"""DNS preference ownership stays paired with its saved Tailscale identity."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DnsJournalInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxytail-dns-journal-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.runtime = self.base / 'runtime'
        (self.runtime / 'state').mkdir(parents=True)
        (self.runtime / 'scripts').mkdir()
        controller = self.runtime / 'scripts/start.sh'
        controller.write_text('#!/bin/sh\nexit "${STOP_RESULT:-0}"\n')
        controller.chmod(0o755)
        self.identity = self.runtime / 'state/tailscaled.state'
        self.journal = self.runtime / 'state/foxydns-preferences.json'
        self.identity_backup = self.base / 'identity.backup'
        self.journal_backup = self.base / 'dns.backup'
        self.identity.write_text('fixture-identity')
        self.journal.write_text(json.dumps({'version': 1, 'entries': [
            {'id': 'profile-a', 'self': 'node-a', 'original': True, 'phase': 'owned'}]}))

    def rewrite(self, source):
        return source.replace('/data/adb/foxytail-state.backup', str(self.identity_backup)) \
            .replace('/data/adb/foxytail-dns-preferences.backup', str(self.journal_backup)) \
            .replace('/data/adb/foxytail', str(self.runtime))

    def uninstall(self, ok=True, **environment):
        script = self.base / 'uninstall.sh'
        script.write_text(self.rewrite((ROOT / 'uninstall.sh').read_text()))
        result = subprocess.run(['sh', str(script)], env={**os.environ, **environment},
                                text=True, capture_output=True, timeout=10)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)

    def restore(self, injection='', ok=True):
        source = (ROOT / 'customize.sh').read_text()
        start = source.index('STATE_BACKUP="/data/adb/foxytail-state.backup"')
        end = source.index('# --- Permissions', start)
        script = 'TS_DIR=' + shlex.quote(str(self.runtime)) + '\n' \
            + 'install_abort() { echo "$*" >&2; exit 1; }\nui_print() { :; }\n' \
            + injection + '\n' + self.rewrite(source[start:end])
        result = subprocess.run(['sh', '-c', script], text=True, capture_output=True, timeout=10)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def test_uninstall_and_reinstall_preserve_identity_and_journal_together(self):
        original = self.journal.read_text()
        self.uninstall()
        self.assertFalse(self.runtime.exists())
        self.assertEqual(self.identity_backup.read_text(), 'fixture-identity')
        self.assertEqual(self.journal_backup.read_text(), original)
        self.assertEqual(self.journal_backup.stat().st_mode & 0o777, 0o600)
        self.restore()
        self.assertEqual(self.identity.read_text(), 'fixture-identity')
        self.assertEqual(self.journal.read_text(), original)
        self.assertEqual(self.identity.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.identity.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)

    def test_failed_cleanup_keeps_runtime_identity_and_ownership(self):
        original = self.journal.read_text()
        self.uninstall(ok=False, STOP_RESULT='1')
        self.assertEqual(self.journal.read_text(), original)
        self.assertEqual(self.identity.read_text(), 'fixture-identity')

    def test_missing_journal_removes_stale_ownership_backup(self):
        self.journal.unlink()
        self.journal_backup.write_text('stale-journal')
        self.uninstall()
        self.assertFalse(self.journal_backup.exists())
        self.assertEqual(self.identity_backup.read_text(), 'fixture-identity')

    def test_existing_identity_never_receives_a_backup_journal(self):
        self.journal.unlink()
        self.identity_backup.write_text('other-identity')
        self.journal_backup.write_text('other-journal')
        self.restore()
        self.assertEqual(self.identity.read_text(), 'fixture-identity')
        self.assertFalse(self.journal.exists())

    def test_existing_journal_is_not_overwritten_when_identity_is_restored(self):
        original = self.journal.read_text()
        self.identity.unlink()
        self.identity_backup.write_text('saved-identity')
        self.journal_backup.write_text('older-journal')
        self.restore()
        self.assertEqual(self.identity.read_text(), 'saved-identity')
        self.assertEqual(self.journal.read_text(), original)

    def test_partial_identity_or_journal_copy_is_private_and_retryable(self):
        self.identity_backup.write_text('complete-identity')
        self.journal_backup.write_text('complete-journal')
        for backup in (self.identity_backup, self.journal_backup):
            with self.subTest(backup=backup.name):
                self.identity.unlink(missing_ok=True)
                self.journal.unlink(missing_ok=True)
                self.restore('''
cp() {
  if [ "$1" = ''' + shlex.quote(str(backup)) + ''' ]; then
    printf '{' >"$2"
    command cp "$2" "$TS_DIR/partial-evidence"
    return 1
  fi
  command cp "$@"
}
''', ok=False)
                self.assertFalse(self.identity.exists())
                self.assertFalse(self.journal.exists())
                evidence = self.runtime / 'partial-evidence'
                self.assertEqual(evidence.read_text(), '{')
                self.assertEqual(evidence.stat().st_mode & 0o777, 0o600)
                self.assertEqual(list(self.identity.parent.glob('.restore-*')), [])
                self.restore()
                self.assertEqual(self.identity.read_text(), 'complete-identity')
                self.assertEqual(self.journal.read_text(), 'complete-journal')
                self.assertEqual(self.identity.stat().st_mode & 0o777, 0o600)
                self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)

    def test_restore_permission_failure_never_publishes_unready_identity(self):
        self.identity_backup.write_text('complete-identity')
        self.journal_backup.write_text('complete-journal')
        for part in ('tailscaled.state', 'foxydns-preferences.json'):
            with self.subTest(part=part):
                self.identity.unlink(missing_ok=True)
                self.journal.unlink(missing_ok=True)
                self.restore('''
chmod() {
  case "$2" in */.restore-*/''' + part + ''') return 1 ;; esac
  command chmod "$@"
}
''', ok=False)
                self.assertFalse(self.identity.exists())
                self.assertFalse(self.journal.exists())
                self.assertEqual(list(self.identity.parent.glob('.restore-*')), [])
                self.restore()
                self.assertEqual(self.identity.read_text(), 'complete-identity')
                self.assertEqual(self.journal.read_text(), 'complete-journal')

    def test_killed_restore_retries_without_using_partial_staging_files(self):
        self.identity_backup.write_text('complete-identity')
        self.journal_backup.write_text('complete-journal')
        for backup in (self.identity_backup, self.journal_backup):
            with self.subTest(backup=backup.name):
                self.identity.unlink(missing_ok=True)
                self.journal.unlink(missing_ok=True)
                self.restore('''
cp() {
  if [ "$1" = ''' + shlex.quote(str(backup)) + ''' ]; then
    printf '{' >"$2"
    trap - 0
    kill -KILL "$$"
    exit 1
  fi
  command cp "$@"
}
''', ok=False)
                self.assertFalse(self.identity.exists())
                self.assertFalse(self.journal.exists())
                stages = list(self.identity.parent.glob('.restore-*'))
                self.assertTrue(stages)
                for stage in stages:
                    self.assertEqual(stage.stat().st_mode & 0o777, 0o700)
                    for partial in stage.iterdir():
                        self.assertEqual(partial.stat().st_mode & 0o777, 0o600)
                self.restore()
                self.assertEqual(self.identity.read_text(), 'complete-identity')
                self.assertEqual(self.journal.read_text(), 'complete-journal')

    def test_restore_publication_failure_is_retryable_for_both_files(self):
        self.identity_backup.write_text('complete-identity')
        self.journal_backup.write_text('complete-journal')
        for part in ('tailscaled.state', 'foxydns-preferences.json'):
            with self.subTest(part=part):
                self.identity.unlink(missing_ok=True)
                self.journal.unlink(missing_ok=True)
                self.restore('''
mv() {
  case "$1" in */''' + part + ''') return 1 ;; esac
  command mv "$@"
}
''', ok=False)
                self.assertFalse(self.identity.exists())
                if part == 'tailscaled.state':
                    self.assertEqual(self.journal.read_text(), 'complete-journal')
                else:
                    self.assertFalse(self.journal.exists())
                self.assertEqual(list(self.identity.parent.glob('.restore-*')), [])
                self.restore()
                self.assertEqual(self.identity.read_text(), 'complete-identity')
                self.assertEqual(self.journal.read_text(), 'complete-journal')

    def test_killed_restore_after_journal_publication_completes_identity_on_retry(self):
        self.identity.unlink()
        self.journal.unlink()
        self.identity_backup.write_text('complete-identity')
        self.journal_backup.write_text('complete-journal')
        self.restore('''
mv() {
  command mv "$@" || return 1
  case "$2" in
    */foxydns-preferences.json) trap - 0; kill -KILL "$$"; exit 1 ;;
  esac
}
''', ok=False)
        self.assertFalse(self.identity.exists())
        self.assertEqual(self.journal.read_text(), 'complete-journal')
        self.restore()
        self.assertEqual(self.identity.read_text(), 'complete-identity')
        self.assertEqual(self.journal.read_text(), 'complete-journal')

    def test_legacy_identity_never_receives_a_backup_journal(self):
        self.identity.rename(self.runtime / 'tailscaled.state')
        self.journal.unlink()
        self.identity_backup.write_text('other-identity')
        self.journal_backup.write_text('other-journal')
        self.restore()
        self.assertFalse(self.identity.exists())
        self.assertFalse(self.journal.exists())
        self.assertEqual((self.runtime / 'tailscaled.state').read_text(), 'fixture-identity')


if __name__ == '__main__':
    unittest.main()
