import 'dart:async';

import 'package:flutter/material.dart';

import '../features/files/files_page.dart';
import '../features/network/account_page.dart';
import '../features/network/coexist_page.dart';
import '../features/network/overview_page.dart';
import '../features/network/peers_page.dart';
import '../features/network/serve_page.dart';
import '../features/network/tunnel_page.dart';
import '../features/observability/diagnostics_page.dart';
import '../features/observability/logs_page.dart';
import '../features/observability/traffic_page.dart';
import '../features/settings/backup_page.dart';
import '../features/settings/context_page.dart';
import '../features/settings/routing_page.dart';
import '../features/settings/settings_page.dart';
import '../features/settings/trial_page.dart';
import '../widgets/export_notice.dart';
import '../widgets/common.dart';
import 'app_state.dart';
import 'platform_bridge.dart';

class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.app});
  final AppState app;
  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> with RestorationMixin {
  final _saved = RestorableStringN(null);
  Widget? _files;
  AppState get app => widget.app;
  @override
  String get restorationId => 'shell';
  @override
  void restoreState(RestorationBucket? oldBucket, bool initialRestore) {
    registerForRestoration(_saved, 'state');
    app.restoreState(_saved.value);
  }
  @override
  void initState() {
    super.initState();
    app.restoration.addListener(_save);
    app.notices.addListener(_notice);
    app.entries.addListener(_entry);
  }
  void _save() {
    if (mounted) _saved.value = app.saveState();
  }
  void _entry() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) Navigator.of(context).popUntil((route) => route.isFirst);
    });
  }
  void _notice() {
    final message = app.notices.value;
    if (message == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
    });
  }
  @override
  void dispose() {
    app.restoration.removeListener(_save);
    app.notices.removeListener(_notice);
    app.entries.removeListener(_entry);
    _saved.dispose();
    super.dispose();
  }

  Widget _page(String name) => switch (name) {
    'peers' => PeersPage(app: app),
    'account' => AccountPage(app: app),
    'tunnel' => TunnelPage(app: app),
    'routing' => RoutingPage(app: app),
    'settings' => SettingsPage(app: app),
    'context' => ContextPage(app: app),
    'trial' => TrialPage(app: app),
    'serve' => ServePage(app: app),
    'coexist' => CoexistPage(app: app),
    'traffic' => TrafficPage(app: app),
    'logs' => LogsPage(app: app),
    'diagnostics' => DiagnosticsPage(app: app),
    'backup' => BackupPage(app: app),
    'more' => _MorePage(app: app),
    'files' => const SizedBox.expand(),
    _ => OverviewPage(app: app),
  };

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<String>(
    valueListenable: app.navigation,
    builder: (context, destination, _) {
      final l = context.l10n;
      final navigation = <(String, IconData, String)>[
        ('overview', Icons.dashboard_outlined, l.web_nav_dashboard),
        ('peers', Icons.devices_outlined, l.web_nav_peers),
        ('files', Icons.folder_outlined, l.web_files_title),
        ('traffic', Icons.show_chart, l.web_nav_traffic),
        ('more', Icons.more_horiz, l.web_nav_more),
      ];
      final index = navigation.indexWhere((item) => item.$1 == destination);
      final selected = index < 0 ? 4 : index;
      if (destination == 'files') _files ??= FilesPage(app: app);
      final wide = MediaQuery.sizeOf(context).width >= 720 &&
          MediaQuery.textScalerOf(context).scale(14) < 28;
      return PopScope(
        canPop: !app.canGoBack,
        onPopInvokedWithResult: (didPop, result) { if (!didPop) app.goBack(); },
        child: Scaffold(
          appBar: AppBar(
            leading: index < 0 ? BackButton(onPressed: app.goBack) : null,
            title: Text(_title(context, destination)),
            actions: [
              AnimatedBuilder(animation: app, builder: (context, _) {
                final count = objects(app.bridge.control['tasks'])
                    .where((task) => task['state'] == 'running').length;
                return IconButton(
                  tooltip: l.web_shell_tasks,
                  icon: Badge(isLabelVisible: count > 0, label: Text('$count'),
                    child: const Icon(Icons.task_alt)),
                  onPressed: () => _showTasks(context, app),
                );
              }),
            ],
          ),
          body: SafeArea(
            top: false,
            child: Row(children: [
              if (wide) ...[
                NavigationRail(
                  selectedIndex: selected,
                  labelType: NavigationRailLabelType.all,
                  onDestinationSelected: (index) => app.navigate(navigation[index].$1),
                  destinations: [for (final item in navigation)
                    NavigationRailDestination(icon: Icon(item.$2), label: Text(item.$3)),
                  ],
                ),
                const VerticalDivider(width: 1),
              ],
              Expanded(child: Column(children: [
                _ServiceBar(app: app),
                ExportNotice(app: app),
                Expanded(child: Stack(fit: StackFit.expand, children: [
                  if (_files != null) Offstage(
                    offstage: destination != 'files',
                    child: TickerMode(enabled: destination == 'files', child: _files!),
                  ),
                  if (destination != 'files') Positioned.fill(
                    child: KeyedSubtree(key: ValueKey(destination), child: _page(destination)),
                  ),
                ])),
              ])),
            ]),
          ),
          bottomNavigationBar: wide ? null : NavigationBar(
            labelBehavior: MediaQuery.sizeOf(context).width < 500 &&
                MediaQuery.textScalerOf(context).scale(14) > 18
              ? NavigationDestinationLabelBehavior.alwaysHide
              : NavigationDestinationLabelBehavior.alwaysShow,
            selectedIndex: selected,
            onDestinationSelected: (index) => app.navigate(navigation[index].$1),
            destinations: [for (final item in navigation)
              NavigationDestination(icon: Icon(item.$2), label: item.$3),
            ],
          ),
        ),
      );
    },
  );
}

