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


class ServiceArmTests(unittest.TestCase):
    """foxytail.service status ordering, trial resident resume, pid rewrite."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name).resolve()
        self.service = (ROOT / 'tailscale/scripts/foxytail.service').read_text()


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


class ModDescTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name).resolve()

    def test_mod_desc_replaces_only_the_first_bracketed_prefix(self):
        svc = (ROOT / 'tailscale/scripts/foxytail.service').read_text()
        funcs = svc[svc.index('update_mod_desc() {'):svc.index('# A stale socket inode')]
        prop = self.dir / 'module.prop'
        ksud = self.dir / 'ksud'
        # Relocate only the fixed manager binary; never invoke a real manager.
        funcs = funcs.replace('/data/adb/ksud', str(ksud))
        for mode in ('absent', 'supported', 'unsupported'):
            with self.subTest(manager=mode):
                prop.write_text('name=FoxyTail\ndescription=[old state] keep [this] tail\nversion=v\n')
                if mode != 'absent':
                    ksud.write_text('#!/bin/sh\nprintf "%s\\n" "$KSU_MODULE" "$@" >"$PWD/ksud.args"\nexit ' +
                                    ('0' if mode == 'supported' else '1') + '\n')
                    ksud.chmod(0o755)
                script = funcs + '''
TS_MOD_PROP="$PWD/module.prop"
# Check the bounded invocation contract without requiring GNU timeout on macOS.
timeout() {
  [ "$1:$2:$3" = '-k:1:2' ] || return 99
  shift 3
  "$@"
}
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
                self.assertEqual([lines[0], lines[2]], ['name=FoxyTail', 'version=v'])
                if mode != 'absent':
                    self.assertEqual((self.dir / 'ksud.args').read_text().splitlines(),
                                     ['foxytail', 'module', 'config', 'set', '--temp',
                                      'override.description', lines[1].removeprefix('description=')])

if __name__ == '__main__':
    unittest.main()
