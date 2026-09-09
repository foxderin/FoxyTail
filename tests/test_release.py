"""Exercise the real packager with local synthetic release assets."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BINARIES = [f'{name}-{arch}' for name in ['tailscaled', 'jq', 'hev-socks5-tunnel'] for arch in ['arm', 'arm64']]


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for relative in ['.github/tools', 'tailscale/scripts', 'tailscale/conf', 'META-INF', 'webroot', 'unwanted']:
            (self.root / relative).mkdir(parents=True)
        shutil.copy(ROOT / '.github/tools/build.sh', self.root / '.github/tools/build.sh')
        shutil.copy(ROOT / 'tailscale/VERSIONS', self.root / 'tailscale/VERSIONS')
        for relative in ['customize.sh', 'service.sh', 'uninstall.sh', 'update.json', 'LICENSE',
                         'tailscale/settings.sh', 'tailscale/scripts/start.sh', 'webroot/index.html',
                         'unwanted/private-data']:
            (self.root / relative).write_text('fixture\n')
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
            self.assertIn('tailscale/scripts/start.sh', names)
            self.assertFalse(any('unwanted' in x or '.github' in x or '/bin/' in x for x in names))
        with zipfile.ZipFile(self.root / 'dist/FoxyTail-v1.0.3-full.zip') as archive:
            self.assertTrue(all('tailscale/bin/' + x in archive.namelist() for x in BINARIES))
        first = (self.root / 'dist/FoxyTail-v1.0.3-full.zip').read_bytes()
        result = self.build(timezone="Asia/Shanghai")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(first, (self.root / 'dist/FoxyTail-v1.0.3-full.zip').read_bytes())

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


if __name__ == '__main__':
    unittest.main()
