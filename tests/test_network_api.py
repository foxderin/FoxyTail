"""Host-only network regressions against the actual shell functions."""
import json
import shlex
import socket
import unittest

from api_fixture import ApiTestCase, ROOT


class NetworkApiTests(ApiTestCase):
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
cmd_routes_set all - ' , 192.168.1.7/24,192.168.1.0/24,,
FD12::55/64,fd12::/64,192.168.1.10/32 , ' ''').stdout)
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
        status.update(mode='transparent', state='running', enabled=True, listenerReady=True,
                      interception4=True, interception6=False, repairNeeded=False, policyState='owned',
                      ipv6DnsInterception='fallback', ipv6ModuleStatus='missing')
        dns.write_text('#!/bin/sh\nprintf %s ' + shlex.quote(json.dumps(status)) + '\n')
        self.assertEqual(json.loads(self.shell('load_conf; cmd_dns').stdout), {'ok': True, **modern_defaults, **status})

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

    def test_peer_lists_keep_all_addresses_when_local_ipv6_is_disabled(self):
        expected = {
            'dual': ('100.64.0.2', ['100.64.0.2', 'fd7a:115c:a1e0::2']),
            'ipv6': ('fd7a:115c:a1e0::3', ['fd7a:115c:a1e0::3']),
            'empty': ('-', []),
            'missing': ('-', []),
        }
        snapshot = {'BackendState': 'Running', 'Peer': {
            name: {'ID': name, 'ExitNodeOption': True, 'TailscaleIPs': addresses}
            for name, (_, addresses) in expected.items()}}
        del snapshot['Peer']['missing']['TailscaleIPs']
        (self.run / 'status.json').write_text(json.dumps(snapshot))
        prefix = '''load_conf; IPV6=off
daemon_up() { return 0; }
ts_cli() { cat "$TS_RUN_DIR/status.json"; }
'''
        for command in ('cmd_peers', 'cmd_exitnodes'):
            with self.subTest(command=command):
                result = json.loads(self.shell(prefix + command).stdout)
                self.assertEqual({peer['id']: (peer['ip'], peer['ips']) for peer in result['peers']}, expected)

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
