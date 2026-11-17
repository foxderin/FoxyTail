"""Modern DNS lifecycle against a fake kernel, helper, and profile store."""
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import tempfile
import time
import unittest

from test_network import MOCK

ROOT = Path(__file__).resolve().parents[1]


class ModernDnsLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxytail-modern-dns-')
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.daemon_down)
        self.base = Path(self.temp.name)
        for directory in ('bin', 'run', 'state'):
            (self.base / directory).mkdir()
        self.env = {**os.environ, 'TEST_DIR': str(self.base),
                    'PATH': str(self.base / 'bin') + os.pathsep + os.environ['PATH'],
                    'MOCK_STATE': str(self.base / 'kernel.json'),
                    'FOXY_BOOT_ID': 'test-boot-1'}
        (self.base / 'kernel.json').write_text(json.dumps({'calls': [], 'chains': {}, 'rules': {}, 'routes': {}}))
        self.executable('mock', MOCK.replace('for name,rules in selected.items():',
            'for name,rules in selected.items():\n'
            '   if name=="OUTPUT":out.append("-P OUTPUT " + os.environ.get("MOCK_OUTPUT_POLICY", "ACCEPT"))'))
        for name in ('iptables', 'ip6tables', 'ip'):
            (self.base / 'bin' / name).symlink_to('mock')
        self.executable('tailscale', '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
p = Path(os.environ['TEST_DIR']); a = sys.argv[2:]
data = json.loads((p / 'profile.json').read_text())
if (p / 'cli-failed').exists(): sys.exit(1)
if a == ['switch', '--list', '--json']:
 print(json.dumps([{'id': data['id'], 'selected': True}]))
elif a == ['debug', 'prefs']:
 print(json.dumps({'CorpDNS': data['acceptDns'], 'Config': {'PrivateNodeKey': 'private-marker'}}))
elif a == ['status', '--json']:
 print(json.dumps({'Self': {'ID': data['self']}}))
elif a and a[0] == 'set':
 with (p / 'sets').open('a') as f: f.write(a[1] + '\\n')
 if (p / 'set-failed').exists(): sys.exit(1)
 if not (p / 'set-no-effect').exists():
  data['acceptDns'] = a[1].endswith('=true')
  (p / 'profile.json').write_text(json.dumps(data))
else: sys.exit(99)
''')
        self.executable('foxydns', '''#!/bin/sh
case "$1" in
  probe)
    if [ -f "$TEST_DIR/probe-response.json" ]; then cat "$TEST_DIR/probe-response.json"; exit "${PROBE_EXIT:-1}"; fi
    if [ -f "$TEST_DIR/probe-failed" ]; then echo '{"ok":false}'; exit 1; fi
    echo '{"ok":true,"queue":true,"conntrack":true,"socketContext":true}' ;;
  check) [ ! -f "$TEST_DIR/check-failed" ] ;;
  quiesce)
    [ ! -f "$TEST_DIR/quiesce-failed" ] || exit 1
    state="$TEST_DIR/run/foxydns.state.json"
    jq '.queueReady=false' "$state" >"$state.next" && mv "$state.next" "$state" ;;
  cleanup)
    [ ! -f "$TEST_DIR/cleanup-failed" ] || exit 1
    : >"$3" ;;
  legacy-cleanup) exit 0 ;;
  health)
    [ -f "$TEST_DIR/alive" ] && [ ! -f "$TEST_DIR/stale-helper" ] || exit 1
    state="$TEST_DIR/run/foxydns.state.json"
    port=$(jq -r '.listen | split(":") | last | tonumber' "$3")
    jq -e --argjson port "$port" --arg instance "${5:-fixture-instance}" \
      'select(.ready == true and .port == $port and .instance == $instance)' "$state" ;;
  watch)
    echo watch >>"$TEST_DIR/guard-watches"
    exit 1 ;;
  serve)
    [ ! -f "$TEST_DIR/bind-failed" ] || exit 1
    mode=$(jq -r .mode "$3")
    queue=false
    [ "$mode" != transparent ] || [ -f "$TEST_DIR/queue-failed" ] || queue=true
    if [ "$queue" = true ]; then
      journal=$(jq -r '.ownershipFile' "$3")
      printf '%s\\n' '{"boot":"fixture","port":1054}' >"$journal"
    fi
    touch "$TEST_DIR/alive"
    port=$(jq -r '.listen | split(":") | last' "$3")
    printf '{"ready":true,"queueReady":%s,"pid":100,"instance":"fixture-instance","port":%s,"updatedAt":%s}\\n' "$queue" "$port" "$(date +%s)" >"$5" ;;
  *) exit 99 ;;
