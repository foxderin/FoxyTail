"""Host-only network regressions against the actual shell functions."""
import json
import shlex
import socket
import unittest

from api_fixture import ApiTestCase, ROOT


class NetworkApiTests(ApiTestCase):
    def test_exit_mutations_preserve_failure_payload_and_exact_identity(self):
        helper = self.scripts / 'foxytail.exitnode'
        helper.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >>"$TS_DIR/exit-calls"\n'
                          'echo \'{"ok":false,"error":"route-apply-failed","exitRouting":{"known":true,"selected":{"id":"node-b"},"effective":"not-effective"}}\'\nexit 1\n')
        helper.chmod(0o755)
        prefix = 'load_conf; export TS_DIR; _op_exec() { test "$1" = 90 || return 9; shift; "$@"; }; '
        for command in ('cmd_exitnode_set node-b', 'cmd_exitnode_clear'):
            response = self.shell(prefix + command, ok=False)
            self.assertNotEqual(response.returncode, 0)
            result = json.loads(response.stdout)
            self.assertFalse(result['ok'])
            self.assertEqual(result['exitRouting']['effective'], 'not-effective')
            self.assertEqual(result['error'], 'route-apply-failed')
        self.assertEqual((self.base / 'exit-calls').read_text().splitlines(), ['set node-b', 'clear'])


    def test_status_unreachable_and_stopped_never_fabricate_peer_inventory(self):
        result = json.loads(self.shell('''load_conf
daemon_up() { return 0; }
daemon_exists() { return 0; }
daemon_uptime() { echo 2; }
ts_status_json() { return 1; }
cmd_status''').stdout)
        self.assertEqual((result['daemon'], result['backend']), ('running', 'unreachable'))
        self.assertIsNone(result['peerList'])
        result = json.loads(self.shell('''load_conf
daemon_up() { return 1; }
daemon_exists() { return 1; }
ts_status_json() { touch "$TS_RUN_DIR/unexpected-cli"; return 9; }
cmd_status''').stdout)
        self.assertEqual((result['daemon'], result['backend']), ('stopped', '-'))
        self.assertIsNone(result['peerList'])
        self.assertFalse((self.run / 'unexpected-cli').exists())


    def test_read_helpers_never_publish_success_after_cancellation(self):
        for command in ('cmd_status', 'cmd_exit_routing', 'cmd_dns', 'cmd_dns_probe', 'cmd_trial_status', 'cmd_context_status'):
            with self.subTest(command=command):
                for name in ('foxytail.exitnode', 'foxytail.dns', 'foxytail.trial'):
                    helper = self.scripts / name
                    helper.write_text('#!/bin/sh\necho \'{"ok":true}\'\n')
                    helper.chmod(0o755)
                result = self.shell('''load_conf
daemon_up() { return 0; }
_op_cancelled() { return 0; }
''' + command, ok=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(json.loads(result.stdout)['ok'])

    def dns_account_fixture(self, fail=False):
        script = self.scripts / 'foxytail.dns'
        script.write_text('#!/bin/sh\n' +
            '[ "$1" != stop ] || test -L ' + shlex.quote(str(self.run / 'dns-account-transition')) + ' || exit 9\n' +
            'echo "$1" >>' + shlex.quote(str(self.base / 'dns-actions')) + '\n' +
            ('[ "$1" != stop ]\n' if fail else 'exit 0\n'))
        script.chmod(0o755)
        # Keep the capture pipe open until the detached DNS restart exits.
        return '''exec 3>&1
load_conf; DNS_MODE=transparent
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


    def test_routes_invalid_cidr_does_not_persist_partial_configuration(self):
        before = self.snapshot()
        result = self.shell("load_conf; cmd_routes_set all - '192.168.1.7/24,1::2::3/64'", ok=False)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.run / 'settings.pending').exists())


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

    def peer_ping_fixture(self):
        (self.run / 'peer-status.json').write_text(json.dumps({'BackendState': 'Running', 'Peer': {
            'p1': {'ID': 'p1', 'TailscaleIPs': ['100.64.0.2', 'fd7a:115c:a1e0::2'], 'Relay': 'sin',
                   'CurAddr': '192.0.2.1:41641', 'Active': True},
            'p2': {'ID': 'p2', 'TailscaleIPs': ['100.64.0.3'], 'Online': True},
        }}))
        return '''load_conf
daemon_up() { return 0; }
ts_status_json() { cat "$TS_RUN_DIR/peer-status.json"; }
ts_cli() { printf '%s\\n' "$*" >>"$TS_RUN_DIR/ping-calls"; cat "$TS_RUN_DIR/ping-output"; return "${PING_RC:-0}"; }
'''


    def test_peer_ping_rejects_invalid_or_foreign_targets_before_launching(self):
        prefix = self.peer_ping_fixture()
        for peer, ip in [('p1', '100.64.0.3'), ('missing', '100.64.0.2'), ('', '100.64.0.2'),
                         ('p1', '100.64.0.2;touch /tmp/unsafe'), ('p1', '--help'),
                         ('p1', 'peer.example'), ('p1', '1::2::3'), ('p1', '999.0.0.2')]:
            with self.subTest(peer=peer, ip=ip):
                result = self.shell(prefix + 'cmd_peer_ping ' + shlex.quote(peer) + ' ' + shlex.quote(ip), ok=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(json.loads(result.stdout)['ok'])
        for snapshot in [{}, [], {'BackendState': 'NeedsLogin'}, {'BackendState': 'Running', 'Peer': []}]:
            (self.run / 'peer-status.json').write_text(json.dumps(snapshot))
            result = self.shell(prefix + 'cmd_peer_ping p1 100.64.0.2', ok=False)
            self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertFalse((self.run / 'ping-calls').exists())

    def test_peer_ping_timeout_malformed_reply_and_cancellation_never_claim_success(self):
        prefix = self.peer_ping_fixture()
        for output in ['ping timed out\nno reply', 'pong from peer (100.64.0.3) via DERP(tok) in 2ms',
                       'pong from peer (100.64.0.2) via DERP(tok) in NaNms']:
            (self.run / 'ping-output').write_text(output)
            result = self.shell(prefix + 'cmd_peer_ping p1 100.64.0.2', ok=False)
            self.assertFalse(json.loads(result.stdout)['ok'])
        (self.run / 'ping-output').write_text('pong from peer (100.64.0.2) via DERP(tok) in 3ms')
        result = self.shell(prefix + '_op_cancelled() { return 0; }; cmd_peer_ping p1 100.64.0.2', ok=False)
        self.assertIn('cancelled', json.loads(result.stdout)['error'])


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

    def dns_probe_fixture(self, body):
        dns = self.scripts / 'foxytail.dns'
        dns.write_text('#!/bin/sh\n' + body)
        dns.chmod(0o755)
        return 'load_conf; _op_exec() { shift; "$@"; }; cmd_dns_probe'


    def test_dns_probe_reason_stays_a_string_even_when_it_looks_like_json(self):
        fixture = self.dns_probe_fixture('printf %s \'{"nested":1}\' >&2\nexit 1\n')
        result = json.loads(self.shell(fixture).stdout)
        self.assertFalse(result['transparentAvailable'])
        self.assertEqual(result['transparentUnavailableReason'], '{"nested":1}')
        self.assertEqual(result['hijackUnavailableReason'], '{"nested":1}')


if __name__ == '__main__':
    unittest.main()
