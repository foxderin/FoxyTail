"""Host-only backup regressions against the actual shell functions."""
import json
import hashlib
from pathlib import Path
import shlex
import tarfile
import unittest

from api_fixture import ApiTestCase


class BackupApiTests(ApiTestCase):
    def selected_archive(self, entries):
        path = self.sdcard / 'Download/foxytail-backup-test.tar.gz'
        self.archive(entries).replace(path)
        return path

    def test_picker_excludes_symlinks_unrelated_names_and_path_escape(self):
        good = self.selected_archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n'})
        download = self.sdcard / 'Download'
        (download / 'foxytail-backup-link.tar.gz').symlink_to(good)
        (download / 'other.tar.gz').write_bytes(good.read_bytes())
        (download / 'foxytail-backup-directory.tar.gz').mkdir()
        result = json.loads(self.shell('cmd_backup_list').stdout)
        self.assertEqual([item['path'] for item in result['backups']], [str(good)])
        self.assertEqual(result['backups'][0]['size'], good.stat().st_size)
        outside = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1400\n'})
        result = self.shell('cmd_restore_preview ' + shlex.quote(str(outside)), ok=False)
        self.assertNotEqual(result.returncode, 0)

    def test_preview_is_read_only_and_shows_validated_config_diff_and_hook_names(self):
        before = self.snapshot()
        archive = self.selected_archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n',
                                         'foxytail.tun.up': 'do-not-execute-secret-hook\n'})
        state = self.base / 'state'
        state.mkdir()
        identity = state / 'tailscaled.state'
        identity.write_text('private-identity')
        result = json.loads(self.shell('cmd_restore_preview ' + shlex.quote(str(archive))).stdout)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(result['sha256'], hashlib.sha256(archive.read_bytes()).hexdigest())
        change = next(change for change in result['changes'] if change['key'] == 'SOCKS_PORT')
        self.assertEqual(change, {'file': 'foxytail.conf', 'key': 'SOCKS_PORT', 'before': '1099', 'after': '1200'})
        self.assertEqual(result['hooks'], ['foxytail.tun.up'])
        self.assertNotIn('private-identity', json.dumps(result))
        self.assertNotIn('do-not-execute-secret-hook', json.dumps(result))
        self.assertEqual(identity.read_text(), 'private-identity')
        self.assertFalse((self.run / 'settings.pending').exists())
        self.assertFalse(list(self.base.glob('restored-hooks-*')))
        self.assertFalse(list(self.base.glob('.restore.*')))

    def test_preview_rejects_links_and_invalid_config_without_writes(self):
        before = self.snapshot()
        for entries in ({'conf/foxytail.conf': ('/etc/passwd',)}, {'conf/foxytail.conf': 'TS_MODE=invalid\n'}):
            with self.subTest(entries=entries):
                archive = self.selected_archive(entries)
                result = self.shell('cmd_restore_preview ' + shlex.quote(str(archive)), ok=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.snapshot(), before)

    def test_restore_rejects_archive_changed_after_preview_before_any_write(self):
        archive = self.selected_archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n'})
        preview = json.loads(self.shell('cmd_restore_preview ' + shlex.quote(str(archive))).stdout)
        before = self.snapshot()
        self.selected_archive({'conf/foxytail.conf': 'SOCKS_PORT=1300\n'})
        result = self.shell('cmd_restore ' + shlex.quote(str(archive)) + ' ' + preview['sha256'], ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('changed after preview', json.loads(result.stdout)['error'])
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(list(self.base.glob('conf.bak-*')))

    def test_restore_validation_has_no_partial_writes(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'PATH=/sdcard/evil\n'})
        self.assertNotEqual(self.shell('cmd_restore ' + shlex.quote(str(archive)), ok=False).returncode, 0)
        self.assertEqual(self.snapshot(), previous)

    def test_restore_validates_retained_context_before_replacing_any_config(self):
        (self.conf / 'context.conf').write_text('cellular:-:typo')
        before = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n'})
        result = self.shell('cmd_restore ' + shlex.quote(str(archive)), ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('restore:', json.loads(result.stdout)['error'])
        self.assertEqual(self.snapshot(), before)

    def test_restore_rejects_links_before_extraction(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'TS_MODE=bridge\n', 'conf/link': (str(self.base / 'escape'),)})
        self.assertNotEqual(self.shell('cmd_restore ' + shlex.quote(str(archive)), ok=False).returncode, 0)
        self.assertEqual(self.snapshot(), previous)
        self.assertFalse((self.base / 'escape').exists())

    def test_restore_rolls_back_failed_activation(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'ROUTE_SCOPE=all\n'})
        result = self.shell('''mv() { case "$1" in */next) return 1 ;; esac; command mv "$@"; }
cmd_restore ''' + shlex.quote(str(archive)), ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), previous)

    def test_failed_rollback_removal_preserves_previous_directory(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'ROUTE_SCOPE=all\n'})
        result = self.shell('''conf_mark_pending() { return 1; }
rm() { [ "$*" != "-rf $TS_CONF_DIR" ] || return 1; command rm "$@"; }
cmd_restore ''' + shlex.quote(str(archive)), ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('previous configuration retained', result.stderr)
        backups = list(self.base.glob('conf.bak-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual({file.name: file.read_bytes() for file in backups[0].iterdir()}, previous)
        self.assertFalse(any(file.is_dir() for file in self.conf.iterdir()), 'rollback nested the old directory inside conf')

    def test_restore_retains_snapshot_and_marks_restart(self):
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'ROUTE_SCOPE=all\n', 'foxytail.tun.up': '#!/system/bin/sh\necho restored\n'})
        result = json.loads(self.shell('cmd_restore ' + shlex.quote(str(archive))).stdout)
        self.assertTrue(Path(result['previous']).is_dir())
        self.assertTrue(result['restartRequired'])
        self.assertEqual((self.conf / 'foxytail.conf').read_text(), 'SOCKS_PORT=1200\n')
        self.assertFalse((self.scripts / 'foxytail.tun.up').exists())

    def test_failed_backup_removes_partial_archive(self):
        result = self.shell('''tar() { [ "$1" != -czf ] || { printf truncated >"$2"; echo 'storage write failed' >&2; return 1; }; command tar "$@"; }
cmd_backup''', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('archive creation failed: storage write failed', json.loads(result.stdout)['error'])
        self.assertEqual(list((self.sdcard / 'Download').iterdir()), [])
        self.assertEqual(list(self.run.glob('.backup.*')), [])
        self.assertFalse((self.run / '.conf-write-lock').is_symlink())

    def test_real_backup_preserves_configuration_and_optional_hooks_and_restores(self):
        for with_hooks in (False, True):
            with self.subTest(with_hooks=with_hooks):
                before = self.snapshot()
                hooks = {name: f'#!/system/bin/sh\n# fixture {name}\necho do-not-execute\n'.encode()
                         for name in ('foxytail.tun.up', 'foxytail.tun.down')} if with_hooks else {}
                for name, content in hooks.items():
                    (self.scripts / name).write_bytes(content)
                # macOS bsdtar otherwise adds AppleDouble metadata entries that
                # Android tar does not produce and the restore format excludes.
                result = json.loads(self.shell('export COPYFILE_DISABLE=1\ncmd_backup').stdout)
                archive = Path(result['path'])
                self.assertTrue(result['ok']); self.assertTrue(archive.is_file())
                self.assertEqual(result['size'], archive.stat().st_size)
                self.assertGreater(result['size'], 0)
                # Real tar/gzip bytes, independently read and compared by Python.
                with tarfile.open(archive, 'r:gz') as backup:
                    files = {member.name: backup.extractfile(member).read()
                             for member in backup.getmembers() if member.isfile()}
                self.assertEqual(files, {**{'conf/' + name: content for name, content in before.items()}, **hooks})
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(list(self.run.glob('.backup.*')), [])
                self.assertFalse((self.run / '.conf-write-lock').is_symlink())
                # The actual restore implementation consumes this archive in our
                # private fixture; no host/device service commands are involved.
                (self.conf / 'foxytail.conf').write_text('SOCKS_PORT=9999\n')
                restored = json.loads(self.shell('cmd_restore ' + shlex.quote(str(archive))).stdout)
                self.assertTrue(restored['ok']); self.assertEqual(self.snapshot(), before)
                for name, content in hooks.items():
                    parked = list(self.base.glob('restored-hooks-*/' + name + '.restored'))
                    self.assertEqual(len(parked), 1)
                    self.assertEqual(parked[0].read_bytes(), content)
                    self.assertEqual(parked[0].stat().st_mode & 0o111, 0)

    def test_backup_verification_and_shared_storage_failures_are_actionable(self):
        result = self.shell('''tar() { [ "$1" != -tzf ] || { echo 'gzip checksum mismatch' >&2; return 1; }; command tar "$@"; }
cmd_backup''', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('archive verification failed: gzip checksum mismatch', json.loads(result.stdout)['error'])
        self.assertEqual(list((self.sdcard / 'Download').iterdir()), [])
        result = self.shell('''mkdir() { [ "$*" != '-p ''' + str(self.sdcard / 'Download') + '''' ] || { echo 'Permission denied' >&2; return 1; }; command mkdir "$@"; }
cmd_backup''', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('cannot create Download directory: Permission denied', json.loads(result.stdout)['error'])
        self.assertEqual(list(self.run.glob('.backup.*')), [])
        self.assertFalse((self.run / '.conf-write-lock').is_symlink())


    def test_file_receive_preserves_first_failure_without_retry(self):
        result = self.shell('''ts_cli() {
  echo "$*" >>"$TS_RUN_DIR/receive-calls"
  echo 'disk full' >&2; return 1
}
cmd_file_receive''', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('disk full', json.loads(result.stdout)['error'])
        self.assertEqual((self.run / 'receive-calls').read_text().splitlines(),
                         ['60 file get --wait=false ' + str(self.base / 'files') + '/'])


if __name__ == '__main__':
    unittest.main()
