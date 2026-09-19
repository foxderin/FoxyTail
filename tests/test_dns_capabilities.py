"""Hermetic IPv6 DNS capability checks; never invoke a host kernel loader."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DnsCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxytail-dns-capability-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.run = self.base / 'run'
        self.bin = self.base / 'bin'
        self.run.mkdir()
        self.bin.mkdir()
        self.boot = self.base / 'boot-id'
        self.boot.write_text('fixture-boot-a\n')
        self.module_tree = self.base / 'vendor_dlkm/lib/modules'
        self.module_tree.mkdir(parents=True)
        self.loader = self.base / 'system/bin/modprobe'
        self.env = {**os.environ, 'TEST_ROOT': str(self.base),
                    'PATH': str(self.bin) + os.pathsep + os.environ['PATH']}
        self.executable(self.bin / 'ip6tables', '''#!/bin/sh
test "$*" = '-t nat -S OUTPUT' || exit 97
test -f "$TEST_ROOT/nat-ready"
''')
        self.executable(self.bin / 'timeout', '''#!/bin/sh
case "$1" in 1|2|3) ;; *) exit 98 ;; esac
printf '%s\n' "$1" >>"$TEST_ROOT/timeout-calls"
shift
exec "$@"
''')
        source = (ROOT / 'tailscale/scripts/foxytail.dns').read_text()
        functions = source[source.index('ipv6_nat_available() {'):
                           source.index('# Reconcile redirect independently')]
        # Rewrite every absolute module tree and loader to this fixture before
        # executing any function. No real /sbin/modprobe fallback can be used.
        for root in ('/system_dlkm/lib/modules', '/vendor_dlkm/lib/modules',
                     '/odm_dlkm/lib/modules', '/system/lib/modules',
                     '/vendor/lib/modules', '/odm/lib/modules'):
            functions = functions.replace(root, str(self.base / root.lstrip('/')))
        functions = functions.replace('"/lib/modules/$(uname -r)"',
                                      shlex.quote(str(self.base / 'lib/modules/fixture-kernel')))
        for loader in ('/system/bin/modprobe', '/vendor/bin/modprobe', '/sbin/modprobe'):
            functions = functions.replace(loader, str(self.base / loader.lstrip('/')))
        functions = functions.replace('/proc/sys/kernel/random/boot_id', str(self.boot))
        self.status_function = source[source.index('dns_status() {'):source.index('usage() {')]
        self.lib = self.base / 'capabilities.sh'
        self.lib.write_text('TS_RUN_DIR=' + shlex.quote(str(self.run)) + '\n'
                            'IPV6=on\nlog() { :; }\n' + functions)

    @staticmethod
    def executable(path, contents):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
        path.chmod(0o755)

    def mock_loader(self, effect='ready'):
        self.executable(self.loader, '''#!/bin/sh
printf '%s\n' "$*" >>"$TEST_ROOT/loader-calls"
test "$1" = -d && test "$3" = ip6table_nat || exit 96
''' + {'ready': 'touch "$TEST_ROOT/nat-ready"\nexit 0\n',
       'no-effect': 'exit 0\n', 'failure': 'exit 1\n'}[effect])

    def module(self, name='ip6table_nat.ko'):
        path = self.module_tree / 'kernel/net/ipv6/netfilter' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
        return path

    def shell(self, script):
        result = subprocess.run(['sh', '-c', '. "$1"\n' + script, 'fixture', str(self.lib)],
                                env=self.env, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout.strip()

    def ensured(self, prefix=''):
        return self.shell(prefix + '\nensure_ipv6_nat; rc=$?\nprintf "%s:" "$rc"\nipv6_module_status')

    def test_native_table_never_loads_module(self):
        self.module(); self.mock_loader()
        (self.base / 'nat-ready').touch()
        self.assertEqual(self.ensured(), '0:not-needed')
        self.assertFalse((self.base / 'loader-calls').exists())

    def test_missing_exact_module_does_not_load_similar_ipv6_modules(self):
        for name in ('nf_nat.ko', 'ip6_tables.ko', 'ip6table_filter.ko',
                     'nhc_ipv6.ko', 'ip6table_nat.ko.backup'):
            self.module(name)
        self.mock_loader()
        self.assertEqual(self.ensured(), '1:missing')
        self.assertFalse((self.base / 'loader-calls').exists())

    def test_matching_module_load_requires_observed_table(self):
        for name in ('ip6table_nat.ko', 'ip6table_nat.ko.xz',
                     'ip6table_nat.ko.gz', 'ip6table_nat.ko.zst'):
            with self.subTest(name=name):
                module = self.module(name)
                self.mock_loader()
                self.assertEqual(self.ensured(), '0:loaded')
                self.assertEqual((self.base / 'loader-calls').read_text().strip(),
                                 f'-d {self.module_tree} ip6table_nat')
                # Subsequent reconciliation preserves the provenance and does
                # not load the already available module again.
                self.assertEqual(self.ensured(), '0:loaded')
                module.unlink()
                (self.base / 'loader-calls').unlink()
                (self.base / 'nat-ready').unlink()

    def test_loader_success_without_nat_falls_back(self):
        self.module(); self.mock_loader('no-effect')
        self.assertEqual(self.ensured(), '1:load-failed')
        self.assertFalse((self.base / 'nat-ready').exists())

    def test_loader_failure_and_missing_loader_fall_back(self):
        self.module(); self.mock_loader('failure')
        self.assertEqual(self.ensured(), '1:load-failed')
        self.loader.unlink()
        self.assertEqual(self.ensured(), '1:loader-unavailable')

    def test_total_module_load_budget_stops_scanning_candidate_loads(self):
        self.module(); self.mock_loader('no-effect')
        for tree in ('system_dlkm/lib/modules', 'system/lib/modules'):
            path = self.base / tree / 'ip6table_nat.ko'
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        clock = '''
date() {
  test "$1" = +%s || return 99
  tick=0
  test ! -f "$TEST_ROOT/clock" || tick=$(cat "$TEST_ROOT/clock")
  printf '%s\n' "$((tick + 1))" >"$TEST_ROOT/clock"
  case "$tick" in 0|1) echo 100 ;; 2) echo 104 ;; *) echo 107 ;; esac
}
'''
        self.assertEqual(self.ensured(clock), '1:load-failed')
        self.assertEqual((self.base / 'timeout-calls').read_text().splitlines(), ['3', '2'])
        self.assertEqual(len((self.base / 'loader-calls').read_text().splitlines()), 2)

    def test_boot_stamped_module_status_never_survives_reboot(self):
        self.module(); self.mock_loader()
        self.assertEqual(self.ensured(), '0:loaded')
        self.boot.write_text('fixture-boot-b\n')
        self.assertEqual(self.shell('ipv6_module_status'), 'not-checked')
        # Native availability after another boot has no inherited "loaded"
        # provenance, even if the old status file survived in run/.
        self.assertEqual(self.ensured(), '0:not-needed')
        self.boot.unlink()
        self.assertEqual(self.shell('ipv6_module_status'), 'not-checked')

    def test_ipv6_disabled_never_scans_or_loads_modules(self):
        self.module(); self.mock_loader()
        self.assertEqual(self.ensured('IPV6=off\nipv6_nat_module_dirs() { touch "$TEST_ROOT/scanned"; }'),
                         '1:not-checked')
        self.assertFalse((self.base / 'scanned').exists())
        self.assertFalse((self.base / 'loader-calls').exists())
        self.assertFalse((self.run / 'dnsmasq.ipv6-module').exists())

    def test_dns_status_observes_capability_without_loading(self):
        self.module(); self.mock_loader()
        config = self.run / 'dnsmasq.conf'
        config.write_text('port=1053\nserver=/example.ts.net/100.100.100.100\n')
        stubs = '''
ensure_run_dirs() { :; }
load_conf() { :; }
load_runtime_conf() { :; }
select_dns_binary() { DNS_BIN=/fixture/dnsmasq; }
get_state() { echo running; }
dns_pids() { echo 123; }
current_dns_context() { echo '{}'; }
dns_context_matches() { return 0; }
redirect_present() { return 0; }
dns_hijack_conflict() { return 1; }
native_dns_present() { return 1; }
settings() { echo opportunistic; }
jqr() { jq "$@"; }
MAGIC_DNS=on; DNS_PORT=1053
DNS_REASON_FILE="$TS_RUN_DIR/dnsmasq.reason"
DNS_CONF="$TS_RUN_DIR/dnsmasq.conf"
'''
        status = json.loads(self.shell(self.status_function + stubs + '\ndns_status --json'))
        self.assertEqual(status['state'], 'running')
        self.assertEqual(status['ipv6DnsInterception'], 'fallback')
        self.assertEqual(status['ipv6ModuleStatus'], 'not-checked')
        self.assertFalse((self.base / 'loader-calls').exists())
        self.assertFalse((self.base / 'nat-ready').exists())
        self.assertFalse((self.run / 'dnsmasq.ipv6-module').exists())


if __name__ == '__main__':
    unittest.main()
