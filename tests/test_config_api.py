"""Host-only config regressions against the actual shell functions."""
import base64
import ipaddress
import json
import os
import random
import shlex
import signal
import subprocess
import time
import unittest

from api_fixture import ApiTestCase, ROOT


class ConfigApiTests(ApiTestCase):
    def test_parser_treats_configuration_as_data(self):
        bad_values = [
            'TS_MODE=bridge\nXX; touch ' + str(self.base / 'executed') + '=x\n',
            'PATH=/sdcard/replacement\n', 'TS_SCRIPTS_DIR=/sdcard/replacement\n',
            'TS_MODE="$(touch ' + str(self.base / 'executed') + ')"\n',
            'TS_MODE=bridge\nTS_MODE=tun\n', 'TS_MODE="bridge";echo injected\n',
        ]
        for content in bad_values:
            with self.subTest(content=content):
                (self.conf / 'foxytail.conf').write_text(content)
                self.assertNotEqual(self.shell('load_conf', ok=False).returncode, 0)
                self.assertFalse((self.base / 'executed').exists())

    def test_parser_preserves_empty_lists_and_final_line(self):
        (self.conf / 'foxytail.conf').write_text('TS_MODE=bridge\nFWMARK=0xF7')
        (self.conf / 'routes.conf').write_text('UID_LIST=""\nROUTE_SUBNETS=""')
        result = self.shell('load_conf && printf "%s|%s|%s" "$FWMARK" "$UID_LIST" "$ROUTE_SUBNETS"')
        self.assertEqual(result.stdout, '0x40000000||')

    def test_dns_modes_roundtrip_and_upgrade_default(self):
        (self.conf / 'foxytail.conf').write_text('MAGIC_DNS=on\nDNS_PORT=1054\n')
        result = json.loads(self.shell('load_conf && cmd_settings_get').stdout)
        self.assertEqual(result['settings']['DNS_MODE'], 'legacy')
        for mode in ['local', 'transparent', 'legacy']:
            result = json.loads(self.shell(f'cmd_settings_set DNS_MODE {mode}').stdout)
            self.assertTrue(result['restartRequired'])
            result = json.loads(self.shell('load_conf && cmd_settings_get').stdout)
            self.assertEqual(result['settings']['DNS_MODE'], mode)
            self.assertEqual(result['settings']['DNS_PORT'], '1054')
        for mode in ['auto', 'flclash', 'off', 'LOCAL', '']:
            self.assertNotEqual(self.shell('cmd_settings_set DNS_MODE ' + shlex.quote(mode), ok=False).returncode, 0)

    def test_schema_rejects_reserved_tables_and_invalid_subnets(self):
        for table in ['0', '52', '253', '254', '255', '999', '65536']:
            self.assertNotEqual(self.shell('_conf_value_error ROUTE_TABLE ' + table, ok=False).returncode, 0)
        self.shell('_conf_value_error ROUTE_TABLE 1052')
        for cidr in ['300.1.1.1/24', '1.2.3.4/99', 'fd00:::1/64', 'fd00::/129', 'not-a-cidr']:
            self.assertNotEqual(self.shell('_conf_value_error ROUTE_SUBNETS ' + shlex.quote(cidr), ok=False).returncode, 0)
        self.shell("_conf_value_error ROUTE_SUBNETS '100.64.0.0/10 fd7a:115c:a1e0::/48'")
        self.assertNotEqual(self.shell("_conf_value_error UID_LIST '0 10123'", ok=False).returncode, 0)

    def test_cidr_normalization_matches_network_semantics_and_preserves_hosts(self):
        rng = random.Random(2452)
        cidrs = ['192.168.1.7/24', '192.168.1.0/24', '192.168.1.10/32',
                 'FD12:34::ABCD/64', 'fd12:34::/64', '2001:db8::1/128',
                 '::ffff:192.0.2.129/120', '0.0.0.0/0', '::/0']
        for bits, address in ((32, ipaddress.IPv4Address), (128, ipaddress.IPv6Address)):
            for prefix in range(bits + 1):
                cidrs.append(f'{address(rng.getrandbits(bits))}/{prefix}')
        expected = []
        for cidr in cidrs:
            network = ipaddress.ip_network(cidr, strict=False)
            canonical = str(network)
            # Python versions differ in the displayed form of mapped IPv6.
            # The API consistently uses hexadecimal RFC 5952-style words.
            if network.version == 6 and '.' in canonical:
                mapped = network.network_address.ipv4_mapped
                self.assertIsNotNone(mapped)
                canonical = canonical.replace(str(mapped), f'{int(mapped) >> 16:x}:{int(mapped) & 0xffff:x}')
            if canonical not in expected:
                expected.append(canonical)
        result = self.shell('normalize_cidrs ' + shlex.quote(' '.join(cidrs)))
        self.assertEqual(result.stdout.split(), expected)
        self.assertEqual(self.shell("normalize_cidrs '192.168.001.010/32'").stdout, '192.168.1.10/32')
        self.assertEqual(self.shell("normalize_cidrs ''").stdout, '')

    def test_invalid_cidr_never_emits_partial_normalized_output(self):
        bad = ['1.2.3/24', '256.1.1.1/24', '1.2.3.4/33', '1.2.3.4/-1',
               'fd00:::1/64', '1:2:3:4:5:6:7::8/64', '1:2:3:4:5:6:7:/64',
               '1::2::3/64', '::ffff:192.0.2.300/128', '::ffff:1.2.3/64',
               '::/129', 'fe80::1%wlan0/64', '::/x', '::1', '0/0', '1.2.3.4/24/1']
        for cidr in bad:
            with self.subTest(cidr=cidr):
                result = self.shell('normalize_cidrs ' + shlex.quote('192.168.0.0/16 ' + cidr), ok=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')

    def test_hot_saves_promote_only_the_requested_file_under_the_config_lock(self):
        self.shell('conf_activate_runtime')
        runtime = self.run / (self.run / 'applied-config').read_text().strip()
        main = (runtime / 'foxytail.conf').read_bytes()
        self.shell('cmd_settings_set SOCKS_PORT 1200')
        self.shell('''load_conf
ip() { return 1; }
cmd_routes_set all - '192.168.1.7/24'
''')
        self.assertEqual((runtime / 'routes.conf').read_bytes(), (self.conf / 'routes.conf').read_bytes())
        self.assertEqual((runtime / 'foxytail.conf').read_bytes(), main)
        rules = 'cellular:-:no-exit-node'
        self.shell('cmd_context_set ' + shlex.quote(base64.b64encode(rules.encode()).decode()))
        self.assertEqual((runtime / 'context.conf').read_text(), rules)
        self.assertEqual((runtime / 'foxytail.conf').read_bytes(), main)
        before = {file.name: file.read_bytes() for file in runtime.iterdir()}
        self.shell('cmd_restore ' + shlex.quote(str(self.archive({'conf/context.conf': '# pending restore'}))))
        self.assertEqual({file.name: file.read_bytes() for file in runtime.iterdir()}, before)
        self.assertTrue((self.run / 'settings.pending').exists())

    def test_failed_runtime_promotion_reports_saved_without_applying(self):
        prefix = '''load_conf
conf_apply_runtime() {
  [ "${_CONF_LOCK_HELD}" = 1 ] || echo 'promotion was outside lock' >&2
  return 1
}
ip() { touch "$TS_RUN_DIR/unexpected-apply"; return 0; }
'''
        result = self.shell(prefix + "cmd_routes_set all - '192.168.1.7/24'", ok=False)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertIn('saved, but runtime configuration promotion failed', json.loads(result.stdout)['error'])
        self.assertIn('192.168.1.0/24', (self.conf / 'routes.conf').read_text())
        self.assertNotIn('outside lock', result.stderr)
        self.assertFalse((self.run / 'unexpected-apply').exists())
        result = self.shell(prefix + "cmd_context_set ''", ok=False)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertIn('saved, but runtime configuration promotion failed', json.loads(result.stdout)['error'])
        self.assertNotIn('outside lock', result.stderr)
        self.assertEqual((self.conf / 'context.conf').read_text(), '')
        self.assertFalse((self.run / '.conf-write-lock').is_symlink())

    def test_hot_saves_fail_closed_without_a_known_runtime(self):
        for command in ("cmd_routes_set all - 'fd12::55/64'", "cmd_context_set ''"):
            result = self.shell('''load_conf
ip() { touch "$TS_RUN_DIR/unexpected-apply"; return 0; }
''' + command, ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('saved, but runtime configuration promotion failed', json.loads(result.stdout)['error'])
            self.assertFalse((self.run / 'unexpected-apply').exists())
            self.assertFalse((self.run / 'applied-config').exists())
            self.assertTrue((self.run / 'settings.pending').exists())
            self.assertFalse((self.run / '.conf-write-lock').is_symlink())

    def test_concurrent_writers_preserve_unrelated_changes(self):
        workers = []
        changes = [('SOCKS_PORT', '1100'), ('DNS_PORT', '1101'), ('STATS_INTERVAL', '71'), ('LOG_MAX_KB', '600')]
        for key, value in changes:
            workers.append(subprocess.Popen(['sh', '-c', '. "$1"; conf_write_key foxytail.conf "$2" "$3"', 'test', str(self.lib), key, value], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        for worker in workers:
            stdout, stderr = worker.communicate(timeout=15)
            self.assertEqual(worker.returncode, 0, stdout + stderr)
        result = self.shell('load_conf && cmd_settings_get')
        values = json.loads(result.stdout)['settings']
        for key, value in changes:
            self.assertEqual(values[key], value)

    def test_native_scope_and_install_marker_reject_writes(self):
        (self.conf / 'routes.conf').write_text('ROUTE_SCOPE=selected\nUID_LIST="10123"')
        self.assertNotEqual(self.shell('conf_write_key foxytail.conf TS_MODE tun', ok=False).returncode, 0)
        (self.base / '.installing').touch()
        self.assertNotEqual(self.shell('conf_write_key foxytail.conf DNS_PORT 1101', ok=False).returncode, 0)

    def test_account_json_and_stderr_are_preserved(self):
        result = self.shell('''daemon_up() { return 0; }
ts_cli() { [ "$*" = '15 switch --list --json' ] || return 9; printf '%s' '[{"id":"id1","nickname":"Home","selected":true}]'; }
cmd_accounts''')
        self.assertEqual(json.loads(result.stdout)['accounts'][0], {'name': 'id1', 'id': 'id1', 'current': True, 'label': 'Home', 'tailnet': ''})
        result = self.shell('''_op_exec() { shift; "$@"; }
tailscale() { echo 'permission denied by policy' >&2; return 1; }
cmd_exitnode_clear''', ok=False)
        self.assertIn('permission denied by policy', json.loads(result.stdout)['error'])

    def test_settings_and_routes_return_public_schema(self):
        result = self.shell('''load_conf
cmd_settings_get
cmd_routes_get''')
        settings, routes = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(settings['settings']['TS_MODE'], 'bridge')
        self.assertEqual(settings['settings']['FWMARK'], '0x40000000')
        self.assertNotIn('pending', settings['settings'])
        self.assertEqual(routes['scope'], 'all')
        self.assertEqual(routes['uids'], [])
        self.assertEqual(routes['subnets'], ['100.64.0.0/10'])

    def test_large_package_list_has_constant_json_process_count(self):
        # Hundreds of apps must not launch hundreds of jq processes while the
        # root bridge holds the WebView callback. Keep parsing real jq output.
        (self.base / 'packages').write_text(''.join(
            f'package:com.example.app{i:03d} uid:{10000 + i}\n' for i in reversed(range(300))
        ) + 'unrelated diagnostic\n')
        result = self.shell('''timeout() { shift; "$@"; }
pm() { cat "$TS_DIR/packages"; }
jqr() { printf x >>"$TS_RUN_DIR/jq-calls"; command jq "$@"; }
cmd_apps''')
        apps = json.loads(result.stdout)['apps']
        self.assertEqual(len(apps), 300)
        self.assertEqual(apps[0], {'label': 'com.example.app000', 'package': 'com.example.app000', 'uid': 10000})
        self.assertEqual(apps[-1]['uid'], 10299)
        self.assertEqual((self.run / 'jq-calls').read_text(), 'x')

    def test_context_save_and_restore_share_validation(self):
        self.shell('conf_activate_runtime')
        valid = ['', 'ssid:Office WiFi:up\ncellular:-:down']
        invalid = ['cellular:-:typo', '# first line\ncellular:-:no-exit-node:unexpected']
        for rules in valid + invalid:
            with self.subTest(rules=rules):
                before = self.snapshot()
                pending = self.run / 'settings.pending'
                old_pending = pending.read_bytes() if pending.exists() else None
                payload = base64.b64encode(rules.encode()).decode()
                saved = self.shell('cmd_context_set ' + shlex.quote(payload), ok=rules in valid)
                restored = self.shell('cmd_restore ' + shlex.quote(str(self.archive(
                    {'conf/context.conf': rules}))), ok=rules in valid)
                for result in (saved, restored):
                    data = json.loads(result.stdout)
                    self.assertEqual(data['ok'], rules in valid, result.stdout)
                    if rules in invalid:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertRegex(data['error'], r'(?:line |:)[12](?:\D|$)')
                if rules in valid:
                    self.assertEqual((self.conf / 'context.conf').read_text(), rules)
                else:
                    self.assertEqual(self.snapshot(), before)
                    self.assertEqual(pending.read_bytes() if pending.exists() else None, old_pending)
                self.assertFalse((self.run / '.conf-write-lock').is_symlink())
                self.assertEqual(list(self.conf.glob('.context.conf.*')), [])

    def test_context_save_waits_for_real_resident_reload_and_reports_start_failure(self):
        self.shell('conf_activate_runtime')
        start = (ROOT / 'tailscale/scripts/start.sh').read_text()
        # Keep the actual bounded readiness loop; only change host exec boundaries.
        start = start.replace('nohup "${TS_SCRIPTS_DIR}/${_sr_name}"',
                              'nohup sh "${TS_SCRIPTS_DIR}/${_sr_name}"')
        start = start.replace('"${TS_SCRIPTS_DIR}/${_sr_name}" stop',
                              'sh "${TS_SCRIPTS_DIR}/${_sr_name}" stop')
        (self.scripts / 'start.sh').write_text(start)
        context = (ROOT / 'tailscale/scripts/foxytail.context').read_text().replace(
            '#!/system/bin/sh', '#!/bin/sh', 1)
        pidfile = self.run / 'slow-context-pid'
        stampfile = self.run / 'slow-context-start'
        for mode in ('failed', 'unready', 'empty'):
            with self.subTest(mode=mode):
                if mode == 'empty':
                    helper = context  # Real no-rules startup must remain a success.
                else:
                    action = 'sleep 0.1; exit 9' if mode == 'failed' else (
                        'echo $$ >' + shlex.quote(str(pidfile)) +
                        '; ps -p $$ -o lstart= >' + shlex.quote(str(stampfile)) + '; exec sleep 30')
                    helper = context.replace('#!/bin/sh', '#!/bin/sh\n'
                        f'case "$1" in start) {action} ;; stop) exit 0 ;; esac', 1)
                (self.scripts / 'foxytail.context').write_text(helper)
                rules = '' if mode == 'empty' else 'cellular:-:no-exit-node'
                try:
                    started = time.monotonic()
                    result = self.shell('cmd_context_set ' + shlex.quote(
                        base64.b64encode(rules.encode()).decode()), ok=mode == 'empty')
                    self.assertLess(time.monotonic() - started, 6, 'startup wait was not bounded')
                    data = json.loads(result.stdout)
                    self.assertEqual(data['ok'], mode == 'empty')
                    if mode != 'empty':
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('saved, but resident startup failed', data['error'])
                    self.assertEqual((self.conf / 'context.conf').read_text(), rules)
                    self.assertTrue((self.run / 'settings.pending').exists())
                    self.assertFalse((self.run / '.conf-write-lock').is_symlink())
                finally:
                    if pidfile.exists():
                        # This fixture execs sleep in place: one owned PID, no descendants.
                        pid = int(pidfile.read_text())
                        actual = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='],
                                                text=True, capture_output=True)
                        if stampfile.exists() and actual.stdout.strip() and actual.stdout == stampfile.read_text():
                            try:
                                os.kill(pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                        pidfile.unlink()


    def test_wait_for_preserves_arguments_and_bounds_failure(self):
        result = self.shell('''sleep() { :; }
ready() { test "$#" = 2 && test "$1" = 'argument with spaces' && test "$2" = 17; }
wait_for ready 2 0 ready 'argument with spaces' 17 || exit 1
attempt() { echo tried; return 1; }
wait_for unavailable 3 0 attempt && exit 2
exit 0
''')
        self.assertEqual(result.stdout.splitlines(), ['tried'] * 3)


if __name__ == '__main__':
    unittest.main()
