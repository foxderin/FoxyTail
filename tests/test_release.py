"""Exercise the real packager with local synthetic release assets."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BINARIES = [f'{name}-{arch}' for name in ['tailscaled', 'jq', 'hev-socks5-tunnel'] for arch in ['arm', 'arm64']]
NATIVE_BINARIES = ['foxydns-arm', 'foxydns-arm64']
SPEC = importlib.util.spec_from_file_location('verified_artifact', ROOT / '.github/tools/verified-artifact.py')
verified_artifact = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verified_artifact)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for relative in ['.github/tools', 'native/foxydns', 'tailscale/scripts', 'tailscale/conf', 'META-INF', 'webroot', 'unwanted']:
            (self.root / relative).mkdir(parents=True)
        shutil.copy(ROOT / '.github/tools/build.sh', self.root / '.github/tools/build.sh')
        # Packaging tests intentionally mock compilation. The verification gate
        # separately tests/vets the real Go source and builds both static ELFs.
        (self.root / '.github/tools/build-native.sh').write_text('''#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1"
for arch in arm arm64; do
  printf 'source-built-foxydns-%s\\n' "$arch" >"$1/foxydns-$arch"
  chmod 0755 "$1/foxydns-$arch"
done
''')
        shutil.copy(ROOT / 'tailscale/VERSIONS', self.root / 'tailscale/VERSIONS')
        for relative in ['customize.sh', 'service.sh', 'uninstall.sh', 'update.json', 'LICENSE',
                         'tailscale/settings.sh', 'webroot/index.html',
                         'native/foxydns/THIRD_PARTY_NOTICES.txt',
                         'unwanted/private-data']:
            (self.root / relative).write_text('fixture\n')
        shutil.copytree(ROOT / 'tailscale/scripts', self.root / 'tailscale/scripts', dirs_exist_ok=True)
        (self.root / 'module.prop').write_text('version=v1.0.3\n')
        (self.root / 'binary-source').mkdir()
        (self.root / 'binary-source/tailscaled').write_bytes(b'local-test-binary\n')
        digest = hashlib.sha256(b'local-test-binary\n').hexdigest()
        self.manifest = ''.join(f'{digest}  {name}\n' for name in BINARIES)
        (self.root / 'tailscale/checksums.txt').write_text(self.manifest)
        assets = ['tailscale_mock_arm.tgz', 'tailscale_mock_arm64.tgz',
                  'jq-armv7a-linux-androideabi', 'jq-aarch64-linux-android',
                  'hev-socks5-tunnel-linux-arm32v7', 'hev-socks5-tunnel-linux-arm64']
        self.assets = json.dumps({'assets': [{'name': x, 'browser_download_url': f'https://example.invalid/{x}'} for x in assets]})

    def build(self, *args, timezone="UTC"):
        driver = r'''
curl() {
  if [ "$1" = -sf ]; then printf '%s\n' "$MOCK_ASSETS"; return; fi
  local dest=''
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -o ]; then shift; dest="$1"; break; fi
    shift
  done
  test -n "$dest" || return 1
  case "$dest" in
    *.tgz) tar -czf "$dest" -C "$MOCK_SOURCE" tailscaled ;;
    *) cp "$MOCK_SOURCE/tailscaled" "$dest" ;;
  esac
}
export -f curl
bash .github/tools/build.sh "$@"
'''
        env = os.environ.copy()
        env.update(MOCK_ASSETS=self.assets, MOCK_SOURCE=str(self.root / 'binary-source'), SOURCE_DATE_EPOCH='1700000000', TZ=timezone)
        return subprocess.run(['bash', '-c', driver, 'build-test', *args], cwd=self.root,
                              env=env, text=True, capture_output=True, timeout=30)

    def test_build_verifies_without_rewriting_and_allowlists_payload(self):
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / 'tailscale/checksums.txt').read_text(), self.manifest)
        import zipfile
        with zipfile.ZipFile(self.root / 'dist/FoxyTail-v1.0.3.zip') as archive:
            names = archive.namelist()
            for path in (ROOT / 'tailscale/scripts').iterdir():
                self.assertIn('tailscale/scripts/' + path.name, names)
            self.assertEqual(archive.read('THIRD_PARTY_NOTICES.txt'), b'fixture\n')
            self.assertFalse(any('unwanted' in x or '.github' in x or 'native/foxydns' in x for x in names))
            self.assertEqual(sorted(x for x in names if '/bin/' in x),
                             ['tailscale/bin/' + x for x in NATIVE_BINARIES])
            self.check_native_manifest(archive)
        with zipfile.ZipFile(self.root / 'dist/FoxyTail-v1.0.3-full.zip') as archive:
            self.assertEqual(archive.read('THIRD_PARTY_NOTICES.txt'), b'fixture\n')
            self.assertTrue(all('tailscale/bin/' + x in archive.namelist() for x in BINARIES + NATIVE_BINARIES))
            self.check_native_manifest(archive)
        self.assertFalse((self.root / 'tailscale/native-checksums.txt').exists())
        first_light = (self.root / 'dist/FoxyTail-v1.0.3.zip').read_bytes()
        first = (self.root / 'dist/FoxyTail-v1.0.3-full.zip').read_bytes()
        result = self.build(timezone="Asia/Shanghai")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(first_light, (self.root / 'dist/FoxyTail-v1.0.3.zip').read_bytes())
        self.assertEqual(first, (self.root / 'dist/FoxyTail-v1.0.3-full.zip').read_bytes())

    def check_native_manifest(self, archive):
        lines = archive.read('tailscale/native-checksums.txt').decode().splitlines()
        entries = [line.split() for line in lines if line and not line.startswith('#')]
        self.assertEqual([entry[1] for entry in entries], NATIVE_BINARIES)
        for digest, name in entries:
            self.assertEqual(hashlib.sha256(archive.read('tailscale/bin/' + name)).hexdigest(), digest)
        self.assertEqual(archive.read('tailscale/checksums.txt').decode(), self.manifest)

    def test_native_build_failure_never_creates_an_incomplete_package(self):
        (self.root / '.github/tools/build-native.sh').write_text('#!/bin/sh\nexit 42\n')
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(list((self.root / 'dist').glob('*.zip')))
        self.assertEqual((self.root / 'tailscale/checksums.txt').read_text(), self.manifest)

    def test_changed_asset_fails_before_packaging(self):
        (self.root / 'binary-source/tailscaled').write_bytes(b'changed-upstream-asset\n')
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(list((self.root / 'dist').glob('*.zip')))
        self.assertEqual((self.root / 'tailscale/checksums.txt').read_text(), self.manifest)

    def test_explicit_update_only_creates_review_candidate(self):
        result = self.build('--update-checksums')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / 'tailscale/checksums.txt.candidate').is_file())
        self.assertEqual((self.root / 'tailscale/checksums.txt').read_text(), self.manifest)
        self.assertFalse(list((self.root / 'dist').glob('*.zip')))


class NativeInstallerTests(unittest.TestCase):
    def test_native_helper_must_be_present_and_match_one_manifest_entry(self):
        source = (ROOT / 'customize.sh').read_text()
        function = source[source.index('verify_native_bin() {'):source.index('# install_bin <name>')]
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            (stage / 'root').mkdir()
            (stage / 'bin').mkdir()
            binary = stage / 'bin/foxydns-arm64'
            binary.write_bytes(b'first-party-helper')
            digest = hashlib.sha256(binary.read_bytes()).hexdigest()
            manifest = stage / 'root/native-checksums.txt'
            entry = f'{digest}  foxydns-arm64\n'
            for case in ['valid', 'changed', 'missing', 'duplicate', 'no-entry']:
                with self.subTest(case=case):
                    manifest.write_text(entry if case not in ['duplicate', 'no-entry']
                                        else entry * 2 if case == 'duplicate' else '# empty\n')
                    binary.write_bytes(b'changed' if case == 'changed' else b'first-party-helper')
                    if case == 'missing':
                        binary.unlink()
                    result = subprocess.run(['sh', '-c', function + '''
STAGE="$1"
abort() { echo "$*" >&2; exit 1; }
verify_native_bin foxydns-arm64
''', 'native-installer-test', directory], text=True, capture_output=True, timeout=10)
                    self.assertEqual(result.returncode == 0, case == 'valid', result.stdout + result.stderr)


class VerifiedArtifactTests(unittest.TestCase):
    sha = 'a' * 40
    repository = 'example/FoxyTail'

    def test_artifacts_require_a_successful_trusted_exact_source_run(self):
        run = {'id': 12, 'head_sha': self.sha, 'event': 'push', 'status': 'completed',
               'conclusion': 'success', 'path': '.github/workflows/shellcheck.yml',
               'head_repository': {'full_name': self.repository}}
        artifact = {'name': 'verified-' + self.sha, 'expired': False,
                    'workflow_run': {'id': 12, 'head_sha': self.sha}}
        cases = [
            (run, artifact, ('ready', '12')),
            ({**run, 'event': 'workflow_dispatch'}, artifact, ('ready', '12')),
            ({**run, 'event': 'pull_request'}, artifact, ('missing', '')),
            ({**run, 'head_sha': 'b' * 40}, artifact, ('missing', '')),
            ({**run, 'head_repository': {'full_name': 'someone/fork'}}, artifact, ('missing', '')),
            ({**run, 'path': '.github/workflows/other.yml'}, artifact, ('missing', '')),
            ({**run, 'conclusion': 'failure'}, artifact, ('failed', '12')),
            ({**run, 'status': 'in_progress'}, artifact, ('pending', '12')),
            (run, {**artifact, 'expired': True}, ('missing', '12')),
            (run, {**artifact, 'workflow_run': {'id': 12, 'head_sha': 'b' * 40}}, ('missing', '12')),
            (run, {**artifact, 'workflow_run': {'id': 99, 'head_sha': self.sha}}, ('missing', '12')),
        ]
        for candidate, asset, expected in cases:
            with self.subTest(candidate=candidate, asset=asset), patch.object(
                    verified_artifact, 'api', side_effect=[[{'workflow_runs': [candidate]}], [{'artifacts': [asset]}]]):
                self.assertEqual(verified_artifact.lookup(self.repository, self.sha), expected)
        # A newer failure must not fall back to an older successful package.
        with patch.object(verified_artifact, 'api', return_value=[{'workflow_runs': [
                {**run, 'id': 13, 'conclusion': 'failure'}, run]}]):
            self.assertEqual(verified_artifact.lookup(self.repository, self.sha), ('failed', '13'))
        with patch.object(verified_artifact, 'api', return_value=[{'workflow_runs': [run]}]):
            self.assertEqual(verified_artifact.lookup(self.repository, self.sha, exclude='12'), ('missing', ''))
        with patch.object(verified_artifact, 'api', side_effect=[
                [{'workflow_runs': [{**run, 'id': 14, 'status': 'queued'}, run]}],
                [{'artifacts': [artifact]}]]):
            self.assertEqual(verified_artifact.lookup(self.repository, self.sha, exclude='13'), ('ready', '12'))
        with patch.object(verified_artifact, 'api', side_effect=[
                [{'workflow_runs': [{**run, 'id': 13}, run]}],
                [{'artifacts': []}], [{'artifacts': [artifact]}]]):
            self.assertEqual(verified_artifact.lookup(self.repository, self.sha), ('ready', '12'))

    def test_release_waits_or_dispatches_once_and_never_bypasses_failed_gates(self):
        scenarios = [
            ([('ready', '12')], 0),
            ([('pending', '12'), ('ready', '12')], 0),
            ([('missing', ''), ('missing', ''), ('pending', '12'), ('ready', '12')], 1),
            ([('missing', '11'), ('pending', '12'), ('ready', '12')], 1),
        ]
        for states, dispatches in scenarios:
            with self.subTest(states=states), patch.object(verified_artifact, 'lookup', side_effect=states), \
                    patch.object(verified_artifact, 'api') as api, patch.object(verified_artifact.time, 'sleep'):
                self.assertEqual(verified_artifact.ensure(self.repository, self.sha, 'v1.3.1'), '12')
                self.assertEqual(api.call_count, dispatches)
                if dispatches:
                    self.assertEqual(api.call_args.kwargs, {'ref': 'v1.3.1'})
        for states in [[('failed', '12')], [('missing', ''), ('missing', '12')]]:
            with self.subTest(states=states), patch.object(verified_artifact, 'lookup', side_effect=states), \
                    patch.object(verified_artifact, 'api'), patch.object(verified_artifact.time, 'sleep'):
                with self.assertRaises(RuntimeError):
                    verified_artifact.ensure(self.repository, self.sha, 'v1.3.1')
        with self.assertRaisesRegex(RuntimeError, 'within 0 seconds'):
            verified_artifact.ensure(self.repository, self.sha, 'v1.3.1', timeout=0)

    def test_downloaded_packages_must_match_checksums_and_tag(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for version, changed, duplicate in [('v1.3.1', False, False), ('v1.3.0', False, False),
                                                ('v1.3.1', True, False), ('v1.3.1', False, True)]:
                checksums = []
                for suffix in ('', '-full'):
                    path = directory / ('FoxyTail-v1.3.1' + suffix + '.zip')
                    with zipfile.ZipFile(path, 'w') as archive:
                        archive.writestr('module.prop', 'version=' + version + '\n')
                    checksums.append(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name)
                if changed:
                    path.write_bytes(b'changed after upload')
                (directory / 'SHA256SUMS').write_text('\n'.join(checksums + checksums[:int(duplicate)]) + '\n')
                if version == 'v1.3.1' and not changed and not duplicate:
                    verified_artifact.check_packages(directory, 'v1.3.1')
                else:
                    with self.assertRaises(ValueError):
                        verified_artifact.check_packages(directory, 'v1.3.1')


if __name__ == '__main__':
    unittest.main()
