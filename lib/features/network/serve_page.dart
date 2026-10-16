import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'network_rules.dart';
import 'network_state.dart';

class ServePage extends StatefulWidget {
  const ServePage({super.key, required this.app});
  final AppState app;
  @override
  State<ServePage> createState() => _ServePageState();
}
class _ServePageState extends NetworkPageState<ServePage> {
  @override
  AppState get app => widget.app;
  final mappings = <bool, List<ServeMapping>>{};
  final errors = <bool, String>{};
  final loading = <bool>{};
  late final TextEditingController port, target;
  bool funnel = false, adding = false;
  String protocol = 'https';
  @override
  void initState() {
    super.initState();
    funnel = app.drafts['serve.kind'] == 1;
    final index = number(app.drafts['serve.protocol']).toInt();
    protocol = index >= 0 && index < serveProtocols.length ? serveProtocols[index] : 'https';
    if (funnel && protocol == 'http') protocol = 'https';
    var draftPort = string(app.drafts['serve.port']);
    if (funnel && !funnelPorts.contains(draftPort)) draftPort = '443';
    port = TextEditingController(text: draftPort);
    target = TextEditingController(text: string(app.drafts['serve.target']));
    port.addListener(() { app.drafts['serve.port'] = port.text; setState(() {}); });
    target.addListener(() { app.drafts['serve.target'] = target.text; setState(() {}); });
  }
  @override
  void load() { _load(false); _load(true); }
  @override
  void invalidated() {
    mappings.clear(); errors.clear(); loading.clear();
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted && app.foreground) load(); });
  }
  @override
  void dispose() { port.dispose(); target.dispose(); super.dispose(); }
  Future<void> _load(bool public) async {
    if (loading.contains(public) || !app.foreground) return;
    final ticket = generation;
    setState(() { loading.add(public); errors.remove(public); });
    try {
      final result = await readCurrent([public ? 'funnel-list' : 'serve-list']);
      if (!mounted || result == null) return;
      if (result['status'] is! Map) throw FormatException(context.l10n.network_invalid_result);
      setState(() { mappings[public] = serveMappings(json(result['status'])).where((m) => m.funnel == public).toList(); });
    } catch (e) { if (mounted && ticket == generation) setState(() { errors[public] = failureMessage(e); mappings.remove(public); }); }
    finally { if (mounted && ticket == generation) setState(() { loading.remove(public); }); }
  }
  ServeDraft get draft => (funnel: funnel, protocol: protocol, port: port.text, target: target.text);
  Future<void> _add() async {
    if (!writable || adding) return;
    final submitted = draft, account = app.accountRevision;
    final p = submitted.port.trim(), destination = submitted.target.trim();
    final l = context.l10n;
    if (!validPort(p)) { app.message(l.web_tools_port_invalid); return; }
    if (!validServe(submitted.funnel, submitted.protocol, p, destination)) { app.message(submitted.funnel ? l.web_tools_funnel_port_invalid : l.web_tools_serve_local_target); return; }
    setState(() { adding = true; });
    await run(() async {
      if (submitted.funnel && !await confirm(context, l.web_serve_funnel, '${l.web_tools_serve_public_hint}\n${submitted.protocol}:$p → $destination')) return;
      if (!mounted || account != app.accountRevision || !writable) return;
      requireOk(await app.submit(l.web_serve_add, [submitted.funnel ? 'funnel-set' : 'serve-set', submitted.protocol, p, destination]));
      if (!mounted || account != app.accountRevision) return;
      if (draft == submitted) target.clear();
      app.message(l.web_tools_serve_add_done);
      load();
    });
    if (mounted) setState(() { adding = false; });
  }
  Future<void> _delete(ServeMapping mapping) => run(() async {
    final account = app.accountRevision;
    if (!await confirm(context, context.l10n.web_delete, '${context.l10n.web_serve_del_confirm}\n${mapping.endpoint}') || !mounted || account != app.accountRevision || !writable) return;
    requireOk(await app.submit(context.l10n.web_delete, mapping.deleteArgs()));
    if (mounted && account == app.accountRevision) load();
  });
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return PageBody(children: [
      for (final public in [false, true]) Section(title: public ? l.web_serve_funnel : l.web_serve_serve,
        trailing: IconButton(tooltip: l.web_tools_refresh, onPressed: loading.contains(public) ? null : () => _load(public), icon: const Icon(Icons.refresh)), children: [
          Text(public ? l.web_tools_serve_public : l.web_tools_serve_private),
          if (loading.contains(public)) const LinearProgressIndicator(),
          if (errors[public] != null) Notice(errors[public]!, error: true),
          if (mappings[public] != null) ...[
            Text('${mappings[public]!.length} ${l.web_tools_mapping_count}'),
            if (mappings[public]!.isEmpty) Notice(l.web_serve_empty),
            for (final mapping in mappings[public]!) ListTile(title: SelectableText(mapping.endpoint), subtitle: SelectableText(mapping.target),
              trailing: IconButton(tooltip: '${l.web_delete} ${mapping.endpoint}', onPressed: writable && mapping.protocol != 'unknown' ? () => _delete(mapping) : null, icon: const Icon(Icons.delete_outline))),
          ],
        ]),
      Section(title: l.web_serve_add, children: [
        SegmentedButton<bool>(segments: [ButtonSegment(value: false, label: Text(l.web_serve_serve), icon: const Icon(Icons.lock_outline)), ButtonSegment(value: true, label: Text(l.web_serve_funnel), icon: const Icon(Icons.public))],
          selected: {funnel}, onSelectionChanged: (value) => setState(() {
            funnel = value.single; app.drafts['serve.kind'] = funnel ? 1 : 0;
            if (funnel && protocol == 'http') { protocol = 'https'; app.drafts['serve.protocol'] = 0; }
            if (funnel) port.text = funnelPorts.contains(port.text.trim()) ? port.text.trim() : '443';
          })),
        if (funnel) Notice(l.web_tools_serve_public_hint),
        DropdownButtonFormField<String>(key: ValueKey('protocol-$funnel-$protocol'), initialValue: protocol, isExpanded: true,
          decoration: InputDecoration(labelText: l.web_tools_serve_listener_protocol),
          items: [for (final p in serveProtocols.where((p) => !funnel || p != 'http')) DropdownMenuItem(value: p, child: Text(p == 'tls-terminated-tcp' ? 'TLS → TCP' : p.toUpperCase()))],
          onChanged: (value) { if (value != null) setState(() { protocol = value; app.drafts['serve.protocol'] = serveProtocols.indexOf(value); }); }),
        if (funnel) DropdownButtonFormField<String>(key: ValueKey('funnel-${port.text}'), initialValue: port.text, decoration: InputDecoration(labelText: l.web_tools_serve_listener_port),
          items: [for (final p in funnelPorts) DropdownMenuItem(value: p, child: Text(p))], onChanged: (value) { if (value != null) port.text = value; })
        else TextField(controller: port, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: l.web_tools_serve_listener_port, hintText: '443')),
        TextField(controller: target, keyboardType: TextInputType.url, decoration: InputDecoration(labelText: l.web_tools_serve_local_target, hintText: protocol.contains('tcp') ? 'localhost:3000' : 'http://localhost:3000')),
        if (adding) const LinearProgressIndicator(),
        FilledButton.icon(onPressed: writable && !adding ? _add : null, icon: const Icon(Icons.add), label: Text(l.web_serve_add)),
      ]),
    ]);
  }
}
