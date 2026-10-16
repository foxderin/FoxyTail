import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/main.dart';

class _ReadOnlyFixture extends AppState {
  _ReadOnlyFixture() : super(bridge: NativeBridge()) { autoRefresh = false; }
  @override Future<void> refreshStatus() async {}
  @override Future<Json> read(List<String> args, {String? owner}) async => switch (args.first) {
    'files-inbox' => {'files': <Object?>[], 'ignored': 0},
    'taildrop-targets' => {'peers': <Object?>[]},
    'file-send-history' => {'transfers': <Object?>[]},
    'compat' => {'warnings': <Object?>[]},
    _ => throw StateError('Unexpected read: $args'),
  };
}

void main() {
  testWidgets('visiting retained Files cannot collapse subsequent pages or swallow actions', (tester) async {
    final app = _ReadOnlyFixture();
    await tester.pumpWidget(FoxyTailApp(app: app));
    await tester.pumpAndSettle();
    app.navigate('files');
    await tester.pumpAndSettle();
    app.navigate('more');
    await tester.pumpAndSettle();
    final account = find.widgetWithText(ListTile, 'Account');
    await tester.ensureVisible(account);
    await tester.pumpAndSettle();
    expect(tester.getRect(account).height, greaterThan(40));
    expect(account.hitTestable(), findsOneWidget);
    await tester.tap(account);
    await tester.pumpAndSettle();
    expect(app.destination, 'account');
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose(); app.bridge.dispose();
  });
}
