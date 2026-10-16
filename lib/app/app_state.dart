import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:flutter/widgets.dart';

import 'platform_bridge.dart';

const destinations = <String>{
  'overview', 'peers', 'files', 'traffic', 'more', 'account', 'tunnel',
  'routing', 'settings', 'context', 'trial', 'serve', 'coexist', 'logs',
  'diagnostics', 'backup',
};

class AppState extends ChangeNotifier with WidgetsBindingObserver {
  AppState({NativeBridge? bridge}) : bridge = bridge ?? NativeBridge.instance {
    drafts = _Drafts(_saveChanged);
    this.bridge.addListener(_platformChanged);
    WidgetsBinding.instance.addObserver(this);
  }

  final NativeBridge bridge;
  late final Map<String, dynamic> drafts;
  final navigation = ValueNotifier<String>('overview');
  final appearance = ValueNotifier<({String theme, String language})>(
    (theme: 'auto', language: 'auto'),
  );
  final notices = ValueNotifier<String?>(null);
  final restoration = ValueNotifier<int>(0);
  final entries = ValueNotifier<int>(0);
  final _back = <String>[];
  String get destination => navigation.value;
  bool get canGoBack => _back.isNotEmpty || destination != 'overview';
  bool foreground = true;
  bool autoRefresh = true;
  bool powerSave = false;
  Json settings = {};
  String theme = 'auto';
  String language = 'auto';
  Json? status;
  Json? exitRouting;
  bool statusFresh = false;
  bool statusLoading = false;
  bool statusEverLoaded = false;
  String? statusError;
  int accountRevision = 0;
  int observationRevision = 0;
  int _nativeAccountRevision = -1;
  int _nativeObservationRevision = -1;
  int? _restoredNativeAccount;
  int _statusGeneration = 0;
  int _exitGeneration = 0;
  int _settingsGeneration = 0;
  Future<void>? _statusRead;
  Future<void>? _exitRead;
  Future<void>? _settingsRead;
  Timer? _poll;
  bool _disposed = false;
  bool _saveQueued = false;
  bool _restoring = false;
  String _entryId = '';
  String _lastSelf = '';

  bool get canWrite => boolean(bridge.control['canWrite']);
  bool get canStop => boolean(bridge.control['canStop']);
  bool get busy => boolean(bridge.control['busy']);
  bool get unknown => boolean(bridge.control['unknown']);

  Future<void> initialize() async {
    try {
      await bridge.initialize();
      _platformChanged();
      await refreshAvailability();
    } catch (error) {
      message(failureMessage(error));
    }
    if (_disposed) return;
    unawaited(refreshStatus());
    unawaited(refreshSettings());
    _schedulePoll();
  }

  void _platformChanged() {
    if (_disposed) return;
    final control = bridge.control;
    final account = number(control['accountRevision']).toInt();
    final observation = number(control['observationRevision']).toInt();
    if (control.isNotEmpty && _nativeAccountRevision != account) {
      final changed = _nativeAccountRevision >= 0;
      _nativeAccountRevision = account;
      if (_restoredNativeAccount != null && _restoredNativeAccount != account) {
        accountRevision++;
        _lastSelf = '';
        _clearIdentityDrafts();
      }
      _restoredNativeAccount = null;
      if (changed) invalidateAccountState();
    }
    if (_nativeObservationRevision != observation) {
      final changed = _nativeObservationRevision >= 0;
      _nativeObservationRevision = observation;
      if (changed) {
        observationRevision++;
        _invalidateStatus();
        _invalidateSettings();
        if (foreground && !busy) unawaited(refreshSettings());
        if (foreground) unawaited(refreshStatus());
      }
    }
    final next = json(bridge.snapshot['appearance']);
    theme = string(next['theme'], theme);
    language = string(next['language'], language);
    appearance.value = (theme: theme, language: language);
    final entry = json(bridge.snapshot['entry']);
    final id = string(entry['id']);
    if (id.isNotEmpty && id != _entryId) {
      _entryId = id;
      if (entry['section'] is String) drafts['files.section'] = entry['section'];
      navigate(string(entry['destination'], 'overview'));
      entries.value++;
      unawaited(bridge.invoke<void>('ackEntry', {'id': id}).catchError((Object error) {
        message(failureMessage(error));
      }));
    }
    notifyListeners();
  }

  Future<Json> read(List<String> args, {String? owner}) async {
    if (args.length == 1 && args.single == 'status') {
      await refreshStatus();
      if (!statusFresh || status == null) {
        throw StateError(statusError ?? 'Status is unconfirmed');
      }
      return status!;
    }
    return bridge.read(args, owner: owner);
  }

  Future<Json> submit(String label, List<String> args) => bridge.submit(label, args);

  Future<void> refreshAvailability() async {
    try {
      await bridge.invoke<void>('refreshAvailability');
    } catch (error) {
      message(failureMessage(error));
    }
  }

