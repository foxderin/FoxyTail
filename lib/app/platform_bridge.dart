import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

typedef Json = Map<String, dynamic>;

Json json(Object? value) => value is Map
    ? value.map((key, value) => MapEntry(key.toString(), value))
    : <String, dynamic>{};
List<Json> objects(Object? value) => value is List
    ? value.whereType<Map>().map(json).toList(growable: false)
    : const <Json>[];
String string(Object? value, [String fallback = '']) =>
    value is String ? value : fallback;
num number(Object? value, [num fallback = 0]) =>
    value is num && value.isFinite ? value : fallback;
bool boolean(Object? value) => value == true;

String failureMessage(Object error) => switch (error) {
  PlatformException() => error.message ?? error.code,
  FormatException() => error.message,
  StateError() => error.message,
  _ => error.toString(),
};

class NativeBridge extends ChangeNotifier {
  NativeBridge();
  static final instance = NativeBridge();
  static const _methods = MethodChannel('dev.foxderin.tail/control');
  static const _events = EventChannel('dev.foxderin.tail/events');
  final _reads = <String, Set<String>>{};
  StreamSubscription<dynamic>? _subscription;
  Json snapshot = {};
  String? connectionError;
  int _sequence = 0;
  int _eventRevision = 0;

  Json get control => json(snapshot['control']);
  Json get transfer => json(snapshot['transfer']);
  Json get files => json(snapshot['files']);
  Json get backup => json(snapshot['backup']);

  Future<void> initialize() async {
    if (_subscription != null) return;
    _subscription = _events.receiveBroadcastStream().listen((Object? event) {
      _eventRevision++;
      _accept(event);
    }, onError: (Object error) {
      connectionError = failureMessage(error);
      notifyListeners();
    });
    final revision = _eventRevision;
    try {
      final initial = await invoke<Json>('initialize');
      if (revision == _eventRevision) _accept(initial);
    } catch (error) {
      connectionError = failureMessage(error);
      notifyListeners();
      rethrow;
    }
  }

  void _accept(Object? value) {
    if (value is! Map) {
      connectionError = 'Invalid platform snapshot';
    } else {
      snapshot = json(value);
      connectionError = null;
    }
    notifyListeners();
  }

  Future<T?> invoke<T>(String method, [Json arguments = const {}]) async {
    final value = await _methods.invokeMethod<Object?>(method, arguments);
    return _decode(value) as T?;
  }

  static Object? _decode(Object? value) {
    if (value is Map) {
      return value.map<String, dynamic>((key, item) {
        if (key is! String) {
          throw const FormatException('Invalid platform response key');
        }
        return MapEntry(key, _decode(item));
      });
    }
    if (value is List) return value.map(_decode).toList(growable: false);
    return value;
  }

  Future<Json> read(List<String> args, {String? owner}) async {
    final id = 'read-${++_sequence}';
    if (owner != null) (_reads[owner] ??= {}).add(id);
    try {
      final value = await invoke<Json>('read', {'id': id, 'args': args});
      if (value == null) throw const FormatException('Missing platform response');
      return value;
    } finally {
      if (owner != null) {
        final ids = _reads[owner];
        ids?.remove(id);
        if (ids?.isEmpty ?? false) _reads.remove(owner);
      }
    }
  }

  void cancelReads(String owner) {
    for (final id in _reads.remove(owner) ?? const <String>{}) {
      unawaited(invoke<void>('cancelRead', {'id': id}).catchError((Object error) {
        connectionError = failureMessage(error);
      }));
    }
  }

  Future<Json> submit(String label, List<String> args) async {
    final result = await invoke<Json>('submit', {'label': label, 'args': args});
    if (result == null) throw const FormatException('Missing operation result');
    return result;
  }

  @override
  void dispose() {
    unawaited(_subscription?.cancel());
    for (final owner in _reads.keys.toList()) {
      cancelReads(owner);
    }
    super.dispose();
  }
}
