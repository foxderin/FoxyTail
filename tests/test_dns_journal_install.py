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

    def restore(self):
        source = (ROOT / 'customize.sh').read_text()
        start = source.index('STATE_BACKUP="/data/adb/foxytail-state.backup"')
        end = source.index('# --- Permissions', start)
        script = 'TS_DIR=' + shlex.quote(str(self.runtime)) + '\n' \
            + 'install_abort() { echo "$*" >&2; exit 1; }\nui_print() { :; }\n' \
            + self.rewrite(source[start:end])
        result = subprocess.run(['sh', '-c', script], text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

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


if __name__ == '__main__':
    unittest.main()