esac
''')
        self.profile()
        self.daemon_up()
        (self.base / 'context.json').write_text(json.dumps({'suffix': 'example.ts.net', 'self': 'node-a', 'hosts': []}, separators=(',', ':')))
        self.config()
        self.runner = self.base / 'runner.sh'
        settings = (ROOT / 'tailscale/scripts/foxytail.lock.sh').read_text()
        locks = settings[settings.index('_proc_starttime() {'):settings.index('conf_lock_acquire() {')]
        self.runner.write_text('''
TS_DIR="$TEST_DIR"
TS_RUN_DIR="$TEST_DIR/run"
TS_BIN_DIR="$TEST_DIR/bin"
TS_SCRIPTS_DIR="$TEST_DIR/scripts"
TS_PID_DIR="$TS_RUN_DIR/pids"
TS_SOCKET="$TS_RUN_DIR/tailscaled.sock"
DNS_CONTEXT_FILE="$TS_RUN_DIR/dnsmasq.context.json"
ensure_run_dirs() { mkdir -p "$TS_RUN_DIR" "$TS_PID_DIR"; }
load_conf() { . "$TEST_DIR/config"; }
load_runtime_conf() { load_conf; }
jqr() { jq "$@"; }
ts_status_json() { _tsj_r=$1; shift; "$_tsj_r" "$@"; }
tmo() { shift; "$@"; }
log() { printf '%s: %s\\n' "$1" "$2" >>"$TEST_DIR/service-log"; }
rotate_log() { :; }
dns_pids() { :; }
# tailscaled liveness is separate from the foxydns listener (`alive`): the
# helper is stopped before pref_restore runs, so keying the daemon check to
# the helper marker would make every clean stop look daemon-down.
pids_of_path() { [ -f "$TEST_DIR/tailscaled-alive" ] && echo 100; return 0; }
TS_DAEMON_CMD=tailscaled
redirect_teardown() { return 0; }
redirect6_teardown() { return 0; }
legacy_capture_cleanup() { return 0; }
current_dns_context() { cat "$TEST_DIR/context.json"; }
stop_by_pids() { [ ! -f "$TEST_DIR/stop-failed" ] && rm -f "$TEST_DIR/alive"; }
ipv6_nat_available() { ip6tables -t nat -S OUTPUT >/dev/null 2>&1; }
ensure_ipv6_nat() { ipv6_nat_available; }
ipv6_module_status() { echo not-checked; }
native_dns_present() { test -f "$TEST_DIR/native-present"; }
dns_hijack_conflict() { test -f "$TEST_DIR/other-dns"; }
flush_android_dns_cache() { echo flush >>"$TEST_DIR/flushes"; }
''' + locks + '\n. ' + shlex.quote(str(ROOT / 'tailscale/scripts/foxytail.dns-modern.sh')) + '\n. ' + shlex.quote(str(ROOT / 'tailscale/scripts/foxytail.dns-pref.sh')) + '''
_proc_starttime() { ps -p "$1" -o pid= | tr -d ' '; }
boot_identity() { echo fixture-boot; }
modern_pids() {
  [ -f "$TEST_DIR/alive" ] || return 0
  echo 100
}
if [ "${REAL_GUARD_TEST:-0}" != 1 ]; then
  modern_guard_start() { touch "$TEST_DIR/guard-active"; }
  modern_guard_stop() { rm -f "$TEST_DIR/guard-active"; }
  modern_guard_alive() { test -f "$TEST_DIR/guard-active"; }
else
  _proc_starttime() { if [ "$1" = 100 ]; then echo 100; else ps -p "$1" -o pid= | tr -d ' '; fi; }
  _conf_pid_stamp() { _proc_starttime "$1"; }
  boot_identity() { echo fixture-boot; }
