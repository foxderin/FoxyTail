import 'dart:convert';

import 'package:foxytail/app/platform_bridge.dart';

const maxSelectedFiles = 32;
const maxFileBytes = 2147483648;
const inboxDirectory = '/data/adb/foxytail/files/';

bool validFileName(String name) =>
    name.isNotEmpty &&
    utf8.encode(name).length <= 255 &&
    !const {'.', '..', '.taildrop', '.outgoing'}.contains(name) &&
    !name.runes.any((c) => c < 32 || (c >= 127 && c <= 159) ||
        (c >= 0xd800 && c <= 0xdfff) || c == 47 || c == 92);

bool validSharedDirectory(String path) => path.isEmpty ||
    (path.length <= 4088 && !path.contains('\\') &&
        !path.runes.any((c) => c < 32 || (c >= 127 && c <= 159)) &&
        path.split('/').every((part) => part.isNotEmpty && part != '.' && part != '..'));

bool activeTransfer(Json item) => const {'queued', 'sending'}.contains(item['status']);

List<Json> retryableFiles(Json item) => activeTransfer(item)
    ? const []
    : objects(item['files']).where((file) =>
        const {'failed', 'cancelled'}.contains(file['status'])).toList();

bool selectMatchingFiles(Set<String> selected, Iterable<String> matches) {
  final next = {...selected, ...matches};
  if (next.length > maxSelectedFiles) return false;
  selected..clear()..addAll(next);
  return true;
}

List<Json> sortedInbox(List<Json> files, int sort) {
  int byName(Json a, Json b) => string(a['name']).compareTo(string(b['name']));
  return List<Json>.of(files)..sort((a, b) {
    final order = switch (sort) {
      1 => number(a['mtime']).compareTo(number(b['mtime'])),
      2 => byName(a, b),
      3 => number(b['size']).compareTo(number(a['size'])),
      _ => number(b['mtime']).compareTo(number(a['mtime'])),
    };
    return order == 0 ? byName(a, b) : order;
  });
}

String requiredFileString(Json item, String key) {
  final value = item[key];
  if (value is! String || value.isEmpty || value.length > 4096) {
    throw const FormatException('Invalid file response');
  }
  return value;
}

num requiredFileNumber(Json item, String key) {
  final value = item[key];
  if (value is! num || !value.isFinite || value < 0) {
    throw const FormatException('Invalid file response');
  }
  return value;
}

List<Json> fileArray(Json response, String key, int limit) {
  final value = response[key];
  if (value is! List || value.length > limit || value.any((v) => v is! Map)) {
    throw const FormatException('Invalid file response');
  }
  return objects(value);
}

({List<Json> files, int ignored}) parseInbox(Json response) {
  final entries = fileArray(response, 'files', 10000);
  final ignored = response['ignored'] ?? 0;
  if (ignored is! num || !ignored.isFinite || ignored < 0 ||
      ignored != ignored.toInt() || ignored > 2147483647 - entries.length) {
    throw const FormatException('Invalid inbox count');
  }
  var skipped = ignored.toInt();
  final names = <String>{};
  final files = <Json>[];
  for (final item in entries) {
    try {
      final name = requiredFileString(item, 'name');
      if (!validFileName(name) || !names.add(name)) {
        throw const FormatException('Invalid inbox name');
      }
      requiredFileNumber(item, 'size');
      requiredFileNumber(item, 'mtime');
      files.add(item);
    } on FormatException {
      skipped++;
    }
  }
  return (files: files, ignored: skipped);
}

List<Json> parseTargets(Json response) {
  final peers = fileArray(response, 'peers', 10000);
  final ids = <String>{};
  for (final peer in peers) {
    if (!ids.add(requiredFileString(peer, 'id'))) {
      throw const FormatException('Duplicate receiving device');
    }
    requiredFileString(peer, 'hostname');
    final ips = peer['ips'];
    if (ips is! List || ips.isEmpty || ips.first is! String ||
        !RegExp(r'^[0-9a-fA-F:.]+$').hasMatch(ips.first as String) ||
        peer['online'] is! bool) {
      throw const FormatException('Invalid receiving device');
    }
  }
  return peers..sort((a, b) {
    final online = (boolean(a['online']) ? 0 : 1).compareTo(boolean(b['online']) ? 0 : 1);
    if (online != 0) return online;
    final name = string(a['hostname']).compareTo(string(b['hostname']));
    return name != 0 ? name : string(a['id']).compareTo(string(b['id']));
  });
}

