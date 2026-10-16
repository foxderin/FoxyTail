import 'dart:convert';
import 'dart:io';

import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/features/settings/settings_rules.dart';

bool validPort(String value) => RegExp(r'^[0-9]{1,5}$').hasMatch(value) &&
    int.parse(value) > 0 && int.parse(value) <= 65535;
bool measured(Object? value) => value is num && value.isFinite && value >= 0;
String identityOf(Json? status) => string(json(status?['self'])['id']);
String connectionState(Json? status) {
  if (status == null || status['ok'] != true || status['backend'] == 'unreachable') return 'unknown';
  if (status['daemon'] == 'stopped') return 'stopped';
  if (status['daemon'] != 'running') return 'unknown';
  return switch (status['backend']) {
    'Running' => 'connected', 'NeedsLogin' => 'login',
    'NeedsMachineAuth' => 'machine-auth', 'Starting' || 'NoState' => 'starting',
    _ => 'unknown',
  };
}
bool serviceKnown(Json? status) => status?['ok'] == true && status?['backend'] != 'unreachable' &&
    const ['running', 'stopped'].contains(status?['daemon']) && const ['tun', 'bridge', 'proxy'].contains(status?['mode']);
bool stopAvailable(Json? status, bool fresh) => !fresh || status?['ok'] != true || status?['daemon'] != 'stopped';
bool expiresSoon(String value, DateTime now) {
  final expiry = DateTime.tryParse(value);
  return expiry != null && expiry.difference(now) < const Duration(days: 7);
}
List<String> addresses(Json peer) => (peer['ips'] is List ? peer['ips'] as List : [peer['ip']])
    .whereType<String>().where((ip) => ip.isNotEmpty && ip != '-').toSet().toList();
List<Json> decodePeerList(Json? status) {
  final list = status?['peerList'];
  if (identityOf(status).isEmpty || list is! List || list.length > 10000) throw const FormatException('Invalid peer inventory');
  return list.map((raw) {
    final peer = json(raw);
    if (peer['id'] is! String || string(peer['id']).isEmpty || peer['hostname'] is! String || peer['online'] is! bool) {
      throw const FormatException('Invalid peer identity or online state');
    }
    return peer;
  }).toList();
}
int pathRank(Json peer) => peer['online'] != true ? 2 : string(peer['curAddr']).isEmpty ? 1 : 0;
List<Json> diagramPeers(List<Json> peers) {
  final sorted = [...peers]..sort((a, b) {
    final rank = pathRank(a).compareTo(pathRank(b));
    if (rank != 0) return rank;
    if (pathRank(a) == 1) {
      final region = string(a['relay'], '—').toLowerCase().compareTo(string(b['relay'], '—').toLowerCase());
      if (region != 0) return region;
    }
    return string(a['hostname']).toLowerCase().compareTo(string(b['hostname']).toLowerCase());
  });
  return sorted.take(12).toList();
}
bool validProbe(Json result, String id, String ip) => result['ok'] == true &&
    result['peerId'] == id && result['ip'] == ip && measured(result['latencyMs']) &&
    result['via'] is String && result['path'] is String;
String? selectedExitId(Json? route) {
  if (route?['known'] != true || !route!.containsKey('selected')) return null;
  if (route['selected'] == null) return '';
  final selected = json(route['selected']);
  if (string(selected['auto']).isNotEmpty) return 'auto:${selected['auto']}';
  for (final key in ['id', 'ip']) {
    if (string(selected[key]).isNotEmpty) return string(selected[key]);
  }
  return null;
}
bool validServer(String value) {
  try {
    final uri = Uri.parse(value);
    return const ['http', 'https'].contains(uri.scheme.toLowerCase()) && uri.host.isNotEmpty &&
        uri.userInfo.isEmpty && !uri.hasFragment && (!uri.hasPort || uri.port >= 1 && uri.port <= 65535) &&
        !RegExp(r'\s').hasMatch(value);
  } on FormatException { return false; }
}
bool hasActiveTransfers(Json history) {
  final rows = history['transfers'];
  if (rows is! List) throw const FormatException('Unknown transfer history');
  var active = false;
  for (final row in rows) {
    switch (json(row)['status']) {
      case 'queued': case 'sending': active = true;
      case 'completed': case 'failed': case 'cancelled': case 'interrupted': break;
      default: throw const FormatException('Unknown transfer state');
    }
  }
  return active;
}
String? numericEndpoint(Object? port) => port is num && port.isFinite && port == port.roundToDouble() && port > 0 && port <= 65535
    ? '127.0.0.1:${port.toInt()}' : null;
bool modernDns(Json data) => const ['local', 'transparent'].contains(data['mode']);
bool dnsReady(Json data) => data['listenerReady'] == true && data['state'] == 'running' &&
    data['repairNeeded'] == false && data['policyState'] == 'owned' && data['enabled'] == true &&
    (data['mode'] == 'local' ? data['reason'] == 'local' : const ['running', 'ipv6-unavailable'].contains(data['reason']));
String? dnsEndpoint(Json data) => modernDns(data) && data['listenerReady'] == true ? numericEndpoint(data['port']) : null;