  Future<void> refreshStatus() {
    if (_disposed || !foreground) return Future<void>.value();
    if (_statusRead != null) return _statusRead!;
    final generation = _statusGeneration;
    final revision = observationRevision;
    final account = accountRevision;
    final completion = Completer<void>();
    _statusRead = completion.future;
    statusLoading = true;
    notifyListeners();
    completion.complete(_loadStatus(generation, revision, account));
    return completion.future;
  }

  Future<void> _loadStatus(int generation, int revision, int account) async {
    try {
      final value = await bridge.read(['status'], owner: 'app.status');
      if (!_currentStatus(generation, revision, account)) return;
      final oldIdentity = _observationIdentity(status);
      final previousSelf = _lastSelf;
      if (previousSelf.isNotEmpty && previousSelf != identityOf(value)) {
        accountRevision++;
        _invalidateExit();
        _clearIdentityDrafts();
      }
      _lastSelf = identityOf(value);
      status = value;
      statusFresh = true;
      statusError = null;
      statusEverLoaded = true;
      if (oldIdentity != _observationIdentity(value)) {
        if (oldIdentity != _observationIdentity(null)) observationRevision++;
        _invalidateExit();
      }
      if (destination == 'overview' || destination == 'peers') {
        unawaited(refreshExitRouting());
      }
    } catch (error) {
      if (!_currentStatus(generation, revision, account)) return;
      statusFresh = false;
      statusEverLoaded = true;
      statusError = failureMessage(error);
      _invalidateExit();
    } finally {
      if (generation == _statusGeneration) {
        statusLoading = false;
        _statusRead = null;
        if (!_disposed) notifyListeners();
      }
    }
  }

  bool _currentStatus(int generation, int revision, int account) =>
    !_disposed && foreground && generation == _statusGeneration &&
    revision == observationRevision && account == accountRevision;

  static String identityOf(Json? value) {
    final self = json(value?['self']);
    return string(self['id'], string(value?['selfId']));
  }

  static String _observationIdentity(Json? value) =>
    '${identityOf(value)}|${value?['mode']}|${json(value?['exitNode'])['id']}|${value?['daemon']}|${value?['backend']}';

  Future<void> refreshExitRouting() {
    if (_disposed || !foreground || !statusFresh || identityOf(status).isEmpty) {
      return Future<void>.value();
    }
    if (_exitRead != null) return _exitRead!;
    final work = _loadExit(_exitGeneration, observationRevision, _observationIdentity(status));
    _exitRead = work;
    return work;
  }

  Future<void> _loadExit(int generation, int revision, String identity) async {
    try {
      final result = await bridge.read(['exit-routing'], owner: 'app.exit');
      if (_disposed || !foreground || generation != _exitGeneration ||
          revision != observationRevision || identity != _observationIdentity(status)) return;
      exitRouting = result['selfId'] == identityOf(status) && result['exitRouting'] is Map
          ? json(result['exitRouting']) : null;
    } catch (_) {
      // A deep probe failure cannot replace the lightweight service observation.
      if (generation == _exitGeneration) exitRouting = null;
    } finally {
      if (generation == _exitGeneration) {
        _exitRead = null;
        if (!_disposed) notifyListeners();
      }
    }
  }

  Future<void> refreshSettings() {
    if (_disposed || !foreground) return Future<void>.value();
    if (_settingsRead != null) return _settingsRead!;
    final work = _loadSettings(_settingsGeneration);
    _settingsRead = work;
    return work;
  }

  Future<void> _loadSettings(int generation) async {
    try {
      final response = await bridge.read(['settings-get'], owner: 'app.settings');
      if (_disposed || generation != _settingsGeneration) return;
      final previousPowerSave = powerSave;
      settings = json(response['settings']);
      if (const ['on', 'off'].contains(settings['WEBUI_AUTO_REFRESH'])) {
        autoRefresh = settings['WEBUI_AUTO_REFRESH'] == 'on';
      }
      if (const ['on', 'off'].contains(settings['POWER_SAVE'])) {
        powerSave = settings['POWER_SAVE'] == 'on';
      }
      if (previousPowerSave != powerSave || !(_poll?.isActive ?? false)) _schedulePoll();
    } catch (_) {
      // The settings page reports its read error; defaults do not assert backend state.
    } finally {
      if (generation == _settingsGeneration) {
        _settingsRead = null;
        if (!_disposed) notifyListeners();
      }
    }
  }

  void _invalidateSettings() {
    _settingsGeneration++;
    _settingsRead = null;
    bridge.cancelReads('app.settings');
  }

  void _invalidateExit() {
    _exitGeneration++;
    _exitRead = null;
    exitRouting = null;
    bridge.cancelReads('app.exit');
  }

  void _invalidateStatus() {
    _statusGeneration++;
    _statusRead = null;
    statusLoading = false;
    statusFresh = false;
    bridge.cancelReads('app.status');
    _invalidateExit();
  }

  void invalidateAccountState() {
    accountRevision++;
    observationRevision++;
    _invalidateStatus();
    _invalidateSettings();
    _lastSelf = '';
    status = null;
    statusEverLoaded = false;
    statusError = null;
    _clearIdentityDrafts();
    notifyListeners();
    if (foreground) unawaited(refreshStatus());
  }

