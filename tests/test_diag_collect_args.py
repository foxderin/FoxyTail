"""foxytail.diag collect positional disambiguation and UTF-8-safe staging."""
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DiagCollectArgsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='foxytail-diag-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        for directory in ('bin', 'scripts', 'conf', 'run', 'modules'):
            (self.base / directory).mkdir()
        helper = self.scripts = self.base / 'scripts/foxytail.diag'
        helper.write_text((ROOT / 'tailscale/scripts/foxytail.diag').read_text().replace(
            '/data/adb/modules', str(self.base / 'modules')))
        (self.base / 'settings.sh').write_text('''
TS_DIR="$TEST_DIR"
TS_RUN_DIR="$TEST_DIR/run"
TS_SCRIPTS_DIR="$TEST_DIR/scripts"
TS_BIN_DIR="$TEST_DIR/bin"
TS_CONF_DIR="$TEST_DIR/conf"
TS_SOCKET="$TS_RUN_DIR/tailscaled.sock"
TS_RUN_LOG_FILE="$TS_RUN_DIR/foxytail.log"
TS_LOG_FILE="$TS_RUN_DIR/tailscaled.log"
TS_MOD_PROP="$TS_DIR/module.prop"
ROUTE_TABLE=1052
IPV6=off
ensure_run_dirs() { mkdir -p "$TS_RUN_DIR" "$TS_RUN_DIR/pids"; }
load_conf() { :; }
log() { :; }
tmo() { shift; "$@"; }
jqr() { jq "$@"; }
have_jq() { return 0; }
''')
        (self.base / 'conf/foxytail.conf').write_text('MAGIC_DNS=off\n')
        # status.err captures raw helper stderr: make it undecodable UTF-8 so
        # only the sanitize pass can keep --rawfile from failing the bundle.
        (self.base / 'bin/tailscale').write_text('#!/bin/sh\n'
            'for a in "$@"; do [ "$a" = status ] && _s=1; done\n'
            'case "${_s:-0}" in\n'
            ' 1) printf \'{"BackendState":"Running","Self":{"HostName":"mine","LoginName":"owner@example.org"}}\\n\'; printf "\\377\\376bad\\n" >&2 ;;\n'
            ' *) echo ok ;;\n'
            'esac\n')
        for name in ('tailscale',):
            (self.base / 'bin' / name).chmod(0o755)
        for name in ('ip', 'iptables', 'ip6tables', 'getprop', 'ls'):
            path = self.base / 'bin' / name
            path.write_text('#!/bin/sh\nexit 0\n')
            path.chmod(0o755)
        self.env = {**os.environ, 'TEST_DIR': str(self.base),
                    'PATH': str(self.base / 'bin') + os.pathsep + os.environ['PATH'],
                    'COPYFILE_DISABLE': '1'}

    def collect(self, *args, ok=True):
        result = subprocess.run(['sh', str(self.base / 'scripts/foxytail.diag'),
                                 'collect', *args], cwd=self.base, env=self.env,
                                text=True, capture_output=True, timeout=20)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def archive_members(self, result):
        path = result.stdout.strip().splitlines()[-1]
        with tarfile.open(path) as archive:
            return {member.name.split('/', 1)[1]: archive.extractfile(member).read()
                    for member in archive.getmembers() if member.isfile()}

    def test_mode_in_slot_one_names_mode_not_a_directory(self):
        # `collect share` must not create ./share or treat the keyword as an
        # output path; with /sdcard unavailable it falls back to $TS_DIR.
        result = self.collect('share')
        self.assertFalse((self.base / 'share').exists())
        self.assertTrue(result.stdout.strip().endswith('.tar.gz'))
        members = self.archive_members(result)
        self.assertEqual(members['diagnostic-mode.txt'], b'mode=share\n')
        self.assertNotIn(b'owner@example.org', members['status.json'])
        # Undecodable bytes in staged files are dropped, not fatal.
        self.assertNotIn(b'\xff', members['status.err'])
        # `collect local <dir>` is explicit and keeps raw identities.
        out = self.base / 'private-out'
        members = self.archive_members(self.collect('local', str(out)))
        self.assertEqual(members['diagnostic-mode.txt'], b'mode=local\n')
        self.assertIn(b'owner@example.org', members['status.json'])
        # Two mode keywords remain an error, whatever their order.
        for args in (('share', 'local'), ('local', 'share')):
            with self.subTest(args=args):
                result = self.collect(*args, ok=False)
                self.assertIn('expected share|local', result.stderr)
        # A bogus mode in slot two is still rejected.
        result = self.collect(str(self.base / 'x'), 'bogus', ok=False)
        self.assertIn('expected share|local', result.stderr)


if __name__ == '__main__':
    unittest.main()