class ServeMapping {
  const ServeMapping(this.protocol, this.port, this.host, this.path, this.target, this.funnel);
  final String protocol, port, host, target;
  final String? path;
  final bool funnel;
  String get endpoint => '$protocol $host:$port${path ?? ''}';
  List<String> deleteArgs() {
    if (protocol == 'unknown') throw const FormatException('Unsupported listener');
    return [funnel ? 'funnel-del' : 'serve-del', protocol, port, if (path != null) path!];
  }
}
List<ServeMapping> serveMappings(Json status) {
  final result = <ServeMapping>[];
  final tcp = json(status['TCP']), allow = json(status['AllowFunnel']);
  for (final entry in tcp.entries) {
    final listener = json(entry.value);
    if (listener['TCPForward'] is! String) continue;
    final funnel = allow.entries.any((host) => host.key.endsWith(':${entry.key}') && host.value == true);
    result.add(ServeMapping(string(listener['TerminateTLS']).isEmpty ? 'tcp' : 'tls-terminated-tcp', entry.key, '', null, listener['TCPForward'] as String, funnel));
  }
  for (final entry in json(status['Web']).entries) {
    final colon = entry.key.lastIndexOf(':');
    if (colon < 0 || !validPort(entry.key.substring(colon + 1))) continue;
    final port = entry.key.substring(colon + 1), listener = json(tcp[entry.key.substring(colon + 1)]);
    final protocol = listener['HTTPS'] == true ? 'https' : listener['HTTP'] == true ? 'http' : 'unknown';
    for (final handler in json(json(entry.value)['Handlers']).entries) {
      final data = json(handler.value);
      var target = '';
      for (final key in ['Proxy', 'Path', 'Text']) {
        if (data[key] is String) { target = data[key] as String; break; }
      }
      result.add(ServeMapping(protocol, port, entry.key.substring(0, colon), handler.key, target, allow[entry.key] == true));
    }
  }
  return result;
}
const serveProtocols = ['https', 'http', 'tcp', 'tls-terminated-tcp'];
const funnelPorts = ['443', '8443', '10000'];
bool validServe(bool funnel, String protocol, String port, String target) =>
    serveProtocols.contains(protocol) && validPort(port) && target.trim().isNotEmpty &&
    (!funnel || protocol != 'http' && funnelPorts.contains(port));
typedef ServeDraft = ({bool funnel, String protocol, String port, String target});

bool canCoexistCheck(Json? info, Json? peer, String address, String port, String resolver) =>
    info?['ok'] == true && info?['dnsReady'] == true && peer != null &&
    string(peer['id']).isNotEmpty && string(peer['dnsName']).isNotEmpty &&
    addresses(peer).contains(address) && validPort(port) &&
    (resolver.isEmpty || validPort(resolver) && int.parse(resolver) != json(info?['dns'])['port']);
String coexistSnippet(Json info, String filter) {
  if (!const ['blacklist', 'rule', 'redir-host'].contains(filter)) throw const FormatException('Unsupported fake-IP filter mode');
  final dns = json(info['dns']), mode = string(info['mode']), suffix = string(info['suffix']);
  if (info['ok'] != true || info['dnsReady'] != true || dns['ok'] != true || dns['enabled'] != true ||
      dns['listenerReady'] != true || dns['repairNeeded'] != false || dns['policyState'] != 'owned' ||
      !modernDns(dns) || suffix != dns['suffix']) throw const FormatException('DNS listener is not ready');
  if (!const ['bridge', 'proxy', 'tun'].contains(mode) || !validPort('${info['socksPort']}') || !validPort('${dns['port']}')) {
    throw const FormatException('Invalid applied mode or port');
  }
  if (suffix.length > 253 || suffix.toLowerCase() == 'ts.net' ||
      !RegExp(r'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$').hasMatch(suffix)) {
    throw const FormatException('Invalid Tailnet suffix');
  }
  if (info['addresses'] is! List) throw const FormatException('Missing current addresses');
  final cidrs = <String>{};
  for (final raw in info['addresses'] as List) {
    if (raw is! String || !RegExp(r'^[0-9a-fA-F:.]+$').hasMatch(raw)) throw const FormatException('Invalid address');
    final ip = InternetAddress.tryParse(raw);
    if (ip == null || ip.isLoopback || ip.isLinkLocal || ip.isMulticast || ip.rawAddress.every((b) => b == 0)) {
      throw const FormatException('Address must be unicast');
    }
    final bytes = ip.rawAddress;
    if (ip.type == InternetAddressType.IPv4 && (bytes[0] == 0 || bytes[0] >= 224 || raw.split('.').any((part) => !RegExp(r'^(0|[1-9][0-9]{0,2})$').hasMatch(part))) ||
        ip.type == InternetAddressType.IPv6 && bytes.take(10).every((b) => b == 0) && bytes[10] == 255 && bytes[11] == 255) {
      throw const FormatException('Address must be unicast');
    }
    cidrs.add(canonicalCidr('$raw/${ip.type == InternetAddressType.IPv6 ? 128 : 32}'));
  }
  if (cidrs.isEmpty) throw const FormatException('No current addresses');
  const proxy = 'FoxyTail-Tailnet';
  final text = StringBuffer('dns:\n  enable: true\n  nameserver-policy:\n    ${jsonEncode('+.$suffix')}: ${jsonEncode('tcp://127.0.0.1:${dns['port']}#DIRECT')}\n  direct-nameserver-follow-policy: true\n');
  if (filter != 'redir-host') text.write('  fake-ip-filter-mode: $filter\n  fake-ip-filter:\n    - ${jsonEncode(filter == 'rule' ? 'DOMAIN-SUFFIX,$suffix,real-ip' : '+.$suffix')}\n');
  text.write('proxies:\n  - name: "$proxy"\n');
  text.write(mode == 'tun' ? '    type: direct\n    interface-name: "tailscale0"\n' : '    type: socks5\n    server: "127.0.0.1"\n    port: ${info['socksPort']}\n');
  text.write('    udp: true\nrules:\n  - ${jsonEncode('DOMAIN-SUFFIX,$suffix,$proxy')}\n');
  for (final cidr in cidrs) { text.write('  - ${jsonEncode('${cidr.contains(':') ? 'IP-CIDR6' : 'IP-CIDR'},$cidr,$proxy,no-resolve')}\n'); }
  return text.toString();
}
