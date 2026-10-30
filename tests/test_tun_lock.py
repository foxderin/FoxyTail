"""TUN controller mutual exclusion via the shared owner lock (.tun-lock)."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from runtime_fixture import host_process_shell

ROOT = Path(__file__).resolve().parents[1]


class TunLockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxytail-tunlock-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        for directory in ('bin', 'scripts', 'run/pids'):
            (self.base / directory).mkdir(parents=True)
        self.scripts = self.base / 'scripts'
        self.runner = self.scripts / 'foxytail.tun'
        self.runner.write_text((ROOT / 'tailscale/scripts/foxytail.tun').read_text())
        (self.scripts / 'foxytail.tun.config.yaml').write_text(
            (ROOT / 'tailscale/scripts/foxytail.tun.config.yaml').read_text())
        self.env = {**os.environ, 'TEST_DIR': str(self.base)}
        # Real owner-lock functions (with host process helpers on Darwin) so
        # the script takes its serialized path; instant sleep keeps retries
        # bounded without changing the outcome.
        lock = (ROOT / 'tailscale/scripts/foxytail.lock.sh').read_text()
        (self.base / 'settings.sh').write_text(r'''
TS_BIN_DIR="$TEST_DIR/bin"
TS_SCRIPTS_DIR="$TEST_DIR/scripts"
TS_RUN_DIR="$TEST_DIR/run"
TS_PID_DIR="$TS_RUN_DIR/pids"
TUN_IFACE=tailscale0
ensure_run_dirs() { mkdir -p "$TS_PID_DIR" "$TS_RUN_DIR"; }
iface_exists() { [ -f "$TEST_DIR/interface" ]; }
load_runtime_conf() { TS_MODE=bridge; SOCKS_PORT=1099; IPV6=off; return 0; }
log() { printf '%s: %s\n' "$1" "$2" >>"$TEST_DIR/service.log"; }
rotate_log() { :; }
wait_for() { wait; shift 3; "$@"; }
sleep() { :; }
pids_of_path() { [ ! -f "$TEST_DIR/alive" ] || echo 101; }
stop_by_pids() { echo "stop:$2" >>"$TEST_DIR/events"; rm -f "$TEST_DIR/alive" "$TEST_DIR/interface"; }
nohup() { "$@"; }
''' + lock + host_process_shell())
        hev = self.base / 'bin/hev-socks5-tunnel'
        hev.write_text('#!/bin/sh\necho launch >>"$TEST_DIR/events"\n'
                       'touch "$TEST_DIR/alive" "$TEST_DIR/interface"\n')
        hev.chmod(0o755)
        self.holder = None

    def stop_holder(self):
        if self.holder is not None:
            self.holder.kill()
            self.holder.wait()
            if self.holder.stdout is not None:
                self.holder.stdout.close()
            self.holder = None

    def tearDown(self):
        self.stop_holder()

    def run_tun(self, *args):
        return subprocess.run(['sh', str(self.runner), *args], cwd=self.base,
                              env=self.env, text=True, capture_output=True, timeout=20)

    def events(self):
        path = self.base / 'events'
        return path.read_text().splitlines() if path.exists() else []

    def lock_path(self):
        return self.base / 'run/.tun-lock'

    def waiters(self):
        directory = self.base / 'run/.tun-lock.waiters'
        return list(directory.iterdir()) if directory.is_dir() else []

    def hold_lock(self):
        # A live foreign owner: the same lock library publishes its token, so
        # the tun controller must wait exactly like a racing invocation.
        script = ('. "$1"; _lock_identity || exit 2\n'
                  'ln -s "$_LOCK_TOKEN" "$TS_RUN_DIR/.tun-lock" || exit 3\n'
                  'mkdir -p "$TS_RUN_DIR/.tun-lock.waiters" || exit 4\n'
                  'ln -s 1 "$TS_RUN_DIR/.tun-lock.waiters/$_LOCK_TOKEN" || exit 5\n'
                  'echo held; exec /bin/sleep 60\n')
        self.holder = subprocess.Popen(['sh', '-c', script, 'holder',
                                        str(self.base / 'settings.sh')],
                                       env=self.env, text=True,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(self.holder.stdout.readline().strip(), 'held')

    def test_held_lock_blocks_mutation_and_dead_owner_is_reaped(self):
        self.hold_lock()
        for command in ('start', 'stop', 'restart'):
            with self.subTest(command=command):
                result = self.run_tun(command)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.events(), [])
        self.assertIn('tunnel controller busy', (self.base / 'service.log').read_text())
        self.stop_holder()
        # Once the owner exits, its dead ticket is reaped and start proceeds.
        result = self.run_tun('start')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.events(), ['launch'])
        # Release is complete: no owner symlink or waiter ticket remains.
        self.assertFalse(self.lock_path().exists())
        self.assertEqual(self.waiters(), [])

    def test_dead_owner_symlink_never_strands_the_controller(self):
        # A crashed owner's leftover symlink is reclaimed rather than
        # blocking the next invocation forever.
        self.lock_path().symlink_to('99999:1:not-a-real-boot')
        result = self.run_tun('start')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.events(), ['launch'])
        self.assertFalse(self.lock_path().exists())


if __name__ == '__main__':
    unittest.main()
