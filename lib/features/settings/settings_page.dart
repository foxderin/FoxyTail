import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'backup_page.dart';
import 'config_scope.dart';
import 'context_page.dart';
import 'settings_rules.dart';
import 'settings_state.dart';
import 'trial_page.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.app});
  final AppState app;
  @override State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends ConfigState<SettingsPage> {
  @override AppState get app => widget.app;
  static const boolKeys = ['MAGIC_DNS', 'IPV6', 'POWER_SAVE', 'WATCHDOG', 'WATCHDOG_PROBE', 'STATS', 'CONTEXT', 'WEBUI_AUTO_REFRESH'];
  static const ranges = <String, (int, int)>{'SOCKS_PORT': (1024, 65535), 'DNS_PORT': (1024, 65535), 'WATCHDOG_INTERVAL': (5, 300), 'STATS_INTERVAL': (10, 3600), 'LOG_MAX_KB': (64, 10240)};
  final fields = <String, SettingsDraft>{};
  final controllers = <String, TextEditingController>{};
  final fieldErrors = <String, String>{};
  final trialKey = GlobalKey<TrialPageState>();
  Json saved = {}, dns = {}, runtime = {};
  List<Json>? hooks;
  bool loaded = false, reading = false, restartRequired = false, advancedBuilt = false, diagnosticsOpen = false;
  bool capabilityProbed = false, submitting = false;
  String? settingsError, dnsError, runtimeError, hooksError;
  bool get advanced => app.drafts['settings.advanced'] == true;
  bool? get transparent => dns['transparentAvailable'] is bool ? dns['transparentAvailable'] as bool : null;
  @override void initState() {
    for (final key in [...boolKeys, 'DNS_MODE', ...ranges.keys]) {
      fields[key] = SettingsDraft(app.drafts, 'settings.$key');
      if (ranges.containsKey(key)) controllers[key] = TextEditingController(text: fields[key]!.value);
    }
    advancedBuilt = advanced;
    super.initState();
  }
  @override void invalidate() { reading = false; loaded = false; }
  void _bind(Json values, {String? discard}) {
    saved = values;
    for (final entry in fields.entries) {
      entry.value.receive(values[entry.key] as String, discard: discard == entry.key);
      final control = controllers[entry.key];
      if (control != null && control.text != entry.value.value) control.value = TextEditingValue(text: entry.value.value, selection: TextSelection.collapsed(offset: entry.value.value.length));
    }
  }
  @override Future<void> refresh() async {
    if (reading || submitting || !app.foreground) return;
    reading = true;
    final ticket = ++generation, account = app.accountRevision;
    await Future.wait([
      () async {
        try {
          final result = await read(['settings-get']), values = json(result['settings']);
          if (!mounted || !current(ticket, account)) return;
          if (result['restartRequired'] is! bool || fields.keys.any((key) => values[key] is! String)) throw FormatException(context.l10n.cs_invalid_response);
          setState(() { _bind(values); restartRequired = result['restartRequired'] as bool; loaded = true; settingsError = null; });
        } catch (error) { if (current(ticket, account)) setState(() { loaded = false; settingsError = failureMessage(error); }); }
      }(),
      _readDns(ticket, account),
      () async {
        try { final result = await read(['status']); if (current(ticket, account)) setState(() { runtime = result; runtimeError = null; }); }
        catch (error) { if (current(ticket, account)) setState(() => runtimeError = failureMessage(error)); }
      }(),
      if (advanced) _readHooks(ticket, account),
    ]);
    if (current(ticket, account)) setState(() => reading = false);
    if (mounted && current(ticket, account) && transparent == null && !capabilityProbed && writable) {
      capabilityProbed = true;
      final l = context.l10n;
      await perform(context, () async {
        final result = await app.submit(l.cs_dns_probe, ['dns-probe']);
        if (result['ok'] != true) throw StateError(string(result['error'], l.web_op_failed));
        if (mounted) await _readDns(generation, app.accountRevision);
      });
    }
  }
  Future<void> _readDns(int ticket, int account) async {
    try { final result = await read(['dns']); if (current(ticket, account)) setState(() { dns = result; dnsError = null; }); }
    catch (error) { if (current(ticket, account)) setState(() { dns = {}; dnsError = failureMessage(error); }); }
  }
  Future<void> _readHooks(int ticket, int account) async {
    try {
      final result = await read(['hooks-get']);
      if (!mounted || !current(ticket, account)) return;
      if (result['hooks'] is! List) throw FormatException(context.l10n.cs_invalid_response);
      setState(() { hooks = objects(result['hooks']); hooksError = null; });
    } catch (error) { if (current(ticket, account)) setState(() => hooksError = failureMessage(error)); }
  }
  Future<void> _reload(String key) async {
    final l = context.l10n;
    if (!await confirm(context, l.cs_reload_draft, l.cs_reload_confirm) || !mounted) return;
    final ticket = ++generation, account = app.accountRevision;
    reading = false;
    await perform(context, () async {
      final result = await read(['settings-get']), values = json(result['settings']);
      if (!current(ticket, account)) return;
      if (result['restartRequired'] is! bool || fields.keys.any((key) => values[key] is! String)) throw FormatException(l.cs_invalid_response);
      setState(() { _bind(values, discard: key); loaded = true; restartRequired = result['restartRequired'] as bool; fieldErrors.remove(key); });
    });
  }
  Future<void> _save(String key) async {
    if (!loaded || submitting || !writable) return;
    final l = context.l10n, field = fields[key]!, original = fields[key]!.value;
    final value = original.trim(), range = ranges[key];
    if (range != null) {
      try { boundedInteger(value, range.$1, range.$2); }
      on FormatException { setState(() => fieldErrors[key] = l.cs_number_range(range.$1, range.$2)); return; }
    }
    if (key == 'DNS_MODE' && value == 'transparent' && transparent == false) { app.message(l.cs_dns_unavailable); return; }
    if (field.conflict() || ['MAGIC_DNS', 'DNS_MODE', 'IPV6'].contains(key) || key.endsWith('_PORT')) {
      if (!await confirm(context, l.cs_save, '${field.conflict() ? '${l.cs_draft_conflict}\n\n' : ''}${l.cs_network_warning}') || !mounted || !loaded || !writable || field.value != original) return;
    }
    final account = app.accountRevision;
    setState(() { submitting = true; generation++; reading = false; });
    await perform(context, () async {
      final result = await app.submit('${l.cs_save} $key', ['settings-set', key, value]);
      if (result['ok'] != true) throw StateError(string(result['error'], l.web_op_failed));
      if (mounted && account == app.accountRevision) setState(() {
        field.submitted(original, value); fieldErrors.remove(key);
        final control = controllers[key];
        if (control != null && control.text == original) control.text = field.value;
      });
      app.message(result['applied'] == true ? l.web_tools_all_applied : l.web_tools_saved_pending);
      await app.refreshSettings();
    });
    if (mounted) { setState(() => submitting = false); await refresh(); }
  }
  Future<void> _restart() async {
    final l = context.l10n;
    if (trialKey.currentState == null || !await trialKey.currentState!.checkRestart() || !mounted) { app.message(l.cs_restart_blocked); return; }
    if (!await confirm(context, l.cs_restart, l.cs_network_warning) || !mounted || !writable) return;
    if (!await trialKey.currentState!.checkRestart() || !mounted || !writable) { app.message(l.cs_restart_blocked); return; }
    await perform(context, () async {
      final result = await app.submit(l.cs_restart, ['control', 'restart']);
      if (result['ok'] != true) throw StateError(string(result['error'], l.web_op_failed));
      final verified = await read(['settings-get']);
      app.message(verified['restartRequired'] == false ? l.web_set_applied : l.web_set_restart_required);
      await app.refreshSettings();
    });
    if (mounted) await refresh();
  }
  String _label(String key) {
    final l = context.l10n;
    return switch (key) {
      'MAGIC_DNS' => l.web_tools_magicdns, 'DNS_MODE' => l.web_tools_dns_mode, 'IPV6' => l.web_tools_ipv6,
      'SOCKS_PORT' => l.web_tools_socks_port, 'DNS_PORT' => l.web_tools_dns_port,
      'POWER_SAVE' => l.web_tools_power_save, 'WATCHDOG' => l.web_tools_watchdog,
      'WATCHDOG_PROBE' => l.web_tools_watchdog_probe, 'STATS' => l.web_tools_stats_enabled,
      'CONTEXT' => l.web_tools_context_enabled, 'WEBUI_AUTO_REFRESH' => l.web_tools_auto_refresh,
      'WATCHDOG_INTERVAL' => l.web_tools_watchdog_interval, 'STATS_INTERVAL' => l.web_tools_stats_interval,
      'LOG_MAX_KB' => l.web_tools_log_limit, _ => key,
    };
  }
  Widget _field(String key) {
    final l = context.l10n, field = fields[key]!, range = ranges[key];
    final enabled = loaded && !submitting && writable, changed = field.dirty || field.conflict();
    return Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (boolKeys.contains(key)) SwitchListTile.adaptive(contentPadding: EdgeInsets.zero, title: Text(_label(key)), value: field.value == 'on', onChanged: enabled ? (value) => setState(() => field.value = value ? 'on' : 'off') : null)
      else if (key == 'DNS_MODE') DropdownButtonFormField<String>(key: ValueKey('dns-${field.value}-$enabled'), initialValue: ['legacy', 'local', 'transparent'].contains(field.value) ? field.value : null, isExpanded: true, decoration: InputDecoration(labelText: _label(key)), items: [
        DropdownMenuItem(value: 'legacy', child: Text(l.web_tools_dns_mode_legacy)), DropdownMenuItem(value: 'local', child: Text(l.web_tools_dns_mode_local)),
        DropdownMenuItem(value: 'transparent', enabled: transparent != false, child: Text(l.web_tools_dns_mode_transparent_option)),
      ], onChanged: enabled ? (value) => setState(() => field.value = value ?? field.value) : null)
      else TextField(controller: controllers[key], enabled: enabled, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: _label(key), helperText: '${l.web_tools_range} ${range!.$1}–${range.$2}', errorText: fieldErrors[key]), onChanged: (value) => setState(() { field.value = value; fieldErrors.remove(key); })),
      if (key == 'WATCHDOG_PROBE' && runtime['powerSave'] == true) Notice(l.web_tools_probe_paused),
      if (key == 'DNS_MODE') ...[
        Notice(field.value == 'transparent' ? transparent == false ? l.web_tools_dns_mode_transparent_unavailable : l.web_tools_dns_mode_transparent_hint : field.value == 'local' ? l.web_tools_dns_mode_local_hint : l.web_tools_dns_mode_legacy_hint),
        if (transparent == false && string(dns['transparentUnavailableReason']).isNotEmpty) Notice(string(dns['transparentUnavailableReason']), error: true),
      ],
      if (changed) Row(children: [
        Expanded(child: Notice(field.conflict() ? l.cs_draft_conflict : l.cs_draft_changed, error: field.conflict())),
        IconButton(tooltip: '${l.cs_save} ${_label(key)}', onPressed: enabled && field.dirty ? () => _save(key) : null, icon: const Icon(Icons.save_outlined)),
        IconButton(tooltip: '${l.cs_reload_draft} ${_label(key)}', onPressed: () => _reload(key), icon: const Icon(Icons.restore)),
      ]),
    ]));
  }
  void _advanced(bool open) {
    setState(() { app.drafts['settings.advanced'] = open; advancedBuilt |= open; });
    if (open) _readHooks(generation, app.accountRevision);
  }
  Widget _advancedBody() {
    final l = context.l10n;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Notice(l.cs_readonly), InfoRow(l.web_tools_route_table, textState(saved['ROUTE_TABLE'], l.cs_value_unknown)),
      InfoRow(l.web_tools_mark, textState(saved['FWMARK'], l.cs_value_unknown)), InfoRow(l.web_tools_mark_mask, textState(saved['FWMARK_MASK'], l.cs_value_unknown)),
      ContextPage(app: app, embedded: true, active: advanced),
      Section(title: l.web_set_hooks, children: [
        if (hooksError != null) Notice(hooksError!, error: true),
        if (hooks == null && hooksError == null) const LinearProgressIndicator(),
        for (final name in ['foxytail.tun.up', 'foxytail.tun.down']) Builder(builder: (context) {
          final matching = hooks?.where((hook) => hook['name'] == name).toList() ?? [];
          final found = matching.isEmpty ? null : matching.first;
          return InfoRow(name.endsWith('.up') ? l.web_set_hook_up : l.web_set_hook_down, found == null || found['missing'] == true ? l.web_misc_missing : string(found['content']).isEmpty ? l.web_misc_empty : string(found['content']));
        }),
      ]),
      ExpansionTile(title: Text(l.web_diag_title), initiallyExpanded: diagnosticsOpen, onExpansionChanged: (value) => setState(() => diagnosticsOpen = value), children: [
        Section(title: l.cs_dns_state, children: [
          if (dnsError != null) Notice(dnsError!, error: true),
          for (final entry in dnsFacts(l, dns).entries) InfoRow(entry.key, entry.value),
          IconButton(tooltip: l.cs_dns_probe, onPressed: writable ? () => perform(context, () async {
            final result = await app.submit(l.cs_dns_probe, ['dns-probe']);
            if (result['ok'] != true) throw StateError(string(result['error'], l.web_op_failed));
            if (mounted) await _readDns(generation, app.accountRevision);
          }) : null, icon: const Icon(Icons.dns_outlined)),
        ]),
        Section(title: l.cs_status, children: [if (runtimeError != null) Notice(runtimeError!, error: true), for (final entry in runtimeFacts(l, runtime).entries) InfoRow(entry.key, entry.value)]),
      ]),
    ]);
  }
  @override Widget build(BuildContext context) {
    final l = context.l10n;
    return PageBody(children: [
      if (settingsError != null) Notice(settingsError!, error: true),
      if (reading && !loaded) const LinearProgressIndicator(),
      if (restartRequired) Section(title: l.web_tools_saved_pending, children: [Notice(l.web_tools_saved_pending_desc), FilledButton.icon(onPressed: loaded && writable && trialKey.currentState?.restartAllowed == true ? _restart : null, icon: const Icon(Icons.restart_alt), label: Text(l.web_tools_restart))]),
      Section(title: l.web_tools_appearance, trailing: IconButton(tooltip: l.web_tools_refresh, onPressed: reading ? null : refresh, icon: const Icon(Icons.refresh)), children: [
        DropdownButtonFormField<String>(key: ValueKey('theme-${app.theme}'), initialValue: app.theme, decoration: InputDecoration(labelText: l.web_set_theme), items: [DropdownMenuItem(value: 'auto', child: Text(l.web_set_theme_auto)), DropdownMenuItem(value: 'light', child: Text(l.web_set_theme_light)), DropdownMenuItem(value: 'dark', child: Text(l.web_set_theme_dark))], onChanged: (value) { if (value != null) perform(context, () => app.setAppearance('theme', value)); }),
        const SizedBox(height: 16),
        DropdownButtonFormField<String>(key: ValueKey('language-${app.language}'), initialValue: ['en', 'zh'].contains(app.language) ? app.language : 'auto', decoration: InputDecoration(labelText: l.web_set_language), items: [DropdownMenuItem(value: 'auto', child: Text(l.web_set_theme_auto)), const DropdownMenuItem(value: 'zh', child: Text('中文')), const DropdownMenuItem(value: 'en', child: Text('English'))], onChanged: (value) { if (value != null) perform(context, () => app.setAppearance('language', value)); }),
      ]),
      Section(title: l.web_tools_network_settings, trailing: IconButton(tooltip: l.web_tools_mode_link, onPressed: () => app.navigate('tunnel'), icon: const Icon(Icons.router_outlined)), children: [for (final key in ['MAGIC_DNS', 'DNS_MODE', 'IPV6', 'SOCKS_PORT', 'DNS_PORT']) _field(key), if (loaded) Notice(restartRequired ? l.web_tools_saved_pending : l.web_tools_all_applied)]),
      Section(title: l.web_tools_background, children: [for (final key in ['POWER_SAVE', 'WATCHDOG', 'WATCHDOG_PROBE', 'STATS', 'CONTEXT', 'WEBUI_AUTO_REFRESH', 'WATCHDOG_INTERVAL', 'STATS_INTERVAL', 'LOG_MAX_KB']) _field(key)]),
      TrialPage(key: trialKey, app: app, embedded: true, onChanged: () { if (mounted) setState(() {}); }, onSettingsChanged: refresh),
      ExpansionTile(title: Text(l.web_tools_advanced), initiallyExpanded: advanced, maintainState: true, onExpansionChanged: _advanced, children: [if (advancedBuilt) _advancedBody()]),
      BackupPage(app: app, embedded: true),
    ]);
  }
  @override void dispose() { for (final controller in controllers.values) { controller.dispose(); } super.dispose(); }
}
