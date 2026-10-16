import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'network_labels.dart';
import 'network_rules.dart';
import 'network_state.dart';

class PeersPage extends StatefulWidget {
  const PeersPage({super.key, required this.app});
  final AppState app;
  @override
  State<PeersPage> createState() => _PeersPageState();
}
class _PeersPageState extends NetworkPageState<PeersPage> {
  @override
  AppState get app => widget.app;
  late final TextEditingController search;
  int filter = 0;
  bool topology = false, topologyExpanded = false, measuring = false;
  final latencies = <String, num?>{};
  @override
  void initState() {
    super.initState();
    search = TextEditingController(text: string(app.drafts['network.peerSearch']));
    filter = number(app.drafts['network.peerFilter']).toInt();
    topology = app.drafts['network.peerTab'] == 1;
    search.addListener(() { app.drafts['network.peerSearch'] = search.text; setState(() {}); });
  }
  @override
  void load() { app.refreshStatus(); }
  @override
  void invalidated() { latencies.clear(); measuring = false; }
  @override
  void dispose() { search.dispose(); super.dispose(); }
  Future<void> _measure() async {
    if (!writable || !app.statusFresh || measuring) return;
    setState(() { measuring = true; latencies.clear(); });
    await run(() async {
      final result = await probeCurrent(context.l10n.web_exit_test, ['speedtest-exitnodes']);
      if (!mounted || result == null) return;
      requireOk(result);
      if (result['results'] is! List) throw FormatException(context.l10n.network_invalid_result);
      setState(() {
        for (final row in objects(result['results'])) { latencies[string(row['id'])] = row['ok'] == true && measured(row['latencyMs']) ? row['latencyMs'] as num : null; }
      });
    });
    if (mounted) setState(() { measuring = false; });
  }
  Future<void> _clearExit() => run(() async {
    final account = app.accountRevision;
    if (!await confirm(context, context.l10n.web_net_exit_clear, context.l10n.network_interrupt) || !mounted || account != app.accountRevision || !writable || !app.statusFresh) return;
    requireOk(await app.submit(context.l10n.web_net_exit_clear, ['exitnode-clear']));
    await app.refreshStatus();
  });
  void _detail(Json peer) {
    showModalBottomSheet<void>(context: context, isScrollControlled: true, useSafeArea: true,
      builder: (_) => SizedBox(height: MediaQuery.sizeOf(context).height * .85,
        child: _PeerDetail(app: app, peer: peer, latency: latencies[string(peer['id'])], tested: latencies.containsKey(string(peer['id'])))));
  }
  Widget _row(Json peer) {
    final l = context.l10n;
    return ListTile(key: ValueKey('peer-${peer['id']}-${peer['hostname']}'),
      leading: Icon(peer['online'] == true ? Icons.devices : Icons.devices_other),
      title: Text(string(peer['hostname'])),
      subtitle: Text([
        peer['online'] == true ? l.web_net_filter_online : l.web_net_filter_offline,
        string(peer['os']), ...addresses(peer),
        if (string(peer['relay']).isNotEmpty) '${l.web_net_relay_region}: ${peer['relay']}',
        if (peer['exitNodeOption'] == true) l.web_exit_title,
        '↓ ${peer['rxBytes'] is num ? formatBytes(number(peer['rxBytes'])) : '—'}  ↑ ${peer['txBytes'] is num ? formatBytes(number(peer['txBytes'])) : '—'}',
      ].where((s) => s.isNotEmpty).join(' · ')),
      trailing: const Icon(Icons.chevron_right), onTap: () => _detail(peer));
  }
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    List<Json>? peers;
    try { peers = decodePeerList(app.status); } on FormatException { peers = null; }
    final query = search.text.trim().toLowerCase();
    final visible = (peers ?? <Json>[]).where((p) =>
      (filter != 1 || p['online'] == true) && (filter != 2 || p['online'] == false) &&
      '${p['hostname']} ${p['os']} ${addresses(p).join(' ')}'.toLowerCase().contains(query)).toList()
      ..sort((a, b) { final online = (a['online'] == true ? 0 : 1).compareTo(b['online'] == true ? 0 : 1); return online != 0 ? online : string(a['hostname']).toLowerCase().compareTo(string(b['hostname']).toLowerCase()); });
    final showRows = visible.isNotEmpty && (!topology || topologyExpanded);
    return LayoutBuilder(builder: (context, constraints) {
      final inset = MediaQuery.sizeOf(context).width < 400 ? 12.0 : 24.0;
      final horizontal = ((constraints.maxWidth - 1120) / 2).clamp(inset, double.infinity);
      return CustomScrollView(slivers: [
        SliverPadding(padding: EdgeInsets.fromLTRB(horizontal, 16, horizontal, 0),
          sliver: SliverToBoxAdapter(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Section(title: l.web_exit_title, children: [
        InfoRow(l.web_net_exit_selection, selectedExitId(app.statusFresh ? app.exitRouting : null) == '' ? l.web_net_exit_local : selectedExitId(app.statusFresh ? app.exitRouting : null) ?? l.web_net_exit_unknown),
        Text(exitLabel(l, app.statusFresh ? app.exitRouting : null)),
        if (selectedExitId(app.exitRouting)?.isNotEmpty == true) OutlinedButton.icon(
          onPressed: writable && app.statusFresh ? _clearExit : null,
          icon: const Icon(Icons.close), label: Text(l.web_net_exit_clear)),
      ]),
      Section(title: l.web_peers_title, trailing: Wrap(children: [
        IconButton(tooltip: l.web_net_refresh, onPressed: app.statusLoading ? null : app.refreshStatus, icon: const Icon(Icons.refresh)),
        IconButton(tooltip: l.web_exit_test, onPressed: writable && app.statusFresh && !measuring ? _measure : null, icon: const Icon(Icons.speed)),
      ]), children: [
        if (app.statusLoading || measuring) const LinearProgressIndicator(),
        if (!app.statusFresh || peers == null) Notice(app.statusError ?? l.web_net_status_stale, error: app.statusError != null),
        Text(peers == null ? '—' : '${peers.length} ${l.web_net_peer_total} · ${peers.where((p) => p['online'] == true).length} ${l.web_net_filter_online}'),
        TextField(controller: search, decoration: InputDecoration(labelText: l.web_net_peers_search, prefixIcon: const Icon(Icons.search))),
        Wrap(spacing: 8, children: [for (var i = 0; i < 3; i++) ChoiceChip(label: Text([l.web_net_filter_all, l.web_net_filter_online, l.web_net_filter_offline][i]), selected: filter == i, onSelected: (_) => setState(() { filter = i; app.drafts['network.peerFilter'] = i; }))]),
        SegmentedButton<bool>(segments: [ButtonSegment(value: false, label: Text(l.web_peers_list), icon: const Icon(Icons.list)), ButtonSegment(value: true, label: Text(l.web_peers_topology), icon: const Icon(Icons.hub))], selected: {topology}, onSelectionChanged: (v) => setState(() { topology = v.single; app.drafts['network.peerTab'] = topology ? 1 : 0; })),
        Text('${visible.length} ${l.web_net_result_count}'),
        if (peers?.isEmpty == true) Notice(l.web_peers_empty)
        else if (peers != null && visible.isEmpty) ...[
          Notice(l.web_net_no_results),
          IconButton(tooltip: l.web_net_reset_filter, onPressed: () { search.clear(); setState(() { filter = 0; app.drafts['network.peerFilter'] = 0; }); }, icon: const Icon(Icons.filter_alt_off)),
        ] else if (topology) ...[
          _Topology(peers: visible, self: string(json(app.status?['self'])['hostname'], '—'), exitId: selectedExitId(app.exitRouting), selected: _detail),
          ExpansionTile(title: Text('${l.web_net_topology_list} · ${visible.length}'),
            initiallyExpanded: topologyExpanded,
            onExpansionChanged: (expanded) => setState(() { topologyExpanded = expanded; })),
        ],
      ]),
          ]))),
        if (showRows) SliverPadding(padding: EdgeInsets.fromLTRB(horizontal, 0, horizontal, 32),
          sliver: DecoratedSliver(
            decoration: BoxDecoration(color: Theme.of(context).colorScheme.surfaceContainerLow, borderRadius: BorderRadius.circular(12)),
            sliver: SliverPadding(padding: const EdgeInsets.all(16),
              sliver: SliverList.builder(itemCount: visible.length, itemBuilder: (context, index) => _row(visible[index]))))),
        if (!showRows) const SliverToBoxAdapter(child: SizedBox(height: 32)),
      ]);
    });
  }
}

