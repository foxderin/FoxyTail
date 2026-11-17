"""Root receive policy/event producer: real shell helpers, no Android claims."""
import json
import shlex
from api_fixture import ApiTestCase, ROOT


class ReceiveMonitorTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        (self.sdcard / 'Download/Taildrop').mkdir()
        source = (ROOT / 'tailscale/scripts/foxytail.receive').read_text()
        source = source.replace('/sdcard', str(self.sdcard))
        functions = source[source.index('# Atomic private state'):source.index('case "${1:-}" in')]
        self.lib.write_text(self.lib.read_text() + '\n' + functions + '''
RECEIVE_STATE="$TS_RUN_DIR/receive-monitor.json"
RECEIVE_JOB="$TS_RUN_DIR/receive-job.json"
TS_MOD_DIR="$TS_DIR/module"
tmo() {
  shift
  case "$1" in
    */foxyfiles) [ ! -f "$TS_RUN_DIR/scan-failed" ] && cat "$TS_RUN_DIR/snapshot" ;;
    am) printf '%s\\n' "$*" >>"$TS_RUN_DIR/broadcasts"; return 1 ;;
    *) return 1 ;;
  esac
}
receive_api() {
  printf '%s\\n' "$*" >>"$TS_RUN_DIR/operations-log"
  case "$1" in
    operation-start) test -f "$RECEIVE_JOB" || return 99; return 1 ;;
    operation-status) cat "$TS_RUN_DIR/job-status" ;;
  esac
}
''')
        self.snapshot_file([])

    def snapshot_file(self, files, self_id='self-a', mode='direct', pending=None):
        (self.run / 'snapshot').write_text(json.dumps({'ok': True, 'files': files,
            'receive': {'selfId': self_id, 'mode': mode, 'pending': pending or []}}))

    def entry(self, name='new.txt', size=3, mtime=100):
        return dict(name=name, size=size, mtime=mtime)

    def broadcasts(self):
        p = self.run / 'broadcasts'
        return p.read_text().splitlines() if p.exists() else []

    def test_hot_preference_defaults_validation_and_pending_isolation(self):
        settings = json.loads(self.shell('load_conf; cmd_settings_get').stdout)['settings']
        self.assertEqual(settings['TAILDROP_AUTO_RECEIVE'], '0')
        result = json.loads(self.shell('cmd_settings_set TAILDROP_AUTO_RECEIVE 1').stdout)
        self.assertTrue(result['applied'])
        self.assertFalse(result['restartRequired'])
        self.assertFalse((self.run / 'settings.pending').exists())
        self.shell('cmd_settings_set TAILDROP_AUTO_RECEIVE on', ok=False)
        self.assertIn('TAILDROP_AUTO_RECEIVE="1"', (self.conf / 'foxytail.conf').read_text())
        self.shell('cmd_settings_set STATS off')
        marker = (self.run / 'settings.pending').read_text()
        self.shell('cmd_settings_set TAILDROP_AUTO_RECEIVE 0')
        self.assertEqual((self.run / 'settings.pending').read_text(), marker)

    def test_baseline_new_files_and_at_most_once_even_broadcast_failure(self):
        self.snapshot_file([self.entry('history.txt')])
        self.shell('receive_round')
        self.assertEqual(self.broadcasts(), [])
        self.snapshot_file([self.entry('history.txt'), self.entry('new "quote".txt')])
        self.shell('receive_round; receive_round')
        calls = self.broadcasts()
        self.assertEqual(len(calls), 1)
        self.assertIn('--exclude-stopped-packages', calls[0])
        self.assertNotIn('--include-stopped-packages', calls[0])
        self.assertRegex(calls[0], r'--es event_id [0-9a-f]{64} --ei count 1 --es kind completed$')
        self.assertNotIn('quote', calls[0])
        self.assertEqual((self.run / 'receive-monitor.json').stat().st_mode & 0o777, 0o600)

    def test_account_restart_baselines_and_incomplete_files(self):
        self.shell('receive_round')
        self.snapshot_file([self.entry('x.partial'), self.entry('x.deleted')])
        self.shell('receive_round')
        self.assertEqual(self.broadcasts(), [])
        self.snapshot_file([self.entry('history')], self_id='self-b')
        self.shell('receive_round')
        self.snapshot_file([self.entry('history'), self.entry('downtime')], self_id='self-b')
        self.shell('_RECEIVE_BASELINE=1; receive_round')
        self.assertEqual(self.broadcasts(), [])

    def test_failed_locked_and_unavailable_scans_preserve_observations(self):
        self.snapshot_file([self.entry()])
        self.shell('receive_round')
        before = (self.run / 'receive-monitor.json').read_text()
        (self.run / 'scan-failed').touch()
        self.shell('receive_round', ok=False)
        (self.run / 'scan-failed').unlink()
        self.shell('taildrop_inbox_dir() { return 1; }; receive_round')
        self.snapshot_file([], self_id='', mode='unavailable')
        self.shell('receive_round', ok=False)
        self.assertEqual((self.run / 'receive-monitor.json').read_text(), before)
        self.snapshot_file([self.entry()])
        self.shell('receive_round')
        self.assertEqual(self.broadcasts(), [])

    def test_auto_recovery_journals_and_only_resubmits_identical_id(self):
        self.snapshot_file([], mode='buffered', pending=[dict(name='a $(touch nope).txt', size=3)])
        self.shell('receive_round')
        self.assertFalse((self.run / 'operations-log').exists())
        self.shell('cmd_settings_set TAILDROP_AUTO_RECEIVE 1')
        self.shell('receive_round', ok=False)  # ambiguous start, journal survives
        job = json.loads((self.run / 'receive-job.json').read_text())
        self.assertRegex(job['id'], r'^\d+_receive_[a-f0-9]{64}$')
        self.shell('receive_round', ok=False)  # unavailable receipt: only same ID may be reconciled
        calls = (self.run / 'operations-log').read_text().splitlines()
        self.assertEqual(sum(x.startswith('operation-start ') for x in calls), 2)
        self.assertEqual(calls[0], calls[-1])
        (self.run / 'job-status').write_text('{"ok":true,"operation":{"state":"running"}}')
        self.shell('cmd_settings_set TAILDROP_AUTO_RECEIVE 0; receive_round')
        self.assertTrue((self.run / 'receive-job.json').exists())
        (self.run / 'job-status').write_text('{"ok":true,"operation":{"state":"completed","result":{"ok":true,"received":true}}}')
        self.shell('receive_round; receive_round')
        self.assertFalse((self.run / 'receive-job.json').exists())
        self.assertEqual(sum(x.startswith('operation-start ') for x in (self.run / 'operations-log').read_text().splitlines()), 2)

    def test_service_stop_disable_install_guards(self):
        for marker in [self.run / 'manual-stop', self.run / 'context-stop', self.base / '.installing']:
            marker.touch()
            self.shell('receive_round')
            self.assertFalse((self.run / 'receive-monitor.json').exists())
            marker.unlink()
        (self.base / 'module').mkdir()
        (self.base / 'module/disable').touch()
        self.shell('receive_round')
        self.assertFalse((self.run / 'receive-monitor.json').exists())

    def test_unknown_and_interrupted_outcome_is_visible_and_never_new_id(self):
        self.snapshot_file([], mode='buffered', pending=[dict(name='a.txt',size=1)])
        self.shell('cmd_settings_set TAILDROP_AUTO_RECEIVE 1; receive_round', ok=False)
        before = (self.run / 'receive-job.json').read_text()
        for state in ['interrupted', 'completed']:
            (self.run / 'job-status').write_text(json.dumps({'ok':True,'operation':{'state':state,'result':{'ok':False}}}))
            self.shell('receive_round', ok=False)
            self.assertEqual((self.run / 'receive-job.json').read_text(), before)
            self.assertEqual(json.loads((self.run / 'receive-status.json').read_text())['state'], 'blocked')
        self.assertEqual(sum(x.startswith('operation-start ') for x in (self.run / 'operations-log').read_text().splitlines()), 1)

    def test_large_inbox_snapshot_is_not_passed_in_one_argv(self):
        files = [self.entry(str(i).zfill(5) + 'x'*100) for i in range(3000)]
        self.snapshot_file(files)
        self.shell('receive_round; receive_round')
        self.assertEqual(self.broadcasts(), [])
        self.snapshot_file(files + [self.entry('fresh')])
        self.shell('receive_round')
        self.assertEqual(len(self.broadcasts()), 1)

    def test_auto_skips_partial_and_oversize_items(self):
        self.snapshot_file([], mode='buffered', pending=[dict(name='bad.partial',size=1),
            dict(name='huge',size=2147483649),dict(name='good',size=2)])
        self.shell('cmd_settings_set TAILDROP_AUTO_RECEIVE 1; receive_round', ok=False)
        self.assertEqual(json.loads((self.run / 'receive-job.json').read_text())['name'], 'good')

    def test_manual_recovery_reconciles_blocked_journal_only_same_account(self):
        self.snapshot_file([], mode='buffered', pending=[dict(name='a.txt',size=1)])
        self.shell('cmd_settings_set TAILDROP_AUTO_RECEIVE 1; receive_round', ok=False)
        (self.run / 'job-status').write_text('{"ok":true,"operation":{"state":"interrupted"}}')
        self.snapshot_file([self.entry('a.txt')], self_id='other', mode='buffered')
        self.shell('receive_round', ok=False)
        self.assertTrue((self.run / 'receive-job.json').exists())
        self.snapshot_file([self.entry('a.txt')], mode='buffered')
        self.shell('receive_round')
        self.assertFalse((self.run / 'receive-job.json').exists())
        self.assertEqual(json.loads((self.run / 'receive-status.json').read_text())['state'],'idle')

    def test_pending_arrivals_notify_with_auto_off_and_missing_inbox(self):
        (self.sdcard / 'Download/Taildrop').rmdir()
        self.snapshot_file([], mode='buffered')
        self.shell('receive_round')
        self.snapshot_file([], mode='buffered', pending=[dict(name='wait.txt',size=3)])
        self.shell('receive_round; receive_round')
        self.assertEqual(len(self.broadcasts()),1)
        self.assertTrue(self.broadcasts()[0].endswith('--es kind pending'))
        self.assertFalse((self.run / 'operations-log').exists())

    def test_pending_and_completed_distinct_and_repeated_arrival_unique(self):
        self.snapshot_file([], mode='buffered')
        self.shell('receive_round')
        self.snapshot_file([], mode='buffered',pending=[dict(name='a',size=3)])
        self.shell('receive_round')
        self.snapshot_file([self.entry('a')], mode='buffered')
        self.shell('receive_round')
        self.snapshot_file([self.entry('a')], mode='buffered',pending=[dict(name='a',size=3)])
        self.shell('receive_round')
        calls = self.broadcasts()
        self.assertEqual(len(calls),3)
        self.assertTrue(calls[0].endswith('--es kind pending'))
        self.assertTrue(calls[1].endswith('--es kind completed'))
        self.assertTrue(calls[2].endswith('--es kind pending'))
        self.assertNotEqual(calls[0],calls[2])

    def test_completed_metadata_edit_is_not_a_new_arrival(self):
        self.snapshot_file([self.entry('a',1,1)])
        self.shell('receive_round')
        self.snapshot_file([self.entry('a',2,2)])
        self.shell('receive_round')
        self.assertEqual(self.broadcasts(),[])

    def test_first_pending_snapshot_is_baseline_not_old_notification(self):
        self.snapshot_file([],mode='buffered',pending=[dict(name='old',size=4)])
        self.shell('receive_round')
        self.snapshot_file([],mode='buffered',pending=[dict(name='old',size=4),dict(name='new',size=1)])
        self.shell('receive_round')
        self.assertEqual(len(self.broadcasts()),1)
        self.assertIn('--ei count 1 --es kind pending', self.broadcasts()[0])

    def test_restart_baseline_preserves_generation_for_identical_later_arrival(self):
        self.snapshot_file([],mode='buffered')
        self.shell('_RECEIVE_BASELINE=1; receive_round')
        self.snapshot_file([],mode='buffered',pending=[dict(name='same.txt',size=4)])
        self.shell('receive_round')
        first_generation = json.loads((self.run / 'receive-monitor.json').read_text())['generation']
        self.snapshot_file([],mode='buffered')
        self.shell('_RECEIVE_BASELINE=1; receive_round')
        self.assertGreater(json.loads((self.run / 'receive-monitor.json').read_text())['generation'],first_generation)
        self.snapshot_file([],mode='buffered',pending=[dict(name='same.txt',size=4)])
        self.shell('receive_round; receive_round')
        calls = self.broadcasts()
        self.assertEqual(len(calls),2)
        self.assertNotEqual(calls[0],calls[1])
        self.assertTrue(all(x.endswith('--es kind pending') for x in calls))
