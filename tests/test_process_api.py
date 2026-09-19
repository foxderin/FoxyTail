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

    def test_backend_keeps_existing_system_cgroup(self):
        function = self.cgroup_fixture('0::/\n5:freezer:/\n3:cpuset:/foreground\n')
        self.shell(function + '\ndetach_from_app_cgroup')
        self.assertEqual((self.base / 'sys/fs/cgroup/cgroup.procs').read_text(), '')

    def test_cancel_before_registration_is_a_tombstone(self):
        request_id = str(int(time.time())) + '_delayed_123'
        result = self.shell('cmd_cancel ' + request_id + '; _op_init ' + request_id + ' login', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.run / 'operations' / request_id / 'cancelled').exists())

    def test_child_discovery_reads_parent_and_starttime_from_one_proc_record(self):
        proc = self.base / 'proc'
        for pid, parent, stamp, comm in [(101, 42, 123, 'child (name)'), (102, 99, 456, 'unrelated')]:
            (proc / str(pid)).mkdir(parents=True)
            fields = ['S', str(parent)] + ['0'] * 17 + [str(stamp)]
            (proc / str(pid) / 'stat').write_text(f'{pid} ({comm}) ' + ' '.join(fields) + '\n')
        source = (ROOT / 'tailscale/scripts/foxytail.webapi-common.sh').read_text()
        function = source[source.index('_op_children() {'):source.index('# Pause each verified parent')]
        function = function.replace('/proc/', str(proc) + '/')
        self.assertEqual(self.shell(function + '\n_op_children 42').stdout.strip(), '101:123')

    def test_cancellation_never_signals_a_reused_pid(self):
        for child in ('child.99999', 'child.99999.child.99998'):
            result = self.shell('''mkdir -p "$TS_RUN_DIR/operations/1_reused"
printf '99998 123\\n' >"$TS_RUN_DIR/operations/1_reused/''' + child + '''"
_op_starttime() { printf 456; }
kill() { echo "unexpected kill" >&2; return 99; }
cmd_cancel 1_reused''')
            self.assertNotIn('unexpected kill', result.stderr)
            self.assertTrue(json.loads(result.stdout)['cancelled'])

    def test_fast_cli_does_not_wait_for_timeout_monitor(self):
        start = time.monotonic()
        result = self.shell('''_op_starttime() { kill -0 "$1" 2>/dev/null && printf 100; }
_op_exec 3 sh -c 'printf ready; exit 7' ''', ok=False)
        self.assertEqual(result.stdout, 'ready')
        self.assertEqual(result.returncode, 7)
        self.assertLess(time.monotonic() - start, 1.5, 'completed CLI waited for its timeout monitor')

    def test_multicall_cli_is_not_mistaken_for_daemon(self):
        proc = self.base / 'proc'
        for pid, name in [('101', 'tailscaled'), ('102', 'tailscale')]:
            (proc / pid).mkdir(parents=True)
            (proc / pid / 'cmdline').write_bytes((str(self.base / 'bin' / name) + '\0--socket=tailscaled.sock\0').encode())
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        function = settings[settings.index('_proc_cmdline() {'):settings.index('# Echo the subset')]
        function = function.replace('/proc/', str(proc) + '/')
        result = self.shell(function + '\npids_of() { printf \'101 102\'; }\nreadlink() { printf \'%s\' "$TS_BIN_DIR/tailscaled"; }\npids_of_path "$TS_BIN_DIR/tailscaled"')
        self.assertEqual(result.stdout.strip(), '101')

    def test_proc_command_snapshot_finishes_without_waiting_for_eof(self):
        proc = self.base / 'proc' / '101'
        proc.mkdir(parents=True)
        fifo = proc / 'cmdline'
        os.mkfifo(fifo)
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        function = settings[settings.index('_proc_cmdline() {'):settings.index('# Like pids_of')]
        function = function.replace('/proc/', str(self.base / 'proc') + '/')
        # Simulate a proc descriptor that yields an argument prefix but never
        # EOF. Discovery must release its controller instead of holding a lock.
        writer = subprocess.Popen(['sh', '-c', 'exec 3>"$1"; head -c 4096 /dev/zero >&3; sleep 5',
                                   'writer', str(fifo)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            start = time.monotonic()
            result = self.shell(function + '\n_proc_cmdline 101')
            self.assertLess(time.monotonic() - start, 1.5)
            self.assertEqual(result.stdout, '\n' * 4096)
        finally:
            writer.terminate()
            writer.wait(timeout=3)

    def test_process_lookup_skips_foreign_or_vanished_candidates_before_read(self):
        result = self.shell('''pids_of() { printf '101 102'; }
readlink() { return 1; }
_proc_cmdline() { touch "$TS_RUN_DIR/unsafe-read"; }
pids_of_path "$TS_BIN_DIR/tailscaled"''')
        self.assertEqual(result.stdout, '')
        self.assertFalse((self.run / 'unsafe-read').exists())

    def test_process_identity_handles_spaces_and_parentheses(self):
        proc = self.base / 'proc'
        (proc / '101').mkdir(parents=True)
        locks = (ROOT / 'tailscale/scripts/foxytail.lock.sh').read_text()
        function = locks[locks.index('_proc_starttime() {'):locks.index('_conf_pid_stamp() {')]
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



if __name__ == '__main__':
    unittest.main()
