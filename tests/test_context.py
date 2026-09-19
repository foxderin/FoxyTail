"""Run the context script on the host with private paths and network command stubs."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from runtime_fixture import install_settings

ROOT = Path(__file__).resolve().parents[1]


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='foxytail-context-test-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        for name in ['scripts', 'conf', 'bin', 'run/pids']:
            (self.base / name).mkdir(parents=True)
        self.script = self.base / 'scripts/foxytail.context'
        self.source = (ROOT / 'tailscale/scripts/foxytail.context').read_text()
        # Invoke the private service stub through sh, as other lifecycle tests
        # do, so host executable-file policies do not interfere with fixtures.
        self.source = self.source.replace('"$SERVICE" start --applied', 'sh "$SERVICE" start --applied')
        self.source = self.source.replace('"$SERVICE" stop', 'sh "$SERVICE" stop')
        self.script.write_text(self.source)
        self.settings = install_settings(self.base)
        self.env = {**os.environ, 'TS_TEST_DIR': str(self.base),
                    'MODPATH': str(self.base / 'module')}
        self.rules = self.base / 'conf/context.conf'
        self.state = self.base / 'run/context.state'
        self.events = self.base / 'events'
        self.write_stub('bin/ip', '''
if [ -f "$TS_TEST_DIR/offline" ]; then exit 0; fi
if [ -f "$TS_TEST_DIR/ssid" ]; then
  echo 'default dev wlan0'
else
  echo 'default dev rmnet0'
fi
''')
        self.write_stub('bin/dumpsys', '''
printf 'SSID: "%s"\n' "$(cat "$TS_TEST_DIR/ssid")"
''')
        self.write_stub('scripts/foxytail.service', '''
printf '%s\n' "$*" >>"$TS_TEST_DIR/service-argv"
printf 'service:%s\n' "$1" >>"$TS_TEST_DIR/events"
if [ -f "$TS_TEST_DIR/fail-service-$1" ]; then
  rm "$TS_TEST_DIR/fail-service-$1"
  exit 9
fi
''')
        self.write_stub('bin/tailscale', '''
printf 'cli:%s\n' "$3" >>"$TS_TEST_DIR/events"
if [ -f "$TS_TEST_DIR/fail-cli" ]; then
  rm "$TS_TEST_DIR/fail-cli"
  exit 9
fi
''')

    def write_stub(self, name, body):
        path = self.base / name
        path.write_text('#!/bin/sh\n' + body)
        path.chmod(0o755)

    def run_script(self, *args, ok=True):
        result = subprocess.run(['sh', str(self.script), *map(str, args)],
                                cwd=self.base, env=self.env, text=True,
                                capture_output=True, timeout=10)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def run_checks(self, body):
        # Keep the real initialization/functions; replace only dispatch to run
        # consecutive polling rounds in one process, without a real sleep.
        runner = self.base / 'scripts/checks'
        runner.write_text(self.source[:self.source.index('\ncase "$1" in')] +
                          '\nensure_run_dirs || exit 1\n' + body)
        result = subprocess.run(['sh', str(runner)], cwd=self.base,
                                env=self.env, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_validation_accepts_supported_syntax_and_eof(self):
        for text in ['', '\n \t# comment\r\n', 'cellular:-:no-exit-node',
                     'ssid:Home Wifi:down\ncellular:-:up\n',
                     '  ssid:家里的 Wi-Fi:exit-node:node-1.example.ts.net\r\n',
                     'ssid:Back\\slash:up', 'ssid:myunknownwifi:up',
                     'ssid: leading and trailing :down',
                     'cellular:-:exit-node:100.64.0.1',
                     'cellular:-:exit-node:fd7a:115c:a1e0::1',
                     'cellular:-:exit-node:::1']:
            with self.subTest(text=text):
                self.rules.write_bytes(text.encode())
                result = self.run_script('validate', self.rules)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, '')
        self.assertFalse(self.events.exists())

    def test_validation_reports_line_and_rejects_bad_fields(self):
        for rule in ['bogus:-:up', 'cellular:any:up', 'cellular::down',
                     'ssid::up', 'ssid:   :up', 'ssid:Home', 'ssid:Home:',
                     'ssid:Home:restart', 'ssid:Home:down:extra', 'ssid:Home:up:',
                     'ssid:Home:no-exit-node:node', 'ssid:Home:exit-node',
                     'ssid:Home:exit-node:', 'ssid:Home:exit-node:two nodes',
                     'ssid:Home:exit-node:$(touch unsafe)',
                     'ssid:Home:Office:up', 'ssid:Home#Wifi:up',
                     'ssid:Home:up # comment', 'ssid:"Home":up',
                     'ssid:Home\tWifi:up', 'ssid:Home\x00Wifi:up',
                     'ssid:unknown:down', 'ssid:<unknown ssid>:down',
                     'ssid:<none>:up']:
            with self.subTest(rule=rule):
                self.rules.write_bytes(('# heading\n\n' + rule).encode())
                result = self.run_script('validate', self.rules, ok=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f'{self.rules}:3:', result.stderr)
                self.assertEqual(result.stdout, '')
        self.assertFalse(self.events.exists())
        self.assertFalse((self.base / 'unsafe').exists())

    def test_validate_requires_a_regular_file_and_does_not_load_config(self):
        self.rules.write_text('cellular:-:up')
        (self.base / 'conf/foxytail.conf').write_text('TS_MODE=invalid\n')
        self.run_script('validate', self.rules)
        for args in [('validate',), ('validate', self.base / 'missing'),
                     ('validate', self.base), ('validate', self.rules, 'extra')]:
            with self.subTest(args=args):
                self.assertNotEqual(self.run_script(*args, ok=False).returncode, 0)
        link = self.base / 'link'
        link.symlink_to(self.rules)
        self.assertNotEqual(self.run_script('validate', link, ok=False).returncode, 0)
        self.assertFalse((self.base / 'run/stats').exists())

    def test_stop_bypasses_bad_main_and_routes_config_but_start_does_not(self):
        self.rules.write_text('cellular:-:up')
        for name, value in [('foxytail.conf', 'TS_MODE=invalid\n'),
                            ('routes.conf', 'ROUTE_SCOPE=invalid\n')]:
            with self.subTest(name=name):
                conf = self.base / 'conf' / name
                conf.write_text(value)
                pid = self.base / 'run/pids/foxytail.context.pid'
                pid.write_text('99999999\n')
                self.run_script('stop')
                self.assertFalse(pid.exists())
                for action in ['start', 'check-once']:
                    self.assertNotEqual(self.run_script(action, ok=False).returncode, 0)
                conf.unlink()
        self.assertFalse(self.events.exists())

    def test_stop_propagates_cleanup_failure_without_loading_config(self):
        (self.base / 'conf/foxytail.conf').write_text('TS_MODE=invalid\n')
        with self.settings.open('a') as stream:
            stream.write('\ndaemon_stop_pidfile() { return 9; }\n')
        self.assertEqual(self.run_script('stop', ok=False).returncode, 9)

    def test_absent_empty_or_malformed_rules_never_run_actions(self):
        for rules in [None, '', '# comments only', 'cellular:-:up\ninvalid',
                      'cellular:-:down\nssid:Home:typo']:
            with self.subTest(rules=rules):
                if rules is None:
                    self.rules.unlink(missing_ok=True)
                else:
                    self.rules.write_text(rules)
                for action in ['start', 'check-once']:
                    result = self.run_script(action, ok=False)
                    self.assertEqual(result.returncode == 0,
                                     rules in [None, '', '# comments only'])
                self.assertFalse(self.events.exists())
                self.assertFalse(self.state.exists())

    def test_eof_rule_executes_once_and_success_is_cached(self):
        self.rules.write_text('cellular:-:no-exit-node')
        self.run_script('check-once')
        self.run_script('check-once')
        self.assertEqual(self.events.read_text().splitlines(), ['cli:--exit-node='])
        self.assertEqual(self.state.read_text(), 'cellular:-\n')

    def test_failed_action_retries_and_only_success_records_context(self):
        self.rules.write_text('cellular:-:up')
        (self.base / 'fail-service-start').touch()
        self.assertNotEqual(self.run_script('check-once', ok=False).returncode, 0)
        self.assertFalse(self.state.exists())
        self.run_script('check-once')
        self.run_script('check-once')
        self.assertEqual(self.events.read_text().splitlines(), ['service:start'] * 2)
        self.assertEqual(self.state.read_text(), 'cellular:-\n')

    def test_up_uses_applied_service_start_and_down_uses_stop(self):
        self.rules.write_text('cellular:-:up\ncellular:-:down')
        self.run_script('check-once')
        self.assertEqual((self.base / 'service-argv').read_text().splitlines(),
                         ['start --applied', 'stop'])

    def test_real_service_down_then_applied_up_clears_manual_stop(self):
        # Keep service dispatch, locks, config selection and lifecycle functions;
        # replace only process discovery/socket readiness and the daemon binary.
        service = (ROOT / 'tailscale/scripts/foxytail.service').read_text()
        service = service.replace('\ncase "$1" in', '''
daemon_pids() { :; }
wait_socket() { wait "$!"; }

case "$1" in''', 1)
        (self.base / 'scripts/foxytail.service').write_text(service)
        self.write_stub('bin/tailscaled', '''
printf '%s\n' "$*" >"$TS_TEST_DIR/daemon-args"
''')
        applied = self.base / 'run/.applied.test'
        applied.mkdir()
        (applied / 'foxytail.conf').write_text('TS_MODE=proxy\nSOCKS_PORT=1199\n')
        (applied / 'routes.conf').write_text('')
        (applied / 'context.conf').write_text('ssid:Home:down\ncellular:-:up')
        (self.base / 'run/applied-config').write_text('.applied.test\n')
        (self.base / 'run/settings.pending').write_text('unapplied\n')
        (self.base / 'conf/foxytail.conf').write_text('TS_MODE=invalid\n')
        (self.base / 'ssid').write_text('Home')

        self.run_script('check-once')
        self.assertTrue((self.base / 'run/manual-stop').exists())
        self.assertFalse((self.base / 'daemon-args').exists())
        (self.base / 'ssid').unlink()
        self.run_script('check-once')

        self.assertFalse((self.base / 'run/manual-stop').exists())
        self.assertIn('--socks5-server=localhost:1199',
                      (self.base / 'daemon-args').read_text())
        self.assertEqual((self.base / 'run/applied-config').read_text(), '.applied.test\n')
        self.assertEqual((self.base / 'run/settings.pending').read_text(), 'unapplied\n')
        self.assertEqual(self.state.read_text(), 'cellular:-\n')

    def test_partial_retry_replays_idempotent_actions_in_order(self):
        self.rules.write_text('cellular:-:up\ncellular:-:exit-node:first\n'
                              'cellular:-:exit-node:second')
        (self.base / 'fail-cli').touch()
        self.run_checks('''
check_once && exit 10
[ ! -e "$STATE_FILE" ] || exit 11
check_once || exit 12
check_once || exit 13
''')
        self.assertEqual(self.events.read_text().splitlines(), [
            'service:start', 'cli:--exit-node=first', 'cli:--exit-node=second',
            'service:start', 'cli:--exit-node=first', 'cli:--exit-node=second'])
        self.assertEqual(self.state.read_text(), 'cellular:-\n')

    def test_partial_retry_restarts_service_stopped_by_later_success(self):
        self.rules.write_text('cellular:-:up\ncellular:-:exit-node:first\ncellular:-:down')
        (self.base / 'fail-cli').touch()
        with (self.base / 'scripts/foxytail.service').open('a') as stream:
            stream.write('''
case "$1" in
  start) touch "$TS_TEST_DIR/service-running" ;;
  stop) rm -f "$TS_TEST_DIR/service-running" ;;
esac
''')
        with (self.base / 'bin/tailscale').open('a') as stream:
            stream.write('\n[ -f "$TS_TEST_DIR/service-running" ] || exit 9\n')
        self.run_checks('''
check_once && exit 10
[ ! -e "$STATE_FILE" ] || exit 11
[ ! -e "$TS_TEST_DIR/service-running" ] || exit 12
check_once || exit 13
check_once || exit 14
''')
        self.assertEqual(self.events.read_text().splitlines(), [
            'service:start', 'cli:--exit-node=first', 'service:stop'] * 2)
        self.assertEqual(self.state.read_text(), 'cellular:-\n')

    def test_context_change_after_partial_success_reapplies_previous_context(self):
        self.rules.write_text('ssid:Home:up\ncellular:-:down\ncellular:-:exit-node:first')
        (self.base / 'ssid').write_text('Home')
        self.run_checks('''
check_once || exit 10
rm "$TS_TEST_DIR/ssid"
touch "$TS_TEST_DIR/fail-cli"
check_once && exit 11
[ ! -e "$STATE_FILE" ] || exit 12
printf Home >"$TS_TEST_DIR/ssid"
check_once || exit 13
''')
        self.assertEqual(self.events.read_text().splitlines(), [
            'service:start', 'service:stop', 'cli:--exit-node=first', 'service:start'])
        self.assertEqual(self.state.read_text(), 'ssid:Home\n')

    def test_resident_retries_using_existing_loop(self):
        self.rules.write_text('cellular:-:up')
        (self.base / 'fail-service-start').touch()
        with self.settings.open('a') as stream:
            stream.write('''
isleep() {
  _test_round=$((${_test_round:-0} + 1))
  [ "$_test_round" -lt 3 ] || _context_stop
}
''')
        self.run_script('start')
        self.assertEqual(self.events.read_text().splitlines(), ['service:start'] * 2)
        self.assertEqual(self.state.read_text(), 'cellular:-\n')
        self.assertFalse((self.base / 'run/pids/foxytail.context.pid').exists())

    def test_rule_change_after_partial_success_applies_new_rules(self):
        self.rules.write_text('cellular:-:up\ncellular:-:exit-node:first')
        (self.base / 'fail-cli').touch()
        self.run_checks('''
check_once && exit 10
printf 'cellular:-:down\n' >"$RULES_FILE"
check_once || exit 11
''')
        self.assertEqual(self.events.read_text().splitlines(), [
            'service:start', 'cli:--exit-node=first', 'service:stop'])

    def test_runtime_snapshot_hides_desired_rules_and_refreshes_every_round(self):
        self.rules.write_text('cellular:-:down')
        (self.base / 'conf/foxytail.conf').write_text('TS_MODE=invalid\n')
        (self.base / 'run/settings.pending').write_text('unapplied\n')
        for name, rule in [('.applied.old', 'cellular:-:up'),
                           ('.applied.next', 'cellular:-:no-exit-node')]:
            directory = self.base / 'run' / name
            directory.mkdir()
            (directory / 'foxytail.conf').write_text('TS_MODE=bridge\n')
            (directory / 'routes.conf').write_text('')
            (directory / 'context.conf').write_text(rule)
        (self.base / 'run/applied-config').write_text('.applied.old\n')
        self.run_script('check-once')
        self.assertEqual(self.events.read_text().splitlines(), ['service:start'])
        self.run_checks('''
check_once || exit 10
printf '.applied.next\n' >"$TS_RUN_DIR/applied-config"
check_once || exit 11
check_once || exit 12
''')
        self.assertEqual(self.events.read_text().splitlines(), [
            'service:start', 'cli:--exit-node='])

    def test_snapshot_change_reapplies_identical_rules(self):
        for name in ['.applied.old', '.applied.next']:
            directory = self.base / 'run' / name
            directory.mkdir()
            (directory / 'foxytail.conf').write_text('TS_MODE=bridge\n')
            (directory / 'routes.conf').write_text('')
            (directory / 'context.conf').write_text('cellular:-:up\ncellular:-:exit-node:first')
        (self.base / 'run/applied-config').write_text('.applied.old\n')
        self.run_checks('''
check_once || exit 10
printf '.applied.next\n' >"$TS_RUN_DIR/applied-config"
check_once || exit 11
''')
        self.assertEqual(self.events.read_text().splitlines(), [
            'service:start', 'cli:--exit-node=first', 'service:start', 'cli:--exit-node=first'])

    def test_pending_without_snapshot_cannot_activate_saved_rules(self):
        self.rules.write_text('cellular:-:up')
        (self.base / 'run/settings.pending').write_text('unapplied\n')
        for action in ['start', 'check-once']:
            self.assertNotEqual(self.run_script(action, ok=False).returncode, 0)
        self.run_script('stop')
        self.run_script('validate', self.rules)
        self.assertFalse(self.events.exists())
        self.assertFalse(self.state.exists())

    def test_special_ssids_match_literally_and_unknown_or_offline_does_not(self):
        for ssid in ['Home Wifi', '家里的 Wi-Fi', 'Back\\slash', 'myunknownwifi',
                     ' leading and trailing ', '$(touch unsafe)']:
            with self.subTest(ssid=ssid):
                self.rules.write_text(f'ssid:{ssid}:up')
                (self.base / 'ssid').write_text(ssid)
                self.state.unlink(missing_ok=True)
                self.run_script('check-once')
        self.assertEqual(self.events.read_text().splitlines(), ['service:start'] * 6)
        self.assertFalse((self.base / 'unsafe').exists())
        self.events.unlink()
        for ssid in ['', 'unknown', '<unknown ssid>', '<none>']:
            (self.base / 'ssid').write_text(ssid)
            self.run_script('check-once')
        (self.base / 'offline').touch()
        self.run_script('check-once')
        self.assertFalse(self.events.exists())


if __name__ == '__main__':
    unittest.main()
