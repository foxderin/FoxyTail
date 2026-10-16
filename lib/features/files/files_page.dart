import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';

import 'files_browser.dart';
import 'files_state.dart';

class FilesPage extends StatefulWidget {
  const FilesPage({super.key, required this.app});
  final AppState app;

  @override
  State<FilesPage> createState() => _FilesPageState();
}

class _ReadSection {
  bool loaded = false;
  String? error;
  Future<void>? pending;
  int generation = 0;
  bool get loading => pending != null;
  void invalidate() { generation++; loaded = false; error = null; pending = null; }
}

class _FilesPageState extends State<FilesPage> with SingleTickerProviderStateMixin {
  AppState get app => widget.app;
  late final String owner = 'files-${identityHashCode(this)}';
  late final TabController tabs;
  late final TextEditingController search;
  final inboxRead = _ReadSection(), targetsRead = _ReadSection(), historyRead = _ReadSection();
  final selected = <String>{}, removedTransfers = <String>{};
  List<Json> inbox = [], ordered = [], peers = [], history = [];
  int sort = 0, ignored = 0, account = 0, historyRevision = 0, filesRevision = -1;
  String? peerId;
  String transferFingerprint = '', fileResultFingerprint = '', adoptedJob = '';
  bool wasVisible = false, wasBusy = false, invoking = false, recovering = false;
  String? operationNotice;
  bool operationFailed = false;

  bool get visible => app.destination == 'files' && app.foreground;
  Json get transfer => app.bridge.transfer;
  Json get files => app.bridge.files;
  bool get transferBusy => boolean(transfer['busy']);
  bool get recoveryRequired => boolean(transfer['recoveryRequired']) ||
      boolean(transfer['preparing']) || string(transfer['request']).isNotEmpty || string(transfer['staged']).isNotEmpty;
  bool get filePending => boolean(files['pending']);
  bool get locked => invoking || app.busy || transferBusy || filePending;
  bool get canClearSources => !invoking && !app.busy && !transferBusy && !recoveryRequired &&
      (!filePending || boolean(files['resolving'])) && (sources.isNotEmpty || boolean(files['resolving']));
  bool get inboxReady => inboxRead.loaded && !inboxRead.loading && inboxRead.error == null && !locked;
  bool get targetsReady => targetsRead.loaded && targetsRead.error == null && !targetsRead.loading;
  bool get historyReady => historyRead.loaded && historyRead.error == null && !historyRead.loading;
  bool get sendReady => app.canWrite && !locked && !recoveryRequired && targetsReady && historyReady &&
      !history.any(activeTransfer);
  List<Json> get sources => objects(files['selection']);
  List<Json> get matches {
    final query = search.text.toLowerCase();
    return query.isEmpty ? ordered : ordered.where((item) => string(item['name']).toLowerCase().contains(query)).toList();
  }

