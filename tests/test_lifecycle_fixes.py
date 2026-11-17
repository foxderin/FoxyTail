"""Regression tests for installer/runtime lifecycle findings.

Same extraction discipline as test_lifecycle: the real shell code is sliced
out of the shipped sources and exercised with private files and owned host
processes only.
"""
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
from runtime_fixture import host_process_shell


def run_sh(script, directory, env=None, ok=True):
    result = subprocess.run(['sh', '-c', script], cwd=directory, text=True,
                            capture_output=True, timeout=20,
                            env=None if env is None else {**os.environ, **env})
    if ok:
        assert result.returncode == 0, f'rc={result.returncode}\n{result.stdout}\n{result.stderr}'
    return result


def sysctl_boot():
    return subprocess.run(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'],
                          text=True, capture_output=True).stdout.strip()


def process_stamp(pid):
    """Start-time identity in the same units recovery_source uses."""
    if sys.platform == 'darwin':
        helper = subprocess.run(
            [sys.executable, str(ROOT / 'tests/host_process.py'), 'stamp', str(pid)],
            text=True, capture_output=True)
        return helper.stdout.strip()
    with open(f'/proc/{pid}/stat') as handle:
        fields = handle.read().rsplit(') ', 1)[1].split()
    return fields[19]


def boot_id():
    if sys.platform == 'darwin':
        return sysctl_boot()
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


