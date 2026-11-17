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
import socket
import sys

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


    def service_functions(self):
        source = (ROOT / 'tailscale/scripts/foxytail.service').read_text()
        return source[source.index('daemon_pids() {'):source.index('# Serialize all controllers')]


    def test_candidate_is_fixed_before_stop_and_preserves_newer_pending(self):
        self.shell('conf_activate_runtime; conf_write_key foxytail.conf SOCKS_PORT 1200')
        self.shell(self.service_functions() + '''
TS_DAEMON_CMD=true
PID_FILE="$TS_RUN_DIR/daemon.pid"
is_running() { return 1; }
daemon_pids() { echo 42; }
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


    def test_start_rejects_daemon_disappearing_after_socket_readiness(self):
        self.main.write_text('TS_MODE=proxy\nMAGIC_DNS=off\n')
        self.shell('conf_activate_runtime')
        self.shell(self.service_functions() + '''
_SERVICE_RECOVERY=1
TS_DAEMON_CMD=true
PID_FILE="$TS_RUN_DIR/daemon.pid"
is_running() { return 1; }
daemon_pids() { :; }
wait_socket() { return 0; }
update_mod_desc() { echo "$1" >"$TS_RUN_DIR/description-state"; }
start_service && exit 1
test ! -f "$PID_FILE" || exit 2
test "$(cat "$TS_RUN_DIR/description-state")" = stopped
''')


class ServiceRecoveryTests(unittest.TestCase):
    """Real service command transitions with private daemon/LocalAPI boundaries."""

    shell = RuntimeConfigTests.shell

    def setUp(self):
        RuntimeConfigTests.setUp(self)
        self.main.write_text('TS_MODE=proxy\nMAGIC_DNS=off\n')
        self.binary = self.base / 'bin'
        self.binary.mkdir()
        self.service = self.scripts / 'foxytail.service'
        self.service.write_text((ROOT / 'tailscale/scripts/foxytail.service').read_text().replace(
            '#!/system/bin/sh', '#!/bin/sh', 1))
        self.service.chmod(0o755)
        watchdog = self.scripts / 'foxytail.watchdog'
        watchdog.write_text(watchdog.read_text().replace('"$SERVICE" recover', 'sh "$SERVICE" recover'))
        self.env = {**os.environ, 'MODPATH': str(self.base)}
        # Host process discovery differs from Android /proc. Keep real process
        # liveness, launch, socket I/O, locks, and service dispatch intact.
        with self.settings.open('a') as settings:
            settings.write('''
_fixture_daemon_alive() {
  case "$1" in ''|*[!0-9]*|0|1) return 1 ;; esac
  _fixture_process=$(ps -p "$1" -o stat= -o command= 2>/dev/null) || return 1
  case "$_fixture_process" in *"$TS_BIN_DIR/tailscaled"*) ;; *) return 1 ;; esac
  case "${_fixture_process%% *}" in *Z*) return 1 ;; esac
  kill -0 "$1" 2>/dev/null
}
pids_of_path() {
  case "$1" in */tailscaled)
    _fixture_pid=$(cat "$TS_RUN_DIR/owned-daemon.pid" 2>/dev/null)
    _fixture_daemon_alive "$_fixture_pid" && echo "$_fixture_pid"
    ;;
  esac
}
''')
        self.daemon = self.binary / 'tailscaled'
        self.daemon.write_text('#!' + sys.executable + '\n' + '''
import json, os, pathlib, socket, sys
path = pathlib.Path(next(arg.split('=', 1)[1] for arg in sys.argv if arg.startswith('--socket=')))
run = path.parent
owned = run / 'owned-daemon.pid'
owned.write_text(str(os.getpid()))
if path.exists(): path.unlink()
server = socket.socket(socket.AF_UNIX)
os.chdir(run)
server.bind(path.name)
server.listen()
while True:
    conn, _ = server.accept()
    if not (run / 'api-unavailable').exists():
        conn.sendall(json.dumps({'BackendState': 'NeedsLogin'}).encode())
    conn.close()
