import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'observation_page.dart';
import 'observability_data.dart';

class DiagnosticsPage extends StatefulWidget {
  const DiagnosticsPage({super.key, required this.app});
  final AppState app;
  @override
  State<DiagnosticsPage> createState() => _DiagnosticsPageState();
}

class _DiagnosticsPageState extends ObservationPageState<DiagnosticsPage> {
  @override
  AppState get app => widget.app;
  @override
  String get destination => 'diagnostics';
  late String mode = app.drafts['diagnostics.mode'] == 'local' ? 'local' : 'share';
  final Map<String, Json?> displayed = {};
  String? submitting, failure;
  @override
  void initState() { super.initState(); app.bridge.addListener(_snapshotChanged); }
  void _snapshotChanged() { if (active) { load(); } }
  @override
  void dispose() { app.bridge.removeListener(_snapshotChanged); super.dispose(); }
  bool running(String command) => submitting == command || (boolean(app.bridge.control['busy']) && app.bridge.control['command'] == command);
  String key(String command, String value) => 'diagnostics.$command.$value';
  int resultTime(String command) => number(json(app.bridge.control['resultTimes'])[command]).toInt();
  @override
  void invalidate(bool accountChanged) {
    if (!accountChanged) return;
    displayed.clear(); failure = null; submitting = null;
    for (final command in ['diag-check', 'diag']) {
      app.drafts.remove(key(command, 'result'));
      app.drafts.remove(key(command, 'confirmed'));
      app.drafts.remove(key(command, 'task'));
      app.drafts[key(command, 'started')] = math.max(DateTime.now().millisecondsSinceEpoch, resultTime(command) + 1);
    }
  }
  @override
  void load() {
    if (!active) return;
    for (final command in ['diag-check', 'diag']) {
      var started = number(app.drafts[key(command, 'started')]).toInt();
      final isRunning = running(command);
      final nativeRunning = boolean(app.bridge.control['busy']) && app.bridge.control['command'] == command;
      final taskId = string(app.bridge.control['id']);
      if (nativeRunning && app.drafts[key(command, 'task')] != taskId) {
        app.drafts[key(command, 'task')] = taskId;
        if (submitting != command) {
          started = math.max(DateTime.now().millisecondsSinceEpoch, resultTime(command) + 1);
          app.drafts[key(command, 'started')] = started;
          app.drafts.remove(key(command, 'result'));
          app.drafts.remove(key(command, 'confirmed'));
        }
      }
      final candidate = json(app.bridge.control['results'])[command];
      final stored = app.drafts[key(command, 'result')];
      final confirmed = number(app.drafts[key(command, 'confirmed')]).toInt();
      final resolved = currentDiagnosticResult(running: isRunning, started: math.max(started, confirmed),
        resultTime: resultTime(command), latest: candidate is Map ? json(candidate) : null,
        stored: stored is Map ? json(stored) : null);
      // A method reply can precede its retained snapshot; never revive the previous task.
      displayed[command] = resolved ?? (!isRunning && confirmed >= started && confirmed > 0 && stored is Map ? json(stored) : null);
      if (resolved != null) {
        app.drafts[key(command, 'result')] = resolved;
        app.drafts[key(command, 'confirmed')] = math.max(confirmed, resultTime(command));
        app.drafts[key(command, 'started')] = math.max(started, resultTime(command));
      }
    }
    if (mounted) setState(() {});
  }
  Future<void> run(String command) async {
    if (!active || !app.canWrite || app.busy || submitting != null) return;
    final selected = mode;
    if (command == 'diag' && selected == 'local') {
      final accepted = await confirm(context, context.l10n.web_diag_local, context.l10n.web_diag_local_hint);
      if (!mounted || !accepted || !active || !app.canWrite || app.busy || submitting != null) return;
    }
    final account = app.accountRevision;
    final started = math.max(DateTime.now().millisecondsSinceEpoch, resultTime(command) + 1);
    app.drafts[key(command, 'started')] = started;
    app.drafts.remove(key(command, 'result'));
    app.drafts.remove(key(command, 'confirmed'));
    setState(() { submitting = command; failure = null; displayed[command] = null; });
    try {
      final result = await app.submit(command == 'diag' ? context.l10n.web_diag_run : context.l10n.web_diag_check,
        command == 'diag' ? ['diag', selected] : ['diag-check']);
      if (!mounted || app.accountRevision != account) return;
      app.drafts[key(command, 'result')] = result;
      app.drafts[key(command, 'confirmed')] = started;
    } catch (error) {
      if (mounted && app.accountRevision == account) setState(() => failure = failureMessage(error));
    } finally {
      if (mounted && app.accountRevision == account) {
        setState(() => submitting = null);
        load();
      }
    }
  }
  Future<void> export(Json result, bool share) async {
    if (!active || !validDiagnosticBundle(result)) return;
    final selected = string(result['mode']);
    final account = app.accountRevision;
    final id = string(result['artifactId']);
    if (share && selected == 'local') {
      if (!await confirm(context, context.l10n.web_diag_local, context.l10n.web_diag_local_hint)) return;
    }
    if (!mounted || !active || account != app.accountRevision || displayed['diag']?['artifactId'] != id || running('diag')) return;
    await perform(context, () async {
      await app.bridge.invoke<Object?>(share ? 'shareArtifact' : 'saveArtifact', {'id': id, 'name': 'foxytail-diagnostics-$selected.tar.gz'});
    });
  }
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final checks = displayed['diag-check'], bundle = displayed['diag'];
    final enabled = active && app.canWrite && !app.busy && submitting == null;
    String title(String id) => switch (id) {
      'config' => l.web_diag_item_config, 'service' => l.web_diag_item_service,
      'tunnel' => l.web_diag_item_tunnel, 'routes' => l.web_diag_item_routes,
      'dns' => l.web_dns_title, _ => l.web_diag_title,
    };
    String reason(String value) => switch (value) {
      'invalid_config' => l.web_diag_invalid_config, 'pending' => l.web_diag_pending,
      'applied' => l.web_diag_applied, 'stopped' => l.web_diag_stopped,
      'connected' => l.web_diag_connected, 'login' => l.web_diag_login,
      'unreachable' => l.web_diag_unreachable, 'needs_connection' => l.web_diag_needs_connection,
      'proxy' => l.web_diag_proxy, 'interface_ready' => l.web_diag_interface_ready,
      'interface_missing' => l.web_diag_interface_missing, 'managed_routes' => l.web_diag_managed_routes,
      'routes_ready' => l.web_diag_routes_ready, 'routes_incomplete' => l.web_diag_routes_incomplete,
      'dns_disabled' => l.web_diag_dns_disabled, 'dns_conflict' => l.web_diag_dns_conflict,
      'dns_limited' => l.web_diag_dns_limited, 'dns_ready' => l.web_diag_dns_ready,
      'dns_unavailable' => l.web_diag_dns_unavailable, _ => l.web_diag_unknown,
    };
    return PageBody(children: [
      if (failure != null) Notice(failure!, error: true),
      Section(title: l.web_diag_check, children: [
        Align(alignment: AlignmentDirectional.centerStart, child: FilledButton.icon(onPressed: enabled ? () => run('diag-check') : null, icon: const Icon(Icons.fact_check_outlined), label: Text(l.web_diag_check))),
        if (running('diag-check')) const LinearProgressIndicator(),
        Semantics(liveRegion: true, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (checks == null && (running('diag-check') || app.drafts[key('diag-check', 'started')] != null)) Notice(l.repair_tools_diag_unconfirmed),
          if (checks != null && !validDiagnosticChecks(checks)) Notice(string(checks['error'], l.web_diag_unknown), error: true),
          if (checks != null && validDiagnosticChecks(checks)) ...objects(checks['checks']).map((row) {
            final level = string(row['level']);
            final state = switch (level) { 'pass' => l.web_diag_level_pass, 'warn' => l.web_diag_level_warn, 'fail' => l.web_diag_level_fail, _ => l.web_diag_level_skip };
            final icon = switch (level) { 'pass' => Icons.check_circle_outline, 'warn' => Icons.warning_amber, 'fail' => Icons.error_outline, _ => Icons.remove_circle_outline };
            return ListTile(contentPadding: EdgeInsets.zero, leading: Icon(icon, color: level == 'fail' ? Theme.of(context).colorScheme.error : null),
              title: Text('${title(string(row['id']))} · $state'), subtitle: Text(reason(string(row['reason']))),
              trailing: level == 'warn' || level == 'fail' ? IconButton(tooltip: l.web_diag_view_details,
                onPressed: () => app.navigate(row['page'] == 'dashboard' ? 'overview' : string(row['page'])), icon: const Icon(Icons.chevron_right)) : null);
          }),
        ])),
      ]),
      Section(title: l.web_tools_diag_collect, children: [
        DropdownButtonFormField<String>(initialValue: mode, isExpanded: true,
          decoration: InputDecoration(labelText: l.web_diag_bundle_mode),
          items: [DropdownMenuItem(value: 'share', child: Text(l.web_diag_share)), DropdownMenuItem(value: 'local', child: Text(l.web_diag_local))],
          onChanged: running('diag') ? null : (value) { if (value != null) setState(() { mode = value; app.drafts['diagnostics.mode'] = value; }); }),
        Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Text(mode == 'local' ? l.web_diag_local_hint : l.web_diag_share_hint)),
        Align(alignment: AlignmentDirectional.centerStart, child: FilledButton.icon(onPressed: enabled ? () => run('diag') : null, icon: const Icon(Icons.bug_report_outlined), label: Text(l.web_diag_run))),
        if (running('diag')) ...[const LinearProgressIndicator(), Semantics(liveRegion: true, child: Text(l.web_diag_running))],
        if (bundle == null && !running('diag') && app.drafts[key('diag', 'started')] != null) Notice(l.repair_tools_diag_unconfirmed),
      ]),
      Section(title: l.web_tools_diag_ready, children: [
        if (bundle == null) Notice(l.web_tools_diag_waiting)
        else if (!validDiagnosticBundle(bundle)) Notice(string(bundle['error'], l.web_diag_unknown), error: true)
        else ...[
          Semantics(liveRegion: true, child: Text(l.web_diag_done)),
          Text(bundle['mode'] == 'local' ? l.web_diag_local : l.web_diag_share),
          SelectableText(string(bundle['path']), style: const TextStyle(fontFamily: 'monospace')),
          Wrap(spacing: 8, children: [
            IconButton(tooltip: l.web_tools_copy_path, onPressed: () => copyText(context, string(bundle['path'])), icon: const Icon(Icons.content_copy)),
            IconButton(tooltip: l.tools_save, onPressed: () => export(bundle, false), icon: const Icon(Icons.save_alt)),
            IconButton(tooltip: l.tools_share, onPressed: () => export(bundle, true), icon: const Icon(Icons.share_outlined)),
          ]),
        ],
      ]),
    ]);
  }
}
