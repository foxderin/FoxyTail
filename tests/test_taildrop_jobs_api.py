"""Native-backed file API boundaries, including binary stdin without exec arguments."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import unittest

from api_fixture import ApiTestCase


class TaildropJobsApiTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        if not os.environ.get('FOXYFILES_TEST_BINARY'):
            self.fail('FOXYFILES_TEST_BINARY is required; run the verifier or build native/foxyfiles')

    def stage(self, name, payload, size=None):
        script = '. "$1"\ncmd_file_stage ' + shlex.quote(name) + ' ' + str(len(payload) if size is None else size)
        result = subprocess.run(['sh', '-c', script, 'test', str(self.lib)], input=payload,
                                capture_output=True, timeout=20)
        return result, json.loads(result.stdout)

    def test_binary_stage_exact_bytes_and_private_cleanup(self):
        for payload in (b'', bytes(range(256)) * 4096):
            with self.subTest(size=len(payload)):
                result, item = self.stage("meeting ' ; $().bin", payload)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(item['ok'])
                staged = Path(item['path'])
                self.assertTrue(staged.is_relative_to(self.base / 'files/.outgoing'))
                self.assertEqual(staged.read_bytes(), payload)
                self.assertEqual(item['size'], len(payload))
                self.assertEqual(staged.stat().st_mode & 0o777, 0o600)
                self.assertTrue(json.loads(self.shell('cmd_file_stage_delete ' + shlex.quote(str(staged))).stdout)['ok'])
                self.assertFalse(staged.exists())

    def test_stage_rejects_size_mismatch_and_unsafe_name_without_publication(self):
        for name, payload, expected in [('short.txt', b'ab', 3), ('long.txt', b'abc', 2),
                                         ('../escape', b'x', 1), ('line\nbreak', b'x', 1)]:
            with self.subTest(name=name):
                result, item = self.stage(name, payload, expected)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(item['ok'])
                self.assertFalse(any(path.is_file() for path in (self.base / 'files/.outgoing').glob('*/*')))
        self.assertFalse((self.base / 'escape').exists())

    def test_inbox_stream_has_no_json_wrapper_or_size_cap(self):
        inbox = self.base / 'files'
        inbox.mkdir()
        payload = bytes(range(256)) * 40000
        (inbox / 'large.bin').write_bytes(payload)
        result = subprocess.run(['sh', '-c', '. "$1"\ncmd_file_read large.bin', 'test', str(self.lib)],
                                capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, payload)
        for name in ('../settings.sh', '.outgoing', '.taildrop'):
            result = self.shell('cmd_file_read ' + shlex.quote(name), ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')

    def test_browse_and_stage_delete_never_escape_owned_roots(self):
        source = self.sdcard / 'Download'
        (source / 'folder').mkdir()
        (source / 'file.txt').write_text('payload')
        (source / 'secret-link').symlink_to(self.base / 'settings.sh')
        (source / 'escape').symlink_to(self.base, target_is_directory=True)
        data = json.loads(self.shell('cmd_files_browse Download').stdout)
        self.assertEqual({entry['name'] for entry in data['entries']}, {'folder', 'file.txt'})
        for relative in ('../', '/data/adb', 'Download/escape'):
            result = self.shell('cmd_files_browse ' + shlex.quote(relative), ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(json.loads(result.stdout)['ok'])
        original = (source / 'file.txt').read_bytes()
        result = self.shell('cmd_file_stage_delete ' + shlex.quote(str(source / 'file.txt')), ok=False)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertEqual((source / 'file.txt').read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
