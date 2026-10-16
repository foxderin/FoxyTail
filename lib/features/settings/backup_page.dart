import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'config_scope.dart';
import 'settings_rules.dart';

class BackupPage extends StatefulWidget {
  const BackupPage({super.key, required this.app, this.embedded = false, this.active = true});
  final AppState app;
  final bool embedded, active;
  @override State<BackupPage> createState() => _BackupPageState();
}

class _BackupPageState extends ConfigState<BackupPage> {
  @override AppState get app => widget.app;
  @override bool get active => widget.active;
  List<Json> archives = [];
  Json? preview;
  bool reading = false, inspecting = false, consuming = false;
  String? error;
  int previewRevision = 0;
  late String settingsFingerprint;
  String get selected => app.drafts['backup.selected'] as String? ?? '';
  bool _artifact(String value) => RegExp(r'^art-[a-f0-9]{32}$').hasMatch(value);
  @override void initState() {
    settingsFingerprint = jsonEncode(app.settings);
    super.initState();
    app.bridge.addListener(_bridgeChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _bridgeChanged(); });
  }
  @override void invalidate() { reading = false; inspecting = false; _expire(); }
  void _expire() { previewRevision++; preview = null; }
  @override void appChanged() {
    final fingerprint = jsonEncode(app.settings);
    if (app.busy || app.unknown || fingerprint != settingsFingerprint) _expire();
    settingsFingerprint = fingerprint;
  }
  void _bridgeChanged() {
    if (!mounted || !active) return;
    final results = json(app.bridge.control['results']);
    for (final entry in {'backup': 'backup.latest', 'restore': 'backup.restored'}.entries) {
      final result = json(results[entry.key]);
      if (result['ok'] == true) app.drafts[entry.value] = result;
    }
    setState(() {});
    final token = string(app.bridge.backup['token']);
    if (_artifact(token) && !consuming) _consume(token);
  }
  Future<void> _consume(String token) async {
    consuming = true;
    try {
      _select(token);
      await app.bridge.invoke<Object?>('consumeBackup', {'token': token});
      if (mounted && active) { await refresh(); await _inspect(); }
    } catch (failure) { if (mounted) setState(() => error = failureMessage(failure)); }
    finally { consuming = false; }
  }
  void _select(String value) {
    setState(() { _expire(); app.drafts['backup.selected'] = value; });
  }
  @override Future<void> refresh() async {
    if (reading || !active || !app.foreground) return;
    reading = true;
    final ticket = ++generation, account = app.accountRevision;
    try {
      await app.refreshSettings();
      if (!current(ticket, account)) return;
      final result = await read(['backup-list']);
      if (!mounted || !current(ticket, account)) return;
      final list = result['backups'];
      if (list is! List) throw FormatException(context.l10n.web_backup_invalid_response);
      final parsed = <Json>[];
      for (final raw in list) {
        final item = json(raw);
        if (!RegExp(r'^/sdcard/Download/foxytail-backup-[A-Za-z0-9._-]+\.tar\.gz$').hasMatch(string(item['path'])) || item['size'] is! num || (item['size'] as num) < 0 || item['mtime'] is! num || (item['mtime'] as num) < 0) throw FormatException(context.l10n.web_backup_invalid_response);
        parsed.add(item);
      }
      setState(() {
        if (preview != null && !_artifact(selected)) {
          final old = archives.where((item) => item['path'] == selected).firstOrNull;
          final next = parsed.where((item) => item['path'] == selected).firstOrNull;
          if (old == null || next == null || old['size'] != next['size'] || old['mtime'] != next['mtime']) _expire();
        }
        archives = parsed; error = null; reading = false;
        if (!_artifact(selected) && !archives.any((item) => item['path'] == selected)) { _expire(); app.drafts['backup.selected'] = ''; }
      });
      final inspected = preview, revision = previewRevision;
      if (inspected != null && writable) {
        final latest = await read(['restore-preview', selected]);
        if (current(ticket, account) && revision == previewRevision &&
            (!validRestorePreview(latest, selected) || latest['sha256'] != inspected['sha256'] || latest['baselineSha256'] != inspected['baselineSha256'])) {
          setState(() { _expire(); error = context.l10n.tools_preview_expired; });
        }
      }
    } catch (failure) { if (current(ticket, account)) setState(() { reading = false; error = failureMessage(failure); _expire(); }); }
  }
  Future<void> _inspect() async {
    if (selected.isEmpty || !writable || inspecting) return;
    setState(() { _expire(); inspecting = true; error = null; });
    final source = selected, revision = previewRevision, account = app.accountRevision, observation = app.observationRevision;
    try {
      final result = await read(['restore-preview', source]);
      if (!mounted || !active || !app.foreground || revision != previewRevision || account != app.accountRevision || observation != app.observationRevision || selected != source || !writable) return;
      if (!validRestorePreview(result, source)) throw FormatException(context.l10n.web_backup_invalid_response);
      setState(() => preview = result);
    } catch (failure) { if (mounted && revision == previewRevision) setState(() => error = failureMessage(failure)); }
    finally { if (mounted) setState(() => inspecting = false); }
  }
  Future<void> _restore() async {
    final current = preview, l = context.l10n;
    if (current == null || !writable) return;
    final revision = previewRevision;
    if (!await confirm(context, l.web_set_restore, '${l.web_set_restore_confirm}\n${current['path']}\nSHA-256: ${current['sha256']}\n${l.tools_baseline}: ${current['baselineSha256']}') || !mounted) return;
    if (preview != current || revision != previewRevision || selected != current['path'] || !writable) { app.message(l.tools_preview_expired); return; }
    setState(_expire);
    await perform(context, () async {
      final result = await app.submit(l.web_set_restore, ['restore', selected, current['sha256'] as String, current['baselineSha256'] as String]);
      if (result['ok'] != true) throw StateError(string(result['error'], l.web_op_failed));
      app.drafts['backup.restored'] = result;
      await app.refreshSettings();
      if (mounted) { setState(() {}); await refresh(); }
    });
  }
  Future<void> _backup() async {
    final l = context.l10n;
    setState(_expire);
    await perform(context, () async {
      final result = await app.submit(l.web_set_backup, ['backup']);
      if (result['ok'] != true) throw StateError(string(result['error'], l.web_op_failed));
      app.drafts['backup.latest'] = result;
      if (mounted) { setState(() {}); await refresh(); }
    });
  }
  Future<void> _export(String id, bool share, bool imported) async {
    final l = context.l10n;
    if (share && (!await confirm(context, l.tools_share, l.tools_backup_sensitive) || !mounted)) return;
    await perform(context, () async { await app.bridge.invoke<Object?>(share ? 'shareArtifact' : 'saveArtifact', {'id': id, 'name': imported ? 'foxytail-backup-import.tar.gz' : 'foxytail-backup.tar.gz'}); });
  }
  Widget _artifactView(Json value, {bool imported = false}) {
    final l = context.l10n, id = string(value['artifactId']), path = string(value['path']);
    if (!_artifact(id)) return Notice(l.web_backup_invalid_response, error: true);
    return Section(title: imported ? l.tools_imported_archive : l.web_tools_backup_latest, children: [
      if (path.isNotEmpty) SelectableText(path),
      Wrap(children: [
        if (path.isNotEmpty) IconButton(tooltip: l.web_tools_copy_path, onPressed: () => copyText(context, path), icon: const Icon(Icons.copy)),
        IconButton(tooltip: l.tools_save, onPressed: () => _export(id, false, imported), icon: const Icon(Icons.save_alt)),
        IconButton(tooltip: l.tools_share, onPressed: () => _export(id, true, imported), icon: const Icon(Icons.share_outlined)),
        IconButton(tooltip: l.tools_select, onPressed: () => _select(id), icon: const Icon(Icons.check_circle_outline)),
      ]),
    ]);
  }
  @override Widget build(BuildContext context) {
    final l = context.l10n, latest = json(app.drafts['backup.latest']), restored = json(app.drafts['backup.restored']);
    final body = <Widget>[
      Section(title: l.web_set_backup, children: [
        FilledButton.tonalIcon(onPressed: writable ? _backup : null, icon: const Icon(Icons.backup_outlined), label: Text(l.web_set_backup)),
        if (latest.isNotEmpty) _artifactView(latest),
        if (_artifact(selected) && selected != latest['artifactId']) _artifactView({'artifactId': selected}, imported: true),
      ]),
      Section(title: l.web_set_restore, trailing: IconButton(tooltip: l.web_backup_refresh, onPressed: reading ? null : refresh, icon: const Icon(Icons.refresh)), children: [
        if (reading) const LinearProgressIndicator(),
        if (error != null) Notice(error!, error: true),
        if (string(app.bridge.backup['error']).isNotEmpty) Notice(string(app.bridge.backup['error']), error: true),
        DropdownButtonFormField<String>(key: ValueKey('${selected}_${archives.length}'), initialValue: _artifact(selected) || archives.any((item) => item['path'] == selected) ? selected : '', isExpanded: true, decoration: InputDecoration(labelText: l.web_backup_select), items: [
          DropdownMenuItem(value: '', child: Text(l.web_backup_select)),
          if (_artifact(selected)) DropdownMenuItem(value: selected, child: Text(l.tools_imported_archive)),
          for (final item in archives) DropdownMenuItem(value: string(item['path']), child: Text('${string(item['name'])} (${formatBytes(number(item['size']))})')),
        ], onChanged: inspecting ? null : (value) => _select(value ?? '')),
        Wrap(spacing: 8, children: [
          FilledButton(onPressed: selected.isNotEmpty && writable && !inspecting ? _inspect : null, child: Text(l.web_backup_preview)),
          IconButton(tooltip: l.tools_import, onPressed: app.bridge.backup['busy'] == true ? null : () => perform(context, () async { setState(_expire); await app.bridge.invoke<Object?>('pickBackup'); }), icon: const Icon(Icons.file_open_outlined)),
        ]),
        if (inspecting || app.bridge.backup['busy'] == true) const LinearProgressIndicator(),
        if (preview != null) Section(title: l.web_backup_changes, children: [
          if (objects(preview!['changes']).isEmpty) Notice(l.web_backup_unchanged),
          for (final change in objects(preview!['changes'])) Card.outlined(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('${change['file']} · ${change['key']}', style: Theme.of(context).textTheme.titleSmall),
            InfoRow(l.web_backup_before, change['before'] == null ? '—' : string(change['before'])),
            InfoRow(l.web_backup_after, change['after'] == null ? '—' : string(change['after'])),
          ]))),
          if ((preview!['hooks'] as List).isNotEmpty) Notice('${l.web_backup_hooks}: ${(preview!['hooks'] as List).join(', ')}'),
          FilledButton(onPressed: writable ? _restore : null, child: Text(l.web_set_restore)),
        ]),
      ]),
      if (restored.isNotEmpty) Section(title: l.web_tools_restore_result, children: [
        if (restored['saved'] != true || restored['restartRequired'] != true || !string(restored['previous']).startsWith('/')) Notice(l.web_backup_invalid_response, error: true)
        else ...[Notice(l.web_tools_saved_pending), InfoRow(l.web_tools_restore_previous, string(restored['previous'])), if (restored['note'] is String) SelectableText(restored['note'] as String)],
      ]),
    ];
    return widget.embedded ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: body) : PageBody(children: body);
  }
  @override void dispose() { app.bridge.removeListener(_bridgeChanged); super.dispose(); }
}
