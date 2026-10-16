import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'config_scope.dart';
import 'settings_rules.dart';
import 'settings_state.dart';

class RoutingPage extends StatefulWidget {
  const RoutingPage({super.key, required this.app});
  final AppState app;
  @override State<RoutingPage> createState() => _RoutingPageState();
}

class _RoutingPageState extends ConfigState<RoutingPage> {
  @override AppState get app => widget.app;
  late final SettingsDraft draft;
  late final TextEditingController subnetInput, search;
  final acceptance = RouteAcceptance();
  String scope = 'all', mode = '?';
  Set<String> uids = {}, subnets = {}, savedSubnets = {}, skippedIpv6 = {};
  List<Json>? apps;
  bool routesKnown = false, ownerKnown = false, ownerAvailable = false, reading = false, saving = false, loadingApps = false, savedPending = false;
  int limit = 100, appsRevision = 0;
  String? routesError, acceptanceError, appsError, subnetError, capabilityError, applyError;
  bool get selectedOnly => app.drafts['routing.selectedOnly'] == true;
  bool get editable => routesKnown && !saving && writable;
  bool get perApp => mode == 'bridge' && ownerKnown && ownerAvailable;
  String get snapshot => jsonEncode([scope, uids.join('\n'), subnets.join('\n')]);
  bool get ipv6Enabled => acceptance.value['ipv6Enabled'] == true;
  Set<String> get pendingIpv6 => ipv6Enabled ? {} : {for (final cidr in savedSubnets) if (cidr.contains(':') && (acceptance.known || skippedIpv6.contains(cidr))) cidr};
  @override void initState() {
    draft = SettingsDraft(app.drafts, 'routing.rules');
    if (draft.value.isNotEmpty) _decode(draft.value);
    subnetInput = TextEditingController(text: app.drafts['routing.newSubnet'] as String? ?? '');
    search = TextEditingController(text: app.drafts['routing.search'] as String? ?? '');
    super.initState();
  }
  void _decode(String value) {
    final parsed = jsonDecode(value) as List;
    scope = parsed[0] as String; uids = parseUids(parsed[1] as String); subnets = canonicalCidrs(parsed[2] as String);
  }
  void _remember() { draft.value = snapshot; }
  @override void invalidate() {
    routesKnown = false; ownerKnown = false; acceptance.known = false; acceptance.revision++; acceptance.reading = false; acceptance.busy = false;
    reading = false; appsRevision++; loadingApps = false;
  }
  @override Future<void> refresh() async {
    if (reading || saving || !app.foreground) return;
    reading = true;
    final ticket = ++generation, account = app.accountRevision;
    await Future.wait([
      () async {
        try {
          final result = await read(['routes-get']);
          if (!mounted || !current(ticket, account)) return;
          if (result['uids'] is! List || result['subnets'] is! List || !['all', 'selected', 'bypass'].contains(result['scope'])) throw FormatException(context.l10n.cs_invalid_response);
          final incomingUids = parseUids((result['uids'] as List).join('\n')), incomingSubnets = canonicalCidrs((result['subnets'] as List).join('\n'));
          setState(() {
            savedSubnets = incomingSubnets;
            draft.receive(jsonEncode([result['scope'], incomingUids.join('\n'), incomingSubnets.join('\n')]));
            _decode(draft.value); routesKnown = true; routesError = null;
          });
          _ensureApps();
        } catch (error) { if (current(ticket, account)) setState(() { routesKnown = false; routesError = failureMessage(error); }); }
      }(),
      () async {
        try {
          final result = await read(['owner-capability']);
          if (!mounted || !current(ticket, account)) return;
          if (result['available'] is! bool) throw FormatException(context.l10n.cs_invalid_response);
          setState(() { ownerKnown = true; ownerAvailable = result['available'] as bool; capabilityError = null; }); _ensureApps();
        } catch (error) { if (current(ticket, account)) setState(() { ownerKnown = false; capabilityError = failureMessage(error); }); }
      }(),
      () async {
        try { final result = await read(['status']); if (current(ticket, account)) { setState(() => mode = string(result['mode'], '?')); _ensureApps(); } }
        catch (error) { if (current(ticket, account)) setState(() { mode = '?'; capabilityError = failureMessage(error); }); }
      }(),
      if (!acceptance.busy) _readAcceptance(),
    ]);
    if (current(ticket, account)) setState(() => reading = false);
  }
  Future<void> _readAcceptance([bool? expected]) async {
    if (acceptance.reading && !acceptance.busy) return;
    final ticket = acceptance.beginRead(expected), account = app.accountRevision;
    try {
      final result = await read(['subnet-routes-get']);
      if (!mounted || !app.foreground || account != app.accountRevision) return;
      if (acceptance.receive(ticket, result)) {
        setState(() {
          mode = string(result['mode']);
          acceptanceError = expected != null && acceptance.on != expected ? context.l10n.web_tools_subnet_mismatch : null;
        });
        _ensureApps();
      }
    } catch (error) {
      if (mounted && account == app.accountRevision && ticket == acceptance.revision) setState(() { acceptance.fail(ticket); acceptanceError = failureMessage(error); });
    }
  }
  Future<void> _accept(bool next) async {
    final l = context.l10n;
    if (!acceptance.enabled || !writable || next == acceptance.on) return;
    if (!await confirm(context, l.web_tools_subnet_accept, next ? l.web_tools_subnet_enable_confirm : l.web_tools_subnet_disable_confirm) || !mounted || !acceptance.enabled || !writable) return;
    setState(acceptance.beginWrite);
    bool? expected;
    await perform(context, () async {
      final result = await app.submit(l.web_tools_subnet_accept, ['subnet-routes-set', next ? 'on' : 'off']);
      if (result['ok'] != true) throw StateError(string(result['error'], l.web_tools_subnet_unconfirmed));
      expected = next;
    });
    if (mounted) await _readAcceptance(expected);
  }
  void _ensureApps() { if (perApp && scope != 'all' && apps == null && !loadingApps) _loadApps(); }
  Future<void> _loadApps() async {
    if (loadingApps) return;
    setState(() { loadingApps = true; appsError = null; });
    final ticket = ++appsRevision, account = app.accountRevision;
    try {
      final result = await read(['apps']);
      if (!mounted || !app.foreground || ticket != appsRevision || account != app.accountRevision) return;
      if (result['apps'] is! List) throw FormatException(context.l10n.cs_invalid_response);
      final list = <Json>[];
      for (final value in objects(result['apps'])) {
        try {
          final uid = parseUids(value['uid'] is int ? '${value['uid']}' : string(value['uid']));
          if (uid.length == 1) list.add({...value, 'uid': uid.single});
        } on FormatException { continue; }
      }
      list.sort((a, b) => string(a['label']).toLowerCase().compareTo(string(b['label']).toLowerCase()));
      setState(() { apps = list; loadingApps = false; });
    } catch (error) { if (mounted && ticket == appsRevision && account == app.accountRevision) setState(() { loadingApps = false; appsError = failureMessage(error); }); }
  }
  void _addSubnet() {
    if (!editable) return;
    String value;
    try { value = canonicalCidr(subnetInput.text); }
    on FormatException { setState(() => subnetError = context.l10n.web_route_subnets_invalid); return; }
    setState(() {
      if (!subnets.add(value)) { subnetError = context.l10n.web_tools_route_duplicate; return; }
      subnetInput.clear(); app.drafts['routing.newSubnet'] = ''; subnetError = null; _remember();
    });
  }
  Future<void> _reload() async {
    final l = context.l10n;
    if (!await confirm(context, l.cs_reload_draft, l.cs_reload_confirm) || !mounted) return;
    final ticket = ++generation, account = app.accountRevision;
    reading = false;
    await perform(context, () async {
      final result = await read(['routes-get']);
      if (!current(ticket, account)) return;
      if (result['uids'] is! List || result['subnets'] is! List || !['all', 'selected', 'bypass'].contains(result['scope'])) throw FormatException(l.cs_invalid_response);
      final incoming = jsonEncode([result['scope'], parseUids((result['uids'] as List).join('\n')).join('\n'), canonicalCidrs((result['subnets'] as List).join('\n')).join('\n')]);
      setState(() { draft.receive(incoming, discard: true); _decode(incoming); savedSubnets = Set.of(subnets); routesKnown = true; routesError = null; });
      _ensureApps();
    });
  }
  Future<void> _save() async {
    final l = context.l10n;
    if (!editable || scope != 'all' && !perApp) return;
    final original = snapshot, savedScope = scope, submittedUids = uids.join('\n'), submittedSubnets = subnets.join('\n');
    if (!await confirm(context, l.web_tools_apply_rules, '${draft.conflict() ? '${l.cs_draft_conflict}\n\n' : ''}${l.cs_network_warning}') || !mounted || !editable || snapshot != original || scope != 'all' && !perApp) return;
    setState(() { saving = true; generation++; reading = false; });
    final account = app.accountRevision;
    await perform(context, () async {
      final result = await app.submit(l.web_tools_apply_rules, ['routes-set', savedScope, submittedUids.isEmpty ? '-' : submittedUids.replaceAll('\n', ','), submittedSubnets.isEmpty ? '-' : submittedSubnets.replaceAll('\n', ',')]);
      if (result['ok'] != true) throw StateError(string(result['applyError'], string(result['error'], l.web_op_failed)));
      if (!mounted || account != app.accountRevision) return;
      final actual = result['subnets'] is List ? canonicalCidrs((result['subnets'] as List).join('\n')).join('\n') : submittedSubnets;
      setState(() {
        final normalized = jsonEncode([savedScope, submittedUids, actual]);
        draft.submitted(original, normalized); _decode(draft.value); savedSubnets = canonicalCidrs(actual);
        skippedIpv6 = result['ipv6Skipped'] is List ? canonicalCidrs((result['ipv6Skipped'] as List).join('\n')) : {};
        final failure = string(result['applyError']);
        savedPending = result['applied'] != true || result['restartRequired'] == true || failure.isNotEmpty;
        applyError = failure.isEmpty ? null : failure;
      });
      app.message(result['requiresIpv6'] == true ? l.web_tools_subnet_ipv6_saved : savedPending ? l.web_tools_saved_pending : l.web_route_apply_done);
      await app.refreshSettings();
    });
    if (mounted) { setState(() => saving = false); await refresh(); }
  }
  List<Widget> _advertised() {
    final l = context.l10n;
    final rows = <Widget>[];
    bool hasIpv6 = false;
    for (final peer in objects(acceptance.value['peers'])) {
      final routes = <String, bool>{};
      for (final item in objects(peer['routes'])) {
        if (!validCidr(string(item['cidr']))) continue;
        final cidr = canonicalCidr(string(item['cidr']));
        if (cidr == '0.0.0.0/0' || cidr == '::/0') continue;
        routes[cidr] = routes[cidr] == true || item['primary'] == true;
      }
      if (routes.isEmpty) continue;
      rows.add(ListTile(contentPadding: EdgeInsets.zero, leading: Icon(Icons.router_outlined, semanticLabel: peer['online'] == true ? l.web_tools_subnet_online : l.web_offline), title: Text(string(peer['hostname'], string(peer['id']))), subtitle: Text(peer['online'] == true ? l.web_tools_subnet_online : l.web_offline)));
      for (final entry in routes.entries) {
        final cidr = entry.key; hasIpv6 |= cidr.contains(':');
        final added = subnets.contains(cidr);
        rows.add(ListTile(contentPadding: EdgeInsets.zero, title: SelectableText(cidr), subtitle: entry.value ? Text(l.web_tools_subnet_primary) : null, trailing: IconButton(tooltip: '${added ? l.web_tools_subnet_added : l.web_tools_subnet_add_network} $cidr', onPressed: editable && acceptance.known && !added && (!cidr.contains(':') || ipv6Enabled) ? () => setState(() { subnets.add(cidr); _remember(); }) : null, icon: Icon(added ? Icons.check_circle_outline : Icons.add))));
      }
    }
    if (rows.isEmpty) rows.add(Notice(acceptance.known ? l.web_tools_subnet_empty : l.web_tools_subnet_unknown));
    if (hasIpv6 && (!acceptance.known || !ipv6Enabled)) rows.add(_ipv6Notice());
    return rows;
  }
  Widget _ipv6Notice() {
    final l = context.l10n;
    return Row(children: [Expanded(child: Notice(acceptance.known ? l.web_tools_subnet_ipv6_disabled : l.web_tools_subnet_ipv6_unknown)), IconButton(tooltip: l.web_set_title, onPressed: () => app.navigate('settings'), icon: const Icon(Icons.settings_outlined))]);
  }
  Widget _apps() {
    final l = context.l10n, matches = matchingApps(apps ?? [], uids, search.text, selectedOnly);
    return Section(title: l.web_route_apps, trailing: IconButton(tooltip: l.web_retry, onPressed: loadingApps ? null : _loadApps, icon: const Icon(Icons.refresh)), children: [
      TextField(controller: search, decoration: InputDecoration(labelText: l.web_tools_search_apps, prefixIcon: const Icon(Icons.search)), onChanged: (value) => setState(() { app.drafts['routing.search'] = value; limit = 100; })),
      Wrap(spacing: 12, crossAxisAlignment: WrapCrossAlignment.center, children: [Text('${l.web_tools_selected} ${uids.length} ${l.web_tools_items}'), FilterChip(label: Text(l.web_tools_selected), selected: selectedOnly, onSelected: (value) => setState(() { app.drafts['routing.selectedOnly'] = value; limit = 100; }))]),
      if (scope == 'selected' && uids.isEmpty) Notice(l.web_tools_route_empty_selection),
      if (loadingApps) const LinearProgressIndicator(),
      if (appsError != null) Notice(appsError!, error: true),
      if (apps != null && matches.isEmpty) Notice(l.web_empty),
      if (matches.isNotEmpty) SizedBox(height: 400, child: ListView.builder(itemCount: matches.length.clamp(0, limit).toInt(), itemBuilder: (context, index) {
        final value = matches[index], uid = string(value['uid']);
        return CheckboxListTile(title: Text(string(value['label'])), subtitle: Text('${string(value['package'])} · UID $uid'), value: uids.contains(uid), onChanged: editable && perApp && scope != 'all' ? (selected) => setState(() { if (selected == true) { uids.add(uid); } else { uids.remove(uid); } _remember(); }) : null);
      })),
      if (matches.length > limit) IconButton(tooltip: '${l.web_tools_route_show_all} (${matches.length - limit})', onPressed: () => setState(() => limit += 100), icon: const Icon(Icons.expand_more)),
    ]);
  }
  @override Widget build(BuildContext context) {
    final l = context.l10n;
    final pending = pendingIpv6;
    final state = !routesKnown ? l.web_tools_route_load_error : draft.conflict() ? l.cs_draft_conflict : draft.dirty ? l.web_tools_route_pending : savedPending || pending.isNotEmpty ? l.web_tools_saved_pending : l.web_tools_route_saved;
    return Column(children: [Expanded(child: PageBody(children: [
      Section(title: l.web_tools_subnet_accept, trailing: IconButton(tooltip: l.web_tools_subnet_refresh, onPressed: acceptance.reading || acceptance.busy ? null : _readAcceptance, icon: const Icon(Icons.refresh)), children: [
        SwitchListTile.adaptive(contentPadding: EdgeInsets.zero, title: Text(l.web_tools_subnet_accept), value: acceptance.on, onChanged: acceptance.enabled && writable ? _accept : null),
        Notice(mode == 'bridge' ? l.web_tools_subnet_bridge_hint : mode == 'proxy' ? l.web_tools_subnet_proxy_hint : l.web_tools_subnet_native_hint),
        if (acceptanceError != null) Notice('${l.web_tools_subnet_unknown}\n$acceptanceError', error: true),
      ]),
      Section(title: l.web_tools_subnet_title, children: _advertised()),
      Section(title: l.web_tools_route_targets, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: TextField(controller: subnetInput, enabled: editable, decoration: InputDecoration(labelText: l.web_route_subnets, hintText: l.web_route_subnets_add_hint, errorText: subnetError), onChanged: (value) => setState(() { app.drafts['routing.newSubnet'] = value; subnetError = null; }))), IconButton(tooltip: l.web_add, onPressed: editable && subnetInput.text.trim().isNotEmpty ? _addSubnet : null, icon: const Icon(Icons.add))]),
        for (final cidr in subnets) ListTile(contentPadding: EdgeInsets.zero, title: SelectableText(cidr), trailing: IconButton(tooltip: '${l.web_delete} $cidr', onPressed: editable ? () => setState(() { subnets.remove(cidr); _remember(); }) : null, icon: const Icon(Icons.delete_outline))),
        if (subnets.isEmpty) Notice(l.web_tools_route_empty_subnets),
        if (subnets.any((value) => value.contains(':')) && (!acceptance.known || !ipv6Enabled)) _ipv6Notice(),
      ]),
      Section(title: l.web_tools_route_policy, children: [
        if (mode == 'tun') Notice(l.web_route_native_scope),
        if (!ownerKnown) Notice(capabilityError ?? l.web_tools_route_probe) else if (!ownerAvailable) Notice(l.web_route_no_owner),
        RadioGroup<String>(groupValue: scope, onChanged: (value) {
          if (value == null || !editable || value != 'all' && !perApp) return;
          setState(() { scope = value; _remember(); }); _ensureApps();
        }, child: Column(children: [
          for (final value in ['all', 'selected', 'bypass']) RadioListTile<String>(title: Text(value == 'all' ? l.web_route_scope_all : value == 'selected' ? l.web_route_scope_selected : l.web_route_scope_bypass), subtitle: Text(value == 'all' ? l.web_route_scope_all_hint : value == 'selected' ? l.web_route_scope_selected_hint : l.web_route_scope_bypass_hint), value: value, enabled: editable && (value == 'all' || perApp)),
        ])),
      ]),
      if (perApp && scope != 'all') _apps(),
      if (routesError != null) Notice(routesError!, error: true),
      if (applyError != null) Notice(applyError!, error: true),
      if (!routesKnown || routesError != null) IconButton(tooltip: l.web_retry, onPressed: reading ? null : refresh, icon: const Icon(Icons.refresh)),
      if (!draft.dirty && pending.isNotEmpty) Notice('${l.web_tools_subnet_ipv6_saved}\n${pending.join('\n')}'),
    ])), Material(elevation: 3, child: SafeArea(top: false, child: Padding(padding: const EdgeInsets.all(12), child: Wrap(spacing: 12, crossAxisAlignment: WrapCrossAlignment.center, children: [
      Text(state), FilledButton.icon(onPressed: editable && (draft.dirty || applyError != null) && (scope == 'all' || perApp) ? _save : null, icon: const Icon(Icons.check), label: Text(l.web_tools_apply_rules)),
      if (draft.dirty || draft.conflict()) IconButton(tooltip: l.cs_reload_draft, onPressed: saving ? null : _reload, icon: const Icon(Icons.restore)),
    ])))),]);
  }
  @override void dispose() { subnetInput.dispose(); search.dispose(); super.dispose(); }
}
