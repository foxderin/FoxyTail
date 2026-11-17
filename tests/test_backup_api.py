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

    def restore_command(self, archive):
        baseline = self.shell('conf_lock_acquire && _restore_baseline').stdout.strip()
        return 'cmd_restore ' + shlex.quote(str(archive)) + ' ' + hashlib.sha256(archive.read_bytes()).hexdigest() + ' ' + baseline

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

    def test_legacy_default_export_is_listed_and_previewable_without_changes(self):
        legacy = self.sdcard / 'Download/foxytail-backup.tar.gz'
        self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n'}).replace(legacy)
        before = self.snapshot()
        result = json.loads(self.shell('cmd_backup_list').stdout)
        self.assertEqual([item['path'] for item in result['backups']], [str(legacy)])
        preview = json.loads(self.shell('cmd_restore_preview ' + shlex.quote(str(legacy))).stdout)
        self.assertEqual(preview['sha256'], hashlib.sha256(legacy.read_bytes()).hexdigest())
        self.assertEqual(self.snapshot(), before)


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
        result = self.shell('cmd_restore ' + shlex.quote(str(archive)) + ' ' + preview['sha256'] + ' ' + preview['baselineSha256'], ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('changed after preview', json.loads(result.stdout)['error'])
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(list(self.base.glob('conf.bak-*')))

    def test_restore_rejects_saved_config_change_with_unchanged_archive(self):
        archive = self.selected_archive({'conf/foxytail.conf': (self.conf / 'foxytail.conf').read_text()})
        preview = json.loads(self.shell('cmd_restore_preview ' + shlex.quote(str(archive))).stdout)
        self.assertEqual(preview['changes'], [])
        (self.conf / 'foxytail.conf').write_text('SOCKS_PORT=1234\n')
        before = self.snapshot()
        result = self.shell('cmd_restore ' + shlex.quote(str(archive)) + ' ' + preview['sha256'] + ' ' + preview['baselineSha256'], ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('saved configuration changed', json.loads(result.stdout)['error'])
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(list(self.base.glob('conf.bak-*')))


    def test_cancel_before_commit_leaves_saved_config_and_no_journal(self):
        archive = self.selected_archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'foxytail.tun.up': 'review-only'})
        before = self.snapshot()
        result = self.shell('_op_commit_begin() { return 1; }\n' + self.restore_command(archive), ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.base / '.restore-transaction').exists())
        self.assertFalse(list(self.base.glob('restored-hooks-*')))
        self.assertFalse(list(self.base.glob('conf.bak-*')))


    def test_restore_validation_has_no_partial_writes(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'PATH=/sdcard/evil\n'})
        self.assertNotEqual(self.shell(self.restore_command(archive), ok=False).returncode, 0)
        self.assertEqual(self.snapshot(), previous)

    def test_restore_validates_retained_context_before_replacing_any_config(self):
        (self.conf / 'context.conf').write_text('cellular:-:typo')
        before = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n'})
        result = self.shell(self.restore_command(archive), ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('restore:', json.loads(result.stdout)['error'])
        self.assertEqual(self.snapshot(), before)


    def test_restore_rolls_back_failed_activation(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'ROUTE_SCOPE=all\n'})
        result = self.shell('''mv() { case "$1" in */next) return 1 ;; esac; command mv "$@"; }
''' + self.restore_command(archive), ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), previous)

    def test_failed_rollback_removal_preserves_previous_directory(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'ROUTE_SCOPE=all\n'})
        result = self.shell('''conf_mark_pending() { return 1; }
rm() { [ "$*" != "-rf $TS_CONF_DIR" ] || return 1; command rm "$@"; }
''' + self.restore_command(archive), ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('previous configuration retained', result.stderr)
        backups = list(self.base.glob('conf.bak-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual({file.name: file.read_bytes() for file in backups[0].iterdir()}, previous)
        self.assertFalse(any(file.is_dir() for file in self.conf.iterdir()), 'rollback nested the old directory inside conf')


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
                restored = json.loads(self.shell(self.restore_command(archive)).stdout)
                self.assertTrue(restored['ok']); self.assertEqual(self.snapshot(), before)
                for name, content in hooks.items():
                    parked = list(self.base.glob('restored-hooks-*/' + name + '.restored'))
                    self.assertEqual(len(parked), 1)
                    self.assertEqual(parked[0].read_bytes(), content)
                    self.assertEqual(parked[0].stat().st_mode & 0o111, 0)


if __name__ == '__main__':
    unittest.main()
