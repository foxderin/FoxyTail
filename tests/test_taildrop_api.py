"""Taildrop regressions using the real WebAPI shell and private shared storage."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import time
import unittest

from api_fixture import ApiTestCase


class TaildropApiTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.inbox = self.base / 'files'
        self.inbox.mkdir()
        self.downloads = self.sdcard / 'Download'

    def receive(self, entries, prefix=''):
        incoming = self.downloads / 'Taildrop'
        incoming.mkdir(exist_ok=True)
        for name, body in entries.items():
            (incoming / name).write_text(body)
        return json.loads(self.shell(prefix + '\ntaildrop_direct_ready() { return 0; }\ncmd_file_receive').stdout)


    def test_receive_counts_only_new_files_and_preserves_existing_exports(self):
        for name in ('a.txt', 'b.txt'):
            (self.inbox / name).write_text('inbox-' + name)
            (self.downloads / name).write_text('user-' + name)
        (self.downloads / 'c.txt').write_text('user-c.txt')
        (self.inbox / 'directory').mkdir()
        result = self.receive({'c.txt': 'received-c'})
        self.assertEqual(result, {'ok': True, 'received': 1, 'exported': 1})
        self.assertEqual({p.name: p.read_text() for p in self.downloads.iterdir() if p.is_file()},
                         {'a.txt': 'user-a.txt', 'b.txt': 'user-b.txt',
                          'c.txt': 'user-c.txt', 'c-1.txt': 'received-c'})
        self.assertEqual((self.inbox / 'c.txt').read_text(), 'received-c')
        self.assertEqual(self.receive({}), {'ok': True, 'received': 0, 'exported': 0})

    def test_receive_keeps_spaces_and_metacharacter_names_intact(self):
        entries = {'meeting notes.txt': 'spaces', 'literal * ? [x].txt': 'glob',
                   "quote ' ; $(echo injected).txt": 'literal',
                   '.env': 'hidden', '-leading.txt': 'dash'}
        result = self.receive(entries)
        self.assertEqual(result, {'ok': True, 'received': len(entries), 'exported': len(entries)})
        self.assertEqual({p.name: p.read_text() for p in self.downloads.iterdir() if p.is_file()}, entries)
        self.assertEqual({p.name: p.read_text() for p in self.inbox.iterdir() if p.is_file()}, entries)
        self.assertEqual(self.receive({}), {'ok': True, 'received': 0, 'exported': 0})

    def test_manual_export_preserves_metacharacter_names(self):
        name = "meeting * [1] ' ; $(echo no).txt"
        (self.inbox / name).write_text('exact content')
        result = json.loads(self.shell('cmd_file_export ' + shlex.quote(name)).stdout)
        self.assertEqual(result, {'ok': True, 'path': str(self.downloads / name)})
        self.assertEqual((self.downloads / name).read_text(), 'exact content')
        self.assertEqual((self.inbox / name).read_text(), 'exact content')

    def test_export_exhaustion_never_overwrites_last_candidate(self):
        (self.inbox / 'a.txt').write_text('new content')
        names = ['a.txt'] + [f'a-{n}.txt' for n in range(1, 100)]
        expected = {name: 'user-' + name for name in names}
        for name, body in expected.items():
            (self.downloads / name).write_text(body)
        result = self.shell('cmd_file_export a.txt', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertEqual({p.name: p.read_text() for p in self.downloads.iterdir()}, expected)
        self.assertEqual((self.inbox / 'a.txt').read_text(), 'new content')
        (self.inbox / 'a.txt').unlink()
        self.assertEqual(self.receive({'a.txt': 'received content'}),
                         {'ok': True, 'received': 1, 'exported': 0})
        self.assertEqual({p.name: p.read_text() for p in self.downloads.iterdir() if p.is_file()}, expected)
        self.assertEqual((self.inbox / 'a.txt').read_text(), 'received content')

    def test_export_skips_directories_and_symlinks(self):
        (self.inbox / 'a.txt').write_text('new content')
        (self.downloads / 'a.txt').mkdir()
        outside = self.base / 'outside'
        outside.write_text('keep outside')
        (self.downloads / 'a-1.txt').symlink_to(outside)
        absent = self.base / 'absent'
        (self.downloads / 'a-2.txt').symlink_to(absent)
        result = json.loads(self.shell('cmd_file_export a.txt').stdout)
        self.assertEqual(result['path'], str(self.downloads / 'a-3.txt'))
        self.assertEqual(outside.read_text(), 'keep outside')
        self.assertFalse(absent.exists())
        self.assertTrue((self.downloads / 'a.txt').is_dir())
        self.assertTrue((self.downloads / 'a-1.txt').is_symlink())
        self.assertTrue((self.downloads / 'a-2.txt').is_symlink())
        self.assertEqual((self.downloads / 'a-3.txt').read_text(), 'new content')

    def test_concurrent_exports_cannot_clobber_each_other(self):
        (self.inbox / 'race.txt').write_text('first sender')
        other = self.base / 'other-inbox'
        other.mkdir()
        (other / 'race.txt').write_text('second sender')
        gate = self.run / 'copy-gate'
        os.mkfifo(gate)
        # Keep the FIFO open so release and cleanup cannot block the test runner.
        gate_fd = os.open(gate, os.O_RDWR | os.O_NONBLOCK)
        script = '''. "$1"
pause_copy() {
  : >"$TS_RUN_DIR/copy-ready"
  IFS= read -r proceed <"$TS_RUN_DIR/copy-gate"
}
cat() { pause_copy; command cat "$@"; }
cp() { pause_copy; command cp "$@"; }
cmd_file_export race.txt
'''
        first = subprocess.Popen(['sh', '-c', script, 'test', str(self.lib)],
                                 text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not (self.run / 'copy-ready').exists():
                self.assertIsNone(first.poll(), 'first export exited before copying')
                self.assertLess(time.monotonic(), deadline, 'first export did not reach copy')
                time.sleep(.01)
            second = json.loads(self.shell('FILES_DIR=' + shlex.quote(str(other)) +
                                           '\ncmd_file_export race.txt').stdout)
            os.write(gate_fd, b'continue\n')
            stdout, stderr = first.communicate(timeout=5)
            self.assertEqual(first.returncode, 0, stdout + stderr)
            first_result = json.loads(stdout)
            self.assertNotEqual(first_result['path'], second['path'])
            self.assertEqual(Path(first_result['path']).read_text(), 'first sender')
            self.assertEqual(Path(second['path']).read_text(), 'second sender')
            self.assertEqual((self.inbox / 'race.txt').read_text(), 'first sender')
            self.assertEqual((other / 'race.txt').read_text(), 'second sender')
        finally:
            os.write(gate_fd, b'continue\n')
            if first.poll() is None:
                first.kill()
            first.communicate(timeout=5)
            os.close(gate_fd)

    def test_failed_export_keeps_inbox_and_removes_partial_copy(self):
        failing_copy = '''cat() { printf partial; return 1; }
cp() { return 1; }
'''
        result = self.receive({'received.txt': 'complete inbox content'}, failing_copy)
        self.assertEqual(result, {'ok': True, 'received': 1, 'exported': 0})
        self.assertEqual((self.inbox / 'received.txt').read_text(), 'complete inbox content')
        self.assertEqual([p for p in self.downloads.iterdir() if p.is_file()], [])
        result = self.shell(failing_copy + 'cmd_file_export received.txt', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertEqual((self.inbox / 'received.txt').read_text(), 'complete inbox content')
        self.assertEqual([p for p in self.downloads.iterdir() if p.is_file()], [])

    def test_receive_unknown_startup_mode_does_not_import(self):
        incoming = self.downloads / 'Taildrop'
        incoming.mkdir()
        (incoming / 'keep.txt').write_text('shared')
        result = self.shell('taildrop_direct_ready() { return 1; }\ncmd_file_receive', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('mode is unknown', json.loads(result.stdout)['error'])
        self.assertEqual(list(self.inbox.iterdir()), [])
        self.assertEqual((incoming / 'keep.txt').read_text(), 'shared')

    def test_receive_reports_unavailable_shared_directory_without_fallback(self):
        result = self.shell('taildrop_direct_ready() { return 0; }\ncmd_file_receive', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('incoming directory unavailable', json.loads(result.stdout)['error'])
        self.assertEqual(list(self.inbox.iterdir()), [])

    def test_receive_preserves_new_content_after_same_name_collision(self):
        self.assertEqual(self.receive({'a.txt': 'first'})['received'], 1)
        self.assertEqual(self.receive({'a.txt': 'second'})['received'], 1)
        self.assertEqual((self.inbox / 'a.txt').read_text(), 'first')
        self.assertEqual((self.inbox / 'a-1.txt').read_text(), 'second')
        self.assertEqual((self.downloads / 'Taildrop/a.txt').read_text(), 'second')
        self.assertEqual(self.receive({})['received'], 0)

    def test_receive_skips_unfinished_files_and_keeps_receipts_after_clear(self):
        result = self.receive({'done.txt': 'complete', 'later.partial': 'partial',
                               'removed.deleted': 'deleted', 'line\nbreak.txt': 'unsupported'})
        self.assertEqual(result, {'ok': True, 'received': 1, 'exported': 1, 'ignored': 1})
        self.assertEqual(json.loads(self.shell('cmd_file_clear').stdout)['removed'], 1)
        self.assertTrue((self.inbox / '.taildrop').is_dir())
        self.assertEqual(self.receive({})['received'], 0)
        self.assertEqual((self.downloads / 'Taildrop/done.txt').read_text(), 'complete')

    def test_private_receipts_and_symlinks_are_not_file_api_items(self):
        receipts = self.inbox / '.taildrop'
        receipts.mkdir()
        (receipts / 'receipt').write_text('private')
        outside = self.base / 'secret'
        outside.write_text('secret')
        (self.inbox / 'link').symlink_to(outside)
        for command in ('cmd_file_read', 'cmd_file_delete', 'cmd_file_export'):
            for name in ('.taildrop', '.taildrop/receipt', 'link'):
                result = self.shell(command + ' ' + shlex.quote(name), ok=False)
                self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(self.shell('cmd_files_inbox').stdout)['files'], [])
        self.assertEqual(json.loads(self.shell('cmd_file_clear').stdout)['removed'], 0)
        self.assertEqual((receipts / 'receipt').read_text(), 'private')
        self.assertEqual(outside.read_text(), 'secret')

    def test_receive_rejects_control_names_without_renaming_or_deleting(self):
        controls = [chr(n) for n in range(1, 32)] + [chr(n) for n in range(127, 160)]
        unsupported = {'bad' + control + '.txt': 'keep' for control in controls}
        unsupported['back\\slash.txt'] = 'keep'
        result = self.receive(dict(unsupported, **{'normal.txt': 'valid'}))
        self.assertEqual(result, {'ok': True, 'received': 1, 'exported': 1, 'ignored': len(unsupported)})
        self.assertEqual({p.name: p.read_text() for p in self.inbox.iterdir() if p.is_file()}, {'normal.txt': 'valid'})
        self.assertEqual({p.name: p.read_text() for p in self.downloads.iterdir() if p.is_file()}, {'normal.txt': 'valid'})
        incoming = self.downloads / 'Taildrop'
        for name, body in unsupported.items():
            self.assertEqual((incoming / name).read_text(), body)
        self.assertEqual(self.receive({}), {'ok': True, 'received': 0, 'exported': 0, 'ignored': len(unsupported)})

    def test_initial_listing_and_clear_isolate_existing_incompatible_entries(self):
        unsupported = ['tab\tname', 'line\nbreak', 'return\rname', 'escape\x1bname', 'delete\x7fname', 'c1\u0085name', 'back\\slash']
        supported = ['normal.txt', '.env', "literal * [1] ' .txt"]
        for name in unsupported + supported:
            (self.inbox / name).write_text('keep-' + name)
        listing = json.loads(self.shell('cmd_files_inbox').stdout)
        self.assertTrue(listing['ok'])
        self.assertEqual({item['name'] for item in listing['files']}, set(supported))
        self.assertEqual(listing['ignored'], len(unsupported))
        read = self.shell('cmd_file_read normal.txt').stdout
        self.assertEqual(read, 'keep-normal.txt')
        self.assertEqual(json.loads(self.shell('cmd_file_clear').stdout), {'ok': True, 'removed': len(supported), 'ignored': len(unsupported)})
        self.assertEqual({p.name for p in self.inbox.iterdir()}, set(unsupported))
        for name in unsupported:
            self.assertEqual((self.inbox / name).read_bytes(), ('keep-' + name).encode())
        listing = json.loads(self.shell('cmd_files_inbox').stdout)
        self.assertEqual(listing['files'], [])
        self.assertEqual(listing['ignored'], len(unsupported))

    def test_large_inbox_uses_one_native_listing_and_no_per_file_helpers(self):
        for index in range(500):
            (self.inbox / f'file-{index:03}.txt').write_text('payload')
        (self.inbox / '.env').write_text('hidden')
        (self.inbox / '.taildrop').mkdir()
        (self.inbox / '.outgoing').mkdir()
        (self.inbox / 'directory').mkdir()
        calls = self.run / 'inbox-native-calls'
        jq_calls = self.run / 'inbox-jq-calls'
        result = self.shell('''
stat() { echo 'unexpected shell stat' >&2; return 1; }
_file_name_valid() { echo 'unexpected per-file validation' >&2; return 1; }
_op_exec() {
  printf '%s\\n' "$3" >>"$TS_RUN_DIR/inbox-native-calls"
  shift
  "$@"
}
jqr() {
  printf '%s\\n' jq >>"$TS_RUN_DIR/inbox-jq-calls"
  command jq "$@"
}
cmd_files_inbox
''')
        listing = json.loads(result.stdout)
        self.assertEqual(set(listing), {'ok', 'files'})
        self.assertTrue(listing['ok'])
        self.assertEqual(len(listing['files']), 501)
        self.assertEqual(calls.read_text().splitlines(), ['inbox-list'])
        self.assertEqual(jq_calls.read_text().splitlines(), ['jq'])
        for entry in listing['files']:
            expected = (self.inbox / entry['name']).stat()
            self.assertEqual(entry, {'name': entry['name'], 'size': expected.st_size,
                                     'mtime': int(expected.st_mtime)})

    def test_inbox_listing_rejects_symlink_directory_without_following_it(self):
        self.inbox.rmdir()
        outside = self.base / 'outside-inbox'
        outside.mkdir()
        (outside / 'secret').write_text('keep private')
        self.inbox.symlink_to(outside, target_is_directory=True)
        result = self.shell('cmd_files_inbox', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertEqual((outside / 'secret').read_text(), 'keep private')

    def test_inbox_native_failure_is_not_replaced_with_empty_success(self):
        helper = self.base / 'bin/foxyfiles'
        helper.write_text('#!/bin/sh\necho metadata-unavailable >&2\nexit 1\n')
        helper.chmod(0o755)
        result = self.shell('cmd_files_inbox', ok=False)
        self.assertNotEqual(result.returncode, 0)
        response = json.loads(result.stdout)
        self.assertFalse(response['ok'])
        self.assertIn('metadata-unavailable', response['error'])
        self.assertNotIn('files', response)

    def test_inbox_item_operations_reject_unsupported_names(self):
        for name in ('tab\tname', 'line\nbreak', 'delete\x7fname', 'c1\u0085name', 'back\\slash'):
            (self.inbox / name).write_text('preserve')
            for command in ('cmd_file_read', 'cmd_file_delete', 'cmd_file_export'):
                result = self.shell(command + ' ' + shlex.quote(name), ok=False)
                self.assertNotEqual(result.returncode, 0)
                if command == 'cmd_file_read':
                    self.assertEqual(result.stdout, '')
                else:
                    self.assertFalse(json.loads(result.stdout)['ok'])
                self.assertEqual((self.inbox / name).read_text(), 'preserve')
        self.assertEqual([p for p in self.downloads.iterdir() if p.is_file()], [])


    def test_direct_mode_marker_requires_same_owned_daemon_identity(self):
        result = self.shell('''
_TAIL_DROP_READY=1
_proc_starttime() { printf 12345; }
boot_identity() { printf boot-a; }
pids_of_path() { printf 7654; }
taildrop_record_direct 7654 || exit 1
taildrop_direct_ready || exit 2
_proc_starttime() { printf 54321; }
if taildrop_direct_ready; then exit 3; fi
_proc_starttime() { printf 12345; }
boot_identity() { printf boot-b; }
if taildrop_direct_ready; then exit 4; fi
boot_identity() { printf boot-a; }
pids_of_path() { printf 8765; }
if taildrop_direct_ready; then exit 5; fi
''')
        self.assertEqual(result.returncode, 0)

    def test_unknown_startup_mode_cannot_be_promoted_by_later_directory(self):
        (self.downloads / 'Taildrop').mkdir()
        result = self.shell('''
_TAIL_DROP_READY=0
_proc_starttime() { printf 12345; }
boot_identity() { printf boot-a; }
pids_of_path() { printf 7654; }
if taildrop_record_direct 7654; then exit 1; fi
if taildrop_direct_ready; then exit 2; fi
''')
        self.assertEqual(result.returncode, 0)

    def test_live_direct_confirmation_recovers_missing_record_but_not_replaced_pid(self):
        (self.downloads / 'Taildrop').mkdir()
        helper = self.base / 'bin/foxyfiles'
        helper.parent.mkdir(exist_ok=True)
        helper.write_text('#!/bin/sh\necho \'{"ok":true,"direct":true}\'\n')
        helper.chmod(0o755)
        prefix = '''
pids_of_path() { printf 7654; }
_proc_starttime() { printf 12345; }
boot_identity() { printf boot-a; }
'''
        self.shell(prefix + '\ntaildrop_confirm_direct && taildrop_direct_ready')
        marker = self.run / 'taildrop-direct'
        self.assertEqual(marker.read_text().strip(), '7654 12345 boot-a')
        marker.unlink()
        helper.write_text('#!/bin/sh\ntouch "' + str(self.base / 'replaced') + '"\necho \'{"ok":true,"direct":true}\'\n')
        result = self.shell(prefix + '''
_proc_starttime() { if [ -f "$TS_DIR/replaced" ]; then printf 54321; else printf 12345; fi; }
taildrop_confirm_direct
''', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())

    def test_clear_removes_hidden_regular_files_and_preserves_directories(self):
        for name in ('ordinary.txt', '.env', '..hidden', '.meeting notes', 'literal *'):
            (self.inbox / name).write_text('remove')
        for name in ('directory', '.hidden-directory'):
            (self.inbox / name).mkdir()
            (self.inbox / name / 'keep').write_text('nested')
        result = json.loads(self.shell('cmd_file_clear').stdout)
        self.assertEqual(result, {'ok': True, 'removed': 5})
        self.assertEqual({p.name for p in self.inbox.iterdir()}, {'directory', '.hidden-directory'})
        for name in ('directory', '.hidden-directory'):
            self.assertEqual((self.inbox / name / 'keep').read_text(), 'nested')
        self.assertTrue(self.base.is_dir())
        self.assertEqual(json.loads(self.shell('cmd_file_clear').stdout), {'ok': True, 'removed': 0})

    def test_selected_delete_preserves_unselected_and_reports_partial_failure(self):
        for name in ('a.txt', '.hidden', 'keep.txt'):
            (self.inbox / name).write_text(name)
        outside = self.base / 'outside'
        outside.write_text('outside')
        (self.inbox / 'link').symlink_to(outside)
        names = ['a.txt', '.hidden', 'missing', 'link']
        result = json.loads(self.shell('set -e\ncmd_file_delete_many ' + shlex.quote(json.dumps(names))).stdout)
        self.assertEqual((result['succeeded'], result['failed']), (2, 2))
        self.assertEqual([(item['name'], item['ok']) for item in result['results']], [(name, i < 2) for i, name in enumerate(names)])
        self.assertEqual((self.inbox / 'keep.txt').read_text(), 'keep.txt')
        self.assertEqual(outside.read_text(), 'outside')
        self.assertTrue((self.inbox / 'link').is_symlink())
        self.assertFalse((self.inbox / 'a.txt').exists())
        self.assertFalse((self.inbox / '.hidden').exists())

    def test_selected_export_preserves_existing_and_exact_names(self):
        name = "literal * ' ; $(id).txt"
        (self.inbox / name).write_text('new')
        (self.downloads / name).write_text('original')
        result = json.loads(self.shell('cmd_file_export_many ' + shlex.quote(json.dumps([name, 'missing']))).stdout)
        self.assertEqual((result['succeeded'], result['failed']), (1, 1))
        self.assertEqual(Path(result['results'][0]['path']).read_text(), 'new')
        self.assertEqual((self.downloads / name).read_text(), 'original')
        self.assertEqual((self.inbox / name).read_text(), 'new')
        self.assertFalse(list(self.run.glob('.file-batch.*')))

    def test_batch_validates_whole_selection_before_any_mutation(self):
        (self.inbox / 'keep').write_text('original')
        for names in ([], ['keep', '../outside'], ['keep', 'keep'], ['keep', '.outgoing'], ['keep', 'bad\nname'], ['keep'] + [str(i) for i in range(32)], {'keep': True}):
            with self.subTest(names=names):
                result = self.shell('cmd_file_delete_many ' + shlex.quote(json.dumps(names)), ok=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(json.loads(result.stdout)['ok'])
                self.assertEqual((self.inbox / 'keep').read_text(), 'original')



if __name__ == '__main__':
    unittest.main()
