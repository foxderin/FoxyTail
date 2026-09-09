"""Host-only regressions: no Android paths, iptables, or live services are used."""
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ConfigApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxytail-api-test-')
        self.base = Path(self.temp.name).resolve()
        self.conf = self.base / 'conf'
        self.run = self.base / 'run'
        self.scripts = self.base / 'scripts'
        self.sdcard = self.base / 'sdcard'
        for directory in [self.conf, self.run, self.scripts, self.sdcard / 'Download']:
            directory.mkdir(parents=True, exist_ok=True)
        for name in ['foxytail.conf', 'routes.conf', 'context.conf']:
            (self.conf / name).write_bytes((ROOT / 'tailscale/conf' / name).read_bytes())
        source = (ROOT / 'tailscale/scripts/foxytail.webapi.sh').read_text()
        helpers = source[source.index('# --- Helpers'):source.index('# --- dispatch')]
        # Relocate the API's shared-storage allowlist to our private fixture.
        helpers = helpers.replace('/sdcard/', str(self.sdcard) + '/')
        self.lib = self.base / 'helpers.sh'
        self.lib.write_text(
            '. ' + shlex.quote(str(ROOT / 'tailscale/settings.sh')) + '\n' +
            'TS_DIR=' + shlex.quote(str(self.base)) + '\n' +
            'TS_CONF_DIR="$TS_DIR/conf"; TS_RUN_DIR="$TS_DIR/run"; TS_PID_DIR="$TS_RUN_DIR/pids"\n'
            'TS_SCRIPTS_DIR="$TS_DIR/scripts"; TS_BIN_DIR="$TS_DIR/bin"; TS_RUN_LOG_FILE="$TS_RUN_DIR/log"\n'
            'TS_SOCKET="$TS_RUN_DIR/tailscaled.sock"; TUN_IFACE=tailscale0\n'
            'mkdir -p "$TS_PID_DIR"\n' + helpers + '\n'
        )

    def tearDown(self):
        self.temp.cleanup()

    def shell(self, script, ok=True):
        result = subprocess.run(['sh', '-c', '. "$1"\n' + script, 'test', str(self.lib)], text=True, capture_output=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result

    def archive(self, entries):
        path = self.sdcard / 'fixture.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, body in entries.items():
                info = tarfile.TarInfo(name)
                if isinstance(body, tuple):
                    info.type = tarfile.SYMTYPE
                    info.linkname = body[0]
                    archive.addfile(info)
                else:
                    content = body.encode()
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
        return path

    def snapshot(self):
        return {file.name: file.read_bytes() for file in self.conf.iterdir()}

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

    def test_schema_rejects_reserved_tables_and_invalid_subnets(self):
        for table in ['0', '52', '253', '254', '255', '999', '65536']:
            self.assertNotEqual(self.shell('_conf_value_error ROUTE_TABLE ' + table, ok=False).returncode, 0)
        self.shell('_conf_value_error ROUTE_TABLE 1052')
        for cidr in ['300.1.1.1/24', '1.2.3.4/99', 'fd00:::1/64', 'fd00::/129', 'not-a-cidr']:
            self.assertNotEqual(self.shell('_conf_value_error ROUTE_SUBNETS ' + shlex.quote(cidr), ok=False).returncode, 0)
        self.shell("_conf_value_error ROUTE_SUBNETS '100.64.0.0/10 fd7a:115c:a1e0::/48'")
        self.assertNotEqual(self.shell("_conf_value_error UID_LIST '0 10123'", ok=False).returncode, 0)

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

    def test_restore_validation_has_no_partial_writes(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'PATH=/sdcard/evil\n'})
        self.assertNotEqual(self.shell('cmd_restore ' + shlex.quote(str(archive)), ok=False).returncode, 0)
        self.assertEqual(self.snapshot(), previous)

    def test_restore_rejects_links_before_extraction(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'TS_MODE=bridge\n', 'conf/link': (str(self.base / 'escape'),)})
        self.assertNotEqual(self.shell('cmd_restore ' + shlex.quote(str(archive)), ok=False).returncode, 0)
        self.assertEqual(self.snapshot(), previous)
        self.assertFalse((self.base / 'escape').exists())

    def test_restore_rolls_back_failed_activation(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'ROUTE_SCOPE=all\n'})
        result = self.shell('''mv() { case "$1" in */next) return 1 ;; esac; command mv "$@"; }
cmd_restore ''' + shlex.quote(str(archive)), ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), previous)

    def test_failed_rollback_removal_preserves_previous_directory(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'ROUTE_SCOPE=all\n'})
        result = self.shell('''conf_mark_pending() { return 1; }
rm() { [ "$*" != "-rf $TS_CONF_DIR" ] || return 1; command rm "$@"; }
cmd_restore ''' + shlex.quote(str(archive)), ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('previous configuration retained', result.stderr)
        backups = list(self.base.glob('conf.bak-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual({file.name: file.read_bytes() for file in backups[0].iterdir()}, previous)
        self.assertFalse(any(file.is_dir() for file in self.conf.iterdir()), 'rollback nested the old directory inside conf')

    def test_rotation_preserves_inode_and_bounds_backup(self):
        logfile = self.run / 'large.log'
        logfile.write_bytes(b'x' * 100_000)
        inode = logfile.stat().st_ino
        self.shell('LOG_MAX_KB=64; rotate_log "$TS_RUN_DIR/large.log"')
        self.assertEqual(logfile.stat().st_ino, inode)
        self.assertEqual(logfile.stat().st_size, 0)
        self.assertEqual((self.run / 'large.log.bak').stat().st_size, 65536)
        self.assertFalse((self.run / '.conf-write-lock').is_symlink())

    def test_restore_retains_snapshot_and_marks_restart(self):
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'ROUTE_SCOPE=all\n', 'foxytail.tun.up': '#!/system/bin/sh\necho restored\n'})
        result = json.loads(self.shell('cmd_restore ' + shlex.quote(str(archive))).stdout)
        self.assertTrue(Path(result['previous']).is_dir())
        self.assertTrue(result['restartRequired'])
        self.assertEqual((self.conf / 'foxytail.conf').read_text(), 'SOCKS_PORT=1200\n')
        self.assertFalse((self.scripts / 'foxytail.tun.up').exists())

    def test_failed_backup_removes_partial_archive(self):
        result = self.shell('''tar() { [ "$1" != -czf ] || { printf truncated >"$2"; return 1; }; command tar "$@"; }
cmd_backup''', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list((self.sdcard / 'Download').iterdir()), [])

    def test_cancel_before_registration_is_a_tombstone(self):
        request_id = str(int(time.time())) + '_delayed_123'
        result = self.shell('cmd_cancel ' + request_id + '; _op_init ' + request_id + ' login', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.run / 'operations' / request_id / 'cancelled').exists())

    def test_cancel_checks_pid_identity(self):
        result = self.shell('''mkdir -p "$TS_RUN_DIR/operations/1_old"
printf '99999 123\\n' >"$TS_RUN_DIR/operations/1_old/child.99999"
_op_starttime() { printf 999; }
kill() { echo "unexpected kill" >&2; return 99; }
cmd_cancel 1_old''')
        self.assertNotIn('unexpected kill', result.stderr)
        self.assertTrue(json.loads(result.stdout)['cancelled'])

    def test_cancellation_stops_only_registered_child(self):
        request_id = str(int(time.time())) + '_live'
        # The host may lack /proc; substitute only the starttime reader. Kill
        # remains real, and the separate bystander must survive cancellation.
        stamp = '_op_starttime() { kill -0 "$1" 2>/dev/null && printf 100; }\n'
        bystander = subprocess.Popen(['sleep', '30'])
        runner = subprocess.Popen(['sh', '-c', '. "$1"; ' + stamp + '_op_init "$2" login; _op_exec 30 sleep 30', 'test', str(self.lib), request_id], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            registry = self.run / 'operations' / request_id
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and not list(registry.glob('child.*')):
                time.sleep(0.02)
            self.assertTrue(list(registry.glob('child.*')), 'child was not registered')
            result = self.shell(stamp + 'cmd_cancel ' + request_id)
            self.assertTrue(json.loads(result.stdout)['cancelled'])
            runner.communicate(timeout=3)
            self.assertEqual(runner.returncode, 130)
            self.assertIsNone(bystander.poll(), 'unrelated process was signalled')
        finally:
            for process in [runner, bystander]:
                if process.poll() is None:
                    process.terminate()
                process.communicate(timeout=3)

    def test_multicall_cli_is_not_mistaken_for_daemon(self):
        proc = self.base / 'proc'
        for pid, name in [('101', 'tailscaled'), ('102', 'tailscale')]:
            (proc / pid).mkdir(parents=True)
            (proc / pid / 'cmdline').write_bytes((str(self.base / 'bin' / name) + '\0--socket=tailscaled.sock\0').encode())
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        function = settings[settings.index('pids_of_path() {'):settings.index('# Echo the subset')]
        function = function.replace('/proc/', str(proc) + '/')
        result = self.shell(function + '\npids_of() { printf \'101 102\'; }\nreadlink() { printf \'%s\' "$TS_BIN_DIR/tailscaled"; }\npids_of_path "$TS_BIN_DIR/tailscaled"')
        self.assertEqual(result.stdout.strip(), '101')

    def test_expired_requests_never_restart_and_gc_is_bounded(self):
        result = self.shell("_op_init 1_expired status", ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('expired', result.stdout)
        self.shell("mkdir -p \"$TS_RUN_DIR/operations/1_done\"; touch \"$TS_RUN_DIR/operations/1_done/done\"; _op_gc")
        self.assertFalse((self.run / 'operations/1_done').exists())

    def test_stale_lock_recovers_without_an_owner_publish_gap(self):
        self.shell("ln -s '999999:-' \"$TS_RUN_DIR/.conf-write-lock\"; conf_write_key foxytail.conf DNS_PORT 1101")
        self.assertFalse((self.run / '.conf-write-lock').is_symlink())
        self.assertIn('DNS_PORT="1101"', (self.conf / 'foxytail.conf').read_text())

    def test_path_aware_serve_delete(self):
        result = self.shell('''ts_cli() { printf '%s\\n' "$*" >"$TS_RUN_DIR/args"; }
_serve_del serve https 8443 '/api/v1'
cat "$TS_RUN_DIR/args"''')
        self.assertIn('25 serve --bg --https=8443 --set-path=/api/v1 off', result.stdout)


if __name__ == '__main__':
    unittest.main()
