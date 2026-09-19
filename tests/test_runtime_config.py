"""Applied configuration and recovery entrypoints, entirely in private fixtures."""
from pathlib import Path
import os
import shlex
import subprocess
import tempfile
import unittest
import shutil

from runtime_fixture import install_settings

ROOT = Path(__file__).resolve().parents[1]


class RuntimeConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxytail-runtime-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.conf = self.base / 'conf'
        self.scripts = self.base / 'scripts'
        self.run = self.base / 'run'
        for directory in (self.conf, self.scripts, self.run):
            directory.mkdir()
        self.main = self.conf / 'foxytail.conf'
        self.main.write_text('TS_MODE=bridge\nMAGIC_DNS=off\nDNS_MODE=legacy\nWATCHDOG=on\nDNS_PORT=1053\n')
        (self.conf / 'routes.conf').write_text('ROUTE_SCOPE=all\nROUTE_SUBNETS="100.64.0.0/10"\n')
        (self.conf / 'context.conf').write_text('cellular:-:no-exit-node\n')
        self.settings = install_settings(self.base)
        for name in ('foxytail.context', 'foxytail.watchdog', 'foxytail.stats', 'foxytail.logd', 'start.sh'):
            path = self.scripts / name
            path.write_text((ROOT / 'tailscale/scripts' / name).read_text().replace('#!/system/bin/sh', '#!/bin/sh', 1))
            path.chmod(0o755)

    def shell(self, source):
        result = subprocess.run(['sh', '-c', '. ' + shlex.quote(str(self.settings)) + '\n' + source],
                                cwd=self.base, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_staged_settings_load_staged_libraries_and_validate_live_config(self):
        stage = self.base / 'stage'
        (stage / 'scripts').mkdir(parents=True)
        shutil.copyfile(self.settings, stage / 'settings.sh')
        for path in self.scripts.glob('foxytail.*.sh'):
            shutil.move(path, stage / 'scripts' / path.name)
        for valid in (True, False):
            self.main.write_text('TS_MODE=' + ('bridge' if valid else 'invalid') + '\n')
            result = subprocess.run(['sh', '-c', 'DIR=$2; . "$1"; load_conf', 'test',
                                     str(stage / 'settings.sh'), str(stage / 'scripts')],
                                    text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode == 0, valid, result.stdout + result.stderr)

    def test_pending_settings_never_replace_recovery_snapshot(self):
        self.shell('''
conf_activate_runtime || exit 1
conf_write_key foxytail.conf DNS_MODE local || exit 2
conf_write_key foxytail.conf MAGIC_DNS on || exit 3
conf_write_key foxytail.conf WATCHDOG off || exit 4
load_runtime_conf || exit 5
test "$DNS_MODE:$MAGIC_DNS:$WATCHDOG" = legacy:off:on || exit 6
load_conf || exit 7
test "$DNS_MODE:$MAGIC_DNS:$WATCHDOG" = local:on:off || exit 8
''')
        service = (ROOT / 'tailscale/scripts/foxytail.service').read_text()
        functions = service[service.index('daemon_pids() {'):service.index('# Serialize all controllers')]
        output = self.shell(functions + '''
_SERVICE_RECOVERY=1
is_running() { return 0; }
reconcile_companions() { echo "$DNS_MODE:$MAGIC_DNS:$WATCHDOG"; }
start_service
''')
        self.assertEqual(output.strip(), 'legacy:off:on')
        self.shell('conf_activate_runtime && load_runtime_conf && test "$DNS_MODE:$MAGIC_DNS:$WATCHDOG" = local:on:off')

    def service_functions(self):
        source = (ROOT / 'tailscale/scripts/foxytail.service').read_text()
        return source[source.index('daemon_pids() {'):source.index('# Serialize all controllers')]

    def test_warm_start_uses_runtime_even_with_invalid_desired(self):
        self.shell('conf_activate_runtime')
        self.main.write_text('TS_MODE=invalid\n')
        self.shell(self.service_functions() + '''
is_running() { return 0; }
reconcile_companions() { test "$TS_MODE" = bridge; }
start_service
''')

    def test_resident_reload_does_not_parse_broken_desired_settings(self):
        self.shell('conf_activate_runtime')
        self.main.write_text('TS_MODE=invalid\n')
        (self.base / 'disable').touch()
        result = subprocess.run(['sh', str(self.scripts / 'start.sh'), 'reload-residents'],
                                cwd=self.base, env={**os.environ, 'MODPATH': str(self.base)},
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_candidate_is_fixed_before_stop_and_preserves_newer_pending(self):
        self.shell('conf_activate_runtime; conf_write_key foxytail.conf SOCKS_PORT 1200')
        self.shell(self.service_functions() + '''
TS_DAEMON_CMD=true
PID_FILE="$TS_RUN_DIR/daemon.pid"
is_running() { return 1; }
daemon_pids() { :; }
wait_socket() { return 0; }
update_mod_desc() { :; }
sleep() { :; }
stop_service() {
  load_runtime_conf || return 1
  test "$SOCKS_PORT" = 1099 || return 1
  conf_write_key foxytail.conf SOCKS_PORT 1300 || return 1
  touch "$TS_RUN_DIR/cleaned-old-companions"
}
reconcile_companions() { test "$SOCKS_PORT" = 1200; }
restart_service || exit 1
test -f "$TS_RUN_DIR/cleaned-old-companions" || exit 2
load_runtime_conf || exit 3
test "$SOCKS_PORT" = 1200 || exit 4
test "$(cat "$TS_RUN_DIR/settings.pending")" != "$(cat "$_RUNTIME_CONF_DIR/revision")"
''')

    def test_cold_start_cleanup_failure_preserves_previous_snapshot(self):
        self.shell('conf_activate_runtime; conf_write_key foxytail.conf SOCKS_PORT 1200')
        self.shell(self.service_functions() + '''
TS_DAEMON_CMD=true
is_running() { return 1; }
stop_service() { load_runtime_conf && test "$SOCKS_PORT" = 1099 && return 7; }
start_service && exit 1
load_runtime_conf && test "$SOCKS_PORT" = 1099
''')

    def test_invalid_candidate_does_not_stop_running_service(self):
        self.shell('conf_activate_runtime')
        self.main.write_text('TS_MODE=invalid\n')
        self.shell(self.service_functions() + '''
stop_service() { touch "$TS_RUN_DIR/stopped"; }
restart_service && exit 1
test ! -e "$TS_RUN_DIR/stopped"
''')

    def test_runtime_survives_bad_desired_and_stop_entrypoints_remain_usable(self):
        self.shell('conf_activate_runtime')
        self.main.write_text('TS_MODE=invalid\n')
        self.shell('load_runtime_conf && test "$TS_MODE" = bridge && ! load_conf')
        for name in ('foxytail.watchdog', 'foxytail.stats', 'foxytail.context', 'foxytail.logd'):
            result = subprocess.run(['sh', str(self.scripts / name), 'stop'],
                                    cwd=self.base, text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, name + result.stdout + result.stderr)
        service = self.scripts / 'foxytail.service'
        service.write_text('#!/bin/sh\ntouch ' + shlex.quote(str(self.run / 'service-stopped')) + '\n')
        service.chmod(0o755)
        # As in test_lifecycle, execute the inert service boundary through the
        # host interpreter; Android's actual service implementation is not run.
        start = self.scripts / 'start.sh'
        start.write_text(start.read_text().replace('"${TS_SCRIPTS_DIR}/foxytail.service" stop',
                                                   'sh "${TS_SCRIPTS_DIR}/foxytail.service" stop'))
        result = subprocess.run(['sh', str(self.scripts / 'start.sh'), 'stop'],
                                cwd=self.base, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.run / 'service-stopped').exists())

    def test_incompatible_native_hot_routes_are_not_promoted(self):
        self.main.write_text('TS_MODE=tun\n')
        self.shell('conf_activate_runtime')
        (self.conf / 'routes.conf').write_text('ROUTE_SCOPE=selected\nUID_LIST="10001"\n')
        self.shell('! conf_apply_runtime routes.conf && load_runtime_conf && test "$ROUTE_SCOPE" = all')

    def test_corrupt_or_incomplete_snapshot_never_falls_back_to_desired(self):
        self.shell('conf_activate_runtime')
        snapshot = self.run / (self.run / 'applied-config').read_text().strip()
        (snapshot / 'routes.conf').unlink()
        self.shell('! load_runtime_conf')
        (self.run / 'applied-config').write_text('../conf\n')
        self.shell('! load_runtime_conf')

    def test_failed_snapshot_publication_preserves_previous_runtime(self):
        self.shell('conf_activate_runtime; conf_write_key foxytail.conf WATCHDOG off')
        self.shell('''
mv() {
  for arg do [ "$arg" != "$TS_RUN_DIR/applied-config" ] || return 1; done
  command mv "$@"
}
if conf_activate_runtime; then exit 1; fi
load_runtime_conf && test "$WATCHDOG" = on
''')

    def test_pending_without_snapshot_fails_closed_until_explicit_activation(self):
        self.shell('''
conf_write_key foxytail.conf WATCHDOG off || exit 1
if load_runtime_conf; then exit 2; fi
if conf_apply_runtime context.conf; then exit 3; fi
conf_activate_runtime && load_runtime_conf && test "$WATCHDOG" = off
''')

    def test_hot_promotion_rejects_nonregular_pointer(self):
        (self.run / 'applied-config').mkdir()
        self.shell('! conf_apply_runtime routes.conf && ! conf_activate_runtime')
        self.assertEqual(list((self.run / 'applied-config').iterdir()), [])


if __name__ == '__main__':
    unittest.main()
