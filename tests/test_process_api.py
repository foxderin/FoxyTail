"""Host-only process regressions against the actual shell functions."""
import json
import os
import subprocess
import time
import unittest

from api_fixture import ApiTestCase, ROOT


class ProcessApiTests(ApiTestCase):
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


    def test_cancel_before_registration_is_a_tombstone(self):
        request_id = str(int(time.time())) + '_delayed_123'
        result = self.shell('cmd_cancel ' + request_id + '; _op_init ' + request_id + ' login', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(os.readlink(self.run / 'operations' / request_id / 'phase'), 'cancelled')


    def test_cancellation_never_signals_a_reused_pid(self):
        for child in ('child.99999', 'child.99999.child.99998'):
            result = self.shell('''mkdir -p "$TS_RUN_DIR/operations/1_reused"
printf '99998 123\\n' >"$TS_RUN_DIR/operations/1_reused/''' + child + '''"
_op_starttime() { printf 456; }
kill() { echo "unexpected kill" >&2; return 99; }
cmd_cancel 1_reused''')
            self.assertNotIn('unexpected kill', result.stderr)
            self.assertTrue(json.loads(result.stdout)['cancelled'])


    def test_embedded_newline_cannot_forge_resident_argument_boundaries(self):
        proc = self.base / 'proc' / '101'
        proc.mkdir(parents=True)
        (proc / 'cmdline').write_bytes(b'/system/bin/sh\0-c\n' +
                                      str(self.scripts / 'foxytail.context').encode() + b'\nstart\0')
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        reader = settings[settings.index('_proc_cmdline() {'):settings.index('# Like pids_of')]
        reader = reader.replace('/proc/', str(self.base / 'proc') + '/')
        result = self.shell(reader + '''
_proc_starttime() { echo 123; }
boot_identity() { echo fixture-boot; }
resident_identity_alive foxytail.context 101 123 fixture-boot
''', ok=False)
        self.assertNotEqual(result.returncode, 0)


    def test_resident_records_reject_pid_reuse_wrong_boot_and_path_substrings(self):
        result = self.shell('''
boot_identity() { echo current-boot; }
_proc_starttime() { echo 123; }
_proc_cmdline() { printf '%s\\n' /system/bin/sh "$resident_path" start; }
kill() { echo "$*" >>"$TS_RUN_DIR/signals"; }
resident_path="$TS_SCRIPTS_DIR/foxytail.context"
mkdir -p "$TS_PID_DIR"
record="$TS_PID_DIR/foxytail.context.pid"
for bad in '42' '42 124 current-boot' '42 123 old-boot'; do
  echo "$bad" >"$record"
  daemon_pid_alive foxytail.context && exit 1
  daemon_stop_pidfile foxytail.context || exit 2
  test ! -e "$record" || exit 3
done
echo '42 123 current-boot' >"$record"
for resident_path in /foreign/foxytail.context "$TS_SCRIPTS_DIR/foxytail.context.evil"; do
  daemon_pid_alive foxytail.context && exit 4
done
resident_path="$TS_SCRIPTS_DIR/foxytail.context"
daemon_pid_alive foxytail.context || exit 5
_proc_cmdline() { printf '%s\\n' /system/bin/sh "$resident_path" status; }
daemon_pid_alive foxytail.context && exit 9
test "$_dpa_pid" = 42 || exit 6
_proc_cmdline() { printf '%s\\n' /bin/echo "$resident_path"; }
daemon_pid_alive foxytail.context && exit 7
daemon_stop_pidfile foxytail.context || exit 8
test ! -e "$TS_RUN_DIR/signals"
''')
        self.assertEqual(result.stdout, '')


    def test_concurrent_resident_start_keeps_one_owner_and_stop_releases_it(self):
        resident = self.scripts / 'foxytail.fixture'
        resident.write_text('#!/bin/sh\nDIR=$(dirname "$0")\n. "$DIR/../settings.sh"\n'
                            'running=1\ntrap "running=0" TERM INT\n'
                            'daemon_claim_pidfile foxytail.fixture || { [ "$?" = 2 ] && exit 0; exit 1; }\n'
                            'trap "daemon_release_pidfile foxytail.fixture" 0\n'
                            'echo claimed >>"$TS_RUN_DIR/claims"\n'
                            'while [ "$running" = 1 ]; do isleep 0.1; done\n')
        resident.chmod(0o755)
        children = [subprocess.Popen(['sh', str(resident), 'start'], stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL) for _ in range(3)]
        try:
            record = self.run / 'pids/foxytail.fixture.pid'
            deadline = time.monotonic() + 5
            while not record.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(record.exists())
            while sum(child.poll() is None for child in children) > 1 and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual(sum(child.poll() is None for child in children), 1)
            self.assertEqual((self.run / 'claims').read_text(), 'claimed\n')
            self.shell('daemon_pid_alive foxytail.fixture && daemon_stop_pidfile foxytail.fixture')
            self.assertFalse(record.exists())
            for child in children:
                self.assertEqual(child.wait(timeout=3), 0)
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=3)

    def test_stop_never_signals_live_foreign_process_with_valid_pid_stamp(self):
        foreign = subprocess.Popen(['sleep', '30'])
        try:
            self.shell('''
pid=''' + str(foreign.pid) + '''
printf '%s %s %s\\n' "$pid" "$(_proc_starttime "$pid")" "$(boot_identity)" >"$TS_PID_DIR/foxytail.context.pid"
daemon_stop_pidfile foxytail.context || exit 1
test ! -e "$TS_PID_DIR/foxytail.context.pid"
''')
            self.assertIsNone(foreign.poll())
        finally:
            foreign.terminate()
            foreign.wait(timeout=3)


    def test_owner_lock_rejects_reused_and_previous_boot_records(self):
        self.shell('''
_lock_identity || exit 1
owner=$_LOCK_TOKEN
_conf_owner_alive "$owner" || exit 2
pid=${owner%%:*}
rest=${owner#*:}
stamp=${rest%%:*}
boot=${rest#*:}
_conf_owner_alive "$pid:$stamp:other-boot" && exit 3
_conf_owner_alive "$pid:$((stamp + 1)):$boot" && exit 4
_conf_owner_alive "$pid:-:$boot" && exit 5
_conf_owner_alive "$pid:$stamp" && exit 6
ln -s "$pid:$stamp:other-boot" "$TS_RUN_DIR/test-lock"
_owner_lock_acquire "$TS_RUN_DIR/test-lock" "$owner" 2 0 || exit 7
test "$(readlink "$TS_RUN_DIR/test-lock")" = "$owner" || exit 8
_owner_lock_release "$TS_RUN_DIR/test-lock" "$owner"
''')

    def test_resident_release_does_not_unlink_new_owner_record(self):
        self.shell('''
record="$TS_PID_DIR/foxytail.context.pid"
printf '%s %s %s\\n' "$$" "$(_proc_starttime "$$")" "$(boot_identity)" >"$record"
daemon_release_pidfile foxytail.context || exit 1
test ! -e "$record" || exit 2
echo '999999 123 replacement-boot' >"$record"
daemon_release_pidfile foxytail.context || exit 3
test "$(cat "$record")" = '999999 123 replacement-boot'
''')


if __name__ == '__main__':
    unittest.main()