fi
load_conf
"$@"
''')


    def test_conntrack_cleanup_failure_retains_journal_and_listener(self):
        self.run_script('modern_dns_start')
        journal = self.base / 'state/foxydns-flows.jsonl'
        before = journal.read_bytes()
        (self.base / 'cleanup-failed').touch()
        self.run_script('modern_dns_stop', ok=False)
        self.assertEqual(journal.read_bytes(), before)
        self.assertTrue(self.status()['listenerReady'])
        self.assertTrue(self.status()['repairNeeded'])
        (self.base / 'cleanup-failed').unlink()
        self.run_script('modern_dns_stop')
        self.assertFalse(self.status()['listenerReady'])
        self.assertEqual(journal.read_bytes(), b'')

    def executable(self, name, contents):
        path = self.base / 'bin' / name
        path.write_text(contents)
        path.chmod(0o755)

    def profile(self, accept=True, profile='profile-a', node='node-a'):
        (self.base / 'profile.json').write_text(json.dumps({'acceptDns': accept, 'id': profile, 'self': node}))

    def config(self, mode='transparent', ipv6='on'):
        (self.base / 'config').write_text(f'DNS_MODE={mode}\nMAGIC_DNS=on\nDNS_PORT=1054\nIPV6={ipv6}\n')

    def run_script(self, *args, ok=True):
        result = subprocess.run(['sh', str(self.runner), *args], env=self.env,
                                text=True, capture_output=True, timeout=20)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def status(self):
        return json.loads(self.run_script('modern_dns_status', '--json'))

    def sets(self):
        path = self.base / 'sets'
        return path.read_text().splitlines() if path.exists() else []

    def daemon_up(self):
        # tailscaled is assumed to be running by default; individual tests
        # stop it via daemon_down to exercise the daemon-down restore path.
        (self.base / 'tailscaled-alive').touch()

    def daemon_down(self):
        marker = self.base / 'tailscaled-alive'
        if marker.exists():
            marker.unlink()

    def kernel(self):
        return json.loads((self.base / 'kernel.json').read_text())

    def test_transparent_rules_capture_only_marked_flow_and_preserve_native_preference(self):
        self.run_script('modern_dns_start')
        status = self.status()
        self.assertTrue(status['listenerReady']); self.assertTrue(status['interception4']); self.assertTrue(status['interception6'])
        self.assertEqual(status['state'], 'running'); self.assertFalse(status['repairNeeded'])
        kernel = self.kernel()
        for cmd in ('iptables', 'ip6tables'):
            queue = kernel['chains'][cmd + ':mangle']['FOXY_DNS_QUEUE']
            capture = kernel['chains'][cmd + ':nat']['FOXY_DNS_CAPTURE']
            self.assertEqual(queue[0], ['-m', 'owner', '--uid-owner', '0', '--gid-owner', '65533', '-j', 'RETURN'])
            self.assertEqual(capture[0], queue[0])
            self.assertEqual(len(queue), 3); self.assertEqual(len(capture), 3)
            self.assertTrue(all('--queue-bypass' in row for row in queue[1:]))
            self.assertTrue(all('0x20000000/0x20000000' in row and '1054' in row for row in capture[1:]))
        self.assertFalse(any('CONNMARK' in arg for row in kernel['calls'] for arg in row))
        journal = (self.base / 'state/foxydns-preferences.json').read_text()
        self.assertNotIn('private-marker', journal)
        self.assertTrue(json.loads(journal)['entries'][0]['original'])
        self.run_script('modern_dns_stop')
        self.assertEqual(self.sets(), ['--accept-dns=false', '--accept-dns=true'])
        self.assertFalse(self.status()['listenerReady'])


    def test_original_false_is_never_reenabled_on_stop(self):
        self.profile(accept=False)
        self.run_script('modern_dns_start'); self.run_script('modern_dns_stop')
        self.assertEqual(self.sets(), [])
        self.assertFalse(json.loads((self.base / 'profile.json').read_text())['acceptDns'])


    def test_user_preference_drift_is_respected_and_not_repeatedly_overwritten(self):
        self.run_script('modern_dns_start')
        self.profile(accept=True)
        self.run_script('modern_dns_start'); self.run_script('modern_dns_start')
        status = self.status()
        self.assertEqual(status['reason'], 'native-policy-changed')
        self.assertFalse(status['repairNeeded']); self.assertFalse(status['interception4'])
        self.assertEqual(self.sets(), ['--accept-dns=false'])
        self.run_script('modern_dns_stop')
        self.assertEqual(self.sets(), ['--accept-dns=false'])

    def test_account_change_never_restores_old_preference_into_new_profile(self):
        self.run_script('modern_dns_start')
        self.profile(accept=False, profile='profile-b', node='node-b')
        self.run_script('modern_dns_stop', ok=False)
        self.assertEqual(self.sets(), ['--accept-dns=false'])
        entries = json.loads((self.base / 'state/foxydns-preferences.json').read_text())['entries']
        self.assertEqual(entries[0]['id'], 'profile-a')
        self.assertFalse(self.status()['interception4'])

    def test_listener_bind_failure_cannot_change_native_dns_or_capture_packets(self):
        (self.base / 'bind-failed').touch()
        self.run_script('modern_dns_start', ok=False)
        status = self.status()
        self.assertFalse(status['listenerReady']); self.assertFalse(status['interception4'])
        self.assertEqual(status['reason'], 'listener-failed')
        self.assertEqual(self.sets(), [])

    def test_failed_preference_write_and_unverified_write_never_install_rules(self):
        for failure in ('set-failed', 'set-no-effect'):
            with self.subTest(failure=failure):
                (self.base / failure).touch()
                self.run_script('modern_dns_start', ok=False)
                self.assertFalse(self.status()['interception4'])
                self.assertTrue(json.loads((self.base / 'profile.json').read_text())['acceptDns'])
                (self.base / failure).unlink()
                self.run_script('modern_dns_stop')

    def test_interception_failure_rolls_back_native_preference_without_foreign_rules(self):
        self.env['MOCK_NO_OWNER'] = '1'
        self.run_script('modern_dns_start', ok=False)
        self.assertEqual(self.sets(), ['--accept-dns=false', '--accept-dns=true'])
        self.assertFalse(self.status()['interception4'])
        self.assertTrue(self.status()['listenerReady'])


    def test_cleanup_failure_retains_listener_while_redirect_can_still_exist(self):
        self.run_script('modern_dns_start')
        self.env['MOCK_FAIL_IPTABLES_DELETE'] = '1'
        self.run_script('modern_dns_stop', ok=False)
        self.assertTrue(self.status()['listenerReady'])
        self.env.pop('MOCK_FAIL_IPTABLES_DELETE')
        self.run_script('modern_dns_stop')
        self.assertFalse(self.status()['listenerReady'])


    def test_monitor_failure_with_healthy_listener_also_withdraws_capture(self):
        self.run_script('modern_dns_start')
        self.env['REAL_GUARD_TEST'] = '1'
        self.run_script('modern_dns_guard')
        self.assertEqual((self.base / 'run/foxydns.reason').read_text().strip(), 'guard-failed')
        self.assertNotIn('FOXY_DNS_CAPTURE', self.kernel()['chains']['iptables:nat'])
        self.assertTrue((self.base / 'alive').exists())


    def test_mark_collision_in_foreign_rules_falls_back_without_changing_them(self):
        kernel = self.kernel()
        foreign = ['-m', 'mark', '--mark', '0x0/0x20000000', '-j', 'ACCEPT']
        kernel['chains']['iptables:mangle'] = {'OUTPUT': [foreign]}
        (self.base / 'kernel.json').write_text(json.dumps(kernel))
        self.run_script('modern_dns_start')
        status = self.status()
        self.assertEqual(status['reason'], 'capture-mark-conflict')
        self.assertTrue(status['listenerReady']); self.assertFalse(status['interception4'])
        self.assertFalse(status['repairNeeded'])
        self.assertEqual(self.kernel()['chains']['iptables:mangle']['OUTPUT'], [foreign])


    def test_active_account_transition_does_not_claim_departing_profile(self):
        marker = self.base / 'run/dns-account-transition'
        marker.symlink_to(f'{os.getpid()}:{os.getpid()}:fixture-boot')
        self.run_script('modern_dns_start')
        self.assertFalse((self.base / 'alive').exists())
        self.assertEqual(self.sets(), [])


    def test_output_drop_policy_is_preserved_and_never_bypassed(self):
        self.env['MOCK_OUTPUT_POLICY'] = 'DROP'
        self.run_script('modern_dns_start')
        status = self.status()
        self.assertTrue(status['listenerReady']); self.assertFalse(status['interception4'])
        self.assertEqual(status['reason'], 'packet-policy-conflict')
        self.assertFalse(status['repairNeeded'])
        self.assertFalse(any('-P' in row for row in self.kernel()['calls']))


    def test_capability_failure_is_private_sanitized_and_logged_only_on_change(self):
        response = self.base / 'probe-response.json'
        response.write_text(json.dumps({'ok': False, 'error': 'INET_DIAG unavailable\nnot supported',
                                        'prefs': {'private': 'must-not-persist'}, 'queries': ['private.example']}))
        self.run_script('modern_dns_start')
        path = self.base / 'run/foxydns.capabilities.json'
        expected = {'ok': False, 'error': 'INET_DIAG unavailable not supported', 'bootId': 'test-boot-1'}
        self.assertEqual(json.loads(path.read_text()), expected)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        stamp = path.stat().st_mtime_ns
        log = (self.base / 'service-log').read_text()
        self.assertEqual(len(log.splitlines()), 1)
        for _ in range(2):
            self.assertEqual(self.status()['capabilityError'], expected['error'])
        self.run_script('modern_dns_start')
        self.assertEqual(path.stat().st_mtime_ns, stamp)
        self.assertEqual((self.base / 'service-log').read_text(), log)
        response.unlink()
        self.run_script('modern_dns_start')
        self.assertEqual(json.loads(path.read_text()), {'ok': True, 'bootId': 'test-boot-1'})
        self.assertIsNone(self.status()['capabilityError'])

    def test_malformed_or_failed_probe_cannot_persist_a_success_claim(self):
        response = self.base / 'probe-response.json'
        for value in ('not-json', '{"ok":false}\n{"ok":true}',
                      '{"ok":true,"queue":true,"conntrack":true,"socketContext":true}'):
            with self.subTest(value=value):
                response.write_text(value)
                self.run_script('modern_probe_capabilities', ok=False)
                saved = json.loads((self.base / 'run/foxydns.capabilities.json').read_text())
                self.assertFalse(saved['ok']); self.assertTrue(saved['error'])
                self.assertEqual(set(saved), {'ok', 'error', 'bootId'})

    def test_capabilities_cache_is_scoped_to_the_boot_that_recorded_it(self):
        # Kernel reflashes must invalidate the cached verdict: a "not
        # supported" written under boot N must not survive into boot N+1,
        # and capabilityError must not surface the stale boot's reason
        # alongside the now-null transparentAvailable.
        response = self.base / 'probe-response.json'
        response.write_text(json.dumps({'ok': False, 'error': 'INET_DIAG unavailable'}))
        self.run_script('modern_probe_capabilities', ok=False)
        status = self.status()
        self.assertEqual(status['transparentAvailable'], False)
        self.assertEqual(status['transparentUnavailableReason'], 'INET_DIAG unavailable')
        # Simulate a kernel reflash: same cache file, different boot id.
        self.env['FOXY_BOOT_ID'] = 'test-boot-2'
        status = json.loads(self.run_script('modern_dns_status', '--json'))
        self.assertIsNone(status['transparentAvailable'])
        self.assertIsNone(status['transparentUnavailableReason'])
        # capabilityError must come from the same boot-filtered source; the
        # stale boot's error text must not leak through any status field.
        self.assertIsNone(status['capabilityError'])
        # A fresh probe under the new boot records a new verdict.
        self.env['PROBE_EXIT'] = '0'
        response.write_text(json.dumps({'ok': True, 'queue': True, 'conntrack': True, 'socketContext': True}))
        self.run_script('modern_probe_capabilities')
        saved = json.loads((self.base / 'run/foxydns.capabilities.json').read_text())
        self.assertEqual(saved, {'ok': True, 'bootId': 'test-boot-2'})
        status = json.loads(self.run_script('modern_dns_status', '--json'))
        self.assertEqual(status['transparentAvailable'], True)
        self.assertIsNone(status['capabilityError'])


if __name__ == '__main__':
    unittest.main()