class InstallerScanTests(unittest.TestCase):
    """installed_pids / quiesce_installed matching and bounded procfs reads."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name).resolve()
        self.proc = self.dir / 'proc'
        self.proc.mkdir()
        source = (ROOT / 'customize.sh').read_text()
        self.function = source[source.index('installed_pids() {'):source.index('quiesce_installed() {')]
        self.function = self.function.replace('/proc/', str(self.proc) + '/')

    def scan(self, entries, scripts=('foxytail.service', 'foxytail.watchdog', 'start.sh')):
        """entries: {pid: (exe_target, cmdline_bytes)}; returns stdout pids."""
        (self.dir / 'bin').mkdir(exist_ok=True)
        scripts_dir = self.dir / 'scripts'
        scripts_dir.mkdir(exist_ok=True)
        for name in scripts:
            (scripts_dir / name).write_text('#!/bin/sh\n')
        for pid, (exe, cmdline) in entries.items():
            (self.proc / pid).mkdir()
            if exe is not None:
                (self.proc / pid / 'exe').symlink_to(exe)
            if cmdline is not None:
                (self.proc / pid / 'cmdline').write_bytes(cmdline)
        return subprocess.run(['sh', '-c', self.function + '''
TS_BIN_DIR="$1/bin"; TS_SCRIPTS_DIR="$1/scripts"; MODPATH="$1/modules_update/foxytail"
installed_pids
''', 'installer-fixture', str(self.dir)], cwd=self.dir, text=True,
                              capture_output=True, timeout=10)

    def pids(self, entries, **kw):
        result = self.scan(entries, **kw)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        return result.stdout.splitlines()

    def argv(self, *elements):
        return b'\0'.join(e.encode() for e in elements) + b'\0'

    def test_exe_and_scripts_path_forms_still_match(self):
        self.assertEqual(self.pids({
            '2001': (self.dir / 'bin/tailscaled', None),
            '2002': ('/system/bin/sh', self.argv('/system/bin/sh', str(self.dir / 'scripts/foxytail.watchdog'), 'start')),
            '2003': ('/system/bin/foreign', self.argv('/system/bin/foreign', '--config=' + str(self.dir / 'scripts/foxytail.watchdog'))),
        }), ['2001', '2002'])

    def test_systemless_and_module_bin_paths_match(self):
        self.assertEqual(self.pids({
            '2101': ('/system/bin/sh', self.argv('/system/bin/foxytail.service', 'status')),
            '2102': ('/system/bin/sh', self.argv('/data/adb/modules/foxytail/system/bin/foxytail.service', 'status')),
            '2103': ('/system/bin/sh', self.argv('/data/adb/modules_update/foxytail/system/bin/foxytail.service', 'status')),
        }), ['2101', '2102', '2103'])

    def test_staged_modpath_bin_path_matches(self):
        staged = self.dir / 'modules_update/foxytail/system/bin/foxytail.service'
        self.assertEqual(self.pids({
            '2110': ('/system/bin/sh', self.argv(str(staged), 'status')),
        }), ['2110'])

    def test_bare_names_match_only_after_an_interpreter(self):
        cases = {
            '2201': self.argv('sh', 'foxytail.service', 'status'),
            '2202': self.argv('/system/bin/mksh', 'foxytail.watchdog'),
            '2203': self.argv('busybox', 'sh', 'start.sh'),
            '2204': self.argv('sh', '-c', 'foxytail.service status'),
            '2205': self.argv('grep', 'foxytail.service'),
            '2206': self.argv('vim', 'foxytail.service'),
            '2207': self.argv('nohup', 'foxytail.service'),
        }
        result = self.pids({pid: ('/system/bin/sh', cmdline) for pid, cmdline in cases.items()})
        self.assertEqual(sorted(result), ['2201', '2202', '2203', '2204'])

    def test_foreign_paths_with_generic_script_names_do_not_match(self):
        # start.sh is too generic to match outside a foxytail path component.
        self.assertEqual(self.pids({
            '2301': ('/system/bin/sh', self.argv('sh', '/data/adb/modules/other/start.sh')),
            '2302': ('/system/bin/sh', self.argv('sh', '/tmp/start.sh')),
        }), [])
        # A foxytail-prefixed name still matches under any directory.
        self.assertEqual(self.pids({
            '2303': ('/system/bin/sh', self.argv('sh', '/data/adb/modules/other/foxytail.service')),
        }), ['2303'])

    def test_cmdline_reads_are_bounded(self):
        # A cmdline longer than one 4K block is truncated, not read to EOF.
        match = self.argv('/system/bin/sh', str(self.dir / 'scripts/foxytail.watchdog'))
        padded = match + (b'x' * 8192) + b'\0'
        self.assertEqual(self.pids({
            '2401': ('/system/bin/sh', padded),
        }), ['2401'])


class InstallLockChoosingTests(unittest.TestCase):
    """install_lock must reap a stale `choosing` ticket only for a dead owner."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name).resolve()
        source = (ROOT / 'install-recovery.sh').read_text()
        host = host_process_shell()
        if host:
            start = source.index('install_stamp() {')
            end = source.index('install_owner_valid() {')
            source = source[:start] + 'install_stamp() { _proc_starttime "$1"; }\n\n' + source[end:]
            source = source.replace('$(cat /proc/sys/kernel/random/boot_id)', '$(boot_identity)')
            source = source.replace(
                'IFS= read -r _il_stat </proc/self/stat || return 1\n  _il_pid=${_il_stat%% *}',
                '_lock_identity || return 1\n  _il_pid=${_LOCK_TOKEN%%:*}')
            source += '\n' + host
        self.functions = source

    def test_dead_choosing_owner_is_reaped(self):
        run_sh(self.functions + '''
TS_DIR="$PWD"
mkdir -p "$TS_DIR/.install-waiters"
ln -s choosing "$TS_DIR/.install-waiters/999999:1:older-boot" || exit 1
install_lock || exit 2
test "$(readlink "$TS_DIR/.install-lock")" = "$_INSTALL_OWNER" || exit 3
test ! -e "$TS_DIR/.install-waiters/999999:1:older-boot" || exit 4
install_unlock
''', self.dir)

    def test_live_choosing_owner_is_honored_then_reaped_after_death(self):
        owner = subprocess.Popen(['sleep', '30'])
        self.addCleanup(owner.kill)
        token = f'{owner.pid}:{process_stamp(owner.pid)}:{boot_id()}'
        run_sh(self.functions + f'''
TS_DIR="$PWD"
mkdir -p "$TS_DIR/.install-waiters"
ln -s choosing "$TS_DIR/.install-waiters/{token}" || exit 1
install_lock && exit 2
test -L "$TS_DIR/.install-waiters/{token}" || exit 3
''', self.dir)
        # The live contested ticket must survive and hold no lock ourselves.
        self.assertEqual(os.readlink(self.dir / '.install-waiters' / token), 'choosing')
        self.assertFalse((self.dir / '.install-lock').exists())
        owner.kill()
        owner.wait()
        run_sh(self.functions + f'''
TS_DIR="$PWD"
install_lock || exit 4
test "$(readlink "$TS_DIR/.install-lock")" = "$_INSTALL_OWNER" || exit 5
test ! -e "$TS_DIR/.install-waiters/{token}" || exit 6
install_unlock
''', self.dir)

    def test_dead_choosing_recheck_during_scan(self):
        # A numeric dead ticket ahead of a dead choosing ticket: both reaped.
        run_sh(self.functions + '''
TS_DIR="$PWD"
mkdir -p "$TS_DIR/.install-waiters"
ln -s 1 "$TS_DIR/.install-waiters/999998:1:older-boot"
ln -s choosing "$TS_DIR/.install-waiters/999999:1:older-boot"
install_lock || exit 1
test ! -e "$TS_DIR/.install-waiters/999998:1:older-boot" || exit 2
test ! -e "$TS_DIR/.install-waiters/999999:1:older-boot" || exit 3
install_unlock
''', self.dir)


