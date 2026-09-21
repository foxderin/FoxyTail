"""Host-safe lifecycle/upgrade fault injection; no Android commands are run."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def run_sh(script, directory):
    result = subprocess.run(['sh', '-c', script], cwd=directory, text=True,
                            capture_output=True, timeout=20)
    if result.returncode:
        raise AssertionError(f'rc={result.returncode}\n{result.stdout}\n{result.stderr}')
    return result.stdout


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def service_functions(self):
        source = (ROOT / 'tailscale/scripts/foxytail.service').read_text()
        return ('load_runtime_conf() { load_conf; }\n' +
                source[source.index('daemon_pids() {'):source.index('# Serialize all controllers')])

    def test_unsupported_native_scope_never_starts_daemon(self):
        script = self.service_functions() + '''
TS_RUN_DIR=.; TS_DIR=.; TS_MODE=tun; ROUTE_SCOPE=selected
ensure_run_dirs() { :; }
load_conf() { :; }
log() { :; }
_SERVICE_RECOVERY=1
is_running() { return 1; }
nohup() { echo unsafe >called; }
start_service && exit 5
test ! -e called
'''
        run_sh(script, self.dir)

    def test_postinstall_starts_all_residents_and_preserves_run(self):
        scripts = self.dir / 'scripts'
        scripts.mkdir()
        runtime = self.dir / 'run'
        runtime.mkdir()
        (runtime / 'route.state').write_text('owned routing state')
        (self.dir / 'settings.sh').write_text('''
TS_DIR="$PWD"; TS_SCRIPTS_DIR="$PWD/scripts"; TS_RUN_DIR="$PWD/run"; TS_MOD_DIR="$PWD"
load_conf() { :; }
load_runtime_conf() { :; }
daemon_pid_alive() { return 1; }
ensure_run_dirs() { :; }
log() { :; }
stop_by_pids() { :; }
''')
        for name in ['foxytail.service', 'foxytail.stats', 'foxytail.watchdog', 'foxytail.context', 'foxytail.logd']:
            path = scripts / name
            path.write_text(f'#!/bin/sh\necho "$1" >"{runtime / name}"\n')
            path.chmod(0o755)
        source = (ROOT / 'tailscale/scripts/start.sh').read_text()
        source = source.replace('nohup "${TS_SCRIPTS_DIR}/${_sr_name}"', 'nohup sh "${TS_SCRIPTS_DIR}/${_sr_name}"')
        source = source.replace('"${TS_SCRIPTS_DIR}/foxytail.service"', 'sh "${TS_SCRIPTS_DIR}/foxytail.service"')
        (scripts / 'start.sh').write_text(source)
        subprocess.run(['sh', str(scripts / 'start.sh'), 'postinstall'], cwd=self.dir, check=True, timeout=10)
        # Background children write bounded, local files. Wait only for their
        # observable completion, never for an arbitrary application sleep.
        import time
        deadline = time.monotonic() + 3
        while not all((runtime / x).exists() for x in ['foxytail.stats', 'foxytail.watchdog', 'foxytail.context', 'foxytail.logd']):
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.01)
        self.assertEqual((runtime / 'route.state').read_text(), 'owned routing state')
        for name in ['foxytail.service', 'foxytail.stats', 'foxytail.watchdog', 'foxytail.context', 'foxytail.logd']:
            self.assertEqual((runtime / name).read_text().strip(), 'start')

    def test_reload_only_clears_the_revision_it_applied(self):
        scripts = self.dir / 'scripts'; scripts.mkdir()
        runtime = self.dir / 'run'; runtime.mkdir()
        (self.dir / 'settings.sh').write_text('''
TS_DIR="$PWD"; TS_SCRIPTS_DIR="$PWD/scripts"; TS_RUN_DIR="$PWD/run"; TS_MOD_DIR="$PWD"
load_conf() { :; }
load_runtime_conf() { :; }
daemon_pid_alive() { return 1; }
ensure_run_dirs() { :; }
log() { :; }
stop_by_pids() { :; }
conf_lock_acquire() { :; }
conf_lock_release() { :; }
conf_trial_active() { return 1; }
_conf_runtime_dir() { _RUNTIME_CONF_DIR="$PWD/run/.applied.test"; }
''')
        snapshot = runtime / '.applied.test'; snapshot.mkdir()
        (snapshot / 'revision').write_text('old-revision\n')
        service = scripts / 'foxytail.service'
        service.write_text('#!/bin/sh\n[ "$WRITE_NEW" != 1 ] || echo new-revision >"$PWD/run/settings.pending"\nexit 0\n')
        service.chmod(0o755)
        source = (ROOT / 'tailscale/scripts/start.sh').read_text()
        source = source.replace('"${TS_SCRIPTS_DIR}/foxytail.service"', 'sh "${TS_SCRIPTS_DIR}/foxytail.service"')
        (scripts / 'start.sh').write_text(source)
        for newer in ('0', '1'):
            (runtime / 'settings.pending').write_text('old-revision\n')
            subprocess.run(['sh', str(scripts / 'start.sh'), 'reload'], cwd=self.dir,
                           env={**os.environ, 'WRITE_NEW': newer}, check=True, timeout=10)
            if newer == '1':
                self.assertEqual((runtime / 'settings.pending').read_text().strip(), 'new-revision')
            else:
                self.assertFalse((runtime / 'settings.pending').exists())
        # Disabled modules cannot claim an unapplied restart succeeded.
        (self.dir / 'disable').touch()
        result = subprocess.run(['sh', str(scripts / 'start.sh'), 'reload'], cwd=self.dir, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((runtime / 'settings.pending').exists())

    def test_upgrade_switch_rolls_back_after_second_directory_failure(self):
        source = (ROOT / 'customize.sh').read_text()
        functions = source[source.index('rollback_install() {'):source.index('# Recover an interrupted earlier switch')]
        for part in ['bin', 'scripts', 'conf']:
            (self.dir / part).mkdir()
            (self.dir / part / 'value').write_text('old-' + part)
            (self.dir / 'candidate' / part).mkdir(parents=True)
            (self.dir / 'candidate' / part / 'value').write_text('new-' + part)
        for part in ['settings.sh', 'VERSIONS', 'checksums.txt', 'native-checksums.txt']:
            (self.dir / part).write_text('old-' + part)
            (self.dir / 'candidate' / part).write_text('new-' + part)
        (self.dir / 'bin/dnsmasq').write_text('user-binary')
        (self.dir / 'files').mkdir()
        (self.dir / 'files/received').write_text('user-file')
        run_sh(functions + '''
TS_DIR="$PWD"; CANDIDATE="$PWD/candidate"; BACKUP="$PWD/backups/unique"
mv() {
  if [ "$1" = "$CANDIDATE/scripts" ]; then return 1; fi
  command mv "$@"
}
switch_install && exit 7
rollback_install
''', self.dir)
        for part in ['bin', 'scripts', 'conf']:
            self.assertEqual((self.dir / part / 'value').read_text(), 'old-' + part)
        self.assertEqual((self.dir / 'bin/dnsmasq').read_text(), 'user-binary')
        self.assertEqual((self.dir / 'files/received').read_text(), 'user-file')
        self.assertEqual((self.dir / 'settings.sh').read_text(), 'old-settings.sh')

    def test_installer_pid_scan_ignores_vendor_proc_entries_with_numeric_prefixes(self):
        source = (ROOT / 'customize.sh').read_text()
        function = source[source.index('installed_pids() {'):source.index('quiesce_installed() {')]
        proc = self.dir / 'proc'
        proc.mkdir()
        function = function.replace('/proc/', str(proc) + '/')
        for name in ('1234', '1235', '1236', '8350_reg', '9999_vendor'):
            (proc / name).mkdir()
        (proc / '1234/exe').symlink_to(self.dir / 'bin/tailscaled')
        (proc / '1235/exe').symlink_to('/system/bin/sh')
        (proc / '1235/cmdline').write_bytes(b'/system/bin/sh\0' +
            str(self.dir / 'scripts/foxytail.watchdog').encode() + b'\0start\0')
        (proc / '1236/exe').symlink_to('/system/bin/foreign')
        (proc / '1236/cmdline').write_bytes(b'/system/bin/foreign\0--config=' +
            str(self.dir / 'scripts/foxytail.watchdog').encode() + b'\0')
        # A vendor entry must be skipped even if an exe link happens to point
        # into our installation; it must never reach the list later signaled.
        (proc / '8350_reg/exe').symlink_to(self.dir / 'bin/tailscaled')
        result = subprocess.run(['sh', '-c', function + '''
TS_BIN_DIR="$1/bin"; TS_SCRIPTS_DIR="$1/scripts"
installed_pids
''', 'installer-fixture', str(self.dir)], cwd=self.dir, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['1234', '1235'])
        self.assertEqual(result.stderr, '')

    def test_installer_pid_scan_with_no_numeric_entries_is_quiet(self):
        source = (ROOT / 'customize.sh').read_text()
        function = source[source.index('installed_pids() {'):source.index('quiesce_installed() {')]
        proc = self.dir / 'proc'
        proc.mkdir()
        function = function.replace('/proc/', str(proc) + '/')
        result = subprocess.run(['sh', '-c', function + '\ninstalled_pids\n'],
                                cwd=self.dir, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(result.stderr, '')

    def test_upgrade_rollback_restores_native_helper_and_manifest_or_their_absence(self):
        source = (ROOT / 'customize.sh').read_text()
        functions = source[source.index('rollback_install() {'):source.index('# Recover an interrupted earlier switch')]
        for had_native in [False, True]:
            with self.subTest(had_native=had_native):
                directory = self.dir / str(had_native)
                directory.mkdir()
                for part in ['bin', 'scripts', 'conf']:
                    (directory / part).mkdir()
                    (directory / part / 'value').write_text('old-' + part)
                    (directory / 'candidate' / part).mkdir(parents=True)
                    (directory / 'candidate' / part / 'value').write_text('new-' + part)
                for part in ['settings.sh', 'VERSIONS', 'checksums.txt']:
                    (directory / part).write_text('old-' + part)
                    (directory / 'candidate' / part).write_text('new-' + part)
                (directory / 'candidate/native-checksums.txt').write_text('new-native-manifest')
                (directory / 'candidate/bin/foxydns').write_text('new-helper')
                if had_native:
                    (directory / 'native-checksums.txt').write_text('old-native-manifest')
                    (directory / 'bin/foxydns').write_text('old-helper')
                run_sh(functions + '''
TS_DIR="$PWD"; CANDIDATE="$PWD/candidate"; BACKUP="$PWD/backups/unique"
switch_install || exit 7
test "$(cat "$TS_DIR/bin/foxydns")" = new-helper || exit 8
test "$(cat "$TS_DIR/native-checksums.txt")" = new-native-manifest || exit 9
# A later permission failure must roll back every part of the switched tree.
rollback_install
''', directory)
                if had_native:
                    self.assertEqual((directory / 'native-checksums.txt').read_text(), 'old-native-manifest')
                    self.assertEqual((directory / 'bin/foxydns').read_text(), 'old-helper')
                else:
                    self.assertFalse((directory / 'native-checksums.txt').exists())
                    self.assertFalse((directory / 'bin/foxydns').exists())
                self.assertEqual((directory / 'conf/value').read_text(), 'old-conf')

    def test_rollback_delete_failure_retains_backup_and_journal(self):
        source = (ROOT / 'customize.sh').read_text()
        functions = source[source.index('rollback_install() {'):source.index('# Recover an interrupted earlier switch')]
        for relative in ['bin', 'backups/old/bin']:
            (self.dir / relative).mkdir(parents=True)
        (self.dir / 'bin/version').write_text('new')
        (self.dir / 'backups/old/bin/version').write_text('old')
        (self.dir / '.installing').write_text('')
        (self.dir / '.install-transaction').write_text('journal')
        run_sh(functions + '''
TS_DIR="$PWD"; BACKUP="$PWD/backups/old"
rm() { if [ "$*" = "-rf $TS_DIR/bin" ]; then return 1; fi; command rm "$@"; }
rollback_install && exit 8
test -f "$TS_DIR/.install-transaction"
test -f "$TS_DIR/.installing"
''', self.dir)
        self.assertEqual((self.dir / 'bin/version').read_text(), 'new')
        self.assertEqual((self.dir / 'backups/old/bin/version').read_text(), 'old')
        self.assertFalse((self.dir / 'bin/bin').exists())

    def test_copytruncate_keeps_existing_writer_on_active_inode(self):
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        function = settings[settings.index('rotate_log()'):settings.index('# Log with a per-call')]
        function += (ROOT / 'tailscale/scripts/foxytail.lock.sh').read_text()
        run_sh(function + '''
LOG_MAX_KB=1
TS_RUN_DIR="$PWD"
logfile="$PWD/daemon.log"
exec 3>>"$logfile"
head -c 2048 /dev/zero >&3
before=$(ls -i "$logfile" | awk '{print $1}')
rotate_log "$logfile"
echo after-rotation >&3
exec 3>&-
after=$(ls -i "$logfile" | awk '{print $1}')
test "$before" = "$after"
test "$(cat "$logfile")" = after-rotation
test -f "$logfile.bak"
test "$(wc -c <"$logfile.bak")" -le 1024
''', self.dir)

    def test_installer_exposes_commands_without_sourced_libraries(self):
        source = (ROOT / 'customize.sh').read_text()
        links = source[source.index('# --- Symlinks'):source.index('# Only now')]
        scripts = self.dir / 'scripts'
        scripts.mkdir()
        commands = ('foxytail.webapi.sh', 'foxytail.service', 'foxytail.tun.up')
        libraries = ('foxytail.config.sh', 'foxytail.lock.sh', 'foxytail.webapi-common.sh',
                     'foxytail.webapi-account.sh', 'foxytail.webapi-network.sh', 'foxytail.webapi-config.sh',
                     'foxytail.webapi-backup.sh', 'foxytail.webapi-tools.sh')
        for name in commands + libraries:
            (scripts / name).touch()
        run_sh('MODPATH="$PWD/module"; TS_BIN_DIR="$PWD/bin"; TS_SCRIPTS_DIR="$PWD/scripts"\n' + links, self.dir)
        self.assertEqual(sorted(path.name for path in (self.dir / 'module/system/bin').iterdir()),
                         sorted(('tailscale', 'tailscaled') + commands))


if __name__ == '__main__':
    unittest.main()