Json parseTransfer(Json item) {
  const states = {'queued', 'sending', 'completed', 'failed', 'cancelled', 'interrupted'};
  final idPattern = RegExp(r'^[a-fA-F0-9]{16,128}$');
  if (!idPattern.hasMatch(requiredFileString(item, 'id')) || !states.contains(item['status'])) {
    throw const FormatException('Invalid transfer');
  }
  for (final key in ['peerId', 'peerName', 'peerIp', 'selfId']) {
    requiredFileString(item, key);
  }
  requiredFileNumber(item, 'startedAt');
  requiredFileNumber(item, 'updatedAt');
  final files = fileArray(item, 'files', maxSelectedFiles);
  if (files.isEmpty) throw const FormatException('Empty transfer');
  final ids = <String>{};
  for (final file in files) {
    final id = requiredFileString(file, 'id');
    final path = requiredFileString(file, 'path');
    final shared = path.startsWith('/sdcard/') && validSharedDirectory(path.substring(8));
    final staged = RegExp(r'^/data/adb/foxytail/files/\.outgoing/[a-zA-Z0-9_-]+/[^/]+$').hasMatch(path);
    if (!idPattern.hasMatch(id) || !ids.add(id) ||
        !validFileName(requiredFileString(file, 'name')) ||
        !(shared || staged) || path.length > 4096 || path.contains('\\') ||
        path.substring(1).split('/').any((part) => part.isEmpty || part == '.' || part == '..') ||
        path.runes.any((c) => c < 32 || (c >= 127 && c <= 159)) ||
        !states.contains(file['status']) || file['status'] == 'interrupted' ||
        file['progressKnown'] is! bool) {
      throw const FormatException('Invalid transfer file');
    }
    if (requiredFileNumber(file, 'sentBytes') > requiredFileNumber(file, 'size')) {
      throw const FormatException('Invalid byte progress');
    }
    requiredFileNumber(file, 'bytesPerSecond');
  }
  return item;
}

List<Json> parseHistory(Json response) {
  final history = fileArray(response, 'transfers', 100);
  final ids = <String>{};
  var active = 0;
  for (final item in history) {
    parseTransfer(item);
    if (!ids.add(string(item['id'])) || (activeTransfer(item) && ++active > 1)) {
      throw const FormatException('Invalid transfer history');
    }
  }
  return history..sort((a, b) => number(b['startedAt']).compareTo(number(a['startedAt'])));
}

List<Json> mergeTransfer(List<Json> history, Json update) {
  final index = history.indexWhere((item) => item['id'] == update['id']);
  if (index >= 0) {
    final old = history[index];
    if (number(old['updatedAt']) > number(update['updatedAt']) ||
        (!activeTransfer(old) && activeTransfer(update))) return history;
  }
  final next = history.where((item) => item['id'] != update['id']).toList()..add(update);
  next.sort((a, b) => number(b['startedAt']).compareTo(number(a['startedAt'])));
  return next.length > 100 ? next.sublist(0, 100) : next;
}

List<Json> parseDirectory(Json response, String directory) {
  if (!validSharedDirectory(directory) || response['ok'] != true ||
      response['path'] != directory || response['truncated'] is! bool) {
    throw const FormatException('Invalid directory response');
  }
  final entries = fileArray(response, 'entries', 1000);
  final paths = <String>{};
  for (final item in entries) {
    final name = requiredFileString(item, 'name');
    final path = requiredFileString(item, 'path');
    if (!validFileName(name) || path != '/sdcard/${directory.isEmpty ? '' : '$directory/'}$name' ||
        !paths.add(path) || item['directory'] is! bool) {
      throw const FormatException('Invalid directory entry');
    }
    requiredFileNumber(item, 'size');
    requiredFileNumber(item, 'mtime');
  }
  return entries;
}

({List<String> completed, List<String> failures}) parseFileBatch(Json result, List<String> requested) {
  final rows = fileArray(result, 'results', maxSelectedFiles);
  if (rows.length != requested.length) throw const FormatException('Invalid batch result');
  final completed = <String>[], failures = <String>[];
  for (var i = 0; i < rows.length; i++) {
    final item = rows[i];
    if (item['name'] != requested[i] || item['ok'] is! bool) {
      throw const FormatException('Invalid batch result');
    }
    if (item['ok'] == true) {
      completed.add(requested[i]);
    } else {
      failures.add('${requested[i]}: ${requiredFileString(item, 'error')}');
    }
  }
  return (completed: completed, failures: failures);
}
