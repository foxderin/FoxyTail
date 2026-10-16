import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'observation_page.dart';
import 'observability_data.dart';

class LogsPage extends StatefulWidget {
  const LogsPage({super.key, required this.app});
  final AppState app;
  @override
  State<LogsPage> createState() => _LogsPageState();
}

class _LogsPageState extends ObservationPageState<LogsPage> {
  @override
  AppState get app => widget.app;
  @override
  String get destination => 'logs';
  @override
  Duration get interval => const Duration(seconds: 5);
  @override
  bool get shouldPoll => app.autoRefresh && live;
  late String source = app.drafts['logs.source'] == 'service' ? 'service' : 'daemon';
  late int limit = const [100, 200, 500, 1000].contains(app.drafts['logs.limit']) ? app.drafts['logs.limit'] as int : 200;
  late bool live = app.drafts['logs.live'] != false, follow = app.drafts['logs.follow'] != false,
      wrap = app.drafts['logs.wrap'] != false, matchCase = app.drafts['logs.case'] == true;
  late final TextEditingController query = TextEditingController(text: app.drafts['logs.query'] as String? ?? '');
  LogSnapshot? snapshot;
  List<LogRecord> matches = [];
  String? failure;
  DateTime? updated;
  bool loading = false, queued = false;
  int requestId = 0;
  @override
  void invalidate(bool accountChanged) {
    requestId++;
    loading = false; queued = false;
    if (accountChanged) { snapshot = null; matches = []; failure = null; updated = null; }
  }
  void refilter() {
    matches = snapshot?.filter(query.text, matchCase) ?? [];
  }
  void changeSource(String value) {
    generation++;
    app.bridge.cancelReads(owner);
    invalidate(true);
    setState(() { source = value; app.drafts['logs.source'] = value; });
    load();
  }
  @override
  Future<void> load() async {
    if (!active) return;
    if (loading) { queued = true; return; }
    final request = ++requestId, epoch = generation, requestedLimit = limit;
    final requestedSource = source;
    bool current() => accepts(epoch) && request == requestId;
    setState(() => loading = true);
    try {
      final result = await app.read(['logs', requestedSource, '$requestedLimit'], owner: owner);
      if (!mounted || !current()) return;
      if (source != requestedSource || limit != requestedLimit) return;
      final lines = result['lines'];
      if (lines is! List || lines.any((value) => value is! String)) throw FormatException(context.l10n.tools_invalid_response);
      final raw = lines.cast<String>();
      setState(() {
        if (snapshot == null || !snapshot!.same(raw)) { snapshot = LogSnapshot(raw); refilter(); }
        updated = DateTime.now(); failure = null;
      });
    } catch (error) {
      if (current() && source == requestedSource && limit == requestedLimit) setState(() => failure = failureMessage(error));
    } finally {
      if (current()) {
        setState(() => loading = false);
        if (queued) { queued = false; unawaited(load()); }
      }
    }
  }
  @override
  void dispose() { query.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    Widget option(String label, bool value, ValueChanged<bool>? change) => FilterChip(label: Text(label), selected: value, onSelected: change);
    return PageBody(children: [
      Section(children: [
        Align(alignment: AlignmentDirectional.centerStart, child: SegmentedButton<String>(
          segments: [ButtonSegment(value: 'daemon', label: Text(l.web_logs_daemon)), ButtonSegment(value: 'service', label: Text(l.web_logs_service))],
          selected: {source}, onSelectionChanged: (value) => changeSource(value.single))),
        const SizedBox(height: 16),
        LayoutBuilder(builder: (context, constraints) {
          final search = TextField(controller: query, decoration: InputDecoration(labelText: l.web_tools_logs_find, prefixIcon: const Icon(Icons.search)),
            onChanged: (value) => setState(() { app.drafts['logs.query'] = value; refilter(); }));
          final count = DropdownButtonFormField<int>(initialValue: limit, decoration: InputDecoration(labelText: l.web_tools_logs_rows),
            items: [for (final value in [100, 200, 500, 1000]) DropdownMenuItem(value: value, child: Text('$value'))],
            onChanged: (value) { if (value != null) { setState(() { limit = value; app.drafts['logs.limit'] = value; }); load(); } });
          return constraints.maxWidth < 360 ? Column(children: [search, const SizedBox(height: 12), count])
            : Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: search), const SizedBox(width: 12), SizedBox(width: 135, child: count)]);
        }),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          option(l.web_tools_logs_live, live && app.autoRefresh, !app.autoRefresh ? null : (value) { setState(() { live = value; app.drafts['logs.live'] = value; }); if (value) load(); }),
          option(l.web_logs_follow, follow, (value) => setState(() { follow = value; app.drafts['logs.follow'] = value; })),
          option(l.web_tools_logs_wrap, wrap, (value) => setState(() { wrap = value; app.drafts['logs.wrap'] = value; })),
          option(l.web_tools_logs_match_case, matchCase, (value) => setState(() { matchCase = value; app.drafts['logs.case'] = value; refilter(); })),
        ]),
        Wrap(spacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Text(shouldPoll && active ? l.web_tools_logs_live : l.web_tools_logs_paused),
          IconButton(tooltip: l.web_tools_refresh, onPressed: loading ? null : load, icon: const Icon(Icons.refresh)),
          IconButton(tooltip: l.web_tools_logs_copy, onPressed: matches.isEmpty ? null : () => copyText(context, LogSnapshot.copy(matches)), icon: const Icon(Icons.copy_all)),
        ]),
      ]),
      Section(children: [
        Wrap(spacing: 16, runSpacing: 8, children: [Text('${l.web_tools_logs_count} · ${matches.length} / ${snapshot?.records.length ?? '—'}'),
          if (updated != null) Text('${l.web_tools_logs_updated} ${MaterialLocalizations.of(context).formatTimeOfDay(TimeOfDay.fromDateTime(updated!))}')]),
        if (loading) const LinearProgressIndicator(),
        if (failure != null) Notice(failure!, error: true),
        if (matches.isEmpty && failure == null) Notice(snapshot == null ? l.web_loading : query.text.isEmpty ? l.web_logs_empty : l.web_tools_logs_no_match),
        if (matches.isNotEmpty) LogViewer(records: matches, wrap: wrap, follow: follow,
          label: source == 'daemon' ? l.web_logs_daemon : l.web_logs_service),
      ]),
    ]);
  }
}

