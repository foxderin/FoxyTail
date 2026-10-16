import 'dart:convert';

class ContextRule {
  const ContextRule(this.trigger, this.value, this.action, [this.argument = '']);
  final String trigger, value, action, argument;
  String get line => '$trigger:${trigger == 'cellular' ? '-' : value}:$action${action == 'exit-node' ? ':$argument' : ''}';
}

ContextRule? parseContextRule(String line) {
  final text = line.replaceFirst(RegExp(r'\r$'), '').replaceFirst(RegExp(r'^[ \t]+'), '').replaceFirst(RegExp(r'[ \t]+$'), '');
  if (RegExp(r'[\x00-\x1f\x7f#]').hasMatch(text)) return null;
  final match = RegExp(r'^(ssid|cellular):([^:]*):(up|down|exit-node|no-exit-node)(?::(.*))?$').firstMatch(text);
  if (match == null) return null;
  final trigger = match[1]!, value = match[2]!, action = match[3]!, argument = match[4];
  if (trigger == 'cellular' ? value != '-' : value.trim().isEmpty || value.contains('"') || ['unknown', '<unknown ssid>', '<none>'].contains(value)) return null;
  if (action == 'exit-node' ? argument == null || !RegExp(r'^[A-Za-z0-9:][A-Za-z0-9_.:%-]*$').hasMatch(argument) : argument != null) return null;
  return ContextRule(trigger, value, action, argument ?? '');
}

List<int> visibleContextRules(String raw) {
  final lines = raw.split('\n');
  return [for (var i = 0; i < lines.length; i++) if (!RegExp(r'^[ \t]*\r?$').hasMatch(lines[i]) && !RegExp(r'^[ \t]*#').hasMatch(lines[i])) i];
}

String replaceContextRule(String raw, int index, String line) {
  if (parseContextRule(line) == null) throw const FormatException('Invalid context rule');
  if (index < 0) {
    final newline = raw.contains('\r\n') ? '\r\n' : '\n';
    return '$raw${raw.isNotEmpty && !raw.endsWith('\n') ? newline : ''}$line$newline';
  }
  final lines = raw.split('\n');
  lines[index] = '$line${lines[index].endsWith('\r') ? '\r' : ''}';
  return lines.join('\n');
}

String removeContextRule(String raw, int index) {
  var current = 0;
  return RegExp(r'[^\n]*\n|[^\n]+$').allMatches(raw).where((_) => current++ != index).map((match) => match[0]!).join();
}

String moveContextRule(String raw, int from, int to) {
  final lines = raw.split('\n');
  final a = lines[from], b = lines[to];
  lines[from] = '${b.replaceFirst(RegExp(r'\r$'), '')}${a.endsWith('\r') ? '\r' : ''}';
  lines[to] = '${a.replaceFirst(RegExp(r'\r$'), '')}${b.endsWith('\r') ? '\r' : ''}';
  return lines.join('\n');
}

bool contextWithinLimit(String raw) => utf8.encode(raw).length <= 48 * 1024;

Set<String> parseUids(String raw) {
  final result = <String>{};
  for (final value in raw.trim().split(RegExp(r'[,\s]+'))) {
    if (value.isEmpty) continue;
    final uid = int.tryParse(value);
    if (!RegExp(r'^[0-9]+$').hasMatch(value) || uid == null || uid > 2147483647) throw FormatException('Invalid UID', value);
    result.add(uid.toString());
  }
  return result;
}

Set<String> canonicalCidrs(String raw) => {for (final value in raw.trim().split(RegExp(r'[,\s]+'))) if (value.isNotEmpty) canonicalCidr(value)};
bool validCidr(String input) {
  try { canonicalCidr(input); return true; } on FormatException { return false; }
}

// Numeric parsing deliberately never performs DNS resolution.
String canonicalCidr(String input) {
  final parts = input.trim().split('/');
  if (parts.length != 2 || !RegExp(r'^[0-9]{1,3}$').hasMatch(parts[1])) throw FormatException('Invalid CIDR', input);
  final prefix = int.parse(parts[1]), v6 = parts[0].contains(':');
  final bytes = v6 ? _ipv6(parts[0]) : _ipv4(parts[0]);
  if (prefix > bytes.length * 8) throw FormatException('Invalid CIDR', input);
  for (var i = 0; i < bytes.length; i++) {
    final bits = (prefix - i * 8).clamp(0, 8).toInt();
    bytes[i] &= (255 << (8 - bits)) & 255;
  }
  if (!v6) return '${bytes.join('.')}/$prefix';
  final words = [for (var i = 0; i < 8; i++) bytes[2 * i] * 256 + bytes[2 * i + 1]];
  var best = -1, count = 1;
  for (var i = 0; i < 8;) {
    if (words[i] != 0) { i++; continue; }
    var end = i;
    while (end < 8 && words[end] == 0) { end++; }
    if (end - i > count) { best = i; count = end - i; }
    i = end;
  }
  final out = StringBuffer();
  for (var i = 0; i < 8;) {
    if (i == best) { out.write('::'); i += count; }
    else {
      if (i > 0 && i != best + count) out.write(':');
      out.write(words[i++].toRadixString(16));
    }
  }
  return '$out/$prefix';
}

