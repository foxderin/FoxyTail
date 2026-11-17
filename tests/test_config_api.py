"""Host-only config regressions against the actual shell functions."""
import base64
import ipaddress
import hashlib
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


    def test_schema_rejects_reserved_tables_and_invalid_subnets(self):
        for table in ['0', '52', '253', '254', '255', '999', '1000', '1053', '65535', '65536']:
            self.assertNotEqual(self.shell('_conf_value_error ROUTE_TABLE ' + table, ok=False).returncode, 0)
        self.shell('_conf_value_error ROUTE_TABLE 1052')
        for cidr in ['300.1.1.1/24', '1.2.3.4/99', 'fd00:::1/64', 'fd00::/129', 'not-a-cidr']:
            self.assertNotEqual(self.shell('_conf_value_error ROUTE_SUBNETS ' + shlex.quote(cidr), ok=False).returncode, 0)
        self.shell("_conf_value_error ROUTE_SUBNETS '100.64.0.0/10 fd7a:115c:a1e0::/48'")
        self.assertNotEqual(self.shell("_conf_value_error UID_LIST '0 10123'", ok=False).returncode, 0)


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
        archive = self.archive({'conf/context.conf': '# pending restore'})
        baseline = self.shell('_restore_baseline').stdout.strip()
        self.shell('cmd_restore ' + shlex.quote(str(archive)) + ' ' + hashlib.sha256(archive.read_bytes()).hexdigest() + ' ' + baseline)
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


    def test_context_rules_read_is_static_and_holds_restore_lock(self):
        rules = '# preserved comment\nssid:Office:up\n'
        (self.conf / 'context.conf').write_text(rules)
        result = self.shell('''
_op_exec() { echo 'unexpected live status read' >&2; return 1; }
jqr() {
  [ "${_CONF_LOCK_HELD:-0}" = 1 ] || { echo 'rules read outside lock' >&2; return 1; }
  command jq "$@"
}
cmd_context_get
[ "${_CONF_LOCK_HELD:-0}" = 0 ]
''')
        self.assertEqual(json.loads(result.stdout), {'ok': True, 'rules': rules})
        self.assertEqual(result.stderr, '')
        nested = self.shell('''
conf_lock_acquire || exit 1
cmd_context_get
[ "${_CONF_LOCK_HELD:-0}" = 1 ] || exit 2
conf_lock_release
''')
        self.assertEqual(json.loads(nested.stdout), {'ok': True, 'rules': rules})
        self.assertFalse((self.run / '.conf-write-lock').is_symlink())
        (self.conf / 'context.conf').unlink()
        self.assertEqual(json.loads(self.shell('cmd_context_get').stdout), {'ok': True, 'rules': ''})


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
                archive = self.archive({'conf/context.conf': rules})
                baseline = self.shell('_restore_baseline').stdout.strip()
                restored = self.shell('cmd_restore ' + shlex.quote(str(archive)) + ' ' + hashlib.sha256(archive.read_bytes()).hexdigest() + ' ' + baseline, ok=rules in valid)
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


if __name__ == '__main__':
    unittest.main()
