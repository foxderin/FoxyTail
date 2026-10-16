import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'observation_page.dart';
import 'observability_data.dart';
import 'traffic_chart.dart';

class TrafficPage extends StatefulWidget {
  const TrafficPage({super.key, required this.app});
  final AppState app;
  @override
  State<TrafficPage> createState() => _TrafficPageState();
}

class _TrafficPageState extends ObservationPageState<TrafficPage> {
  @override
  AppState get app => widget.app;
  @override
  String get destination => 'traffic';
  Json? summary;
  List<TrafficSample> hours = [], days = [];
  final Map<String, String> peerNames = {}, appNames = {};
  bool loading = false;
  String? failure;
  late bool daily = app.drafts['traffic.daily'] == true;
  late bool table = app.drafts['traffic.table'] == true;
  late String? selectedHour = app.drafts['traffic.selectedHour'] as String?, selectedDay = app.drafts['traffic.selectedDay'] as String?;
  int requestId = 0;
  @override
  void invalidate(bool accountChanged) {
    requestId++;
    loading = false;
    if (accountChanged) {
      summary = null; hours = []; days = []; peerNames.clear(); appNames.clear();
      selectedHour = null; selectedDay = null; failure = null;
    }
  }
  @override
  Future<void> load() async {
    if (!active || loading) return;
    final request = ++requestId, epoch = generation;
    setState(() { loading = true; failure = null; });
    bool current() => accepts(epoch) && request == requestId;
    try {
      final result = await app.read(['traffic', 'summary'], owner: owner);
      if (!mounted || !current()) return;
      if (!['hours', 'days', 'topn', 'uids'].every((key) => result[key] is List)) {
        throw FormatException(context.l10n.tools_invalid_response);
      }
      final nextHours = trafficSamples(result, false), nextDays = trafficSamples(result, true);
      setState(() { summary = result; hours = nextHours; days = nextDays; peerNames.clear(); appNames.clear(); });
      final lookups = <Future<void>>[];
      if (objects(result['topn']).any((row) => trafficBytes(row['rx']) + trafficBytes(row['tx']) > 0)) {
        lookups.add(app.read(['peers'], owner: owner).then((value) {
          if (!current()) return;
          setState(() { for (final row in objects(value['peers'])) { final name = string(row['hostname']); if (name.isNotEmpty) peerNames[string(row['id'])] = name; } });
        }).catchError((Object _) {}));
      }
      if (objects(result['uids']).any((row) => trafficBytes(row['tx']) > 0)) {
        lookups.add(app.read(['apps'], owner: owner).then((value) {
          if (!current()) return;
          setState(() { for (final row in objects(value['apps'])) { final name = string(row['label']); if (name.isNotEmpty) appNames['${row['uid'] ?? ''}'] = name; } });
        }).catchError((Object _) {}));
      }
      await Future.wait(lookups);
    } catch (error) {
      if (current()) setState(() { failure = error is FormatException ? context.l10n.tools_invalid_response : failureMessage(error); summary = null; hours = []; days = []; });
    } finally {
      if (current()) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final samples = daily ? days : hours;
    final selected = selectedTrafficIndex(samples, daily ? selectedDay : selectedHour);
    final known = samples.any((sample) => sample.rx != null || sample.tx != null);
    final rx = samples.fold<double>(0, (sum, sample) => sum + (sample.rx ?? 0));
    final tx = samples.fold<double>(0, (sum, sample) => sum + (sample.tx ?? 0));
    final peers = objects(summary?['topn']).where((row) => trafficBytes(row['rx']) + trafficBytes(row['tx']) > 0).toList()
      ..sort((a, b) => (trafficBytes(b['rx']) + trafficBytes(b['tx'])).compareTo(trafficBytes(a['rx']) + trafficBytes(a['tx'])));
    final apps = objects(summary?['uids']).where((row) => trafficBytes(row['tx']) > 0).take(50).toList();
    void select(int index) => setState(() {
      if (daily) { selectedDay = samples[index].label; app.drafts['traffic.selectedDay'] = selectedDay; }
      else { selectedHour = samples[index].label; app.drafts['traffic.selectedHour'] = selectedHour; }
    });
    Widget ranking(bool byApp) => Section(title: byApp ? l.web_traffic_by_app : l.web_traffic_topn, children: [
      if (byApp) Text(l.web_traffic_app_tx_hint),
      if ((byApp ? apps : peers).isEmpty) Notice(byApp ? l.web_net_traffic_no_app : l.web_net_traffic_no_peer),
      ...List.generate(byApp ? apps.length : peers.take(10).length, (index) {
        final row = (byApp ? apps : peers)[index];
        final id = '${row[byApp ? 'uid' : 'id'] ?? ''}';
        final received = trafficBytes(row['rx']), sent = trafficBytes(row['tx']);
        final label = byApp ? (appNames[id] ?? '${l.web_traffic_uid}$id') : (peerNames[id] ?? id);
        final maximum = peers.isEmpty ? 1.0 : trafficBytes(peers.first['rx']) + trafficBytes(peers.first['tx']);
        return Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          ListTile(contentPadding: EdgeInsets.zero,
            leading: byApp ? const Icon(Icons.apps) : Text('${index + 1}'.padLeft(2, '0')),
            title: Text(label), subtitle: Text(byApp ? '${l.web_traffic_uid}$id' : '${l.web_traffic_rx} ${formatBytes(received)} · ${l.web_traffic_tx} ${formatBytes(sent)}'),
            trailing: Text(formatBytes(byApp ? sent : received + sent))),
          if (!byApp) ExcludeSemantics(child: LayoutBuilder(builder: (context, constraints) => Row(children: [
            Container(height: 5, width: constraints.maxWidth * received / maximum, color: Theme.of(context).colorScheme.primary),
            Container(height: 5, width: constraints.maxWidth * sent / maximum, color: Theme.of(context).colorScheme.tertiary),
          ]))),
        ]));
      }),
    ]);
    return PageBody(children: [
      Wrap(spacing: 12, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
        SegmentedButton<bool>(segments: [ButtonSegment(value: false, label: Text(l.web_traffic_hourly)), ButtonSegment(value: true, label: Text(l.web_traffic_daily))], selected: {daily},
          onSelectionChanged: (value) => setState(() { daily = value.single; app.drafts['traffic.daily'] = daily; })),
        IconButton(tooltip: l.web_tools_refresh, onPressed: loading ? null : load, icon: const Icon(Icons.refresh)),
      ]),
      if (loading) const LinearProgressIndicator(),
      if (failure != null) Notice(failure!, error: true),
      Wrap(spacing: 12, runSpacing: 12, children: [
        Metric(l.web_net_traffic_total, known ? formatBytes(rx + tx) : '—', icon: Icons.monitor_heart_outlined),
        Metric(l.web_traffic_rx, known ? formatBytes(rx) : '—', icon: Icons.arrow_downward),
        Metric(l.web_traffic_tx, known ? formatBytes(tx) : '—', icon: Icons.arrow_upward),
      ]),
      Section(title: l.web_net_traffic_chart, children: [
        Wrap(spacing: 24, children: [
          Text(l.web_traffic_rx, style: TextStyle(color: Theme.of(context).colorScheme.primary, fontWeight: FontWeight.bold)),
          Text(l.web_traffic_tx, style: TextStyle(color: Theme.of(context).colorScheme.tertiary)),
        ]),
        if (!known) Notice(l.web_net_traffic_no_samples),
        if (samples.isNotEmpty) TrafficChart(samples: samples, selected: selected, onSelected: select),
        if (selected >= 0) Semantics(liveRegion: true, child: Wrap(spacing: 16, runSpacing: 8, children: [
          Text(samples[selected].label),
          Text('${l.web_traffic_rx} ${samples[selected].rx == null ? l.web_net_traffic_unrecorded : formatBytes(samples[selected].rx!)}'),
          Text('${l.web_traffic_tx} ${samples[selected].tx == null ? l.web_net_traffic_unrecorded : formatBytes(samples[selected].tx!)}'),
        ])),
        Align(alignment: AlignmentDirectional.centerStart, child: IconButton(isSelected: table, tooltip: l.web_net_traffic_table,
          onPressed: () => setState(() { table = !table; app.drafts['traffic.table'] = table; }), icon: const Icon(Icons.table_chart_outlined))),
        if (table) SingleChildScrollView(scrollDirection: Axis.horizontal, child: DataTable(
          columns: [DataColumn(label: Text(l.web_net_traffic_time)), DataColumn(label: Text(l.web_traffic_rx), numeric: true), DataColumn(label: Text(l.web_traffic_tx), numeric: true)],
          rows: [for (final sample in samples) DataRow(cells: [DataCell(Text(sample.label)), DataCell(Text(sample.rx == null ? l.web_net_traffic_unrecorded : formatBytes(sample.rx!))), DataCell(Text(sample.tx == null ? l.web_net_traffic_unrecorded : formatBytes(sample.tx!)))])],
        )),
      ]),
      if (summary != null) LayoutBuilder(builder: (context, constraints) => constraints.maxWidth > 700
        ? Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: ranking(false)), const SizedBox(width: 16), Expanded(child: ranking(true))])
        : Column(children: [ranking(false), ranking(true)])),
    ]);
  }
}
