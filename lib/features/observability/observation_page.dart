import 'dart:async';
import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';

abstract class ObservationPageState<T extends StatefulWidget> extends State<T> {
  AppState get app;
  String get destination;
  late final String owner = '$destination-${identityHashCode(this)}';
  int generation = 0;
  late int _account, _observation;
  bool _active = false;
  Timer? _timer;
  bool get active => mounted && app.foreground && app.destination == destination;
  bool accepts(int request) => active && request == generation;
  Duration? get interval => null;
  bool get shouldPoll => app.autoRefresh;
  void load();
  void invalidate(bool accountChanged);

  @override
  void initState() {
    super.initState();
    _account = app.accountRevision;
    _observation = app.observationRevision;
    app.addListener(_changed);
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _changed(); });
  }

  void _changed() {
    final accountChanged = _account != app.accountRevision;
    final observationChanged = _observation != app.observationRevision;
    final next = active;
    final resumed = next && !_active;
    if (accountChanged || observationChanged || next != _active) {
      generation++;
      app.bridge.cancelReads(owner);
      _timer?.cancel();
      _account = app.accountRevision;
      _observation = app.observationRevision;
      _active = next;
      invalidate(accountChanged);
      if (next) {
        _schedule();
        if (resumed || accountChanged || observationChanged) load();
      }
    }
    if (mounted) setState(() {});
  }

  void _schedule() {
    final delay = interval;
    if (!active || delay == null) return;
    _timer = Timer(app.powerSave && delay < const Duration(seconds: 30) ? const Duration(seconds: 30) : delay, () {
      if (!active) return;
      if (shouldPoll) load();
      _schedule();
    });
  }

  @override
  void dispose() {
    generation++;
    _timer?.cancel();
    app.removeListener(_changed);
    app.bridge.cancelReads(owner);
    super.dispose();
  }
}
