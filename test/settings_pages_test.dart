import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/features/settings/backup_page.dart';
import 'package:foxytail/features/settings/context_page.dart';
import 'package:foxytail/features/settings/routing_page.dart';
import 'package:foxytail/features/settings/settings_page.dart';
import 'package:foxytail/l10n/generated/app_localizations.dart';

class ConfigFixture extends AppState {
  ConfigFixture() { autoRefresh = false; }
  String rules = '# retained\r\ncellular:-:up\r\n';
  bool statusFails = false;
  final reads = <String>[];
  @override bool get canWrite => true;
  @override bool get busy => false;
  @override bool get unknown => false;
  @override Future<void> refreshSettings() async {}
  @override Future<Json> read(List<String> args, {String? owner}) async {
    reads.add(args.first);
    switch (args.first) {
      case 'context-get': return {'rules': rules};
      case 'context-status':
        if (statusFails) throw StateError('live unavailable');
        return {'status': {'running': true, 'context': 'ssid:Home'}};
      case 'settings-get': return {'restartRequired': false, 'settings': {
        for (final key in ['MAGIC_DNS', 'IPV6', 'POWER_SAVE', 'WATCHDOG', 'WATCHDOG_PROBE', 'STATS', 'CONTEXT', 'WEBUI_AUTO_REFRESH']) key: 'off',
        'DNS_MODE': 'legacy', 'SOCKS_PORT': '1055', 'DNS_PORT': '1053', 'WATCHDOG_INTERVAL': '30', 'STATS_INTERVAL': '60', 'LOG_MAX_KB': '1024',
        'ROUTE_TABLE': '1052', 'FWMARK': '0x80000', 'FWMARK_MASK': '0xff0000',
      }};
      case 'dns': return {'transparentAvailable': true};
      case 'status': return {'mode': 'bridge', 'powerSave': false};
      case 'hooks-get': return {'hooks': <Object?>[]};
      case 'trial-status': return {'trial': null};
      case 'routes-get': return {'scope': 'selected', 'uids': [10001], 'subnets': ['10.0.0.0/8']};
      case 'owner-capability': return {'available': true};
      case 'subnet-routes-get': return {'acceptRoutes': false, 'ipv6Enabled': true, 'mode': 'bridge', 'peers': <Object?>[]};
      case 'apps': return {'apps': [
        {'label': 'Alpha', 'package': 'com.alpha', 'uid': 10001},
        {'label': 'Beta', 'package': 'com.beta', 'uid': 10001},
        for (var i = 0; i < 201; i++) {'label': 'Item $i', 'package': 'com.item$i', 'uid': 11000 + i},
      ]};
      case 'backup-list': return {'backups': [{'path': '/sdcard/Download/foxytail-backup-test.tar.gz', 'name': 'test.tar.gz', 'size': 30, 'mtime': 1}]};
      case 'restore-preview': return {'path': args[1], 'sha256': 'a' * 64, 'baselineSha256': 'b' * 64, 'changes': <Object?>[], 'hooks': <Object?>[]};
      default: throw StateError('Unexpected read ${args.first}');
    }
  }
  void configChanged() { settings = {'DNS_MODE': 'local'}; notifyListeners(); }
}

Widget host(Widget child) => MaterialApp(locale: const Locale('en'), localizationsDelegates: AppLocalizations.localizationsDelegates, supportedLocales: AppLocalizations.supportedLocales, home: Scaffold(body: child));

