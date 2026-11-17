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
        receive = result.pop('receive')
        self.assertEqual(receive['mode'], 'unavailable')
        self.assertEqual(receive['pending'], [])
        self.assertTrue(receive['error'])
        return result


    def test_receive_dispatch_validates_and_forwards_identity(self):
        helper = self.base / 'bin/foxyfiles'
        helper.write_text('#!/bin/sh\nprintf "%s\\n" "$@" >"' + str(self.run / 'receive-args') + '"\n' + "echo '{\"ok\":true,\"received\":true,\"sourceDeleted\":true}'\n")
        helper.chmod(0o755)
        source = (self.scripts / 'foxytail.webapi.sh').read_text()
        with self.lib.open('a') as handle:
            handle.write(source[source.index('_webapi_dispatch()'):source.rindex('_webapi_dispatch "$@"')])
        result = self.shell("_webapi_dispatch file-receive 'photo.txt' self-1")
        self.assertTrue(json.loads(result.stdout)['sourceDeleted'])
        args = (self.run / 'receive-args').read_text().splitlines()
        self.assertEqual(args[0], 'receive')
        self.assertEqual(args[-4:], ['--name', 'photo.txt', '--self', 'self-1'])
        invalid = self.shell("_webapi_dispatch file-receive '../escape' self-1", ok=False)
        self.assertNotEqual(invalid.returncode, 0)
        extra = self.shell("_webapi_dispatch file-receive photo.txt self-1 extra", ok=False)
        self.assertNotEqual(extra.returncode, 0)


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


if __name__ == '__main__':
    unittest.main()
