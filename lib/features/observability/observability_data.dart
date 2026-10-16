import 'package:foxytail/app/platform_bridge.dart';

class TrafficSample {
  const TrafficSample(this.label, this.rx, this.tx);
  final String label;
  final double? rx, tx;
}

double trafficBytes(Object? value) {
  final parsed = value is num ? value.toDouble() : double.tryParse('$value');
  return parsed != null && parsed.isFinite && parsed >= 0 ? parsed : 0;
}

List<TrafficSample> trafficSamples(Json summary, bool daily) {
  final rows = summary[daily ? 'days' : 'hours'];
  if (rows is! List) throw const FormatException('Invalid traffic samples');
  return rows.map((value) {
    if (value is! Map) throw const FormatException('Invalid traffic sample');
    final row = json(value);
    final counters = daily ? row : row['iface'] is Map ? json(row['iface']) : null;
    final recorded = row.containsKey('samples')
        ? number(row['samples']) > 0
        : counters != null && trafficBytes(counters['rx']) + trafficBytes(counters['tx']) > 0;
    final String label;
    if (daily) {
      if (row['date'] is! String) throw const FormatException('Invalid traffic date');
      label = row['date'] as String;
    } else {
      if (row['hour'] is! num) throw const FormatException('Invalid traffic hour');
      label = '${(row['hour'] as num).toInt().toString().padLeft(2, '0')}:00';
    }
    return TrafficSample(label, recorded && counters != null ? trafficBytes(counters['rx']) : null,
        recorded && counters != null ? trafficBytes(counters['tx']) : null);
  }).toList(growable: false);
}

int selectedTrafficIndex(List<TrafficSample> samples, String? label) {
  final retained = samples.indexWhere((sample) => sample.label == label);
  if (retained >= 0) return retained;
  for (var i = samples.length - 1; i >= 0; i--) {
    if (samples[i].rx != null || samples[i].tx != null) return i;
  }
  return samples.length - 1;
}

String visibleLog(String value) {
  if (value.isEmpty) return ' ';
  final out = StringBuffer();
  for (final rune in value.runes) {
    if ((rune < 32 || (rune >= 127 && rune <= 159)) && rune != 9 && rune != 10 && rune != 13) {
      out.write('\\u${rune.toRadixString(16).padLeft(4, '0')}');
    } else {
      out.writeCharCode(rune);
    }
  }
  return out.toString();
}

class LogRecord {
  LogRecord(this.number, this.raw) : display = visibleLog(raw), folded = raw.toLowerCase();
  final int number;
  final String raw, display, folded;
}

class LogSnapshot {
  LogSnapshot(List<String> lines)
      : records = List.generate(lines.length, (index) => LogRecord(index + 1, lines[index]), growable: false);
  final List<LogRecord> records;
  bool same(List<String> lines) {
    if (records.length != lines.length) return false;
    for (var i = 0; i < lines.length; i++) {
      if (records[i].raw != lines[i]) return false;
    }
    return true;
  }
  List<LogRecord> filter(String query, bool matchCase) {
    final needle = matchCase ? query : query.toLowerCase();
    return records.where((row) => (matchCase ? row.raw : row.folded).contains(needle)).toList(growable: false);
  }
  static String copy(List<LogRecord> records) => records.map((row) => row.raw).join('\n');
}

Json? currentDiagnosticResult({required bool running, required int started,
    required int resultTime, Json? latest, Json? stored}) {
  if (running) return null;
  if (latest != null && (started == 0 || resultTime >= started)) return latest;
  return started == 0 ? stored : null;
}

bool validDiagnosticBundle(Json result) {
  final path = string(result['path']);
  return boolean(result['ok']) && RegExp(r'^art-[a-f0-9]{32}$').hasMatch(string(result['artifactId'])) &&
      const ['share', 'local'].contains(result['mode']) && path.startsWith('/') && path.endsWith('.tar.gz') &&
      !RegExp(r'[\x00-\x1f\x7f]').hasMatch(path);
}

bool validDiagnosticChecks(Json result) {
  final checks = result['checks'];
  return boolean(result['ok']) && checks is List && checks.isNotEmpty && checks.every((value) {
    if (value is! Map) return false;
    return value['id'] is String && value['reason'] is String &&
        const ['pass', 'warn', 'fail', 'skip'].contains(value['level']) &&
        const ['settings', 'dashboard', 'account', 'logs', 'tunnel', 'routing'].contains(value['page']);
  });
}
