import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/l10n/generated/app_localizations.dart';
import 'package:foxytail/main.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Native bridge, every destination, appearance and unavailable-root boundaries', (tester) async {
    final bridge = NativeBridge();
    final app = AppState(bridge: bridge);
    await tester.pumpWidget(FoxyTailApp(app: app));
    await app.initialize();
    await tester.pump(const Duration(seconds: 2));
    final originalTheme = app.theme, originalLanguage = app.language;
    for (final appearance in [('en', 'dark'), ('zh', 'light')]) {
      await app.setAppearance('language', appearance.$1);
      await app.setAppearance('theme', appearance.$2);
      await tester.pump(const Duration(milliseconds: 350));
      final native = await bridge.invoke<Json>('snapshot');
      expect(json(native?['appearance'])['language'], appearance.$1);
      expect(json(native?['appearance'])['theme'], appearance.$2);
      for (final destination in destinations) {
        app.navigate(destination);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 700));
        expect(app.destination, destination);
        expect(tester.takeException(), isNull, reason: '$destination ${appearance.$1}');
      }
      app.navigate('files');
      await tester.pump();
      app.navigate('more');
      await tester.pump(const Duration(milliseconds: 350));
      final l = AppLocalizations.of(tester.element(find.byType(Scaffold).first));
      final account = find.widgetWithText(ListTile, l.web_acc_title);
      await tester.ensureVisible(account);
      await tester.pump();
      expect(account.hitTestable(), findsOneWidget);
      await tester.tap(account);
      await tester.pump();
      expect(app.destination, 'account');
    }
    app.navigate('files');
    await tester.pump();
    app.navigate('more');
    await tester.pump();
    await bridge.invoke<void>('clearSources');
    await app.setAppearance('language', originalLanguage);
    await app.setAppearance('theme', originalTheme);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose(); bridge.dispose();
    await tester.pump();
  });
}
