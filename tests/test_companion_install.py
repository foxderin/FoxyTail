"""Companion code stays in PackageManager storage, never a hidden module overlay."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CompanionInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxytail-companion-install-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.module = self.base / 'module'
        self.data = self.base / 'data/app'
        self.binary = self.base / 'bin'
        for directory in [self.module / 'companion', self.data / 'dev.foxderin.tail', self.binary]:
            directory.mkdir(parents=True)
        self.apk = self.module / 'companion/FoxyTail.apk'
        self.apk.write_bytes(b'APK\x00new-signed-payload\xff')
        (self.apk.parent / 'FoxyTail.apk.sha256').write_text(hashlib.sha256(self.apk.read_bytes()).hexdigest() + '\n')
        self.installed = self.data / 'dev.foxderin.tail/base.apk'
        self.script = self.module / 'install-companion.sh'
        self.script.write_text((ROOT / 'install-companion.sh').read_text().replace('/data/app/', str(self.data) + '/'))
        for command, body in {
            'getprop': 'echo 36',
            'pm': '''case "$1" in
path) cat "$TEST_DIR/path" 2>/dev/null ;;
install)
  printf '%s\\n' "$*" >>"$TEST_DIR/calls"
  if [ -e "$TEST_DIR/deny" ]; then echo 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' >&2; exit 1; fi
  cat >"$TEST_DIR/data/app/dev.foxderin.tail/base.apk"
  printf 'package:%s/data/app/dev.foxderin.tail/base.apk\\n' "$TEST_DIR" >"$TEST_DIR/path"
  echo Success ;;
*) exit 99 ;;
esac''',
        }.items():
            path = self.binary / command
            path.write_text('#!/bin/sh\n' + body + '\n')
            path.chmod(0o755)
        if not shutil.which('timeout'):
            timeout = self.binary / 'timeout'
            timeout.write_text('#!/bin/sh\nshift\nexec "$@"\n')
            timeout.chmod(0o755)
        self.env = {**os.environ, 'TEST_DIR': str(self.base), 'PATH': str(self.binary) + os.pathsep + os.environ['PATH']}

    def run_install(self):
        return subprocess.run(['sh', str(self.script)], env=self.env, capture_output=True, timeout=10)

    def test_system_overlay_is_replaced_by_streamed_package_manager_install(self):
        (self.base / 'path').write_text('package:/system/app/FoxyTail/FoxyTail.apk\n')
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installed.read_bytes(), self.apk.read_bytes())
        self.assertIn(b'install -r --user 0 -S', (self.base / 'calls').read_bytes())
        before = self.installed.stat().st_mtime_ns
        self.assertEqual(self.run_install().returncode, 0)
        self.assertEqual(self.installed.stat().st_mtime_ns, before)
        self.assertEqual(len((self.base / 'calls').read_text().splitlines()), 1)

    def test_failed_signature_update_preserves_installed_app_and_reports_error(self):
        self.installed.write_bytes(b'older-private-app-data-preserved')
        (self.base / 'path').write_text('package:' + str(self.installed) + '\n')
        (self.base / 'deny').touch()
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'INSTALL_FAILED_UPDATE_INCOMPATIBLE', result.stderr)
        self.assertEqual(self.installed.read_bytes(), b'older-private-app-data-preserved')

    def test_tampered_payload_never_reaches_package_manager(self):
        self.apk.write_bytes(b'changed payload')
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.base / 'calls').exists())
        self.assertFalse(self.installed.exists())

    def test_absent_app_installs_without_user_data_deletion(self):
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installed.read_bytes(), self.apk.read_bytes())
        self.assertNotIn('uninstall', (self.base / 'calls').read_text())


if __name__ == '__main__':
    unittest.main()
