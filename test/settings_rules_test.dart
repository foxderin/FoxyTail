import 'package:flutter_test/flutter_test.dart';
import 'package:foxytail/features/settings/settings_rules.dart';

void main() {
  group('numeric-only CIDR canonicalization', () {
    final examples = {
      '192.168.001.222/24': '192.168.1.0/24',
      '255.255.255.255/0': '0.0.0.0/0',
      '255.255.255.255/32': '255.255.255.255/32',
      '2001:DB8:dead:beef:1234:5678:90ab:cdef/32': '2001:db8::/32',
      '2001:db8::1/0': '::/0', '::1/128': '::1/128',
      '::ffff:192.0.2.128/120': '::ffff:c000:200/120',
      '1:0:0:2:0:0:3:4/128': '1::2:0:0:3:4/128',
      '1:2:3:4:5:6:7:8/128': '1:2:3:4:5:6:7:8/128',
    };
    for (final example in examples.entries) {
      test(example.key, () => expect(canonicalCidr(example.key), example.value));
    }
    test('canonical sets deduplicate in order', () {
      expect(canonicalCidrs('10.1.2.3/8,10.2.3.4/8\n2001:db8::1/32').toList(), ['10.0.0.0/8', '2001:db8::/32']);
    });
    for (final invalid in ['localhost/24', '1.2.3/24', '256.0.0.1/24', '1.2.3.4/-1', '1.2.3.4/33', '::1/129', '1:::2/64', '1::2::3/64', '1:2:3:4:5:6:7/128', 'fe80::1%wlan0/64', '[::1]/128', '1:2:3:4:5:6:7:8::/128']) {
      test('rejects $invalid', () { expect(() => canonicalCidr(invalid), throwsFormatException); expect(validCidr(invalid), isFalse); });
    }
  });
  group('lossless context editing', () {
    const original = '# 注释\r\nssid:Home:up\r\n\r\nunknown:future:action\r\nssid:Home:up\r\ncellular:-:down';
    test('comments and blank lines are not rule rows', () => expect(visibleContextRules(original), [1, 3, 4, 5]));
    test('unknown syntax remains raw', () => expect(parseContextRule('unknown:future:action'), isNull));
    test('parse trims only rule margin and preserves IPv6 argument', () {
      expect(parseContextRule(' \tssid:Home:up \t\r')!.line, 'ssid:Home:up');
      expect(parseContextRule('ssid:Home:exit-node:fd7a:115c::2')!.line, 'ssid:Home:exit-node:fd7a:115c::2');
    });
    test('editing one duplicate leaves every other byte intact', () => expect(replaceContextRule(original, 1, 'ssid:Office:down'), '# 注释\r\nssid:Office:down\r\n\r\nunknown:future:action\r\nssid:Home:up\r\ncellular:-:down'));
    test('swapping rules is reversible including CRLF and final line', () => expect(moveContextRule(moveContextRule(original, 1, 5), 1, 5), original));
    test('removal preserves unrelated trailing line endings', () {
      expect(removeContextRule(original, 5), '# 注释\r\nssid:Home:up\r\n\r\nunknown:future:action\r\nssid:Home:up\r\n');
      expect(removeContextRule('ssid:A:up', 0), '');
      expect(removeContextRule('ssid:A:up\r\n', 0), '');
    });
    test('append selects existing newline convention', () {
      expect(replaceContextRule('# note', -1, 'cellular:-:up'), '# note\ncellular:-:up\n');
      expect(replaceContextRule('# note\r\ncellular:-:up', -1, 'ssid:Home:up'), '# note\r\ncellular:-:up\r\nssid:Home:up\r\n');
      expect(replaceContextRule('ssid:B:up', 0, 'ssid:A:up'), 'ssid:A:up');
    });
    for (final invalid in ['ssid::up', 'ssid:unknown:up', 'ssid:<none>:up', 'ssid:"Home":up', 'ssid:Home:up:extra', 'ssid:Home:exit-node:', 'ssid:Home#x:up', 'cellular:Home:up', 'cellular:-:up\u0000']) {
      test('invalid visual rule $invalid', () => expect(parseContextRule(invalid), isNull));
    }
    test('replacement validates before touching text', () => expect(() => replaceContextRule(original, 1, 'ssid::up'), throwsFormatException));
    test('48 KiB limit counts UTF-8 rather than characters', () {
      expect(contextWithinLimit('a' * (48 * 1024)), isTrue);
      expect(contextWithinLimit('a' * (48 * 1024 + 1)), isFalse);
      expect(contextWithinLimit('界' * (16 * 1024)), isTrue);
      expect(contextWithinLimit('${'界' * (16 * 1024)}a'), isFalse);
    });
  });
  group('trial and integer boundaries', () {
    test('rollback failed remains active', () {
      for (final state in ['preparing', 'running', 'rolling-back', 'rollback-failed']) { expect(trialActive(state), isTrue); expect(validTrialState(state), isTrue); }
      for (final state in ['confirmed', 'rolled-back', 'superseded']) { expect(trialActive(state), isFalse); expect(validTrialState(state), isTrue); }
      expect(validTrialState(''), isFalse); expect(validTrialState('healthy'), isFalse);
    });
    test('duration 30–300 accepts nonpreset values', () {
      for (final value in [30, 300, 91]) { expect(trialDuration('$value'), value); }
      for (final value in ['29', '301', '-30', '0', '90.5', '999999999999']) { expect(() => trialDuration(value), throwsFormatException); }
    });
    test('monotonic countdown starts at request, never response', () {
      expect(trialRemaining(8, 1000, 4500), 5);
      expect(trialRemaining(8, 1000, 31000), 0);
      expect(trialRemaining(8, 1000, 500), 8);
    });
    test('settings ranges reject floats signs overflow and endpoints outside range', () {
      for (final range in [(1024, 65535), (5, 300), (10, 3600), (64, 10240)]) {
        expect(boundedInteger('${range.$1}', range.$1, range.$2), range.$1);
        expect(boundedInteger('${range.$2}', range.$1, range.$2), range.$2);
        for (final value in ['${range.$1 - 1}', '${range.$2 + 1}', '1.2', '+1024', '-1', '99999999999999999999999']) { expect(() => boundedInteger(value, range.$1, range.$2), throwsFormatException); }
      }
    });
  });
  test('UID normalization, bounds and deduplication', () {
    expect(parseUids('0,010001\n10001 2147483647').toList(), ['0', '10001', '2147483647']);
    expect(parseUids(''), isEmpty);
    for (final value in ['-1', '1.5', '2147483648', '99999999999999999999999', 'shell']) { expect(() => parseUids(value), throwsFormatException); }
  });
  test('missing facts are never false or healthy', () {
    expect(booleanState(true, 'Yes', 'No', 'Unknown'), 'Yes');
    expect(booleanState(false, 'Yes', 'No', 'Unknown'), 'No');
    for (final value in [null, 'false', 0, Object()]) { expect(booleanState(value, 'Yes', 'No', 'Unknown'), 'Unknown'); }
    for (final value in ['legacy', 'local', 'transparent']) { expect(textState(value, 'Unknown'), value); }
    for (final value in [null, '', false, 0, Object()]) { expect(textState(value, 'Unknown'), 'Unknown'); }
  });
  group('draft merge matrix', () {
    final cases = <(String?, String?, String, bool, String, String?, bool)>[
      (null, null, 'disk', false, 'disk', 'disk', false),
      ('old', 'old', 'restored', false, 'restored', 'restored', false),
      ('old', 'edited', 'old', false, 'edited', 'old', false),
      ('old', 'edited', 'restored', false, 'edited', 'old', true),
      ('old', 'edited', 'edited', false, 'edited', 'edited', false),
      ('submitted', 'newer edit', 'submitted', false, 'newer edit', 'submitted', false),
      ('submitted', 'submitted', 'restored', false, 'restored', 'restored', false),
      ('old', 'old', 'restored', true, 'old', 'old', true),
      ('old', 'old', 'old', true, 'old', 'old', false),
      (null, 'legacy draft', 'restored', false, 'legacy draft', null, true),
      ('old', 'old', '', false, '', '', false),
    ];
    for (var i = 0; i < cases.length; i++) {
      test('merge case $i', () {
        final c = cases[i], result = mergeDraft(c.$1, c.$2, c.$3, editing: c.$4);
        expect((result.value, result.baseline, result.conflict), (c.$5, c.$6, c.$7));
        if (result.conflict) expect(mergeDraft(result.baseline, result.value, c.$3, editing: c.$4).conflict, isTrue);
      });
    }
  });
  group('restore preview trust boundary', () {
    Map<String, dynamic> preview() => {'path': 'art-${'a' * 32}', 'sha256': 'b' * 64, 'baselineSha256': 'c' * 64, 'changes': [{'file': 'foxytail.conf', 'key': 'IPV6', 'before': null, 'after': 'on'}], 'hooks': ['foxytail.tun.up']};
    test('requires selected source and both digests', () {
      final value = preview();
      expect(validRestorePreview(value, value['path'] as String), isTrue);
      expect(validRestorePreview(value, 'other'), isFalse);
      for (final key in ['sha256', 'baselineSha256']) {
        expect(validRestorePreview({...value, key: 'A' * 64}, value['path'] as String), isFalse);
        expect(validRestorePreview({...value, key: ''}, value['path'] as String), isFalse);
      }
    });
    test('rejects unknown files hooks and missing diff sides', () {
      final value = preview();
      for (final row in [{'file': 'identity', 'key': 'key', 'before': '', 'after': ''}, {'file': 'context.conf', 'key': 'rules', 'after': ''}, {'file': 'routes.conf', 'key': 'UIDS', 'before': 1, 'after': ''}]) {
        expect(validRestorePreview({...value, 'changes': [row]}, value['path'] as String), isFalse);
      }
      expect(validRestorePreview({...value, 'hooks': ['execute.sh']}, value['path'] as String), isFalse);
    });
  });
}