class LogViewer extends StatefulWidget {
  const LogViewer({super.key, required this.records, required this.wrap, required this.follow, required this.label});
  final List<LogRecord> records;
  final bool wrap, follow;
  final String label;
  @override
  State<LogViewer> createState() => _LogViewerState();
}

class _LogViewerState extends State<LogViewer> {
  final vertical = ScrollController(), horizontal = ScrollController();
  List<LogRecord>? measured;
  double measuredWidth = 0, contentWidth = 0;
  TextScaler? measuredScale;
  bool measuredWrap = true;
  List<double> heights = [];
  void followEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.follow && vertical.hasClients) vertical.jumpTo(vertical.position.maxScrollExtent);
    });
  }
  @override
  void initState() { super.initState(); followEnd(); }
  @override
  void didUpdateWidget(LogViewer old) {
    super.didUpdateWidget(old);
    if (widget.follow && (widget.records != old.records || !old.follow || widget.wrap != old.wrap)) followEnd();
    if (widget.wrap && horizontal.hasClients) horizontal.jumpTo(0);
  }
  @override
  void dispose() { vertical.dispose(); horizontal.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) {
    const style = TextStyle(fontFamily: 'monospace', fontSize: 12, height: 1.8);
    final scale = MediaQuery.textScalerOf(context);
    return LayoutBuilder(builder: (context, constraints) {
      final numberWidth = math.max(44.0, scale.scale(34));
      final gutter = numberWidth + 24;
      if (measured != widget.records || measuredWidth != constraints.maxWidth || measuredScale != scale || measuredWrap != widget.wrap) {
        measured = widget.records; measuredWidth = constraints.maxWidth; measuredScale = scale; measuredWrap = widget.wrap;
        contentWidth = constraints.maxWidth;
        heights = [];
        for (final row in widget.records) {
          final painter = TextPainter(text: TextSpan(text: row.display, style: style), textDirection: TextDirection.ltr, textScaler: scale)
            ..layout(maxWidth: widget.wrap ? math.max(1, constraints.maxWidth - gutter) : double.infinity);
          contentWidth = math.max(contentWidth, painter.width + gutter);
          heights.add(math.max(scale.scale(21.6), painter.height) + 4);
        }
        if (widget.follow) followEnd();
      }
      final height = math.max(240.0, MediaQuery.sizeOf(context).height * .62);
      final list = SizedBox(width: widget.wrap ? constraints.maxWidth : contentWidth, height: height,
        child: ListView.builder(controller: vertical, padding: const EdgeInsets.symmetric(vertical: 12),
          itemCount: widget.records.length, itemExtentBuilder: (index, _) => heights[index],
          itemBuilder: (context, index) {
            final row = widget.records[index];
            return Padding(key: ValueKey(row.number), padding: const EdgeInsets.symmetric(vertical: 2, horizontal: 6),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                ExcludeSemantics(child: SizedBox(width: numberWidth, child: Text('${row.number}', textAlign: TextAlign.end, style: style.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant)))),
                const SizedBox(width: 12),
                Expanded(child: SelectableText(row.display, style: style, textDirection: TextDirection.ltr)),
              ]));
          }));
      return Semantics(label: widget.label, child: ClipRRect(borderRadius: BorderRadius.circular(12), child: ColoredBox(
        color: Theme.of(context).colorScheme.surfaceContainer,
        child: widget.wrap ? list : Scrollbar(controller: horizontal, thumbVisibility: true,
          child: SingleChildScrollView(controller: horizontal, scrollDirection: Axis.horizontal, child: list)),
      )));
    });
  }
}
