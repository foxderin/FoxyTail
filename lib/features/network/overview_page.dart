import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'account_page.dart';
import 'network_labels.dart';
import 'network_rules.dart';
import 'network_state.dart';

class OverviewPage extends StatefulWidget {
  const OverviewPage({super.key, required this.app});
  final AppState app;
  @override
  State<OverviewPage> createState() => _OverviewPageState();
}
class _OverviewPageState extends NetworkPageState<OverviewPage> {
  @override
  AppState get app => widget.app;
  Json? compatibility;
  String? compatibilityError;
  bool loginOffered = false;
  @override
  void load() { app.refreshStatus(); _compat(); }
  Future<void> _compat() async {
    try {
      final result = await readCurrent(['compat']);
      if (result != null) setState(() { compatibility = result; compatibilityError = null; });
    } catch (error) { if (mounted) setState(() { compatibilityError = failureMessage(error); }); }
  }
  @override
  Widget build(BuildContext context) {
    final l = context.l10n, status = app.status;
    final fresh = app.statusFresh && app.statusError == null;
    final actual = fresh ? status : null, self = json(actual?['self']), peers = json(actual?['peers']);
    final route = fresh ? app.exitRouting : null, exit = json(actual?['exitNode']);
    final selected = selectedExitId(route);
    final expiry = string(actual?['keyExpiry']);
    if (fresh) loginOffered = connectionState(actual) == 'login';
    return PageBody(children: [
      if (app.statusLoading) const LinearProgressIndicator(),
      if (compatibilityError != null && compatibilityError != app.statusError) Notice(compatibilityError!, error: true),
      for (final warning in (compatibility?['warnings'] is List ? compatibility!['warnings'] as List : const <Object?>[]).whereType<String>()) Notice('${l.web_dash_compat_warning}: $warning'),
      if (string(compatibility?['alert']).isNotEmpty) Notice('${l.web_dash_compat_warning}: ${compatibility!['alert']}'),
      if (expiry.isNotEmpty && expiresSoon(expiry, DateTime.now())) Notice('${l.web_dash_key_expiring}$expiry'),
      Section(title: connectionLabel(l, actual), trailing: IconButton(tooltip: l.web_retry,
        onPressed: app.statusLoading ? null : () { app.refreshStatus(); _compat(); }, icon: const Icon(Icons.refresh)), children: [
        if (!fresh && app.statusError != string(app.bridge.control['message'])) Notice(app.statusError ?? l.web_net_unknown_hint, error: app.statusError != null),
        if (connectionState(actual) == 'stopped') Text(l.web_net_stopped_hint),
        if (connectionState(actual) == 'starting') Text(l.web_net_connecting_hint),
        Wrap(spacing: 24, runSpacing: 16, children: [
          Metric(l.web_dash_peers_online, peers['online'] is num && peers['offline'] is num ? '${peers['online']} / ${number(peers['online']) + number(peers['offline'])}' : '—', icon: Icons.groups),
          Metric(l.web_net_service_runtime, actual?['uptime'] is num ? formatUptime(number(actual?['uptime'])) : '—', icon: Icons.timer_outlined),
        ]),
      ]),
      if (loginOffered) LoginPanel(key: const ValueKey('overview-login'), app: app, compact: true),
      Section(title: l.web_dash_self, children: [
        if (self.isEmpty) Notice(l.web_net_address_pending) else ...[
          InfoRow(l.web_net_device_address, string(self['hostname'], '—')),
          for (final ip in addresses(self)) ListTile(title: SelectableText(ip), trailing: IconButton(tooltip: l.web_net_copy_address, icon: const Icon(Icons.copy), onPressed: () => copyText(context, ip))),
          InfoRow(l.web_net_relay_region, string(self['relay'], '—')),
          InfoRow(l.web_dash_magicdns, actual?['magicDns'] == true ? l.web_net_enabled : actual?['magicDns'] == false ? l.web_net_disabled : l.web_net_unknown),
        ],
      ]),
      Section(title: l.web_dash_exitnode, trailing: IconButton(tooltip: l.web_net_manage_exit, icon: const Icon(Icons.chevron_right), onPressed: () => app.navigate('peers')), children: [
        InfoRow(l.web_net_exit_selection, selected == null ? l.web_net_exit_unknown : selected.isEmpty ? l.web_net_exit_local : selected),
        Text(exitLabel(l, route)),
        if (route?['selected'] != null && actual?['mode'] == 'bridge') InfoRow(l.web_net_exit_scope, '${string(route?['scope'])} ${route?['uids'] is List ? (route!['uids'] as List).where((v) => v is String || v is num).join(', ') : ''}'),
        if (exit.isNotEmpty) ...[
          InfoRow(l.web_dash_traffic, '↓ ${exit['rx'] is num ? formatBytes(number(exit['rx'])) : '—'}  ↑ ${exit['tx'] is num ? formatBytes(number(exit['tx'])) : '—'}'),
          if (exit['online'] == false) Notice(l.web_net_exit_unavailable),
        ],
      ]),
      Section(title: l.web_net_quick_access, children: [
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final destination in [
            ('peers', l.web_peers_title, Icons.groups), ('routing', l.web_route_title, Icons.alt_route),
            ('tunnel', '${l.web_tun_title} / DNS', Icons.router), ('logs', l.web_logs_title, Icons.article_outlined),
          ]) OutlinedButton.icon(onPressed: () => app.navigate(destination.$1), icon: Icon(destination.$3), label: Text(destination.$2)),
        ]),
      ]),
    ]);
  }
}
