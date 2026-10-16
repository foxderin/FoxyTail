import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:foxytail/features/settings/settings_state.dart';
import 'package:foxytail/l10n/generated/app_localizations.dart';

Map<String, dynamic> trial(String state, {String id = 'trial-1'}) => {
  'id': id, 'status': state, 'remaining': 120, 'reason': '',
  'candidate': {'mode': 'bridge', 'dnsMode': 'legacy', 'routeScope': 'all'},
  'previous': {'mode': 'tun', 'dnsMode': 'local', 'routeScope': 'selected'},
};

void main() {
  test('diagnostic facts preserve missing and unsupported values', () async {
    final l = await AppLocalizations.delegate.load(const Locale('en'));
    final dns = dnsFacts(l, {'mode': 'transparent', 'enabled': 'false', 'port': 65536});
    expect(dns[l.cs_actual_mode], 'transparent');
    expect(dns[l.cs_dns_enabled], l.cs_value_unknown);
    expect(dns[l.cs_dns_port], l.cs_value_unknown);
    expect(dnsFacts(l, {'port': 1053})[l.cs_dns_port], '1053');
    expect(runtimeFacts(l, {'powerSave': false})[l.cs_power_save], l.cs_no);
    expect(runtimeFacts(l, {})[l.cs_backend_state], l.cs_value_unknown);
    final scenario = scenarioFacts(l, {'running': false, 'lastResult': {'ok': false, 'at': double.infinity}});
    expect(scenario[l.cs_watcher_running], l.cs_no);
    expect(scenario[l.cs_last_ok], l.cs_no);
    expect(scenario[l.cs_last_time], l.cs_value_unknown);
    expect(settingsValue(l, 'rollback-failed'), l.cs_rollback_failed);
  });
  test('field success preserves typing performed after submission', () {
    final values = <String, dynamic>{};
    final draft = SettingsDraft(values, 'settings.DNS_PORT')..receive('1053');
    draft.value = ' 1054 ';
    final submitted = draft.value;
    draft.value = '1055';
    draft.submitted(submitted, '1054');
    expect(draft.value, '1055'); expect(draft.baseline, '1054'); expect(draft.dirty, isTrue);
    draft.receive('1054');
    expect(draft.value, '1055'); expect(draft.conflict(), isFalse);
    final restored = SettingsDraft(Map<String, dynamic>.of(values), 'settings.DNS_PORT')..receive('1054');
    expect(restored.value, '1055'); expect(restored.baseline, '1054');
  });
  test('static context reads remain independent from live status', () {
    final values = <String, dynamic>{};
    const rules = '# baseline\ncellular:-:up\n';
    final draft = SettingsDraft(values, 'context.raw')..receive(rules);
    draft.value = '${rules}ssid:Office:down\n';
    final edited = draft.value;
    // Live failures never enter the static rule model or replace its baseline.
    expect(draft.baseline, rules); expect(draft.value, edited);
    draft.receive('cellular:-:down\n');
    expect(draft.value, edited); expect(draft.baseline, rules); expect(draft.conflict(), isTrue);
    draft.receive('cellular:-:down\n', discard: true);
    expect(draft.value, 'cellular:-:down\n'); expect(draft.conflict(), isFalse);
  });
  test('open visual edit protects an otherwise untouched context baseline', () {
    final draft = SettingsDraft({}, 'context.raw')..receive('ssid:Home:up\r\n');
    draft.receive('ssid:Office:up\n', editing: true);
    expect(draft.value, 'ssid:Home:up\r\n'); expect(draft.conflict(editing: true), isTrue);
  });
  test('trial transitions refresh settings only for changed identity or state', () {
    final state = TrialObservation();
    expect(state.restartAllowed, isFalse);
    expect(state.receive({'trial': null}, 0), isFalse); expect(state.restartAllowed, isTrue);
    expect(state.receive({'trial': null}, 10), isFalse);
    state.changing = true; state.known = false;
    expect(state.restartAllowed, isFalse);
    state.changing = false;
    expect(state.receive({'trial': trial('running')}, 1000), isTrue);
    expect(state.restartAllowed, isFalse); expect(state.canConfirm(121000), isFalse);
    expect(state.receive({'trial': trial('running')}, 2000), isFalse);
    expect(state.receive({'trial': trial('rollback-failed')}, 3000), isTrue);
    expect(state.active, isTrue); expect(state.restartAllowed, isFalse);
    expect(state.receive({'trial': trial('rolled-back')}, 4000), isTrue); expect(state.restartAllowed, isTrue);
    expect(() => state.receive({'trial': {'status': 'running'}}, 5000), throwsFormatException);
  });
  test('invalid trial data fail-closes restart without erasing active identity', () {
    final state = TrialObservation()..receive({'trial': trial('running')}, 1000);
    expect(() => state.receive({'trial': {'status': 'running'}}, 2000), throwsFormatException);
    expect(state.restartAllowed, isFalse); expect(state.known, isFalse); expect(state.trial?['id'], 'trial-1');
    expect(() => state.receive({}, 2000), throwsFormatException);
    expect(() => state.receive({'trial': {...trial('running'), 'remaining': double.nan}}, 2000), throwsFormatException);
    expect(() => state.receive({'trial': {...trial('running'), 'remaining': -1}}, 2000), throwsFormatException);
  });
  test('subnet verification rejects pre-write polls and old errors', () {
    final acceptance = RouteAcceptance();
    final off = <String, dynamic>{'acceptRoutes': false, 'ipv6Enabled': true, 'mode': 'bridge', 'peers': <Object?>[]};
    final first = acceptance.beginRead(); acceptance.receive(first, off);
    final poll = acceptance.beginRead();
    expect(acceptance.enabled, isTrue); expect(acceptance.on, isFalse);
    acceptance.beginWrite(); expect(acceptance.enabled, isFalse);
    expect(acceptance.receive(poll, off), isFalse); expect(acceptance.busy, isTrue);
    final verified = acceptance.beginRead(true);
    acceptance.receive(verified, {...off, 'acceptRoutes': true});
    expect(acceptance.enabled, isTrue); expect(acceptance.on, isTrue);
    acceptance.receive(poll, off); acceptance.fail(poll);
    expect(acceptance.enabled, isTrue); expect(acceptance.on, isTrue);
    acceptance.fail(verified); acceptance.beginRead(); expect(acceptance.enabled, isFalse);
    expect(() => acceptance.receive(acceptance.revision, {'acceptRoutes': true}), throwsFormatException);
    expect(acceptance.enabled, isFalse);
  });
  test('shared UID selection filters all packages and searches package label UID', () {
    final apps = [
      {'label': 'Alpha', 'package': 'com.alpha', 'uid': '10001'},
      {'label': 'Beta', 'package': 'com.beta', 'uid': '10001'},
      {'label': 'Other', 'package': 'com.other', 'uid': '10002'},
    ];
    final selected = <String>{'10001'};
    expect(matchingApps(apps, selected, '', true).length, 2);
    expect(matchingApps(apps, selected, 'BETA', false).single['package'], 'com.beta');
    expect(matchingApps(apps, selected, 'com.al', false).single['label'], 'Alpha');
    expect(matchingApps(apps, selected, '10001', false).length, 2);
    selected.remove('10001');
    expect(matchingApps(apps, selected, '', true), isEmpty);
  });
}
