"""Read-only health summaries and real diagnostic archives in private paths."""
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
import unittest

from api_fixture import ApiTestCase, ROOT


class DiagnosticsTests(ApiTestCase):
    def test_summary_distinguishes_stopped_unknown_and_failed_components(self):
        for backend, daemon, mode, dns, expected in [
            ('-', 'stopped', 'bridge', '{}', {'service': 'warn', 'routes': 'skip', 'dns': 'fail'}),
            ('unreachable', 'running', 'bridge', '{}', {'service': 'fail', 'routes': 'skip', 'dns': 'fail'}),
            ('Running', 'running', 'bridge', '{"state":"running","reason":"dns-interception-conflict"}',
             {'service': 'pass', 'routes': 'fail', 'dns': 'warn'}),
            ('Running', 'running', 'proxy', '{"state":"running","reason":"local","mode":"local","enabled":true,"listenerReady":true,"policyState":"owned","repairNeeded":false}',
             {'service': 'pass', 'routes': 'skip', 'dns': 'pass'}),
            ('Running', 'running', 'proxy', '{"state":"running","mode":"local","enabled":true,"listenerReady":false,"repairNeeded":true,"policyState":"unknown"}',
             {'service': 'pass', 'routes': 'skip', 'dns': 'fail'}),
        ]:
            with self.subTest(backend=backend, mode=mode):
                result = self.shell('''
load_runtime_conf() { TS_MODE=''' + mode + '''; MAGIC_DNS=on; DNS_MODE=local; }
cmd_status() { printf '%s' ''' + shlex.quote(json.dumps({'backend': backend, 'daemon': daemon})) + '''; }
ip() { return 1; }
_op_exec() {
  case "$2" in */foxytail.dns) printf '%s' ''' + shlex.quote(dns) + ''' ;; *) return 1 ;; esac
}
cmd_diag_check''')
                rows = {row['id']: row for row in json.loads(result.stdout)['checks']}
                for key, level in expected.items():
                    self.assertEqual(rows[key]['level'], level)
        result = self.shell('load_runtime_conf() { return 1; }; cmd_diag_check')
        self.assertEqual(json.loads(result.stdout)['checks'][0]['reason'], 'invalid_config')
        self.assertFalse((self.run / 'settings.pending').exists(), 'read-only check wrote pending state')

    def test_shared_archive_anonymizes_consistently_and_keeps_local_mode_explicit(self):
        bin_dir = self.base / 'bin'
        bin_dir.mkdir(exist_ok=True)
        status = {
            'BackendState': 'Running',
            'MagicDNSSuffix': 'private-tailnet.ts.net',
            'Self': {'HostName': 'my-phone', 'DNSName': 'my-phone.secret.ts.net', 'UserID': 1234567,
                     'TailscaleIPs': ['100.80.90.10', 'fd7a:115c:a1e0::1234']},
            'User': {'1234567': {'ID': 1234567, 'LoginName': 'owner@example.org', 'DisplayName': 'Private Owner'}},
            'Peer': {},
        }
        for name, body in {
            'tailscale': 'case "$2" in status) printf %s ' + shlex.quote(json.dumps(status)) + ' ;; *) echo "100.80.90.10 fd7a:115c:a1e0::1234" ;; esac',
            'ip': 'echo "100.80.90.10 fd7a:115c:a1e0::1234"',
            'iptables': ':', 'ip6tables': ':', 'getprop': ':',
        }.items():
            path = bin_dir / name
            path.write_text('#!/bin/sh\n' + body + '\n')
            path.chmod(0o755)
        (self.base / 'modules').mkdir()
        source = (ROOT / 'tailscale/scripts/foxytail.diag').read_text().replace(
            '/data/adb/modules', str(self.base / 'modules'))
        helper = self.scripts / 'foxytail.diag'
        helper.write_text(source)
        (self.conf / 'context.conf').write_text('ssid:Private WiFi:down\ncellular:-:exit-node:personal-gateway.example.ts.net\n')
        (self.conf / 'unrelated.secret').write_text('must-not-be-packaged')
        (self.run / 'tailscaled.log').write_text(
            '12:34:56 my-phone owner@example.org Private Owner Private WiFi 100.80.90.10 '
            "fd7a:115c:a1e0::1234 tskey-auth-supersecret https://headscale.example.org/register/token\n"
            "context: 'ssid:Old Private WiFi' -> 'ssid:Private WiFi'\n")

        def collect(mode):
            out = self.base / ('out-' + mode)
            result = subprocess.run(['sh', str(helper), 'collect', str(out), mode],
                                    text=True, capture_output=True, timeout=15,
                                    env={**os.environ, 'COPYFILE_DISABLE': '1'})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            with tarfile.open(result.stdout.strip().splitlines()[-1]) as archive:
                return {member.name.split('/', 1)[1]: archive.extractfile(member).read().decode()
                        for member in archive.getmembers() if member.isfile()}

        shared = collect('share')
        all_text = '\n'.join(shared.values())
        for secret in ['my-phone', 'owner@example.org', 'Private Owner', 'Private WiFi',
                       '100.80.90.10', 'fd7a:115c:a1e0::1234', 'tskey-auth-supersecret',
                       'headscale.example.org', 'must-not-be-packaged', '1234567', 'Old Private WiFi',
                       'private-tailnet.ts.net', 'personal-gateway.example.ts.net']:
            self.assertNotIn(secret, all_text)
        self.assertIn('12:34:56', shared['tailscaled.log.tail'])
        anonymized = json.loads(shared['status.json'])
        for alias in [anonymized['Self']['HostName'], *anonymized['Self']['TailscaleIPs']]:
            self.assertRegex(alias, r'^\[anon-\d+\]$')
            self.assertIn(alias, shared['tailscaled.log.tail'])
        self.assertEqual(shared['diagnostic-mode.txt'], 'mode=share\n')
        self.assertFalse(list(self.run.glob('diag-*')), 'private redaction inputs survived')
        helper.chmod(0o755)
        result = self.shell('export COPYFILE_DISABLE=1\n_op_exec() { shift; case "$1" in */foxytail.diag) shift; sh ' +
                            shlex.quote(str(helper)) + ' "$@" ;; *) "$@" ;; esac; }\ncmd_diag')
        exported = json.loads(result.stdout)
        self.assertEqual(exported['mode'], 'share', 'sharing must default to redaction')
        self.assertRegex(exported['artifactId'], r'^art-[a-f0-9]{32}$')
        binary = subprocess.run(['sh', '-c', '. "$1"\ncmd_artifact_read "$2"', 'test',
                                 str(self.lib), exported['artifactId']], capture_output=True, timeout=15)
        self.assertEqual(binary.returncode, 0, binary.stderr)
        self.assertEqual(binary.stdout, Path(exported['path']).read_bytes())
        with tarfile.open(fileobj=io.BytesIO(binary.stdout), mode='r:gz') as archive:
            exported_text = '\n'.join(archive.extractfile(member).read().decode()
                                      for member in archive.getmembers() if member.isfile())
        self.assertNotIn('owner@example.org', exported_text)
        self.assertNotIn('tskey-auth-supersecret', exported_text)
        self.assertIn('mode=share', exported_text)
        local = collect('local')
        self.assertIn('owner@example.org', local['status.json'])
        self.assertEqual(local['diagnostic-mode.txt'], 'mode=local\n')
        # Cancel at the publication boundary, after the archive has been renamed.
        mv = bin_dir / 'mv'
        mv.write_text('#!/bin/sh\n/bin/mv "$@" || exit 1\ncase "$2" in *.tar.gz) kill -TERM "$PPID" ;; esac\n')
        mv.chmod(0o755)
        cancelled = self.base / 'out-cancelled'
        result = subprocess.run(['sh', str(helper), 'collect', str(cancelled), 'share'],
                                capture_output=True, text=True, timeout=15,
                                env={**os.environ, 'COPYFILE_DISABLE': '1'})
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(list(cancelled.glob('*.tar.gz*')), 'cancelled final archive survived publication')

    def test_local_bundle_never_defaults_to_shared_storage(self):
        helper = self.scripts / 'foxytail.diag'
        helper.write_text((ROOT / 'tailscale/scripts/foxytail.diag').read_text().replace(
            '/data/adb/modules', str(self.base / 'modules')))
        (self.base / 'modules').mkdir(exist_ok=True)
        result = subprocess.run(['sh', str(helper), 'collect', '', 'local'],
                                capture_output=True, text=True, timeout=15,
                                env={**os.environ, 'COPYFILE_DISABLE': '1'})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        path = Path(result.stdout.strip().splitlines()[-1])
        self.assertEqual(path.parent, self.base / 'diag')
        self.assertTrue(path.is_file())
        with tarfile.open(path) as archive:
            self.assertIn('diagnostic-mode.txt',
                          [member.name.split('/', 1)[1] for member in archive.getmembers()
                           if member.isfile()])
        # The default directory is pruned to the newest two bundles; an
        # explicit destination keeps every run.
        for _ in range(2):
            subprocess.run(['sh', str(helper), 'collect', '', 'local'],
                           capture_output=True, text=True, timeout=15,
                           env={**os.environ, 'COPYFILE_DISABLE': '1'})
        self.assertEqual(len(list((self.base / 'diag').glob('foxytail-diag-*.tar.gz'))), 2)
        explicit = self.base / 'explicit'
        for _ in range(3):
            subprocess.run(['sh', str(helper), 'collect', str(explicit), 'local'],
                           capture_output=True, text=True, timeout=15,
                           env={**os.environ, 'COPYFILE_DISABLE': '1'})
        self.assertEqual(len(list(explicit.glob('foxytail-diag-*.tar.gz'))), 3)


if __name__ == '__main__':
    unittest.main()
