"""Read-only coexistence snapshots and stale/invalid-target protection."""
import json
import shlex
import unittest

from api_fixture import ApiTestCase


class CoexistApiTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.status = {
            'BackendState': 'Running', 'MagicDNSSuffix': 'tail.example',
            'CurrentTailnet': {'MagicDNSEnabled': True},
            'Self': {'ID': 'self-one', 'TailscaleIPs': ['100.64.1.1']},
            'Peer': {'key': {'ID': 'peer-one', 'HostName': 'nas',
                             'DNSName': 'nas.tail.example.', 'Online': True,
                             'TailscaleIPs': ['100.64.1.2', 'fd7a:115c:a1e0::2']}},
        }
        self.dns = {'mode': 'local', 'enabled': True, 'state': 'running',
                    'listenerReady': True, 'repairNeeded': False,
                    'policyState': 'owned', 'suffix': 'tail.example',
                    'port': 1053, 'reason': 'local'}
        self.save_state()
        for name, body in {
            'foxytail.dns': 'cat "$TS_DIR/dns.json"',
            'foxytail.compat': 'echo \'{"modules":[],"apps":[],"warnings":[]}\'',
        }.items():
            path = self.scripts / name
            path.write_text('#!/bin/sh\n' + body + '\n')
            path.chmod(0o755)
        (self.base / 'bin').mkdir(exist_ok=True)
        self.probe = self.base / 'bin/foxydns'
        self.probe.write_text('#!/bin/sh\ntouch "$TS_RUN_DIR/probed"\n'
                              'echo \'{"ok":true,"checks":[]}\'\n')
        self.probe.chmod(0o755)
        self.prefix = '''export TS_DIR TS_RUN_DIR
load_conf
daemon_up() { return 0; }
ts_cli() { cat "$TS_DIR/status.json"; }
'''

    def save_state(self):
        (self.base / 'status.json').write_text(json.dumps(self.status))
        (self.base / 'dns.json').write_text(json.dumps(self.dns))

    def info(self):
        return json.loads(self.shell(self.prefix + 'cmd_coexist_info').stdout)

    def check(self, snapshot, peer='peer-one', ip='100.64.1.2', port='443', resolver='-'):
        args = ' '.join(map(shlex.quote, [snapshot, peer, ip, port, resolver]))
        return self.shell(self.prefix + 'cmd_coexist_check ' + args, ok=False)


    def test_invalid_or_changed_target_never_starts_network_probe(self):
        snapshot = self.info()['snapshot']
        for args in [
            {'peer': 'other-peer'}, {'ip': '127.0.0.1'}, {'ip': '100.64.1.3'},
            {'ip': '100.64.1.2;touch x'}, {'port': '0'}, {'port': '65536'},
            {'port': '-1'}, {'resolver': '1053'}, {'resolver': '01053'},
            {'resolver': '8.8.8.8:53'}, {'resolver': '65536'},
        ]:
            with self.subTest(args=args):
                data = json.loads(self.check(snapshot, **args).stdout)
                self.assertFalse(data['ok'])
                self.assertFalse((self.run / 'probed').exists())
        self.status['Peer']['key']['TailscaleIPs'] = ['100.64.1.3']
        self.save_state()
        data = json.loads(self.check(snapshot).stdout)
        self.assertFalse(data['ok'])
        self.assertIn('detect again', data['error'])
        self.assertFalse((self.run / 'probed').exists())

    def test_account_change_during_probe_discards_apparent_success(self):
        snapshot = self.info()['snapshot']
        self.probe.write_text('#!/bin/sh\n'
            'jq \' .Self.ID="different-account" \' "$TS_DIR/status.json" >"$TS_DIR/next.json"\n'
            'mv "$TS_DIR/next.json" "$TS_DIR/status.json"\n'
            'echo \'{"ok":true,"checks":[{"id":"tcp","ok":true}]}\'\n')
        data = json.loads(self.check(snapshot).stdout)
        self.assertFalse(data['ok'])
        self.assertIn('changed during verification', data['error'])
        self.assertNotIn('checks', data)

    def test_untrusted_names_or_invalid_addresses_do_not_become_configuration(self):
        for suffix, address in [('tail.example\nrules: []', '100.64.1.2'),
                                ('bad..example', '100.64.1.2'),
                                ('tail.example', '100.64.999.2'),
                                ('tail.example', 'fd7a:::2')]:
            with self.subTest(suffix=suffix, address=address):
                self.status['MagicDNSSuffix'] = suffix
                self.status['Peer']['key']['TailscaleIPs'] = [address]
                self.save_state()
                data = json.loads(self.shell(self.prefix + 'cmd_coexist_info', ok=False).stdout)
                self.assertFalse(data['ok'])
                self.assertNotIn('snapshot', data)


if __name__ == '__main__':
    unittest.main()
