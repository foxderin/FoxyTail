"""Hardening regressions across the WebAPI dispatch and helper functions."""
import hashlib
import json
import os
import shlex
import subprocess
import sys
import unittest

from api_fixture import ApiTestCase, ROOT
from runtime_fixture import host_process_shell


class WebapiHardeningTests(ApiTestCase):
    def script(self, name, body):
        path = self.base / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!/bin/sh\n' + body)
        path.chmod(0o755)
        return path

    def entry_fixture(self):
        source = (ROOT / 'tailscale/scripts/foxytail.webapi.sh').read_text()
        source = source.replace('# --- dispatch', host_process_shell() + '\n# --- dispatch', 1)
        self.api = self.script('scripts/foxytail.webapi.sh', source.replace(
            '/sdcard', str(self.sdcard)).replace('#!/system/bin/sh\n', '', 1))
        for path in self.scripts.glob('foxytail.webapi-*.sh'):
            path.write_text(path.read_text()
                .replace('then "${TS_SCRIPTS_DIR}/start.sh"', 'then sh "${TS_SCRIPTS_DIR}/start.sh"')
                .replace('else "${TS_SCRIPTS_DIR}/foxytail.service"', 'else sh "${TS_SCRIPTS_DIR}/foxytail.service"'))
        with (self.base / 'settings.sh').open('a') as settings:
            settings.write('\ndetach_from_app_cgroup() { :; }\n')
        self.env = dict(os.environ, TEST_DIR=str(self.base), TEST_PYTHON=sys.executable)

    def entry(self, *args, ok=True):
        result = subprocess.run(['sh', str(self.api), *args], env=self.env,
                                capture_output=True, text=True, timeout=15)
        data = json.loads(result.stdout)
        self.assertEqual(data['ok'], ok, result.stdout + result.stderr)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        return data

    def test_backup_is_gated_while_an_upgrade_is_in_progress(self):
        self.entry_fixture()
        (self.base / '.installing').touch()
        self.assertIn('upgrade', self.entry('backup', ok=False)['error'])
        # Reads and already-permitted stop paths are unaffected by the gate.
        self.assertEqual(self.entry('backup-list'), {'ok': True, 'backups': []})

    def test_single_file_ops_survive_broken_configuration_like_batch_forms(self):
        self.entry_fixture()
        inbox = self.sdcard / 'Download' / 'Taildrop'
        inbox.mkdir()
        (inbox / 'a.txt').write_text('alpha')
        (inbox / 'b.txt').write_text('beta')
        (self.conf / 'foxytail.conf').write_text('TS_MODE=invalid\n')
        # The single-name inbox operations must degrade exactly like their
        # batch equivalents: their own validation still applies, and only a
        # handler-level failure may reject the request.
        self.assertEqual(self.entry('file-delete', 'a.txt'), {'ok': True})
        self.assertIn('invalid name', self.entry('file-delete', '../escape', ok=False)['error'])
        self.assertEqual(self.entry('file-clear'), {'ok': True, 'removed': 1})
        # Proof the configuration really is broken: gated commands still fail.
        self.assertIn('invalid configuration', self.entry('settings-get', ok=False)['error'])
        # The upgrade gate still covers the same commands independently.
        (self.base / '.installing').touch()
        self.assertIn('upgrade', self.entry('file-delete', 'b.txt', ok=False)['error'])

    def test_format_character_names_are_rejected_like_other_spoofed_names(self):
        inbox = self.sdcard / 'Download' / 'Taildrop'
        inbox.mkdir()
        marks = ['\u061c', '\u200b', '\u200e', '\u200f', '\ufeff']
        marks += [chr(codepoint) for codepoint in range(0x202a, 0x202f)]  # U+202A..U+202E
        marks += [chr(codepoint) for codepoint in range(0x2060, 0x2065)]  # U+2060..U+2064
        self.assertEqual(len(marks), 15)
        for mark in marks:
            name = 'evil' + mark + '.txt'
            (inbox / name).write_text('spoofed')
            for command in ('cmd_file_delete', 'cmd_file_read'):
                with self.subTest(command=command, codepoint=f'U+{ord(mark):04X}'):
                    result = self.shell(command + ' ' + shlex.quote(name), ok=False)
                    self.assertNotEqual(result.returncode, 0)
                    if command == 'cmd_file_read':
                        self.assertEqual(result.stdout, '')
                    else:
                        self.assertFalse(json.loads(result.stdout)['ok'])
            with self.subTest(command='cmd_file_delete_many', codepoint=f'U+{ord(mark):04X}'):
                result = self.shell('cmd_file_delete_many ' + shlex.quote(json.dumps([name])), ok=False)
                self.assertNotEqual(result.returncode, 0)
            self.assertTrue((inbox / name).exists(), name)
            (inbox / name).unlink()
        # A clear sees the same names as unsupported entries, never deletes them.
        for mark in marks[:3]:
            (inbox / ('x' + mark + '.txt')).write_text('keep')
        (inbox / 'ordinary.txt').write_text('remove')
        result = json.loads(self.shell('cmd_file_clear').stdout)
        self.assertEqual(result, {'ok': True, 'removed': 1, 'ignored': 3})
        self.assertEqual(sorted(p.name for p in inbox.iterdir()), sorted('x' + m + '.txt' for m in marks[:3]))

    def test_option_lookalike_arguments_are_rejected_before_helper_invocation(self):
        for command in ('cmd_switch -x', 'cmd_switch --profile',
                        'cmd_file_send_delete -abc', 'cmd_file_stage_delete --path=/tmp/x'):
            with self.subTest(command=command):
                result = self.shell(command, ok=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(json.loads(result.stdout)['ok'])

    def test_second_login_reports_busy_instead_of_starting_a_concurrent_cli(self):
        result = self.shell('''
_lock_identity || exit 9
ln -s "$_LOCK_TOKEN" "$TS_RUN_DIR/.login-lock" || exit 8
daemon_up() { return 1; }
tailscale() { echo 'unexpected login cli' >&2; return 99; }
cmd_login
''', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('another login is in progress', json.loads(result.stdout)['error'])

    def test_traffic_preserves_a_helper_failure_verdict(self):
        stats = self.scripts / 'foxytail.stats'
        stats.write_text('#!/bin/sh\necho \'{"ok":false,"error":"collector-broken"}\'\n')
        stats.chmod(0o755)
        result = json.loads(self.shell('_op_exec() { shift; "$@"; }; cmd_traffic daily').stdout)
        self.assertEqual(result, {'ok': False, 'error': 'collector-broken'})
        stats.write_text('#!/bin/sh\necho \'{"days":[]}\'\n')
        result = json.loads(self.shell('_op_exec() { shift; "$@"; }; cmd_traffic daily').stdout)
        self.assertEqual(result, {'ok': True, 'days': []})
        stats.write_text('#!/bin/sh\necho \'{"ok":false,"error":"uid-cache-broken"}\'\n')
        result = json.loads(self.shell('_op_exec() { shift; "$@"; }; cmd_traffic_uids').stdout)
        self.assertEqual(result, {'ok': False, 'error': 'uid-cache-broken'})

    def test_restore_stage_extracts_the_validated_resolved_path(self):
        # TS_DIR is not exported to helper children, so bake the capture path in.
        helper = self.script('bin/foxyfiles',
            'printf \'%s\\n\' "$@" >' + shlex.quote(str(self.base / 'helper-args')) +
            '\necho not-a-digest\n')
        target_dir = self.sdcard / 'dir'
        target_dir.mkdir()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n'})
        archive.replace(target_dir / 'a.tar.gz')
        alias = self.sdcard / 'alias'
        alias.symlink_to(target_dir, target_is_directory=True)
        result = self.shell('_restore_stage ' + shlex.quote(str(alias / 'a.tar.gz')), ok=False)
        self.assertNotEqual(result.returncode, 0)
        args = (self.base / 'helper-args').read_text().splitlines()
        self.assertEqual(args[0], 'extract')
        # The resolved path must be extracted, never the submitted alias.
        self.assertEqual(args[1], str(target_dir / 'a.tar.gz'))


if __name__ == '__main__':
    unittest.main()
