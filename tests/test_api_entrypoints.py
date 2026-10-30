"""Real WebAPI/helper dispatch in private paths; Android commands are inert stubs."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import unittest

from api_fixture import ApiTestCase, ROOT
from runtime_fixture import host_process_shell


class ApiEntrypointTests(ApiTestCase):
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
        # These host fixtures must never move a real cgroup or touch devices.
        with (self.base / 'settings.sh').open('a') as settings:
            settings.write('\ndetach_from_app_cgroup() { :; }\n')
        self.script('scripts/foxytail.service', 'echo "$*" >>"$TEST_DIR/service-calls"\n')
        self.script('scripts/start.sh', 'echo "$*" >>"$TEST_DIR/start-calls"\n')
        self.env = dict(os.environ, TEST_DIR=str(self.base), TEST_PYTHON=sys.executable)

    def entry(self, *args, ok=True):
        result = subprocess.run(['sh', str(self.api), *args], env=self.env,
                                capture_output=True, text=True, timeout=15)
        data = json.loads(result.stdout)
        self.assertEqual(data['ok'], ok, result.stdout + result.stderr)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        return data

    def test_taildrop_history_and_batch_dispatch_contracts(self):
        self.entry_fixture()
        self.script('bin/id', 'echo 0\n')
        self.api.write_text(self.api.read_text().replace('# --- dispatch', '''
cmd_file_delete_many() { jqr -n --arg names "$1" '{ok:true,names:$names}'; }
# --- dispatch''', 1))
        self.script('bin/foxyfiles', '''
printf '%s\\n' "$@" >"$TEST_DIR/helper-args"
printf '%s\\n' '{"ok":true,"removed":1,"retained":2}'
''')
        commands = [('file-send-delete', 'a' * 32), ('file-send-clear',),
                    ('file-delete-many', '["quote \' and space.txt"]')]
        advertised = self.entry('backend-info')['commands']
        (self.conf / 'foxytail.conf').write_text('TS_MODE=invalid\n')
        for args in commands:
            with self.subTest(command=args[0]):
                self.assertIn(args[0], advertised)
                result = self.entry(*args)
                if args[0].startswith('file-send-'):
                    self.assertEqual(result, {'ok': True, 'removed': 1, 'retained': 2})
                    expected = [args[0][5:], '--root', str(self.base)]
                    if len(args) == 2:
                        expected += ['--id', args[1]]
                    self.assertEqual((self.base / 'helper-args').read_text().splitlines(), expected)
                else:
                    self.assertEqual(result['names'], args[1])
                self.entry(*args, 'extra', ok=False)
                if len(args) == 2:
                    self.entry(args[0], ok=False)
                (self.base / '.installing').touch()
                self.assertIn('upgrade', self.entry(*args, ok=False)['error'])
                (self.base / '.installing').unlink()

    def test_invalid_main_and_routes_preserve_recovery_dispatch(self):
        self.entry_fixture()
        good = self.snapshot()
        archive = self.archive({'conf/' + name: body.decode() for name, body in good.items()})
        for name, bad in [('foxytail.conf', 'TS_MODE=invalid\n'),
                          ('routes.conf', 'ROUTE_SCOPE=invalid\n')]:
            with self.subTest(name=name):
                (self.conf / name).write_text(bad)
                (self.run / 'foxytail.log').write_text('recovery log\n')
                self.assertEqual(self.entry('logs', 'service')['lines'], ['recovery log'])
                self.entry('logs', 'invalid', ok=False)
                self.entry('control', 'stop')
                self.entry('cancel', str(int(time.time())) + '_recovery_' + name.replace('.', '_'))
                self.entry('cancel', '../invalid', ok=False)
                self.entry('restore', str(self.sdcard / 'missing.tar.gz'), ok=False)
                for args in [('control', 'start'), ('control', 'restart'), ('mode-set', 'proxy'),
                             ('routes-set', 'all', '-', '-'), ('context-set', ''),
                             ('settings-set', 'DNS_PORT', '1200')]:
                    self.assertIn('invalid configuration', self.entry(*args, ok=False)['error'])
                self.assertFalse((self.base / 'start-calls').exists())
                self.assertEqual((self.base / 'service-calls').read_text().splitlines()[-1], 'stop')
                import hashlib
                baseline = self.shell('_restore_baseline').stdout.strip()
                self.entry('restore', str(archive), hashlib.sha256(archive.read_bytes()).hexdigest(), baseline)
                self.assertEqual(self.snapshot(), good)
        self.assertEqual((self.base / 'service-calls').read_text().splitlines(), ['stop', 'stop'])

    def test_independent_reads_do_not_wait_for_configuration_writer(self):
        self.entry_fixture()
        self.script('bin/pm', 'printf "package:com.example.reader uid:10101\\n"\n')
        holder = subprocess.Popen(['sh', '-c', '. "$1"; ensure_run_dirs; conf_lock_acquire || exit 1; '
            'trap conf_lock_release EXIT; printf "ready\\n"; IFS= read -r release',
            'hold', str(self.base / 'settings.sh')], env=self.env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), 'ready')
            (self.conf / 'foxytail.conf').write_text('TS_MODE=invalid\n')
            result = subprocess.run(['sh', str(self.api), 'apps'], env=self.env,
                capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)['apps'],
                [{'label': 'com.example.reader', 'package': 'com.example.reader', 'uid': 10101}])
            self.assertIsNone(holder.poll(), 'read must complete before the writer releases ownership')
        finally:
            holder.communicate('release\n', timeout=5)
        self.assertFalse(self.entry('settings-get', ok=False)['ok'])

    def test_independent_device_read_ignores_broken_saved_configuration(self):
        self.entry_fixture()
        self.api.write_text(self.api.read_text().replace('# --- dispatch',
            'daemon_up() { return 0; }\n# --- dispatch', 1))
        self.script('bin/tailscale', '''printf '%s' '{"BackendState":"Running","Self":{"ID":"self-one"},"Peer":{"peer":{"ID":"peer-one","HostName":"peer-one","TailscaleIPs":["100.64.0.2"],"Online":true}}}'
''')
        (self.conf / 'foxytail.conf').write_text('TS_MODE=invalid\n')
        self.assertEqual(self.entry('peers')['peers'][0]['id'], 'peer-one')

    def slow_fixture(self):
        self.entry_fixture()
        for name in ('foxytail.diag', 'foxytail.compat'):
            source = (ROOT / 'tailscale/scripts' / name).read_text()
            self.script('scripts/' + name, source.replace('#!/system/bin/sh\n', '', 1)
                        .replace('/sdcard/', str(self.sdcard) + '/')
                        .replace('/data/adb/modules', str(self.base / 'modules')))
        self.script('bin/slow', 'sh "$TEST_DIR/bin/nested" &\nwait\n')
        self.script('bin/nested', 'trap "" TERM\n"$TEST_PYTHON" "$TEST_DIR/bin/leaf.py" &\nwait\n')
        (self.base / 'bin/leaf.py').write_text('''import os, signal, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(os.environ['TEST_DIR'], 'leaf-pid').write_text(str(os.getpid()))
time.sleep(30)
''')
        self.script('bin/tailscale', '''
if [ "$2" = "$SLOW_PHASE" ]; then exec "$TEST_DIR/bin/slow"; fi
echo '{"BackendState":"Running","Peer":{}}'
''')
        self.script('bin/pm', '''
case "$SLOW_PHASE" in
  pm) exec "$TEST_DIR/bin/slow" ;;
  dumpsys) [ "$*" = 'list packages -3 -U' ] || echo package:com.example.fixture ;;
esac
''')
        self.script('bin/dumpsys', 'exec "$TEST_DIR/bin/slow"\n')
        for name in ('ip', 'iptables', 'ip6tables', 'getprop'):
            self.script('bin/' + name, 'exit 0\n')

    def test_runtime_reads_use_applied_config_while_settings_read_saved_config(self):
        self.entry_fixture()
        self.shell('conf_activate_runtime')
        (self.conf / 'foxytail.conf').write_text('TS_MODE=proxy\nSOCKS_PORT=1200\nDNS_PORT=1201\n')
        self.shell('conf_lock_acquire; conf_mark_pending; conf_lock_release')
        self.script('bin/ip', 'exit 1\n')
        self.script('scripts/foxytail.dns', '''
. "$TEST_DIR/settings.sh"
load_runtime_conf || exit 1
printf '{"state":"stopped","suffix":"","port":%s,"mode":"%s"}' "$DNS_PORT" "$DNS_MODE"
''')
        saved = self.entry('settings-get')['settings']
        self.assertEqual((saved['TS_MODE'], saved['SOCKS_PORT'], saved['DNS_PORT']), ('proxy', '1200', '1201'))
        for invalid in (False, True):
            if invalid:
                (self.conf / 'foxytail.conf').write_text('TS_MODE=invalid\n')
            self.assertEqual(self.entry('status')['mode'], 'bridge')
            tun = self.entry('tun')
            self.assertEqual((tun['mode'], tun['socksPort']), ('bridge', 1099))
            self.assertEqual(self.entry('dns')['port'], 1053)

    def test_host_process_stamp_survives_stop_and_rejects_zombies(self):
        self.entry_fixture()
        process = subprocess.Popen(['sleep', '30'], start_new_session=True)
        def stamp(prefix=''):
            return subprocess.run(['sh', '-c', '. "$1"; ' + prefix + '_proc_starttime "$2"',
                'test', str(self.base / 'settings.sh'), str(process.pid)],
                text=True, capture_output=True, timeout=3)
        try:
            before = stamp()
            self.assertEqual(before.returncode, 0, before.stderr)
            self.assertTrue(before.stdout.strip())
            process.send_signal(signal.SIGSTOP)
            stopped = stamp()
            process.send_signal(signal.SIGCONT)
            resumed = stamp()
            self.assertEqual(stopped.stdout, before.stdout)
            self.assertEqual(resumed.stdout, before.stdout)
        finally:
            self.terminate(process)

    def test_real_diagnostic_timeout_cleans_descendants_and_partial_output(self):
        self.slow_fixture()
        tools = self.scripts / 'foxytail.webapi-tools.sh'
        # The fixture chain needs about a second to reach its slow leaf on a
        # loaded host, so the timeout must not fire before that leaf is running.
        tools.write_text(tools.read_text().replace('_op_exec 120 ', '_op_exec 4 '))
        self.env['SLOW_PHASE'] = 'status'
        request = str(int(time.time())) + '_timeout'
        runner = subprocess.Popen(['sh', str(self.api), '--request-id', request, 'diag'],
            env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            stdout, stderr = runner.communicate(timeout=20)
            self.assertNotEqual(runner.returncode, 0, stdout + stderr)
            self.assertFalse(json.loads(stdout)['ok'])
            leaffile = self.base / 'leaf-pid'
            deadline = time.monotonic() + 5
            while not leaffile.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(leaffile.exists(), 'the timed-out operation never reached its slow descendant')
            leaf = leaffile.read_text()
            state = subprocess.run(['ps', '-p', leaf, '-o', 'stat='], text=True, capture_output=True)
            self.assertTrue(state.returncode != 0 or state.stdout.strip().startswith('Z'))
            self.assertFalse(list((self.run / 'operations' / request).glob('child.*')))
            self.assertFalse(list(self.run.glob('diag.*')))
            self.assertFalse(list((self.sdcard / 'Download').glob('*.tar.gz*')))
        finally:
            self.terminate(runner)

    def terminate(self, process):
        # Each runner has its own session solely for reliable fixture cleanup,
        # even when the regression deliberately detects leaked descendants.
        # Once its leader exits, never signal a possibly reused group ID unless
        # our fixture's recorded leaf still belongs to that very same group.
        owned = process.poll() is None
        if not owned and (self.base / 'leaf-pid').exists():
            try:
                owned = os.getpgid(int((self.base / 'leaf-pid').read_text())) == process.pid
            except ProcessLookupError:
                pass
        try:
            if owned:
                os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            if process.poll() is None:
                process.kill()
        process.communicate(timeout=3)

    def test_exit_routing_cancels_owned_descendants_without_success_payload(self):
        self.slow_fixture()
        source = (ROOT / 'tailscale/scripts/foxytail.exitnode').read_text()
        self.script('scripts/foxytail.exitnode', source.replace('#!/system/bin/sh\n', '', 1))
        self.script('scripts/foxytail.route', 'exec "$TEST_DIR/bin/slow"\n')
        self.script('bin/tailscale', '''
case "$2" in
 switch) echo '[{"id":"profile-a","selected":true}]' ;;
 debug) echo '{"ExitNodeID":"node-a","ExitNodeIP":"","ExitNodeAllowLANAccess":false}' ;;
 status) echo '{"BackendState":"Running","Self":{"ID":"self-a"},"ExitNodeStatus":{"ID":"node-a","Online":true},"Peer":{}}' ;;
 *) exit 1 ;;
esac
''')
        with (self.scripts / 'foxytail.webapi-network.sh').open('a') as network:
            network.write('\ndaemon_up() { return 0; }\ndaemon_exists() { return 0; }\n')
        request = str(int(time.time())) + '_exit_route_cancel'
        runner = subprocess.Popen(['sh', str(self.api), '--request-id', request, 'exit-routing'],
            env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        bystander = subprocess.Popen(['sleep', '30'], start_new_session=True)
        try:
            pidfile = self.base / 'leaf-pid'
            deadline = time.monotonic() + 8
            while not pidfile.exists() and runner.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(pidfile.exists(), 'exit routing never reached nested route read')
            registry = self.run / 'operations' / request
            self.assertTrue(list(registry.glob('child.*')))
            started = time.monotonic()
            self.assertTrue(self.entry('cancel', request)['cancelled'])
            stdout, stderr = runner.communicate(timeout=3)
            self.assertLess(time.monotonic() - started, 7)
            self.assertNotEqual(runner.returncode, 0, stdout + stderr)
            self.assertFalse(json.loads(stdout)['ok'])
            state = subprocess.run(['ps', '-p', pidfile.read_text(), '-o', 'stat='], text=True, capture_output=True)
            self.assertTrue(state.returncode != 0 or state.stdout.strip().startswith('Z'))
            self.assertFalse(list(registry.glob('child.*')))
            self.assertIsNone(bystander.poll())
        finally:
            self.terminate(runner)
            self.terminate(bystander)

    def test_real_slow_helpers_cancel_descendants_and_leave_bystander_alive(self):
        self.slow_fixture()
        bystander = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.buffer.read()'],
            stdin=subprocess.PIPE, start_new_session=True)
        self.addCleanup(self.terminate, bystander)
        for index, (command, phase) in enumerate([
            ('diag', 'status'), ('diag', 'netcheck'), ('diag', 'bugreport'),
            ('diag', 'pm'), ('compat', 'pm'), ('apps', 'pm'), ('apps', 'dumpsys'),
        ]):
            with self.subTest(command=command, phase=phase):
                pidfile = self.base / 'leaf-pid'
                pidfile.unlink(missing_ok=True)
                request = str(int(time.time())) + f'_slow_{index}'
                runner = subprocess.Popen(['sh', str(self.api), '--request-id', request, command],
                    env=dict(self.env, SLOW_PHASE=phase), stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, text=True, start_new_session=True)
                try:
                    deadline = time.monotonic() + 5
                    while not pidfile.exists() and runner.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue(pidfile.exists(), 'actual helper never reached slow descendant')
                    leaf = int(pidfile.read_text())
                    registry = self.run / 'operations' / request
                    self.assertTrue(list(registry.glob('child.*')))
                    # Recovery cancellation still works after desired config breaks.
                    (self.conf / 'routes.conf').write_text('ROUTE_SCOPE=invalid\n')
                    cancelled = self.entry('cancel', request)
                    self.assertTrue(cancelled['cancelled'])
                    stdout, stderr = runner.communicate(timeout=3)
                    self.assertNotEqual(runner.returncode, 0, stdout + stderr)
                    self.assertFalse(json.loads(stdout)['ok'])
                    state = subprocess.run(['ps', '-p', str(leaf), '-o', 'stat='], text=True, capture_output=True)
                    self.assertTrue(state.returncode != 0 or state.stdout.strip().startswith('Z'),
                                    'owned descendant survived cancellation: ' + state.stdout)
                    self.assertIsNone(bystander.poll(), 'unrelated process was signalled')
                    self.assertFalse(list(registry.glob('child.*')))
                    self.assertFalse(list(self.run.glob('diag.*')), 'cancelled staging directory survived')
                    self.assertFalse(list((self.sdcard / 'Download').glob('*.tar.gz*')))
                finally:
                    self.terminate(runner)
                    (self.conf / 'routes.conf').write_text('ROUTE_SCOPE=all\n')

    def test_registered_commit_refuses_cancellation(self):
        self.slow_fixture()
        self.script('scripts/foxytail.service', 'exec "$TEST_DIR/bin/slow"\n')
        request = str(int(time.time())) + '_commit'
        runner = subprocess.Popen(['sh', str(self.api), '--request-id', request, 'control', 'start'],
            env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            deadline = time.monotonic() + 5
            while not (self.base / 'leaf-pid').exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue((self.base / 'leaf-pid').exists())
            self.assertIn('cannot be cancelled', self.entry('cancel', request, ok=False)['error'])
            self.assertIsNone(runner.poll())
            self.assertFalse((self.run / 'operations' / request / 'cancelled').exists())
        finally:
            self.terminate(runner)


if __name__ == '__main__':
    unittest.main()
