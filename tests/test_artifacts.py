"""Real stdin artifact transport and unchanged transactional restore invariants."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess

from api_fixture import ApiTestCase


class ArtifactApiTests(ApiTestCase):
    def binary_shell(self, script, data=b'', ok=True):
        result = subprocess.run(
            ['sh', '-c', '. "$1"\n' + script, 'test', str(self.lib)],
            input=data, capture_output=True, timeout=20)
        if ok:
            self.assertEqual(result.returncode, 0, (result.stderr + result.stdout).decode(errors='replace'))
        return result

    def stage(self, archive, name='imported.tar.gz', length=None):
        data = archive.read_bytes()
        result = self.binary_shell('cmd_artifact_stage ' + shlex.quote(name) + ' ' +
                                   str(len(data) if length is None else length), data)
        value = json.loads(result.stdout)
        self.assertRegex(value['id'], r'^art-[a-f0-9]{32}$')
        self.assertEqual(value['size'], len(data))
        return value['id']

    def test_real_stdin_preview_restore_export_preserves_original_and_identity(self):
        source = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n',
                               'foxytail.tun.up': '#!/system/bin/sh\necho never-run\n'})
        data = source.read_bytes()
        identity = self.base / 'tailscaled.state'
        identity.write_bytes(b'account-identity-must-survive')
        token = self.stage(source)
        preview = json.loads(self.shell('cmd_restore_preview ' + token).stdout)
        self.assertEqual(preview['path'], token)
        self.assertEqual(preview['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(preview['hooks'], ['foxytail.tun.up'])
        result = json.loads(self.shell('cmd_restore ' + token + ' ' + preview['sha256'] + ' ' + preview['baselineSha256']).stdout)
        self.assertTrue(result['saved'])
        self.assertFalse(result['applied'])
        self.assertEqual((self.conf / 'foxytail.conf').read_text(), 'SOCKS_PORT=1200\n')
        self.assertEqual(identity.read_bytes(), b'account-identity-must-survive')
        self.assertEqual(source.read_bytes(), data)
        exported = self.binary_shell('cmd_artifact_read ' + token)
        self.assertEqual(exported.stdout, data, 'binary stdout must contain no JSON envelope')
        parked = list(self.base.glob('restored-hooks-*/foxytail.tun.up.restored'))
        self.assertEqual(len(parked), 1)
        self.assertEqual(parked[0].stat().st_mode & 0o111, 0)
        self.assertFalse((self.scripts / 'foxytail.tun.up').exists())
        self.assertTrue(json.loads(self.shell('cmd_artifact_delete ' + token).stdout)['ok'])
        missing = self.binary_shell('cmd_artifact_read ' + token, ok=False)
        self.assertNotEqual(missing.returncode, 0)
        self.assertEqual(missing.stdout, b'')
        self.assertEqual(source.read_bytes(), data)

    def test_token_hash_and_baseline_mismatch_reject_before_writes(self):
        source = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n'})
        token = self.stage(source)
        preview = json.loads(self.shell('cmd_restore_preview ' + token).stdout)
        before = self.snapshot()
        failed = self.shell('cmd_restore ' + token + ' ' + '0' * 64 + ' ' + preview['baselineSha256'], ok=False)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn('changed after preview', json.loads(failed.stdout)['error'])
        self.assertEqual(self.snapshot(), before)
        (self.conf / 'foxytail.conf').write_text('SOCKS_PORT=1234\n')
        before = self.snapshot()
        failed = self.shell('cmd_restore ' + token + ' ' + preview['sha256'] + ' ' + preview['baselineSha256'], ok=False)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn('saved configuration changed', json.loads(failed.stdout)['error'])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.binary_shell('cmd_artifact_read ' + token).stdout, source.read_bytes())

    def test_restore_lease_blocks_delete_and_expiry_until_shell_exits(self):
        source = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n'})
        token = self.stage(source)
        marker = self.base / 'delete-result'
        token_dir = self.base / '.artifacts' / token
        # _restore_stage owns the same lifetime and descriptor as preview/restore.
        result = self.shell('_restore_stage ' + token + '\n' +
                            '(cmd_artifact_delete ' + token + ') >' + shlex.quote(str(marker)) +
                            ' && exit 99\n' +
                            '"$TS_BIN_DIR/foxyfiles" artifact-read --root "$TS_DIR" --id ' + token + ' >/dev/null')
        self.assertEqual(result.returncode, 0)
        self.assertFalse(json.loads(marker.read_text())['ok'])
        self.assertTrue((token_dir / 'import.tar.gz').is_file())
        old = 1
        os.utime(token_dir, (old, old))
        expired = self.binary_shell('cmd_artifact_read ' + token, ok=False)
        self.assertNotEqual(expired.returncode, 0)
        self.assertEqual(expired.stdout, b'')
        self.assertFalse(token_dir.exists())
        self.assertTrue(source.exists())

    def test_mksh_restore_pin_explicitly_inherits_cloexec_descriptor(self):
        mksh = os.environ.get('FOXYTAIL_TEST_MKSH') or shutil.which('mksh')
        if not mksh:
            self.skipTest('mksh required to exercise Android CLOEXEC descriptor semantics')
        source = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n'})
        token = self.stage(source)
        # Run the actual shell restore path: mksh gives persistent `exec 8<`
        # descriptors CLOEXEC, unlike dash/bash. Pin must explicitly inherit 8.
        result = subprocess.run([mksh, '-c', '. "$1"\n_restore_stage "$2"\n'
                                 '(cmd_artifact_delete "$2") && exit 99\n'
                                 '"$TS_BIN_DIR/foxyfiles" artifact-read --root "$TS_DIR" --id "$2" >/dev/null',
                                 'test', str(self.lib), token],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('restore lease does not match artifact', result.stderr)
        self.assertFalse(json.loads(result.stdout)['ok'], 'live restore lease did not reject deletion')
        self.assertEqual(self.binary_shell('cmd_artifact_read ' + token).stdout, source.read_bytes())
        self.assertTrue(json.loads(self.shell('cmd_artifact_delete ' + token).stdout)['ok'],
                        'restore lease leaked after mksh exited')

    def test_rejects_unsafe_names_tokens_sizes_and_symlink_without_output(self):
        for name, size, data in [('../bad.tar.gz', 1, b'x'), ('bad.sh', 1, b'x'),
                                 ('ok.tar.gz', 1, b'xx'), ('ok.tar.gz', 2, b'x'),
                                 ('ok.tar.gz', -1, b'x' * ((1 << 20) + 1))]:
            result = self.binary_shell('cmd_artifact_stage ' + shlex.quote(name) + ' ' + str(size), data, ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(json.loads(result.stdout)['ok'])
        for token in ('/etc/passwd', '../x', 'art-' + 'A' * 32):
            result = self.binary_shell('cmd_artifact_read ' + shlex.quote(token), ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b'')
        source = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n'})
        token = self.stage(source, length=-1)
        private = self.base / '.artifacts' / token / 'import.tar.gz'
        private.unlink()
        private.symlink_to(source)
        result = self.binary_shell('cmd_artifact_read ' + token, ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'')
        before = source.read_bytes()
        result = self.shell('cmd_restore_preview ' + token, ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(source.read_bytes(), before)

    def test_token_restore_rejects_archive_links_without_mutating_source(self):
        source = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n',
                               'conf/link': (str(self.base / 'outside'),)})
        original = source.read_bytes()
        token = self.stage(source)
        before = self.snapshot()
        result = self.shell('cmd_restore_preview ' + token, ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.base / 'outside').exists())
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(self.binary_shell('cmd_artifact_read ' + token).stdout, original)

    def test_backup_export_token_contains_only_allowlisted_configuration(self):
        (self.base / 'tailscaled.state').write_bytes(b'private-account')
        (self.conf / 'not-backed-up.secret').write_bytes(b'private-secret')
        result = json.loads(self.shell('export COPYFILE_DISABLE=1\ncmd_backup').stdout)
        self.assertRegex(result['artifactId'], r'^art-[a-f0-9]{32}$')
        original = Path(result['path']).read_bytes()
        self.assertEqual(self.binary_shell('cmd_artifact_read ' + result['artifactId']).stdout, original)
        import io
        import tarfile
        with tarfile.open(fileobj=io.BytesIO(original), mode='r:gz') as archive:
            self.assertTrue(all(member.name in ('conf', 'conf/', 'conf/foxytail.conf', 'conf/routes.conf',
                                                'conf/context.conf', 'foxytail.tun.up', 'foxytail.tun.down')
                                for member in archive.getmembers()))
