import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/widgets.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('dev.foxderin.tail/control');
  const events = MethodChannel('dev.foxderin.tail/events');
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late NativeBridge bridge;
  late AppState app;
  late List<Completer<Json>> status;
  late List<Completer<Json>> exit;

  Json light(String id, {String mode = 'bridge'}) => {
    'ok': true, 'daemon': 'running', 'backend': 'Running', 'mode': mode,
    'self': {'id': id},
  };

  setUp(() async {
    status = []; exit = [];
    messenger.setMockMethodCallHandler(events, (_) async => null);
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'initialize') {
        return {'control': {'accountRevision': 8, 'observationRevision': 0},
          'appearance': {'theme': 'auto', 'language': 'auto'}};
      }
      if (call.method == 'read') {
        final args = json(call.arguments)['args'] as List;
        final request = Completer<Json>();
        if (args[0] == 'status') status.add(request);
        else if (args[0] == 'exit-routing') exit.add(request);
        else return {'settings': <String, dynamic>{}};
        return request.future;
      }
      return null;
    });
    bridge = NativeBridge();
    app = AppState(bridge: bridge);
    await bridge.initialize();
  });
  tearDown(() async {
    app.dispose(); bridge.dispose();
    for (final pending in [...status, ...exit]) {
      if (!pending.isCompleted) pending.complete({});
    }
    await Future<void>.delayed(Duration.zero);
    messenger.setMockMethodCallHandler(channel, null);
    messenger.setMockMethodCallHandler(events, null);
  });

  test('Synchronous loading listeners join the published in-flight read', () async {
    Future<void>? nested;
    void listener() {
      if (app.statusLoading) nested ??= app.refreshStatus();
    }
    app.addListener(listener);
    final read = app.refreshStatus();
    await Future<void>.delayed(Duration.zero);
    expect(status.length, 1);
    status.single.complete(light('self'));
    await Future.wait([read, nested!]);
    expect(app.statusFresh, isTrue);
    app.removeListener(listener);
  });

  test('Account transition fences an old read without delaying the new account', () async {
    final before = app.refreshStatus();
    final duplicate = app.refreshStatus();
    await Future<void>.delayed(Duration.zero);
    expect(status.length, 1);
    app.invalidateAccountState();
    final current = app.refreshStatus();
    await Future<void>.delayed(Duration.zero);
    expect(status.length, 2);
    status[1].complete(light('new-account'));
    await current;
    status[0].complete(light('old-account'));
    await Future.wait([before, duplicate]);
    expect(AppState.identityOf(app.status), 'new-account');
    expect(app.statusFresh, isTrue);
  });

  test('Deep mismatched result never overwrites light status; external identity clears artifacts', () async {
    var pending = app.refreshStatus();
    await Future<void>.delayed(Duration.zero);
    status[0].complete(light('first'));
    await pending;
    await Future<void>.delayed(Duration.zero);
    exit[0].complete({'selfId': 'different', 'exitRouting': {'effective': 'selected'}});
    await Future<void>.delayed(Duration.zero);
    expect(app.exitRouting, isNull);
    expect(app.statusFresh, isTrue);
    app.drafts['diagnostics.diag.result'] = {'ok': true, 'artifactId': 'old'};
    final revision = app.observationRevision;
    pending = app.refreshStatus();
    await Future<void>.delayed(Duration.zero);
    status[1].complete(light('first', mode: 'tun'));
    await pending;
    expect(app.observationRevision, greaterThan(revision));
    final account = app.accountRevision;
    pending = app.refreshStatus();
    await Future<void>.delayed(Duration.zero);
    status[2].complete(light('second'));
    await pending;
    expect(app.accountRevision, greaterThan(account));
    expect(app.drafts['diagnostics.diag.result'], isNull);
    expect(app.statusFresh, isTrue);
    expect(AppState.identityOf(app.status), 'second');
  });

  test('Restoration keeps drafts before native readiness and removes mismatched identity data', () {
    final other = NativeBridge();
    final restored = AppState(bridge: other);
    app.drafts['settings.value'] = 'unsaved';
    app.drafts['peers.filter'] = 'private';
    app.accountRevision = 4;
    app.drafts['files'] = {'peer': 'chosen-peer', 'account': app.accountRevision, 'sort': 2};
    restored.restoreState(app.saveState());
    expect(restored.drafts['settings.value'], 'unsaved');
    expect(restored.drafts['peers.filter'], 'private');
    expect(restored.accountRevision, 4);
    expect(json(restored.drafts['files'])['peer'], 'chosen-peer');
    restored.invalidateAccountState();
    expect(restored.drafts['settings.value'], 'unsaved');
    expect(restored.drafts['peers.filter'], isNull);
    expect(json(restored.drafts['files'])['peer'], isNull);
    expect(json(restored.drafts['files'])['sort'], 2);
    restored.dispose(); other.dispose();
  });

  test('Late settings from a prior lifecycle cannot replace fresh settings', () async {
    final settings = <Completer<Json>>[];
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'read') {
        if ((json(call.arguments)['args'] as List).first == 'settings-get') {
          final pending = Completer<Json>();
          settings.add(pending);
          return pending.future;
        }
        return light('self');
      }
      return null;
    });
    final old = app.refreshSettings();
    await Future<void>.delayed(Duration.zero);
    app.didChangeAppLifecycleState(AppLifecycleState.paused);
    app.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await Future<void>.delayed(Duration.zero);
    settings[1].complete({'settings': {'POWER_SAVE': 'on', 'WEBUI_AUTO_REFRESH': 'off'}});
    await Future<void>.delayed(Duration.zero);
    settings[0].complete({'settings': {'POWER_SAVE': 'off', 'WEBUI_AUTO_REFRESH': 'on'}});
    await old;
    expect(app.powerSave, isTrue);
    expect(app.autoRefresh, isFalse);
  });

  testWidgets('Frequent settings refresh cannot starve shared status polling', (tester) async {
    var reads = 0;
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'read') {
        if ((json(call.arguments)['args'] as List).first == 'status') {
          reads++;
          return light('self');
        }
        return {'settings': {'POWER_SAVE': 'off', 'WEBUI_AUTO_REFRESH': 'on'}};
      }
      return null;
    });
    unawaited(app.refreshSettings());
    await tester.pump();
    await tester.pump(const Duration(seconds: 10));
    unawaited(app.refreshSettings());
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(reads, 1);
    expect(app.statusFresh, isTrue);
    app.didChangeAppLifecycleState(AppLifecycleState.paused);
    await tester.pump(const Duration(seconds: 30));
    expect(reads, 1);
  });
}
