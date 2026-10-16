import 'dart:async';
import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';

abstract class ConfigState<T extends StatefulWidget> extends State<T> {
  AppState get app;
  bool get active => true;
  late final String owner = 'settings-${identityHashCode(this)}';
  int generation = 0;
  late int _account, _observation;
  late bool _foreground, _busy;
  late bool _active;
  Timer? _poll;
  int _pollTicks = 0;
  bool get writable => app.canWrite && !app.busy && !app.unknown;
  bool current(int ticket, int account) => mounted && active && app.foreground && generation == ticket && app.accountRevision == account;
  Future<void> refresh();
  void invalidate() {}
  void appChanged() {}
  @override void initState() {
    super.initState();
    _account = app.accountRevision; _observation = app.observationRevision; _foreground = app.foreground;
    _busy = app.busy;
    _active = active;
    app.addListener(_changed);
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted && active && app.foreground) refresh(); });
    _poll = Timer.periodic(const Duration(seconds: 10), (_) {
      _pollTicks++;
      if (app.powerSave && _pollTicks % 3 != 0) return;
      if (active && app.foreground && app.autoRefresh && !app.busy) refresh();
    });
  }
  void _changed() {
    if (!mounted) return;
    final changed = _account != app.accountRevision || _observation != app.observationRevision;
    final resumed = !_foreground && app.foreground;
    final settled = _busy && !app.busy;
    if (changed || !app.foreground && _foreground) {
      generation++; app.bridge.cancelReads(owner); invalidate();
    }
    _account = app.accountRevision; _observation = app.observationRevision; _foreground = app.foreground;
    _busy = app.busy;
    appChanged();
    setState(() {});
    if ((changed || resumed || settled) && active && app.foreground && !app.busy) refresh();
  }
  @override void didUpdateWidget(covariant T oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_active != active) {
      _active = active;
      generation++; app.bridge.cancelReads(owner); invalidate();
      if (active && app.foreground) {
        WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted && active) refresh(); });
      }
    }
  }
  Future<Json> read(List<String> args) => app.read(args, owner: owner);
  @override void dispose() {
    generation++; _poll?.cancel(); app.removeListener(_changed); app.bridge.cancelReads(owner); super.dispose();
  }
}
