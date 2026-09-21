"""Applied configuration and recovery entrypoints, entirely in private fixtures."""
from pathlib import Path
import os
import shlex
import subprocess
import tempfile
import unittest
import shutil
import json
import signal
import time

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
        output = self.shell(self.service_functions() + '''
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
        # A repeated start keeps the runtime snapshot and still reports the
        # reconciler's failure to its caller.
        output = self.shell(self.service_functions() + '''
is_running() { return 0; }
reconcile_companions() { test "$TS_MODE" = bridge || return 9; echo reconciled; return 7; }
start_service
test "$?" = 7
''')
        self.assertEqual(output.strip(), 'reconciled')

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


class ConfigurationTrialTests(unittest.TestCase):
    """Exercise the real detached worker with a private, inert service boundary."""

    def setUp(self):
        RuntimeConfigTests.setUp(self)
        self.addCleanup(self.stop_worker)
        self.journal = self.base / 'state/config-trial'
        self.binary = self.base / 'bin'
        self.binary.mkdir()
        self.clock = self.run / 'clock'
        self.clock.write_text('100')
        with self.settings.open('a') as settings:
            settings.write('\n# Private fixture process boundary.\n'
                           'pids_of_path() { case "$1" in */tailscaled) [ -f "$TS_RUN_DIR/daemon-stopped" ] || echo 42 ;; */hev-socks5-tunnel) [ ! -f "$TS_RUN_DIR/hev-running" ] || echo 43 ;; esac; }\n'
                           'detach_from_app_cgroup() { return 0; }\n'
                           'daemon_pid_alive() { return 1; }\n')
        self.write_executable(self.binary / 'date', '#!/bin/sh\n'
                              '[ "$1" != +%s ] || { cat ' + shlex.quote(str(self.clock)) + '; exit; }\n'
                              'exec /bin/date "$@"\n')
        self.write_executable(self.binary / 'tailscale', '#!/bin/sh\n'
                              'test ! -f ' + shlex.quote(str(self.run / 'health-failed')) + ' || exit 1\n'
                              'echo \'{"BackendState":"Running"}\'\n')
        self.write_executable(self.binary / 'ip', '#!/bin/sh\nexit 0\n')
        self.write_executable(self.scripts / 'foxytail.trial',
                              (ROOT / 'tailscale/scripts/foxytail.trial').read_text().replace('#!/system/bin/sh', '#!/bin/sh', 1))
        self.write_executable(self.scripts / 'start.sh', '''#!/bin/sh
DIR=$(dirname "$(realpath "$0")")
. "${DIR}/../settings.sh"
[ "$1" = reload-trial ] || exit 1
_lock_identity
token=$_LOCK_TOKEN
_owner_lock_acquire "$TS_RUN_DIR/.service-lock" "$token" 100 0.05 || exit 1
trap '_owner_lock_release "$TS_RUN_DIR/.service-lock" "$token"' 0
next=$("$DIR/foxytail.trial" prepare "$2" "$3") || exit 1
echo "$2 $3" >>"$TS_RUN_DIR/service-calls"
while [ -e "$TS_RUN_DIR/hold-$3" ]; do sleep 0.05; done
_TRIAL_ID=$2
conf_activate_runtime "$next"
''')
        self.shell('conf_activate_runtime')

    shell = RuntimeConfigTests.shell

    @staticmethod
    def write_executable(path, content):
        path.write_text(content)
        path.chmod(0o755)

    def trial(self, *args, ok=True):
        result = subprocess.run([str(self.scripts / 'foxytail.trial'), *args],
                                cwd=self.base, text=True, capture_output=True, timeout=10)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def wait_status(self, expected):
        deadline = time.monotonic() + 7
        while time.monotonic() < deadline:
            if (self.journal / 'status').exists() and (self.journal / 'status').read_text().strip() == expected:
                return
            time.sleep(0.05)
        log = (self.run / 'foxytail.log').read_text() if (self.run / 'foxytail.log').exists() else ''
        self.fail(f'trial did not become {expected}: ' + log)

    def begin(self, mode='saved'):
        result = json.loads(self.trial('begin', '30', mode).stdout)
        return result['trial']['id']

    def stop_worker(self):
        if not self.journal.exists():
            return
        (self.journal / 'status').write_text('superseded\n')
        for hold in self.run.glob('hold-*'):
            hold.unlink()
        worker = self.journal / 'worker'
        if worker.exists():
            try:
                os.kill(int(worker.read_text().split()[0]), signal.SIGTERM)
            except ProcessLookupError:
                pass
        time.sleep(0.1)

    def runtime_mode(self):
        return self.shell('load_runtime_conf && echo "$TS_MODE"').strip()

    def test_timeout_rolls_back_without_any_status_poll_or_frontend(self):
        self.begin('proxy')
        self.wait_status('running')
        self.assertEqual(self.runtime_mode(), 'proxy')
        self.clock.write_text('200')
        self.wait_status('rolled-back')
        self.assertEqual(self.runtime_mode(), 'bridge')
        self.assertTrue((self.run / 'settings.pending').exists())

    def test_confirmation_persists_trial_choice_and_keeps_later_saved_settings(self):
        trial_id = self.begin('proxy')
        self.wait_status('running')
        self.trial('confirm', trial_id)
        self.assertEqual(self.runtime_mode(), 'proxy')
        self.assertIn('TS_MODE=proxy', self.main.read_text())
        self.assertFalse((self.run / 'settings.pending').exists())
        time.sleep(1.1)  # The confirmed worker leaves its timer before another trial.
        trial_id = self.begin('bridge')
        self.wait_status('running')
        self.shell('conf_write_key foxytail.conf SOCKS_PORT 1300')
        self.trial('confirm', trial_id)
        self.assertEqual(self.runtime_mode(), 'bridge')
        self.assertEqual(self.shell('load_conf && echo "$SOCKS_PORT"').strip(), '1300')
        self.assertIn('TS_MODE=proxy', self.main.read_text())
        self.assertTrue((self.run / 'settings.pending').exists())

    def test_expiry_and_failed_health_preserve_later_saves(self):
        trial_id = self.begin('proxy')
        self.wait_status('running')
        self.shell('conf_write_key foxytail.conf SOCKS_PORT 1300')
        self.trial('revert', trial_id)
        self.wait_status('rolled-back')
        self.assertEqual(self.runtime_mode(), 'bridge')
        self.assertEqual(self.shell('load_conf && echo "$SOCKS_PORT"').strip(), '1300')
        (self.run / 'health-failed').touch()
        self.begin('proxy')
        self.wait_status('rolled-back')
        self.assertEqual(self.runtime_mode(), 'bridge')
        self.assertIn('health check failed', (self.journal / 'reason').read_text())

    def test_status_recovers_dead_worker_once_without_waiting_for_rollback(self):
        self.begin('proxy')
        self.wait_status('running')
        old_pid = int((self.journal / 'worker').read_text().split()[0])
        os.kill(old_pid, signal.SIGKILL)
        time.sleep(0.1)
        self.clock.write_text('200')
        hold = self.run / 'hold-previous'
        hold.touch()
        started = time.monotonic()
        self.trial('status')
        self.assertLess(time.monotonic() - started, 2)
        self.wait_status('rolling-back')
        worker = (self.journal / 'worker').read_text()
        for _ in range(3):
            self.trial('check')
        self.assertEqual((self.journal / 'worker').read_text(), worker)
        self.assertNotEqual(int(worker.split()[0]), old_pid)
        hold.unlink()
        self.wait_status('rolled-back')
        self.assertEqual(self.runtime_mode(), 'bridge')

    def test_boot_recovery_and_explicit_stop_do_not_activate_saved_candidate(self):
        self.begin('proxy')
        self.wait_status('running')
        self.shell('conf_write_key foxytail.conf SOCKS_PORT 1300')
        self.assertNotEqual(self.trial('boot', ok=False).returncode, 0)
        self.assertEqual(self.runtime_mode(), 'proxy')
        os.kill(int((self.journal / 'worker').read_text().split()[0]), signal.SIGKILL)
        time.sleep(0.1)
        (self.run / 'daemon-stopped').touch()
        (self.run / 'hev-running').touch()
        self.assertNotEqual(self.trial('boot', ok=False).returncode, 0)
        self.assertEqual(self.runtime_mode(), 'proxy')
        (self.run / 'hev-running').unlink()
        self.trial('boot')
        self.wait_status('rolled-back')
        self.assertEqual(self.runtime_mode(), 'bridge')
        self.assertEqual(self.shell('load_conf && echo "$SOCKS_PORT"').strip(), '1300')
        (self.run / 'daemon-stopped').unlink()
        time.sleep(1.1)
        self.begin('proxy')
        self.wait_status('running')
        self.trial('supersede')
        calls = (self.run / 'service-calls').read_text()
        self.clock.write_text('200')
        time.sleep(1.1)
        self.trial('check')
        self.assertEqual((self.run / 'service-calls').read_text(), calls)
        self.assertEqual((self.journal / 'status').read_text().strip(), 'superseded')

    def test_stale_id_and_expired_confirmation_cannot_apply_or_confirm(self):
        trial_id = self.begin('proxy')
        self.wait_status('running')
        before = (self.run / 'service-calls').read_text()
        self.assertNotEqual(self.trial('confirm', 'old-trial', ok=False).returncode, 0)
        self.assertNotEqual(self.trial('revert', 'old-trial', ok=False).returncode, 0)
        self.assertNotEqual(self.trial('prepare', 'old-trial', 'previous', ok=False).returncode, 0)
        self.assertEqual((self.run / 'service-calls').read_text(), before)
        self.clock.write_text('200')
        self.assertNotEqual(self.trial('confirm', trial_id, ok=False).returncode, 0)
        self.wait_status('rolled-back')
        self.assertNotEqual((self.journal / 'status').read_text().strip(), 'confirmed')

    def test_dns_readiness_failure_rolls_back_even_if_state_claims_running(self):
        self.shell('conf_write_key foxytail.conf MAGIC_DNS on; conf_write_key foxytail.conf DNS_MODE local')
        self.write_executable(self.scripts / 'foxytail.dns', '#!/bin/sh\n'
                              'echo \'{"state":"running","mode":"local","enabled":true,"reason":"local",'
                              '"listenerReady":false,"repairNeeded":true,"policyState":"lost"}\'\n')
        self.begin('proxy')
        self.wait_status('rolled-back')
        self.assertEqual(self.runtime_mode(), 'bridge')
        self.assertIn('health check failed', (self.journal / 'reason').read_text())

    def test_installation_preserves_unconfirmed_journal_for_cold_recovery(self):
        self.begin('proxy')
        self.wait_status('running')
        calls = (self.run / 'service-calls').read_text()
        (self.base / '.installing').touch()
        time.sleep(1.1)
        self.trial('check')
        self.assertEqual((self.run / 'service-calls').read_text(), calls)
        self.assertEqual((self.journal / 'status').read_text().strip(), 'running')
        (self.run / 'daemon-stopped').touch()
        (self.base / '.installing').unlink()
        self.trial('boot')
        self.assertEqual(self.runtime_mode(), 'bridge')
        self.assertEqual((self.journal / 'status').read_text().strip(), 'rolled-back')


if __name__ == '__main__':
    unittest.main()
