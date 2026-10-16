import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';

abstract class NetworkPageState<T extends StatefulWidget> extends State<T> {
  AppState get app;
  late final String owner = 'network-${identityHashCode(this)}';
  late int _account, _observation;
  late bool _foreground;
  int generation = 0;
  bool get writable => app.foreground && app.canWrite && !app.busy && !app.unknown;
  @override
  void initState() {
    super.initState();
    _account = app.accountRevision;
    _observation = app.observationRevision;
    _foreground = app.foreground;
    app.addListener(_changed);
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) load(); });
  }
  void load() {}
  void invalidated() {}
  void _changed() {
    if (!mounted) return;
    if (_foreground != app.foreground) {
      _foreground = app.foreground;
      generation++;
      app.bridge.cancelReads(owner);
      invalidated();
      if (_foreground) WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted && app.foreground) load(); });
    }
    if (_account != app.accountRevision || _observation != app.observationRevision) {
      _account = app.accountRevision;
      _observation = app.observationRevision;
      generation++;
      app.bridge.cancelReads(owner);
      invalidated();
    }
    setState(() {});
  }
  bool current(int ticket, int account, int observation) => mounted && app.foreground && ticket == generation &&
      account == app.accountRevision && observation == app.observationRevision;
  Future<Json?> readCurrent(List<String> args) async {
    final ticket = generation, account = app.accountRevision, observation = app.observationRevision;
    try {
      final result = await app.read(args, owner: owner);
      return current(ticket, account, observation) ? result : null;
    } catch (_) {
      if (!current(ticket, account, observation)) return null;
      rethrow;
    }
  }
  Future<Json?> probeCurrent(String label, List<String> args) async {
    final ticket = generation, account = app.accountRevision, observation = app.observationRevision;
    try {
      final result = await app.submit(label, args);
      return current(ticket, account, observation) ? result : null;
    } catch (_) {
      if (!current(ticket, account, observation)) return null;
      rethrow;
    }
  }
  Future<void> run(Future<void> Function() action) => perform(context, action);
  void requireOk(Json result) {
    if (result['ok'] != true) throw StateError(string(result['error'], context.l10n.network_invalid_result));
  }
  @override
  void dispose() {
    generation++;
    app.removeListener(_changed);
    app.bridge.cancelReads(owner);
    super.dispose();
  }
}
