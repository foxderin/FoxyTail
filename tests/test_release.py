"""Exercise the real packager with local synthetic release assets."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BINARIES = [f'{name}-{arch}' for name in ['tailscaled', 'jq', 'hev-socks5-tunnel'] for arch in ['arm', 'arm64']]
NATIVE_BINARIES = [f'{name}-{arch}' for name in ['foxydns', 'foxyfiles'] for arch in ['arm', 'arm64']]


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
for helper in foxydns foxyfiles; do
  for arch in arm arm64; do
    [ "${OMIT_NATIVE:-}" != "$helper-$arch" ] || continue
    printf 'source-built-%s-%s\\n' "$helper" "$arch" >"$1/$helper-$arch"
    chmod 0755 "$1/$helper-$arch"
  done
done
''')
        (self.root / '.github/tools/build-daemon.sh').write_text("""#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$1"
for arch in arm arm64; do
  [ "${OMIT_NATIVE:-}" != "tailscaled-$arch" ] || exit 1
  printf 'patched-daemon-%s\\n' "$arch" >"$1/tailscaled-$arch"
  chmod 0755 "$1/tailscaled-$arch"
done
(cd "$1" && sha256sum tailscaled-arm tailscaled-arm64 > daemon-checksums.txt)
echo pinned-source >"$1/daemon-build.txt"
""")
        (self.root / '.github/tools/build-android.sh').write_text('''#!/usr/bin/env bash
set -euo pipefail
test "$1" = release
printf 'signed-companion-fixture\\n' >"$2"
''')
        shutil.copy(ROOT / 'tailscale/VERSIONS', self.root / 'tailscale/VERSIONS')
        for relative in ['customize.sh', 'service.sh', 'install-recovery.sh', 'uninstall.sh', 'update.json', 'LICENSE',
                         'tailscale/settings.sh', 'webroot/index.html',
                         'native/foxydns/THIRD_PARTY_NOTICES.txt',
                         'unwanted/private-data']:
            (self.root / relative).write_text('fixture\n')
        shutil.copytree(ROOT / 'tailscale/scripts', self.root / 'tailscale/scripts', dirs_exist_ok=True)
        (self.root / 'module.prop').write_text('version=v1.0.3\n')
        (self.root / 'binary-source').mkdir()
        (self.root / 'binary-source/tailscaled').write_bytes(b'local-test-binary\n')
        digest = hashlib.sha256(b'local-test-binary\n').hexdigest()
        self.manifest = ''.join(f'{digest}  {name}\n' for name in BINARIES if not name.startswith('tailscaled-'))
        (self.root / 'tailscale/checksums.txt').write_text(self.manifest)
        assets = ['tailscale_mock_arm.tgz', 'tailscale_mock_arm64.tgz',
                  'jq-armv7a-linux-androideabi', 'jq-aarch64-linux-android',
                  'hev-socks5-tunnel-linux-arm32v7', 'hev-socks5-tunnel-linux-arm64']
        self.assets = json.dumps({'assets': [{'name': x, 'browser_download_url': f'https://example.invalid/{x}'} for x in assets]})

    def build(self, *args, timezone="UTC", omit_native=''):
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
umask 077
bash .github/tools/build.sh "$@"
'''
        env = os.environ.copy()
        env.update(MOCK_ASSETS=self.assets, MOCK_SOURCE=str(self.root / 'binary-source'), SOURCE_DATE_EPOCH='1700000000',
                   TZ=timezone, OMIT_NATIVE=omit_native)
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
            self.assertEqual(archive.read('install-recovery.sh'), b'fixture\n')
            self.assertFalse(any('companion' in x or 'install-companion' in x for x in names))
            self.assertNotIn('system/app/FoxyTail/FoxyTail.apk', names)
            self.assertFalse(any(x.startswith('webroot/') or x.startswith('webui/') for x in names))
            self.assertFalse(any('unwanted' in x or '.github' in x or 'native/foxydns' in x for x in names))
            self.assertEqual(sorted(x for x in names if '/bin/' in x),
                             sorted('tailscale/bin/' + x for x in NATIVE_BINARIES))
            self.check_native_manifest(archive)
        with zipfile.ZipFile(self.root / 'dist/FoxyTail-v1.0.3-full.zip') as archive:
            self.assertEqual(archive.read('THIRD_PARTY_NOTICES.txt'), b'fixture\n')
            self.assertEqual(archive.read('install-recovery.sh'), b'fixture\n')
            self.assertFalse(any('companion' in x for x in archive.namelist()))
            self.assertNotIn('system/app/FoxyTail/FoxyTail.apk', archive.namelist())
            self.assertTrue(all('tailscale/bin/' + x in archive.namelist() for x in BINARIES + NATIVE_BINARIES))
            self.check_native_manifest(archive)
        self.assertFalse((self.root / 'tailscale/native-checksums.txt').exists())
        self.assertEqual((self.root / 'dist/FoxyTail-v1.0.3.apk').read_bytes(), b'signed-companion-fixture\n')
        sums = (self.root / 'dist/SHA256SUMS').read_text().splitlines()
        self.assertEqual(sorted(line.split()[1] for line in sums),
                         ['FoxyTail-v1.0.3-daemon-arm.tgz', 'FoxyTail-v1.0.3-daemon-arm64.tgz', 'FoxyTail-v1.0.3-full.zip', 'FoxyTail-v1.0.3.apk', 'FoxyTail-v1.0.3.zip', 'daemon-build.txt'])
        for line in sums:
            name, digest = line.split()[1], line.split()[0]
            self.assertEqual(hashlib.sha256((self.root / 'dist' / name).read_bytes()).hexdigest(), digest)
        first_light = (self.root / 'dist/FoxyTail-v1.0.3.zip').read_bytes()
        first = (self.root / 'dist/FoxyTail-v1.0.3-full.zip').read_bytes()
        result = self.build(timezone="Asia/Shanghai")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(first_light, (self.root / 'dist/FoxyTail-v1.0.3.zip').read_bytes())
        self.assertEqual(first, (self.root / 'dist/FoxyTail-v1.0.3-full.zip').read_bytes())

    def check_native_manifest(self, archive):
        lines = archive.read('tailscale/native-checksums.txt').decode().splitlines()
        entries = [line.split() for line in lines if line and not line.startswith('#')]
        self.assertEqual([entry[1] for entry in entries], NATIVE_BINARIES + ['tailscaled-arm', 'tailscaled-arm64'])
        for digest, name in entries:
            if 'tailscale/bin/' + name in archive.namelist():
                payload = archive.read('tailscale/bin/' + name)
            else:
                self.assertTrue(name.startswith('tailscaled-'))
                with tarfile.open(self.root / 'dist' / f'FoxyTail-v1.0.3-daemon-{name.split("-")[-1]}.tgz') as daemon:
                    self.assertEqual(daemon.getnames(), ['tailscaled'])
                    payload = daemon.extractfile('tailscaled').read()
            self.assertEqual(hashlib.sha256(payload).hexdigest(), digest)
        self.assertEqual(archive.read('tailscale/checksums.txt').decode(), self.manifest)


    def test_companion_signing_failure_never_creates_a_package(self):
        (self.root / '.github/tools/build-android.sh').write_text('#!/bin/sh\nexit 42\n')
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(list((self.root / 'dist').glob('*.zip')))

    def test_missing_native_architecture_never_creates_a_package(self):
        for binary in NATIVE_BINARIES + ['tailscaled-arm', 'tailscaled-arm64']:
            with self.subTest(binary=binary):
                result = self.build(omit_native=binary)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(list((self.root / 'dist').glob('*.zip')))

    def test_changed_asset_fails_before_packaging(self):
        (self.root / 'binary-source/tailscaled').write_bytes(b'changed-upstream-asset\n')
        result = self.build()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(list((self.root / 'dist').glob('*.zip')))
        self.assertEqual((self.root / 'tailscale/checksums.txt').read_text(), self.manifest)


class NativeInstallerTests(unittest.TestCase):
    def test_daemon_light_download_is_release_pinned_and_fail_closed(self):
        source = (ROOT / 'customize.sh').read_text()
        verify = source[source.index('verify_native_bin() {'):source.index('# install_bin <name>')]
        install = source[source.index('# Only a matching FoxyTail release'):source.index('install_bin jq ')]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'root').mkdir(); (root / 'bin').mkdir()
            (root / 'module.prop').write_text('version=v1.0.3\n')
            payload = b'patched-daemon'
            (root / 'tailscaled').write_bytes(payload)
            with tarfile.open(root / 'asset.tgz', 'w:gz') as archive:
                archive.add(root / 'tailscaled', arcname='tailscaled')
            digest = hashlib.sha256(payload).hexdigest()
            (root / 'root/native-checksums.txt').write_text(f'{digest}  tailscaled-arm64\n')
            driver = verify + '\n' + """