String _title(BuildContext context, String name) {
  final l = context.l10n;
  return switch (name) {
    'overview' => l.web_nav_dashboard, 'peers' => l.web_nav_peers,
    'files' => l.web_files_title, 'traffic' => l.web_nav_traffic,
    'more' => l.web_nav_more, 'account' => l.web_acc_title,
    'tunnel' => l.web_tun_title, 'routing' => l.web_route_title,
    'settings' => l.web_set_title, 'context' => l.web_set_context,
    'trial' => l.web_trial_title, 'serve' => l.web_serve_title,
    'coexist' => l.web_coexist_title, 'logs' => l.web_logs_title,
    'diagnostics' => l.web_diag_title, 'backup' => l.web_set_backup,
    _ => 'FoxyTail',
  };
}

class _MorePage extends StatelessWidget {
  const _MorePage({required this.app});
  final AppState app;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final groups = <(String, List<(String, IconData)>)>[
      (l.web_tools_network, [('tunnel', Icons.router_outlined), ('routing', Icons.alt_route),
        ('coexist', Icons.hub_outlined), ('serve', Icons.dns_outlined)]),
      (l.web_tools_device, [('account', Icons.person_outline)]),
      (l.web_tools_maintenance, [('logs', Icons.article_outlined), ('diagnostics', Icons.bug_report_outlined),
        ('settings', Icons.settings_outlined), ('context', Icons.rule),
        ('trial', Icons.timer_outlined), ('backup', Icons.backup_outlined)]),
    ];
    return PageBody(children: [
      for (final group in groups) Section(title: group.$1, children: [
        for (final item in group.$2) ListTile(
          leading: Icon(item.$2), title: Text(_title(context, item.$1)),
          trailing: const Icon(Icons.chevron_right), onTap: () => app.navigate(item.$1),
        ),
      ]),
      ListTile(
        leading: const Icon(Icons.description_outlined),
        title: Text(MaterialLocalizations.of(context).licensesPageTitle),
        onTap: () => showLicensePage(context: context, applicationName: 'FoxyTail'),
      ),
    ]);
  }
}

class _ServiceBar extends StatelessWidget {
  const _ServiceBar({required this.app});
  final AppState app;

