"""Host-only regressions: no Android paths, iptables, or live services are used."""
import io
import base64
import ipaddress
import json
import os
from pathlib import Path
import random
import shlex
import signal
import socket
import subprocess
import tarfile
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ConfigApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxytail-api-test-')
        self.base = Path(self.temp.name).resolve()
        self.conf = self.base / 'conf'
        self.run = self.base / 'run'
        self.scripts = self.base / 'scripts'
        self.sdcard = self.base / 'sdcard'
        for directory in [self.conf, self.run, self.scripts, self.sdcard / 'Download']:
            directory.mkdir(parents=True, exist_ok=True)
        for name in ['foxytail.conf', 'routes.conf', 'context.conf']:
            (self.conf / name).write_bytes((ROOT / 'tailscale/conf' / name).read_bytes())
        settings = (ROOT / 'tailscale/settings.sh').read_text().replace(
            'TS_DIR="/data/adb/foxytail"', 'TS_DIR=' + shlex.quote(str(self.base)))
        (self.base / 'settings.sh').write_text(settings)
        context = (ROOT / 'tailscale/scripts/foxytail.context').read_text()
        # Keep the actual validator; watcher lifecycle is outside this fixture.
        context = context.replace('#!/system/bin/sh', '#!/bin/sh\n'
            'case "$1" in start|stop) exit 0 ;; esac', 1)
        (self.scripts / 'foxytail.context').write_text(context)
        (self.scripts / 'foxytail.context').chmod(0o755)
        (self.scripts / 'start.sh').write_text('#!/bin/sh\n[ "$1" = reload-residents ]\n')
        (self.scripts / 'start.sh').chmod(0o755)
        source = (ROOT / 'tailscale/scripts/foxytail.webapi.sh').read_text()
        helpers = source[source.index('# --- Helpers'):source.index('# --- dispatch')]
        # Relocate the API's shared-storage allowlist to our private fixture.
        helpers = helpers.replace('/sdcard/', str(self.sdcard) + '/')
        # Use the host interpreter at the lifecycle fixture boundary.
        helpers = helpers.replace('"${TS_SCRIPTS_DIR}/start.sh" reload-residents',
                                  'sh "${TS_SCRIPTS_DIR}/start.sh" reload-residents')
        self.lib = self.base / 'helpers.sh'
        self.lib.write_text(
            '. ' + shlex.quote(str(ROOT / 'tailscale/settings.sh')) + '\n' +
            'TS_DIR=' + shlex.quote(str(self.base)) + '\n' +
            'TS_CONF_DIR="$TS_DIR/conf"; TS_RUN_DIR="$TS_DIR/run"; TS_PID_DIR="$TS_RUN_DIR/pids"\n'
            'TS_SCRIPTS_DIR="$TS_DIR/scripts"; TS_BIN_DIR="$TS_DIR/bin"; TS_RUN_LOG_FILE="$TS_RUN_DIR/log"\n'
            'TS_SOCKET="$TS_RUN_DIR/tailscaled.sock"; TUN_IFACE=tailscale0\n'
            'mkdir -p "$TS_PID_DIR"\n' + helpers + '\n'
        )

    def tearDown(self):
        self.temp.cleanup()

    def shell(self, script, ok=True):
        result = subprocess.run(['sh', '-c', '. "$1"\n' + script, 'test', str(self.lib)], text=True, capture_output=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result

    def archive(self, entries):
        path = self.sdcard / 'fixture.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, body in entries.items():
                info = tarfile.TarInfo(name)
                if isinstance(body, tuple):
                    info.type = tarfile.SYMTYPE
                    info.linkname = body[0]
                    archive.addfile(info)
                else:
                    content = body.encode()
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
        return path

    def snapshot(self):
        return {file.name: file.read_bytes() for file in self.conf.iterdir()}

    def test_parser_treats_configuration_as_data(self):
        bad_values = [
            'TS_MODE=bridge\nXX; touch ' + str(self.base / 'executed') + '=x\n',
            'PATH=/sdcard/replacement\n', 'TS_SCRIPTS_DIR=/sdcard/replacement\n',
            'TS_MODE="$(touch ' + str(self.base / 'executed') + ')"\n',
            'TS_MODE=bridge\nTS_MODE=tun\n', 'TS_MODE="bridge";echo injected\n',
        ]
        for content in bad_values:
            with self.subTest(content=content):
                (self.conf / 'foxytail.conf').write_text(content)
                self.assertNotEqual(self.shell('load_conf', ok=False).returncode, 0)
                self.assertFalse((self.base / 'executed').exists())

    def test_parser_preserves_empty_lists_and_final_line(self):
        (self.conf / 'foxytail.conf').write_text('TS_MODE=bridge\nFWMARK=0xF7')
        (self.conf / 'routes.conf').write_text('UID_LIST=""\nROUTE_SUBNETS=""')
        result = self.shell('load_conf && printf "%s|%s|%s" "$FWMARK" "$UID_LIST" "$ROUTE_SUBNETS"')
        self.assertEqual(result.stdout, '0x40000000||')

    def test_parser_key_membership_matches_public_schema(self):
        self.shell('''for file in foxytail.conf routes.conf; do
  for key in $(_conf_keys "$file"); do _conf_has_key "$file" "$key" || exit 1; done
done
! _conf_has_key foxytail.conf UID_LIST && ! _conf_has_key routes.conf TS_MODE &&
! _conf_has_key other.conf TS_MODE && ! _conf_has_key foxytail.conf PATH''')

    def test_dns_modes_roundtrip_and_upgrade_default(self):
        (self.conf / 'foxytail.conf').write_text('MAGIC_DNS=on\nDNS_PORT=1054\n')
        result = json.loads(self.shell('load_conf && cmd_settings_get').stdout)
        self.assertEqual(result['settings']['DNS_MODE'], 'legacy')
        for mode in ['local', 'transparent', 'legacy']:
            result = json.loads(self.shell(f'cmd_settings_set DNS_MODE {mode}').stdout)
            self.assertTrue(result['restartRequired'])
            result = json.loads(self.shell('load_conf && cmd_settings_get').stdout)
            self.assertEqual(result['settings']['DNS_MODE'], mode)
            self.assertEqual(result['settings']['DNS_PORT'], '1054')
        for mode in ['auto', 'flclash', 'off', 'LOCAL', '']:
            self.assertNotEqual(self.shell('cmd_settings_set DNS_MODE ' + shlex.quote(mode), ok=False).returncode, 0)

    def test_dns_api_preserves_actual_capabilities_and_false_repair_flag(self):
        fixture = {'mode':'transparent', 'state':'running', 'reason':'running', 'port':1054,
                   'enabled':True, 'listenerReady':True, 'interception4':True,
                   'interception6':False, 'repairNeeded':False, 'policyState':'owned'}
        script = self.scripts / 'foxytail.dns'
        script.write_text('#!/bin/sh\nprintf %s ' + shlex.quote(json.dumps(fixture)) + '\n')
        script.chmod(0o755)
        result = json.loads(self.shell('load_conf; cmd_dns').stdout)
        for key, value in fixture.items():
            self.assertEqual(result[key], value, key)

    def dns_account_fixture(self, fail=False):
        script = self.scripts / 'foxytail.dns'
        script.write_text('#!/bin/sh\n' +
            '[ "$1" != stop ] || test -L ' + shlex.quote(str(self.run / 'dns-account-transition')) + ' || exit 9\n' +
            'echo "$1" >>' + shlex.quote(str(self.base / 'dns-actions')) + '\n' +
            ('[ "$1" != stop ]\n' if fail else 'exit 0\n'))
        script.chmod(0o755)
        return '''load_conf; DNS_MODE=transparent
_op_exec() { shift; "$@"; }
daemon_up() { return 0; }
ts_cli() { test -L "$TS_RUN_DIR/dns-account-transition" || return 9; echo "$*" >>"$TS_DIR/account-actions"; }
'''

    def test_account_transition_restores_dns_before_cli_and_cleans_marker(self):
        prefix = self.dns_account_fixture()
        for command in ['cmd_switch profile-two', 'cmd_logout', 'cmd_login_authkey tskey-test']:
            result = self.shell(prefix + command)
            self.assertTrue(json.loads(result.stdout)['ok'])
            self.assertFalse((self.run / 'dns-account-transition').is_symlink())
        self.assertEqual((self.base / 'account-actions').read_text().splitlines(),
                         ['30 switch profile-two', '30 logout', '60 login --authkey=tskey-test'])
        self.assertEqual((self.base / 'dns-actions').read_text().splitlines().count('stop'), 3)

    def test_account_transition_aborts_on_unrestored_dns_policy(self):
        result = self.shell(self.dns_account_fixture(fail=True) + 'cmd_switch profile-two', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertFalse((self.base / 'account-actions').exists())
        self.assertFalse((self.run / 'dns-account-transition').is_symlink())

    def test_legacy_account_transition_does_not_require_new_helper(self):
        result = self.shell('load_conf; daemon_up() { return 0; }; ts_cli() { return 0; }; cmd_logout')
        self.assertTrue(json.loads(result.stdout)['ok'])

    def test_watchdog_respects_explicit_nonrepairable_dns_state(self):
        source = (ROOT / 'tailscale/scripts/foxytail.watchdog').read_text()
        check = source[source.index('check_once() {'):source.index('_watchdog_stop() {')]
        fixture = self.scripts / 'foxytail.dns'
        fixture.write_text('#!/bin/sh\ncat "$TS_DIR/dns-status.json"\n')
        fixture.chmod(0o755)
        prefix = check + """
load_conf; export TS_DIR
TS_MODE=proxy; MAGIC_DNS=on
MANUAL_STOP_FILE="$TS_RUN_DIR/manual-stop"; BAD_COUNT_FILE="$TS_RUN_DIR/bad"; ROUTE_CACHE="$TS_RUN_DIR/route-cache"
ts_status_json() { echo '{"BackendState":"Running"}'; }
pids_of_path() { echo 123; }
ip() { return 0; }
log() { :; }
recover() { echo "$*"; }
check_once
"""
        for state, expected in [
            ({'state':'degraded', 'repairNeeded':False}, ''),
            ({'state':'running', 'repairNeeded':True}, 'reconcile companion-not-ready'),
            ({'state':'degraded'}, 'reconcile companion-not-ready'),
            ({'state':'running'}, ''),
        ]:
            (self.base / 'dns-status.json').write_text(json.dumps(state))
            self.assertEqual(self.shell(prefix).stdout.strip(), expected)

    def cgroup_fixture(self, records):
        proc = self.base / 'proc' / 'self'
        proc.mkdir(parents=True)
        (proc / 'stat').write_text('4321 (foxytail.webapi) S 1 2 3\n')
        (proc / 'cgroup').write_text(records)
        sys = self.base / 'sys' / 'fs' / 'cgroup'
        sys.mkdir(parents=True)
        (sys / 'cgroup.procs').touch()
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        function = settings[settings.index('detach_from_app_cgroup() {'):settings.index('# Rotate <file>')]
        function = function.replace('/proc/self/', str(proc) + '/').replace('/sys/fs/cgroup/', str(sys) + '/')
        for controller in ['freezer', 'cpuset', 'cpuctl']:
            function = function.replace('/dev/' + controller + '/', str(self.base / 'dev' / controller) + '/')
        return function

    def test_backend_moves_only_itself_out_of_app_freezer(self):
        function = self.cgroup_fixture('0::/apps/uid_10379/pid_10154\n5:freezer:/\n')
        # A cgroupfs write updates membership; emulate that kernel effect with
        # a shell builtin while retaining the actual PID destination write.
        result = self.shell(function + '''
echo() {
  if [ "$*" = 4321 ]; then command echo '0::/' >"$TS_DIR/proc/self/cgroup"; fi
  command echo "$@"
}
detach_from_app_cgroup''')
        self.assertEqual(result.stdout, '')
        self.assertEqual((self.base / 'sys/fs/cgroup/cgroup.procs').read_text(), '4321\n')

    def test_backend_refuses_lock_when_freezer_detach_fails(self):
        function = self.cgroup_fixture('0::/apps/uid_10379/pid_10154\n')
        # A writable destination that fails to move us is also rejected by the
        # post-write membership check; never proceed to load/lock configuration.
        result = self.shell(function + '\ndetach_from_app_cgroup && load_conf', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('still in the manager app freezer', result.stderr)
        self.assertFalse((self.run / '.conf-write-lock').exists())

    def test_backend_keeps_existing_system_cgroup(self):
        function = self.cgroup_fixture('0::/\n5:freezer:/\n3:cpuset:/foreground\n')
        self.shell(function + '\ndetach_from_app_cgroup')
        self.assertEqual((self.base / 'sys/fs/cgroup/cgroup.procs').read_text(), '')

    def test_schema_rejects_reserved_tables_and_invalid_subnets(self):
        for table in ['0', '52', '253', '254', '255', '999', '65536']:
            self.assertNotEqual(self.shell('_conf_value_error ROUTE_TABLE ' + table, ok=False).returncode, 0)
        self.shell('_conf_value_error ROUTE_TABLE 1052')
        for cidr in ['300.1.1.1/24', '1.2.3.4/99', 'fd00:::1/64', 'fd00::/129', 'not-a-cidr']:
            self.assertNotEqual(self.shell('_conf_value_error ROUTE_SUBNETS ' + shlex.quote(cidr), ok=False).returncode, 0)
        self.shell("_conf_value_error ROUTE_SUBNETS '100.64.0.0/10 fd7a:115c:a1e0::/48'")
        self.assertNotEqual(self.shell("_conf_value_error UID_LIST '0 10123'", ok=False).returncode, 0)

    def test_cidr_normalization_matches_network_semantics_and_preserves_hosts(self):
        rng = random.Random(2452)
        cidrs = ['192.168.1.7/24', '192.168.1.0/24', '192.168.1.10/32',
                 'FD12:34::ABCD/64', 'fd12:34::/64', '2001:db8::1/128',
                 '::ffff:192.0.2.129/120', '0.0.0.0/0', '::/0']
        for bits, address in ((32, ipaddress.IPv4Address), (128, ipaddress.IPv6Address)):
            for prefix in range(bits + 1):
                cidrs.append(f'{address(rng.getrandbits(bits))}/{prefix}')
        expected = []
        for cidr in cidrs:
            network = ipaddress.ip_network(cidr, strict=False)
            canonical = str(network)
            # Python versions differ in the displayed form of mapped IPv6.
            # The API consistently uses hexadecimal RFC 5952-style words.
            if network.version == 6 and '.' in canonical:
                mapped = network.network_address.ipv4_mapped
                self.assertIsNotNone(mapped)
                canonical = canonical.replace(str(mapped), f'{int(mapped) >> 16:x}:{int(mapped) & 0xffff:x}')
            if canonical not in expected:
                expected.append(canonical)
        result = self.shell('normalize_cidrs ' + shlex.quote(' '.join(cidrs)))
        self.assertEqual(result.stdout.split(), expected)
        self.assertEqual(self.shell("normalize_cidrs '192.168.001.010/32'").stdout, '192.168.1.10/32')
        self.assertEqual(self.shell("normalize_cidrs ''").stdout, '')

    def test_invalid_cidr_never_emits_partial_normalized_output(self):
        bad = ['1.2.3/24', '256.1.1.1/24', '1.2.3.4/33', '1.2.3.4/-1',
               'fd00:::1/64', '1:2:3:4:5:6:7::8/64', '1:2:3:4:5:6:7:/64',
               '1::2::3/64', '::ffff:192.0.2.300/128', '::ffff:1.2.3/64',
               '::/129', 'fe80::1%wlan0/64', '::/x', '::1', '0/0', '1.2.3.4/24/1']
        for cidr in bad:
            with self.subTest(cidr=cidr):
                result = self.shell('normalize_cidrs ' + shlex.quote('192.168.0.0/16 ' + cidr), ok=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')

    def subnet_fixture(self, accept=False, status=None):
        prefs = {'RouteAll': accept, 'CorpDNS': True, 'ExitNodeID': 'unchanged-exit',
                 'Config': {'PrivateNodeKey': 'fixture-private-marker'}}
        (self.base / 'prefs.json').write_text(json.dumps(prefs))
        (self.base / 'status.json').write_text(json.dumps(status or {'BackendState': 'Running', 'Peer': {}}))
        return '''load_conf
daemon_up() { return 0; }
ts_cli() {
  printf '%s\\n' "$*" >>"$TS_RUN_DIR/cli-calls"
  case "$2:$3" in
    debug:prefs)
      [ ! -f "$TS_DIR/prefs-failed" ] || return 1
      cat "$TS_DIR/prefs.json" ;;
    status:--json)
      [ ! -f "$TS_DIR/status-failed" ] || return 1
      cat "$TS_DIR/status.json" ;;
    set:--accept-routes=true|set:--accept-routes=false)
      [ ! -f "$TS_DIR/set-failed" ] || { echo 'denied by policy' >&2; return 1; }
      if [ ! -f "$TS_DIR/set-no-effect" ]; then
        jqr --argjson value "${3#--accept-routes=}" '.RouteAll=$value' "$TS_DIR/prefs.json" >"$TS_DIR/prefs.next" || return 1
        mv "$TS_DIR/prefs.next" "$TS_DIR/prefs.json"
      fi ;;
    *) return 99 ;;
  esac
}
'''

    def test_subnet_discovery_filters_node_addresses_and_exit_routes_only(self):
        status = {'BackendState': 'Running', 'Peer': {
            'router': {'ID': 'node1', 'HostName': 'router', 'Online': True,
                       'TailscaleIPs': ['100.64.0.2', 'fd7a:115c:a1e0::2'],
                       'AllowedIPs': ['100.64.0.2/32', 'fd7a:115c:a1e0::2/128', '0.0.0.0/0', '::/0',
                                      '192.168.1.10/32', '192.168.1.0/24', 'fd12::10/128', '10.20.0.0/16'],
                       'PrimaryRoutes': ['192.168.1.0/24', 'fd12::/64']},
            'host': {'ID': 'host-only', 'TailscaleIPs': ['100.64.0.3'], 'AllowedIPs': ['100.64.0.3/32']},
        }}
        result = self.shell(self.subnet_fixture(accept=False, status=status) + '\ncmd_subnet_routes_get')
        data = json.loads(result.stdout)
        self.assertFalse(data['acceptRoutes']); self.assertFalse(data['ipv6Enabled'])
        self.assertEqual(data['mode'], 'bridge')
        self.assertEqual(len(data['peers']), 1)
        routes = {r['cidr']: r['primary'] for r in data['peers'][0]['routes']}
        self.assertEqual(routes, {'10.20.0.0/16': False, '192.168.1.0/24': True,
                                  '192.168.1.10/32': False, 'fd12::/64': True, 'fd12::10/128': False})
        self.assertNotIn('fixture-private-marker', result.stdout)

    def test_subnet_read_failures_remain_unknown_and_never_write(self):
        script = self.subnet_fixture(accept=True)
        (self.base / 'prefs-failed').touch()
        result = json.loads(self.shell(script + '\ncmd_subnet_routes_get', ok=False).stdout)
        self.assertIsNone(result['acceptRoutes']); self.assertFalse(result['ok'])
        (self.base / 'prefs-failed').unlink()
        (self.base / 'prefs.json').write_text('{}')
        result = json.loads(self.shell(script + '\ncmd_subnet_routes_get', ok=False).stdout)
        self.assertIsNone(result['acceptRoutes'])
        script = self.subnet_fixture(accept=True)
        (self.base / 'status-failed').touch()
        result = json.loads(self.shell(script + '\ncmd_subnet_routes_get', ok=False).stdout)
        self.assertTrue(result['acceptRoutes']); self.assertIn('peer subnet routes', result['error'])
        self.assertNotIn('set ', (self.run / 'cli-calls').read_text())

    def test_malformed_subnet_snapshot_does_not_claim_an_empty_known_result(self):
        script = self.subnet_fixture(accept=True)
        for status in ({}, [], {'BackendState': 'Running', 'Peer': []},
                       {'BackendState': 'Running', 'Peer': {'bad': {'AllowedIPs': '192.168.0.0/16'}}}):
            with self.subTest(status=status):
                (self.base / 'status.json').write_text(json.dumps(status))
                result = json.loads(self.shell(script + '\ncmd_subnet_routes_get', ok=False).stdout)
                self.assertFalse(result['ok']); self.assertTrue(result['acceptRoutes'])
                self.assertEqual(result['peers'], [])
                self.assertIn('invalid peer subnet routes snapshot', result['error'])

    def test_subnet_setting_changes_only_profile_preference_and_confirms_it(self):
        script = self.subnet_fixture(accept=False)
        before_prefs = json.loads((self.base / 'prefs.json').read_text())
        before_conf = self.snapshot()
        result = json.loads(self.shell(script + '\ncmd_subnet_routes_set on').stdout)
        self.assertEqual(result, {'ok': True, 'applied': True, 'acceptRoutes': True})
        after_prefs = json.loads((self.base / 'prefs.json').read_text())
        self.assertEqual(after_prefs, {**before_prefs, 'RouteAll': True})
        self.assertEqual(self.snapshot(), before_conf)
        self.assertEqual((self.run / 'cli-calls').read_text().splitlines(),
                         ['5 debug prefs', '10 set --accept-routes=true', '5 debug prefs'])
        result = json.loads(self.shell(script + '\ncmd_subnet_routes_set off').stdout)
        self.assertFalse(result['acceptRoutes']); self.assertTrue(result['applied'])
        (self.run / 'cli-calls').write_text('')
        result = json.loads(self.shell(script + '\ncmd_subnet_routes_set off').stdout)
        self.assertEqual(result, {'ok': True, 'applied': True, 'acceptRoutes': False})
        self.assertEqual((self.run / 'cli-calls').read_text().splitlines(), ['5 debug prefs'])

    def test_subnet_setting_failure_and_stopped_daemon_never_claim_applied(self):
        script = self.subnet_fixture(accept=False)
        for marker in ('set-no-effect', 'set-failed', 'prefs-failed'):
            with self.subTest(marker=marker):
                (self.base / marker).touch()
                result = json.loads(self.shell(script + '\ncmd_subnet_routes_set on', ok=False).stdout)
                self.assertFalse(result['ok']); self.assertFalse(result['applied'])
                self.assertEqual(result['acceptRoutes'], None if marker == 'prefs-failed' else False)
                (self.base / marker).unlink()
        before = (self.run / 'cli-calls').read_text()
        for command in ('cmd_subnet_routes_get', 'cmd_subnet_routes_set on', 'cmd_subnet_routes_set invalid'):
            result = json.loads(self.shell(script + '\ndaemon_up() { return 1; }\n' + command, ok=False).stdout)
            self.assertIsNone(result['acceptRoutes']); self.assertFalse(result['ok'])
        self.assertEqual((self.run / 'cli-calls').read_text(), before)

    def test_routes_set_normalizes_cidrs_and_reports_unapplied_ipv6(self):
        self.shell('conf_activate_runtime')
        route = self.scripts / 'foxytail.route'
        route.write_text('#!/bin/sh\nexit 0\n'); route.chmod(0o755)
        result = json.loads(self.shell('''load_conf
ip() { [ "$*" = 'link show dev tailscale0' ]; }
cmd_routes_set all - '192.168.1.7/24,192.168.1.0/24,FD12::55/64,fd12::/64,192.168.1.10/32' ''').stdout)
        self.assertEqual(result['subnets'], ['192.168.1.0/24', 'fd12::/64', '192.168.1.10/32'])
        self.assertTrue(result['saved']); self.assertFalse(result['applied'])
        self.assertTrue(result['requiresIpv6']); self.assertEqual(result['ipv6Skipped'], ['fd12::/64'])
        self.assertIn('IPv4 routing applied', result['note'])
        self.assertIsNone(result['applyError'])
        self.assertIn('ROUTE_SUBNETS="192.168.1.0/24 fd12::/64 192.168.1.10/32"',
                      (self.conf / 'routes.conf').read_text())
        # Explicit activation applies IPv6 after saving the destination.
        self.shell('conf_write_key foxytail.conf IPV6 on; conf_activate_runtime')
        result = json.loads(self.shell('''load_conf
ip() { return 0; }
cmd_routes_set all - '192.168.1.7/24,FD12::55/64' ''').stdout)
        self.assertTrue(result['applied']); self.assertFalse(result['requiresIpv6'])
        self.assertEqual(result['ipv6Skipped'], [])
        self.assertIsNone(result['applyError'])

    def test_routes_reload_failure_is_distinct_from_unapplied_ipv6(self):
        self.shell('conf_activate_runtime')
        route = self.scripts / 'foxytail.route'
        route.write_text('#!/bin/sh\nexit 1\n'); route.chmod(0o755)
        result = json.loads(self.shell('''load_conf
ip() { return 0; }
cmd_routes_set all - '192.168.1.7/24,FD12::55/64' ''').stdout)
        self.assertTrue(result['ok']); self.assertTrue(result['saved'])
        self.assertFalse(result['applied']); self.assertTrue(result['restartRequired'])
        self.assertEqual(result['applyError'], 'routing reload failed; inspect the service log')
        self.assertIn(result['applyError'], result['note'])
        self.assertIn('IPv6 destinations are not applied while IPv6 is disabled', result['note'])
        self.assertNotIn('IPv4 routing applied', result['note'])
        self.assertTrue(result['requiresIpv6']); self.assertEqual(result['ipv6Skipped'], ['fd12::/64'])
        self.assertEqual(result['subnets'], ['192.168.1.0/24', 'fd12::/64'])
        # A tunnel that is not ready is pending, not an attempted reload failure.
        result = json.loads(self.shell('''load_conf
ip() { return 1; }
cmd_routes_set all - '192.168.1.7/24,FD12::55/64' ''').stdout)
        self.assertIsNone(result['applyError']); self.assertFalse(result['applied'])
        self.assertIn('routing will apply when the tunnel is ready', result['note'])
        self.assertTrue(result['requiresIpv6'])

    def test_routes_invalid_cidr_does_not_persist_partial_configuration(self):
        before = self.snapshot()
        result = self.shell("load_conf; cmd_routes_set all - '192.168.1.7/24,1::2::3/64'", ok=False)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.run / 'settings.pending').exists())

    def test_routes_report_applied_ipv6_while_desired_setting_is_pending(self):
        route = self.scripts / 'foxytail.route'
        route.write_text('#!/bin/sh\nexit 0\n'); route.chmod(0o755)
        for applied, desired, skipped in [('off', 'on', ['fd12::/64']), ('on', 'off', [])]:
            with self.subTest(applied=applied, desired=desired):
                self.shell(f'conf_write_key foxytail.conf IPV6 {applied}; conf_activate_runtime')
                self.shell(f'conf_write_key foxytail.conf IPV6 {desired}')
                result = json.loads(self.shell('''load_conf
ip() { return 0; }
cmd_routes_set all - '192.168.1.7/24,fd12::55/64'
''').stdout)
                self.assertEqual(result['ipv6Skipped'], skipped)
                self.assertEqual(result['applied'], not skipped)
                self.assertEqual(result['requiresIpv6'], bool(skipped))
                self.assertEqual(result['restartRequired'], bool(skipped))
                self.assertIsNone(result['applyError'])
                self.assertTrue((self.run / 'settings.pending').exists())
                saved = json.loads(self.shell('load_conf; cmd_settings_get').stdout)
                self.assertEqual(saved['settings']['IPV6'], desired)

    def test_hot_saves_promote_only_the_requested_file_under_the_config_lock(self):
        self.shell('conf_activate_runtime')
        runtime = self.run / (self.run / 'applied-config').read_text().strip()
        main = (runtime / 'foxytail.conf').read_bytes()
        self.shell('cmd_settings_set SOCKS_PORT 1200')
        self.shell('''load_conf
ip() { return 1; }
cmd_routes_set all - '192.168.1.7/24'
''')
        self.assertEqual((runtime / 'routes.conf').read_bytes(), (self.conf / 'routes.conf').read_bytes())
        self.assertEqual((runtime / 'foxytail.conf').read_bytes(), main)
        rules = 'cellular:-:no-exit-node'
        self.shell('cmd_context_set ' + shlex.quote(base64.b64encode(rules.encode()).decode()))
        self.assertEqual((runtime / 'context.conf').read_text(), rules)
        self.assertEqual((runtime / 'foxytail.conf').read_bytes(), main)
        before = {file.name: file.read_bytes() for file in runtime.iterdir()}
        self.shell('cmd_restore ' + shlex.quote(str(self.archive({'conf/context.conf': '# pending restore'}))))
        self.assertEqual({file.name: file.read_bytes() for file in runtime.iterdir()}, before)
        self.assertTrue((self.run / 'settings.pending').exists())

    def test_failed_runtime_promotion_reports_saved_without_applying(self):
        prefix = '''load_conf
conf_apply_runtime() {
  [ "${_CONF_LOCK_HELD}" = 1 ] || echo 'promotion was outside lock' >&2
  return 1
}
ip() { touch "$TS_RUN_DIR/unexpected-apply"; return 0; }
'''
        result = self.shell(prefix + "cmd_routes_set all - '192.168.1.7/24'", ok=False)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertIn('saved, but runtime configuration promotion failed', json.loads(result.stdout)['error'])
        self.assertIn('192.168.1.0/24', (self.conf / 'routes.conf').read_text())
        self.assertNotIn('outside lock', result.stderr)
        self.assertFalse((self.run / 'unexpected-apply').exists())
        result = self.shell(prefix + "cmd_context_set ''", ok=False)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertIn('saved, but runtime configuration promotion failed', json.loads(result.stdout)['error'])
        self.assertNotIn('outside lock', result.stderr)
        self.assertEqual((self.conf / 'context.conf').read_text(), '')
        self.assertFalse((self.run / '.conf-write-lock').is_symlink())

    def test_hot_saves_fail_closed_without_a_known_runtime(self):
        for command in ("cmd_routes_set all - 'fd12::55/64'", "cmd_context_set ''"):
            result = self.shell('''load_conf
ip() { touch "$TS_RUN_DIR/unexpected-apply"; return 0; }
''' + command, ok=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('saved, but runtime configuration promotion failed', json.loads(result.stdout)['error'])
            self.assertFalse((self.run / 'unexpected-apply').exists())
            self.assertFalse((self.run / 'applied-config').exists())
            self.assertTrue((self.run / 'settings.pending').exists())
            self.assertFalse((self.run / '.conf-write-lock').is_symlink())

    def test_concurrent_writers_preserve_unrelated_changes(self):
        workers = []
        changes = [('SOCKS_PORT', '1100'), ('DNS_PORT', '1101'), ('STATS_INTERVAL', '71'), ('LOG_MAX_KB', '600')]
        for key, value in changes:
            workers.append(subprocess.Popen(['sh', '-c', '. "$1"; conf_write_key foxytail.conf "$2" "$3"', 'test', str(self.lib), key, value], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        for worker in workers:
            stdout, stderr = worker.communicate(timeout=15)
            self.assertEqual(worker.returncode, 0, stdout + stderr)
        result = self.shell('load_conf && cmd_settings_get')
        values = json.loads(result.stdout)['settings']
        for key, value in changes:
            self.assertEqual(values[key], value)

    def test_native_scope_and_install_marker_reject_writes(self):
        (self.conf / 'routes.conf').write_text('ROUTE_SCOPE=selected\nUID_LIST="10123"')
        self.assertNotEqual(self.shell('conf_write_key foxytail.conf TS_MODE tun', ok=False).returncode, 0)
        (self.base / '.installing').touch()
        self.assertNotEqual(self.shell('conf_write_key foxytail.conf DNS_PORT 1101', ok=False).returncode, 0)

    def test_account_json_and_stderr_are_preserved(self):
        result = self.shell('''daemon_up() { return 0; }
ts_cli() { [ "$*" = '15 switch --list --json' ] || return 9; printf '%s' '[{"id":"id1","nickname":"Home","selected":true}]'; }
cmd_accounts''')
        self.assertEqual(json.loads(result.stdout)['accounts'][0], {'name': 'id1', 'id': 'id1', 'current': True, 'label': 'Home', 'tailnet': ''})
        result = self.shell('''_op_exec() { shift; "$@"; }
tailscale() { echo 'permission denied by policy' >&2; return 1; }
cmd_exitnode_clear''', ok=False)
        self.assertIn('permission denied by policy', json.loads(result.stdout)['error'])

    def test_settings_and_routes_use_one_json_process_per_snapshot(self):
        result = self.shell('''load_conf
jqr() { printf x >>"$TS_RUN_DIR/jq-calls"; command jq "$@"; }
cmd_settings_get
cmd_routes_get''')
        settings, routes = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(settings['settings']['TS_MODE'], 'bridge')
        self.assertEqual(settings['settings']['FWMARK'], '0x40000000')
        self.assertNotIn('pending', settings['settings'])
        self.assertEqual(routes['scope'], 'all')
        self.assertEqual(routes['uids'], [])
        self.assertEqual(routes['subnets'], ['100.64.0.0/10'])
        self.assertEqual((self.run / 'jq-calls').read_text(), 'xx')

    def test_large_package_list_has_constant_json_process_count(self):
        # Hundreds of apps must not launch hundreds of jq processes while the
        # root bridge holds the WebView callback. Keep parsing real jq output.
        (self.base / 'packages').write_text(''.join(
            f'package:com.example.app{i:03d} uid:{10000 + i}\n' for i in reversed(range(300))
        ) + 'unrelated diagnostic\n')
        result = self.shell('''timeout() { shift; "$@"; }
pm() { cat "$TS_DIR/packages"; }
jqr() { printf x >>"$TS_RUN_DIR/jq-calls"; command jq "$@"; }
cmd_apps''')
        apps = json.loads(result.stdout)['apps']
        self.assertEqual(len(apps), 300)
        self.assertEqual(apps[0], {'label': 'com.example.app000', 'package': 'com.example.app000', 'uid': 10000})
        self.assertEqual(apps[-1]['uid'], 10299)
        self.assertEqual((self.run / 'jq-calls').read_text(), 'x')

    def test_dns_status_preserves_configuration_and_native_capability(self):
        modern_defaults = {'mode': 'legacy', 'configuredMode': None, 'pendingMode': None,
                           'listenerReady': False, 'interception4': False, 'interception6': False,
                           'repairNeeded': None, 'policyState': None, 'capabilityError': None}
        status = {'state': 'stopped', 'suffix': '', 'port': 1053, 'enabled': False,
                  'reason': 'Local DNS helper is disabled', 'binary': '/system/bin/dnsmasq',
                  'upstreamNative': True, 'ipv6DnsInterception': 'disabled',
                  'ipv6ModuleStatus': 'not-checked'}
        dns = self.scripts / 'foxytail.dns'
        dns.write_text('#!/bin/sh\nprintf %s ' + shlex.quote(json.dumps(status)) + '\n')
        dns.chmod(0o755)
        result = json.loads(self.shell('load_conf; cmd_dns').stdout)
        self.assertEqual(result, {'ok': True, **modern_defaults, **status})
        for mode, module in [('available', 'not-needed'), ('module-loaded', 'loaded'),
                             ('fallback', 'missing'), ('fallback', 'load-failed')]:
            status.update(state='running', enabled=True, ipv6DnsInterception=mode,
                          ipv6ModuleStatus=module)
            dns.write_text('#!/bin/sh\nprintf %s ' + shlex.quote(json.dumps(status)) + '\n')
            self.assertEqual(json.loads(self.shell('load_conf; cmd_dns').stdout), {'ok': True, **modern_defaults, **status})

    def test_restore_validation_has_no_partial_writes(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'PATH=/sdcard/evil\n'})
        self.assertNotEqual(self.shell('cmd_restore ' + shlex.quote(str(archive)), ok=False).returncode, 0)
        self.assertEqual(self.snapshot(), previous)

    def test_context_save_and_restore_share_validation(self):
        self.shell('conf_activate_runtime')
        valid = ['', '# comments only', 'cellular:-:no-exit-node',
                 'ssid:Office WiFi:up\ncellular:-:down\ncellular:-:exit-node:100.64.0.1']
        invalid = ['cellular:-:typo', 'ssid::up', 'cellular:home:down',
                   'cellular:-:exit-node', 'ssid:Office:Guest:up', 'ssid:Office#Guest:up',
                   'none:-:down',
                   '# first line\ncellular:-:no-exit-node:unexpected']
        for rules in valid + invalid:
            with self.subTest(rules=rules):
                before = self.snapshot()
                pending = self.run / 'settings.pending'
                old_pending = pending.read_bytes() if pending.exists() else None
                payload = base64.b64encode(rules.encode()).decode()
                saved = self.shell('cmd_context_set ' + shlex.quote(payload), ok=rules in valid)
                restored = self.shell('cmd_restore ' + shlex.quote(str(self.archive(
                    {'conf/context.conf': rules}))), ok=rules in valid)
                for result in (saved, restored):
                    data = json.loads(result.stdout)
                    self.assertEqual(data['ok'], rules in valid, result.stdout)
                    if rules in invalid:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertRegex(data['error'], r'(?:line |:)[12](?:\D|$)')
                if rules in valid:
                    self.assertEqual((self.conf / 'context.conf').read_text(), rules)
                else:
                    self.assertEqual(self.snapshot(), before)
                    self.assertEqual(pending.read_bytes() if pending.exists() else None, old_pending)
                self.assertFalse((self.run / '.conf-write-lock').is_symlink())
                self.assertEqual(list(self.conf.glob('.context.conf.*')), [])

    def test_context_save_waits_for_real_resident_reload_and_reports_start_failure(self):
        self.shell('conf_activate_runtime')
        start = (ROOT / 'tailscale/scripts/start.sh').read_text()
        # Keep the actual bounded readiness loop; only change host exec boundaries.
        start = start.replace('nohup "${TS_SCRIPTS_DIR}/${_sr_name}"',
                              'nohup sh "${TS_SCRIPTS_DIR}/${_sr_name}"')
        start = start.replace('"${TS_SCRIPTS_DIR}/${_sr_name}" stop',
                              'sh "${TS_SCRIPTS_DIR}/${_sr_name}" stop')
        (self.scripts / 'start.sh').write_text(start)
        context = (ROOT / 'tailscale/scripts/foxytail.context').read_text().replace(
            '#!/system/bin/sh', '#!/bin/sh', 1)
        pidfile = self.run / 'slow-context-pid'
        stampfile = self.run / 'slow-context-start'
        for mode in ('failed', 'unready', 'empty'):
            with self.subTest(mode=mode):
                if mode == 'empty':
                    helper = context  # Real no-rules startup must remain a success.
                else:
                    action = 'sleep 0.1; exit 9' if mode == 'failed' else (
                        'echo $$ >' + shlex.quote(str(pidfile)) +
                        '; ps -p $$ -o lstart= >' + shlex.quote(str(stampfile)) + '; exec sleep 30')
                    helper = context.replace('#!/bin/sh', '#!/bin/sh\n'
                        f'case "$1" in start) {action} ;; stop) exit 0 ;; esac', 1)
                (self.scripts / 'foxytail.context').write_text(helper)
                rules = '' if mode == 'empty' else 'cellular:-:no-exit-node'
                try:
                    started = time.monotonic()
                    result = self.shell('cmd_context_set ' + shlex.quote(
                        base64.b64encode(rules.encode()).decode()), ok=mode == 'empty')
                    self.assertLess(time.monotonic() - started, 6, 'startup wait was not bounded')
                    data = json.loads(result.stdout)
                    self.assertEqual(data['ok'], mode == 'empty')
                    if mode != 'empty':
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('saved, but resident startup failed', data['error'])
                    self.assertEqual((self.conf / 'context.conf').read_text(), rules)
                    self.assertTrue((self.run / 'settings.pending').exists())
                    self.assertFalse((self.run / '.conf-write-lock').is_symlink())
                finally:
                    if pidfile.exists():
                        # This fixture execs sleep in place: one owned PID, no descendants.
                        pid = int(pidfile.read_text())
                        actual = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='],
                                                text=True, capture_output=True)
                        if stampfile.exists() and actual.stdout.strip() and actual.stdout == stampfile.read_text():
                            try:
                                os.kill(pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                        pidfile.unlink()

    def test_restore_validates_retained_context_before_replacing_any_config(self):
        (self.conf / 'context.conf').write_text('cellular:-:typo')
        before = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n'})
        result = self.shell('cmd_restore ' + shlex.quote(str(archive)), ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('restore:', json.loads(result.stdout)['error'])
        self.assertEqual(self.snapshot(), before)

    def test_restore_rejects_links_before_extraction(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'TS_MODE=bridge\n', 'conf/link': (str(self.base / 'escape'),)})
        self.assertNotEqual(self.shell('cmd_restore ' + shlex.quote(str(archive)), ok=False).returncode, 0)
        self.assertEqual(self.snapshot(), previous)
        self.assertFalse((self.base / 'escape').exists())

    def test_restore_rolls_back_failed_activation(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'ROUTE_SCOPE=all\n'})
        result = self.shell('''mv() { case "$1" in */next) return 1 ;; esac; command mv "$@"; }
cmd_restore ''' + shlex.quote(str(archive)), ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), previous)

    def test_failed_rollback_removal_preserves_previous_directory(self):
        previous = self.snapshot()
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'ROUTE_SCOPE=all\n'})
        result = self.shell('''conf_mark_pending() { return 1; }
rm() { [ "$*" != "-rf $TS_CONF_DIR" ] || return 1; command rm "$@"; }
cmd_restore ''' + shlex.quote(str(archive)), ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('previous configuration retained', result.stderr)
        backups = list(self.base.glob('conf.bak-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual({file.name: file.read_bytes() for file in backups[0].iterdir()}, previous)
        self.assertFalse(any(file.is_dir() for file in self.conf.iterdir()), 'rollback nested the old directory inside conf')

    def test_rotation_preserves_inode_and_bounds_backup(self):
        logfile = self.run / 'large.log'
        logfile.write_bytes(b'x' * 100_000)
        inode = logfile.stat().st_ino
        self.shell('LOG_MAX_KB=64; rotate_log "$TS_RUN_DIR/large.log"')
        self.assertEqual(logfile.stat().st_ino, inode)
        self.assertEqual(logfile.stat().st_size, 0)
        self.assertEqual((self.run / 'large.log.bak').stat().st_size, 65536)
        self.assertFalse((self.run / '.conf-write-lock').is_symlink())

    def test_restore_retains_snapshot_and_marks_restart(self):
        archive = self.archive({'conf/foxytail.conf': 'SOCKS_PORT=1200\n', 'conf/routes.conf': 'ROUTE_SCOPE=all\n', 'foxytail.tun.up': '#!/system/bin/sh\necho restored\n'})
        result = json.loads(self.shell('cmd_restore ' + shlex.quote(str(archive))).stdout)
        self.assertTrue(Path(result['previous']).is_dir())
        self.assertTrue(result['restartRequired'])
        self.assertEqual((self.conf / 'foxytail.conf').read_text(), 'SOCKS_PORT=1200\n')
        self.assertFalse((self.scripts / 'foxytail.tun.up').exists())

    def test_failed_backup_removes_partial_archive(self):
        result = self.shell('''tar() { [ "$1" != -czf ] || { printf truncated >"$2"; echo 'storage write failed' >&2; return 1; }; command tar "$@"; }
cmd_backup''', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('archive creation failed: storage write failed', json.loads(result.stdout)['error'])
        self.assertEqual(list((self.sdcard / 'Download').iterdir()), [])
        self.assertEqual(list(self.run.glob('.backup.*')), [])
        self.assertFalse((self.run / '.conf-write-lock').is_symlink())

    def test_real_backup_preserves_configuration_and_optional_hooks_and_restores(self):
        for with_hooks in (False, True):
            with self.subTest(with_hooks=with_hooks):
                before = self.snapshot()
                hooks = {name: f'#!/system/bin/sh\n# fixture {name}\necho do-not-execute\n'.encode()
                         for name in ('foxytail.tun.up', 'foxytail.tun.down')} if with_hooks else {}
                for name, content in hooks.items():
                    (self.scripts / name).write_bytes(content)
                # macOS bsdtar otherwise adds AppleDouble metadata entries that
                # Android tar does not produce and the restore format excludes.
                result = json.loads(self.shell('export COPYFILE_DISABLE=1\ncmd_backup').stdout)
                archive = Path(result['path'])
                self.assertTrue(result['ok']); self.assertTrue(archive.is_file())
                self.assertEqual(result['size'], archive.stat().st_size)
                self.assertGreater(result['size'], 0)
                # Real tar/gzip bytes, independently read and compared by Python.
                with tarfile.open(archive, 'r:gz') as backup:
                    files = {member.name: backup.extractfile(member).read()
                             for member in backup.getmembers() if member.isfile()}
                self.assertEqual(files, {**{'conf/' + name: content for name, content in before.items()}, **hooks})
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(list(self.run.glob('.backup.*')), [])
                self.assertFalse((self.run / '.conf-write-lock').is_symlink())
                # The actual restore implementation consumes this archive in our
                # private fixture; no host/device service commands are involved.
                (self.conf / 'foxytail.conf').write_text('SOCKS_PORT=9999\n')
                restored = json.loads(self.shell('cmd_restore ' + shlex.quote(str(archive))).stdout)
                self.assertTrue(restored['ok']); self.assertEqual(self.snapshot(), before)
                for name, content in hooks.items():
                    parked = list(self.base.glob('restored-hooks-*/' + name + '.restored'))
                    self.assertEqual(len(parked), 1)
                    self.assertEqual(parked[0].read_bytes(), content)
                    self.assertEqual(parked[0].stat().st_mode & 0o111, 0)

    def test_backup_verification_and_shared_storage_failures_are_actionable(self):
        result = self.shell('''tar() { [ "$1" != -tzf ] || { echo 'gzip checksum mismatch' >&2; return 1; }; command tar "$@"; }
cmd_backup''', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('archive verification failed: gzip checksum mismatch', json.loads(result.stdout)['error'])
        self.assertEqual(list((self.sdcard / 'Download').iterdir()), [])
        result = self.shell('''mkdir() { [ "$*" != '-p ''' + str(self.sdcard / 'Download') + '''' ] || { echo 'Permission denied' >&2; return 1; }; command mkdir "$@"; }
cmd_backup''', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('cannot create Download directory: Permission denied', json.loads(result.stdout)['error'])
        self.assertEqual(list(self.run.glob('.backup.*')), [])
        self.assertFalse((self.run / '.conf-write-lock').is_symlink())

    def test_cancel_before_registration_is_a_tombstone(self):
        request_id = str(int(time.time())) + '_delayed_123'
        result = self.shell('cmd_cancel ' + request_id + '; _op_init ' + request_id + ' login', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.run / 'operations' / request_id / 'cancelled').exists())

    def test_cancel_checks_pid_identity(self):
        result = self.shell('''mkdir -p "$TS_RUN_DIR/operations/1_old"
printf '99999 123\\n' >"$TS_RUN_DIR/operations/1_old/child.99999"
_op_starttime() { printf 999; }
kill() { echo "unexpected kill" >&2; return 99; }
cmd_cancel 1_old''')
        self.assertNotIn('unexpected kill', result.stderr)
        self.assertTrue(json.loads(result.stdout)['cancelled'])

    def test_child_discovery_reads_parent_and_starttime_from_one_proc_record(self):
        proc = self.base / 'proc'
        for pid, parent, stamp, comm in [(101, 42, 123, 'child (name)'), (102, 99, 456, 'unrelated')]:
            (proc / str(pid)).mkdir(parents=True)
            fields = ['S', str(parent)] + ['0'] * 17 + [str(stamp)]
            (proc / str(pid) / 'stat').write_text(f'{pid} ({comm}) ' + ' '.join(fields) + '\n')
        source = (ROOT / 'tailscale/scripts/foxytail.webapi.sh').read_text()
        function = source[source.index('_op_children() {'):source.index('# Pause each verified parent')]
        function = function.replace('/proc/', str(proc) + '/')
        self.assertEqual(self.shell(function + '\n_op_children 42').stdout.strip(), '101:123')

    def test_cancellation_never_signals_a_reused_descendant_pid(self):
        result = self.shell('''mkdir -p "$TS_RUN_DIR/operations/1_reused"
printf '99998 123\\n' >"$TS_RUN_DIR/operations/1_reused/child.99999.child.99998"
_op_starttime() { printf 456; }
kill() { echo "unexpected kill" >&2; return 99; }
cmd_cancel 1_reused''')
        self.assertNotIn('unexpected kill', result.stderr)
        self.assertTrue(json.loads(result.stdout)['cancelled'])

    def test_fast_cli_does_not_wait_for_timeout_monitor(self):
        start = time.monotonic()
        result = self.shell('''_op_starttime() { kill -0 "$1" 2>/dev/null && printf 100; }
_op_exec 3 sh -c 'printf ready; exit 7' ''', ok=False)
        self.assertEqual(result.stdout, 'ready')
        self.assertEqual(result.returncode, 7)
        self.assertLess(time.monotonic() - start, 1.5, 'completed CLI waited for its timeout monitor')

    def test_cancellation_stops_only_registered_child(self):
        request_id = str(int(time.time())) + '_live'
        # The host may lack /proc; substitute only the starttime reader. Kill
        # remains real, and the separate bystander must survive cancellation.
        stamp = '_op_starttime() { kill -0 "$1" 2>/dev/null && printf 100; }\n'
        bystander = subprocess.Popen(['sleep', '30'])
        runner = subprocess.Popen(['sh', '-c', '. "$1"; ' + stamp + '_op_init "$2" login; _op_exec 30 sleep 30', 'test', str(self.lib), request_id], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            registry = self.run / 'operations' / request_id
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and not list(registry.glob('child.*')):
                time.sleep(0.02)
            self.assertTrue(list(registry.glob('child.*')), 'child was not registered')
            result = self.shell(stamp + 'cmd_cancel ' + request_id)
            self.assertTrue(json.loads(result.stdout)['cancelled'])
            runner.communicate(timeout=3)
            self.assertEqual(runner.returncode, 130)
            self.assertIsNone(bystander.poll(), 'unrelated process was signalled')
        finally:
            for process in [runner, bystander]:
                if process.poll() is None:
                    process.terminate()
                process.communicate(timeout=3)

    def test_multicall_cli_is_not_mistaken_for_daemon(self):
        proc = self.base / 'proc'
        for pid, name in [('101', 'tailscaled'), ('102', 'tailscale')]:
            (proc / pid).mkdir(parents=True)
            (proc / pid / 'cmdline').write_bytes((str(self.base / 'bin' / name) + '\0--socket=tailscaled.sock\0').encode())
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        function = settings[settings.index('_proc_cmdline() {'):settings.index('# Echo the subset')]
        function = function.replace('/proc/', str(proc) + '/')
        result = self.shell(function + '\npids_of() { printf \'101 102\'; }\nreadlink() { printf \'%s\' "$TS_BIN_DIR/tailscaled"; }\npids_of_path "$TS_BIN_DIR/tailscaled"')
        self.assertEqual(result.stdout.strip(), '101')

    def test_proc_command_snapshot_finishes_without_waiting_for_eof(self):
        proc = self.base / 'proc' / '101'
        proc.mkdir(parents=True)
        fifo = proc / 'cmdline'
        os.mkfifo(fifo)
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        function = settings[settings.index('_proc_cmdline() {'):settings.index('# Like pids_of')]
        function = function.replace('/proc/', str(self.base / 'proc') + '/')
        # Simulate a proc descriptor that yields an argument prefix but never
        # EOF. Discovery must release its controller instead of holding a lock.
        writer = subprocess.Popen(['sh', '-c', 'exec 3>"$1"; head -c 4096 /dev/zero >&3; sleep 5',
                                   'writer', str(fifo)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            start = time.monotonic()
            result = self.shell(function + '\n_proc_cmdline 101')
            self.assertLess(time.monotonic() - start, 1.5)
            self.assertEqual(result.stdout, '\n' * 4096)
        finally:
            writer.terminate()
            writer.wait(timeout=3)

    def test_process_lookup_skips_foreign_or_vanished_candidates_before_read(self):
        result = self.shell('''pids_of() { printf '101 102'; }
readlink() { return 1; }
_proc_cmdline() { touch "$TS_RUN_DIR/unsafe-read"; }
pids_of_path "$TS_BIN_DIR/tailscaled"''')
        self.assertEqual(result.stdout, '')
        self.assertFalse((self.run / 'unsafe-read').exists())

    def test_status_reports_live_daemon_without_socket_as_unreachable(self):
        result = json.loads(self.shell('''load_conf
daemon_exists() { return 0; }
ts_status_json() { touch "$TS_RUN_DIR/unexpected-cli"; }
cmd_status''').stdout)
        self.assertEqual((result['daemon'], result['backend']), ('running', 'unreachable'))
        self.assertFalse((self.run / 'unexpected-cli').exists())

    def test_peer_lists_distinguish_unknown_from_a_confirmed_empty_snapshot(self):
        for command in ('cmd_peers', 'cmd_exitnodes'):
            for prefix in ('daemon_up() { return 1; };',
                           'daemon_up() { return 0; }; ts_cli() { return 1; };'):
                result = self.shell(prefix + command, ok=False)
                self.assertNotEqual(result.returncode, 0)
                data = json.loads(result.stdout)
                self.assertFalse(data['ok']); self.assertNotIn('peers', data)
            for snapshot in ('', 'not json', '{}', '[]', 'null',
                             '{"BackendState":"NeedsLogin"}',
                             '{"BackendState":"Running","Peer":[]}',
                             '{"BackendState":"Running","Peer":{"x":"invalid"}}',
                             '{"BackendState":"Running","Peer":{}}'):
                for rc in (0, 1):
                    known = snapshot == '{"BackendState":"Running","Peer":{}}' and rc == 0
                    prefix = 'daemon_up() { return 0; }; ts_cli() { printf %s ' + shlex.quote(snapshot) + f'; return {rc}; }}; '
                    result = self.shell(prefix + command, ok=known)
                    data = json.loads(result.stdout)
                    self.assertEqual(data['ok'], known, (snapshot, rc, result.stdout))
                    if known:
                        self.assertEqual(data['peers'], [])
                    else:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertNotIn('peers', data)
        snapshot = {'BackendState': 'Running', 'Peer': {
            'a': {'ID': 'a', 'ExitNodeOption': True}, 'b': {'ID': 'b'}}}
        prefix = 'daemon_up() { return 0; }; ts_cli() { printf %s ' + shlex.quote(json.dumps(snapshot)) + '; }; '
        self.assertEqual(len(json.loads(self.shell(prefix + 'cmd_peers').stdout)['peers']), 2)
        self.assertEqual([peer['id'] for peer in json.loads(self.shell(prefix + 'cmd_exitnodes').stdout)['peers']], ['a'])

    def test_status_rechecks_process_after_localapi_failure(self):
        sock = socket.socket(socket.AF_UNIX)
        sock.bind(str(self.run / 'tailscaled.sock'))
        self.addCleanup(sock.close)
        for stopped in (False, True):
            with self.subTest(stopped=stopped):
                (self.run / 'alive').touch()
                result = json.loads(self.shell('''load_conf
daemon_exists() { [ -f "$TS_RUN_DIR/alive" ]; }
ts_status_json() { ''' + ('rm "$TS_RUN_DIR/alive";' if stopped else ':;') + ''' }
cmd_status''').stdout)
                expected = ('stopped', '-') if stopped else ('running', 'unreachable')
                self.assertEqual((result['daemon'], result['backend']), expected)

    def test_status_preserves_startup_login_and_machine_approval_states(self):
        sock = socket.socket(socket.AF_UNIX)
        sock.bind(str(self.run / 'tailscaled.sock'))
        self.addCleanup(sock.close)
        for backend in ('NoState', 'NeedsLogin', 'NeedsMachineAuth'):
            with self.subTest(backend=backend):
                (self.run / 'status.json').write_text(json.dumps({'BackendState': backend, 'Peer': {}, 'Self': None}))
                result = json.loads(self.shell('''load_conf
daemon_exists() { return 0; }
daemon_uptime() { echo 1; }
ts_status_json() { cat "$TS_RUN_DIR/status.json"; }
ts_cli() { touch "$TS_RUN_DIR/unexpected-auth-probe"; return 99; }
cmd_status''').stdout)
                self.assertTrue(result['ok'])
                self.assertEqual((result['daemon'], result['backend']), ('running', backend))
                self.assertFalse((self.run / 'unexpected-auth-probe').exists())

    def test_process_identity_handles_spaces_and_parentheses(self):
        proc = self.base / 'proc'
        (proc / '101').mkdir(parents=True)
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        function = settings[settings.index('_proc_starttime() {'):settings.index('_conf_pid_stamp() {')]
        function = function.replace('/proc/', str(proc) + '/')
        # Fields after comm are state then 18 numeric fields before starttime.
        rest = ' '.join(['S'] + ['0'] * 18 + ['123456', '999'])
        (proc / '101' / 'stat').write_text('101 (tailscale (worker) name) ' + rest + '\n')
        result = self.shell(function + '\n_proc_starttime 101')
        self.assertEqual(result.stdout.strip(), '123456')
        (proc / '101' / 'stat').write_text('101 (tailscaled) ' + rest.replace('S ', 'Z ', 1) + '\n')
        self.assertNotEqual(self.shell(function + '\n_proc_starttime 101', ok=False).returncode, 0)

    def test_expired_requests_never_restart_and_gc_is_bounded(self):
        result = self.shell("_op_init 1_expired status", ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('expired', result.stdout)
        self.shell("mkdir -p \"$TS_RUN_DIR/operations/1_done\"; touch \"$TS_RUN_DIR/operations/1_done/done\"; _op_gc")
        self.assertFalse((self.run / 'operations/1_done').exists())

    def test_stale_lock_recovers_without_an_owner_publish_gap(self):
        self.shell("ln -s '999999:-' \"$TS_RUN_DIR/.conf-write-lock\"; conf_write_key foxytail.conf DNS_PORT 1101")
        self.assertFalse((self.run / '.conf-write-lock').is_symlink())
        self.assertIn('DNS_PORT="1101"', (self.conf / 'foxytail.conf').read_text())

    def test_path_aware_serve_delete(self):
        result = self.shell('''ts_cli() { printf '%s\\n' "$*" >"$TS_RUN_DIR/args"; }
_serve_del serve https 8443 '/api/v1'
cat "$TS_RUN_DIR/args"''')
        self.assertIn('25 serve --bg --yes --https=8443 --set-path=/api/v1 off', result.stdout)

    def test_serve_and_funnel_keep_listener_and_upstream_protocols_separate(self):
        cli = '''ts_cli() { printf '%s\\n' "$@" >"$TS_RUN_DIR/args"; }
'''
        before = self.snapshot()
        for kind, proto, port, canonical in [
            ('serve', 'http', '0080', 80), ('serve', 'https', '65535', 65535),
            ('serve', 'tcp', '1', 1), ('serve', 'tls-terminated-tcp', '8443', 8443),
            ('funnel', 'https', '00443', 443), ('funnel', 'tcp', '8443', 8443),
            ('funnel', 'tls-terminated-tcp', '10000', 10000),
        ]:
            with self.subTest(kind=kind, proto=proto, port=port):
                target = 'http://127.0.0.1:3000/api' if proto in ('http', 'https') else 'tcp://127.0.0.1:3000'
                result = json.loads(self.shell(cli + '_serve_set ' + ' '.join(map(shlex.quote, [kind, proto, port, target]))).stdout)
                self.assertEqual(result, {'ok': True, 'kind': kind, 'proto': proto, 'port': canonical})
                self.assertEqual((self.run / 'args').read_text().splitlines(),
                                 ['25', kind, '--bg', f'--{proto}={canonical}', target])
                result = json.loads(self.shell(cli + f'_serve_del {kind} {proto} {port}').stdout)
                self.assertTrue(result['deleted']); self.assertEqual(result['port'], canonical)
                self.assertEqual((self.run / 'args').read_text().splitlines(),
                                 ['25', kind, '--bg', '--yes', f'--{proto}={canonical}', 'off'])
        result = json.loads(self.shell(cli + "_serve_del funnel https 8443 '/api/v1'").stdout)
        self.assertTrue(result['deleted'])
        self.assertEqual((self.run / 'args').read_text().splitlines(),
                         ['25', 'funnel', '--bg', '--yes', '--https=8443', '--set-path=/api/v1', 'off'])
        self.assertEqual(self.snapshot(), before)

    def test_unsupported_funnel_listeners_fail_before_any_cli_or_config_change(self):
        cli = '''ts_cli() { touch "$TS_RUN_DIR/unexpected-cli"; return 99; }
'''
        before = self.snapshot()
        invalid = [
            ('funnel', 'http', '443', 'funnel supports only https'),
            ('funnel', 'udp', '443', 'funnel supports only https'),
            ('serve', 'udp', '443', 'serve supports only http'),
            ('funnel', 'https', '80', 'funnel public port must be 443, 8443, or 10000'),
            ('funnel', 'tcp', '8080', 'funnel public port must be 443, 8443, or 10000'),
            ('funnel', 'tls-terminated-tcp', '65535', 'funnel public port must be 443, 8443, or 10000'),
        ]
        invalid += [('serve', 'http', port, 'invalid port') for port in ('', '0', '0000', '65536', '-1', '0x50', '443x')]
        for kind, proto, port, error in invalid:
            for action in ('set', 'del'):
                with self.subTest(kind=kind, proto=proto, port=port, action=action):
                    arguments = [kind, proto, port] + (['http://127.0.0.1:3000'] if action == 'set' else [])
                    result = self.shell(cli + f'_serve_{action} ' + ' '.join(map(shlex.quote, arguments)), ok=False)
                    self.assertNotEqual(result.returncode, 0)
                    data = json.loads(result.stdout)
                    self.assertFalse(data['ok']); self.assertIn(error, data['error'])
        self.assertFalse((self.run / 'unexpected-cli').exists())
        self.assertEqual(self.snapshot(), before)

    def test_funnel_cli_failure_remains_an_error_without_resetting_mappings(self):
        cli = '''ts_cli() { printf '%s\\n' "$@" >"$TS_RUN_DIR/args"; echo 'denied by tailnet policy' >&2; return 1; }
'''
        for action in ('set', 'del'):
            result = self.shell(cli + f'_serve_{action} funnel https 443' +
                                (' http://127.0.0.1:3000' if action == 'set' else ''), ok=False)
            self.assertNotEqual(result.returncode, 0)
            data = json.loads(result.stdout)
            self.assertFalse(data['ok']); self.assertIn('denied by tailnet policy', data['error'])
            self.assertNotIn('reset', (self.run / 'args').read_text().splitlines())

    def test_serve_set_never_interprets_a_target_as_delete_or_flags(self):
        before = self.snapshot()
        for kind in ('serve', 'funnel'):
            for target in ('off', '--https=8443', '--bg=false', '-x'):
                with self.subTest(kind=kind, target=target):
                    result = self.shell('''ts_cli() { touch "$TS_RUN_DIR/unexpected-cli"; return 99; }
''' + f'_serve_set {kind} https 443 ' + shlex.quote(target), ok=False)
                    self.assertNotEqual(result.returncode, 0)
                    data = json.loads(result.stdout)
                    self.assertFalse(data['ok']); self.assertIn('control arguments', data['error'])
        self.assertFalse((self.run / 'unexpected-cli').exists())
        self.assertEqual(self.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