STAGE="$1"; MODPATH="$1"; ARCH=arm64
abort() { echo "$*" >&2; exit 1; }
gh_download() {
  [ "$CASE" != full ] || exit 96
  test "$1" = foxderin/FoxyTail && test "$2" = v1.0.3 || exit 97
  test "$3" = 'FoxyTail-v1.0.3-daemon-arm64\\.tgz' || exit 98
  [ "$CASE" != missing ] || return 1
  cp "$STAGE/asset.tgz" "$4"
}
""" + install
            for case in ['valid', 'missing', 'tampered', 'full']:
                with self.subTest(case=case):
                    target = root / 'bin/tailscaled-arm64'
                    target.unlink(missing_ok=True)
                    if case == 'full': target.write_bytes(payload)
                    (root / 'root/native-checksums.txt').write_text(f'{digest if case != "tampered" else "0" * 64}  tailscaled-arm64\n')
                    result = subprocess.run(['sh', '-c', driver, 'installer', str(root)],
                        env={**os.environ, 'CASE': case}, text=True, capture_output=True, timeout=10)
                    self.assertEqual(result.returncode == 0, case in ('valid', 'full'), result.stdout + result.stderr)

    def test_native_helper_must_be_present_and_match_one_manifest_entry(self):
        source = (ROOT / 'customize.sh').read_text()
        function = source[source.index('verify_native_bin() {'):source.index('# install_bin <name>')]
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            (stage / 'root').mkdir()
            (stage / 'bin').mkdir()
            for name in NATIVE_BINARIES + ['tailscaled-arm', 'tailscaled-arm64']:
                binary = stage / 'bin' / name
                digest = hashlib.sha256(b'first-party-helper').hexdigest()
                manifest = stage / 'root/native-checksums.txt'
                entry = f'{digest}  {name}\n'
                for case in ['valid', 'changed', 'missing', 'duplicate', 'no-entry']:
                    with self.subTest(name=name, case=case):
                        manifest.write_text(entry if case not in ['duplicate', 'no-entry']
                                            else entry * 2 if case == 'duplicate' else '# empty\n')
                        binary.write_bytes(b'changed' if case == 'changed' else b'first-party-helper')
                        if case == 'missing':
                            binary.unlink()
                        result = subprocess.run(['sh', '-c', function + '''
STAGE="$1"
abort() { echo "$*" >&2; exit 1; }
verify_native_bin "$2"
''', 'native-installer-test', directory, name], text=True, capture_output=True, timeout=10)
                        self.assertEqual(result.returncode == 0, case == 'valid', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
