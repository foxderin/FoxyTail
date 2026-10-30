"""Taildrop regressions using the real WebAPI shell and private shared storage.

Received files live directly in Download/Taildrop: the file API lists,
reads, deletes and clears them in place. There is no import or export
step, so these tests pin the shared-directory boundary instead.
"""
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
        self.downloads = self.sdcard / 'Download'
        self.inbox = self.downloads / 'Taildrop'
        self.inbox.mkdir()

    def listing(self):
        result = json.loads(self.shell('cmd_files_inbox').stdout)
        self.assertTrue(result['ok'], result)
        return result

    def test_missing_taildrop_directory_lists_and_clears_empty(self):
        self.inbox.rmdir()
        self.assertEqual(self.listing(), {'ok': True, 'files': []})
        self.assertEqual(json.loads(self.shell('cmd_file_clear').stdout), {'ok': True, 'removed': 0})

    def test_listing_skips_inflight_internal_and_non_regular_entries(self):
        entries = {'done.txt': 'complete', '.env': 'hidden',
                   "meeting ' * [1].txt": 'literal'}
        for name, body in entries.items():
            (self.inbox / name).write_text(body)
        for name in ('later.partial', 'removed.deleted'):
            (self.inbox / name).write_text('unfinished')
        for name in ('.taildrop', '.outgoing', 'directory'):
            (self.inbox / name).mkdir()
        outside = self.base / 'secret'
        outside.write_text('secret')
        (self.inbox / 'link').symlink_to(outside)
        listing = self.listing()
        self.assertEqual({item['name'] for item in listing['files']}, set(entries))
        for entry in listing['files']:
            expected = (self.inbox / entry['name']).stat()
            self.assertEqual(entry, {'name': entry['name'], 'size': expected.st_size,
                                     'mtime': int(expected.st_mtime)})
        self.assertEqual(outside.read_text(), 'secret')

    def test_initial_listing_and_clear_isolate_existing_incompatible_entries(self):
        unsupported = ['tab\tname', 'line\nbreak', 'return\rname', 'escape\x1bname', 'delete\x7fname', 'c1\u0085name', 'back\\slash']
        supported = ['normal.txt', '.env', "literal * [1] ' .txt"]
        for name in unsupported + supported:
            (self.inbox / name).write_text('keep-' + name)
        listing = self.listing()
        self.assertEqual({item['name'] for item in listing['files']}, set(supported))
        self.assertEqual(listing['ignored'], len(unsupported))
        read = self.shell('cmd_file_read normal.txt').stdout
        self.assertEqual(read, 'keep-normal.txt')
        self.assertEqual(json.loads(self.shell('cmd_file_clear').stdout), {'ok': True, 'removed': len(supported), 'ignored': len(unsupported)})
        self.assertEqual({p.name for p in self.inbox.iterdir()}, set(unsupported))
        for name in unsupported:
            self.assertEqual((self.inbox / name).read_bytes(), ('keep-' + name).encode())
        listing = self.listing()
        self.assertEqual(listing['files'], [])
        self.assertEqual(listing['ignored'], len(unsupported))

    def test_clear_preserves_inflight_directories_and_symlinks(self):
        for name in ('ordinary.txt', '.env', '..hidden', '.meeting notes', 'literal *'):
            (self.inbox / name).write_text('remove')
        for name in ('later.partial', 'removed.deleted'):
            (self.inbox / name).write_text('unfinished')
        for name in ('directory', '.hidden-directory'):
            (self.inbox / name).mkdir()
            (self.inbox / name / 'keep').write_text('nested')
        outside = self.base / 'outside'
        outside.write_text('outside')
        (self.inbox / 'link').symlink_to(outside)
        result = json.loads(self.shell('cmd_file_clear').stdout)
        self.assertEqual(result, {'ok': True, 'removed': 5})
        self.assertEqual({p.name for p in self.inbox.iterdir()},
                         {'later.partial', 'removed.deleted', 'directory', '.hidden-directory', 'link'})
        for name in ('directory', '.hidden-directory'):
            self.assertEqual((self.inbox / name / 'keep').read_text(), 'nested')
        self.assertEqual((self.inbox / 'later.partial').read_text(), 'unfinished')
        self.assertEqual(outside.read_text(), 'outside')
        self.assertEqual(json.loads(self.shell('cmd_file_clear').stdout), {'ok': True, 'removed': 0})

    def test_large_inbox_uses_one_native_listing_and_no_per_file_helpers(self):
        for index in range(500):
            (self.inbox / f'file-{index:03}.txt').write_text('payload')
        (self.inbox / '.env').write_text('hidden')
        (self.inbox / 'later.partial').write_text('unfinished')
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
            for command in ('cmd_file_read', 'cmd_file_delete'):
                result = self.shell(command + ' ' + shlex.quote(name), ok=False)
                self.assertNotEqual(result.returncode, 0)
                if command == 'cmd_file_read':
                    self.assertEqual(result.stdout, '')
                else:
                    self.assertFalse(json.loads(result.stdout)['ok'])
                self.assertEqual((self.inbox / name).read_text(), 'preserve')

    def test_reserved_and_symlink_names_are_not_file_api_items(self):
        receipts = self.inbox / '.taildrop'
        receipts.mkdir()
        (receipts / 'receipt').write_text('private')
        outside = self.base / 'secret'
        outside.write_text('secret')
        (self.inbox / 'link').symlink_to(outside)
        for command in ('cmd_file_read', 'cmd_file_delete'):
            for name in ('.taildrop', '.taildrop/receipt', 'link'):
                result = self.shell(command + ' ' + shlex.quote(name), ok=False)
                self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.listing()['files'], [])
        self.assertEqual(json.loads(self.shell('cmd_file_clear').stdout)['removed'], 0)
        self.assertEqual((receipts / 'receipt').read_text(), 'private')
        self.assertEqual(outside.read_text(), 'secret')

    def test_delete_removes_one_and_preserves_others(self):
        for name in ('a.txt', '.hidden', 'keep.txt'):
            (self.inbox / name).write_text(name)
        self.assertEqual(json.loads(self.shell('cmd_file_delete a.txt').stdout), {'ok': True})
        self.assertFalse((self.inbox / 'a.txt').exists())
        self.assertEqual({p.name for p in self.inbox.iterdir()}, {'.hidden', 'keep.txt'})

    def test_selected_delete_preserves_unselected_and_reports_partial_failure(self):
        for name in ('a.txt', '.hidden', 'keep.txt'):
            (self.inbox / name).write_text(name)
        outside = self.base / 'outside'
        outside.write_text('outside')
        (self.inbox / 'link').symlink_to(outside)
        names = ['a.txt', '.hidden', 'missing', 'link']
        result = json.loads(self.shell('cmd_file_delete_many ' + shlex.quote(json.dumps(names))).stdout)
        self.assertTrue(result['ok'])
        rows = {row['name']: row for row in result['results']}
        self.assertEqual([row['name'] for row in result['results']], names)
        self.assertTrue(rows['a.txt']['ok'] and rows['.hidden']['ok'])
        self.assertFalse(rows['missing']['ok'] or rows['link']['ok'])
        self.assertEqual({p.name for p in self.inbox.iterdir()}, {'keep.txt', 'link'})
        self.assertEqual(outside.read_text(), 'outside')

    def test_batch_validates_whole_selection_before_any_mutation(self):
        (self.inbox / 'a.txt').write_text('keep')
        for names in (['a.txt', 'bad\tname'], ['a.txt'] * 33, [], 'not-an-array'):
            result = self.shell('cmd_file_delete_many ' + shlex.quote(json.dumps(names)), ok=False)
            self.assertNotEqual(result.returncode, 0, names)
        self.assertTrue((self.inbox / 'a.txt').exists())

    def test_delete_and_clear_reject_removed_directories(self):
        self.inbox.rmdir()
        result = self.shell('cmd_file_delete a.txt', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)['ok'])


if __name__ == '__main__':
    unittest.main()