  bool get known => app.statusFresh && serviceKnown(app.status);
  static bool serviceKnown(Json? value) => value?['ok'] == true && value?['backend'] != 'unreachable' &&
    const ['running', 'stopped'].contains(value?['daemon']) &&
    const ['tun', 'bridge', 'proxy'].contains(value?['mode']);

  Future<void> _control(BuildContext context, String action, [String? mode]) async {
    final value = app.status;
    final allowed = !app.busy && (action == 'stop'
      ? app.canStop && (!app.statusFresh || value?['ok'] != true || value?['daemon'] != 'stopped')
      : known && app.canWrite && (action != 'restart' || value?['daemon'] == 'running'));
    if (!allowed) return;
    final l = context.l10n;
    if (action != 'start' && !await confirm(context, l.network_service, l.network_interrupt)) return;
    if (!context.mounted) return;
    await perform(context, () async {
      final result = await app.submit(l.network_service, action == 'mode'
        ? ['mode-set', mode!] : ['control', action]);
      if (result['ok'] != true) app.message(string(result['error'], l.backend_failed));
      await app.refreshStatus();
    });
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(animation: app, builder: (context, _) {
    final l = context.l10n;
    final value = app.status;
    final running = value?['daemon'] == 'running';
    final control = app.bridge.control;
    final state = !app.statusEverLoaded ? l.web_shell_starting : !app.statusFresh ? app.status == null ? l.web_shell_unknown : l.web_dash_status_stale
      : value?['ok'] != true || value?['backend'] == 'unreachable' ? l.web_shell_unknown
      : value?['daemon'] == 'stopped' ? l.web_shell_stopped
      : value?['daemon'] != 'running' ? l.web_shell_unknown
      : switch (value?['backend']) {
        'Running' => l.web_shell_connected, 'NeedsLogin' => l.web_shell_login,
        'NeedsMachineAuth' => l.network_machine_auth,
        'Starting' || 'NoState' => l.web_shell_starting, _ => l.web_shell_unknown,
      };
    final canRescue = app.canStop && !known && (!app.statusFresh || value?['ok'] != true || value?['daemon'] != 'stopped');
    return Material(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      child: Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8), child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(spacing: 12, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
            Semantics(liveRegion: true, child: Text(state, style: Theme.of(context).textTheme.labelLarge)),
            if (known) Tooltip(message: l.web_net_controls_service, child: Switch(
              value: running, onChanged: app.busy || !(running ? app.canStop : app.canWrite)
                ? null : (enabled) => _control(context, enabled ? 'start' : 'stop'),
            )),
            if (known) DropdownButton<String>(
              value: string(value?['mode']),
              underline: const SizedBox.shrink(),
              items: [
                DropdownMenuItem(value: 'tun', child: Text(l.web_net_mode_tun)),
                DropdownMenuItem(value: 'bridge', child: Text(l.web_net_mode_bridge)),
                DropdownMenuItem(value: 'proxy', child: Text(l.web_net_mode_proxy)),
              ],
              onChanged: app.busy || !app.canWrite ? null : (mode) {
                if (mode != null && mode != value?['mode']) unawaited(_control(context, 'mode', mode));
              },
            ),
            if (known && running) IconButton(
              tooltip: l.web_dash_restart, icon: const Icon(Icons.restart_alt),
              onPressed: app.busy || !app.canWrite ? null : () => _control(context, 'restart'),
            ),
            if (canRescue) IconButton(
              tooltip: l.repair_shell_stop, icon: const Icon(Icons.stop_circle_outlined),
              onPressed: app.busy ? null : () => _control(context, 'stop'),
            ),
            if (!known) IconButton(
              tooltip: l.web_tools_refresh, icon: const Icon(Icons.refresh),
              onPressed: app.statusLoading ? null : () async {
                await app.refreshAvailability(); await app.refreshStatus();
              },
            ),
            if (boolean(control['canCancel'])) IconButton(
              tooltip: l.cancel, icon: const Icon(Icons.close),
              onPressed: () => perform(context, () async { await app.bridge.invoke<void>('cancel'); }),
            ),
            if (app.busy) IconButton(
              tooltip: l.control_reconnect, icon: const Icon(Icons.sync),
              onPressed: () => perform(context, () async { await app.bridge.invoke<void>('reconnect'); }),
            ),
            if (app.unknown) IconButton(
              tooltip: l.control_acknowledge, icon: const Icon(Icons.fact_check_outlined),
              onPressed: () async {
                if (!await confirm(context, l.control_unknown_title, l.control_unknown_warning) || !context.mounted) return;
                await perform(context, () async { await app.bridge.invoke<void>('acknowledgeUnknown'); });
              },
            ),
          ]),
          if (boolean(control['hasNotice']) && string(control['message']).isNotEmpty)
            Padding(padding: const EdgeInsets.only(top: 4), child: Semantics(
              liveRegion: true, child: Text(string(control['message']), style: Theme.of(context).textTheme.bodySmall),
            )),
          if (app.bridge.connectionError != null) Notice(app.bridge.connectionError!, error: true),
        ],
      )),
    );
  });
}

