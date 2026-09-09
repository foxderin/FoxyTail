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

    def test_parser_key_membership_matches_public_schema(self):
        self.shell('''for file in foxytail.conf routes.conf; do
  for key in $(_conf_keys "$file"); do _conf_has_key "$file" "$key" || exit 1; done
done
! _conf_has_key foxytail.conf UID_LIST && ! _conf_has_key routes.conf TS_MODE &&
! _conf_has_key other.conf TS_MODE && ! _conf_has_key foxytail.conf PATH''')

    def cgroup_fixture(self, records):
        proc = self.base / 'proc' / 'self'
        proc.mkdir(parents=True)
        (proc / 'stat').write_text('4321 (foxytail.webapi) S 1 2 3\n')
        (proc / 'cgroup').write_text(records)
        sys = self.base / 'sys' / 'fs' / 'cgroup'
        sys.mkdir(parents=True)
        (sys / 'cgroup.procs').touch()
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        function = settings[settings.index('detach_from_app_cgroup() {'):settings.index('# Rotate <file>')]
        function = function.replace('/proc/self/', str(proc) + '/').replace('/sys/fs/cgroup/', str(sys) + '/')
        for controller in ['freezer', 'cpuset', 'cpuctl']:
            function = function.replace('/dev/' + controller + '/', str(self.base / 'dev' / controller) + '/')
        return function

    def test_backend_moves_only_itself_out_of_app_freezer(self):
        function = self.cgroup_fixture('0::/apps/uid_10379/pid_10154\n5:freezer:/\n')
        # A cgroupfs write updates membership; emulate that kernel effect with
        # a shell builtin while retaining the actual PID destination write.
        result = self.shell(function + '''
echo() {
  if [ "$*" = 4321 ]; then command echo '0::/' >"$TS_DIR/proc/self/cgroup"; fi
  command echo "$@"
}
detach_from_app_cgroup''')
        self.assertEqual(result.stdout, '')
        self.assertEqual((self.base / 'sys/fs/cgroup/cgroup.procs').read_text(), '4321\n')

    def test_backend_refuses_lock_when_freezer_detach_fails(self):
        function = self.cgroup_fixture('0::/apps/uid_10379/pid_10154\n')
        # A writable destination that fails to move us is also rejected by the
        # post-write membership check; never proceed to load/lock configuration.
        result = self.shell(function + '\ndetach_from_app_cgroup && load_conf', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('still in the manager app freezer', result.stderr)
        self.assertFalse((self.run / '.conf-write-lock').exists())

    def test_backend_keeps_existing_system_cgroup(self):
        function = self.cgroup_fixture('0::/\n5:freezer:/\n3:cpuset:/foreground\n')
        self.shell(function + '\ndetach_from_app_cgroup')
        self.assertEqual((self.base / 'sys/fs/cgroup/cgroup.procs').read_text(), '')

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

    def test_settings_and_routes_use_one_json_process_per_snapshot(self):
        result = self.shell('''load_conf
jqr() { printf x >>"$TS_RUN_DIR/jq-calls"; command jq "$@"; }
cmd_settings_get
cmd_routes_get''')
        settings, routes = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(settings['settings']['TS_MODE'], 'bridge')
        self.assertEqual(settings['settings']['FWMARK'], '0x40000000')
        self.assertNotIn('pending', settings['settings'])
        self.assertEqual(routes['scope'], 'all')
        self.assertEqual(routes['uids'], [])
        self.assertEqual(routes['subnets'], ['100.64.0.0/10'])
        self.assertEqual((self.run / 'jq-calls').read_text(), 'xx')

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

    def test_dns_status_preserves_configuration_and_native_capability(self):
        status = {'state': 'stopped', 'suffix': '', 'port': 1053, 'enabled': False,
                  'reason': 'Local DNS helper is disabled', 'binary': '/system/bin/dnsmasq',
                  'upstreamNative': True}
        dns = self.scripts / 'foxytail.dns'
        dns.write_text('#!/bin/sh\nprintf %s ' + shlex.quote(json.dumps(status)) + '\n')
        dns.chmod(0o755)
        result = json.loads(self.shell('load_conf; cmd_dns').stdout)
        self.assertEqual(result, {'ok': True, **status})

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

    def test_fast_cli_does_not_wait_for_timeout_monitor(self):
        start = time.monotonic()
        result = self.shell('''_op_starttime() { kill -0 "$1" 2>/dev/null && printf 100; }
_op_exec 3 sh -c 'printf ready; exit 7' ''', ok=False)
        self.assertEqual(result.stdout, 'ready')
        self.assertEqual(result.returncode, 7)
        self.assertLess(time.monotonic() - start, 1.5, 'completed CLI waited for its timeout monitor')

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

    def test_process_identity_handles_spaces_and_parentheses(self):
        proc = self.base / 'proc'
        (proc / '101').mkdir(parents=True)
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        function = settings[settings.index('_proc_starttime() {'):settings.index('_conf_pid_stamp() {')]
        function = function.replace('/proc/', str(proc) + '/')
        # Fields after comm are state then 18 numeric fields before starttime.
        rest = ' '.join(['S'] + ['0'] * 18 + ['123456', '999'])
        (proc / '101' / 'stat').write_text('101 (tailscale (worker) name) ' + rest + '\n')
        result = self.shell(function + '\n_proc_starttime 101')
        self.assertEqual(result.stdout.strip(), '123456')
        (proc / '101' / 'stat').write_text('101 (tailscaled) ' + rest.replace('S ', 'Z ', 1) + '\n')
        self.assertNotEqual(self.shell(function + '\n_proc_starttime 101', ok=False).returncode, 0)

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
