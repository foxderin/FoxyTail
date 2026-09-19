"""Exercise the real ticket locks using only private files and owned host processes."""
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]


class LockRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='foxytail-lock-test-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.lock = self.directory / '.lock'
        self.waiters = self.directory / '.lock.waiters'
        source = (ROOT / 'tailscale/scripts/foxytail.lock.sh').read_text()
        self.functions = source
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

    def test_dead_legacy_primary_and_orphan_reaper_do_not_block_recovery(self):
        dead = self.finish(self.start('_lock_identity; printf "%s\\n" "$_LOCK_TOKEN"'))
        self.lock.symlink_to(dead)
        reaper = self.directory / '.lock.reap'
        reaper.symlink_to(dead)
        self.finish(self.acquire_once())
        self.assert_released()
        # An old reaper is inert; do not require a new shared cleanup protocol.
        self.assertEqual(os.readlink(reaper), dead)

    def test_dead_choosing_numeric_and_temporary_tickets_are_reaped(self):
        self.waiters.mkdir()
        for ticket in ('choosing', '7'):
            dead = self.finish(self.start('_lock_identity; printf "%s\\n" "$_LOCK_TOKEN"'))
            (self.waiters / dead).symlink_to(ticket)
            (self.waiters / ('.ticket.' + dead)).symlink_to('8')
        self.finish(self.acquire_once())
        self.assert_released()

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

    def test_live_choosing_owner_is_respected_until_it_dies(self):
        chooser = self.start('''
_lock_identity
token=$_LOCK_TOKEN
mkdir -p "$lock.waiters"
ln -s choosing "$lock.waiters/$token" || exit 11
printf '%s\n' "$token" >"$TS_RUN_DIR/choosing.ready"
IFS= read -r proceed
''')
        token = self.wait_for('choosing.ready').read_text().strip()
        self.finish(self.start('''
_lock_identity
_owner_lock_acquire "$lock" "$_LOCK_TOKEN" 3 .005 && exit 21
test ! -L "$lock.waiters/$_LOCK_TOKEN"
'''))
        self.assertEqual(os.readlink(self.waiters / token), 'choosing')
        self.assertFalse(self.lock.is_symlink())
        chooser.kill()
        self.finish(chooser, expected=-signal.SIGKILL)
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

    def test_orphaned_reaper_cannot_bypass_a_live_owners_ticket(self):
        dead = self.finish(self.start('_lock_identity; printf "%s\\n" "$_LOCK_TOKEN"'))
        self.lock.symlink_to(dead)
        reaper = self.start('''
rm() {
  if [ "$2" = "$lock" ]; then
    # Model a dispatched external unlink surviving the shell that owns its ticket.
    command sh -c '
      : >"$2/unlink.ready"
      IFS= read -r proceed
      command rm -f "$1"
    ' orphan-unlink "$lock" "$TS_RUN_DIR"
  else
    command rm "$@"
  fi
}
_lock_identity
_owner_lock_acquire "$lock" "$_LOCK_TOKEN" 100 .005
''')
        self.wait_for('unlink.ready')
        reaper.kill()
        reaper.wait(timeout=5)
        owner, token = self.hold()
        self.finish(reaper, expected=-signal.SIGKILL, input='unlink\n')
        # The late unlink may erase the primary. The surviving live ticket must
        # still exclude every contender using the new protocol.
        self.assertTrue((self.waiters / token).is_symlink())
        self.finish(self.start('''
_lock_identity
_owner_lock_acquire "$lock" "$_LOCK_TOKEN" 3 .005 && exit 21
test ! -L "$lock.waiters/$_LOCK_TOKEN"
'''))
        self.assertIsNone(owner.poll())
        self.finish(owner, input='release\n')
        self.finish(self.acquire_once())
        self.assert_released()

    def test_identity_uses_proc_self_instead_of_inherited_shell_dollar_pid(self):
        proc = self.directory / 'proc'
        for pid in ('self', '4242'):
            (proc / pid).mkdir(parents=True)
            (proc / pid / 'stat').write_text(
                '4242 (worker (subshell)) ' + ' '.join(['S'] + ['0'] * 18 + ['123456', '0']) + '\n')
        functions = self.functions.replace('/proc/', str(proc) + '/')
        output = self.finish(self.start('''
( _lock_identity; printf '%s\n' "$_LOCK_TOKEN" )
''', functions=functions))
        self.assertEqual(output, '4242:123456')

    def test_pid_reuse_does_not_keep_old_primary_or_ticket_alive(self):
        live = self.start('printf "%s\\n" "$$" >"$TS_RUN_DIR/live.ready"; IFS= read -r proceed')
        pid = self.wait_for('live.ready').read_text().strip()
        proc = self.directory / 'proc' / pid
        proc.mkdir(parents=True)
        (proc / 'stat').write_text(
            pid + ' (reused pid) ' + ' '.join(['S'] + ['0'] * 18 + ['200', '0']) + '\n')
        self.lock.symlink_to(pid + ':100')
        self.waiters.mkdir()
        (self.waiters / (pid + ':100')).symlink_to('1')
        functions = self.functions.replace('/proc/', str(self.directory / 'proc') + '/')
        self.finish(self.start('''
_lock_identity
_owner_lock_acquire "$lock" "$_LOCK_TOKEN" 100 .005 || exit 11
_owner_lock_release "$lock" "$_LOCK_TOKEN"
''', functions=functions))
        self.assertIsNone(live.poll())
        self.finish(live, input='release\n')
        self.assert_released()

    def test_controllers_release_their_own_lock_domains(self):
        service = (ROOT / 'tailscale/scripts/foxytail.service').read_text()
        service = service[service.index('service_unlock() {'):service.index('\ncase "$1" in', service.index('service_unlock() {'))]
        dns = (ROOT / 'tailscale/scripts/foxytail.dns-modern.sh').read_text()
        dns = dns[dns.index('modern_lock() {'):dns.index('modern_reason() {')]
        self.finish(self.start('''
service_lock || exit 11
modern_lock || exit 12
conf_lock_acquire || exit 13
test "$(readlink "$TS_RUN_DIR/.service-lock")" = "$_SERVICE_LOCK_TOKEN" || exit 14
test "$(readlink "$TS_RUN_DIR/.dns-lock")" = "$_md_token" || exit 15
test "$(readlink "$TS_RUN_DIR/.conf-write-lock")" = "$_CONF_LOCK_TOKEN" || exit 16
conf_lock_release
modern_unlock
test -L "$TS_RUN_DIR/.service-lock" || exit 17
''', functions=self.functions + service + dns))
        for name in ('.service-lock', '.dns-lock', '.conf-write-lock'):
            self.assertFalse((self.directory / name).is_symlink())
            self.assertEqual(list((self.directory / (name + '.waiters')).iterdir()), [])
        route = (ROOT / 'tailscale/scripts/foxytail.route').read_text()
        route = route[route.index('route_lock() {'):route.index('\niface_exists()')]
        self.finish(self.start('''route_lock || exit 1
test "$(readlink "$TS_RUN_DIR/.conf-write-lock")" = "$_CONF_LOCK_TOKEN" || exit 2
''', functions=self.functions + route))
        self.assertFalse((self.directory / '.conf-write-lock').is_symlink())


if __name__ == '__main__':
    unittest.main()