String _taskDestination(String command) => switch (command) {
  'control' || 'mode-set' => 'overview',
  'speedtest-exitnodes' || 'exitnode-set' || 'exitnode-clear' || 'peer-ping' => 'peers',
  'derp-speedtest' || 'socks-check' || 'dns-probe' => 'tunnel',
  'coexist-info' || 'coexist-check' => 'coexist',
  'diag' || 'diag-check' => 'diagnostics',
  'file-receive' || 'file-delete' || 'file-delete-many' || 'file-clear' || 'file-export' || 'file-export-many' || 'file-send-delete' || 'file-send-clear' => 'files',
  'backup' || 'restore' => 'backup',
  'settings-set' => 'settings',
  'context-set' => 'context',
  'trial-start' || 'trial-confirm' || 'trial-revert' => 'trial',
  'subnet-routes-set' || 'routes-set' => 'routing',
  'login-authkey' || 'login' || 'logout' || 'switch' => 'account',
  'serve-set' || 'serve-del' || 'funnel-set' || 'funnel-del' => 'serve',
  _ => 'more',
};

void _showTasks(BuildContext context, AppState app) {
  unawaited(showModalBottomSheet<void>(
    context: context, showDragHandle: true, isScrollControlled: true,
    builder: (context) => SafeArea(child: SizedBox(
      height: MediaQuery.sizeOf(context).height * .65,
      child: AnimatedBuilder(animation: app.bridge, builder: (context, _) {
        final l = context.l10n;
        final tasks = objects(app.bridge.control['tasks']);
        return ListView(children: [
          Padding(padding: const EdgeInsets.all(16), child: Text(l.web_shell_tasks,
            style: Theme.of(context).textTheme.titleLarge)),
          if (tasks.isEmpty && !boolean(app.bridge.transfer['busy']))
            ListTile(title: Text(l.web_shell_no_tasks)),
          for (final task in tasks.reversed) ListTile(
            leading: Icon(task['state'] == 'done' ? Icons.check_circle_outline
              : task['state'] == 'running' ? Icons.pending_outlined : Icons.info_outline),
            title: Text(string(task['label'])),
            subtitle: Text([
              switch (task['state']) {
                'running' => task['cancellation'] == 'requested' ? l.web_task_cancel_pending
                  : task['cancellation'] == 'failed' ? l.web_task_cancel_failed : l.web_shell_task_running,
                'done' => l.web_shell_task_done, 'cancelled' => l.web_shell_task_cancelled,
                'unknown' => l.web_shell_unknown, _ => l.web_shell_task_error,
              },
              if (const ['error', 'unknown'].contains(task['state'])) string(task['detail']),
            ].where((part) => part.isNotEmpty).join('\n')),
            onTap: () { Navigator.pop(context); app.navigate(_taskDestination(string(task['command']))); },
          ),
          if (boolean(app.bridge.transfer['busy'])) ListTile(
            leading: const Icon(Icons.file_upload_outlined), title: Text(l.web_files_title),
            subtitle: Text(string(app.bridge.transfer['message'])),
            onTap: () { Navigator.pop(context); app.drafts['files.section'] = 'history'; app.navigate('files'); },
          ),
        ]);
      }),
    )),
  ));
}
