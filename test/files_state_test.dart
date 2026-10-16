import 'package:flutter_test/flutter_test.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/features/files/files_state.dart';

Json transfer(String state, int updated, {String fileState = 'sending', int sent = 0}) => {
  'id': '0123456789abcdef', 'peerId': 'peer', 'peerName': 'Device',
  'peerIp': '100.64.0.2', 'selfId': 'self', 'status': state,
  'startedAt': 1, 'updatedAt': updated,
  'files': [{
    'id': 'fedcba9876543210', 'name': 'file.bin', 'path': '/sdcard/file.bin',
    'status': fileState, 'size': 100, 'sentBytes': sent,
    'bytesPerSecond': 5, 'progressKnown': true,
  }],
};

void main() {
  test('filtered select-all preserves hidden choices and rejects the whole overflow', () {
    final selected = {'hidden'};
    expect(selectMatchingFiles(selected, ['visible', 'visible']), isTrue);
    expect(selected, {'hidden', 'visible'});
    final before = Set<String>.of(selected);
    expect(selectMatchingFiles(selected, List.generate(31, (i) => '$i')), isFalse);
    expect(selected, before);
    expect(selectMatchingFiles(selected, List.generate(30, (i) => '$i')), isTrue);
    expect(selected.length, 32);
  });

  test('all inbox orders are stable by name at equal time or size', () {
    final files = <Json>[
      {'name': 'b', 'mtime': 2, 'size': 1},
      {'name': 'a', 'mtime': 2, 'size': 1},
      {'name': 'c', 'mtime': 1, 'size': 9},
    ];
    expect(sortedInbox(files, 0).map((file) => file['name']), ['a', 'b', 'c']);
    expect(sortedInbox(files, 1).map((file) => file['name']), ['c', 'a', 'b']);
    expect(sortedInbox(files, 2).map((file) => file['name']), ['a', 'b', 'c']);
    expect(sortedInbox(files, 3).map((file) => file['name']), ['c', 'a', 'b']);
    expect(files.first['name'], 'b');
  });

  test('incompatible inbox entries are counted rather than exposed', () {
    final parsed = parseInbox({'ignored': 2, 'files': [
      {'name': 'good', 'size': 0, 'mtime': 0},
      {'name': '../bad', 'size': 1, 'mtime': 0},
      {'name': 'bad-size', 'size': -1, 'mtime': 0},
    ]});
    expect(parsed.ignored, 4);
    expect(parsed.files.single['name'], 'good');
    expect(() => parseInbox({'files': <Object?>[], 'ignored': 0.5}), throwsFormatException);
  });

  test('directory responses cannot substitute path, duplicates or traversal', () {
    final entry = {'name': 'a', 'path': '/sdcard/Download/a', 'directory': false, 'size': 0, 'mtime': 0};
    Json response(List<Json> entries) => {'ok': true, 'path': 'Download', 'truncated': false, 'entries': entries};
    expect(parseDirectory(response([entry]), 'Download').length, 1);
    expect(() => parseDirectory(response([entry, entry]), 'Download'), throwsFormatException);
    expect(() => parseDirectory(response([{...entry, 'path': '/sdcard/elsewhere/a'}]), 'Download'), throwsFormatException);
    expect(() => parseDirectory(response([entry]), '../Download'), throwsFormatException);
    expect(() => parseDirectory(response(List.generate(1001, (_) => entry)), 'Download'), throwsFormatException);
    expect(validFileName('文件\n.txt'), isFalse);
    expect(validFileName(List.filled(86, '文').join()), isFalse);
  });

  test('only explicit failed/cancelled files retry, never active or unknown', () {
    final item = transfer('interrupted', 2, fileState: 'failed');
    item['files'] = [
      ...objects(item['files']),
      {...objects(item['files']).single, 'id': '1111111111111111', 'status': 'completed'},
      {...objects(item['files']).single, 'id': '2222222222222222', 'status': 'cancelled'},
      {...objects(item['files']).single, 'id': '3333333333333333', 'status': 'sending'},
    ];
    expect(retryableFiles(item).map((file) => file['status']), ['failed', 'cancelled']);
    expect(retryableFiles({...item, 'status': 'sending'}), isEmpty);
    expect(retryableFiles(transfer('interrupted', 2, fileState: 'queued')), isEmpty);
  });

  test('late active snapshots cannot resurrect terminal history', () {
    final terminal = transfer('completed', 10, fileState: 'completed', sent: 100);
    final history = [terminal];
    expect(identical(mergeTransfer(history, transfer('sending', 11)), history), isTrue);
    final active = [transfer('sending', 5)];
    expect(identical(mergeTransfer(active, transfer('sending', 4)), active), isTrue);
    expect(mergeTransfer(active, terminal).single['status'], 'completed');
    expect(parseTransfer(terminal)['id'], terminal['id']);
    expect(() => parseTransfer(transfer('sending', 1, sent: 101)), throwsFormatException);
    expect(() => parseHistory({'transfers': [terminal, terminal]}), throwsFormatException);
  });

  test('batch result preserves ordered per-file failures and refuses mismatched receipts', () {
    final result = parseFileBatch({'ok': false, 'results': [
      {'name': 'a', 'ok': true}, {'name': 'b', 'ok': false, 'error': 'Permission denied'},
    ]}, ['a', 'b']);
    expect(result.completed, ['a']);
    expect(result.failures, ['b: Permission denied']);
    expect(() => parseFileBatch({'results': [{'name': 'b', 'ok': true}]}, ['a']), throwsFormatException);
    expect(() => parseFileBatch({'results': <Object?>[]}, ['a']), throwsFormatException);
  });
}
