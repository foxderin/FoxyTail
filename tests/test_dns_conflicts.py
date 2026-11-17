"""Exercise conflict classification with actual scanner functions, no host netfilter."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DnsConflictTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxytail-conflicts-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.rules = self.base / 'rules'
        self.rules.write_text('')
        compat = (ROOT / 'tailscale/scripts/foxytail.compat').read_text()
        dns = (ROOT / 'tailscale/scripts/foxytail.dns').read_text()
        self.lib = self.base / 'lib.sh'
        self.lib.write_text('''
IPV6=off
iptables() { cat "$RULES"; }
ip6tables() { return 1; }
jqr() { jq "$@"; }
''' + compat[compat.index('check_dns_hijack_quiet() {'):compat.index('\ncheck() {')]
            + '\n' + dns[dns.index('legacy_connmark_safe() {'):dns.index('\nlegacy_capture_cleanup() {')]
            + '\n' + dns[dns.index('legacy_upstream_snapshot() {'):dns.index('# Mount FOXY_DNS')])

    def invoke(self, function, rules, prefix=''):
        self.rules.write_text(rules)
        return subprocess.run(['sh', '-c', '. "$1"\n' + prefix + '\n' + function, 'fixture', str(self.lib)],
                              env={**os.environ, 'RULES': str(self.rules)}, text=True, capture_output=True, timeout=5)

    def test_dns_covering_rule_forms(self):
        for match in ('', '--dport 1:1024', '--dport :53', '-m multiport --dports 22,53,443',
                      '! --dport 443', '--dport unknown-service', '--dports 53,unknown-service',
                      '-p unknown-protocol', '--dport ! 443', '-m multiport --ports 53'):
            with self.subTest(match=match):
                result = self.invoke('check_dns_hijack_quiet', f'-A OUTPUT {match} -j REDIRECT --to-ports 8053\n')
                self.assertEqual(result.returncode, 0, result.stderr)


    def test_jump_and_goto_propagate_dns_coverage(self):
        result = self.invoke('check_dns_hijack_quiet', '-A OUTPUT --dport 1:1024 -g PROXY\n-A PROXY -p udp -j REDIRECT --to-ports 8053\n')
        self.assertEqual(result.returncode, 0)

    def test_connmark_foreign_masks_reject_ownership(self):
        for match in ('--set-xmark 1/0xffffffff', '--set-mark 0', '--or-mark 0x20000000',
                      '--and-mark 0xdfffffff', '--save-mark --nfmask 0 --ctmask 0x20000000',
                      '--restore-mark --nfmask 0x20000000 --ctmask 0', '--set-xmark 0/unknown',
                      '--save-mark', '--unknown-option 0'):
            with self.subTest(match=match):
                self.assertEqual(self.invoke('legacy_connmark_safe', f'-A OUTPUT -j CONNMARK {match}\n').returncode, 1)
        for match in ('--set-xmark 1/0xff', '--or-mark 0x100', '--and-mark 0xefffffff',
                      '--save-mark --nfmask 0xff --ctmask 0xff'):
            with self.subTest(match=match):
                self.assertEqual(self.invoke('legacy_connmark_safe', f'-A OUTPUT -j CONNMARK {match}\n').returncode, 0)


    def test_parser_failure_is_not_clear(self):
        result = self.invoke('check_dns_hijack_quiet', '', 'awk() { return 2; }')
        self.assertEqual(result.returncode, 0)

    def test_inventory_failure_is_not_clear(self):
        result = self.invoke('check_dns_hijack_quiet', '', 'iptables() { return 1; }')
        self.assertEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
