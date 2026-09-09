"""Exercise the real packager with local synthetic release assets."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BINARIES = [f'{name}-{arch}' for name in ['tailscaled', 'jq', 'hev-socks5-tunnel'] for arch in ['arm', 'arm64']]
NATIVE_BINARIES = ['foxydns-arm', 'foxydns-arm64']
FLAT_LIBRARIES = ['foxytail.stats-lib.sh', 'foxytail.watchdog-lib.sh', 'foxytail.log-lib.sh']


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
                         'tailscale/settings.sh', 'tailscale/scripts/start.sh', 'webroot/index.html',
                         'native/foxydns/THIRD_PARTY_NOTICES.txt',
                         'unwanted/private-data']:
            (self.root / relative).write_text('fixture\n')
        for name in FLAT_LIBRARIES:
            shutil.copy(ROOT / 'tailscale/scripts' / name, self.root / 'tailscale/scripts' / name)
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
        with zipfile.ZipFile(self.root / 'dist/FoxyTail-v1.0.3.zip') as archive:
            names = archive.namelist()
            self.assertIn('tailscale/scripts/start.sh', names)
            self.assertEqual(archive.read('THIRD_PARTY_NOTICES.txt'), b'fixture\n')
            self.assertFalse(any('unwanted' in x or '.github' in x or 'native/foxydns' in x for x in names))
            self.assertEqual(sorted(x for x in names if '/bin/' in x),
                             ['tailscale/bin/' + x for x in NATIVE_BINARIES])
            self.check_native_manifest(archive)
            self.check_flat_libraries(archive)
        with zipfile.ZipFile(self.root / 'dist/FoxyTail-v1.0.3-full.zip') as archive:
            self.assertEqual(archive.read('THIRD_PARTY_NOTICES.txt'), b'fixture\n')
            self.assertTrue(all('tailscale/bin/' + x in archive.namelist() for x in BINARIES + NATIVE_BINARIES))
            self.check_native_manifest(archive)
            self.check_flat_libraries(archive)
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

    def check_flat_libraries(self, archive):
        for name in FLAT_LIBRARIES:
            relative = 'tailscale/scripts/' + name
            self.assertEqual(archive.read(relative), (ROOT / relative).read_bytes())

    def installer_package(self):
        # Only Android-manager callbacks and runtime dependencies are fixtures.
        # The ZIP contains the actual installer, packager and new shell libraries.
        shutil.copy(ROOT / 'customize.sh', self.root / 'customize.sh')
        (self.root / 'tailscale/settings.sh').write_text('load_conf() { return 0; }\n')
        (self.root / 'tailscale/scripts/start.sh').write_text('#!/bin/sh\nexit 0\n')
        for name in ['foxytail.tun.up', 'foxytail.tun.down']:
            (self.root / 'tailscale/scripts' / name).write_text('#!/bin/sh\n# new hook template\n')
        (self.root / 'tailscale/conf/foxytail.conf').write_text('MODE=bridge\n')
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return self.root / 'dist/FoxyTail-v1.0.3-full.zip'

    def installed_fixture(self, name, upgrade=False):
        base = self.root / name
        for relative in ['runtime', 'module', 'tmp', 'dev', 'proc']:
            (base / relative).mkdir(parents=True)
        runtime = base / 'runtime'
        if upgrade:
            for part in ['bin', 'scripts', 'conf', 'state', 'files']:
                (runtime / part).mkdir()
            for lib in FLAT_LIBRARIES:
                (runtime / 'scripts' / lib).write_text('# old version of ' + lib + '\n')
            (runtime / 'scripts/foxytail.tun.up').write_text('# user hook\n')
            (runtime / 'scripts/user-task.sh').write_text('# user script\n')
            (runtime / 'bin/dnsmasq').write_text('user binary\n')
            (runtime / 'conf/foxytail.conf').write_text('MODE=proxy\n')
            (runtime / 'state/tailscaled.state').write_text('preserved identity\n')
            (runtime / 'files/received').write_text('received user file\n')
            for part in ['settings.sh', 'VERSIONS', 'checksums.txt', 'native-checksums.txt']:
                (runtime / part).write_text('# old ' + part + '\n')
        return base

    def run_installer(self, package, base, fail_permissions=False):
        # Relocate every mutable absolute Android path into this private tree,
        # including /proc so quiesce cannot inspect or signal a host process.
        with zipfile.ZipFile(package) as archive:
            source = archive.read('customize.sh').decode()
        source = source.replace('/data/adb/foxytail', str(base / 'runtime'))
        source = source.replace('/proc/', str(base / 'proc') + '/')
        # The tailscale prefix covers both /dev/tailscale and /dev/tailscaled
        # in one pass, without rewriting a previously relocated destination.
        for name in ['tailscale', 'foxytail.service']:
            source = source.replace('/dev/' + name, str(base / 'dev' / name))
        script = base / 'customize-fixture.sh'
        script.write_text(source)
        driver = r'''
ui_print() { printf '%s\n' "$*"; }
abort() { printf '%s\n' "$*" >&2; exit 1; }
set_perm() { chmod "$4" "$1"; }
set_perm_recursive() {
  if [ "$FAIL_SCRIPT_PERMISSIONS" = 1 ] && [ "$1" = "$TEST_RUNTIME/scripts" ]; then
    return 1
  fi
  find "$1" -type d -exec chmod "$4" {} + &&
    find "$1" -type f -exec chmod "$5" {} +
}
iptables() { return 1; }
. "$1"
'''
        env = {**os.environ, 'BOOTMODE': 'true', 'KSU': 'true', 'KSU_VER_CODE': '12000',
               'ARCH': 'arm64', 'MODPATH': str(base / 'module'), 'TMPDIR': str(base / 'tmp'),
               'ZIPFILE': str(package), 'TEST_RUNTIME': str(base / 'runtime'),
               'FAIL_SCRIPT_PERMISSIONS': '1' if fail_permissions else '0'}
        return subprocess.run(['sh', '-c', driver, 'module-installer-test', str(script)],
                              cwd=base, env=env, text=True, capture_output=True, timeout=15)

    def check_installed_libraries(self, base):
        scripts = base / 'runtime/scripts'
        for name in FLAT_LIBRARIES:
            self.assertEqual((scripts / name).read_bytes(), (ROOT / 'tailscale/scripts' / name).read_bytes())
            self.assertEqual((scripts / name).stat().st_mode & 0o777, 0o755)
        # Source the installed files through their actual flat runtime path.
        # Library implementations must remain side-effect free when loaded.
        result = subprocess.run(['sh', '-c', '''
TS_SCRIPTS_DIR="$1"
shift
for library do . "$TS_SCRIPTS_DIR/$library" || exit 1; done
printf 'libraries-loaded\n'
''', 'installed-library-test', str(scripts), *FLAT_LIBRARIES],
                                cwd=base, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, 'libraries-loaded\n')
        self.assertEqual(result.stderr, '')

    def check_user_data_preserved(self, base):
        for relative, content in {
            'scripts/foxytail.tun.up': '# user hook\n',
            'scripts/user-task.sh': '# user script\n',
            'bin/dnsmasq': 'user binary\n',
            'conf/foxytail.conf': 'MODE=proxy\n',
            'state/tailscaled.state': 'preserved identity\n',
            'files/received': 'received user file\n',
        }.items():
            self.assertEqual((base / 'runtime' / relative).read_text(), content)

    def test_flat_libraries_survive_packaging_fresh_install_and_upgrade(self):
        package = self.installer_package()
        for upgrade in [False, True]:
            with self.subTest(upgrade=upgrade):
                base = self.installed_fixture('upgrade' if upgrade else 'fresh', upgrade)
                result = self.run_installer(package, base)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.check_installed_libraries(base)
                self.assertFalse((base / 'runtime/.install-transaction').exists())
                for name in ['tailscale', 'tailscaled']:
                    self.assertEqual((base / 'dev' / name).readlink(), base / 'runtime/bin/tailscaled')
                if upgrade:
                    self.check_user_data_preserved(base)
                    backup, = (base / 'runtime/backups').iterdir()
                    for lib in FLAT_LIBRARIES:
                        self.assertEqual((backup / 'scripts' / lib).read_text(), '# old version of ' + lib + '\n')
                    self.assertEqual((base / 'runtime/scripts/foxytail.tun.up.new').read_text(),
                                     '#!/bin/sh\n# new hook template\n')

    def test_late_installer_failure_restores_previous_flat_libraries(self):
        package = self.installer_package()
        base = self.installed_fixture('rollback', upgrade=True)
        result = self.run_installer(package, base, fail_permissions=True)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Previous software restored', result.stdout)
        for lib in FLAT_LIBRARIES:
            self.assertEqual((base / 'runtime/scripts' / lib).read_text(), '# old version of ' + lib + '\n')
        self.check_user_data_preserved(base)
        self.assertFalse((base / 'runtime/.installing').exists())
        self.assertFalse((base / 'runtime/.install-transaction').exists())

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


if __name__ == '__main__':
    unittest.main()