List<int> _ipv4(String raw) {
  final parts = raw.split('.');
  if (parts.length != 4) throw FormatException('Invalid IPv4', raw);
  return parts.map((part) {
    if (!RegExp(r'^[0-9]{1,3}$').hasMatch(part)) throw FormatException('Invalid IPv4', raw);
    final byte = int.parse(part);
    if (byte > 255) throw FormatException('Invalid IPv4', raw);
    return byte;
  }).toList();
}

List<int> _ipv6(String raw) {
  if (!RegExp(r'^[0-9a-fA-F:.]+$').hasMatch(raw)) throw FormatException('Invalid IPv6', raw);
  if (raw.contains('.')) {
    final colon = raw.lastIndexOf(':');
    final v4 = _ipv4(raw.substring(colon + 1));
    raw = '${raw.substring(0, colon + 1)}${(v4[0] * 256 + v4[1]).toRadixString(16)}:${(v4[2] * 256 + v4[3]).toRadixString(16)}';
  }
  final halves = raw.split('::');
  if (halves.length > 2) throw FormatException('Invalid IPv6', raw);
  final left = halves[0].isEmpty ? <String>[] : halves[0].split(':');
  final right = halves.length == 1 || halves[1].isEmpty ? <String>[] : halves[1].split(':');
  final size = left.length + right.length;
  if (halves.length == 1 ? size != 8 : size >= 8) throw FormatException('Invalid IPv6', raw);
  final bytes = List<int>.filled(16, 0);
  for (var i = 0; i < size; i++) {
    final word = i < left.length ? left[i] : right[i - left.length];
    if (!RegExp(r'^[0-9a-fA-F]{1,4}$').hasMatch(word)) throw FormatException('Invalid IPv6', raw);
    final at = i < left.length ? i : 8 - right.length + i - left.length;
    final value = int.parse(word, radix: 16);
    bytes[2 * at] = value >> 8; bytes[2 * at + 1] = value & 255;
  }
  return bytes;
}

class DraftMerge {
  const DraftMerge(this.value, this.baseline, this.conflict);
  final String value;
  final String? baseline;
  final bool conflict;
}

DraftMerge mergeDraft(String? baseline, String? draft, String saved, {bool editing = false}) {
  final dirty = editing || draft != null && draft != baseline;
  if (!dirty || !editing && saved == draft) return DraftMerge(saved, saved, false);
  return DraftMerge(draft ?? saved, baseline, saved != baseline);
}

String booleanState(Object? value, String yes, String no, String unknown) => value is bool ? (value ? yes : no) : unknown;
String textState(Object? value, String unknown) => value is String && value.isNotEmpty ? value : unknown;
bool trialActive(String state) => const ['preparing', 'running', 'rolling-back', 'rollback-failed'].contains(state);
bool validTrialState(String state) => trialActive(state) || const ['confirmed', 'rolled-back', 'superseded'].contains(state);
int trialDuration(String text) => boundedInteger(text, 30, 300, pattern: r'^[0-9]{2,3}$');
int boundedInteger(String text, int min, int max, {String pattern = r'^[0-9]+$'}) {
  final value = int.tryParse(text);
  if (!RegExp(pattern).hasMatch(text) || value == null || value < min || value > max) throw FormatException('Expected integer $min–$max', text);
  return value;
}
int trialRemaining(num seconds, int requestedAt, int now) => (seconds.floor() - ((now - requestedAt).clamp(0, 1 << 62) ~/ 1000)).clamp(0, 1 << 62).toInt();

bool validRestorePreview(Map<String, dynamic> value, String selected) {
  if (value['path'] != selected || value['sha256'] is! String || !RegExp(r'^[a-f0-9]{64}$').hasMatch(value['sha256'] as String) || value['baselineSha256'] is! String || !RegExp(r'^[a-f0-9]{64}$').hasMatch(value['baselineSha256'] as String)) return false;
  final changes = value['changes'], hooks = value['hooks'];
  if (changes is! List || hooks is! List) return false;
  for (final row in changes) {
    if (row is! Map || !['foxytail.conf', 'routes.conf', 'context.conf'].contains(row['file']) || row['key'] is! String) return false;
    for (final key in ['before', 'after']) {
      if (!row.containsKey(key) || row[key] != null && row[key] is! String) return false;
    }
  }
  return hooks.every((hook) => ['foxytail.tun.up', 'foxytail.tun.down'].contains(hook));
}