class InotifydWatchTests(unittest.TestCase):
    """The module watcher must observe the manager-visible directory."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name).resolve()

    def identity_source(self):
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        return settings[settings.index('resident_identity_alive() {'):settings.index('# The same predicate backs')]

    def test_identity_accepts_managed_and_staging_dirs(self):
        source = self.identity_source() + '''
_proc_starttime() { echo 1; }
boot_identity() { echo b; }
TS_SCRIPTS_DIR=/data/adb/foxytail/scripts
TS_MOD_DIR=/data/adb/modules_update/foxytail
_argv_dir="$1"
_proc_cmdline() {
  printf '%s\n' inotifyd "$TS_SCRIPTS_DIR/foxytail.inotify" "$_argv_dir"
}
resident_identity_alive inotifyd 7 1 b
'''
        for argv_dir, expected in (
            ('/data/adb/modules_update/foxytail', 0),
            ('/data/adb/modules/foxytail', 0),
            ('/data/adb/modules/other', 1),
        ):
            result = subprocess.run(
                ['sh', '-c', source, 'fixture', argv_dir], cwd=self.dir,
                text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, expected, argv_dir + result.stderr)

    def test_enable_ensures_watcher(self):
        scripts = self.dir / 'scripts'
        scripts.mkdir()
        runtime = self.dir / 'run'
        runtime.mkdir()
        (self.dir / 'settings.sh').write_text('''
TS_DIR="$PWD"; TS_SCRIPTS_DIR="$PWD/scripts"; TS_RUN_DIR="$PWD/run"; TS_MOD_DIR="$PWD"
load_conf() { :; }
load_runtime_conf() { :; }
ensure_run_dirs() { :; }
log() { :; }
daemon_stop_pidfile() { :; }
conf_trial_active() { return 1; }
_lock_identity() { _LOCK_TOKEN="test:1:b"; }
_owner_lock_acquire() { return 0; }
_owner_lock_release() { :; }
daemon_pid_alive() { echo "$1" >>"$TS_RUN_DIR/identity-checks"; return 0; }
''')
        (scripts / 'foxytail.inotify').write_text('#!/bin/sh\nexit 0\n')
        (scripts / 'foxytail.inotify').chmod(0o755)
        service = scripts / 'foxytail.service'
        service.write_text('#!/bin/sh\nexit 0\n')
        service.chmod(0o755)
        for name in ['foxytail.stats', 'foxytail.watchdog', 'foxytail.context', 'foxytail.logd']:
            resident = scripts / name
            resident.write_text('#!/bin/sh\nexit 0\n')
            resident.chmod(0o755)
        source = (ROOT / 'tailscale/scripts/start.sh').read_text()
        source = source.replace('"${TS_SCRIPTS_DIR}/foxytail.service"', 'sh "${TS_SCRIPTS_DIR}/foxytail.service"')
        (scripts / 'start.sh').write_text(source)
        result = subprocess.run(['sh', str(scripts / 'start.sh'), 'enable'],
                                cwd=self.dir, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        checks = (runtime / 'identity-checks').read_text().splitlines()
        self.assertIn('inotifyd', checks)


class ServiceArmTests(unittest.TestCase):
    """foxytail.service status ordering, trial resident resume, pid rewrite."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name).resolve()
        self.service = (ROOT / 'tailscale/scripts/foxytail.service').read_text()

    def status_script(self):
        svc = self.service
        status_doc = svc[svc.index('# @cmd status'):svc.index('# @cmd mode')]
        funcs = (svc[svc.index('humanize_bytes() {'):svc.index('status_service() {')] +
                 svc[svc.index('status_service() {'):svc.index('\nlog_service() {')] +
                 svc[svc.index('usage() {'):svc.index('\nhelp() {')])
        # Preserve the real admission/dispatch cases without coupling to their verb list.
        dispatch = svc[svc.index('\ncase "$1" in', svc.index('service_lock() {')):]
        return status_doc + funcs + dispatch

    def run_status(self, args, running, backend='Running', conf_rc=1, addrs='', ipout=''):
        (self.dir / 'status.json').write_text(backend if isinstance(backend, dict) or backend.startswith('{') else '{}')
        status_json = backend if backend.startswith('{') else '{"BackendState":"' + backend + '","Self":{"HostName":"h","OS":"android","TailscaleIPs":["100.64.0.1"],"Addrs":[' + addrs + ']},"Peer":{},"CurrentTailnet":{"MagicDNSEnabled":false}}'
        (self.dir / 'status.json').write_text(status_json)
        (self.dir / 'ip.out').write_text(ipout)
        script = '''
TS_DIR="$PWD"; TS_LOG_FILE="$PWD/ts.log"; TS_RUN_LOG_FILE="$PWD/run.log"
TS_SOCKET="$PWD/sock"; TS_MOD_PROP="$PWD/module.prop"; TS_MODE=
normal= red= green= yellow= blue= orange=
scripts_name=foxytail.service
log() { :; }
ensure_run_dirs() { :; }
is_running() { return ''' + str(running) + '''; }
service_lock() { :; }
conf_trial_active() { return 1; }
load_runtime_conf() { return ''' + str(conf_rc) + '''; }
ts_status_json() { cat "$TS_DIR/status.json"; }
jqr() { jq "$@"; }
ip() { cat "$TS_DIR/ip.out"; }
''' + self.status_script()
        return subprocess.run(['sh', '-c', script, 'svc'] + args.split(), cwd=self.dir,
                              text=True, capture_output=True, timeout=10)

    def test_unknown_status_argument_is_a_usage_error(self):
        result = self.run_status('status bogus', running=0)
        self.assertEqual(result.returncode, 1)
        self.assertIn('usage', result.stdout + result.stderr)

    def test_stopped_reported_even_with_broken_configuration(self):
        result = self.run_status('status', running=1, conf_rc=1)
        self.assertEqual(result.returncode, 1)
        self.assertIn('stopped', result.stdout)

    def test_running_reported_with_broken_configuration(self):
        result = self.run_status('status', running=0, conf_rc=1)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('running', result.stdout)
        self.assertIn('unknown', result.stdout)

    def test_ipv6_endpoint_matches_the_full_address(self):
        addrs = '"[2001:db8:85a3::1]:41641","10.0.0.5:41641"'
        ipout = ('2: eth0    inet6 2001:db8:85a3::1/64 scope global\n'
                 '3: wlan0    inet 10.0.0.5/24 scope global\n')
        result = self.run_status('status', running=0, conf_rc=0, addrs=addrs, ipout=ipout)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        v6 = [line for line in result.stdout.splitlines() if '2001:db8:85a3::1' in line]
        v4 = [line for line in result.stdout.splitlines() if '10.0.0.5' in line]
        self.assertTrue(v6 and 'eth0' in v6[0], result.stdout)
        self.assertTrue(v4 and 'wlan0' in v4[0], result.stdout)

    def test_trial_arm_resumes_residents_on_restart_failure(self):
        arm = self.service[self.service.index('  trial)\n'):self.service.index('  context)\n')]
        (self.dir / 'run').mkdir()
        scripts = self.dir / 'scripts'
        scripts.mkdir()
        (scripts / 'foxytail.trial').write_text(
            '#!/bin/sh\n[ "$1" = prepare ] && echo "$TS_RUN_DIR/cand" && exit 0\nexit 1\n')
        (scripts / 'foxytail.trial').chmod(0o755)
        (scripts / 'start.sh').write_text('''#!/bin/sh
case "$1" in
  pause-residents) echo pause >>"$CALL_LOG"; exit "${PAUSE_RC:-0}" ;;
  resume-residents) echo resume >>"$CALL_LOG" ;;
esac
exit 0
''')
        (scripts / 'start.sh').chmod(0o755)
        for pause_rc, restart_rc, expected_calls in ((1, 0, 1), (0, 1, 1), (0, 0, 0)):
            with self.subTest(pause_rc=pause_rc, restart_rc=restart_rc):
                log = self.dir / f'calls-{pause_rc}-{restart_rc}'
                script = f'''
TS_SCRIPTS_DIR="$PWD/scripts"; TS_RUN_DIR="$PWD/run"; TS_DIR="$PWD"
export CALL_LOG="{log}"
restart_service() {{ return {restart_rc}; }}
case "trial" in
{arm}esac
'''
                result = subprocess.run(['sh', '-c', script], cwd=self.dir, text=True,
                                        capture_output=True, timeout=10,
                                        env={**os.environ, 'PAUSE_RC': str(pause_rc)})
                calls = log.read_text().splitlines() if log.exists() else []
                if expected_calls == 0:
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(calls, ['pause', 'resume'])

    def test_start_rewrite_missing_pidfile_for_live_daemon(self):
        funcs = self.service[self.service.index('\nstart_service() {'):self.service.index('restore_trial_preference() {')]
        pid_dir = self.dir / 'pids'
        pid_dir.mkdir()
        for present in (False, True):
            with self.subTest(present=present):
                pid_file = pid_dir / 'tailscaled.pid'
                if present:
                    pid_file.write_text('111\n')
                elif pid_file.exists():
                    pid_file.unlink()
                script = funcs + '''
TS_DIR="$PWD"; TS_RUN_DIR="$PWD"; PID_FILE="$PWD/pids/tailscaled.pid"
ensure_run_dirs() { :; }
is_running() { return 0; }
daemon_pids() { echo 4242; }
log() { :; }
restore_trial_preference() { return 0; }
load_runtime_conf() { return 0; }
reconcile_companions() { return 0; }
start_service
'''
                result = subprocess.run(['sh', '-c', script], cwd=self.dir, text=True,
                                        capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(pid_file.read_text().strip(), '111' if present else '4242')

    def test_superseded_trial_restores_owned_exit_preference(self):
        funcs = self.service[self.service.index('restore_trial_preference() {'):self.service.index('reconcile_companions() {')]
        trial = self.dir / 'state/config-trial'
        trial.mkdir(parents=True)
        scripts = self.dir / 'scripts'
        scripts.mkdir()
        (scripts / 'foxytail.exitnode').write_text('#!/bin/sh\necho "$1 $2" >>"$PWD/called"\n')
        (scripts / 'foxytail.exitnode').chmod(0o755)
        for status, expected in (('superseded', 1), ('rolled-back', 1), ('rollback-failed', 1),
                                 ('confirmed', 0), ('running', 0)):
            with self.subTest(status=status):
                (trial / 'status').write_text(status + '\n')
                called = self.dir / 'called'
                if called.exists():
                    called.unlink()
                script = funcs + '''
TS_DIR="$PWD"; TS_SCRIPTS_DIR="$PWD/scripts"
restore_trial_preference
'''
                result = subprocess.run(['sh', '-c', script], cwd=self.dir, text=True,
                                        capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                if expected:
                    self.assertEqual(called.read_text().strip(),
                                     f'trial-restore {self.dir}/state/config-trial')
                else:
                    self.assertFalse(called.exists())


class ModDescAndUninstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name).resolve()

    def test_mod_desc_replaces_only_the_first_bracketed_prefix(self):
        svc = (ROOT / 'tailscale/scripts/foxytail.service').read_text()
        funcs = svc[svc.index('update_mod_desc() {'):svc.index('# A stale socket inode')]
        prop = self.dir / 'module.prop'
        prop.write_text('name=FoxyTail\ndescription=[old state] keep [this] tail\nversion=v\n')
        script = funcs + '''
TS_MOD_PROP="$PWD/module.prop"
# Emulate GNU sed -i on hosts whose sed lacks it.
sed() {
  case "$1" in
    -i) shift; _f=$2; command sed "$1" "$_f" >"$_f.$$" && cat "$_f.$$" >"$_f"; rm -f "$_f.$$" ;;
    *) command sed "$@" ;;
  esac
}
update_mod_desc stopped
'''
        run_sh(script, self.dir)
        lines = prop.read_text().splitlines()
        self.assertTrue(lines[1].startswith('description=[ '), lines[1])
        self.assertIn('keep [this] tail', lines[1])

    def test_uninstall_removes_stale_dns_backup_without_state(self):
        source = (ROOT / 'uninstall.sh').read_text()
        block = source[source.index('# Do not signal processes'):source.index('for _name in')]
        backup = self.dir / 'adb/foxytail-dns-preferences.backup'
        backup.parent.mkdir()
        backup.write_text('stale-journal')
        ts = self.dir / 'ts'
        ts.mkdir()
        identity_backup = self.dir / 'adb/foxytail-state.backup'
        for has_state, has_journal, has_saved_identity, expect in (
            (False, False, False, False),  # no identity: orphaned backup removed
            (False, False, True, True),    # saved identity: paired backup retained
            (True, False, False, False),   # identity without journal: stale backup removed
            (True, True, False, True),     # journal pairs with identity: backup refreshed
        ):
            with self.subTest(has_state=has_state, has_journal=has_journal,
                              has_saved_identity=has_saved_identity):
                for path in [backup, identity_backup,
                             ts / 'state/tailscaled.state',
                             ts / 'state/foxydns-preferences.json']:
                    if path.exists():
                        path.unlink()
                if has_state:
                    (ts / 'state').mkdir(exist_ok=True)
                    (ts / 'state/tailscaled.state').write_text('identity')
                if has_journal:
                    (ts / 'state/foxydns-preferences.json').write_text('journal')
                if has_saved_identity:
                    identity_backup.write_text('saved-identity')
                backup.write_text('stale-journal')
                script = f'''
TS_DIR="$PWD/ts"; SCRIPTS_DIR="$TS_DIR/scripts"
STATE_BACKUP="$PWD/adb/foxytail-state.backup"
DNS_PREFERENCES_BACKUP="{backup}"
say() {{ :; }}
{block}
'''
                result = subprocess.run(['sh', '-c', script], cwd=self.dir, text=True,
                                        capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                if expect:
                    self.assertEqual(backup.read_text(),
                                     'journal' if has_journal else 'stale-journal')
                else:
                    self.assertFalse(backup.exists())


if __name__ == '__main__':
    unittest.main()