class _Topology extends StatelessWidget {
  const _Topology({required this.peers, required this.self, required this.exitId, required this.selected});
  final List<Json> peers;
  final String self;
  final String? exitId;
  final void Function(Json) selected;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n, shown = diagramPeers(peers);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      ListTile(leading: const Icon(Icons.router), title: Text(self), subtitle: Text('${shown.length} / ${peers.length} ${l.web_net_peer_total}')),
      for (var rank = 0; rank < 3; rank++) if (shown.any((p) => pathRank(p) == rank)) Card.filled(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text([l.web_net_topo_direct, l.web_net_topo_relay, l.web_net_filter_offline][rank], style: Theme.of(context).textTheme.titleSmall),
        const Divider(),
        Wrap(spacing: 8, runSpacing: 8, children: [for (final peer in shown.where((p) => pathRank(p) == rank))
          ActionChip(avatar: Icon(exitId == peer['id'] ? Icons.exit_to_app : rank == 0 ? Icons.link : rank == 1 ? Icons.cloud_outlined : Icons.link_off),
            tooltip: '${l.web_net_peer_details}: ${peer['hostname']} · ${addresses(peer).join(' · ')}',
            label: Text('${peer['hostname']}${rank == 1 ? ' · ${string(peer['relay'], '—')}' : ''}${exitId == peer['id'] ? ' · ${l.web_net_topo_exit}' : ''}'), onPressed: () => selected(peer)),
        ]),
      ]))),
    ]);
  }
}