  void _clearIdentityDrafts() {
    drafts.removeWhere((key, value) => key.startsWith('peers.') ||
      key.startsWith('coexist.') || key.startsWith('network.'));
    if (drafts['files'] is Map) {
      drafts['files'] = {...json(drafts['files']), 'peer': null, 'account': accountRevision};
    }
    final times = json(bridge.control['resultTimes']);
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final command in const ['diag', 'diag-check']) {
      for (final suffix in const ['result', 'confirmed', 'task']) {
        drafts.remove('diagnostics.$command.$suffix');
      }
      final retained = number(times[command]).toInt() + 1;
      drafts['diagnostics.$command.started'] = now > retained ? now : retained;
    }
  }

  Future<void> setAppearance(String key, String value) async {
    await bridge.invoke<void>('appearance', {'key': key, 'value': value});
    if (key == 'theme') theme = value;
    if (key == 'language') language = value;
    appearance.value = (theme: theme, language: language);
    notifyListeners();
  }

  void navigate(String next) {
    if (!destinations.contains(next)) next = 'overview';
    if (next == destination) return;
    if (const ['overview', 'peers', 'files', 'traffic', 'more'].contains(next)) {
      _back.clear();
    } else {
      _back.add(destination);
    }
    navigation.value = next;
    _saveChanged();
    notifyListeners();
    if (next == 'overview' || next == 'peers') {
      unawaited(refreshStatus());
    }
  }

  void goBack() {
    navigation.value = _back.isEmpty ? 'overview' : _back.removeLast();
    _saveChanged();
    notifyListeners();
  }

  void message(String value) {
    if (_disposed) return;
    notices.value = null;
    if (value.isNotEmpty) notices.value = value;
  }

  void _schedulePoll() {
    _poll?.cancel();
    if (_disposed || !foreground) return;
    _poll = Timer(Duration(seconds: powerSave ? 30 : 15), () {
      if (autoRefresh) unawaited(refreshStatus());
      _schedulePoll();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    foreground = state == AppLifecycleState.resumed;
    if (foreground) {
      unawaited(refreshAvailability());
      unawaited(refreshStatus());
      unawaited(refreshSettings());
      _schedulePoll();
    } else {
      _poll?.cancel();
      _invalidateStatus();
      _invalidateSettings();
      _saveChanged();
    }
    notifyListeners();
  }

  void _saveChanged() {
    if (_saveQueued || _restoring || _disposed) return;
    _saveQueued = true;
    scheduleMicrotask(() {
      _saveQueued = false;
      if (!_disposed) restoration.value++;
    });
  }

  String saveState() => jsonEncode({
    'destination': destination, 'back': _back, 'drafts': drafts,
    'accountRevision': _nativeAccountRevision, 'accountGeneration': accountRevision, 'selfId': _lastSelf,
  });

  void restoreState(String? encoded) {
    if (encoded == null) return;
    try {
      final saved = json(jsonDecode(encoded));
      _restoring = true;
      drafts.clear();
      drafts.addAll(json(saved['drafts']));
      accountRevision = number(saved['accountGeneration']).toInt();
      _lastSelf = string(saved['selfId']);
      _back.clear();
      final history = saved['back'];
      if (history is List) _back.addAll(history.whereType<String>().where(destinations.contains));
      if (_entryId.isEmpty) {
        final route = string(saved['destination'], 'overview');
        navigation.value = destinations.contains(route) ? route : 'overview';
      }
      _restoredNativeAccount = number(saved['accountRevision'], -1).toInt();
      if (_nativeAccountRevision >= 0 && _restoredNativeAccount != _nativeAccountRevision) {
        accountRevision++;
        _lastSelf = '';
        _clearIdentityDrafts();
        _restoredNativeAccount = null;
      }
    } on FormatException {
      // An unreadable system restoration bundle is not a persisted module state.
    } finally {
      _restoring = false;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _poll?.cancel();
    _invalidateStatus();
    bridge.cancelReads('app.settings');
    bridge.removeListener(_platformChanged);
    WidgetsBinding.instance.removeObserver(this);
    navigation.dispose();
    appearance.dispose();
    notices.dispose();
    restoration.dispose();
    entries.dispose();
    super.dispose();
  }
}

class _Drafts extends MapBase<String, dynamic> {
  _Drafts(this.changed);
  final VoidCallback changed;
  final _values = <String, dynamic>{};
  @override
  dynamic operator [](Object? key) => _values[key];
  @override
  void operator []=(String key, dynamic value) { _values[key] = value; changed(); }
  @override
  void clear() { if (_values.isNotEmpty) { _values.clear(); changed(); } }
  @override
  Iterable<String> get keys => _values.keys;
  @override
  dynamic remove(Object? key) {
    final existed = _values.containsKey(key);
    final value = _values.remove(key);
    if (existed) changed();
    return value;
  }
}
