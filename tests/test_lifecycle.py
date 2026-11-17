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


if __name__ == '__main__':
    unittest.main()
