import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';

import 'files_state.dart';

class FilesBrowser extends StatefulWidget {
  const FilesBrowser({super.key, required this.app});
  final AppState app;

  @override
  State<FilesBrowser> createState() => _FilesBrowserState();
}

class _FilesBrowserState extends State<FilesBrowser> {
  late String directory;
  late final String owner = 'files-browser-${identityHashCode(this)}';
  List<Json> entries = [];
  bool loading = false, truncated = false, changing = false;
  String? error;
  int generation = 0;

  @override
  void initState() {
    super.initState();
    final saved = string(widget.app.drafts['files.directory']);
    directory = validSharedDirectory(saved) ? saved : '';
    widget.app.bridge.addListener(_changed);
    _browse(directory);
  }

  void _changed() { if (mounted) setState(() {}); }


  Future<void> _browse(String path) async {
    if (!validSharedDirectory(path) || (loading && path == directory)) return;
    widget.app.bridge.cancelReads(owner);
    final token = ++generation;
    setState(() { directory = path; loading = true; error = null; entries = []; truncated = false; });
    widget.app.drafts['files.directory'] = path;
    try {
      final result = await widget.app.read(['files-browse', path.isEmpty ? '-' : path], owner: owner);
      final parsed = parseDirectory(result, path);
      if (!mounted || token != generation) return;
      setState(() { entries = parsed; truncated = boolean(result['truncated']); });
    } catch (e) {
      if (!mounted || token != generation) return;
      setState(() => error = e is FormatException ? context.l10n.web_files_invalid_response : failureMessage(e));
    } finally {
      if (mounted && token == generation) setState(() => loading = false);
    }
  }

  Future<void> _select(Json item, bool selected) async {
    if (changing || boolean(widget.app.bridge.transfer['busy']) ||
        boolean(widget.app.bridge.files['pending'])) return;
    setState(() => changing = true);
    await perform(context, () async {
      await widget.app.bridge.invoke<Object?>(selected ? 'removeSource' : 'addSharedFiles',
          selected ? {'key': item['path']} : {'files': [{'path': item['path'], 'size': item['size']}]});
    });
    if (mounted) setState(() => changing = false);
  }

  @override
  void dispose() {
    generation++;
    widget.app.bridge.cancelReads(owner);
    widget.app.bridge.removeListener(_changed);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final selection = objects(widget.app.bridge.files['selection']);
    final selected = selection.map((item) => string(item['path'])).toSet();
    final locked = changing || boolean(widget.app.bridge.transfer['busy']) ||
        boolean(widget.app.bridge.transfer['recoveryRequired']) || boolean(widget.app.bridge.files['pending']);
    final crumbs = <Widget>[TextButton(onPressed: () => _browse(''), child: const Text('/sdcard'))];
    var path = '';
    for (final part in directory.split('/').where((part) => part.isNotEmpty)) {
      path = path.isEmpty ? part : '$path/$part';
      final destination = path;
      crumbs.add(TextButton(onPressed: () => _browse(destination), child: Text(part)));
    }
    return Scaffold(
      appBar: AppBar(title: Text(l.web_files_choose), actions: [
        IconButton(tooltip: l.web_files_parent, onPressed: directory.isEmpty ? null : () {
          final slash = directory.lastIndexOf('/');
          _browse(slash < 0 ? '' : directory.substring(0, slash));
        }, icon: const Icon(Icons.arrow_upward)),
        IconButton(tooltip: l.web_tools_refresh, onPressed: loading ? null : () => _browse(directory), icon: const Icon(Icons.refresh)),
      ]),
      body: SafeArea(child: CustomScrollView(slivers: [
        SliverToBoxAdapter(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Semantics(label: l.web_files_location, child: SingleChildScrollView(scrollDirection: Axis.horizontal, child: Row(children: crumbs))),
        if (loading) const LinearProgressIndicator(),
        if (string(widget.app.bridge.files['message']).isNotEmpty)
          Padding(padding: const EdgeInsets.all(16), child: Notice(string(widget.app.bridge.files['message']),
            error: json(widget.app.bridge.files['result'])['ok'] == false)),
        if (error != null) Padding(padding: const EdgeInsets.all(16), child: Notice(error!, error: true)),
        if (error != null) Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Text(l.web_files_storage_hint)),
        if (truncated) Padding(padding: const EdgeInsets.all(16), child: Notice(l.web_files_truncated)),
        Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Align(alignment: AlignmentDirectional.centerStart,
          child: Text('${l.web_files_selected} ${selection.length}/$maxSelectedFiles'))),
        if (!loading && error == null && entries.isEmpty)
          Padding(padding: const EdgeInsets.all(16), child: Text(l.web_files_directory_empty)),
        ])),
        SliverList.builder(itemCount: entries.length, itemBuilder: (context, index) {
                final item = entries[index];
                final folder = boolean(item['directory']);
                final name = string(item['name']);
                final checked = selected.contains(item['path']);
                final enabled = !locked && (checked || (selection.length < maxSelectedFiles && number(item['size']) <= maxFileBytes));
                return ListTile(
                  key: ValueKey(item['path']), leading: Icon(folder ? Icons.folder_outlined : Icons.insert_drive_file_outlined),
                  title: Text(name),
                  subtitle: Text('${folder ? l.web_files_directory : formatBytes(number(item['size']))} · ${formatTime(number(item['mtime']))}'),
                  onTap: folder ? () => _browse(string(item['path']).substring(8)) : enabled ? () => _select(item, checked) : null,
                  trailing: folder
                      ? IconButton(tooltip: '${l.web_files_open_directory} $name', onPressed: () => _browse(string(item['path']).substring(8)), icon: const Icon(Icons.chevron_right))
                      : Semantics(label: '${l.web_files_select} $name', child: Checkbox(value: checked, onChanged: enabled ? (_) => _select(item, checked) : null)),
                );
              }),
      ])),
    );
  }
}
