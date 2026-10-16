import 'dart:async';
import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'network_labels.dart';
import 'network_rules.dart';
import 'network_state.dart';
import 'coexist_page.dart';

class TunnelPage extends StatefulWidget {
  const TunnelPage({super.key, required this.app});
  final AppState app;
  @override
  State<TunnelPage> createState() => _TunnelPageState();
}
class _TunnelPageState extends NetworkPageState<TunnelPage> {
  @override
  AppState get app => widget.app;
  Json? tun, dns, socks, derp;
  bool loading = false, dnsLoading = false, socksLoading = false, derpLoading = false;
  String? tunError, dnsError, socksError, derpError;
  Timer? timer;
  int pollTick = 0;
  @override
  void initState() {
    super.initState();
    timer = Timer.periodic(const Duration(seconds: 15), (_) {
      pollTick++;
      if (app.foreground && app.autoRefresh && (!app.powerSave || pollTick.isEven) && !app.busy) unawaited(_loadTun());
    });
  }
  @override
  void load() { _loadTun(); }
  @override
  void invalidated() {
    tun = null; dns = null; socks = null; derp = null;
    loading = false; dnsLoading = false; socksLoading = false; derpLoading = false;
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted && app.foreground) _loadTun(); });
  }
  @override
  void dispose() { timer?.cancel(); super.dispose(); }
  Future<void> _loadTun() async {
    if (loading || !app.foreground) return;
    final ticket = generation;
    setState(() { loading = true; tunError = null; });
    try {
      final result = await readCurrent(['tun']);
      if (result != null) setState(() { tun = result; });
    } catch (e) { if (mounted && ticket == generation) setState(() { tunError = failureMessage(e); }); }
    finally { if (mounted && ticket == generation) setState(() { loading = false; }); }
  }
  Future<void> _dns() async {
    if (dnsLoading || !app.foreground) return;
    final ticket = generation;
    setState(() { dnsLoading = true; dns = null; dnsError = null; });
    try {
      final result = await readCurrent(['dns']);
      if (result != null) { requireOk(result); setState(() { dns = result; }); }
    } catch (e) { if (mounted && ticket == generation) setState(() { dnsError = failureMessage(e); }); }
    finally { if (mounted && ticket == generation) setState(() { dnsLoading = false; }); }
  }
  Future<void> _probe(bool relay) async {
    if (!writable || relay && derpLoading || !relay && socksLoading) return;
    final ticket = generation;
    setState(() { if (relay) { derpLoading = true; derp = null; derpError = null; } else { socksLoading = true; socks = null; socksError = null; } });
    try {
      final result = await probeCurrent(relay ? context.l10n.web_tun_derp : context.l10n.web_tun_socks_check, [relay ? 'derp-speedtest' : 'socks-check']);
      if (!mounted || result == null) return;
      requireOk(result);
      if (relay ? result['relays'] is! List : result['success'] is! bool || !measured(result['elapsedMs']) || result['httpCode'] is! String) throw FormatException(context.l10n.web_net_peer_probe_invalid);
      setState(() { if (relay) { derp = result; } else { socks = result; } });
    } catch (e) { if (mounted && ticket == generation) setState(() { if (relay) { derpError = failureMessage(e); } else { socksError = failureMessage(e); } }); }
    finally { if (mounted && ticket == generation) setState(() { if (relay) { derpLoading = false; } else { socksLoading = false; } }); }
  }
  @override
  Widget build(BuildContext context) {
    final l = context.l10n, mode = string(tun?['mode']);
    final endpoint = numericEndpoint(tun?['socksPort']);
    final supportsSocks = const ['bridge', 'proxy'].contains(mode);
    return PageBody(children: [
      Section(title: l.web_tools_tunnel_overview, trailing: IconButton(tooltip: l.web_tools_refresh, onPressed: loading ? null : _loadTun, icon: const Icon(Icons.refresh)), children: [
        if (loading) const LinearProgressIndicator(),
        if (tunError != null) Notice('${l.web_net_status_stale}\n$tunError', error: true),
        if (!app.statusFresh) Notice(l.web_net_status_stale),
        if (tun == null && !loading) Notice(l.network_unknown),
        if (tun != null) ...[
          Text(mode == 'tun' ? l.web_tools_tun_desc : mode == 'proxy' ? l.web_tools_proxy_desc : mode == 'bridge' ? l.web_tools_bridge_desc : l.network_unknown),
          InfoRow(l.web_coexist_applied_mode, mode.isEmpty ? l.network_unknown : mode),
          InfoRow(l.web_tun_iface, 'tailscale0 · ${tun!['ifaceUp'] == true ? l.web_tun_up : tun!['ifaceUp'] == false ? l.web_tun_down : l.network_unknown}'),
          InfoRow(l.web_tun_gateway, string(tun!['gateway'], '—')),
          if (mode == 'bridge') InfoRow(l.web_tun_hev, tun!['hevPid'] is num && number(tun!['hevPid']) > 0 ? 'PID ${tun!['hevPid']}' : tun!.containsKey('hevPid') && tun!['hevPid'] == null ? l.web_tun_not_running : l.network_unknown),
          IconButton(tooltip: l.web_more_routing, onPressed: () => app.navigate('routing'), icon: const Icon(Icons.alt_route)),
        ],
      ]),
      Section(title: l.web_dns_title, trailing: IconButton(tooltip: l.web_tools_dns_settings, onPressed: () => app.navigate('settings'), icon: const Icon(Icons.settings)), children: [
        if (dnsLoading) const LinearProgressIndicator(),
        if (dnsError != null) Notice(dnsError!, error: true),
        if (dns == null && !dnsLoading && dnsError == null) Notice(l.web_tools_dns_unchecked),
        if (dns != null) ...[
          Text(dnsLabel(l, dns!), style: Theme.of(context).textTheme.titleMedium),
          if (!modernDns(dns!)) ...[
            InfoRow(l.web_tools_dns_ipv6_path, ipv6DnsLabel(l, dns!)),
            if (dns!['ipv6DnsInterception'] == 'fallback') Notice(l.web_tools_dns_ipv6_fallback_hint),
            InfoRow(l.web_dns_native, dns!['upstreamNative'] == true ? l.web_tools_dns_native_yes : dns!['upstreamNative'] == false ? l.web_tools_dns_native_no : l.network_unknown),
          ],
          if (dnsEndpoint(dns!) != null) ListTile(title: Text(l.web_tools_dns_endpoint), subtitle: SelectableText(dnsEndpoint(dns!)!), trailing: IconButton(tooltip: l.web_tools_dns_endpoint_copy, onPressed: () => copyText(context, dnsEndpoint(dns!)!), icon: const Icon(Icons.copy))),
          if (dns!['mode'] == 'transparent' && dns!['listenerReady'] == true) Notice(dns!['reason'] == 'transparent-unavailable' ? l.web_tools_dns_transparent_unavailable : l.web_tools_dns_transparent_limit),
          if (string(dns!['suffix']).isNotEmpty) InfoRow(l.web_dns_suffix, string(dns!['suffix'])),
        ],
        OutlinedButton.icon(onPressed: dnsLoading ? null : _dns, icon: const Icon(Icons.network_check), label: Text(dns == null ? l.web_dns_check : l.web_tools_dns_check_again)),
      ]),
      CoexistPanel(app: app),
      if (supportsSocks) Section(title: l.web_tun_socks_check, children: [
        InfoRow('SOCKS5', endpoint ?? l.network_unknown),
        if (socksLoading) const LinearProgressIndicator(),
        if (socksError != null) Notice(socksError!, error: true),
        if (socks != null) Notice('${socks!['success'] == true ? l.web_tun_socks_ok : l.web_tun_socks_fail} · HTTP ${socks!['httpCode']} · ${socks!['elapsedMs']} ms${string(socks!['error']).isEmpty ? '' : '\n${socks!['error']}'}', error: socks!['success'] != true),
        OutlinedButton.icon(onPressed: writable && app.statusFresh && tunError == null && endpoint != null && !socksLoading ? () => _probe(false) : null, icon: const Icon(Icons.network_check), label: Text(l.web_tun_socks_check)),
      ]),
      Section(title: l.web_tun_derp, children: [
        if (derpLoading) const LinearProgressIndicator(),
        if (derpError != null) Notice(derpError!, error: true),
        if (derp != null && objects(derp!['relays']).isEmpty) Notice(l.web_peers_empty),
        for (final relay in objects(derp?['relays'])) ListTile(title: Text(string(relay['code'], '—')),
          subtitle: relay['code'] == derp?['preferred'] ? Text(l.web_tun_preferred) : null,
          trailing: Text(measured(relay['latencyMs']) ? '${relay['latencyMs']} ms' : '—')),
        OutlinedButton.icon(onPressed: writable && !derpLoading ? () => _probe(true) : null, icon: const Icon(Icons.speed), label: Text(l.web_tun_derp)),
      ]),
    ]);
  }
}
