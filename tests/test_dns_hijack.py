"""Hijack-mode DNS lifecycle against a fake kernel, helper, and profile store."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

from test_network import MOCK

ROOT = Path(__file__).resolve().parents[1]


class HijackDnsLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxytail-hijack-dns-')
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
    if [ "$4" = --hijack ]; then
      if [ -f "$TEST_DIR/hijack-probe-response.json" ]; then cat "$TEST_DIR/hijack-probe-response.json"; exit "${PROBE_EXIT:-1}"; fi
      if [ -f "$TEST_DIR/hijack-probe-failed" ]; then echo '{"ok":false,"error":"injection denied"}'; exit 1; fi
      echo '{"ok":true,"queue":true,"inject":true}'; exit 0
    fi
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
    jq -e --argjson port "$port" --arg instance "${5:-fixture-instance}" \\
      'select(.ready == true and .port == $port and .instance == $instance)' "$state" ;;
  watch)
    echo watch >>"$TEST_DIR/guard-watches"
    exit 1 ;;
  serve)
    [ ! -f "$TEST_DIR/bind-failed" ] || exit 1
    mode=$(jq -r .mode "$3")
    queue=false
    case "$mode" in
      transparent|hijack) [ -f "$TEST_DIR/queue-failed" ] || queue=true ;;
    esac
    if [ "$mode" = transparent ] && [ "$queue" = true ]; then
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
modern_guard_start() { touch "$TEST_DIR/guard-active"; }
modern_guard_stop() { rm -f "$TEST_DIR/guard-active"; }
modern_guard_alive() { test -f "$TEST_DIR/guard-active"; }
load_conf
"$@"
''')

    def executable(self, name, contents):
        path = self.base / 'bin' / name
        path.write_text(contents)
        path.chmod(0o755)

    def profile(self, accept=True, profile='profile-a', node='node-a'):
        (self.base / 'profile.json').write_text(json.dumps({'acceptDns': accept, 'id': profile, 'self': node}))

    def config(self, mode='hijack', ipv6='on'):
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
        (self.base / 'tailscaled-alive').touch()

    def daemon_down(self):
        marker = self.base / 'tailscaled-alive'
        if marker.exists():
            marker.unlink()

    def kernel(self):
        return json.loads((self.base / 'kernel.json').read_text())

    def test_hijack_queues_udp_without_nat_marks_or_redirects(self):
        self.run_script('modern_dns_start')
        status = self.status()
        self.assertEqual(status['mode'], 'hijack')
        self.assertEqual(status['state'], 'running')
        self.assertTrue(status['listenerReady'])
        self.assertTrue(status['interception4'])
        self.assertTrue(status['interception6'])
        self.assertFalse(status['repairNeeded'])
        kernel = self.kernel()
        for cmd in ('iptables', 'ip6tables'):
            tables = kernel['chains']
            self.assertIn(cmd + ':mangle', tables)
            self.assertNotIn('FOXY_DNS_CAPTURE', tables.get(cmd + ':nat', {}))
            queue = tables[cmd + ':mangle']['FOXY_DNS_QUEUE']
            self.assertEqual(queue[0], ['-m', 'owner', '--uid-owner', '0', '--gid-owner', '65533', '-j', 'RETURN'])
            self.assertEqual(len(queue), 2)
            self.assertIn('NFQUEUE', queue[1])
            self.assertIn('--queue-bypass', queue[1])
            self.assertIn('udp', queue[1])
            self.assertNotIn('tcp', queue[1])
            output = tables[cmd + ':mangle']['OUTPUT']
            self.assertEqual(output[-1], ['-j', 'FOXY_DNS_QUEUE'])
        for call in kernel['calls']:
            joined = ' '.join(call)
            self.assertNotIn('CONNMARK', joined)
            self.assertNotIn('0x20000000', joined)
            self.assertNotIn('REDIRECT', joined)
        journal = (self.base / 'state/foxydns-preferences.json').read_text()
        self.assertNotIn('private-marker', journal)
        self.assertTrue(json.loads(journal)['entries'][0]['original'])
        self.run_script('modern_dns_stop')
        self.assertEqual(self.sets(), ['--accept-dns=false', '--accept-dns=true'])
        self.assertFalse(self.status()['listenerReady'])

    def test_hijack_probe_failure_degrades_to_local_listener(self):
        (self.base / 'hijack-probe-failed').touch()
        self.run_script('modern_dns_start')
        status = self.status()
        self.assertEqual(status['mode'], 'hijack')
        self.assertEqual(status['state'], 'degraded')
        self.assertEqual(status['reason'], 'hijack-unavailable')
        self.assertEqual(status['capabilityError'], 'injection denied')
        self.assertTrue(status['listenerReady'])
        self.assertFalse(status['interception4'])
        self.assertFalse(status['repairNeeded'])
        kernel = self.kernel()
        self.assertNotIn('FOXY_DNS_QUEUE', kernel['chains'].get('iptables:mangle', {}))
        self.assertEqual(self.sets(), ['--accept-dns=false'])

    def test_hijack_v6_survives_missing_nat_module(self):
        self.env['MOCK_NO_IPV6_NAT'] = '1'
        self.run_script('modern_dns_start')
        status = self.status()
        self.assertEqual(status['state'], 'running')
        self.assertTrue(status['interception4'])
        self.assertTrue(status['interception6'])
        kernel = self.kernel()
        self.assertIn('FOXY_DNS_QUEUE', kernel['chains']['ip6tables:mangle'])

    def test_hijack_queue_loss_reports_repair_and_restores(self):
        self.run_script('modern_dns_start')
        self.assertTrue(self.status()['interception4'])
        state = self.base / 'run/foxydns.state.json'
        data = json.loads(state.read_text())
        data['queueReady'] = False
        state.write_text(json.dumps(data))
        status = self.status()
        self.assertEqual(status['state'], 'degraded')
        self.assertEqual(status['reason'], 'queue-failed')
        self.assertTrue(status['repairNeeded'])
        self.assertFalse(status['interception4'])
        self.run_script('modern_dns_start')
        status = self.status()
        self.assertEqual(status['state'], 'running')
        self.assertTrue(status['interception4'])

    def test_probe_hijack_records_boot_scoped_verdict(self):
        self.run_script('modern_probe_hijack')
        cached = json.loads((self.base / 'run/foxydns.hijack-capabilities.json').read_text())
        self.assertTrue(cached['ok'])
        self.assertEqual(cached['bootId'], 'test-boot-1')
        (self.base / 'hijack-probe-failed').touch()
        self.run_script('modern_probe_hijack', ok=False)
        cached = json.loads((self.base / 'run/foxydns.hijack-capabilities.json').read_text())
        self.assertFalse(cached['ok'])
        self.assertIn('injection denied', cached['error'])

    def test_hijack_policy_conflict_keeps_local_only(self):
        self.env['MOCK_OUTPUT_POLICY'] = 'DROP'
        self.run_script('modern_dns_start')
        status = self.status()
        self.assertEqual(status['reason'], 'packet-policy-conflict')
        self.assertTrue(status['listenerReady'])
        self.assertFalse(status['interception4'])

    def test_hijack_guard_failure_cleans_queue_chain(self):
        self.runner.write_text(self.runner.read_text().replace(
            'modern_guard_start() { touch "$TEST_DIR/guard-active"; }',
            'modern_guard_start() { return 1; }'))
        self.run_script('modern_dns_start', ok=False)
        kernel = self.kernel()
        self.assertNotIn('FOXY_DNS_QUEUE', kernel['chains'].get('iptables:mangle', {}))
        self.assertEqual(self.status()['reason'], 'guard-failed')


if __name__ == '__main__':
    unittest.main()
