"""Host-safe log monitor tests using its source-only public library entrypoint."""
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / 'tailscale/scripts/foxytail.log-lib.sh'
OLD = ROOT / 'tests/fixtures/logd-v1.3.0.sh'


class LogdTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.run = self.directory / 'run'
        self.conf = self.directory / 'conf'
        self.run.mkdir()
        (self.run / 'pids').mkdir()
        self.conf.mkdir()
        (self.conf / 'foxytail.conf').write_text('LOG_MAX_KB="64"\nWATCHDOG="off"\n')
        (self.conf / 'routes.conf').write_text('ROUTE_SCOPE="all"\n')
        self.env = {**os.environ, 'TEST_DIR': str(self.directory), 'TEST_ROOT': str(ROOT)}

    def prelude(self):
        # Source production helpers whole; no function-order/string slicing.
        # Bash's function export lets the fixture count calls without copying
        # a parser/rotation implementation into a mock.
        return '''
. "$TEST_ROOT/tailscale/settings.sh"
TS_DIR="$TEST_DIR"; TS_RUN_DIR="$TEST_DIR/run"; TS_CONF_DIR="$TEST_DIR/conf"
TS_PID_DIR="$TS_RUN_DIR/pids"; TS_RUN_LOG_FILE="$TS_RUN_DIR/foxytail.log"
. "$TEST_ROOT/tailscale/scripts/foxytail.log-lib.sh"
eval "_real_$(declare -f load_conf)"
load_conf() { echo load >>"$TEST_DIR/metrics"; _real_load_conf "$@"; }
eval "_real_$(declare -f logd_rotate_all)"
logd_rotate_all() { echo scan >>"$TEST_DIR/metrics"; _real_logd_rotate_all "$@"; }
'''

    def shell(self, script, timeout=20):
        result = subprocess.run(['bash', '-c', self.prelude() + script],
                                env=self.env, cwd=self.directory, text=True,
                                capture_output=True, timeout=timeout)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def metrics(self):
        path = self.directory / 'metrics'
        return path.read_text().splitlines() if path.exists() else []

    def wait_for(self, predicate, seconds=5):
        deadline = time.monotonic() + seconds
        while not predicate():
            self.assertLess(time.monotonic(), deadline, 'observable condition did not arrive')
            time.sleep(.02)

    def cleanup_process(self, process):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.communicate(timeout=5)

    def test_library_source_has_no_runtime_side_effects(self):
        result = subprocess.run(['sh', '-c', '. "$1"', 'sh', str(LIB)],
                                cwd=self.directory, text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout + result.stderr, '')
        self.assertEqual(list(self.run.iterdir()), [self.run / 'pids'])

    def test_unchanged_pair_does_not_reparse_or_take_writer_lock(self):
        self.shell('''
logd_reload_config
conf_lock_acquire() { echo unexpected-lock >&2; return 99; }
i=0
while [ "$i" -lt 30 ]; do logd_reload_config || exit 1; i=$((i + 1)); done
test "$LOG_MAX_KB" = 64
''')
        self.assertEqual(self.metrics().count('load'), 1)

    def test_atomic_replace_and_equal_size_edit_are_detected(self):
        self.shell('''
logd_reload_config
echo 'LOG_MAX_KB="65"' >"$TS_CONF_DIR/new.conf"
mv "$TS_CONF_DIR/new.conf" "$TS_CONF_DIR/foxytail.conf"
logd_reload_config
test "$LOG_MAX_KB" = 65
echo 'LOG_MAX_KB="66"' >"$TS_CONF_DIR/foxytail.conf"
logd_reload_config
test "$LOG_MAX_KB" = 66
''')
        self.assertEqual(self.metrics().count('load'), 3)

    def test_invalid_version_is_diagnosed_once_then_recovers(self):
        result = self.shell('''
logd_reload_config
echo 'LOG_MAX_KB="invalid"' >"$TS_CONF_DIR/foxytail.conf"
logd_reload_config
test "$LOG_MAX_KB" = 512
logd_reload_config
logd_reload_config
echo 'LOG_MAX_KB="67"' >"$TS_CONF_DIR/foxytail.conf"
logd_reload_config
test "$LOG_MAX_KB" = 67
''')
        self.assertEqual(result.stderr.count('invalid value for LOG_MAX_KB'), 1)
        self.assertEqual(self.metrics().count('load'), 3)

    def test_signature_never_follows_invalid_configuration_symlinks(self):
        result = self.shell('''
logd_reload_config
rm "$TS_CONF_DIR/foxytail.conf"
ln -s "$TEST_DIR/private-not-config" "$TS_CONF_DIR/foxytail.conf"
echo private-value >"$TEST_DIR/private-not-config"
cksum() { case "$1" in *foxytail.conf) echo unsafe-read >&2; return 99;; esac; command cksum "$@"; }
logd_reload_config
logd_reload_config
test "$LOG_MAX_KB" = 512
''')
        self.assertNotIn('unsafe-read', result.stderr)
        self.assertEqual(result.stderr.count('expected regular file'), 1)

    def test_two_file_restore_is_loaded_only_after_writer_releases_lock(self):
        # Writer deliberately pauses between replacements. The reader's first
        # speculative signature sees the partial pair; load must see the final
        # pair after acquiring the writer's real lock.
        writer = self.prelude() + '''
conf_lock_acquire || exit 1
echo 'LOG_MAX_KB="72"' >"$TS_CONF_DIR/foxytail.conf"
echo ready >"$TEST_DIR/writer-ready"
while [ ! -f "$TEST_DIR/reader-ready" ]; do sleep .01; done
echo 'ROUTE_SCOPE="selected"' >"$TS_CONF_DIR/routes.conf"
conf_lock_release
'''
        process = subprocess.Popen(['bash', '-c', writer], env=self.env, cwd=self.directory,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   start_new_session=True)
        self.addCleanup(self.cleanup_process, process)
        self.wait_for(lambda: (self.directory / 'writer-ready').exists())
        self.shell('''
eval "_before_lock_$(declare -f conf_lock_acquire)"
conf_lock_acquire() { echo ready >"$TEST_DIR/reader-ready"; _before_lock_conf_lock_acquire; }
logd_reload_config
test "$LOG_MAX_KB:$ROUTE_SCOPE" = 72:selected
''')
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, stdout + stderr)

    def test_rotation_preserves_open_writer_and_skips_symlinks_with_watchdog_off(self):
        self.shell('''
logd_reload_config
test "$WATCHDOG" = off
exec 9>>"$TS_RUN_DIR/daemon.log"
head -c 131072 /dev/zero >&9
echo private-value >"$TEST_DIR/private-file"
ln -s "$TEST_DIR/private-file" "$TS_RUN_DIR/symlink.log"
logd_rotate_all
echo next-message >&9
exec 9>&-
test "$(cat "$TS_RUN_DIR/daemon.log")" = next-message
test "$(wc -c <"$TS_RUN_DIR/daemon.log.bak")" -le 65536
test "$(cat "$TEST_DIR/private-file")" = private-value
''')

    def test_concurrent_rotators_do_not_replace_backup_with_empty_file(self):
        logfile = self.run / 'daemon.log'
        logfile.write_bytes(b'x' * 8192)
        script = self.prelude() + '''
LOG_MAX_KB=1
eval "_before_barrier_$(declare -f conf_lock_acquire)"
conf_lock_acquire() {
  echo ready >>"$TEST_DIR/barrier"
  while [ "$(wc -l <"$TEST_DIR/barrier")" -lt 2 ]; do sleep .01; done
  _before_barrier_conf_lock_acquire
}
rotate_log "$TS_RUN_DIR/daemon.log"
'''
        processes = []
        for _ in range(2):
            process = subprocess.Popen(['bash', '-c', script], env=self.env,
                                       cwd=self.directory, text=True, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, start_new_session=True)
            self.addCleanup(self.cleanup_process, process)
            processes.append(process)
        for process in processes:
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stdout + stderr)
        self.assertEqual(logfile.stat().st_size, 0)
        self.assertEqual((self.run / 'daemon.log.bak').read_bytes(), b'x' * 1024)

    def simulate(self, mode):
        # Deterministic clocks exercise the actual event loop. The queued
        # metadata-only health stream must never postpone the 30s audit.
        self.shell('''
_TEST_NOW=0
logd_clock() { _LD_NOW=$_TEST_NOW; }
logd_cleanup() { :; }
logd_stop_events() { _LD_WATCH_PID=; }
logd_start_events() {
  case "$TEST_MODE" in unavailable) return 1;; *) _LD_WATCH_PID=$$;; esac
}
logd_pause() { _TEST_NOW=$((_TEST_NOW + $1)); [ "$_TEST_NOW" -lt "$TEST_HORIZON" ] || _LD_RUNNING=0; }
logd_read_event() {
  case "$TEST_MODE" in
    irrelevant)
      _TEST_NOW=$((_TEST_NOW + 1))
      _lde_events=y _lde_dir=$TS_RUN_DIR _lde_name=foxydns.health.json
      [ "$_TEST_NOW" -lt "$TEST_HORIZON" ] || _LD_RUNNING=0
      return 0;;
    overflow|removed)
      if [ "$_TEST_NOW" = 0 ]; then
        _TEST_NOW=1; _lde_events=o _lde_dir=$TS_RUN_DIR _lde_name=
        [ "$TEST_MODE" != removed ] || _lde_events=x
        return 0
      fi;;
  esac
  case "$1" in 0.01) return 1;; esac
  _TEST_NOW=$((_TEST_NOW + $1))
  [ "$_TEST_NOW" -lt "$TEST_HORIZON" ] || _LD_RUNNING=0
  return 1
}
logd_run
''')

    def test_lost_events_and_irrelevant_traffic_keep_bounded_audits(self):
        for mode in ['silent', 'irrelevant', 'overflow']:
            with self.subTest(mode=mode):
                (self.directory / 'metrics').unlink(missing_ok=True)
                self.env.update(TEST_MODE=mode, TEST_HORIZON='61')
                self.simulate(mode)
                self.assertEqual(self.metrics().count('load'), 1)
                expected = 4 if mode == 'overflow' else 3
                self.assertEqual(self.metrics().count('scan'), expected)

    def test_unavailable_events_retain_original_two_second_capacity_checks(self):
        self.env.update(TEST_MODE='unavailable', TEST_HORIZON='60')
        self.simulate('unavailable')
        self.assertEqual(self.metrics().count('scan'), 30)
        self.assertEqual(self.metrics().count('load'), 1)

    def test_one_removed_watch_falls_back_even_while_other_watch_is_alive(self):
        self.env.update(TEST_MODE='removed', TEST_HORIZON='60')
        self.simulate('removed')
        self.assertEqual(self.metrics().count('scan'), 30)
        self.assertEqual(self.metrics().count('load'), 1)

    def test_measured_idle_workload_matches_saved_v130_fixture(self):
        scripts = self.directory / 'scripts'
        scripts.mkdir()
        shutil.copyfile(OLD, scripts / 'foxytail.logd')
        (self.directory / 'settings.sh').write_text(self.prelude() + '''
ensure_run_dirs() { :; }
daemon_claim_pidfile() { :; }
eval "_real_$(declare -f rotate_log)"
rotate_log() { echo check >>"$TEST_DIR/metrics"; _real_rotate_log "$@"; }
_TEST_NOW=0
isleep() { _TEST_NOW=$((_TEST_NOW + $1)); [ "$_TEST_NOW" -lt 60 ] || _la_running=0; }
''')
        for index in range(8):
            (self.run / f'daemon-{index}.log').write_text('idle\n')
        old = subprocess.run(['bash', str(scripts / 'foxytail.logd'), 'start'], env=self.env,
                             cwd=self.directory, text=True, capture_output=True, timeout=20)
        self.assertEqual(old.returncode, 0, old.stdout + old.stderr)
        before = {'config_loads': self.metrics().count('load'), 'file_checks': self.metrics().count('check')}
        (self.directory / 'metrics').unlink()
        self.env.update(TEST_MODE='silent', TEST_HORIZON='60')
        self.simulate('silent')
        after = {'config_loads': self.metrics().count('load'), 'file_checks': self.metrics().count('scan') * 8}
        self.assertEqual(before, {'config_loads': 30, 'file_checks': 240})
        self.assertEqual(after, {'config_loads': 1, 'file_checks': 16})
        # Work counts, not physical wakeups or battery claims.
        self.assertEqual(after['file_checks'] / before['file_checks'], 1 / 15)

    def start_live(self, emitter='silent'):
        binary = self.directory / 'bin'
        binary.mkdir(exist_ok=True)
        watcher = binary / 'inotifyd'
        watcher.write_text('''#!/usr/bin/env python3
import os, pathlib, signal, sys, time
root = pathlib.Path(os.environ['TEST_DIR'])
(root / 'watcher.pid').write_text(str(os.getpid()))
if os.environ.get('TEST_EMITTER') == 'dead':
    sys.exit(1)
if os.environ.get('TEST_EMITTER') == 'full':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True:
        try:
            sys.stdout.write(('c\\t' + str(root / 'run') + '\\tdense.log\\n') * 4096)
            sys.stdout.flush()
        except BrokenPipeError:
            time.sleep(.01)
with (root / 'events').open() as source:
    while True:
        line = source.readline()
        if line:
            sys.stdout.write(line); sys.stdout.flush()
            (root / 'emitted').touch()
        else:
            time.sleep(.01)
''')
        watcher.chmod(0o755)
        (self.directory / 'events').touch()
        self.env.update(TEST_EMITTER=emitter)
        script = self.prelude() + '''
PATH="$TEST_DIR/bin:$PATH"
echo "$$" >"$TS_PID_DIR/foxytail.logd.pid"
logd_run
'''
        process = subprocess.Popen(['bash', '-c', script], env=self.env, cwd=self.directory,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   start_new_session=True)
        self.addCleanup(self.cleanup_process, process)
        self.wait_for(lambda: (self.directory / 'watcher.pid').exists())
        return process

    def stop_live(self, process):
        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0, stdout + stderr)
        watcher_pid = int((self.directory / 'watcher.pid').read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(watcher_pid, 0)
        self.assertFalse(list(self.run.rglob('.logd-events.*')))
        self.assertFalse((self.run / 'pids/foxytail.logd.pid').exists())

    def test_shutdown_interrupts_idle_read_and_reaps_watcher(self):
        process = self.start_live()
        self.stop_live(process)

    def test_shutdown_reaps_full_pipe_producer_that_ignores_term(self):
        process = self.start_live('full')
        # Give the producer an opportunity to fill the pipe while the parent
        # is coalescing. TERM alone cannot stop this deliberately bad child.
        time.sleep(.1)
        started = time.monotonic()
        self.stop_live(process)
        self.assertLess(time.monotonic() - started, 2)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'requires Linux inotify')
    def test_real_kernel_fifo_output_does_not_feed_watched_directory(self):
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        libc.inotify_init1.argtypes = [ctypes.c_int]
        libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        self.assertGreaterEqual(fd, 0, os.strerror(ctypes.get_errno()))
        self.addCleanup(os.close, fd)
        # IN_MODIFY | IN_CREATE would detect the previous feedback bug: writes
        # to a FIFO immediately inside a watched directory notify that parent.
        self.assertGreaterEqual(libc.inotify_add_watch(fd, os.fsencode(self.run), 0x102), 0)
        process = self.start_live()
        # Startup's configuration lock intentionally creates a symlink in
        # run. Isolate the phase under test: subsequent watcher stdout writes.
        while True:
            try:
                os.read(fd, 65536)
            except BlockingIOError:
                break
        with (self.directory / 'events').open('a') as stream:
            stream.write(f'c\t{self.run}\tfoxydns.health.json\n' * 40)
        self.wait_for(lambda: (self.directory / 'emitted').exists())
        with self.assertRaises(BlockingIOError):
            os.read(fd, 65536)
        self.stop_live(process)

    def test_write_burst_is_coalesced_and_copytruncate_retains_writer(self):
        logfile = self.run / 'daemon with spaces.log'
        with logfile.open('ab', buffering=0) as writer:
            process = self.start_live()
            inode = logfile.stat().st_ino
            writer.write(b'x' * 131072)
            with (self.directory / 'events').open('a') as events:
                events.write(f'c\t{self.run}\t{logfile.name}\n' * 200)
            self.wait_for(lambda: logfile.stat().st_size == 0)
            self.assertEqual(logfile.stat().st_ino, inode)
            writer.write(b'still-open\n')
            self.assertEqual(logfile.read_text(), 'still-open\n')
            self.assertLessEqual(self.metrics().count('scan'), 2)
            self.assertEqual(self.metrics().count('load'), 1)
            self.stop_live(process)


if __name__ == '__main__':
    unittest.main()
