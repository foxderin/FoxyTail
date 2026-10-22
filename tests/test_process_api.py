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
        self.assertEqual(os.readlink(self.run / 'operations' / request_id / 'phase'), 'cancelled')

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

    def test_fast_cli_waits_for_monitor_trap_before_stopping_it(self):
        start = time.monotonic()
        result = self.shell('''command -v shopt >/dev/null && shopt -s expand_aliases
register_trap() { command sleep 0.2; trap "$@"; }
alias trap=register_trap
. "$TS_SCRIPTS_DIR/foxytail.webapi-common.sh"
unalias trap
trap 'exit 99' TERM INT HUP
_op_starttime() { kill -0 "$1" 2>/dev/null && printf 100; }
fast_cli() { printf ready; return 7; }
_op_exec 3 fast_cli''', ok=False)
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

    def test_inotify_identity_requires_exact_handler_and_module_arguments(self):
        self.shell('''
boot_identity() { echo fixture-boot; }
_proc_starttime() { echo 123; }
handler="$TS_SCRIPTS_DIR/foxytail.inotify"
module="$TS_MOD_DIR"
_proc_cmdline() { printf '%s\\n' /system/bin/inotifyd "$handler" "$module"; }
resident_identity_alive inotifyd 42 123 fixture-boot || exit 1
handler="$handler.foreign"
resident_identity_alive inotifyd 42 123 fixture-boot && exit 2
handler="$TS_SCRIPTS_DIR/foxytail.inotify"
module=/foreign/module
resident_identity_alive inotifyd 42 123 fixture-boot && exit 3
module="$TS_MOD_DIR"
_proc_cmdline() { printf '%s\\n' /system/bin/echo inotifyd "$handler" "$module"; }
resident_identity_alive inotifyd 42 123 fixture-boot && exit 4
_proc_cmdline() { printf '%s\\n' /data/adb/magisk/busybox inotifyd "$handler" "$module"; }
resident_identity_alive inotifyd 42 123 fixture-boot
''')

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

    def test_stop_by_pids_terminates_the_bound_process(self):
        victim = subprocess.Popen(['sleep', '30'])
        try:
            self.shell('stop_by_pids fixture ' + str(victim.pid))
            self.assertEqual(victim.wait(timeout=5), -15)
        finally:
            if victim.poll() is None:
                victim.kill()
                victim.wait(timeout=3)

    def test_stop_by_pids_never_signals_a_recycled_identity(self):
        # The recorded start time no longer matches after the first lookup, as
        # happens when a dead target's PID was recycled by a foreign process.
        victim = subprocess.Popen(['sleep', '30'])
        try:
            self.shell('''
log() { :; }
kill() {
  case "$1" in
    -0) command kill "$@" 2>/dev/null ;;
    *) printf '%s\\n' "$*" >>"$TS_RUN_DIR/signals"; command kill "$@" 2>/dev/null ;;
  esac
}
_proc_starttime() {
  reads=$(cat "$TS_RUN_DIR/stamp-reads" 2>/dev/null || echo 0)
  reads=$((reads + 1)); printf '%s' "$reads" >"$TS_RUN_DIR/stamp-reads"
  [ "$reads" -le 1 ] && printf original || printf usurper
}
stop_by_pids foreign ''' + str(victim.pid) + '''
test ! -e "$TS_RUN_DIR/signals"''')
            self.assertIsNone(victim.poll())
        finally:
            victim.terminate()
            victim.wait(timeout=3)

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

    def test_expired_requests_never_restart_and_gc_is_bounded(self):
        result = self.shell("_op_init 1_expired status", ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('expired', result.stdout)
        self.shell("mkdir -p \"$TS_RUN_DIR/operations/1_done\"; touch \"$TS_RUN_DIR/operations/1_done/done\"; _op_gc")
        self.assertFalse((self.run / 'operations/1_done').exists())



if __name__ == '__main__':
    unittest.main()
