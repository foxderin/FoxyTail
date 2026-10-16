import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'network_labels.dart';
import 'network_rules.dart';
import 'network_state.dart';

class CoexistPage extends StatelessWidget {
  const CoexistPage({super.key, required this.app});
  final AppState app;
  @override
  Widget build(BuildContext context) => PageBody(children: [CoexistPanel(app: app)]);
}
class CoexistPanel extends StatefulWidget {
  const CoexistPanel({super.key, required this.app});
  final AppState app;
  @override
  State<CoexistPanel> createState() => _CoexistPanelState();
}
class _CoexistPanelState extends NetworkPageState<CoexistPanel> {
  @override
  AppState get app => widget.app;
  Json? info, peer, result;
  String address = '', filter = '', snippet = '';
  String? error, snippetError;
  bool detecting = false, checking = false, copying = false;
  late final TextEditingController port, resolver;
  @override
  void initState() {
    super.initState();
    final filters = ['', 'blacklist', 'rule', 'redir-host', 'whitelist'];
    final index = number(app.drafts['coexist.filter']).toInt();
    filter = index >= 0 && index < filters.length ? filters[index] : '';
    port = TextEditingController(text: string(app.drafts['coexist.targetPort']));
    resolver = TextEditingController(text: string(app.drafts['coexist.resolverPort']));
    port.addListener(() { app.drafts['coexist.targetPort'] = port.text; _invalidateResult(); });
    resolver.addListener(() { app.drafts['coexist.resolverPort'] = resolver.text; _invalidateResult(); });
  }
  void _invalidateResult() { setState(() { generation++; result = null; checking = false; }); }
  @override
  void invalidated() { info = null; peer = null; result = null; snippet = ''; address = ''; detecting = false; checking = false; copying = false; }
  @override
  void load() { if (mounted) setState(invalidated); }
  @override
  void dispose() { port.dispose(); resolver.dispose(); super.dispose(); }
  void _snippet() {
    snippet = ''; snippetError = null;
    if (info?['dnsReady'] != true || filter.isEmpty) return;
    if (filter == 'whitelist') { snippetError = context.l10n.web_coexist_whitelist_hint; return; }
    try { snippet = coexistSnippet(info!, filter); }
    on FormatException { snippetError = context.l10n.web_coexist_invalid_snapshot; }
  }
  Future<void> _detect() async {
    if (!writable || detecting) return;
    setState(() { generation++; info = null; peer = null; address = ''; snippet = ''; result = null; error = null; detecting = true; });
    try {
      final response = await probeCurrent(context.l10n.web_coexist_detect, ['coexist-info']);
      if (!mounted || response == null) return;
      requireOk(response);
      if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(string(response['snapshot'])) || response['peers'] is! List || response['dns'] is! Map || response['environment'] is! Map) throw FormatException(context.l10n.tools_invalid_response);
      setState(() { info = response; _snippet(); });
    } catch (e) { if (mounted) setState(() { error = failureMessage(e); }); }
    finally { if (mounted) setState(() { detecting = false; }); }
  }
  Future<void> _copy() async {
    if (copying || info == null || snippet.isEmpty) return;
    final expected = info!['snapshot'], text = snippet;
    setState(() { copying = true; });
    await run(() async {
      final current = await readCurrent(['coexist-info']);
      if (!mounted || current == null) return;
      if (current['snapshot'] != expected || current['dnsReady'] != true) {
        setState(() { invalidated(); error = context.l10n.web_coexist_context_changed; });
        return;
      }
      await copyText(context, text);
    });
    if (mounted) setState(() { copying = false; });
  }
  Future<void> _check() async {
    final p = port.text.trim(), r = resolver.text.trim();
    if (!writable || checking || !canCoexistCheck(info, peer, address, p, r)) return;
    final snapshot = info!['snapshot'], id = string(peer!['id']), name = peer!['dnsName'], ip = address;
    final path = info!['mode'] == 'tun' ? 'system' : 'socks5';
    setState(() { generation++; checking = true; result = null; error = null; });
    try {
      final response = await probeCurrent(context.l10n.web_coexist_check, ['coexist-check', '$snapshot', id, ip, p, r.isEmpty ? '-' : r]);
      if (response == null) return;
      requireOk(response);
      if (response['snapshot'] != snapshot || response['name'] != name || response['address'] != ip || response['targetPort'] != int.parse(p) || response['path'] != path) {
        setState(() { invalidated(); error = context.l10n.web_coexist_context_changed; });
        return;
      }
      setState(() { result = response; });
    } catch (e) { if (mounted) setState(() { error = failureMessage(e); }); }
    finally { if (mounted) setState(() { checking = false; }); }
  }
  @override
  Widget build(BuildContext context) {
    final l = context.l10n, ready = info?['ok'] == true && info?['dnsReady'] == true;
    final environment = json(info?['environment']), dns = json(info?['dns']);
    final peers = objects(info?['peers']);
    final labels = {'dns-udp': l.web_coexist_dns_udp, 'dns-tcp': l.web_coexist_dns_tcp, 'resolver-udp': l.web_coexist_resolver_udp, 'resolver-tcp': l.web_coexist_resolver_tcp, 'tcp': l.web_coexist_tcp};
    return Section(title: l.web_coexist_title, children: [
      Text(l.web_coexist_intro),
      if (detecting) const LinearProgressIndicator(),
      if (error != null) Notice(error!, error: true),
      OutlinedButton.icon(onPressed: writable && !detecting ? _detect : null, icon: const Icon(Icons.search), label: Text(info == null ? l.web_coexist_detect : l.web_coexist_refresh)),
      if (info == null && !detecting) Notice(l.web_coexist_unchecked),
      if (info != null) ...[
        Text(l.web_coexist_environment, style: Theme.of(context).textTheme.titleMedium),
        if (objects(environment['modules']).isEmpty && objects(environment['apps']).isEmpty) Notice(l.web_coexist_inventory_empty),
        for (final category in ['modules', 'apps']) for (final item in objects(environment[category])) InfoRow(string(item[category == 'apps' ? 'package' : 'name']), string(item['kind'])),
        if (string(environment['alert']).isNotEmpty) Notice(string(environment['alert'])),
        for (final warning in (environment['warnings'] is List ? environment['warnings'] as List : const <Object?>[]).whereType<String>()) Notice(warning),
        InfoRow(l.web_coexist_applied_mode, string(info!['mode'])),
        InfoRow(l.web_dns_suffix, string(info!['suffix'])),
        InfoRow(l.web_dns_title, dnsLabel(l, dns)),
        if (!ready) ...[
          Notice(l.web_coexist_prerequisite),
          IconButton(tooltip: l.web_tools_dns_settings, onPressed: () => app.navigate('settings'), icon: const Icon(Icons.settings)),
        ] else ...[
          InfoRow(l.web_tools_dns_endpoint, numericEndpoint(dns['port']) ?? l.network_unknown),
          InfoRow(l.web_coexist_target_path, info!['mode'] == 'tun' ? 'tailscale0' : 'SOCKS5 ${numericEndpoint(info!['socksPort']) ?? l.network_unknown}'),
          Text(l.web_coexist_filter_step, style: Theme.of(context).textTheme.titleMedium),
          Text(l.web_coexist_core_hint),
          DropdownButtonFormField<String>(initialValue: filter, isExpanded: true, decoration: InputDecoration(labelText: l.web_coexist_filter_label), items: [
            DropdownMenuItem(value: '', child: Text(l.web_coexist_filter_choose)),
            const DropdownMenuItem(value: 'blacklist', child: Text('fake-ip · blacklist')),
            const DropdownMenuItem(value: 'rule', child: Text('fake-ip · rule')),
            const DropdownMenuItem(value: 'redir-host', child: Text('redir-host')),
            DropdownMenuItem(value: 'whitelist', child: Text(l.web_coexist_filter_whitelist)),
          ], onChanged: (value) { if (value == null) return; setState(() { filter = value; app.drafts['coexist.filter'] = ['', 'blacklist', 'rule', 'redir-host', 'whitelist'].indexOf(value); generation++; result = null; _snippet(); }); }),
          if (snippetError != null) Notice(snippetError!),
          if (snippet.isNotEmpty) ExpansionTile(initiallyExpanded: true, title: Text(l.web_coexist_snippet_step), children: [
            Text(l.web_coexist_merge_hint), Text(l.web_coexist_scope_hint), Text(l.web_coexist_name_hint),
            Text(info!['mode'] == 'tun' ? l.web_coexist_tun_hint : l.web_coexist_socks_hint), Text(l.web_coexist_ipv6_hint),
            SelectableText(snippet, style: const TextStyle(fontFamily: 'monospace')),
            IconButton(tooltip: l.web_copy, onPressed: copying ? null : _copy, icon: const Icon(Icons.copy)),
          ]),
          Text(l.web_coexist_check_step, style: Theme.of(context).textTheme.titleMedium),
          if (peers.isEmpty) Notice(l.web_coexist_no_peers) else ...[
            Text(l.web_coexist_check_hint),
            DropdownButtonFormField<int>(key: ValueKey(info!['snapshot']), initialValue: -1, isExpanded: true, decoration: InputDecoration(labelText: l.web_coexist_peer),
              items: [DropdownMenuItem(value: -1, child: Text(l.web_coexist_peer_choose)), for (var i = 0; i < peers.length; i++) DropdownMenuItem(value: i, child: Text('${string(peers[i]['dnsName'])}${peers[i]['online'] == true ? '' : ' · ${l.web_offline}'}'))],
              onChanged: (value) => setState(() { generation++; result = null; peer = value == null || value < 0 ? null : peers[value]; address = ''; })),
            DropdownButtonFormField<String>(key: ValueKey('${info!['snapshot']}-${peer?['id']}'), initialValue: '', isExpanded: true, decoration: InputDecoration(labelText: l.web_coexist_address),
              items: [DropdownMenuItem(value: '', child: Text(l.web_coexist_address_choose)), for (final ip in peer == null ? <String>[] : addresses(peer!)) DropdownMenuItem(value: ip, child: Text(ip))],
              onChanged: peer == null ? null : (value) => setState(() { generation++; result = null; address = value ?? ''; })),
            TextField(controller: port, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: l.web_coexist_port)),
            TextField(controller: resolver, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: l.web_coexist_resolver_port)),
            Text(l.web_coexist_ports_hint),
            if (port.text.isNotEmpty && !validPort(port.text.trim()) || resolver.text.isNotEmpty && (!validPort(resolver.text.trim()) || int.tryParse(resolver.text.trim()) == dns['port'])) Notice(l.web_coexist_invalid_port, error: true),
            if (checking) const LinearProgressIndicator(),
            FilledButton.icon(onPressed: writable && !checking && canCoexistCheck(info, peer, address, port.text.trim(), resolver.text.trim()) ? _check : null, icon: const Icon(Icons.network_check), label: Text(l.web_coexist_check)),
          ],
        ],
      ],
      if (result != null) ...[
        InfoRow(l.web_coexist_peer, string(result!['name'])),
        InfoRow(l.web_coexist_target, '${string(result!['address']).contains(':') ? '[${result!['address']}]' : result!['address']}:${result!['targetPort']}'),
        InfoRow(l.web_coexist_target_path, result!['path'] == 'socks5' ? l.web_coexist_path_socks : l.web_coexist_path_system),
        for (final entry in labels.entries) _checkResult(entry.key, entry.value),
        Notice(l.web_coexist_result_boundary),
      ],
    ]);
  }
  Widget _checkResult(String id, String title) {
    final l = context.l10n, rows = objects(result?['checks']).where((c) => c['id'] == id).toList();
    final row = rows.isEmpty ? null : rows.last;
    final state = row == null ? id.startsWith('resolver-') && resolver.text.trim().isEmpty ? l.web_coexist_skipped : l.web_coexist_not_checked : row['ok'] == true ? l.web_coexist_pass : l.web_coexist_fail;
    return ListTile(title: Text('$title · $state'), subtitle: row == null ? null : Text([
      if (measured(row['elapsedMs'])) '${row['elapsedMs']} ms',
      if (string(row['error']).isNotEmpty) string(row['error']),
      if (row['addresses'] is List && (row['addresses'] as List).isNotEmpty) '${l.web_coexist_observed}: ${(row['addresses'] as List).whereType<String>().join(', ')}',
    ].join('\n')));
  }
}
