"""Exercise the real ticket locks using only private files and owned host processes."""
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest

from runtime_fixture import host_process_shell


ROOT = Path(__file__).resolve().parents[1]


class LockRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='foxytail-lock-test-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.lock = self.directory / '.lock'
        self.waiters = self.directory / '.lock.waiters'
        source = (ROOT / 'tailscale/scripts/foxytail.lock.sh').read_text()
        self.production_functions = source
        self.functions = source + host_process_shell()
        self.preamble = '''
TS_RUN_DIR="$1"
lock="$TS_RUN_DIR/.lock"
ensure_run_dirs() { :; }
log() { printf '%s\n' "$*" >&2; }
'''

    def start(self, script, functions=None):
        process = subprocess.Popen(
            ['sh', '-c', (self.functions if functions is None else functions) +
             self.preamble + script, 'lock-fixture', str(self.directory)],
            cwd=self.directory, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, start_new_session=True)

        def cleanup():
            # Every group was created by this test; no process-name matching.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate(timeout=5)

        self.addCleanup(cleanup)
        return process

    def finish(self, process, expected=0, input=None):
        stdout, stderr = process.communicate(input=input, timeout=15)
        self.assertEqual(process.returncode, expected, stdout + stderr)
        return stdout.strip()

    def wait_for(self, filename):
        target = self.directory / filename
        deadline = time.monotonic() + 5
        while not target.exists():
            self.assertLess(time.monotonic(), deadline, 'missing fixture checkpoint: ' + filename)
            time.sleep(.005)
        return target

    def acquire_once(self):
        return self.start('''
_lock_identity
token=$_LOCK_TOKEN
_owner_lock_acquire "$lock" "$token" 100 .005 || exit 11
test "$(readlink "$lock")" = "$token" || exit 12
_owner_lock_release "$lock" "$token"
''')

    def hold(self, name='owner', legacy=False):
        acquire = ('ln -s "$token" "$lock"' if legacy else
                   '_owner_lock_acquire "$lock" "$token" 100 .005')
        process = self.start('''
_lock_identity
token=$_LOCK_TOKEN
''' + acquire + ''' || exit 11
printf '%s\n' "$token" >"$TS_RUN_DIR/''' + name + '''.ready"
IFS= read -r proceed
_owner_lock_release "$lock" "$token"
''')
        token = self.wait_for(name + '.ready').read_text().strip()
        return process, token

    def assert_released(self):
        self.assertFalse(self.lock.is_symlink())
        self.assertEqual(list(self.waiters.iterdir()), [])


    def test_live_legacy_owner_is_not_stolen_and_timeout_cleans_own_ticket(self):
        owner, token = self.hold(legacy=True)
        waiter = self.start('''
_lock_identity
token=$_LOCK_TOKEN
_owner_lock_acquire "$lock" "$token" 3 .005 && exit 21
test ! -L "$lock.waiters/$token" || exit 22
test ! -L "$lock.waiters/.ticket.$token" || exit 23
''')
        self.finish(waiter)
        self.assertEqual(os.readlink(self.lock), token)
        self.assertEqual(list(self.waiters.iterdir()), [])
        self.finish(owner, input='release\n')
        self.finish(self.acquire_once())
        self.assert_released()


    def test_failed_stale_primary_removal_respects_retry_limit(self):
        dead = self.finish(self.start('_lock_identity; printf "%s\\n" "$_LOCK_TOKEN"'))
        self.lock.symlink_to(dead)
        output = self.finish(self.start('''
attempts=0
rm() {
  if [ "$2" = "$lock" ]; then
    attempts=$((attempts + 1))
    # Bound the fault itself: the current retry bug must not hang the runner.
    [ "$attempts" -gt 3 ] || return 1
  fi
  command rm "$@"
}
_lock_identity
token=$_LOCK_TOKEN
_owner_lock_acquire "$lock" "$token" 2 .005
result=$?
printf '%s %s\n' "$result" "$attempts"
if [ "$result" = 0 ]; then
  _owner_lock_release "$lock" "$token"
else
  test ! -L "$lock.waiters/$token" || exit 22
fi
'''))
        result, attempts = map(int, output.split())
        self.assertNotEqual(result, 0,
                            f'acquired after {attempts} failed/removal attempts despite limit=2')
        self.assertLessEqual(attempts, 2)

    def test_interruption_between_choosing_and_numeric_publication_recovers(self):
        chooser = self.start('''
mv() {
  : >"$TS_RUN_DIR/publish.ready"
  IFS= read -r proceed
  command mv "$@"
}
_lock_identity
printf '%s\n' "$_LOCK_TOKEN" >"$TS_RUN_DIR/token"
_owner_lock_acquire "$lock" "$_LOCK_TOKEN" 100 .005
''')
        self.wait_for('publish.ready')
        token = (self.directory / 'token').read_text().strip()
        self.assertEqual(os.readlink(self.waiters / token), 'choosing')
        self.assertEqual(os.readlink(self.waiters / ('.ticket.' + token)), '1')
        chooser.kill()
        self.finish(chooser, expected=-signal.SIGKILL)
        self.finish(self.acquire_once())
        self.assert_released()

    def test_interrupted_owner_recovers_but_live_owner_and_ticket_are_preserved(self):
        owner, token = self.hold()
        self.finish(self.start('''
_lock_identity
token=$_LOCK_TOKEN
_owner_lock_acquire "$lock" "$token" 3 .005 && exit 21
_owner_lock_release "$lock" "$token"
'''))
        self.assertEqual(os.readlink(self.lock), token)
        self.assertEqual([entry.name for entry in self.waiters.iterdir()], [token])
        owner.kill()
        self.finish(owner, expected=-signal.SIGKILL)
        self.finish(self.acquire_once())
        self.assert_released()

    def test_competing_acquisitions_and_stale_recovery_are_mutually_exclusive(self):
        dead = self.finish(self.start('_lock_identity; printf "%s\\n" "$_LOCK_TOKEN"'))
        self.lock.symlink_to(dead)
        (self.directory / '.lock.reap').symlink_to(dead)
        processes = [self.start('''
_lock_identity
token=$_LOCK_TOKEN
IFS= read -r proceed
for iteration in 1 2 3; do
  _owner_lock_acquire "$lock" "$token" 1000 .005 || exit 11
  mkdir "$TS_RUN_DIR/critical" || exit 31
  printf 'enter:%s\n' "$token" >>"$TS_RUN_DIR/events"
  sleep .005
  printf 'leave:%s\n' "$token" >>"$TS_RUN_DIR/events"
  rmdir "$TS_RUN_DIR/critical" || exit 32
  _owner_lock_release "$lock" "$token"
done
''') for _ in range(6)]
        for process in processes:
            process.stdin.write('start\n')
            process.stdin.flush()
        for process in processes:
            self.finish(process)
        events = (self.directory / 'events').read_text().splitlines()
        self.assertEqual(len(events), 36)
        for enter, leave in zip(events[::2], events[1::2]):
            self.assertTrue(enter.startswith('enter:'))
            self.assertEqual(leave, enter.replace('enter:', 'leave:', 1))
        self.assert_released()


    def test_identity_uses_proc_self_instead_of_inherited_shell_dollar_pid(self):
        proc = self.directory / 'proc'
        for pid in ('self', '4242'):
            (proc / pid).mkdir(parents=True)
            (proc / pid / 'stat').write_text(
                '4242 (worker (subshell)) ' + ' '.join(['S'] + ['0'] * 18 + ['123456', '0']) + '\n')
        functions = self.production_functions.replace('/proc/', str(proc) + '/')
        functions += '\nboot_identity() { echo fixture-boot; }\n'
        output = self.finish(self.start('''
( _lock_identity; printf '%s\n' "$_LOCK_TOKEN" )
''', functions=functions))
        self.assertEqual(output, '4242:123456:fixture-boot')

    def test_pid_reuse_does_not_keep_old_primary_or_ticket_alive(self):
        live = self.start('IFS= read -r proceed')
        pid = str(live.pid)
        proc = self.directory / 'proc' / pid
        proc.mkdir(parents=True)
        (proc / 'stat').write_text(
            pid + ' (reused pid) ' + ' '.join(['S'] + ['0'] * 18 + ['200', '0']) + '\n')
        self.lock.symlink_to(pid + ':100:fixture-boot')
        self.waiters.mkdir()
        (self.waiters / (pid + ':100:fixture-boot')).symlink_to('1')
        for own in ('self', '4242'):
            (self.directory / 'proc' / own).mkdir()
            (self.directory / 'proc' / own / 'stat').write_text(
                '4242 (controller) ' + ' '.join(['S'] + ['0'] * 18 + ['300', '0']) + '\n')
        functions = self.production_functions.replace('/proc/', str(self.directory / 'proc') + '/')
        functions += '\nboot_identity() { echo fixture-boot; }\n'
        self.finish(self.start('''
_lock_identity
_owner_lock_acquire "$lock" "$_LOCK_TOKEN" 100 .005 || exit 11
_owner_lock_release "$lock" "$_LOCK_TOKEN"
''', functions=functions))
        self.assertIsNone(live.poll())
        self.finish(live, input='release\n')
        self.assert_released()


if __name__ == '__main__':
    unittest.main()
