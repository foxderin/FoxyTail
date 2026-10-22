"""TUN lifecycle fault injection with local files, fake PIDs, and custom hooks."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class TunLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxytail-tun-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        for directory in ('bin', 'scripts', 'run/pids'):
            (self.base / directory).mkdir(parents=True)
        self.scripts = self.base / 'scripts'
        self.runner = self.scripts / 'foxytail.tun'
        self.runner.write_text((ROOT / 'tailscale/scripts/foxytail.tun').read_text())
        (self.scripts / 'foxytail.tun.config.yaml').write_text(
            (ROOT / 'tailscale/scripts/foxytail.tun.config.yaml').read_text())
        self.pid = self.base / 'run/pids/hev-socks5-tunnel.pid'
        self.pending = self.base / 'run/hev.pending'
        self.env = {**os.environ, 'TEST_DIR': str(self.base)}
        # Exercise the real exact-path filter, with every process lookup and
        # stop replaced. No /proc reads, host signals, or Android commands.
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        ownership = settings[settings.index('pids_of_path() {'):settings.index('stop_by_pids() {')]
        (self.base / 'settings.sh').write_text(r'''
TS_BIN_DIR="$TEST_DIR/bin"
TS_SCRIPTS_DIR="$TEST_DIR/scripts"
TS_RUN_DIR="$TEST_DIR/run"
TS_PID_DIR="$TS_RUN_DIR/pids"
TUN_IFACE=tailscale0
ensure_run_dirs() { mkdir -p "$TS_PID_DIR"; }
iface_exists() { ip link show dev "${TUN_IFACE}" >/dev/null 2>&1; }
load_conf() { echo unexpected-desired-conf >>"$TEST_DIR/events"; return 99; }
load_runtime_conf() {
  TS_MODE=bridge; SOCKS_PORT=1099; IPV6=off
  [ ! -f "$TEST_DIR/bad-runtime-conf" ]
}
log() { printf '%s: %s\n' "$1" "$2" >>"$TEST_DIR/service.log"; }
rotate_log() { :; }
pids_of() {
  [ ! -f "$TEST_DIR/alive" ] || printf '%s\n' 101 102
  echo 999
}
readlink() {
  case "$1" in
    /proc/101/exe|/proc/102/exe) echo "$TS_BIN_DIR/hev-socks5-tunnel" ;;
    /proc/999/exe) echo /foreign/bin/hev-socks5-tunnel ;;
    *) return 99 ;;
  esac
}
_proc_cmdline() {
  case "$1" in
    101) echo "$TS_BIN_DIR/hev-socks5-tunnel" ;;
    102) echo hev-socks5-tunnel ;;
    *) return 99 ;;
  esac
}
stop_by_pids() {
  printf 'stop:%s\n' "$(printf '%s' "$2" | tr '\n' ',')" >>"$TEST_DIR/events"
  [ "$1" = hev-socks5-tunnel ] && [ "$2" = "$(printf '101\n102')" ] || return 99
  [ ! -f "$TEST_DIR/stop-failed" ] || return 1
  rm -f "$TEST_DIR/alive" "$TEST_DIR/interface"
}
ip() {
  [ "$*" = 'link show dev tailscale0' ] || return 99
  test -f "$TEST_DIR/interface"
}
nohup() { "$@"; }
wait_for() {
  # The fake helper exits after publishing its local state. Join it so
  # assertions do not depend on background scheduling or arbitrary sleeps.
  wait
  [ ! -f "$TEST_DIR/wait-failed" ] || return 1
  shift 3
  "$@"
}
sleep() { echo sleep >>"$TEST_DIR/events"; }
''' + ownership)
        self.executable(self.base / 'bin/hev-socks5-tunnel', '''#!/bin/sh
echo launch >>"$TEST_DIR/events"
touch "$TEST_DIR/alive" "$TEST_DIR/interface"
echo fixture-hev-log
''')
        self.executable(self.scripts / 'foxytail.tun.up', '''#!/bin/sh
echo up >>"$TEST_DIR/events"
test -f "$TEST_DIR/interface" || exit 99
test ! -f "$TEST_DIR/partial-up" || exit 98
touch "$TEST_DIR/partial-up"
[ ! -f "$TEST_DIR/up-failed" ] || exit 9
''')
        self.executable(self.scripts / 'foxytail.tun.down', '''#!/bin/sh
echo down >>"$TEST_DIR/events"
test ! -f "$TEST_DIR/alive" || exit 99
[ ! -f "$TEST_DIR/down-failed" ] || exit 9
rm -f "$TEST_DIR/partial-up"
''')

    def executable(self, path, text):
        path.write_text(text)
        path.chmod(0o755)

    def bundled_hooks(self):
        for name in ('foxytail.tun.up', 'foxytail.tun.down'):
            source = (ROOT / 'tailscale/scripts' / name).read_text()
            self.executable(self.scripts / name, source.replace('#!/system/bin/sh', '#!/bin/sh', 1))
        self.executable(self.scripts / 'foxytail.route', '''#!/bin/sh
echo "route:$1" >>"$TEST_DIR/events"
[ ! -f "$TEST_DIR/route-$1-failed" ] || exit 9
''')

    def run_tun(self, command, expected=0):
        result = subprocess.run(['sh', str(self.runner), command], cwd=self.base,
                                env=self.env, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def events(self):
        path = self.base / 'events'
        return path.read_text().splitlines() if path.exists() else []

    def running(self, interface=True):
        (self.base / 'alive').touch()
        if interface:
            (self.base / 'interface').touch()
        # A stale PID file never grants ownership of the foreign process.
        self.pid.write_text('999\n')
        (self.base / 'run/hev.yaml').write_text('runtime-config\n')
        (self.base / 'run/hev-socks5-tunnel.log').write_text('diagnostic-log\n')

    def test_failed_down_blocks_restart_until_cleanup_succeeds(self):
        self.running()
        failed = self.base / 'down-failed'
        failed.touch()
        self.run_tun('stop', expected=1)
        self.assertEqual(self.events(), ['stop:101,102', 'down'])
        self.assertFalse((self.base / 'alive').exists())
        self.assertTrue(self.pending.exists())
        self.assertEqual(self.pid.read_text(), '999\n')
        self.assertIn('down hook failed', (self.base / 'service.log').read_text())
        self.run_tun('restart', expected=1)
        self.assertEqual(self.events(), ['stop:101,102', 'down', 'down'])
        failed.unlink()
        self.run_tun('restart')
        self.assertEqual(self.events()[-4:], ['down', 'sleep', 'launch', 'up'])
        self.assertFalse(self.pending.exists())

    def test_unresolved_stop_retains_ownership_and_diagnostics(self):
        self.running()
        (self.base / 'stop-failed').touch()
        for command in ('stop', 'restart', 'start'):
            with self.subTest(command=command):
                self.run_tun(command, expected=1)
                self.assertTrue((self.base / 'alive').exists())
                self.assertTrue(self.pending.exists())
                self.assertEqual(self.pid.read_text(), '999\n')
                self.assertEqual((self.base / 'run/hev.yaml').read_text(), 'runtime-config\n')
                self.assertEqual((self.base / 'run/hev-socks5-tunnel.log').read_text(),
                                 'diagnostic-log\n')
        self.assertEqual(self.events(), ['stop:101,102'] * 3)

    def test_up_failure_rolls_back_before_retrying_custom_hook(self):
        failed = self.base / 'up-failed'
        failed.touch()
        for _ in range(2):
            self.run_tun('start', expected=1)
            for path in ('alive', 'interface', 'partial-up'):
                self.assertFalse((self.base / path).exists())
            self.assertFalse(self.pid.exists())
            self.assertFalse(self.pending.exists())
        self.assertEqual(self.events(), ['launch', 'up', 'stop:101,102', 'down'] * 2)
        failed.unlink()
        self.run_tun('start')
        self.assertEqual(self.events()[-2:], ['launch', 'up'])
        before = self.events()
        self.run_tun('start')
        self.assertEqual(self.events(), before)

    def test_failed_rollback_never_takes_already_running_fast_path(self):
        (self.base / 'up-failed').touch()
        (self.base / 'stop-failed').touch()
        self.run_tun('start', expected=1)
        self.assertEqual(self.events(), ['launch', 'up', 'stop:101,102'])
        self.assertTrue(self.pending.exists())
        self.assertTrue(self.pid.exists())
        (self.base / 'up-failed').unlink()
        self.run_tun('start', expected=1)
        self.assertEqual(self.events(), ['launch', 'up', 'stop:101,102', 'stop:101,102'])
        self.assertTrue((self.base / 'interface').exists())
        self.assertIn('rollback incomplete', (self.base / 'service.log').read_text())
        (self.base / 'stop-failed').unlink()
        self.run_tun('start')
        self.assertEqual(self.events()[-4:], ['stop:101,102', 'down', 'launch', 'up'])
        self.assertFalse(self.pending.exists())

    def test_failed_rollback_down_is_retried_before_launch(self):
        (self.base / 'up-failed').touch()
        (self.base / 'down-failed').touch()
        self.run_tun('start', expected=1)
        self.assertEqual(self.events(), ['launch', 'up', 'stop:101,102', 'down'])
        self.assertTrue(self.pending.exists())
        self.assertTrue((self.base / 'partial-up').exists())
        self.run_tun('start', expected=1)
        self.assertEqual(self.events(), ['launch', 'up', 'stop:101,102', 'down', 'down'])
        (self.base / 'up-failed').unlink()
        (self.base / 'down-failed').unlink()
        self.run_tun('start')
        self.assertEqual(self.events()[-3:], ['down', 'launch', 'up'])
        self.assertFalse(self.pending.exists())

    def test_missing_interface_recovery_respects_down_failure(self):
        self.running(interface=False)
        (self.base / 'down-failed').touch()
        self.run_tun('start', expected=1)
        self.assertEqual(self.events(), ['stop:101,102', 'down'])
        self.assertTrue(self.pending.exists())
        (self.base / 'down-failed').unlink()
        self.run_tun('start')
        self.assertEqual(self.events()[-3:], ['down', 'launch', 'up'])

    def test_timeout_cannot_turn_into_success_without_the_up_hook(self):
        (self.base / 'wait-failed').touch()
        self.run_tun('start', expected=1)
        self.assertEqual(self.events(), ['launch'])
        self.assertTrue(self.pending.exists())
        (self.base / 'wait-failed').unlink()
        self.run_tun('start')
        self.assertEqual(self.events(), ['launch', 'stop:101,102', 'down', 'launch', 'up'])
        self.assertFalse(self.pending.exists())

    def test_absent_hooks_preserve_successful_start_stop_and_restart(self):
        for name in ('foxytail.tun.up', 'foxytail.tun.down'):
            (self.scripts / name).unlink()
        self.run_tun('start')
        self.run_tun('start')
        self.assertEqual(self.events(), ['launch'])
        self.run_tun('restart')
        self.assertEqual(self.events(), ['launch', 'stop:101,102', 'sleep', 'launch'])
        self.run_tun('stop')
        self.assertFalse(self.pid.exists())
        self.assertFalse(self.pending.exists())
        before = self.events()
        self.run_tun('stop')
        self.assertEqual(self.events(), before)

    def test_start_and_status_require_runtime_config(self):
        result = self.run_tun('status')
        self.assertIn('Mode: bridge, socks5: 127.0.0.1:1099', result.stdout)
        (self.base / 'bad-runtime-conf').touch()
        for command in ('start', 'status'):
            with self.subTest(command=command):
                self.run_tun(command, expected=1)
        self.assertEqual(self.events(), [])

    def test_bundled_hooks_propagate_route_status_and_use_runtime_config(self):
        self.bundled_hooks()
        for hook, action in (('up', 'apply'), ('down', 'teardown')):
            with self.subTest(hook=hook):
                failed = self.base / f'route-{action}-failed'
                failed.touch()
                for expected in (9, 0):
                    result = subprocess.run(['sh', str(self.scripts / f'foxytail.tun.{hook}')],
                                            env=self.env, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                    if failed.exists():
                        failed.unlink()
        self.assertEqual(self.events(), ['route:apply'] * 2 + ['route:teardown'] * 2)
        (self.base / 'bad-runtime-conf').touch()
        for hook, expected in (('up', 1), ('down', 0)):
            result = subprocess.run(['sh', str(self.scripts / f'foxytail.tun.{hook}')],
                                    env=self.env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertEqual(self.events(), ['route:apply'] * 2 + ['route:teardown'] * 3)

    def test_bundled_apply_failure_rolls_back_tunnel(self):
        self.bundled_hooks()
        (self.base / 'route-apply-failed').touch()
        self.run_tun('start', expected=1)
        self.assertEqual(self.events(), ['launch', 'route:apply', 'stop:101,102', 'route:teardown'])
        self.assertFalse((self.base / 'alive').exists())
        self.assertFalse(self.pending.exists())
        (self.base / 'route-apply-failed').unlink()
        self.run_tun('start')
        self.assertEqual(self.events()[-2:], ['launch', 'route:apply'])

    def test_bundled_teardown_failure_aborts_restart(self):
        self.bundled_hooks()
        self.running()
        (self.base / 'route-teardown-failed').touch()
        self.run_tun('restart', expected=1)
        self.assertEqual(self.events(), ['stop:101,102', 'route:teardown'])
        self.assertTrue(self.pending.exists())
        (self.base / 'route-teardown-failed').unlink()
        self.run_tun('restart')
        self.assertEqual(self.events()[-4:], ['route:teardown', 'sleep', 'launch', 'route:apply'])

    def test_bad_runtime_config_does_not_prevent_cleanup_or_signal_stale_pid(self):
        self.running()
        (self.base / 'bad-runtime-conf').touch()
        self.run_tun('stop')
        self.assertEqual(self.events(), ['stop:101,102', 'down'])
        self.pid.write_text('999\n')
        self.run_tun('stop')
        self.assertEqual(self.events(), ['stop:101,102', 'down', 'down'])
        self.assertFalse(self.pid.exists())
        self.assertFalse(self.pending.exists())


if __name__ == '__main__':
    unittest.main()
