#!/usr/bin/env python3
"""Exercise exit preference ownership and truthful policy state without networking."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLI = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ['TEST_DIR'])
p = root / 'daemon.json'
s = json.loads(p.read_text())
a = [v for v in sys.argv[1:] if not v.startswith('--socket=')]
with (root / 'reads').open('a') as f: f.write(json.dumps(a) + '\n')
if s.get('unavailable'): sys.exit(1)
if a[:1] == ['switch']:
 print(json.dumps([] if s.get('unknownProfile') else [{'id': s['profile'], 'selected': True}]))
elif a == ['debug', 'prefs']: print(json.dumps(s['prefs']))
elif a == ['status', '--json']:
 print(json.dumps(s['status']))
 if s.get('changeDuringStatus'):
  s.update(s.pop('changeDuringStatus'))
  p.write_text(json.dumps(s))
elif a[:1] == ['set']:
 with (root / 'writes').open('a') as f: f.write(json.dumps(a) + '\n')
 if s.get('failWrite'): sys.exit(1)
 prefs = s['prefs']
 for arg in a[1:]:
  key, value = arg.split('=', 1)
  if key == '--exit-node':
   prefs['AutoExitNode'] = value[5:] if value.startswith('auto:') else ''
   prefs['ExitNodeID'] = next((v['ID'] for v in s['status']['Peer'].values() if value in v['TailscaleIPs']), '')
   if prefs['AutoExitNode']: prefs['ExitNodeID'] = 'node-a'
   prefs['ExitNodeIP'] = ''
  elif key == '--exit-node-allow-lan-access': prefs['ExitNodeAllowLANAccess'] = value == 'true'
 id = prefs['ExitNodeID']
 s['status']['ExitNodeStatus'] = {'ID': id, 'Online': True, 'TailscaleIPs': ['100.64.0.1' if id == 'node-a' else '100.64.0.2']} if id else None
 p.write_text(json.dumps(s))
else: sys.exit(2)
'''


class ExitRoutingRegression(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='foxytail-exit-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ('scripts', 'bin', 'run', 'state/config-trial'):
            (self.root / name).mkdir(parents=True)
        shutil.copy(ROOT / 'tailscale/scripts/foxytail.exitnode', self.root / 'scripts/foxytail.exitnode')
        (self.root / 'settings.sh').write_text('''TS_DIR="$TEST_DIR"
TS_RUN_DIR="$TEST_DIR/run"
TS_SCRIPTS_DIR="$TEST_DIR/scripts"
TS_SOCKET="$TEST_DIR/socket"
ensure_run_dirs() { :; }
load_runtime_conf() { . "$TEST_DIR/config"; }
conf_lock_acquire() { :; }
conf_lock_release() { :; }
jqr() { jq "$@"; }
tmo() { shift; "$@"; }
ts_status_json() { "$@"; }
''')
        self.config()
        (self.root / 'bin/tailscale').write_text(CLI)
        (self.root / 'bin/tailscale').chmod(0o755)
        (self.root / 'scripts/foxytail.route').write_text('#!/bin/sh\n[ ! -e "$TEST_DIR/route-fails" ]\n')
        (self.root / 'scripts/foxytail.route').chmod(0o755)
        self.env = {**os.environ, 'TEST_DIR': str(self.root), 'PATH': str(self.root / 'bin') + os.pathsep + os.environ['PATH']}
        self.daemon = {'profile': 'profile-a', 'prefs': {'ExitNodeID': '', 'ExitNodeIP': '', 'ExitNodeAllowLANAccess': False},
                       'status': {'BackendState': 'Running', 'Self': {'ID': 'self-a'}, 'ExitNodeStatus': None, 'Peer': {
                           'a': {'ID': 'node-a', 'HostName': 'same-name', 'ExitNodeOption': True, 'TailscaleIPs': ['100.64.0.1']},
                           'b': {'ID': 'node-b', 'HostName': 'same-name', 'ExitNodeOption': True, 'TailscaleIPs': ['100.64.0.2']}}}}
        self.save()

    def config(self, mode='bridge', scope='all', uids='', ipv6='on'):
        (self.root / 'config').write_text(f'TS_MODE={mode}\nROUTE_SCOPE={scope}\nUID_LIST="{uids}"\nIPV6={ipv6}\n')

    def save(self):
        (self.root / 'daemon.json').write_text(json.dumps(self.daemon))

    def reload(self):
        self.daemon = json.loads((self.root / 'daemon.json').read_text())

    def run_exit(self, *args, ok=True):
        proc = subprocess.run(['sh', str(self.root / 'scripts/foxytail.exitnode'), *args], env=self.env, text=True, capture_output=True)
        self.assertEqual(proc.returncode == 0, ok, proc.stdout + proc.stderr)
        return json.loads(proc.stdout) if proc.stdout.strip() else None

    def begin_trial(self):
        (self.root / 'state/config-trial/status').write_text('running\n')

    def restore(self, ok=True):
        return self.run_exit('trial-restore', str(self.root / 'state/config-trial'), ok=ok)


    def test_read_rejects_identity_preferences_or_config_changed_during_policy_check(self):
        self.run_exit('set', 'node-a')
        self.reload()
        original = json.loads(json.dumps(self.daemon))
        helper = self.root / 'scripts/foxytail.route'
        for change in ('profile', 'self', 'preferences', 'config'):
            with self.subTest(change=change):
                self.daemon = json.loads(json.dumps(original))
                self.save()
                self.config()
                helper.write_text('''#!/bin/sh
python3 - "$TEST_DIR" ''' + change + ''' <<'PY'
import json, sys
from pathlib import Path
root, change = Path(sys.argv[1]), sys.argv[2]
p = root / 'daemon.json'
s = json.loads(p.read_text())
if change == 'profile': s['profile'] = 'other'
elif change == 'self': s['status']['Self']['ID'] = 'other'
elif change == 'preferences': s['prefs']['ExitNodeAllowLANAccess'] = True
else:
 c = root / 'config'
 c.write_text(c.read_text().replace('ROUTE_SCOPE=all', 'ROUTE_SCOPE=selected'))
p.write_text(json.dumps(s))
PY
''')
                writes = (self.root / 'writes').read_text()
                result = self.run_exit('status')
                self.assertFalse(result['known'])
                self.assertEqual(result['effective'], 'unknown')
                self.assertEqual((self.root / 'writes').read_text(), writes)


    def test_exact_identity_and_route_failure_are_not_success(self):
        self.run_exit('set', 'same-name', ok=False)
        self.assertFalse((self.root / 'writes').exists())
        (self.root / 'route-fails').touch()
        result = self.run_exit('set', 'node-b', ok=False)
        self.assertFalse(result['ok'])
        self.assertEqual(result['exitRouting']['selected']['id'], 'node-b')
        self.assertEqual(result['exitRouting']['effective'], 'not-effective')
        self.assertFalse(result['exitRouting']['ipv4'])
        (self.root / 'route-fails').unlink()
        result = self.run_exit('set', 'node-b')
        self.assertEqual(result['exitRouting']['effective'], 'bridge-policy')


    def test_trial_restores_original_auto_and_lan_preference(self):
        self.daemon['prefs'].update(ExitNodeID='node-a', AutoExitNode='any', ExitNodeAllowLANAccess=True)
        self.daemon['status']['ExitNodeStatus'] = {'ID': 'node-a', 'Online': True}
        self.save()
        self.begin_trial()
        self.run_exit('set', 'node-b', '--context')
        self.restore()
        self.reload()
        self.assertEqual(self.daemon['prefs']['AutoExitNode'], 'any')
        self.assertTrue(self.daemon['prefs']['ExitNodeAllowLANAccess'])
        self.assertFalse((self.root / 'state/config-trial/exit-preference.json').exists())

    def test_trial_manual_same_id_pref_changes_prevent_rollback(self):
        for change in ({'ExitNodeAllowLANAccess': True}, {'AutoExitNode': 'any'}):
            with self.subTest(change=change):
                self.daemon['prefs'].update(ExitNodeID='', AutoExitNode='', ExitNodeAllowLANAccess=False)
                self.daemon['status']['ExitNodeStatus'] = None
                self.save()
                self.begin_trial()
                self.run_exit('set', 'node-b', '--context')
                self.reload()
                self.daemon['prefs'].update(change)
                self.save()
                before = (self.root / 'writes').read_text()
                self.restore()
                self.assertEqual((self.root / 'writes').read_text(), before)
                self.reload()
                self.assertEqual(self.daemon['prefs']['ExitNodeID'], 'node-b')

    def test_trial_profile_mismatch_retains_journal_without_writing(self):
        self.begin_trial()
        self.run_exit('set', 'node-a', '--context')
        self.reload()
        self.daemon['profile'] = 'profile-b'
        self.save()
        before = (self.root / 'writes').read_text()
        self.restore(ok=False)
        self.assertEqual((self.root / 'writes').read_text(), before)
        self.assertTrue((self.root / 'state/config-trial/exit-preference.json').exists())


    def test_trial_daemon_unavailable_retains_recoverable_journal(self):
        self.begin_trial()
        self.run_exit('set', 'node-a', '--context')
        self.reload()
        self.daemon['unavailable'] = True
        self.save()
        self.restore(ok=False)
        self.assertTrue((self.root / 'state/config-trial/exit-preference.json').exists())
        self.daemon['unavailable'] = False
        self.save()
        self.restore()
        self.reload()
        self.assertEqual(self.daemon['prefs']['ExitNodeID'], '')


    def test_corrupt_journal_fails_without_preference_write(self):
        self.begin_trial()
        self.run_exit('set', 'node-b', '--context')
        journal = self.root / 'state/config-trial/exit-preference.json'
        entry = json.loads(journal.read_text())
        entry['expected'].pop('allowLAN')
        journal.write_text(json.dumps(entry))
        before = (self.root / 'writes').read_text()
        self.restore(ok=False)
        self.assertEqual((self.root / 'writes').read_text(), before)
        self.assertTrue(journal.exists())


if __name__ == '__main__':
    unittest.main()