class _PeerDetail extends StatefulWidget {
  const _PeerDetail({required this.app, required this.peer, required this.latency, required this.tested});
  final AppState app;
  final Json peer;
  final num? latency;
  final bool tested;
  @override
  State<_PeerDetail> createState() => _PeerDetailState();
}
class _PeerDetailState extends NetworkPageState<_PeerDetail> {
  @override
  AppState get app => widget.app;
  final probes = <String, String>{};
  String? checking;
  late final int initialAccount;
  @override
  void initState() { super.initState(); initialAccount = app.accountRevision; }
  @override
  void invalidated() { probes.clear(); checking = null; }
  Json? get livePeer {
    if (initialAccount != app.accountRevision) return null;
    try {
      for (final peer in decodePeerList(app.status)) {
        if (peer['id'] == widget.peer['id']) return peer;
      }
    } on FormatException { return null; }
    return null;
  }
  Future<void> _ping(String ip) async {
    if (!app.statusFresh || !writable || livePeer == null || !addresses(livePeer!).contains(ip)) return;
    setState(() { checking = ip; probes.remove(ip); });
    await run(() async {
      final result = await probeCurrent(context.l10n.web_net_peer_probe, ['peer-ping', string(widget.peer['id']), ip]);
      if (!mounted || result == null || livePeer == null || !addresses(livePeer!).contains(ip)) return;
      final l = context.l10n;
      final path = switch (result['path']) { 'direct' => l.web_net_peer_direct, 'derp' => 'DERP', 'peer-relay' => l.web_net_peer_relay, _ => l.web_net_unknown };
      setState(() { probes[ip] = validProbe(result, string(widget.peer['id']), ip) ? '$path · ${result['latencyMs']} ms ${result['via']}' : string(result['error'], l.web_net_peer_probe_invalid); });
    });
    if (mounted) setState(() { checking = null; });
  }
  Future<void> _exit(bool clear) => run(() async {
    final account = app.accountRevision;
    if (!await confirm(context, context.l10n.web_exit_title, context.l10n.network_interrupt) || !mounted || account != app.accountRevision || !app.statusFresh || !writable || livePeer == null) return;
    if (!clear && livePeer!['online'] != true) return;
    requireOk(await app.submit(context.l10n.web_exit_title, clear ? ['exitnode-clear'] : ['exitnode-set', string(widget.peer['id'])]));
    await app.refreshStatus();
  });
  @override
  Widget build(BuildContext context) {
    final l = context.l10n, peer = livePeer ?? widget.peer;
    final sameAccount = initialAccount == app.accountRevision;
    final fresh = sameAccount && app.statusFresh && livePeer != null;
    final route = fresh ? app.exitRouting : null;
    final current = selectedExitId(route) == peer['id'];
    return PageBody(children: [
      Row(children: [Expanded(child: Text(l.web_peers_detail, style: Theme.of(context).textTheme.titleLarge)), IconButton(tooltip: l.web_close, onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close))]),
      if (!sameAccount) Notice(l.web_net_status_stale) else Section(title: string(peer['hostname']), children: [
        if (!fresh) Notice(l.web_net_status_stale),
        Text(peer['online'] == true ? l.web_net_filter_online : l.web_net_filter_offline),
        for (final ip in addresses(peer)) ...[
          ListTile(title: SelectableText(ip), trailing: IconButton(tooltip: l.web_net_copy_address, onPressed: () => copyText(context, ip), icon: const Icon(Icons.copy))),
          OutlinedButton.icon(onPressed: fresh && writable && checking == null ? () => _ping(ip) : null, icon: const Icon(Icons.network_ping), label: Text('${l.web_net_peer_probe} ${ip.contains(':') ? 'IPv6' : 'IPv4'}')),
          if (checking == ip) const LinearProgressIndicator(),
          if (probes[ip] != null) Notice(probes[ip]!),
        ],
        InfoRow(l.web_net_os, string(peer['os'], '—')),
        InfoRow(l.web_net_relay_region, string(peer['relay'], '—')),
        InfoRow(l.web_peers_rx, peer['rxBytes'] is num ? formatBytes(number(peer['rxBytes'])) : '—'),
        InfoRow(l.web_peers_tx, peer['txBytes'] is num ? formatBytes(number(peer['txBytes'])) : '—'),
        if (peer['exitNodeOption'] == true) ...[
          Text(exitLabel(l, route)),
          if (route?['selected'] != null && app.status?['mode'] == 'bridge') InfoRow(l.web_net_exit_scope, '${string(route?['scope'])} ${route?['uids'] is List ? (route!['uids'] as List).join(', ') : ''}'),
          InfoRow(l.web_exit_title, '${current ? l.web_exit_current : l.web_net_enabled} · ${!widget.tested ? l.web_net_exit_untested : widget.latency == null ? l.web_net_exit_unreachable : '${widget.latency} ms'}'),
          if (current && peer['online'] == false) Notice(l.web_net_exit_unavailable),
          OutlinedButton.icon(onPressed: fresh && writable && selectedExitId(route) != null && (current || peer['online'] == true) ? () => _exit(current) : null,
            icon: Icon(current ? Icons.close : Icons.check_circle_outline), label: Text(current ? l.web_net_exit_clear : l.web_net_exit_apply)),
        ],
      ]),
    ]);
  }
}