  @override
  void initState() {
    super.initState();
    account = app.accountRevision;
    final draft = json(app.drafts['files']);
    sort = number(draft['sort']).toInt().clamp(0, 3);
    peerId = draft['account'] == account && draft['peer'] is String ? draft['peer'] as String : null;
    search = TextEditingController(text: string(draft['search']));
    final names = draft['selected'];
    if (names is List && names.length <= maxSelectedFiles) {
      selected.addAll(names.whereType<String>().where(validFileName));
    }
    tabs = TabController(length: 3, vsync: this, initialIndex: number(draft['tab']).toInt().clamp(0, 2));
    tabs.addListener(_saveDraft);
    search.addListener(_searchChanged);
    app.addListener(_onUpdate);
    app.bridge.addListener(_onUpdate);
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _onUpdate(); });
  }

  void _saveDraft() {
    app.drafts['files'] = {'sort': sort, 'search': search.text, 'selected': selected.toList(),
      'peer': peerId, 'account': account, 'tab': tabs.index};
    if (mounted) setState(() {});
  }

  void _searchChanged() => _saveDraft();

  void _onUpdate() {
    if (!mounted) return;
    if (account != app.accountRevision) {
      account = app.accountRevision;
      for (final part in ['targets', 'history']) { app.bridge.cancelReads('$owner-$part'); }
      targetsRead.invalidate(); historyRead.invalidate();
      peers = []; history = []; peerId = null; adoptedJob = ''; transferFingerprint = '';
      removedTransfers.clear(); historyRevision++;
      _saveDraft();
    }
    _mergeNativeTransfer();
    final revision = number(files['revision'], -1).toInt();
    if (revision != filesRevision) {
      filesRevision = revision;
      final result = json(files['result']);
      final resultFingerprint = jsonEncode(result);
      if (resultFingerprint != fileResultFingerprint) {
        fileResultFingerprint = resultFingerprint;
        if (result['results'] is List) {
          final rows = objects(result['results']);
          selected.removeAll(rows.where((row) => row['ok'] == true).map((row) => string(row['name'])));
          _saveDraft();
        }
      }
    }
    final requested = app.drafts.remove('files.section');
    if (requested is String) _focus(requested);
    final entered = visible && !wasVisible;
    final finished = wasBusy && !transferBusy;
    wasVisible = visible; wasBusy = transferBusy;
    if (visible) {
      if (entered || !inboxRead.loaded && !inboxRead.loading && inboxRead.error == null) unawaited(_refreshInbox());
      if (entered || !targetsRead.loaded && !targetsRead.loading && targetsRead.error == null) unawaited(_refreshTargets());
      if (entered || !historyRead.loaded && !historyRead.loading && historyRead.error == null) unawaited(_refreshHistory());
      if (finished) {
        unawaited(_refreshAfterChange(historyRead, _refreshHistory));
        unawaited(_refreshAfterChange(inboxRead, _refreshInbox));
      }
      if (entered && recoveryRequired) unawaited(_recover());
    }
    setState(() {});
  }

  void _focus(String section) {
    if (section == 'send') tabs.index = 1;
    if (section == 'history') tabs.index = 2;
    if (section == 'inbox') tabs.index = 0;
  }
  Future<void> _refreshAfterChange(_ReadSection section, Future<void> Function() refresh) async {
    final pending = section.pending;
    if (pending != null) await pending;
    if (mounted && visible) await refresh();
  }


  void _mergeNativeTransfer() {
    if (!historyRead.loaded || number(transfer['accountRevision'], -1) != number(app.bridge.control['accountRevision'], -2)) return;
    final update = json(transfer['snapshot']);
    if (update.isEmpty || removedTransfers.contains(string(update['id']))) return;
    final selfId = AppState.identityOf(app.status);
    if (selfId.isNotEmpty && update['selfId'] != selfId) return;
    if (selfId.isEmpty && !history.any((item) => item['id'] == update['id'] && item['selfId'] == update['selfId'])) return;
    final fingerprint = jsonEncode(update);
    if (fingerprint == transferFingerprint) return;
    transferFingerprint = fingerprint;
    try {
      history = mergeTransfer(history, parseTransfer(update));
      historyRevision++;
    } on FormatException {
      historyRead.error = context.l10n.web_files_invalid_response;
    }
  }

  Future<void> _read(_ReadSection section, String part, String command,
      void Function(Json) apply, {bool identityBound = false}) {
    if (section.pending != null) return section.pending!;
    if (!visible) return Future<void>.value();
    final generation = section.generation, identity = account;
    final completer = Completer<void>();
    section.pending = completer.future;
    setState(() {});
    () async {
      try {
        final result = await app.read([command], owner: '$owner-$part');
        if (!mounted || generation != section.generation || identityBound && identity != account) return;
        apply(result);
        section.loaded = true; section.error = null;
      } catch (error) {
        if (!mounted || generation != section.generation || identityBound && identity != account) return;
        section.error = error is FormatException ? context.l10n.web_files_invalid_response : _error(error);
      } finally {
        if (mounted && generation == section.generation) {
          section.pending = null;
          setState(() {});
        }
        completer.complete();
      }
    }();
    return completer.future;
  }

  Future<void> _refreshInbox() => _read(inboxRead, 'inbox', 'files-inbox', (result) {
    final parsed = parseInbox(result);
    inbox = parsed.files; ignored = parsed.ignored; ordered = sortedInbox(inbox, sort);
    selected.retainAll(inbox.map((item) => string(item['name'])));
    _saveDraft();
  });

  Future<void> _refreshTargets() => _read(targetsRead, 'targets', 'taildrop-targets', (result) {
    peers = parseTargets(result);
    if (!peers.any((peer) => peer['id'] == peerId)) peerId = peers.isEmpty ? null : string(peers.first['id']);
    _saveDraft();
  }, identityBound: true);

  Future<void> _refreshHistory() async {
    final revision = historyRevision;
    await _read(historyRead, 'history', 'file-send-history', (result) {
      var loaded = parseHistory(result);
      if (revision != historyRevision) {
        for (final update in history) {
          loaded = mergeTransfer(loaded, update);
        }
      }
      history = loaded.where((item) => !removedTransfers.contains(string(item['id']))).toList();
    }, identityBound: true);
    if (mounted) {
      _mergeNativeTransfer();
      setState(() {});
    }
    if (!mounted || !visible || !historyReady || transferBusy) return;
    final active = history.where(activeTransfer).firstOrNull;
    if (active != null && adoptedJob != active['id']) {
      adoptedJob = string(active['id']);
      if (!await _invoke('adoptTransfer', {'jobId': adoptedJob}, true)) adoptedJob = '';
    }
  }

  String _error(Object error) => error is PlatformException
      ? error.message ?? error.code : error.toString();

  Future<bool> _invoke(String method, [Json args = const {}, bool quiet = false]) async {
    try {
      await app.bridge.invoke<Object?>(method, args);
      return true;
    } catch (error) {
      if (!mounted) return false;
      setState(() { operationNotice = _error(error); operationFailed = true; });
      if (!quiet) await _showResult(operationNotice!, failed: true);
      return false;
    }
  }

  Future<void> _recover() async {
    if (recovering || transferBusy) return;
    recovering = true;
    await _invoke('recoverTransfer', const {}, true);
    recovering = false;
    if (mounted && visible) await _refreshHistory();
  }

  Future<void> _showResult(String message, {bool failed = false}) async {
    if (!mounted) return;
    if (!failed) { app.message(message); return; }
    await showDialog<void>(context: context, builder: (context) => AlertDialog(
      title: Text(context.l10n.error_title), content: SingleChildScrollView(child: SelectableText(message)),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: Text(context.l10n.close))],
    ));
  }

  Future<void> _nativeAction(String method, [Json args = const {}]) async {
    if (locked) return;
    setState(() => invoking = true);
    await _invoke(method, args);
    if (mounted) setState(() => invoking = false);
  }

  Future<void> _confirmSend() async {
    if (!sendReady || sources.isEmpty || peerId == null) return;
    final identity = account, chosenPeer = peerId;
    final chosen = sources.map((file) => string(file['key'], string(file['uri'], string(file['path'])))).toList();
    final target = peers.where((peer) => peer['id'] == chosenPeer).firstOrNull;
    if (target == null) return;
    final l = context.l10n;
    if (!await confirm(context, l.send, '${l.send_confirm(sources.length, string(target['hostname']))}\n${sources.map((file) => string(file['name'])).join('\n')}')) return;
    if (!mounted || identity != account || !sendReady || chosenPeer != peerId ||
        jsonEncode(chosen) != jsonEncode(sources.map((file) => string(file['key'], string(file['uri'], string(file['path'])))).toList())) return;
    await _invoke('requestNotifications');
    if (!mounted || identity != account || !sendReady) return;
    await _nativeAction('sendFiles', {'peerId': chosenPeer});
  }

  Future<void> _retry(Json item) async {
    if (!sendReady || retryableFiles(item).isEmpty) return;
    final identity = account;
    await _refreshTargets();
    if (!mounted || identity != account || !sendReady) return;
    final peer = peers.where((peer) => peer['id'] == item['peerId']).firstOrNull;
    if (peer == null) { await _showResult(context.l10n.web_files_retry_target_missing, failed: true); return; }
    if (!await confirm(context, context.l10n.retry, context.l10n.retry_confirm(string(peer['hostname'])))) return;
    if (!mounted || identity != account || !sendReady || !history.any((current) => current['id'] == item['id'])) return;
    await _invoke('requestNotifications');
    if (mounted && identity == account && sendReady) await _nativeAction('retryTransfer', {'jobId': item['id']});
  }

  Future<void> _command(String title, String prompt, List<String> args, {List<String>? names}) async {
    if (!app.canWrite || locked) return;
    final identity = account;
    if (!await confirm(context, title, prompt)) return;
    if (!mounted || identity != account || !app.canWrite || locked) return;
    setState(() => invoking = true);
    final historyAction = args.first == 'file-send-delete' || args.first == 'file-send-clear';
    try {
      Json result;
      try { result = await app.submit(title, args); }
      on PlatformException catch (error) {
        final detail = json(error.details);
        final partial = detail['results'] is List ? detail : json(detail['result']);
        if (names == null || partial['results'] is! List) rethrow;
        result = partial;
      }
      if (!mounted || account != identity) return;
      String notice;
      var failed = false;
      if (names != null) {
        final batch = parseFileBatch(result, names);
        selected.removeAll(batch.completed);
        notice = context.l10n.taildrop_batch_result(batch.completed.length, batch.failures.length);
        if (batch.failures.isNotEmpty) { notice += '\n${batch.failures.join('\n')}'; failed = true; }
      } else {
        if (result['ok'] != true) throw FormatException(string(result['error'], context.l10n.backend_failed));
        if (historyAction) {
          for (final item in history.where((item) => !activeTransfer(item) && (args.first == 'file-send-clear' || item['id'] == args[1]))) {
            removedTransfers.add(string(item['id']));
          }
          history = history.where((item) => !removedTransfers.contains(string(item['id']))).toList();
          historyRevision++;
          notice = context.l10n.taildrop_history_removed(requiredFileNumber(result, 'removed').toInt(), requiredFileNumber(result, 'retained').toInt());
        } else if (args.first == 'file-export') {
          notice = '${context.l10n.web_files_exported_to} ${string(result['path'])}';
        } else if (args.first == 'file-clear') {
          notice = '${context.l10n.web_files_cleared} (${number(result['removed'])})';
          if (number(result['ignored']) > 0) notice += '\n${context.l10n.repair_files_ignored_clear(number(result['ignored']).toInt())}';
        } else { notice = context.l10n.web_files_deleted; }
      }
      operationNotice = notice; operationFailed = failed;
      _saveDraft();
      await _showResult(notice, failed: failed);
    } catch (error) {
      if (mounted) {
        operationNotice = _error(error); operationFailed = true;
        await _showResult(operationNotice!, failed: true);
      }
    } finally {
      if (mounted) {
        setState(() => invoking = false);
        if (historyAction) {
          await _refreshAfterChange(historyRead, _refreshHistory);
        } else {
          await _refreshAfterChange(inboxRead, _refreshInbox);
        }
      }
    }
  }

  void _selectMatches() {
    if (!inboxReady) return;
    if (!selectMatchingFiles(selected, matches.map((item) => string(item['name'])))) {
      app.message(context.l10n.taildrop_selection_limit);
    }
    _saveDraft();
  }

  Future<void> _batch(bool delete) async {
    if (!inboxReady || selected.isEmpty) return;
    final names = selected.toList();
    final l = context.l10n;
    await _command(delete ? l.taildrop_delete_selected : l.taildrop_export_selected,
      '${delete ? l.taildrop_delete_confirm(names.length) : l.taildrop_export_confirm(names.length)}\n${names.join('\n')}',
      [delete ? 'file-delete-many' : 'file-export-many', jsonEncode(names)], names: names);
  }

  Future<void> _exportDirectory() async {
    if (!inboxReady || selected.isEmpty) return;
    final names = selected.toList();
    if (!await confirm(context, context.l10n.files_export_directory,
        '${context.l10n.files_export_directory_confirm(names.length)}\n${names.join('\n')}')) return;
    if (mounted && inboxReady) await _nativeAction('exportInbox', {'names': names});
  }

  @override
  void dispose() {
    app.removeListener(_onUpdate); app.bridge.removeListener(_onUpdate);
    for (final part in ['inbox', 'targets', 'history']) { app.bridge.cancelReads('$owner-$part'); }
    inboxRead.invalidate(); targetsRead.invalidate(); historyRead.invalidate();
    search.removeListener(_searchChanged); search.dispose(); tabs.removeListener(_saveDraft); tabs.dispose();
    super.dispose();
  }

  Widget _icon(String label, IconData icon, VoidCallback? action) =>
      IconButton(tooltip: label, onPressed: action, icon: Icon(icon));

  Widget _notice(_ReadSection section, String empty, bool isEmpty) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (section.loading) const LinearProgressIndicator(),
      if (section.error != null) Notice(section.error!, error: true),
      if (!section.loading && section.error == null && isEmpty) Text(section.loaded ? empty : context.l10n.web_loading),
    ],
  );

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return Column(children: [
      TabBar(controller: tabs, isScrollable: true, tabAlignment: TabAlignment.start, tabs: [
        Tab(text: l.web_files_inbox), Tab(text: l.web_files_send), Tab(text: l.web_files_history),
      ]),
      Expanded(child: LayoutBuilder(builder: (context, constraints) {
        final inset = constraints.maxWidth > 1000 ? (constraints.maxWidth - 1000) / 2 : 0.0;
        final rows = tabs.index == 0 ? matches : tabs.index == 1 ? sources : history;
        return CustomScrollView(key: PageStorageKey('files-${tabs.index}'), slivers: [
          SliverPadding(padding: EdgeInsets.fromLTRB(inset + 16, 16, inset + 16, 8),
            sliver: SliverToBoxAdapter(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              ..._progress(),
              if (tabs.index == 0) _inboxHeader(),
              if (tabs.index == 1) _sendHeader(),
              if (tabs.index == 2) _historyHeader(),
            ]))),
          SliverPadding(padding: EdgeInsets.symmetric(horizontal: inset + 16), sliver: SliverList.builder(
            itemCount: rows.length,
            itemBuilder: (context, index) => tabs.index == 0 ? _inboxRow(rows[index]) : tabs.index == 1 ? _sourceRow(rows[index]) : _historyRow(rows[index]),
          )),
          const SliverToBoxAdapter(child: SizedBox(height: 32)),
        ]);
      })),
    ]);
  }

  List<Widget> _progress() {
    final l = context.l10n;
    final progress = json(files['progress']);
    final result = json(files['result']);
    final failures = objects(result['results']).where((row) => row['ok'] != true).toList();
    final nativeMessage = string(files['message']);
    final transferMessage = string(transfer['message']);
    return [
      if (operationNotice != null) Notice(operationNotice!, error: operationFailed),
      if (nativeMessage.isNotEmpty) Semantics(liveRegion: true, child: Notice(nativeMessage, error: !filePending && result['ok'] == false)),
      if (transferMessage.isNotEmpty) Semantics(liveRegion: true, child: Notice(transferMessage)),
      if (filePending) Section(children: [
        if (progress.isNotEmpty && !boolean(files['resolving']) && !boolean(files['pickerPending'])) Text(progress['phase'] == 'committing'
            ? l.repair_files_save_committing(string(progress['name']), formatBytes(number(progress['bytes'])))
            : l.taildrop_share_progress(number(progress['index']).toInt(), number(progress['total']).toInt(), string(progress['name']), formatBytes(number(progress['bytes'])))),
        const LinearProgressIndicator(),
        if (boolean(files['canCancel'])) Align(alignment: AlignmentDirectional.centerEnd,
          child: _icon(l.cancel, Icons.close, () => _invoke('cancelExport'))),
      ]),
      if (failures.isNotEmpty) Notice('${l.taildrop_batch_result(objects(result['results']).length - failures.length, failures.length)}\n${failures.map((row) => '${string(row['name'])}: ${string(row['error'])}${boolean(row['partial']) ? '\n${l.repair_files_save_partial}' : ''}').join('\n')}', error: true),
      if (transferBusy) Align(alignment: AlignmentDirectional.centerEnd,
        child: _icon(l.web_files_cancel_send, Icons.close, () => _invoke('cancelTransfer'))),
      if (!transferBusy && recoveryRequired) Align(alignment: AlignmentDirectional.centerEnd,
        child: _icon(l.web_tools_refresh, Icons.sync, recovering ? null : _recover)),
    ];
  }

  Widget _inboxHeader() {
    final l = context.l10n;
    final orderLabels = [l.taildrop_sort_orders_0, l.taildrop_sort_orders_1, l.taildrop_sort_orders_2, l.taildrop_sort_orders_3];
    return Section(title: l.web_files_inbox, trailing: _icon(l.web_tools_refresh, Icons.refresh, inboxRead.loading ? null : _refreshInbox), children: [
      if (inboxRead.loaded) Wrap(spacing: 24, runSpacing: 8, children: [
        Metric(l.web_tools_file_count, '${inbox.length}', icon: Icons.folder_outlined),
        Metric(l.web_tools_total_size, formatBytes(inbox.fold<num>(0, (sum, file) => sum + number(file['size'])))),
      ]),
      _notice(inboxRead, search.text.isEmpty ? l.web_files_empty : l.web_empty, matches.isEmpty),
      if (ignored > 0) Notice(l.repair_files_ignored_inbox(ignored)),
      TextField(controller: search, decoration: InputDecoration(labelText: l.web_tools_file_search, prefixIcon: const Icon(Icons.search))),
      Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
        PopupMenuButton<int>(tooltip: l.taildrop_sort, initialValue: sort, icon: const Icon(Icons.sort),
          onSelected: (value) { sort = value; ordered = sortedInbox(inbox, sort); _saveDraft(); },
          itemBuilder: (_) => [for (var i = 0; i < 4; i++) CheckedPopupMenuItem(value: i, checked: sort == i, child: Text(orderLabels[i]))]),
        _icon(l.taildrop_select_matches, Icons.select_all, inboxReady && matches.isNotEmpty ? _selectMatches : null),
        _icon(l.web_files_clear, Icons.delete_sweep_outlined, inboxReady && app.canWrite && inbox.isNotEmpty
          ? () => _command(l.web_files_clear, l.files_clear_confirm, ['file-clear']) : null),
        _icon(l.web_files_receive, Icons.download, !locked && !recoveryRequired && app.canWrite ? () async {
          await _invoke('requestNotifications');
          if (mounted) await _nativeAction('importInbox');
        } : null),
      ]),
      Text(l.web_files_receive_hint),
      if (selected.isNotEmpty) ...[
        Text(l.taildrop_selected_count(selected.length, matches.length)),
        Wrap(children: [
          _icon(l.taildrop_deselect, Icons.deselect, inboxReady ? () { selected.clear(); _saveDraft(); } : null),
          _icon(l.taildrop_share_selected, Icons.share_outlined, inboxReady ? () => _nativeAction('shareInbox', {'names': selected.toList()}) : null),
          _icon(l.taildrop_export_selected, Icons.drive_file_move_outline, inboxReady && app.canWrite ? () => _batch(false) : null),
          _icon(l.files_export_directory, Icons.create_new_folder_outlined, inboxReady ? _exportDirectory : null),
          _icon(l.taildrop_delete_selected, Icons.delete_outline, inboxReady && app.canWrite ? () => _batch(true) : null),
        ]),
      ],
    ]);
  }

  Widget _inboxRow(Json file) {
    final l = context.l10n, name = string(file['name']);
    final checked = selected.contains(name);
    return Card(key: ValueKey(name), child: Column(children: [
      CheckboxListTile(value: checked, title: Text(name),
        subtitle: Text('${formatBytes(number(file['size']))} · ${formatTime(number(file['mtime']))}'),
        onChanged: inboxReady && (checked || selected.length < maxSelectedFiles) ? (value) {
          if (value == true) { selected.add(name); } else { selected.remove(name); }
          _saveDraft();
        } : null),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: Align(alignment: AlignmentDirectional.centerEnd,
        child: Wrap(children: [
          _icon('${l.web_tools_copy_path} $name', Icons.copy, () => copyText(context, '$inboxDirectory$name')),
          _icon('${l.web_files_download} $name', Icons.save_alt, inboxReady ? () => _nativeAction('saveInbox', {'name': name}) : null),
          _icon('${l.web_files_export} $name', Icons.drive_file_move_outline, inboxReady && app.canWrite
            ? () => _command(l.web_files_export, l.files_export_confirm(name), ['file-export', name]) : null),
          _icon('${l.open} $name', Icons.open_in_new, inboxReady ? () => _nativeAction('openInbox', {'name': name}) : null),
          _icon('${l.share} $name', Icons.share_outlined, inboxReady ? () => _nativeAction('shareInbox', {'names': [name]}) : null),
        ]))),
    ]));
  }

  Widget _sendHeader() {
    final l = context.l10n;
    final selection = sources;
    final known = selection.every((file) => number(file['size'], -1) >= 0);
    return Section(title: l.web_files_send, children: [
      Text(l.web_files_send_hint),
      _notice(targetsRead, l.web_tools_no_peers, peers.isEmpty),
      DropdownButtonFormField<String>(initialValue: peers.any((peer) => peer['id'] == peerId) ? peerId : null,
        key: ValueKey('$account:$peerId:${peers.map((peer) => peer['id']).join(',')}'),
        isExpanded: true, decoration: InputDecoration(labelText: l.web_files_peer),
        items: peers.map((peer) => DropdownMenuItem(value: string(peer['id']), child: Text(
          '${string(peer['hostname'])} · ${(peer['ips'] as List).first}${boolean(peer['online']) ? '' : ' (${l.web_offline})'}'))).toList(),
        onChanged: !locked && targetsReady ? (value) { peerId = value; _saveDraft(); } : null),
      Wrap(children: [
        _icon(l.web_files_refresh_targets, Icons.refresh, targetsRead.loading || transferBusy ? null : _refreshTargets),
        _icon(l.pick_files, Icons.add, !locked && !recoveryRequired ? () => _nativeAction('pickFiles') : null),
        _icon(l.web_files_choose, Icons.folder_open, !locked && !recoveryRequired ? () => Navigator.of(context).push<void>(MaterialPageRoute(builder: (_) => FilesBrowser(app: app))) : null),
        _icon(l.taildrop_clear_selection, Icons.deselect, canClearSources ? () => _invoke('clearSources') : null),
      ]),
      Text('${l.web_files_selected} ${selection.length}/$maxSelectedFiles · ${known ? formatBytes(selection.fold<num>(0, (sum, file) => sum + number(file['size']))) : '—'}'),
      if (selection.isEmpty) Text(l.web_files_selection_empty),
      if (historyRead.error != null) Notice(historyRead.error!, error: true),
      if (historyRead.loading) const LinearProgressIndicator(),
      FilledButton.icon(onPressed: sendReady && selection.isNotEmpty && peerId != null ? _confirmSend : null,
        icon: const Icon(Icons.send), label: Text(l.web_files_send_btn)),
    ]);
  }

  Widget _sourceRow(Json source) {
    final key = string(source['key'], string(source['uri'], string(source['path'])));
    return ListTile(key: ValueKey(key), title: SelectableText(string(source['name'])),
      subtitle: SelectableText('$key · ${number(source['size'], -1) < 0 ? '—' : formatBytes(number(source['size']))}'),
      trailing: _icon('${context.l10n.web_files_remove_selection} ${string(source['name'])}', Icons.close,
        !locked && !recoveryRequired ? () => _nativeAction('removeSource', {'key': key}) : null));
  }

  Widget _historyHeader() {
    final l = context.l10n;
    return Section(title: l.web_files_history, trailing: Wrap(children: [
      _icon(l.web_tools_refresh, Icons.refresh, historyRead.loading ? null : _refreshHistory),
      _icon(l.taildrop_clear_history, Icons.delete_sweep_outlined,
        !locked && app.canWrite && historyReady && history.any((item) => !activeTransfer(item))
          ? () => _command(l.taildrop_clear_history, l.taildrop_clear_history_confirm, ['file-send-clear']) : null),
    ]), children: [_notice(historyRead, l.web_files_history_empty, history.isEmpty)]);
  }

  String _state(String state) {
    final l = context.l10n;
    return switch (state) {
      'queued' => l.web_files_queued, 'sending' => l.web_files_sending,
      'completed' => l.web_files_completed, 'failed' => l.web_files_failed,
      'cancelled' => l.web_files_cancelled, _ => l.web_files_interrupted,
    };
  }

  Widget _historyRow(Json item) {
    final l = context.l10n;
    final itemFiles = objects(item['files']);
    final active = activeTransfer(item);
    final failed = retryableFiles(item);
    final targetPresent = peers.any((peer) => peer['id'] == item['peerId']);
    return Card(key: ValueKey(item['id']), child: Padding(padding: const EdgeInsets.all(12), child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SelectableText('${string(item['peerName'], string(item['peerId']))} · ${string(item['peerIp'])}', style: Theme.of(context).textTheme.titleMedium),
        Text('${formatTime(number(item['startedAt']))} · ${l.web_files_completed_count} ${itemFiles.where((file) => file['status'] == 'completed').length}/${itemFiles.length}'),
        Semantics(liveRegion: active, child: Text(_state(string(item['status'])))),
        if (active) Text(l.web_files_accepted_hint),
        if (string(item['error']).isNotEmpty) Notice(string(item['error']), error: true),
        ...itemFiles.map((file) {
          final sending = file['status'] == 'sending', known = boolean(file['progressKnown']);
          final size = number(file['size']), sent = number(file['sentBytes']);
          final progress = l.known_progress(formatBytes(sent), formatBytes(size), formatBytes(number(file['bytesPerSecond'])));
          return Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            SelectableText(string(file['name'])),
            Text('${_state(string(file['status']))} · ${formatBytes(size)}'),
            if (sending && known) ...[
              Text(progress),
              LinearProgressIndicator(value: size > 0 ? (sent / size).clamp(0.0, 1.0) : 0,
                semanticsLabel: '${l.web_files_sending} ${string(file['name'])}', semanticsValue: progress),
            ],
            if (sending && !known) Text(l.web_files_progress_unknown),
            if (string(file['error']).isNotEmpty) Notice(string(file['error']), error: true),
          ]));
        }),
        Wrap(children: [
          if (active) _icon(l.web_files_cancel_send, Icons.close, invoking ? null : () => _invoke('cancelTransfer', {'jobId': item['id']})),
          if (!active) _icon(l.taildrop_delete_history, Icons.delete_outline,
            !locked && app.canWrite && historyReady ? () => _command(l.taildrop_delete_history, l.taildrop_delete_history_confirm, ['file-send-delete', string(item['id'])]) : null),
          if (failed.isNotEmpty) _icon('${l.web_files_retry_unsuccessful} (${failed.length})', Icons.refresh,
            sendReady && targetPresent ? () => _retry(item) : null),
        ]),
        if (failed.isNotEmpty && targetsRead.loaded && !targetPresent) Notice(l.web_files_retry_target_missing),
      ],
    )));
  }
}
