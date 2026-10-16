import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'config_scope.dart';
import 'settings_rules.dart';
import 'settings_state.dart';

class ContextPage extends StatefulWidget {
  const ContextPage({super.key, required this.app, this.embedded = false, this.active = true});
  final AppState app;
  final bool embedded, active;
  @override State<ContextPage> createState() => _ContextPageState();
}

class _ContextPageState extends ConfigState<ContextPage> {
  @override AppState get app => widget.app;
  @override bool get active => widget.active;
  late final SettingsDraft draft;
  late final TextEditingController raw, ssid, target;
  bool loaded = false, reading = false, saving = false;
  String? rulesError, statusError;
  String? get editorError => app.drafts['context.editorError'] as String?;
  set editorError(String? value) { if (value == null) { app.drafts.remove('context.editorError'); } else { app.drafts['context.editorError'] = value; } }
  Json? status;
  bool get textMode => app.drafts['context.textMode'] == true;
  int get editing => app.drafts['context.editing'] as int? ?? -2;
  String get trigger => app.drafts['context.trigger'] as String? ?? 'ssid';
  String get action => app.drafts['context.action'] as String? ?? 'up';
  bool get editable => loaded && !saving && writable;
  @override void initState() {
    draft = SettingsDraft(app.drafts, 'context.raw');
    raw = TextEditingController(text: draft.value);
    ssid = TextEditingController(text: app.drafts['context.value'] as String? ?? '');
    target = TextEditingController(text: app.drafts['context.arg'] as String? ?? '');
    super.initState();
  }
  @override void invalidate() { reading = false; }
  @override Future<void> refresh() async {
    if (reading || saving || !active || !app.foreground) return;
    reading = true;
    final ticket = ++generation, account = app.accountRevision;
    await Future.wait([
      () async {
        try {
          final result = await read(['context-get']);
          if (!mounted || !current(ticket, account)) return;
          if (result['rules'] is! String) throw FormatException(context.l10n.web_tools_context_load_error);
          setState(() {
            draft.receive(result['rules'] as String, editing: editing != -2);
            _syncRaw(); loaded = true; rulesError = null;
          });
        } catch (error) { if (current(ticket, account)) setState(() => rulesError = failureMessage(error)); }
      }(),
      () async {
        try {
          final result = await read(['context-status']);
          if (current(ticket, account)) setState(() { status = json(result['status']); statusError = null; });
        } catch (error) { if (current(ticket, account)) setState(() { status = null; statusError = failureMessage(error); }); }
      }(),
    ]);
    if (current(ticket, account)) setState(() => reading = false);
  }
  void _syncRaw() {
    if (raw.text != draft.value) raw.value = TextEditingValue(text: draft.value, selection: TextSelection.collapsed(offset: draft.value.length));
  }
  void _changeRaw(String value) { setState(() { draft.value = value; _syncRaw(); }); }
  void _startEdit(int index, ContextRule? rule) {
    setState(() {
      app.drafts['context.editing'] = index;
      app.drafts['context.trigger'] = rule?.trigger ?? 'ssid';
      app.drafts['context.action'] = rule?.action ?? 'up';
      ssid.text = rule?.value ?? ''; target.text = rule?.argument ?? '';
      app.drafts['context.value'] = ssid.text; app.drafts['context.arg'] = target.text; editorError = null;
    });
  }
  void _closeEdit() { setState(() { app.drafts.remove('context.editing'); editorError = null; }); }
  void _applyRule() {
    final rule = ContextRule(trigger, ssid.text, action, target.text);
    if (parseContextRule(rule.line) == null) { setState(() => editorError = context.l10n.web_context_invalid); return; }
    _changeRaw(replaceContextRule(draft.value, editing, rule.line));
    _closeEdit();
  }
  Future<void> _reload() async {
    if (!await confirm(context, context.l10n.cs_reload_draft, context.l10n.cs_reload_confirm) || !mounted) return;
    final ticket = ++generation, account = app.accountRevision;
    try {
      final result = await read(['context-get']);
      if (!mounted || !current(ticket, account)) return;
      if (result['rules'] is! String) throw FormatException(context.l10n.cs_invalid_response);
      setState(() { draft.receive(result['rules'] as String, discard: true); _syncRaw(); app.drafts.remove('context.editing'); loaded = true; rulesError = null; editorError = null; reading = false; });
    } catch (error) { if (current(ticket, account)) setState(() { rulesError = failureMessage(error); reading = false; }); }
  }
  Future<void> _save() async {
    final l = context.l10n;
    if (!editable || editing != -2) return;
    final submitted = draft.value;
    if (!contextWithinLimit(submitted)) { setState(() => rulesError = l.cs_context_limit); return; }
    if (!await confirm(context, l.web_save, '${draft.conflict() ? '${l.cs_draft_conflict}\n\n' : ''}${l.cs_network_warning}') || !mounted || !editable || draft.value != submitted) return;
    setState(() { saving = true; generation++; reading = false; });
    final account = app.accountRevision;
    await perform(context, () async {
      final result = await app.submit(l.web_save, ['context-set', base64Encode(utf8.encode(submitted))]);
      if (result['ok'] != true) throw StateError(string(result['error'], l.web_op_failed));
      if (mounted && account == app.accountRevision) setState(() => draft.submitted(submitted, submitted));
      app.message(l.web_tools_saved_pending);
    });
    if (mounted) { setState(() => saving = false); await refresh(); }
  }
  String _actionLabel(String value) {
    final l = context.l10n;
    return switch (value) { 'down' => l.web_context_down, 'exit-node' => l.web_context_exit, 'no-exit-node' => l.web_context_no_exit, _ => l.web_context_up };
  }
  List<Widget> _status() {
    final l = context.l10n, value = status;
    final known = value != null && value['running'] is bool && value['context'] is String;
    final last = json(value?['lastResult']);
    final confirmed = known && last['ok'] is bool && last['context'] is String && last['at'] is num && (last['at'] as num).isFinite;
    return [
      InfoRow(l.web_context_current, known ? '${textState(value['context'], l.web_net_unknown)} · ${value['running'] == true ? l.web_context_running : l.web_context_stopped}' : l.web_net_unknown),
      if (!confirmed) Notice(l.web_context_unconfirmed)
      else ...[
        InfoRow(l.web_context_last, '${last['ok'] == true ? l.web_context_success : l.web_context_failed} · ${last['context']} · ${formatTime(last['at'] as num)}'),
        if (string(last['error']).isNotEmpty && last['error'] != 'context-action-failed') Notice(string(last['error']), error: true),
      ],
      if (statusError != null) Notice(statusError!, error: true),
    ];
  }
  List<Widget> _visual() {
    final l = context.l10n, lines = draft.value.split('\n'), positions = visibleContextRules(draft.value);
    final canEdit = editable && editing == -2;
    return [
      if (!loaded) const LinearProgressIndicator(),
      for (var position = 0; position < positions.length; position++) Builder(builder: (context) {
        final index = positions[position], rule = parseContextRule(lines[index]);
        return Card.outlined(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (rule == null) ...[Text(l.web_context_unsupported), SelectableText(lines[index], style: const TextStyle(fontFamily: 'monospace'))]
          else Text('${rule.trigger == 'ssid' ? '${l.web_context_wifi}: ${rule.value}' : l.web_context_cellular} → ${_actionLabel(rule.action)}${rule.argument.isEmpty ? '' : ': ${rule.argument}'}'),
          Wrap(alignment: WrapAlignment.end, children: [
            IconButton(tooltip: l.web_context_move_up, onPressed: canEdit && position > 0 ? () => _changeRaw(moveContextRule(draft.value, index, positions[position - 1])) : null, icon: const Icon(Icons.arrow_upward)),
            IconButton(tooltip: l.web_context_move_down, onPressed: canEdit && position + 1 < positions.length ? () => _changeRaw(moveContextRule(draft.value, index, positions[position + 1])) : null, icon: const Icon(Icons.arrow_downward)),
            IconButton(tooltip: l.web_context_edit, onPressed: canEdit ? () { if (rule == null) { setState(() => app.drafts['context.textMode'] = true); } else { _startEdit(index, rule); } } : null, icon: const Icon(Icons.edit_outlined)),
            IconButton(tooltip: l.web_delete, onPressed: canEdit ? () => _changeRaw(removeContextRule(draft.value, index)) : null, icon: const Icon(Icons.delete_outline)),
          ]),
        ])));
      }),
      if (loaded && positions.isEmpty) Notice(l.web_context_empty),
      Align(alignment: AlignmentDirectional.centerStart, child: FilledButton.tonalIcon(onPressed: canEdit ? () => _startEdit(-1, null) : null, icon: const Icon(Icons.add), label: Text(l.web_context_add))),
    ];
  }
  Widget _editor() {
    final l = context.l10n;
    return Section(title: l.web_context_edit, children: [
      DropdownButtonFormField<String>(key: ValueKey('trigger-$editing-$trigger'), initialValue: trigger, decoration: InputDecoration(labelText: l.web_context_network), items: [DropdownMenuItem(value: 'ssid', child: Text(l.web_context_wifi)), DropdownMenuItem(value: 'cellular', child: Text(l.web_context_cellular))], onChanged: editable ? (value) => setState(() { app.drafts['context.trigger'] = value; editorError = null; }) : null),
      if (trigger == 'ssid') TextField(controller: ssid, enabled: editable, decoration: const InputDecoration(labelText: 'SSID'), onChanged: (value) { app.drafts['context.value'] = value; setState(() => editorError = null); }),
      DropdownButtonFormField<String>(key: ValueKey('action-$editing-$action'), initialValue: action, decoration: InputDecoration(labelText: l.web_context_action), items: [for (final value in ['up', 'down', 'exit-node', 'no-exit-node']) DropdownMenuItem(value: value, child: Text(_actionLabel(value)))], onChanged: editable ? (value) => setState(() { app.drafts['context.action'] = value; editorError = null; }) : null),
      if (action == 'exit-node') TextField(controller: target, enabled: editable, decoration: InputDecoration(labelText: l.web_context_target), onChanged: (value) { app.drafts['context.arg'] = value; setState(() => editorError = null); }),
      if (editorError != null) Notice(editorError!, error: true),
      Wrap(children: [FilledButton(onPressed: editable ? _applyRule : null, child: Text(l.web_context_apply_rule)), IconButton(tooltip: l.web_cancel, onPressed: _closeEdit, icon: const Icon(Icons.close))]),
    ]);
  }
  @override Widget build(BuildContext context) {
    final l = context.l10n;
    final body = <Widget>[
      Section(title: l.web_set_context, trailing: Wrap(children: [
        IconButton(tooltip: l.web_context_refresh, onPressed: reading || saving ? null : refresh, icon: const Icon(Icons.refresh)),
        IconButton(tooltip: textMode ? l.web_context_visual : l.web_context_text, onPressed: editing == -2 && !saving ? () => setState(() => app.drafts['context.textMode'] = !textMode) : null, icon: Icon(textMode ? Icons.view_list_outlined : Icons.code)),
      ]), children: [
        ..._status(),
        if (draft.conflict(editing: editing != -2)) Notice(l.cs_draft_conflict, error: true) else if (draft.dirty || editing != -2) Notice(l.cs_draft_changed),
        if (rulesError != null) Notice(rulesError!, error: true),
        if (textMode) ...[Notice(l.web_set_context_hint), TextField(controller: raw, enabled: editable, minLines: 8, maxLines: 20, style: const TextStyle(fontFamily: 'monospace'), decoration: InputDecoration(labelText: l.web_set_context), onChanged: (value) => setState(() => draft.value = value))] else ..._visual(),
        if (editing != -2) _editor(),
        Wrap(spacing: 8, children: [FilledButton.icon(onPressed: editable && editing == -2 ? _save : null, icon: const Icon(Icons.save_outlined), label: Text(l.web_save)), if (draft.dirty || editing != -2 || draft.conflict()) IconButton(tooltip: l.cs_reload_draft, onPressed: saving ? null : () => perform(context, _reload), icon: const Icon(Icons.restore))]),
      ]),
    ];
    return widget.embedded ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: body) : PageBody(children: body);
  }
  @override void dispose() { raw.dispose(); ssid.dispose(); target.dispose(); super.dispose(); }
}
