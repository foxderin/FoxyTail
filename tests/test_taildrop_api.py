"""Taildrop regressions using the real WebAPI shell and private shared storage."""
import base64
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

    def download(self, name, prefix='', ok=True):
        return self.shell(prefix + '\ncmd_file_download ' + shlex.quote(name), ok=ok)

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
        self.assertEqual(result, {'ok': True, 'received': 1, 'exported': 1})
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
        for command in ('cmd_file_download', 'cmd_file_delete', 'cmd_file_export'):
            for name in ('.taildrop', '.taildrop/receipt', 'link'):
                result = self.shell(command + ' ' + shlex.quote(name), ok=False)
                self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(self.shell('cmd_files_inbox').stdout)['files'], [])
        self.assertEqual(json.loads(self.shell('cmd_file_clear').stdout)['removed'], 0)
        self.assertEqual((receipts / 'receipt').read_text(), 'private')
        self.assertEqual(outside.read_text(), 'secret')

    def test_send_uses_peer_id_and_exact_current_address_not_hostname(self):
        target = self.sdcard / 'hello.txt'
        target.write_text('payload')
        status = {'Peer': {
            'a': {'ID': 'node-a', 'HostName': 'duplicate', 'TailscaleIPs': ['100.96.0.31']},
            'b': {'ID': 'node-b', 'HostName': 'duplicate', 'TailscaleIPs': ['fd7a:115c:a1e0::2']}}}
        prefix = 'ts_status_json() { printf %s ' + shlex.quote(json.dumps(status)) + '; }\n'
        prefix += 'ts_cli() { printf "%s\\n" "$@" >"$TS_RUN_DIR/send-calls"; }\n'
        for peer, address, destination in [('node-a', '100.96.0.31', '100.96.0.31:'),
                                            ('node-b', 'fd7a:115c:a1e0::2', '[fd7a:115c:a1e0::2]:')]:
            result = self.shell(prefix + 'cmd_file_send ' + shlex.quote(str(target)) + ' ' + peer + ' ' + address)
            self.assertTrue(json.loads(result.stdout)['ok'])
            self.assertEqual((self.run / 'send-calls').read_text().splitlines(),
                             ['300', 'file', 'cp', str(target), destination])
        (self.run / 'send-calls').unlink()
        for peer, address in [('duplicate', '100.96.0.31'), ('node-a', 'fd7a:115c:a1e0::2'),
                              ('node-b', '100.96.0.99'), ('bad;rm -rf /', '100.96.0.31')]:
            result = self.shell(prefix + 'cmd_file_send ' + shlex.quote(str(target)) + ' ' + shlex.quote(peer) + ' ' + address, ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.run / 'send-calls').exists())

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

    def test_download_empty_binary_large_and_inclusive_cap(self):
        for size in (0, 257, 100 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024):
            with self.subTest(size=size):
                payload = (bytes(range(256)) * ((size + 255) // 256))[:size]
                name = 'binary data.bin'
                (self.inbox / name).write_bytes(payload)
                # Android mksh may resolve printf to toybox, not a builtin.
                result = json.loads(self.download(name, 'printf() { /usr/bin/printf "$@"; }\n').stdout)
                self.assertEqual(set(result), {'ok', 'name', 'size', 'data'})
                self.assertTrue(result['ok'])
                self.assertEqual(result['name'], name)
                self.assertEqual(result['size'], size)
                self.assertEqual(base64.b64decode(result['data'], validate=True), payload)
                self.assertEqual({p.name for p in self.inbox.iterdir()}, {name})
                self.assertEqual({p.name for p in self.run.iterdir()}, {'pids'})
                self.assertEqual(list(self.downloads.iterdir()), [])

    def test_download_rejects_oversize_before_encoding(self):
        with (self.inbox / 'too-large.bin').open('wb') as file:
            file.truncate(8 * 1024 * 1024 + 1)
        result = self.download('too-large.bin', '''base64() {
  : >"$TS_RUN_DIR/unexpected-encoding"
  return 1
}
''', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertIn('too large', json.loads(result.stdout)['error'])
        self.assertFalse((self.run / 'unexpected-encoding').exists())
        self.assertEqual((self.inbox / 'too-large.bin').stat().st_size, 8 * 1024 * 1024 + 1)

    def test_download_reports_encoding_and_size_errors_without_success_payload(self):
        (self.inbox / 'data.bin').write_bytes(b'\x00\xffbinary')
        for prefix in ("base64() { printf cGFydGlhbA==; return 1; }",
                       "stat() { return 1; }", "stat() { printf invalid; }"):
            with self.subTest(prefix=prefix):
                result = self.download('data.bin', prefix, ok=False)
                self.assertNotEqual(result.returncode, 0)
                data = json.loads(result.stdout)
                self.assertFalse(data['ok'])
                self.assertNotIn('data', data)
                self.assertEqual((self.inbox / 'data.bin').read_bytes(), b'\x00\xffbinary')
                self.assertEqual({p.name for p in self.run.iterdir()}, {'pids'})


if __name__ == '__main__':
    unittest.main()
