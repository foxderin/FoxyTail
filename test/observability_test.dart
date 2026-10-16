import 'dart:ui' show SemanticsAction;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/features/observability/observation_page.dart';
import 'package:foxytail/features/observability/logs_page.dart';
import 'package:foxytail/features/observability/observability_data.dart';
import 'package:foxytail/features/observability/traffic_chart.dart';
import 'package:foxytail/l10n/generated/app_localizations.dart';

Widget host(Widget child) => MaterialApp(localizationsDelegates: AppLocalizations.localizationsDelegates,
  supportedLocales: AppLocalizations.supportedLocales, home: Scaffold(body: child));

void main() {
  test('Traffic preserves missing intervals, recorded idle, and legacy counters', () {
    final summary = <String, dynamic>{'hours': [
      {'hour': 0, 'samples': 0, 'iface': {'rx': 99, 'tx': 99}},
      {'hour': 1, 'samples': 1, 'iface': {'rx': 0, 'tx': 0}},
      {'hour': 2, 'iface': {'rx': 0, 'tx': 0}},
      {'hour': 3, 'iface': {'rx': 1, 'tx': 2}},
    ], 'days': [{'date': '2026-10-09', 'samples': 1, 'rx': 0, 'tx': 0}]};
    final hours = trafficSamples(summary, false);
    expect(hours[0].rx, isNull);
    expect(hours[1].rx, 0);
    expect(hours[2].rx, isNull);
    expect(hours[3].tx, 2);
    expect(trafficSamples(summary, true).single.label, '2026-10-09');
    expect(trafficSamples(summary, true).single.rx, 0);
    expect(selectedTrafficIndex(hours, '01:00'), 1);
    expect(selectedTrafficIndex(hours, null), 3);
    expect(selectedTrafficIndex([], null), -1);
    expect(trafficBytes(double.nan), 0);
    expect(trafficBytes(double.infinity), 0);
    expect(trafficBytes(-1), 0);
    expect(() => trafficSamples({'hours': [null]}, false), throwsFormatException);
  });

  test('Logs copy every original matching line without escaping or truncation', () {
    final lines = List.generate(1000, (i) => '${i.isEven ? 'Alpha' : 'alpha'} $i ${'long log text ' * 12}');
    final snapshot = LogSnapshot(lines);
    expect(LogSnapshot.copy(snapshot.filter('', false)), lines.join('\n'));
    final filtered = snapshot.filter('Alpha', true);
    expect(filtered.length, 500);
    expect(filtered[1].number, 3);
    expect(LogSnapshot.copy(filtered), lines.where((row) => row.startsWith('Alpha')).join('\n'));
    expect(snapshot.filter('Alpha', false).length, 1000);
    expect(snapshot.filter('not present', false), isEmpty);
    expect(snapshot.same(List.of(lines)), isTrue);
    expect(snapshot.same([...lines, 'new']), isFalse);
    final special = LogSnapshot(['', 'raw\tline\u001b[31m', '中文\u0000\u0085']);
    expect(special.records[0].display, ' ');
    expect(special.records[1].display, r'raw' '\t' r'line\u001b[31m');
    expect(special.records[2].display, r'中文\u0000\u0085');
    expect(LogSnapshot.copy(special.filter('', false)), '\nraw\tline\u001b[31m\n中文\u0000\u0085');
  });

  test('New or unknown diagnostics never resurrect old success or artifacts', () {
    final pass = <String, dynamic>{'ok': true};
    final failed = <String, dynamic>{'ok': false, 'error': 'latest failure'};
    expect(currentDiagnosticResult(running: false, started: 0, resultTime: 20, latest: failed, stored: pass), same(failed));
    expect(currentDiagnosticResult(running: true, started: 21, resultTime: 20, latest: pass, stored: pass), isNull);
    expect(currentDiagnosticResult(running: false, started: 21, resultTime: 20, latest: pass, stored: pass), isNull);
    expect(currentDiagnosticResult(running: false, started: 21, resultTime: 22, latest: failed, stored: pass), same(failed));
    expect(currentDiagnosticResult(running: false, started: 0, resultTime: 0, stored: failed), same(failed));
    final bundle = <String, dynamic>{'ok': true, 'artifactId': 'art-0123456789abcdef0123456789abcdef', 'mode': 'share', 'path': '/data/adb/foxytail/diagnostics/report.tar.gz'};
    expect(validDiagnosticBundle(bundle), isTrue);
    expect(validDiagnosticBundle({...bundle, 'path': '/tmp/report\n.tar.gz'}), isFalse);
    expect(validDiagnosticBundle({...bundle, 'artifactId': '/tmp/report.tar.gz'}), isFalse);
    expect(validDiagnosticBundle({...bundle, 'ok': false}), isFalse);
    expect(validDiagnosticBundle({...bundle, 'mode': 'unknown'}), isFalse);
    expect(currentDiagnosticResult(running: true, started: 21, resultTime: 20, latest: bundle, stored: bundle), isNull);
    expect(validDiagnosticChecks({'ok': true, 'checks': [{'id': 'dns', 'reason': 'dns_ready', 'level': 'pass', 'page': 'tunnel'}]}), isTrue);
    expect(validDiagnosticChecks({'ok': true, 'checks': [{'id': 'dns', 'reason': 'dns_ready', 'level': 'pass', 'page': 'untrusted'}]}), isFalse);
  });

  testWidgets('Chart keyboard and accessibility traverse actual gaps and retain selection', (tester) async {
    final handle = tester.ensureSemantics();
    final samples = [const TrafficSample('00:00', 0, 0), const TrafficSample('01:00', null, null), const TrafficSample('02:00', 2048, 1024)];
    var selected = 0;
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    await tester.pumpWidget(host(StatefulBuilder(builder: (context, setState) => SingleChildScrollView(
      controller: scroll,
      child: Column(children: [SizedBox(width: 360,
        child: TrafficChart(samples: samples, selected: selected, onSelected: (value) => setState(() => selected = value))),
        const SizedBox(height: 1000),
      ]),
    ))));
    final chartContext = tester.element(find.byType(TrafficChart));
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump();
    expect(selected, 1);
    final semantics = tester.getSemantics(find.bySemanticsLabel(AppLocalizations.of(chartContext).web_net_traffic_chart));
    expect(semantics.getSemanticsData().value, contains(AppLocalizations.of(chartContext).web_net_traffic_unrecorded));
    tester.renderObject(find.byType(TrafficChart)).owner!.semanticsOwner!.performAction(semantics.id, SemanticsAction.increase);
    await tester.pump();
    expect(selected, 2);
    await tester.drag(find.byType(TrafficChart), const Offset(0, -90));
    await tester.pump();
    expect(selected, 2);
    expect(scroll.offset, greaterThan(0));
    await tester.pumpWidget(const SizedBox.shrink());
    handle.dispose();
  });

  testWidgets('Log viewer virtualizes, preserves unchanged scroll, follows and unwraps', (tester) async {
    final records = LogSnapshot(List.generate(1000, (i) => 'Line $i ${'long log text ' * 12}')).records;
    var wrap = true, follow = false;
    late StateSetter update;
    await tester.pumpWidget(host(StatefulBuilder(builder: (context, setState) {
      update = setState;
      return SizedBox(width: 320, child: LogViewer(records: records, wrap: wrap, follow: follow, label: 'Logs'));
    })));
    await tester.pump();
    expect(find.byType(SelectableText).evaluate().length, lessThan(100));
    final list = tester.widget<ListView>(find.byType(ListView));
    list.controller!.jumpTo(1000);
    await tester.pump();
    final position = list.controller!.offset;
    update(() {});
    await tester.pump();
    expect(list.controller!.offset, position);
    update(() => follow = true);
    await tester.pumpAndSettle();
    expect(list.controller!.offset, list.controller!.position.maxScrollExtent);
    update(() => wrap = false);
    await tester.pumpAndSettle();
    final horizontal = tester.widget<SingleChildScrollView>(find.byType(SingleChildScrollView));
    expect(horizontal.controller!.position.maxScrollExtent, greaterThan(0));
    horizontal.controller!.jumpTo(50);
    await tester.pump();
    update(() => wrap = true);
    await tester.pumpAndSettle();
    expect(find.byType(SingleChildScrollView), findsNothing);
  });

  testWidgets('Observation polling stops off-page and in background and rejects stale generations', (tester) async {
    final app = AppState();
    app.navigate('traffic');
    final key = GlobalKey<_ObservationHarnessState>();
    await tester.pumpWidget(host(_ObservationHarness(key: key, app: app)));
    await tester.pump();
    final state = key.currentState!;
    expect(state.loads, 1);
    final request = state.generation;
    await tester.pump(const Duration(seconds: 5));
    expect(state.loads, 2);
    app.navigate('more');
    await tester.pump(const Duration(seconds: 15));
    expect(state.loads, 2);
    expect(state.accepts(request), isFalse);
    app.foreground = false;
    app.navigate('traffic');
    await tester.pump(const Duration(seconds: 15));
    expect(state.loads, 2);
    app.foreground = true;
    app.navigate('logs');
    app.navigate('traffic');
    await tester.pump();
    expect(state.loads, 3);
    app.autoRefresh = false;
    await tester.pump(const Duration(seconds: 5));
    expect(state.loads, 3);
    app.autoRefresh = true;
    app.powerSave = true;
    await tester.pump(const Duration(seconds: 5));
    expect(state.loads, 4);
    await tester.pump(const Duration(seconds: 29));
    expect(state.loads, 4);
    await tester.pump(const Duration(seconds: 1));
    expect(state.loads, 5);
    await tester.pumpWidget(const SizedBox());
    expect(state.accepts(state.generation), isFalse);
    app.dispose();
  });
}

class _ObservationHarness extends StatefulWidget {
  const _ObservationHarness({super.key, required this.app});
  final AppState app;
  @override
  State<_ObservationHarness> createState() => _ObservationHarnessState();
}

class _ObservationHarnessState extends ObservationPageState<_ObservationHarness> {
  int loads = 0;
  @override
  AppState get app => widget.app;
  @override
  String get destination => 'traffic';
  @override
  Duration get interval => const Duration(seconds: 5);
  @override
  void load() { loads++; }
  @override
  void invalidate(bool accountChanged) {}
  @override
  Widget build(BuildContext context) => const SizedBox();
}
