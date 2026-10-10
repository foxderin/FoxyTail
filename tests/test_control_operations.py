"""Detached control protocol against real shell dispatch and process identities."""
import base64
import json
import os
import signal
import subprocess
import time

from api_fixture import ApiTestCase
import test_api_entrypoints as entrypoints


class ControlOperationTests(ApiTestCase):
    script = entrypoints.ApiEntrypointTests.script
    entry_fixture = entrypoints.ApiEntrypointTests.entry_fixture
    entry = entrypoints.ApiEntrypointTests.entry

    def setUp(self):
        super().setUp()
        self.entry_fixture()
        self.overrides = self.base / 'overrides.sh'
        self.overrides.write_text('')
        source = self.api.read_text()
        self.api.write_text(source.replace('# --- dispatch', '. "$TEST_DIR/overrides.sh"\n# --- dispatch', 1))
        self.operations = []

    def tearDown(self):
        try:
            self.release_workers()
        finally:
            super().tearDown()

    def release_workers(self):
        (self.base / 'release').touch()
        for request in self.operations:
            try:
                self.entry('cancel', request)
            except (AssertionError, subprocess.TimeoutExpired, json.JSONDecodeError):
                pass

    def request(self, suffix):
        request = str(int(time.time())) + '_' + suffix
        self.operations.append(request)
        return request

    def terminal(self, request):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            operation = self.entry('operation-status', request)['operation']
            if operation['state'] != 'running':
                return operation
            time.sleep(0.03)
        self.fail('operation never became terminal: ' + request)

    def await_path(self, name):
        path = self.base / name
        deadline = time.monotonic() + 8
        while not path.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(path.exists(), name)
        return path

    def test_accepted_operation_survives_caller_and_deduplicates_without_replay(self):
        self.overrides.write_text('''cmd_control() {
  echo invocation >>"$TS_DIR/invocations"
  touch "$TS_DIR/entered"
  while [ ! -f "$TS_DIR/release" ]; do sleep 0.03; done
  echo '{"ok":true,"saved":true,"applied":false,"restartRequired":true,"note":"preserved"}'
}
''')
        request = self.request('survive')
        accepted = self.entry('operation-start', request, 'control', 'stop')['operation']
        self.assertEqual(accepted['id'], request)
        self.assertEqual(accepted['command'], 'control')
        self.await_path('entered')
        replay = self.entry('operation-start', request, 'control', 'start')['operation']
        self.assertEqual(replay['state'], 'running')
        self.assertFalse(replay['cancellable'])
        self.assertFalse(self.entry('cancel', request, ok=False)['ok'])
        (self.base / 'release').touch()
        terminal = self.terminal(request)
        self.assertEqual(terminal['state'], 'completed')
        self.assertEqual(terminal['exitCode'], 0)
        self.assertTrue(terminal['result']['saved'])
        self.assertFalse(terminal['result']['applied'])
        self.assertTrue(terminal['result']['restartRequired'])
        self.assertEqual((self.base / 'invocations').read_text().splitlines(), ['invocation'])
        self.assertEqual(self.entry('operation-start', request, 'control', 'stop')['operation'], terminal)
        self.entry('operation-start', request, 'logout', ok=False)

    def test_nonzero_exit_cannot_turn_structured_result_into_success(self):
        self.overrides.write_text('''cmd_diag_check() {
  echo '{"ok":true,"saved":true,"applied":false,"applyError":"actual detail","checks":[1,2]}'
  return 7
}
''')
        request = self.request('nonzero')
        self.entry('operation-start', request, 'diag-check')
        terminal = self.terminal(request)
        self.assertEqual(terminal['exitCode'], 7)
        self.assertFalse(terminal['result']['ok'])
        self.assertEqual(terminal['result']['applyError'], 'actual detail')
        self.assertEqual(terminal['result']['checks'], [1, 2])
        self.assertTrue(terminal['result']['saved'])

    def test_worker_ignores_hangup_after_acceptance(self):
        self.overrides.write_text('''cmd_diag_check() {
  touch "$TS_DIR/entered"
  while [ ! -f "$TS_DIR/release" ]; do sleep 0.03; done
  echo '{"ok":true,"finishedAfterHangup":true}'
}
''')
        request = self.request('hangup')
        self.entry('operation-start', request, 'diag-check')
        self.await_path('entered')
        directory = self.run / 'operations' / request
        for name in ('supervisor', 'runner'):
            os.kill(int((directory / name).read_text().split()[0]), signal.SIGHUP)
        (self.base / 'release').touch()
        self.assertTrue(self.terminal(request)['result']['finishedAfterHangup'])

    def test_cancel_stops_unregistered_actual_worker_descendants_and_no_bystander(self):
        self.script('bin/nested-control', '''trap '' TERM
printf '%s' "$$" >"$TEST_DIR/leaf.pid"
while :; do sleep 1; done
''')
        self.overrides.write_text('''cmd_diag_check() {
  sh "$TS_DIR/bin/nested-control" &
  wait
  echo '{"ok":true}'
}
''')
        bystander = subprocess.Popen(['sleep', '30'])
        def stop_bystander():
            if bystander.poll() is None:
                bystander.kill()
            bystander.wait(timeout=5)
        self.addCleanup(stop_bystander)
        request = self.request('cancel_tree')
        self.entry('operation-start', request, 'diag-check')
        path = self.await_path('leaf.pid')
        deadline = time.monotonic() + 3
        while not path.read_text() and time.monotonic() < deadline:
            time.sleep(0.02)
        leaf = int(path.read_text())
        cancelled = self.entry('cancel', request)
        self.assertTrue(cancelled['cancelled'])
        terminal = self.terminal(request)
        self.assertEqual(terminal['state'], 'cancelled')
        self.assertFalse(terminal['result']['ok'])
        self.assertNotEqual(self.shell('_proc_starttime ' + str(leaf), ok=False).returncode, 0)
        self.assertIsNone(bystander.poll())

    def test_commit_rejection_and_done_without_receipt_recover_as_unknown(self):
        request = self.request('interrupted')
        operation = self.run / 'operations' / request
        operation.mkdir(parents=True)
        (operation / 'durable').touch()
        (operation / 'command').write_text('control\n')
        (operation / 'done').touch()
        (operation / 'phase').symlink_to('committing')
        (operation / 'runner').write_text(f'{os.getpid()} 1 wrong-boot\n')
        (operation / 'output').write_text('{"ok":true}')
        (self.conf / 'foxytail.conf').write_text('TS_MODE=invalid\n')
        self.entry('cancel', request, ok=False)
        terminal = self.entry('operation-status', request)['operation']
        self.assertEqual(terminal['state'], 'interrupted')
        self.assertFalse(terminal['result']['ok'])
        self.assertEqual(terminal['exitCode'], 125)
        self.assertIn('unknown', terminal['result']['error'])
        self.assertTrue((operation / 'result.json').is_file())

    def test_backend_info_and_stop_work_with_bad_configuration(self):
        self.script('bin/id', 'echo 0\n')
        self.overrides.write_text('TS_MOD_DIR="$TS_DIR/module"\nTS_MOD_PROP="$TS_MOD_DIR/module.prop"\n')
        module = self.base / 'module'
        module.mkdir()
        (module / 'module.prop').write_text('version=vtest\nversionCode=123\n')
        (module / 'disable').touch()
        (self.conf / 'foxytail.conf').write_text('ROUTE_TABLE=1053\n')
        info = self.entry('backend-info')
        self.assertEqual((info['protocol'], info['moduleVersion'], info['versionCode']), (1, 'vtest', 123))
        self.assertTrue(info['disabled'])
        self.assertIn('hooks-get', info['commands'])
        request = self.request('bad_config_stop')
        self.entry('operation-start', request, 'control', 'stop')
        self.assertTrue(self.terminal(request)['result']['ok'])
        self.entry('operation-status', self.request('unknown'), ok=False)

    def test_rejected_commands_counts_payloads_and_tombstones_never_execute(self):
        for suffix, args in [('shell', ['sh', '-c', 'touch /bad']), ('login', ['login']),
                             ('read', ['artifact-read', 'art-' + 'a' * 32]),
                             ('extra', ['diag-check', 'extra']), ('huge', ['context-set', 'a' * 65537])]:
            request = self.request(suffix)
            self.entry('operation-start', request, *args, ok=False)
            self.assertFalse((self.run / 'operations' / request / 'durable').exists())
        request = self.request('pre_cancel')
        self.entry('cancel', request)
        self.entry('operation-start', request, 'control', 'stop', ok=False)
        self.assertFalse((self.base / 'service-calls').exists())
        self.entry('operation-status', '../escape', ok=False)

    def test_authkey_not_in_receipts_or_logs(self):
        self.overrides.write_text('''_dns_account_begin() { :; }
ts_cli() { printf 'leaked input: %s\\n' "$*"; return 9; }
''')
        secret = 'tskey-auth-PRIVATE_DONT_STORE'
        request = self.request('authkey')
        self.entry('operation-start', request, 'login-authkey', secret)
        terminal = self.terminal(request)
        self.assertFalse(terminal['result']['ok'])
        for directory in (self.run / 'operations' / request, self.run):
            for file in directory.iterdir():
                if file.is_file() and not file.is_symlink():
                    self.assertNotIn(secret.encode(), file.read_bytes(), str(file))

    def test_malformed_multiple_and_oversized_output_are_not_success(self):
        for suffix, body in [('empty', ':'), ('multiple', 'echo \'{"ok":true}\\n{"ok":true}\''),
                             ('oversize', 'head -c 1100000 /dev/zero | tr "\\000" x')]:
            self.overrides.write_text('cmd_diag_check() { ' + body + '; }\n')
            request = self.request(suffix)
            self.entry('operation-start', request, 'diag-check')
            terminal = self.terminal(request)
            self.assertFalse(terminal['result']['ok'])
            directory = self.run / 'operations' / request
            self.assertLess((directory / 'result.json').stat().st_size, 1048576)
            self.assertFalse((directory / 'output').exists())

    def test_private_retention_expires_without_replay_and_enforces_capacity(self):
        registry = self.run / 'operations'
        registry.mkdir(exist_ok=True)
        old_id = str(int(time.time()) - 90000) + '_old'
        old = registry / old_id
        old.mkdir()
        (old / 'durable').touch()
        (old / 'command').write_text('diag-check')
        self.entry('operation-status', old_id, ok=False)
        self.assertFalse(old.exists())
        self.entry('operation-start', old_id, 'diag-check', ok=False)
        for index in range(128):
            request = str(int(time.time())) + f'_capacity_{index}'
            directory = registry / request
            directory.mkdir()
            (directory / 'durable').touch()
            (directory / 'command').write_text('diag-check')
            (directory / 'result.json').write_text('{"ok":true,"operation":{"state":"completed"}}')
        self.entry('operation-start', self.request('full'), 'diag-check', ok=False)
        self.assertEqual(registry.stat().st_mode & 0o777, 0o700)

    def test_status_does_not_evict_valid_receipt_at_capacity(self):
        registry = self.run / 'operations'
        registry.mkdir(exist_ok=True)
        aged = int(time.time()) - 1000
        requested = f'{aged}_queried'
        for index in range(128):
            request = requested if index == 0 else f'{aged}_capacity_{index}'
            directory = registry / request
            directory.mkdir()
            (directory / 'durable').touch()
            (directory / 'command').write_text('diag-check')
            (directory / 'result.json').write_text(
                '{"ok":true,"operation":{"id":"%s","command":"diag-check",'
                '"state":"completed","result":{"ok":true}}}' % request)
        self.assertEqual(self.entry('operation-status', requested)['operation']['id'], requested)
        self.assertTrue((registry / requested).is_dir())

    def test_fixed_capability_and_readonly_hooks(self):
        self.script('bin/iptables', 'printf "%s\\n" "$*" >>"$TEST_DIR/iptables.calls"\n')
        self.assertTrue(self.entry('owner-capability')['available'])
        self.assertEqual((self.base / 'iptables.calls').read_text().strip(), '-m owner --help')
        (self.scripts / 'foxytail.tun.up').write_text('echo do-not-execute\n')
        hooks = self.entry('hooks-get')['hooks']
        self.assertEqual(hooks[0]['content'], 'echo do-not-execute\n')
        self.assertTrue(hooks[1]['missing'])
        (self.scripts / 'foxytail.tun.down').symlink_to(self.conf / 'foxytail.conf')
        self.entry('hooks-get', ok=False)

    def test_context_bound_rejects_without_modifying_saved_rules(self):
        before = (self.conf / 'context.conf').read_bytes()
        payload = base64.b64encode(b'#' * 49153).decode()
        self.entry('context-set', payload, ok=False)
        self.assertEqual((self.conf / 'context.conf').read_bytes(), before)
