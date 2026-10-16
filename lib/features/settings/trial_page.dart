import 'dart:async';
import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'config_scope.dart';
import 'settings_state.dart';
import 'settings_rules.dart';

class TrialPage extends StatefulWidget {
  const TrialPage({super.key, required this.app, this.embedded = false, this.active = true, this.onChanged, this.onSettingsChanged});
  final AppState app;
  final bool embedded, active;
  final VoidCallback? onChanged;
  final VoidCallback? onSettingsChanged;
  @override State<TrialPage> createState() => TrialPageState();
}

class TrialPageState extends ConfigState<TrialPage> {
  @override AppState get app => widget.app;
  @override bool get active => widget.active;
  final observation = TrialObservation();
  final clock = Stopwatch();
  Timer? timer;
  bool reading = false, refreshSettings = false;
  String? error;
  late final TextEditingController duration;
  bool get restartAllowed => observation.restartAllowed;
  String get candidate => app.drafts['trial.mode'] as String? ?? 'saved';
  @override void initState() {
    duration = TextEditingController(text: app.drafts['trial.duration'] as String? ?? '120');
    clock.start();
    super.initState();
    timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted || !active || !app.foreground) return;
      setState(() {});
      if ((!observation.known || observation.active) && clock.elapsedMilliseconds % 2000 < 1000) refresh();
    });
  }
  @override void invalidate() { observation.known = false; reading = false; }
  @override Future<void> refresh() async {
    if (reading || observation.changing || !active || !app.foreground) return;
    reading = true;
    final ticket = ++generation, account = app.accountRevision, requestedAt = clock.elapsedMilliseconds;
    try {
      final result = await read(['trial-status']);
      if (!current(ticket, account)) return;
      final changed = observation.receive(result, requestedAt);
      setState(() { reading = false; error = null; });
      final update = refreshSettings || changed;
      refreshSettings = false;
      if (update) { await app.refreshSettings(); if (mounted) widget.onSettingsChanged?.call(); }
    } catch (failure) {
      if (current(ticket, account)) {
        setState(() { observation.known = false; error = failureMessage(failure); reading = false; });
        if (refreshSettings) { refreshSettings = false; await app.refreshSettings(); if (mounted) widget.onSettingsChanged?.call(); }
      }
    }
    if (mounted) widget.onChanged?.call();
  }
  Future<bool> checkRestart() async {
    // A pending poll is not the precondition for a new destructive action.
    generation++; reading = false; observation.known = false;
    await refresh();
    return mounted && restartAllowed;
  }
  Future<void> _start() async {
    final l = context.l10n;
    if (!observation.known || observation.active || !writable) return;
    int seconds;
    try { seconds = trialDuration(duration.text); }
    on FormatException { setState(() => error = l.cs_number_range(30, 300)); return; }
    final mode = candidate;
    if (!await confirm(context, l.web_trial_start, l.cs_network_warning) || !mounted || !observation.known || observation.active || !writable) return;
    await _change(l.web_trial_start, ['trial-start', '$seconds', mode]);
  }
  Future<void> _finish(bool keep) async {
    final l = context.l10n, value = observation.trial;
    if (!observation.known || value == null || !observation.active || keep && !observation.canConfirm(clock.elapsedMilliseconds)) return;
    final id = string(value['id']);
    final label = keep ? l.web_trial_confirm : l.web_trial_revert;
    if (!await confirm(context, label, keep ? l.cs_trial_confirm_warning : l.cs_trial_revert_warning) || !mounted) return;
    if (!observation.known || observation.trial?['id'] != id || !observation.active || keep && !observation.canConfirm(clock.elapsedMilliseconds) || !writable) { await refresh(); return; }
    await _change(label, [keep ? 'trial-confirm' : 'trial-revert', id]);
  }
  Future<void> _change(String label, List<String> args) async {
    final failed = context.l10n.web_op_failed;
    setState(() { observation.changing = true; observation.known = false; generation++; reading = false; error = null; });
    widget.onChanged?.call();
    await perform(context, () async {
      final result = await app.submit(label, args);
      if (result['ok'] != true) throw StateError(string(result['error'], failed));
    });
    if (mounted) { setState(() { observation.changing = false; refreshSettings = true; }); await refresh(); }
  }
  String _label(String status) {
    final l = context.l10n;
    return switch (status) {
      'preparing' => l.web_trial_preparing, 'running' => l.web_trial_running, 'rolling-back' => l.web_trial_reverting,
      'confirmed' => l.web_trial_confirmed, 'rolled-back' => l.web_trial_reverted, 'rollback-failed' => l.web_trial_failed,
      'superseded' => l.web_trial_superseded, _ => l.web_trial_invalid_response,
    };
  }
  String _summary(Object? value) { final data = json(value); return '${string(data['mode'])} / ${string(data['dnsMode'])} / ${string(data['routeScope'])}'; }
  @override Widget build(BuildContext context) {
    final l = context.l10n, value = observation.trial;
    final editable = observation.known && !observation.active && !observation.changing && writable;
    final body = Section(title: l.web_trial_title, trailing: IconButton(tooltip: l.web_retry, onPressed: reading || observation.changing ? null : refresh, icon: const Icon(Icons.refresh)), children: [
      DropdownButtonFormField<String>(initialValue: candidate, decoration: InputDecoration(labelText: l.web_trial_candidate), items: [for (final mode in ['saved', 'bridge', 'tun', 'proxy']) DropdownMenuItem(value: mode, child: Text(mode == 'saved' ? l.web_trial_saved : mode))], onChanged: editable ? (value) => setState(() => app.drafts['trial.mode'] = value) : null),
      TextField(controller: duration, enabled: editable, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: l.web_trial_duration, helperText: '${l.web_tools_range} 30–300 s'), onChanged: (value) => app.drafts['trial.duration'] = value),
      if (!observation.known && error == null) const LinearProgressIndicator(),
      if (error != null) Notice('${l.web_trial_invalid_response}\n$error', error: true),
      if (observation.known && value != null) ...[
        Notice(_label(string(value['status'])), error: value['status'] == 'rollback-failed'),
        InfoRow(l.web_trial_candidate, _summary(value['candidate'])),
        InfoRow(l.web_trial_previous, _summary(value['previous'])),
        if (value['status'] == 'running') Semantics(liveRegion: true, child: InfoRow(l.web_trial_remaining, '${observation.remaining(clock.elapsedMilliseconds)} s')),
        if (string(value['reason']).isNotEmpty) Notice(string(value['reason'])),
      ],
      Wrap(spacing: 8, children: [
        if (!observation.active) FilledButton(onPressed: editable ? _start : null, child: Text(l.web_trial_start)),
        if (observation.active) ...[
          FilledButton(onPressed: writable && observation.canConfirm(clock.elapsedMilliseconds) ? () => _finish(true) : null, child: Text(l.web_trial_confirm)),
          OutlinedButton(onPressed: writable && observation.known && !observation.changing ? () => _finish(false) : null, child: Text(l.web_trial_revert)),
        ],
      ]),
    ]);
    return widget.embedded ? body : PageBody(children: [body]);
  }
  @override void dispose() { timer?.cancel(); clock.stop(); duration.dispose(); super.dispose(); }
}