void main() {
  testWidgets('visual editor has an explicit draft boundary and preserves CRLF comments', (tester) async {
    final app = ConfigFixture();
    await tester.pumpWidget(host(ContextPage(app: app)));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Add rule'));
    await tester.tap(find.text('Add rule'));
    await tester.pumpAndSettle();
    final ssid = find.byWidgetPredicate((widget) => widget is TextField && widget.decoration?.labelText == 'SSID');
    await tester.ensureVisible(ssid);
    await tester.enterText(ssid, 'Office');
    final save = tester.widget<FilledButton>(find.ancestor(of: find.text('Save'), matching: find.byWidgetPredicate((widget) => widget is FilledButton)).last);
    expect(save.onPressed, isNull);
    expect(app.drafts['context.raw'], app.rules);
    await tester.ensureVisible(find.text('Update draft'));
    await tester.tap(find.text('Update draft'));
    await tester.pumpAndSettle();
    expect(app.drafts['context.raw'], '# retained\r\ncellular:-:up\r\nssid:Office:up\r\n');
    expect(app.drafts.containsKey('context.editing'), isFalse);
    expect(tester.widget<FilledButton>(find.ancestor(of: find.text('Save'), matching: find.byWidgetPredicate((widget) => widget is FilledButton)).last).onPressed, isNotNull);
    await tester.pumpWidget(const SizedBox()); app.dispose();
  });
  testWidgets('live status failure and external rules cannot erase context edit', (tester) async {
    final app = ConfigFixture();
    app.drafts['context.textMode'] = true;
    await tester.pumpWidget(host(ContextPage(app: app)));
    await tester.pumpAndSettle();
    final raw = find.byWidgetPredicate((widget) => widget is TextField && widget.decoration?.labelText == 'Network context rules');
    const edited = '# retained\r\nssid:Office:down\r\n';
    await tester.enterText(raw, edited);
    app.statusFails = true; app.rules = 'cellular:-:down\n';
    await tester.tap(find.byTooltip('Refresh execution status'));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(raw).controller!.text, edited);
    expect(tester.widget<TextField>(raw).enabled, isTrue);
    expect(app.drafts['context.raw.baseline'], '# retained\r\ncellular:-:up\r\n');
    expect(find.textContaining('saving will overwrite'), findsOneWidget);
    await tester.pumpWidget(const SizedBox()); app.dispose();
  });
  testWidgets('advanced settings lazily construct and retain context draft on reopen', (tester) async {
    final app = ConfigFixture();
    await tester.pumpWidget(host(SettingsPage(app: app)));
    await tester.pumpAndSettle();
    expect(find.byType(ContextPage), findsNothing);
    expect(app.reads.where((read) => read == 'context-get'), isEmpty);
    await tester.ensureVisible(find.text('Advanced options'));
    await tester.tap(find.text('Advanced options'));
    await tester.pumpAndSettle();
    expect(find.byType(ContextPage), findsOneWidget);
    app.drafts['context.raw'] = '# edited\r\nssid:Office:up\r\n';
    await tester.ensureVisible(find.text('Advanced options'));
    await tester.tap(find.text('Advanced options'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Advanced options'));
    await tester.pumpAndSettle();
    expect(app.drafts['context.raw'], '# edited\r\nssid:Office:up\r\n');
    expect(find.byType(ContextPage), findsOneWidget);
    await tester.pumpWidget(const SizedBox()); app.dispose();
  });
  testWidgets('configuration change expires restore preview without issuing restore', (tester) async {
    final app = ConfigFixture();
    app.drafts['backup.selected'] = '/sdcard/Download/foxytail-backup-test.tar.gz';
    await tester.pumpWidget(host(BackupPage(app: app)));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Preview restore changes'));
    await tester.tap(find.text('Preview restore changes'));
    await tester.pumpAndSettle();
    expect(find.text('No configuration changes'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Restore config'), findsOneWidget);
    app.configChanged();
    await tester.pumpAndSettle();
    expect(find.text('No configuration changes'), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Restore config'), findsNothing);
    await tester.pumpWidget(const SizedBox()); app.dispose();
  });
  testWidgets('shared numeric UID toggles all packages and paging survives filtering', (tester) async {
    final app = ConfigFixture();
    await tester.pumpWidget(host(RoutingPage(app: app)));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Alpha'));
    expect(tester.widget<CheckboxListTile>(find.widgetWithText(CheckboxListTile, 'Alpha')).value, isTrue);
    expect(tester.widget<CheckboxListTile>(find.widgetWithText(CheckboxListTile, 'Beta')).value, isTrue);
    await tester.tap(find.text('Alpha'));
    await tester.pumpAndSettle();
    expect(tester.widget<CheckboxListTile>(find.widgetWithText(CheckboxListTile, 'Beta')).value, isFalse);
    final search = find.byWidgetPredicate((widget) => widget is TextField && widget.decoration?.labelText == 'Search app, package or UID');
    await tester.ensureVisible(search);
    await tester.enterText(search, '10001');
    await tester.pumpAndSettle();
    expect(find.byType(CheckboxListTile), findsNWidgets(2));
    await tester.enterText(search, '');
    await tester.pumpAndSettle();
    expect(find.byTooltip('Show more apps (103)'), findsOneWidget);
    await tester.ensureVisible(find.byTooltip('Show more apps (103)'));
    await tester.tap(find.byTooltip('Show more apps (103)'));
    await tester.pumpAndSettle();
    expect(find.byTooltip('Show more apps (3)'), findsOneWidget);
    expect(app.drafts['routing.rules'], contains('selected'));
    await tester.pumpWidget(const SizedBox()); app.dispose();
  });
}
