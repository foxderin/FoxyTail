import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/features/network/peers_page.dart';
import 'package:foxytail/l10n/generated/app_localizations.dart';

// Controlled UI fixture only: does not prove real root or Tailnet behavior.
class PeerFixture extends AppState {
  PeerFixture(int count) : super(bridge: NativeBridge()) {
    autoRefresh = false;
    statusFresh = true;
    exitRouting = {'known': true, 'selected': null};
    status = {
      'self': {'id': 'self', 'hostname': 'This device'},
      'peerList': [
        for (var i = 0; i < count; i++) {
          'id': '$i',
          'hostname': 'device-${i.toString().padLeft(3, '0')}',
          'online': i != count - 1,
          'os': 'linux',
          'ips': ['100.64.0.${i + 1}'],
          'curAddr': '192.0.2.1:41641',
        },
      ],
    };
  }

  final probes = <Completer<Json>>[];
  @override bool get canWrite => true;
  @override bool get busy => false;
  @override bool get unknown => false;
  @override Future<void> refreshAvailability() async {}
  @override Future<void> refreshSettings() async {}
  @override Future<void> refreshStatus() async {
    statusFresh = true;
    notifyListeners();
  }
  @override Future<Json> submit(String label, List<String> args) {
    if (args.first != 'peer-ping') throw StateError('Unexpected command: $args');
    final response = Completer<Json>();
    probes.add(response);
    return response.future;
  }
  @override void dispose() {
    super.dispose();
    bridge.dispose();
  }
}

Widget host(Widget child) => MaterialApp(
  locale: const Locale('en'),
  localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales,
  home: Scaffold(body: child),
);

Finder peerRows() => find.byWidgetPredicate((widget) => widget is ListTile &&
    widget.key is ValueKey<String> &&
    (widget.key! as ValueKey<String>).value.startsWith('peer-'));

void main() {
  for (final topology in [false, true]) {
    testWidgets('${topology ? 'topology' : 'peer'} list lazily reaches every peer and retains search and details', (tester) async {
      await tester.binding.setSurfaceSize(const Size(900, 1100));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final app = PeerFixture(150);
      app.drafts['network.peerTab'] = topology ? 1 : 0;
      await tester.pumpWidget(host(PeersPage(app: app)));
      await tester.pumpAndSettle();
      final scrollable = find.byType(Scrollable).first;
      final last = find.byKey(const ValueKey('peer-149-device-149'));
      if (topology) {
        expect(find.byType(ActionChip), findsNWidgets(12));
        expect(peerRows(), findsNothing);
        final expand = find.byType(ExpansionTile);
        await tester.ensureVisible(expand);
        await tester.tap(expand);
        await tester.pumpAndSettle();
      }
      expect(peerRows().evaluate().length, lessThan(30));
      expect(last, findsNothing);
      await tester.scrollUntilVisible(last, 600, scrollable: scrollable, maxScrolls: 100);
      await tester.pumpAndSettle();
      expect(peerRows().evaluate().length, lessThan(30));
      await tester.tap(last);
      await tester.pumpAndSettle();
      expect(find.text('100.64.0.150'), findsOneWidget);
      await tester.tap(find.byTooltip('Close'));
      await tester.pumpAndSettle();

      final search = find.byType(TextField);
      await tester.scrollUntilVisible(search, -600, scrollable: scrollable, maxScrolls: 100);
      await tester.enterText(search, '100.64.0.150');
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(last, 300, scrollable: scrollable);
      expect(peerRows(), findsOneWidget);
      await tester.ensureVisible(find.widgetWithText(ChoiceChip, 'Online'));
      await tester.tap(find.widgetWithText(ChoiceChip, 'Online'));
      await tester.pumpAndSettle();
      expect(peerRows(), findsNothing);
      await tester.tap(find.widgetWithText(ChoiceChip, 'Offline'));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(last, 300, scrollable: scrollable);
      expect(peerRows(), findsOneWidget);
      await tester.tap(last);
      await tester.pumpAndSettle();
      expect(find.descendant(of: find.byType(BottomSheet), matching: find.text('100.64.0.150')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    });
  }

  testWidgets('foreground boundary clears a pending peer probe and rejects its old response', (tester) async {
    final app = PeerFixture(1);
    await tester.pumpWidget(host(PeersPage(app: app)));
    await tester.pumpAndSettle();
    final peer = find.byKey(const ValueKey('peer-0-device-000'));
    await tester.scrollUntilVisible(peer, 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(peer);
    await tester.pumpAndSettle();
    final probe = find.text('Test connection IPv4');
    await tester.ensureVisible(probe);
    await tester.tap(probe);
    await tester.pump();
    expect(app.probes, hasLength(1));
    expect(find.byType(LinearProgressIndicator), findsOneWidget);

    app.didChangeAppLifecycleState(AppLifecycleState.paused);
    await tester.pump();
    expect(find.byType(LinearProgressIndicator), findsNothing);
    app.didChangeAppLifecycleState(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    app.probes.first.complete({
      'ok': true, 'peerId': '0', 'ip': '100.64.0.1',
      'latencyMs': 987, 'path': 'direct', 'via': 'old-route',
    });
    await tester.pumpAndSettle();
    expect(find.textContaining('old-route'), findsNothing);
    await tester.ensureVisible(probe);
    await tester.tap(probe);
    await tester.pump();
    expect(app.probes, hasLength(2));
    app.probes.last.complete({
      'ok': true, 'peerId': '0', 'ip': '100.64.0.1',
      'latencyMs': 4, 'path': 'direct', 'via': 'current-route',
    });
    await tester.pumpAndSettle();
    expect(find.textContaining('4 ms current-route'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