''')
        self.daemon.chmod(0o755)
        cli = self.binary / 'tailscale'
        cli.write_text('#!' + sys.executable + '\n' + '''
import os, pathlib, socket, sys
path = pathlib.Path(next(arg.split('=', 1)[1] for arg in sys.argv if arg.startswith('--socket=')))
client = socket.socket(socket.AF_UNIX)
client.settimeout(0.5)
os.chdir(path.parent)
client.connect(path.name)
data = client.recv(4096)
if not data: sys.exit(1)
print(data.decode())
''')
        cli.chmod(0o755)
        if not shutil.which('timeout'):
            timeout = self.binary / 'timeout'
            timeout.write_text('#!' + sys.executable + '\n' + '''
import subprocess, sys
try:
    sys.exit(subprocess.call(sys.argv[2:], timeout=float(sys.argv[1])))
except subprocess.TimeoutExpired:
    sys.exit(124)
''')
            timeout.chmod(0o755)
        dns = self.scripts / 'foxytail.dns'
        dns.write_text('#!/bin/sh\ntest ! -f ' + shlex.quote(str(self.run / 'dns-failure')) + '\n')
        dns.chmod(0o755)
        self.addCleanup(self.stop_private_daemon)

    def stop_private_daemon(self):
        owned = self.run / 'owned-daemon.pid'
        if owned.exists():
            pid = int(owned.read_text())
            process = subprocess.run(['ps', '-p', str(pid), '-o', 'command='],
                                     text=True, capture_output=True)
            if str(self.daemon) in process.stdout:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def control(self, *args, ok=True):
        result = subprocess.run(['sh', str(self.service), *args], cwd=self.base, env=self.env,
                                text=True, capture_output=True, timeout=20, start_new_session=True)
        if ok:
            logs = ''.join(path.read_text() for path in self.run.glob('*.log'))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr + logs)
        return result

    def watchdog_round(self):
        result = subprocess.run(['sh', str(self.scripts / 'foxytail.watchdog'), 'check-once'],
                                cwd=self.base, env=self.env, text=True, capture_output=True, timeout=20,
                                start_new_session=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_failed_recovery_teardown_remains_retryable_and_stop_is_respected(self):
        self.control('start')
        (self.run / 'dns-failure').touch()
        self.assertNotEqual(self.control('recover', 'restart', ok=False).returncode, 0)
        self.assertFalse((self.run / 'manual-stop').exists())
        self.assertFalse((self.run / 'pids/tailscaled.pid').exists())
        (self.run / 'dns-failure').unlink()
        self.watchdog_round()
        self.assertTrue((self.run / 'pids/tailscaled.pid').read_text().strip().isdigit())
        (self.run / 'dns-failure').touch()
        self.assertNotEqual(self.control('stop', ok=False).returncode, 0)
        (self.run / 'dns-failure').unlink()
        marker = (self.run / 'manual-stop').read_bytes()
        self.control('recover', 'restart')
        self.watchdog_round()
        self.assertEqual((self.run / 'manual-stop').read_bytes(), marker)
        self.assertFalse((self.run / 'pids/tailscaled.pid').exists())


    def test_trial_rollback_after_context_down_restores_preference_after_daemon_start(self):
        self.control('start')
        self.control('context', 'down')
        journal = self.base / 'state/config-trial'
        journal.mkdir(parents=True)
        (journal / 'id').write_text('retained')
        (journal / 'status').write_text('rolling-back')
        trial = self.scripts / 'foxytail.trial'
        trial.write_text('#!/bin/sh\nDIR=$(dirname "$0")\n. "$DIR/../settings.sh"\n'
                         '[ "$1" = prepare ] || exit 1\n'
                         '_conf_runtime_dir && conf_prepare_runtime "$_RUNTIME_CONF_DIR"\n')
        trial.chmod(0o755)
        start = self.scripts / 'start.sh'
        start.write_text('#!/bin/sh\ncase "$1" in pause-residents|resume-residents) exit 0 ;; *) exit 1 ;; esac\n')
        start.chmod(0o755)
        helper = self.scripts / 'foxytail.exitnode'
        helper.write_text('#!/bin/sh\nDIR=$(dirname "$0")\n. "$DIR/../settings.sh"\n'
                          '[ "$1" = trial-restore ] && [ "$2" = "$TS_DIR/state/config-trial" ] || exit 1\n'
                          'tailscale --socket="$TS_SOCKET" status --json >/dev/null || exit 1\n'
                          'echo restored >>"$TS_RUN_DIR/preference-restored"\n')
        helper.chmod(0o755)
        self.control('trial', 'retained', 'previous')
        self.assertFalse((self.run / 'context-stop').exists())
        self.assertFalse((self.run / 'manual-stop').exists())
        self.assertEqual((self.run / 'preference-restored').read_text(), 'restored\n')
        (journal / 'status').write_text('rolled-back')
        self.control('recover', 'reconcile')
        self.assertEqual((self.run / 'preference-restored').read_text(), 'restored\nrestored\n')

    def test_failed_launch_cannot_use_stale_socket_to_report_running(self):
        stale = socket.socket(socket.AF_UNIX)
        stale.bind(str(self.run / 'tailscaled.sock'))
        stale.close()
        self.daemon.write_text('#!/bin/sh\nexit 1\n')
        result = self.control('start', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.run / 'pids/tailscaled.pid').exists())


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
        self.wall_clock = self.run / 'wall-clock'
        self.wall_clock.write_text('100')
        with self.settings.open('a') as settings:
            settings.write('\n# Private fixture process boundary.\n'
                           'pids_of_path() { case "$1" in */tailscaled) [ -f "$TS_RUN_DIR/daemon-stopped" ] || echo 42 ;; */hev-socks5-tunnel) [ ! -f "$TS_RUN_DIR/hev-running" ] || echo 43 ;; esac; }\n'
                           'detach_from_app_cgroup() { return 0; }\n'
                           'monotonic_seconds() { cat "$TS_RUN_DIR/clock"; }\n')
        self.write_executable(self.binary / 'date', '#!/bin/sh\n'
                              '[ "$1" != +%s ] || { cat ' + shlex.quote(str(self.wall_clock)) + '; exit; }\n'
                              'exec /bin/date "$@"\n')
        self.write_executable(self.binary / 'tailscale', '#!/bin/sh\n'
                              'if [ -f ' + shlex.quote(str(self.run / 'hold-health')) + ' ] && [ "$(cat ' + shlex.quote(str(self.journal / 'status')) + ' 2>/dev/null)" = running ]; then\n'
                              '  touch ' + shlex.quote(str(self.run / 'health-entered')) + '\n'
                              '  while [ -f ' + shlex.quote(str(self.run / 'hold-health')) + ' ]; do sleep 0.02; done\n'
                              'fi\n'
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

    def test_wall_clock_changes_do_not_extend_or_expire_elapsed_trial(self):
        trial_id = self.begin('proxy')
        self.wait_status('running')
        for wall in ('1', '99999999'):
            self.wall_clock.write_text(wall)
            time.sleep(1.1)
            self.assertEqual((self.journal / 'status').read_text().strip(), 'running')
            status = json.loads(self.trial('status').stdout)['trial']
            self.assertEqual(status['remaining'], 30)
        self.clock.write_text('131')
        self.assertNotEqual(self.trial('confirm', trial_id, ok=False).returncode, 0)
        self.wait_status('rolled-back')

    def test_changed_boot_identity_expires_trial_even_before_elapsed_deadline(self):
        self.begin('proxy')
        self.wait_status('running')
        (self.journal / 'boot').write_text('previous-boot\n')
        self.wait_status('rolled-back')
        self.assertEqual(self.runtime_mode(), 'bridge')


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
        worker = (self.journal / 'worker').read_text().split()[0]
        deadline = time.monotonic() + 7
        while time.monotonic() < deadline:
            probe = subprocess.run(['sh', '-c', '. "$1"; _proc_starttime "$2"', 'probe', str(self.settings), worker], capture_output=True, text=True)
            if probe.returncode != 0:
                break
            time.sleep(0.05)
        self.assertNotEqual(probe.returncode, 0, 'installation must wait for the trial worker to exit')
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
