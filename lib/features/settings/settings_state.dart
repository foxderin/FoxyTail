import 'package:intl/intl.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/l10n/generated/app_localizations.dart';
import 'settings_rules.dart';

class SettingsDraft {
  SettingsDraft(this.storage, this.key);
  final Map<String, dynamic> storage;
  final String key;
  String? saved;
  String? get baseline => storage['$key.baseline'] as String?;
  String get value => storage[key] as String? ?? '';
  set value(String value) => storage[key] = value;
  bool get dirty => saved != null && saved != value;
  bool conflict({bool editing = false}) => saved != null && mergeDraft(baseline, storage[key] as String?, saved!, editing: editing).conflict;
  void receive(String incoming, {bool editing = false, bool discard = false}) {
    saved = incoming;
    final merged = discard ? DraftMerge(incoming, incoming, false) : mergeDraft(baseline, storage[key] as String?, incoming, editing: editing);
    storage['$key.baseline'] = merged.baseline;
    value = merged.value;
  }
  void submitted(String original, String normalized) {
    saved = normalized;
    storage['$key.baseline'] = normalized;
    if (value == original) value = normalized;
  }
}

class TrialObservation {
  Json? trial;
  bool known = false, observed = false, changing = false;
  int requestedAt = 0;
  bool get active => trialActive(string(trial?['status']));
  bool get restartAllowed => known && !changing && !active;
  int remaining(int now) => trialRemaining(number(trial?['remaining']), requestedAt, now);
  bool canConfirm(int now) => known && !changing && trial?['status'] == 'running' && remaining(now) > 0;
  bool receive(Json result, int requestTime) {
    final incoming = result['trial'];
    if (!result.containsKey('trial') || incoming != null && !_valid(json(incoming))) {
      known = false;
      throw const FormatException('Invalid trial response');
    }
    final value = incoming == null ? null : json(incoming);
    final changed = observed && (trial?['id'] != value?['id'] || trial?['status'] != value?['status']);
    trial = value; known = true; observed = true; requestedAt = requestTime;
    return changed;
  }
  static bool _valid(Json value) {
    if (!RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(string(value['id'])) || !validTrialState(string(value['status'])) || value['remaining'] is! num || !(value['remaining'] as num).isFinite || (value['remaining'] as num) < 0 || value['reason'] is! String) return false;
    for (final key in ['candidate', 'previous']) {
      final summary = json(value[key]);
      if (['mode', 'dnsMode', 'routeScope'].any((name) => summary[name] is! String)) return false;
    }
    return true;
  }
}

class RouteAcceptance {
  int revision = 0;
  bool known = false, busy = false, reading = false;
  Json value = {};
  bool? expected;
  bool get on => value['acceptRoutes'] == true;
  bool get enabled => known && !busy;
  int beginRead([bool? expected]) { this.expected = expected; reading = true; return ++revision; }
  void beginWrite() { revision++; busy = true; }
  bool receive(int ticket, Json incoming) {
    if (ticket != revision) return false;
    if (incoming['acceptRoutes'] is! bool || incoming['ipv6Enabled'] is! bool || incoming['mode'] is! String || incoming['peers'] is! List) {
      fail(ticket);
      throw const FormatException('Invalid subnet response');
    }
    value = incoming; known = true; busy = false; reading = false;
    return true;
  }
  void fail(int ticket) { if (ticket == revision) { known = false; busy = false; reading = false; } }
}

String settingsValue(AppLocalizations l, Object? value) {
  final text = textState(value, l.cs_value_unknown);
  return switch (text) {
    'running' || 'Running' => l.cs_running,
    'stopped' || 'Stopped' => l.cs_stopped,
    'disabled' => l.cs_disabled,
    'degraded' => l.cs_degraded,
    'conflict' => l.cs_conflict,
    'owned' => l.cs_owned,
    'restore-pending' => l.cs_restore_pending,
    'apply-pending' => l.cs_apply_pending,
    'disable-pending' => l.cs_disable_pending,
    'preparing' => l.cs_preparing,
    'rolling-back' => l.cs_rolling_back,
    'confirmed' => l.cs_confirmed,
    'rolled-back' => l.cs_rolled_back,
    'rollback-failed' => l.cs_rollback_failed,
    'superseded' => l.cs_superseded,
    'all' => l.cs_scope_all,
    'selected' => l.cs_scope_selected,
    'bypass' => l.cs_scope_bypass,
    _ => text,
  };
}

Map<String, String> dnsFacts(AppLocalizations l, Json value) {
  String flag(String key) => booleanState(value[key], l.cs_yes, l.cs_no, l.cs_value_unknown);
  String fact(String key) => settingsValue(l, value[key]);
  final port = value['port'];
  return {
    l.cs_actual_mode: fact('mode'), l.cs_configured_mode: fact('configuredMode'), l.cs_pending_mode: flag('pendingMode'),
    l.cs_dns_enabled: flag('enabled'), l.cs_state: fact('state'), l.cs_reason: fact('reason'),
    l.cs_listener_ready: flag('listenerReady'), l.cs_dns_port: port is num && port > 0 && port <= 65535 ? '$port' : l.cs_value_unknown,
    l.cs_dns_suffix: fact('suffix'), l.cs_interception4: flag('interception4'), l.cs_interception6: flag('interception6'),
    l.cs_repair_needed: flag('repairNeeded'), l.cs_policy_state: fact('policyState'), l.cs_capability_error: fact('capabilityError'),
    l.cs_transparent_available: flag('transparentAvailable'), l.cs_unavailable_reason: fact('transparentUnavailableReason'),
    l.cs_upstream_native: flag('upstreamNative'), l.cs_ipv6_path: fact('ipv6DnsInterception'), l.cs_ipv6_module: fact('ipv6ModuleStatus'),
  };
}

Map<String, String> runtimeFacts(AppLocalizations l, Json value) => {
  l.cs_daemon_state: settingsValue(l, value['daemon']), l.cs_backend_state: settingsValue(l, value['backend']),
  l.cs_actual_mode: settingsValue(l, value['mode']),
  l.cs_power_save: booleanState(value['powerSave'], l.cs_yes, l.cs_no, l.cs_value_unknown),
  l.cs_magic_dns: booleanState(value['magicDns'], l.cs_yes, l.cs_no, l.cs_value_unknown),
  l.cs_host_name: textState(json(value['self'])['hostname'], l.cs_value_unknown),
};

Map<String, String> scenarioFacts(AppLocalizations l, Json value) {
  final last = json(value['lastResult']);
  final at = last['at'];
  return {
    l.cs_watcher_running: booleanState(value['running'], l.cs_yes, l.cs_no, l.cs_value_unknown),
    l.cs_current_context: settingsValue(l, value['context']),
    l.cs_last_context: settingsValue(l, last['context']),
    l.cs_last_ok: booleanState(last['ok'], l.cs_yes, l.cs_no, l.cs_value_unknown),
    l.cs_last_time: at is num && at.isFinite && at > 0 && at <= 8640000000000 ? DateFormat('yyyy-MM-dd HH:mm').format(DateTime.fromMillisecondsSinceEpoch((at * 1000).toInt())) : l.cs_value_unknown,
    l.cs_last_error: settingsValue(l, last['error']),
  };
}

List<Json> matchingApps(List<Json> apps, Set<String> selected, String query, bool selectedOnly) {
  final needle = query.toLowerCase();
  return apps.where((app) => (!selectedOnly || selected.contains(string(app['uid']))) && '${string(app['label'])} ${string(app['package'])} ${string(app['uid'])}'.toLowerCase().contains(needle)).toList();
}
