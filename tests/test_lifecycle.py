"""Host-safe lifecycle/upgrade fault injection; no Android commands are run."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from runtime_fixture import host_process_shell

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
        self.dir = Path(self.tmp.name).resolve()

    def recovery_source(self):
        source = (ROOT / 'install-recovery.sh').read_text()
        host = host_process_shell()
        if not host:
            return source
        # Only replace platform process reads, retaining the real lock protocol.
        start = source.index('install_stamp() {')
        end = source.index('install_owner_valid() {')
        source = source[:start] + 'install_stamp() { _proc_starttime "$1"; }\n\n' + source[end:]
        source = source.replace('$(cat /proc/sys/kernel/random/boot_id)', '$(boot_identity)')
        source = source.replace('IFS= read -r _il_stat </proc/self/stat || return 1\n  _il_pid=${_il_stat%% *}',
                                '_lock_identity || return 1\n  _il_pid=${_LOCK_TOKEN%%:*}')
        return source + '\n' + host

    def installer_functions(self):
        source = (ROOT / 'customize.sh').read_text()
        entry = source[source.index('install_recovery_entry() {'):source.index('# shellcheck source=install-recovery.sh')]
        return (self.recovery_source() + '\n' + entry + '\n' +
                source[source.index('install_abort() {'):source.index('# Recover an interrupted earlier switch')])

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
daemon_stop_pidfile() { :; }
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
daemon_stop_pidfile() { :; }
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

    def installer_success_fixture(self, directory, entry_kind='absent', fail_remove=False):
        runtime = directory / 'runtime'
        candidate = directory / 'candidate'
        dev = directory / 'dev'
        dev.mkdir(parents=True)
        for tree, version in ((runtime, 'old'), (candidate, 'new')):
            for part in ('bin', 'scripts', 'conf'):
                (tree / part).mkdir(parents=True)
                (tree / part / 'version').write_text(version)
            for part in ('settings.sh', 'VERSIONS', 'checksums.txt', 'native-checksums.txt'):
                (tree / part).write_text(version)
            if entry_kind != 'owned-dangling':
                for relative in ('bin/tailscaled', 'scripts/foxytail.service'):
                    executable = tree / relative
                    executable.write_text('#!/bin/sh\nexit 0\n')
                    executable.chmod(0o755)
            (tree / 'bin/tailscale').symlink_to('tailscaled')
        starter = candidate / 'scripts/start.sh'
        starter.write_text('''#!/bin/sh
[ ! -e "$PWD/runtime/.installing" ] && [ ! -e "$PWD/runtime/.install-transaction" ] || exit 1
for entry in "$PWD/dev/"*; do
  [ ! -L "$entry" ] || printf '%s\\n' "${entry##*/}" >>"$PWD/links-at-start"
done
printf '%s\\n' "$1" >"$PWD/postinstall"
''')
        starter.chmod(0o755)
        (directory / 'module').mkdir()
        for name in ('tailscale', 'tailscaled', 'foxytail.service'):
            entry = dev / name
            expected = runtime / ('scripts/foxytail.service' if name == 'foxytail.service' else 'bin/tailscaled')
            if entry_kind.startswith('owned-'):
                entry.symlink_to(expected)
            elif entry_kind.startswith('external-'):
                target = directory / ('external-' + name)
                if entry_kind == 'external-live':
                    target.write_text('external')
                entry.symlink_to(target)
            elif entry_kind == 'wrong-runtime':
                entry.symlink_to(runtime / 'bin/version')
            elif entry_kind == 'file':
                entry.write_text('unrelated')
            elif entry_kind == 'directory':
                entry.mkdir()
                (entry / 'keep').write_text('unrelated')
        source = (ROOT / 'customize.sh').read_text()
        functions = self.installer_functions()
        success = source[source.index('ui_print "- Switching software; backup:'):]
        # Relocate all filesystem probes as well as the legacy entries.
        success = success.replace('/data/adb/', str(directory / 'adb') + '/')
        success = success.replace('/dev/', str(dev) + '/')
        success = success.replace('/proc/', str(directory / 'proc') + '/')
        prelude = '''
TS_DIR="$PWD/runtime"; TS_BIN_DIR="$TS_DIR/bin"; TS_SCRIPTS_DIR="$TS_DIR/scripts"
TS_CONF_DIR="$TS_DIR/conf"; MODPATH="$PWD/module"
CANDIDATE="$PWD/candidate"; BACKUP="$TS_DIR/backups/test"
ui_print() { printf '%s\\n' "$*"; }
abort() { exit 1; }
set_perm() { :; }
set_perm_recursive() { :; }
iptables() { return 1; }
rm() {
  for arg do
    if [ "$FAIL_REMOVE" = 1 ] && [ "$arg" = "$PWD/dev/tailscale" ]; then
      [ "$_INSTALL_SWITCH_ACTIVE" = 0 ] && printf 'committed\\n' >"$PWD/remove-failed"
      return 1
    fi
  done
  command rm "$@"
}
'''
        result = subprocess.run(['sh', '-c', prelude + functions + '\nbegin_install || exit 1\n' + success + '\nwait\n'],
                                cwd=directory, env={**os.environ, 'FAIL_REMOVE': str(int(fail_remove))},
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((directory / 'postinstall').read_text().strip(), 'postinstall')
        for part in ('bin', 'scripts', 'conf'):
            self.assertEqual((runtime / part / 'version').read_text(), 'new')
            self.assertEqual((runtime / 'backups/test' / part / 'version').read_text(), 'old')
        self.assertFalse((runtime / '.installing').exists())
        self.assertFalse((runtime / '.install-transaction').exists())
        for name in ('tailscale', 'tailscaled', 'foxytail.service'):
            expected = runtime / ('scripts/foxytail.service' if name == 'foxytail.service' else 'bin/tailscaled')
            public = directory / 'module/system/bin' / name
            if name == 'foxytail.service' and entry_kind == 'owned-dangling':
                self.assertFalse(os.path.lexists(public))
            else:
                self.assertEqual(os.readlink(public), str(expected))
        return result.stdout

    def test_installer_success_removes_only_exact_owned_dev_links(self):
        for kind in ('absent', 'owned-live', 'owned-dangling', 'external-live', 'external-dangling',
                     'wrong-runtime', 'file', 'directory'):
            with self.subTest(kind=kind):
                directory = self.dir / kind
                self.installer_success_fixture(directory, kind)
                for name in ('tailscale', 'tailscaled', 'foxytail.service'):
                    entry = directory / 'dev' / name
                    if kind == 'absent' or kind.startswith('owned-'):
                        self.assertFalse(os.path.lexists(entry))
                    elif kind.startswith('external-'):
                        self.assertEqual(os.readlink(entry), str(directory / ('external-' + name)))
                        self.assertEqual(entry.exists(), kind == 'external-live')
                    elif kind == 'wrong-runtime':
                        self.assertEqual(os.readlink(entry), str(directory / 'runtime/bin/version'))
                    elif kind == 'file':
                        self.assertEqual(entry.read_text(), 'unrelated')
                    else:
                        self.assertEqual((entry / 'keep').read_text(), 'unrelated')
                if kind == 'absent' or kind.startswith('owned-'):
                    self.assertFalse((directory / 'links-at-start').exists())

    def test_installer_dev_cleanup_failure_warns_without_rollback_or_skipping_postinstall(self):
        output = self.installer_success_fixture(self.dir, 'owned-live', fail_remove=True)
        self.assertEqual((self.dir / 'remove-failed').read_text().strip(), 'committed')
        link = self.dir / 'dev/tailscale'
        self.assertEqual(os.readlink(link), str(self.dir / 'runtime/bin/tailscaled'))
        self.assertEqual((self.dir / 'links-at-start').read_text().splitlines(), ['tailscale'])
        self.assertIn(str(link), output)
        for name in ('tailscaled', 'foxytail.service'):
            self.assertFalse(os.path.lexists(self.dir / 'dev' / name))

    def test_upgrade_switch_rolls_back_after_second_directory_failure(self):
        source = (ROOT / 'customize.sh').read_text()
        functions = self.installer_functions()
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
begin_install || exit 6
switch_install && exit 7
rollback_install
_INSTALL_SWITCH_ACTIVE=0
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
        functions = self.installer_functions()
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
                (directory / 'candidate/bin/foxyfiles').write_text('new-files-helper')
                if had_native:
                    (directory / 'native-checksums.txt').write_text('old-native-manifest')
                    (directory / 'bin/foxydns').write_text('old-helper')
                    (directory / 'bin/foxyfiles').write_text('old-files-helper')
                run_sh(functions + '''
TS_DIR="$PWD"; CANDIDATE="$PWD/candidate"; BACKUP="$PWD/backups/unique"
begin_install || exit 6
switch_install || exit 7
test "$(cat "$TS_DIR/bin/foxydns")" = new-helper || exit 8
test "$(cat "$TS_DIR/bin/foxyfiles")" = new-files-helper || exit 10
test "$(cat "$TS_DIR/native-checksums.txt")" = new-native-manifest || exit 9
# A later permission failure must roll back every part of the switched tree.
rollback_install
_INSTALL_SWITCH_ACTIVE=0
''', directory)
                if had_native:
                    self.assertEqual((directory / 'native-checksums.txt').read_text(), 'old-native-manifest')
                    self.assertEqual((directory / 'bin/foxydns').read_text(), 'old-helper')
                    self.assertEqual((directory / 'bin/foxyfiles').read_text(), 'old-files-helper')
                else:
                    self.assertFalse((directory / 'native-checksums.txt').exists())
                    self.assertFalse((directory / 'bin/foxydns').exists())
                    self.assertFalse((directory / 'bin/foxyfiles').exists())
                self.assertEqual((directory / 'conf/value').read_text(), 'old-conf')

    def test_rollback_delete_failure_retains_backup_and_journal(self):
        source = (ROOT / 'customize.sh').read_text()
        functions = self.installer_functions()
        for relative in ['bin', 'backups/old/bin']:
            (self.dir / relative).mkdir(parents=True)
        (self.dir / 'bin/version').write_text('new')
        (self.dir / 'backups/old/bin/version').write_text('old')
        owner = '999999:1:previous-boot\n'
        (self.dir / '.installing').write_text(owner)
        (self.dir / 'backups/old/.install-owner').write_text(owner)
        (self.dir / '.install-transaction').write_text(str(self.dir / 'backups/old') + '\n')
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

    def installer_transaction_fixture(self, directory):
        for part in ['bin', 'scripts', 'conf']:
            (directory / part).mkdir(parents=True)
            (directory / part / 'value').write_text('old-' + part)
            (directory / 'candidate' / part).mkdir(parents=True)
            (directory / 'candidate' / part / 'value').write_text('new-' + part)
        for part in ['settings.sh', 'VERSIONS', 'checksums.txt', 'native-checksums.txt']:
            (directory / part).write_text('old-' + part)
            (directory / 'candidate' / part).write_text('new-' + part)
        for relative in ['state/tailscaled.state', 'files/received', 'backups/retained/bin/user']:
            path = directory / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('preserved-' + relative)
        source = (ROOT / 'customize.sh').read_text()
        functions = self.installer_functions()
        recovery = source[source.index('# Recover an interrupted earlier switch'):source.index('mkdir -p "${CANDIDATE}/bin"')]
        prelude = '''
TS_DIR="$PWD"; CANDIDATE="$PWD/candidate"; BACKUP="$PWD/backups/42-interrupted"
ui_print() { :; }
abort() { echo "$*" >&2; exit 1; }
'''
        return prelude + functions, recovery

    def assert_installed_tree_preserved(self, directory):
        for part in ['bin', 'scripts', 'conf']:
            self.assertEqual((directory / part / 'value').read_text(), 'old-' + part)
        for part in ['settings.sh', 'VERSIONS', 'checksums.txt', 'native-checksums.txt']:
            self.assertEqual((directory / part).read_text(), 'old-' + part)
        for relative in ['state/tailscaled.state', 'files/received', 'backups/retained/bin/user']:
            self.assertEqual((directory / relative).read_text(), 'preserved-' + relative)
        self.assertFalse((directory / '.installing').exists())
        self.assertFalse((directory / '.install-transaction').exists())

    def boot_fixture(self, directory):
        module = directory / 'module'
        module.mkdir(exist_ok=True)
        (module / 'install-recovery.sh').write_text(self.recovery_source())
        source = (ROOT / 'service.sh').read_text().replace('/data/adb/foxytail', str(directory))
        (module / 'service.sh').write_text(source)
        (directory / 'settings.sh').write_text('# old-settings.sh\nnetwork_snapshot() { return 0; }\n')
        (directory / 'candidate/settings.sh').write_text('echo partial-settings >&2; exit 66\n')
        starter = directory / 'scripts/start.sh'
        starter.write_text('''#!/bin/sh
for part in bin scripts conf; do
  [ "$(cat "$PWD/$part/value")" = "old-$part" ] || exit 71
done
[ ! -e "$PWD/.installing" ] && [ ! -e "$PWD/.install-transaction" ] || exit 72
echo started >"$PWD/boot-started"
''')
        starter.chmod(0o755)
        (directory / 'candidate/scripts/start.sh').write_text('#!/bin/sh\nexit 73\n')
        return module

    def boot(self, directory, injection=''):
        return subprocess.run(['sh', '-c', 'getprop() { echo 1; }\n' + injection +
                               '\n. "$PWD/module/service.sh"', str(directory / 'module/service.sh')],
                              cwd=directory, text=True, capture_output=True, timeout=10)

    def test_killed_switch_recovers_through_root_boot_at_every_boundary(self):
        parts = ('bin', 'scripts', 'conf', 'settings.sh', 'VERSIONS', 'checksums.txt', 'native-checksums.txt')
        boundaries = ['journal-before', 'journal-after'] + [
            f'{which}-{part}-{when}' for part in parts for which in ('old', 'new') for when in ('before', 'after')]
        for boundary in boundaries:
            with self.subTest(boundary=boundary):
                directory = self.dir / boundary
                functions, _ = self.installer_transaction_fixture(directory)
                self.boot_fixture(directory)
                result = subprocess.run(['sh', '-c', functions + '''
mv() {
  boundary=
  if [ "$2" = "$TS_DIR/.install-transaction" ]; then boundary=journal; fi
  for part in bin scripts conf settings.sh VERSIONS checksums.txt native-checksums.txt; do
    [ "$1" != "$TS_DIR/$part" ] || boundary=old-$part
    [ "$1" != "$CANDIDATE/$part" ] || boundary=new-$part
  done
  [ "$FAULT" != "$boundary-before" ] || kill -KILL "$$"
  command mv "$@" || return 1
  [ "$FAULT" != "$boundary-after" ] || kill -KILL "$$"
}
begin_install || exit 2
switch_install || exit 3
exit 4
'''], cwd=directory, env={**os.environ, 'FAULT': boundary}, text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, -9, result.stdout + result.stderr)
                result = self.boot(directory)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual((directory / 'boot-started').read_text().strip(), 'started')
                self.assertEqual((directory / 'settings.sh').read_text(), '# old-settings.sh\nnetwork_snapshot() { return 0; }\n')
                for part in ('bin', 'scripts', 'conf'):
                    self.assertEqual((directory / part / 'value').read_text(), 'old-' + part)
                self.assertFalse((directory / '.install-transaction').exists())

    def test_recovery_itself_can_be_killed_and_retried(self):
        for part in ('bin', 'scripts', 'conf', 'settings.sh'):
            for when in ('before', 'after'):
                with self.subTest(part=part, when=when):
                    directory = self.dir / (part + when)
                    functions, _ = self.installer_transaction_fixture(directory)
                    self.boot_fixture(directory)
                    result = subprocess.run(['sh', '-c', functions + '\nbegin_install; switch_install; kill -KILL "$$"'],
                                            cwd=directory, text=True, capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, -9, result.stderr)
                    injection = f'''
mv() {{
  if [ "$1" = "$PWD/backups/42-interrupted/{part}" ]; then
    [ "{when}" != before ] || kill -KILL "$$"
    command mv "$@" || return 1
    kill -KILL "$$"
  fi
  command mv "$@"
}}
'''
                    result = self.boot(directory, injection)
                    self.assertEqual(result.returncode, -9, result.stderr)
                    self.assertFalse((directory / 'boot-started').exists())
                    self.assertTrue((directory / '.install-transaction').exists())
                    result = self.boot(directory)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertTrue((directory / 'boot-started').exists())

    def test_interrupted_journal_publication_cleans_gate_and_private_temporary(self):
        for boundary in ['before', 'after']:
            with self.subTest(boundary=boundary):
                directory = self.dir / boundary
                functions, _ = self.installer_transaction_fixture(directory)
                result = subprocess.run(['sh', '-c', functions + '''
mv() {
  if [ "$2" = "$TS_DIR/.install-transaction" ]; then
    [ "$FAULT" != before ] || kill -TERM "$$"
    command mv "$@" || return 1
    kill -TERM "$$"
  fi
  command mv "$@"
}
begin_install || install_abort journal
'''], cwd=directory, env={**os.environ, 'FAULT': boundary}, text=True, capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assert_installed_tree_preserved(directory)
                self.assertEqual(list(directory.glob('.install-transaction-*')), [])
                self.assertTrue((directory / 'backups/42-interrupted').is_dir())

    def test_unproven_journal_preserves_evidence_and_unrelated_backups(self):
        functions, recovery = self.installer_transaction_fixture(self.dir)
        (self.dir / '.install-transaction').write_text(str(self.dir / 'backups/retained') + '\n')
        (self.dir / '.installing').write_text('999999:1:previous-boot\n')
        result = subprocess.run(['sh', '-c', functions + recovery], cwd=self.dir,
                                text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.dir / 'bin/value').read_text(), 'old-bin')
        self.assertEqual((self.dir / 'backups/retained/bin/user').read_text(),
                         'preserved-backups/retained/bin/user')
        self.assertTrue((self.dir / '.install-transaction').exists())
        self.assertTrue((self.dir / '.installing').exists())

    def test_begin_install_never_reuses_an_existing_backup(self):
        functions, _ = self.installer_transaction_fixture(self.dir)
        backup = self.dir / 'backups/42-interrupted'
        backup.mkdir()
        (backup / '.install-owner').write_text('999999:1:older-boot\n')
        (backup / 'settings.sh').write_text('retained-settings')
        result = subprocess.run(['sh', '-c', functions + '\nbegin_install || install_abort existing'],
                                cwd=self.dir, text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((backup / 'settings.sh').read_text(), 'retained-settings')
        self.assertEqual((backup / '.install-owner').read_text(), '999999:1:older-boot\n')
        self.assert_installed_tree_preserved(self.dir)

    def test_boot_and_installer_cannot_cross_a_live_install_lock(self):
        functions, _ = self.installer_transaction_fixture(self.dir)
        self.boot_fixture(self.dir)
        holder = subprocess.Popen(['sh', '-c', functions + '''
install_lock || exit 1
trap 'install_unlock' 0
printf 'ready\\n'
read -r release
'''], cwd=self.dir, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline(), 'ready\n')
            result = self.boot(self.dir)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.dir / 'boot-started').exists())
            result = subprocess.run(['sh', '-c', functions + '\nbegin_install'], cwd=self.dir,
                                    text=True, capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.dir / '.installing').exists())
        finally:
            _, stderr = holder.communicate('release\n', timeout=10)
        self.assertEqual(holder.returncode, 0, stderr)
        result = self.boot(self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.dir / 'boot-started').exists())

    def test_boot_keeps_install_lock_until_startup_returns(self):
        functions, _ = self.installer_transaction_fixture(self.dir)
        self.boot_fixture(self.dir)
        starter = self.dir / 'scripts/start.sh'
        starter.write_text('#!/bin/sh\nprintf "starting\\n"\nread -r release\n')
        boot = subprocess.Popen(['sh', '-c', 'getprop() { echo 1; }; . "$PWD/module/service.sh"',
                                 str(self.dir / 'module/service.sh')], cwd=self.dir,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(boot.stdout.readline(), 'starting\n')
            result = subprocess.run(['sh', '-c', functions + '\nbegin_install'], cwd=self.dir,
                                    text=True, capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.dir / '.installing').exists())
        finally:
            _, stderr = boot.communicate('release\n', timeout=10)
        self.assertEqual(boot.returncode, 0, stderr)
        self.assertFalse((self.dir / '.install-lock').is_symlink())

    def test_stale_lock_requires_exact_boot_and_starttime(self):
        run_sh(self.recovery_source() + '''
TS_DIR="$PWD"
install_lock || exit 1
owner=$_INSTALL_OWNER
pid=${owner%%:*}
install_owner_alive "$owner" || exit 2
install_owner_alive "$pid:0:$_INSTALL_BOOT" && exit 3
install_owner_alive "$pid:$_il_start:another-boot" && exit 4
install_unlock
for stale in "$pid:0:$_INSTALL_BOOT" "$pid:$_il_start:another-boot"; do
  ln -s "$stale" "$TS_DIR/.install-lock" || exit 5
  ln -s choosing "$TS_DIR/.install-waiters/$stale" || exit 6
  install_lock || exit 7
  [ "$(readlink "$TS_DIR/.install-lock")" = "$owner" ] || exit 8
  [ ! -L "$TS_DIR/.install-waiters/$stale" ] || exit 9
  install_unlock
done
''', self.dir)

    def test_active_module_receives_only_stable_boot_files(self):
        source = (ROOT / 'customize.sh').read_text()
        entry = source[source.index('install_recovery_entry() {'):source.index('# shellcheck source=install-recovery.sh')]
        entry = entry.replace('/data/adb/', str(self.dir) + '/')
        active = self.dir / 'modules/foxytail'
        staged = self.dir / 'modules_update/foxytail'
        active.mkdir(parents=True)
        staged.mkdir(parents=True)
        for name in ('install-recovery.sh', 'service.sh'):
            (active / name).write_text('old-' + name)
            (staged / name).write_bytes((ROOT / name).read_bytes())
        (active / 'custom').mkdir()
        (active / 'custom/settings').write_text('keep-custom')
        (active / 'module.prop').write_text('old-version')
        run_sh(entry + '\nMODPATH="$PWD/modules_update/foxytail"\ninstall_recovery_entry\n', self.dir)
        for name in ('install-recovery.sh', 'service.sh'):
            self.assertEqual((active / name).read_bytes(), (staged / name).read_bytes())
            self.assertEqual((active / name).stat().st_mode & 0o777, 0o755)
        self.assertEqual((active / 'custom/settings').read_text(), 'keep-custom')
        self.assertEqual((active / 'module.prop').read_text(), 'old-version')

    def test_boot_rejects_unowned_or_escaped_backup_without_deleting_data(self):
        for fault in ('owner', 'traversal', 'backup-symlink', 'owner-symlink'):
            with self.subTest(fault=fault):
                directory = self.dir / fault
                functions, _ = self.installer_transaction_fixture(directory)
                self.boot_fixture(directory)
                result = subprocess.run(['sh', '-c', functions + '\nbegin_install; switch_install; kill -KILL "$$"'],
                                        cwd=directory, text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, -9, result.stderr)
                backup = directory / 'backups/42-interrupted'
                if fault == 'owner':
                    (backup / '.install-owner').write_text('999999:1:foreign-boot\n')
                elif fault == 'traversal':
                    (directory / '.install-transaction').write_text(str(backup / '../retained') + '\n')
                elif fault == 'backup-symlink':
                    alias = directory / 'backups/alias'
                    alias.symlink_to(backup, target_is_directory=True)
                    (directory / '.install-transaction').write_text(str(alias) + '\n')
                else:
                    (backup / '.install-owner').unlink()
                    (backup / '.install-owner').symlink_to(directory / '.installing')
                result = self.boot(directory)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((directory / 'boot-started').exists())
                self.assertTrue((directory / '.install-transaction').exists())
                self.assertTrue((directory / '.installing').exists())
                self.assertEqual((backup / 'bin/value').read_text(), 'old-bin')
                self.assertEqual((directory / 'bin/value').read_text(), 'new-bin')
                self.assertEqual((directory / 'backups/retained/bin/user').read_text(),
                                 'preserved-backups/retained/bin/user')

    def test_failed_boot_restore_retains_evidence_for_retry(self):
        functions, _ = self.installer_transaction_fixture(self.dir)
        self.boot_fixture(self.dir)
        result = subprocess.run(['sh', '-c', functions + '\nbegin_install; switch_install; kill -KILL "$$"'],
                                cwd=self.dir, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, -9, result.stderr)
        result = self.boot(self.dir, '''
mv() { [ "$1" != "$PWD/backups/42-interrupted/bin" ] || return 1; command mv "$@"; }
''')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.dir / '.installing').exists())
        self.assertTrue((self.dir / '.install-transaction').exists())
        self.assertEqual((self.dir / 'backups/42-interrupted/bin/value').read_text(), 'old-bin')
        self.assertFalse((self.dir / 'boot-started').exists())
        result = self.boot(self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.dir / 'boot-started').exists())

    def test_quiesce_is_internal_and_does_not_create_a_user_stop_hold(self):
        source = (ROOT / 'customize.sh').read_text()
        function = source[source.index('quiesce_installed() {'):source.index('# Each successfully moved old entry')]
        function = function.replace('"${TS_SCRIPTS_DIR}/foxytail.service" stop',
                                    'sh "${TS_SCRIPTS_DIR}/foxytail.service" stop')
        scripts = self.dir / 'scripts'
        scripts.mkdir()
        service = scripts / 'foxytail.service'
        service.write_text('#!/bin/sh\n[ "$1:$2" = stop:--internal ] || { touch "$PWD/user-held"; exit 1; }\n')
        service.chmod(0o755)
        run_sh(function + '''
TS_DIR="$PWD"; TS_SCRIPTS_DIR="$PWD/scripts"; _INSTALL_OWNER=fixture
printf '%s\\n' "$_INSTALL_OWNER" >"$TS_DIR/.installing"
installed_pids() { :; }
quiesce_installed
''', self.dir)
        self.assertFalse((self.dir / 'user-held').exists())

    def test_backup_creation_and_journal_publish_failures_leave_old_tree_usable(self):
        for fault in ('mkdir', 'publish'):
            with self.subTest(fault=fault):
                directory = self.dir / fault
                functions, _ = self.installer_transaction_fixture(directory)
                result = subprocess.run(['sh', '-c', functions + '''
mkdir() {
  if [ "$FAULT" = mkdir ] && [ "$1" = "$BACKUP" ]; then return 1; fi
  command mkdir "$@"
}
mv() {
  if [ "$FAULT" = publish ] && [ "$2" = "$TS_DIR/.install-transaction" ]; then return 1; fi
  command mv "$@"
}
begin_install || install_abort preparation
'''], cwd=directory, env={**os.environ, 'FAULT': fault}, text=True, capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assert_installed_tree_preserved(directory)
                self.assertEqual(list(directory.glob('.install-transaction-*')), [])

    def test_copytruncate_keeps_existing_writer_on_active_inode(self):
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        function = settings[settings.index('rotate_log()'):settings.index('# Log with a per-call')]
        function += (ROOT / 'tailscale/scripts/foxytail.lock.sh').read_text() + '\n' + host_process_shell()
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
