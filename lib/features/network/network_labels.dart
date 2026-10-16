import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/l10n/generated/app_localizations.dart';
import 'network_rules.dart';

String connectionLabel(AppLocalizations l, Json? status) => switch (connectionState(status)) {
  'connected' => l.network_connected, 'stopped' => l.network_stopped,
  'login' => l.network_login_needed, 'machine-auth' => l.network_machine_auth,
  'starting' => l.network_starting, _ => l.network_unknown,
};
String boolLabel(AppLocalizations l, Object? value) => value == true ? l.network_yes : value == false ? l.network_no : l.network_unknown;
String exitLabel(AppLocalizations l, Json? route) {
  if (route?['known'] != true || !route!.containsKey('selected')) return l.web_net_exit_unknown_hint;
  if (route['effective'] == 'not-effective') return l.web_net_exit_failed;
  if (route['selected'] == null) return l.web_net_no_exit_hint;
  return switch (route['effective']) {
    'explicit-proxy' => l.web_net_exit_proxy, 'daemon-owned' => l.web_net_exit_daemon,
    'bridge-policy' => route['ipv6'] == true ? l.web_net_exit_bridge_dual : l.web_net_exit_bridge_v4,
    _ => l.web_net_exit_failed,
  };
}
String dnsLabel(AppLocalizations l, Json data) {
  var reason = string(data['reason']);
  if (modernDns(data)) {
    if (reason == 'missing-binary') return l.web_tools_dns_helper_missing;
    if (reason.isNotEmpty && !const ['running', 'local', 'transparent-unavailable', 'ipv6-unavailable'].contains(reason)) return dnsReason(l, reason, l.web_dns_degraded);
    if (data['listenerReady'] != true) return l.web_tools_dns_listener_unready;
    if (data['mode'] == 'local') return dnsReady(data) ? l.web_tools_dns_local_ready : l.web_dns_degraded;
    if (dnsReady(data) && data['interception4'] == true) return data['interception6'] == true ? l.web_tools_dns_transparent_ready : l.web_tools_dns_transparent_ipv4;
    return reason == 'transparent-unavailable' ? l.web_tools_dns_local_only : l.web_tools_dns_transparent_inactive;
  }
  if (reason.isEmpty || data['ipv6DnsInterception'] == 'fallback' && reason == 'ipv6-unavailable') reason = string(data['state']);
  return dnsReason(l, reason, l.web_net_unknown);
}
String dnsReason(AppLocalizations l, String reason, String fallback) => switch (reason) {
  'running' => l.web_dns_running, 'disabled' => l.web_dns_disabled,
  'apply-pending' => l.web_dns_apply_pending, 'disable-pending' => l.web_dns_disable_pending,
  'tailnet-unavailable' => l.web_dns_tailnet_unavailable, 'missing-binary' => l.web_dns_missing_binary,
  'conflict' => l.web_dns_conflict, 'redirect-failed' => l.web_dns_redirect_failed,
  'cleanup-failed' => l.web_dns_cleanup_failed, 'process-failed' => l.web_dns_process_failed,
  'reconcile-needed' => l.web_dns_reconcile_needed, 'private-dns' => l.web_dns_private_dns,
  'ipv6-unavailable' => l.web_tools_dns_ipv6_unavailable, 'local' => l.web_tools_dns_local_ready,
  'transparent-unavailable' => l.web_tools_dns_local_only,
  'native-policy-unavailable' => l.web_tools_dns_native_policy_unavailable,
  'native-policy-changed' => l.web_tools_dns_native_policy_changed,
  'restore-pending' => l.web_tools_dns_restore_pending, 'invalid-config' => l.web_tools_dns_invalid_config,
  'listener-failed' => l.web_tools_dns_listener_failed, 'interception-failed' => l.web_tools_dns_interception_failed,
  'context-changed' => l.web_tools_dns_context_changed,
  'interception-lost' || 'queue-failed' => l.web_tools_dns_interception_lost,
  'guard-failed' => l.web_tools_dns_guard_failed, 'capture-mark-conflict' => l.web_tools_dns_mark_conflict,
  'packet-policy-conflict' => l.web_tools_dns_packet_policy_conflict,
  'dns-interception-conflict' => l.web_tools_dns_interception_conflict,
  'stopped' => l.web_dns_stopped, 'degraded' => l.web_dns_degraded, _ => fallback,
};
String ipv6DnsLabel(AppLocalizations l, Json data) {
  final path = switch (data['ipv6DnsInterception']) {
    'available' => l.web_tools_dns_ipv6_native, 'module-loaded' => l.web_tools_dns_ipv6_module,
    'fallback' => l.web_tools_dns_ipv6_fallback, 'disabled' => l.web_tools_dns_ipv6_disabled,
    _ => l.network_unknown,
  };
  final detail = data['ipv6DnsInterception'] != 'fallback' ? '' : switch (data['ipv6ModuleStatus']) {
    'missing' => l.web_tools_dns_ipv6_module_missing, 'load-failed' => l.web_tools_dns_ipv6_module_failed,
    'loader-unavailable' => l.web_tools_dns_ipv6_loader_missing, 'not-checked' => l.web_tools_dns_ipv6_module_unchecked,
    _ => '',
  };
  return detail.isEmpty ? path : '$path ($detail)';
}
