import 'package:flutter_test/flutter_test.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/features/network/network_rules.dart';
import 'package:foxytail/features/network/network_labels.dart';
import 'package:foxytail/l10n/generated/app_localizations_en.dart';

void main() {
  test('connection uncertainty and authorization remain distinct', () {
    final status = <String, dynamic>{'ok': true, 'daemon': 'running', 'mode': 'bridge'};
    expect(connectionState(status), 'unknown');
    for (final entry in {'NeedsLogin': 'login', 'NeedsMachineAuth': 'machine-auth', 'Starting': 'starting', 'Running': 'connected'}.entries) {
      status['backend'] = entry.key;
      expect(connectionState(status), entry.value);
    }
    status['backend'] = 'unreachable';
    expect(serviceKnown(status), false);
    expect(stopAvailable(status, true), true);
    expect(stopAvailable(null, false), true);
    status['daemon'] = 'stopped';
    expect(connectionState(status), 'unknown');
    expect(stopAvailable({'ok': true, 'daemon': 'stopped'}, true), false);
    expect(expiresSoon('invalid', DateTime.utc(1970)), false);
    expect(expiresSoon('1970-01-02T00:00:00Z', DateTime.utc(1970)), true);
  });
  test('peer inventory is scoped and does not accept guessed online state', () {
    final peer = <String, dynamic>{'id': 'a', 'hostname': 'peer', 'online': true, 'ips': ['100.64.0.1', 'fd7a:115c:a1e0::1', '-', 17, '100.64.0.1']};
    expect(addresses(peer), ['100.64.0.1', 'fd7a:115c:a1e0::1']);
    expect(pathRank(peer), 1);
    peer['curAddr'] = '192.0.2.1:41641';
    expect(pathRank(peer), 0);
    peer['online'] = false;
    expect(pathRank(peer), 2);
    final status = <String, dynamic>{'self': {'id': 'self'}, 'peerList': [peer]};
    expect(decodePeerList(status), [peer]);
    expect(() => decodePeerList({...status, 'self': <String, dynamic>{}}), throwsFormatException);
    expect(() => decodePeerList({...status, 'peerList': [{'id': 'bad', 'hostname': 'bad'}]}), throwsFormatException);
  });
  test('probe identity and numeric result must match request', () {
    final probe = <String, dynamic>{'ok': true, 'peerId': 'node', 'ip': '100.64.0.1', 'latencyMs': 0, 'via': 'DERP(sin)', 'path': 'derp'};
    expect(validProbe(probe, 'node', '100.64.0.1'), true);
    expect(validProbe(probe, 'other', '100.64.0.1'), false);
    expect(validProbe(probe, 'node', '100.64.0.2'), false);
    expect(validProbe({...probe, 'latencyMs': '3'}, 'node', '100.64.0.1'), false);
    expect(validProbe({...probe, 'latencyMs': double.infinity}, 'node', '100.64.0.1'), false);
  });
  test('diagram bounds only its copy and prioritizes actual paths', () {
    final peers = List<Json>.generate(15, (i) => {'id': 'node$i', 'hostname': 'Peer $i', 'online': i >= 10});
    peers[14]['curAddr'] = '192.0.2.1:41641';
    final diagram = diagramPeers(peers);
    expect(diagram.length, 12);
    expect(diagram.first, same(peers[14]));
    expect(diagram[1], same(peers[10]));
    expect(diagram[5], same(peers[0]));
    expect(peers.length, 15);
    expect(peers.first['id'], 'node0');
  });
  test('login URL boundaries and fail-closed transfer history', () {
    for (final url in ['http://headscale.example:8080/path', 'https://headscale.example']) { expect(validServer(url), true); }
    for (final url in ['javascript:alert(1)', 'https://user:secret@example.com', 'https://example.com:65536', 'https://example.com:0', 'https://example.com/#secret']) { expect(validServer(url), false); }
    expect(hasActiveTransfers({'transfers': [{'status': 'sending'}]}), true);
    expect(hasActiveTransfers({'transfers': [{'status': 'interrupted'}]}), false);
    expect(() => hasActiveTransfers({}), throwsFormatException);
    expect(() => hasActiveTransfers({'transfers': [{'status': 'future'}]}), throwsFormatException);
    expect(() => hasActiveTransfers({'transfers': [{'status': 'sending'}, {'status': 'future'}]}), throwsFormatException);
  });
  test('exit selection distinguishes null, missing, automatic and ineffective', () {
    final l = AppLocalizationsEn();
    expect(selectedExitId({'known': true}), null);
    expect(selectedExitId({'known': true, 'selected': null}), '');
    expect(selectedExitId({'known': true, 'selected': {'auto': 'any'}}), 'auto:any');
    final route = <String, dynamic>{'known': true, 'selected': {'id': 'node'}, 'effective': 'not-effective'};
    expect(selectedExitId(route), 'node');
    expect(exitLabel(l, route), l.web_net_exit_failed);
    expect(exitLabel(l, {'known': true}), l.web_net_exit_unknown_hint);
  });
  test('DNS health requires observed listener and owned policy', () {
    final l = AppLocalizationsEn();
    final dns = <String, dynamic>{'mode': 'transparent', 'enabled': true, 'listenerReady': true, 'state': 'running', 'repairNeeded': false, 'policyState': 'owned', 'reason': 'running', 'interception4': true, 'interception6': false, 'port': 1053};
    expect(dnsLabel(l, dns), l.web_tools_dns_transparent_ipv4);
    expect(dnsEndpoint(dns), '127.0.0.1:1053');
    expect(dnsReady({...dns, 'repairNeeded': true}), false);
    expect(dnsReady({...dns, 'policyState': 'foreign'}), false);
    expect(dnsReady({...dns, 'enabled': null}), false);
    expect(dnsEndpoint({...dns, 'port': 1053.5}), null);
    expect(numericEndpoint('1099'), null);
    expect(numericEndpoint(65536), null);
    expect(dnsLabel(l, {}), l.web_net_unknown);
  });
  test('exact handler removal uses listener flags rather than port', () {
    final mappings = serveMappings({
      'TCP': {'443': {'HTTP': true}, '8443': {'HTTPS': true}, '10000': {'TCPForward': 'localhost:22', 'TerminateTLS': 'node.test.ts.net'}},
      'Web': {'node:443': {'Handlers': {'/exact': {'Proxy': 'http://localhost:3000'}}}, 'node:8443': {'Handlers': {'/a/b': {'Text': 'hello'}}}, 'node:1234': {'Handlers': {'/unknown': {'Path': '/tmp'}}}},
      'AllowFunnel': {'node:8443': true, 'node:10000': true},
    });
    expect(mappings.length, 4);
    expect(mappings.singleWhere((m) => m.port == '443').deleteArgs(), ['serve-del', 'http', '443', '/exact']);
    expect(mappings.singleWhere((m) => m.port == '8443').deleteArgs(), ['funnel-del', 'https', '8443', '/a/b']);
    expect(mappings.singleWhere((m) => m.port == '10000').deleteArgs(), ['funnel-del', 'tls-terminated-tcp', '10000']);
    expect(() => mappings.singleWhere((m) => m.port == '1234').deleteArgs(), throwsFormatException);
  });
  test('Serve protocol and public port constraints', () {
    expect(validServe(false, 'http', '443', 'http://localhost:3000'), true);
    expect(validServe(true, 'http', '443', 'http://localhost:3000'), false);
    expect(validServe(true, 'https', '444', 'http://localhost:3000'), false);
    expect(validServe(true, 'tcp', '10000', 'localhost:22'), true);
  });
  test('coexist snippets remain bound to exact safe host routes and DNS', () {
    final info = <String, dynamic>{'ok': true, 'dnsReady': true, 'mode': 'bridge', 'socksPort': 1099, 'suffix': 'example.ts.net', 'addresses': ['100.64.0.1', 'fd7a:115c:a1e0::1'], 'dns': {'ok': true, 'enabled': true, 'listenerReady': true, 'repairNeeded': false, 'policyState': 'owned', 'mode': 'local', 'port': 1053, 'suffix': 'example.ts.net'}};
    final snippet = coexistSnippet(info, 'blacklist');
    expect(snippet, contains('tcp://127.0.0.1:1053#DIRECT'));
    expect(snippet, contains('IP-CIDR,100.64.0.1/32,FoxyTail-Tailnet,no-resolve'));
    expect(snippet, contains('IP-CIDR6,fd7a:115c:a1e0::1/128,FoxyTail-Tailnet,no-resolve'));
    expect(coexistSnippet(info, 'rule'), contains('DOMAIN-SUFFIX,example.ts.net,real-ip'));
    expect(coexistSnippet(info, 'redir-host'), isNot(contains('fake-ip-filter')));
    expect(coexistSnippet({...info, 'mode': 'tun'}, 'rule'), contains('interface-name: "tailscale0"'));
    expect(() => coexistSnippet(info, 'whitelist'), throwsFormatException);
    expect(() => coexistSnippet({...info, 'dns': {...json(info['dns']), 'repairNeeded': null}}, 'rule'), throwsFormatException);
    for (final address in ['localhost', '127.0.0.1', '0.0.0.2', '224.0.0.1', '169.254.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', '1.2.3.999']) {
      expect(() => coexistSnippet({...info, 'addresses': [address]}, 'blacklist'), throwsFormatException);
    }
    final peer = <String, dynamic>{'id': 'n1', 'dnsName': 'peer.example.ts.net', 'ips': ['100.64.0.2']};
    expect(canCoexistCheck(info, peer, '100.64.0.2', '443', ''), true);
    expect(canCoexistCheck(info, peer, '100.64.0.2', '443', '5353'), true);
    expect(canCoexistCheck(info, peer, '100.64.0.2', '443', '1053'), false);
    expect(canCoexistCheck(info, peer, '100.64.0.3', '443', ''), false);
    expect(canCoexistCheck({...info, 'dnsReady': false}, peer, '100.64.0.2', '443', ''), false);
  });
}
