"""Run the context script on the host with private paths and network command stubs."""
import os
import json
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
        self.source = self.source.replace('"$SERVICE" context', 'sh "$SERVICE" context')
        self.script.write_text(self.source)
        self.settings = install_settings(self.base)
        self.env = {**os.environ, 'TS_TEST_DIR': str(self.base),
                    'MODPATH': str(self.base / 'module')}
        self.rules = self.base / 'conf/context.conf'
        self.state = self.base / 'run/context.state'
        self.result = self.base / 'run/context.result.json'
        self.events = self.base / 'events'
        with self.settings.open('a') as stream:
            stream.write('''
network_snapshot() {
  [ ! -f "$TS_TEST_DIR/offline" ] || { echo '{"known":false}'; return 1; }
  _fixture_transport=cellular
  [ ! -f "$TS_TEST_DIR/ssid" ] || _fixture_transport=wifi
  [ ! -f "$TS_TEST_DIR/transport" ] || _fixture_transport=$(cat "$TS_TEST_DIR/transport")
  jqr -nc --arg t "$_fixture_transport" '{known:true,transport:$t,signature:$t}'
}
''')
        self.write_stub('scripts/foxytail.exitnode', '''
case "$1" in
  set) [ "$3" = --context ] || exit 2; _exit=$2 ;;
  clear) [ "$2" = --context ] || exit 2; _exit= ;;
  *) exit 2 ;;
esac
exec tailscale --socket=private set --exit-node="$_exit"
''')
        self.write_stub('bin/dumpsys', '''
printf 'SSID: "%s"\n' "$(cat "$TS_TEST_DIR/ssid")"
''')
        self.write_stub('scripts/foxytail.service', '''
printf '%s\n' "$*" >>"$TS_TEST_DIR/service-argv"
case "$1:$2" in context:up) set -- start ;; context:down) set -- stop ;; *) exit 2 ;; esac
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


    def test_failed_action_retries_and_only_success_records_context(self):
        self.rules.write_text('cellular:-:up')
        (self.base / 'fail-service-start').touch()
        self.assertNotEqual(self.run_script('check-once', ok=False).returncode, 0)
        self.assertFalse(self.state.exists())
        status = json.loads(self.run_script('status').stdout)
        self.assertFalse(status['running'])
        self.assertEqual(status['lastResult']['context'], 'cellular:-')
        self.assertEqual(status['lastResult']['error'], 'context-action-failed')
        self.assertFalse(status['lastResult']['ok'])
        self.run_script('check-once')
        completed = self.result.read_bytes()
        status = json.loads(self.run_script('status').stdout)
        self.assertTrue(status['lastResult']['ok'])
        self.assertIsInstance(status['lastResult']['at'], int)
        self.assertNotIn('error', status['lastResult'])
        self.run_script('check-once')
        self.assertEqual(self.result.read_bytes(), completed)
        self.assertEqual(self.events.read_text().splitlines(), ['service:start'] * 2)
        self.assertEqual(self.state.read_text(), 'cellular:-\n')


    def test_real_service_context_down_up_preserves_user_hold_and_trial(self):
        # Keep service dispatch, locks, config selection and lifecycle functions;
        # replace only process discovery/socket readiness and the daemon binary.
        service = (ROOT / 'tailscale/scripts/foxytail.service').read_text()
        service = service.replace('\ncase "$1" in', '''
daemon_pids() { [ ! -f "$TS_TEST_DIR/daemon-args" ] || printf '%s\\n' 123; }
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
        self.assertTrue((self.base / 'run/context-stop').exists())
        self.assertFalse((self.base / 'run/manual-stop').exists())
        self.assertFalse((self.base / 'daemon-args').exists())
        (self.base / 'ssid').unlink()
        self.run_script('check-once')

        self.assertFalse((self.base / 'run/context-stop').exists())
        self.assertIn('--socks5-server=localhost:1199',
                      (self.base / 'daemon-args').read_text())
        self.assertEqual((self.base / 'run/applied-config').read_text(), '.applied.test\n')
        self.assertEqual((self.base / 'run/settings.pending').read_text(), 'unapplied\n')
        self.assertEqual(self.state.read_text(), 'cellular:-\n')
        (self.base / 'daemon-args').unlink()
        (self.base / 'run/manual-stop').write_text('user hold\n')
        self.state.unlink()
        self.run_script('check-once')
        self.assertTrue((self.base / 'run/manual-stop').exists())
        self.assertFalse((self.base / 'daemon-args').exists())
        journal = self.base / 'state/config-trial'
        journal.mkdir(parents=True)
        (journal / 'status').write_text('running\n')
        (self.base / 'ssid').write_text('Home')
        self.run_script('check-once')
        self.assertEqual((journal / 'status').read_text(), 'running\n')

    def test_unknown_ethernet_and_vpn_never_match_cellular_rules(self):
        self.rules.write_text('cellular:-:down\nssid:Home:up\n')
        for transport in ('unknown', 'ethernet', 'vpn'):
            (self.base / 'transport').write_text(transport)
            self.run_script('check-once')
            self.assertEqual(self.state.read_text().strip(), transport + ':-')
        self.assertFalse(self.events.exists())


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


    def test_pending_without_snapshot_cannot_activate_saved_rules(self):
        self.rules.write_text('cellular:-:up')
        (self.base / 'run/settings.pending').write_text('unapplied\n')
        for action in ['start', 'check-once']:
            self.assertNotEqual(self.run_script(action, ok=False).returncode, 0)
        self.run_script('stop')
        self.run_script('validate', self.rules)
        self.assertFalse(self.events.exists())
        self.assertFalse(self.state.exists())

    def test_result_does_not_expose_arguments_or_claim_unsaved_execution(self):
        self.rules.write_text('cellular:-:exit-node:private-node.example')
        (self.base / 'fail-cli').touch()
        self.run_script('check-once', ok=False)
        previous = self.result.read_bytes()
        self.assertNotIn(b'private-node.example', previous)
        self.assertEqual(self.result.stat().st_mode & 0o777, 0o600)
        self.rules.write_text('cellular:-:up')
        self.assertFalse(json.loads(self.run_script('status').stdout)['lastResult']['ok'])
        self.assertEqual(self.result.read_bytes(), previous)
        self.run_script('stop')
        self.assertEqual(self.result.read_bytes(), previous)
        self.rules.write_text('')
        self.run_script('check-once')
        self.assertFalse(self.result.exists())
        self.rules.write_text('ssid:Other Network:up')
        self.run_script('check-once')
        self.assertIsNone(json.loads(self.run_script('status').stdout)['lastResult'])


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


    def test_disabled_context_keeps_result_without_process_or_rule_actions_and_can_restart(self):
        self.rules.write_text('cellular:-:up')
        self.run_script('check-once')
        previous = self.result.read_bytes()
        (self.base / 'conf/foxytail.conf').write_text('CONTEXT=off\n')
        self.run_script('start')
        self.run_script('check-once')
        self.assertEqual(self.result.read_bytes(), previous)
        self.assertEqual(self.events.read_text().splitlines(), ['service:start'])
        self.assertFalse((self.base / 'run/pids/foxytail.context.pid').exists())
        (self.base / 'conf/foxytail.conf').write_text('CONTEXT=on\n')
        with self.settings.open('a') as stream:
            stream.write('\nisleep() { _context_stop; }\n')
        self.run_script('start')
        self.assertEqual(self.events.read_text().splitlines(), ['service:start'] * 2)

    def test_running_context_stops_on_disabled_runtime_without_erasing_result(self):
        self.rules.write_text('cellular:-:up')
        with self.settings.open('a') as stream:
            stream.write('''
isleep() {
  echo slept >>"$TS_TEST_DIR/intervals"
  printf 'CONTEXT=off\n' >"$TS_CONF_DIR/foxytail.conf"
}
''')
        self.run_script('start')
        self.assertEqual((self.base / 'intervals').read_text().splitlines(), ['slept'])
        self.assertEqual(self.events.read_text().splitlines(), ['service:start'])
        self.assertTrue(json.loads(self.result.read_text())['ok'])
        self.assertFalse((self.base / 'run/pids/foxytail.context.pid').exists())


if __name__ == '__main__':
    unittest.main()
