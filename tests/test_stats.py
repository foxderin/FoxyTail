#!/usr/bin/env python3
"""Regression checks for reset-aware counter deltas and bucket attribution."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from runtime_fixture import install_settings

ROOT=Path(__file__).resolve().parents[1]

@unittest.skipUnless(shutil.which('jq'),'jq is needed for runtime stats filters')
class StatsRegression(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='foxytail-stats-');self.addCleanup(self.tmp.cleanup)
  self.dir=Path(self.tmp.name)
  binary=os.environ.get('FOXYFILES_TEST_BINARY')
  if not binary:self.skipTest('run .github/tools/verify.sh to provide the native statistics helper')
  shutil.copyfile(binary,self.dir/'foxyfiles');(self.dir/'foxyfiles').chmod(0o755)
  script=(ROOT/'tailscale/scripts/foxytail.stats').read_text()
  self.script=self.dir/'query.sh'
  self.script.write_text('TS_RUN_DIR="$TEST_DIR"\nTS_BIN_DIR="$TEST_DIR"\njqr() { jq "$@"; }\nstats_recent_files() { echo "$SAMPLES"; }\n'+script[script.index('stats_summary() ('):script.index('\ncase "$1" in')]+ '\nquery "$@"\n')
  self.file=self.dir/'samples.jsonl'
 def query(self,mode,*args):
  r=subprocess.run(['sh',str(self.script),mode,*args],env={**os.environ,'TEST_DIR':str(self.dir),'SAMPLES':str(self.file),'TZ':'UTC'},text=True,capture_output=True)
  self.assertEqual(r.returncode,0,r.stderr)
  return json.loads(r.stdout)
 def samples(self,values,times=None,generations=None):
  times=times or [i*60 for i in range(len(values))]
  rows=[]
  for i,v in enumerate(values):
   rows.append(dict(ts=times[i],iface=dict(rx=v,tx=v),peers=[dict(id='peer',rx=v,tx=v)],uids=[dict(uid='10101',rx=0,tx=v)],uidDirection='tx',generation=dict(iface=(generations or ['a']*len(values))[i],peers=(generations or ['a']*len(values))[i],uids=(generations or ['a']*len(values))[i])))
  self.file.write_text('\n'.join(json.dumps(r) for r in rows)+'\n');return rows
 def test_counter_reset_accumulates_observable_bytes(self):
  self.samples([1000,1500,0,200])
  day=self.query('daily')['days'][0];self.assertEqual((day['rx'],day['tx']),(700,700))
  self.assertEqual(self.query('topn','10')['topn'][0]['rx'],700)
  self.assertEqual(self.query('uids','10')['uids'][0],dict(uid='10101',rx=0,tx=700))
 def test_generation_change_counts_new_counter_even_if_larger(self):
  self.samples([100,200,300],generations=['a','a','b'])
  self.assertEqual(self.query('daily')['days'][0]['rx'],400)
 def test_errors_and_malformed_rows_do_not_become_zero_samples(self):
  rows=self.samples([100,300],[0,120])
  self.file.write_text(json.dumps(rows[0])+'\nnot-json\n'+json.dumps(dict(ts=60,error='daemon-unreachable'))+'\n'+json.dumps(rows[1])+'\n')
  day=self.query('daily')['days'][0];self.assertEqual(day['samples'],2);self.assertEqual(day['rx'],200)
 def test_repeated_queries_invalidate_appends_truncation_and_replacement(self):
  rows=self.samples([100,200])
  first=self.query('summary','1970-01-01')
  cache=self.dir/'.stats-summary-cache'
  stamp=cache.stat().st_mtime_ns
  self.assertEqual(self.query('summary','1970-01-01'),first)
  self.assertEqual(cache.stat().st_mtime_ns,stamp)
  with self.file.open('a') as stream:stream.write(json.dumps(dict(ts=120,iface=dict(rx=400,tx=400),generation=rows[-1]['generation']))+'\n')
  self.assertEqual(self.query('daily')['days'][0]['rx'],300)
  self.file.write_text(json.dumps(rows[0])+'\n')
  self.assertEqual(self.query('daily')['days'][0]['samples'],1)
  replacement=self.dir/'replacement.jsonl'
  replacement.write_text(json.dumps(dict(ts=0,iface=None))+'\n')
  replacement.replace(self.file)
  self.assertEqual(self.query('daily')['days'][0]['samples'],0)
 def test_uid_collection_sums_ipv4_ipv6_as_transmit_bytes(self):
  snapshot=self.dir/'route.snapshot';snapshot.mkdir()
  for family in ['iptables','ip6tables']:
   (snapshot/(family+'.filter')).write_text('-A FOXY_STAT -m owner --uid-owner 10101 -j RETURN\n')
  source=(ROOT/'tailscale/scripts/foxytail.stats').read_text()
  runner=self.dir/'collect.sh'
  runner.write_text("""TS_STATS_DIR="$TEST_DIR"
TS_RUN_DIR="$TEST_DIR"
TS_BIN_DIR="$TEST_DIR"
TS_SOCKET="$TEST_DIR/socket"
jqr() { jq "$@"; }
ts_status_json() { _tsj_r=$1; shift; "$_tsj_r" "$@"; }
tmo() { echo '{"Peer":{}}'; }
pids_of_path() { :; }
prune_stats() { :; }
iptables() { printf '%s\\n' '1 100 RETURN all -- * tailscale0 0.0.0.0/0 0.0.0.0/0 owner UID match 10101' '1 30 RETURN all -- * tailscale0 0.0.0.0/0 0.0.0.0/0 owner UID match 10102'; }
ip6tables() { printf '%s\\n' '1 200 RETURN all -- * tailscale0 ::/0 ::/0 owner UID match 10101' '1 50 RETURN all -- * tailscale0 ::/0 ::/0 owner UID match 10102'; }
"""+source[source.index('collect_once() {'):source.index('\n_stats_stop() {')]+ '\ncollect_once\n')
  result=subprocess.run(['sh',str(runner)],env={**os.environ,'TEST_DIR':str(self.dir)},text=True,capture_output=True)
  self.assertEqual(result.returncode,0,result.stderr)
  row=json.loads(next(self.dir.glob('????-??-??.jsonl')).read_text())
  self.assertEqual(row['uidDirection'],'tx')
  self.assertEqual(row['uids'],[dict(uid='10101',rx=0,tx=300),dict(uid='10102',rx=0,tx=80)])
 def collect(self,body):
  source=(ROOT/'tailscale/scripts/foxytail.stats').read_text()
  runner=self.dir/'collect.sh'
  runner.write_text('''TS_STATS_DIR="$TEST_DIR"
TS_RUN_DIR="$TEST_DIR"
TS_BIN_DIR="$TEST_DIR"
TS_SOCKET="$TEST_DIR/socket"
jqr() { echo jq >>"$TEST_DIR/calls"; jq "$@"; }
ts_status_json() { _tsj_r=$1; shift; "$_tsj_r" "$@"; }
tmo() { echo cli >>"$TEST_DIR/calls"; cat "$TEST_DIR/status"; }
pids_of_path() { :; }
prune_stats() { echo prune >>"$TEST_DIR/calls"; }
chmod() { echo chmod >>"$TEST_DIR/calls"; command chmod "$@"; }
iptables() { echo ipv4 >>"$TEST_DIR/calls"; echo '1 100 RETURN all -- * tailscale0 0.0.0.0/0 0.0.0.0/0 owner UID match 10101'; }
ip6tables() { echo ipv6 >>"$TEST_DIR/calls"; echo '1 200 RETURN all -- * tailscale0 ::/0 ::/0 owner UID match 10101'; }
'''+source[source.index('collect_once() {'):source.index('\n_stats_stop() {')]+'\n'+body)
  (self.dir/'status').write_text('{"Peer":{"peer":{"ID":"peer","RxBytes":100,"TxBytes":200}}}')
  result=subprocess.run(['sh',str(runner)],env={**os.environ,'TEST_DIR':str(self.dir)},text=True,capture_output=True)
  self.assertEqual(result.returncode,0,result.stderr)
  return (self.dir/'calls').read_text().splitlines()
 def test_hot_route_apply_changes_owned_families_and_generation_on_next_sample(self):
  calls=self.collect('''collect_once
mkdir "$TEST_DIR/route.snapshot"
echo '-A FOXY_STAT -m owner --uid-owner 10101 -j RETURN' >"$TEST_DIR/route.snapshot/iptables.filter"
echo first >"$TEST_DIR/route.snapshot/generation"
collect_once
echo '-A FOXY_STAT -m owner --uid-owner 10101 -j RETURN' >"$TEST_DIR/route.snapshot/ip6tables.filter"
echo second >"$TEST_DIR/route.snapshot/generation"
collect_once
''')
  rows=[json.loads(row) for row in next(self.dir.glob('????-??-??.jsonl')).read_text().splitlines()]
  self.assertEqual([row['uids'] for row in rows],[[],[dict(uid='10101',rx=0,tx=100)],[dict(uid='10101',rx=0,tx=300)]])
  self.assertEqual([row['generation']['uids'] for row in rows],['','first','second'])

class StatsLifecycle(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='foxytail-stats-loop-');self.addCleanup(self.tmp.cleanup)
  self.base=Path(self.tmp.name)
  for name in ['conf','scripts','bin']:(self.base/name).mkdir()
  self.settings=install_settings(self.base)
  self.script=self.base/'scripts/foxytail.stats'
  self.script.write_bytes((ROOT/'tailscale/scripts/foxytail.stats').read_bytes())
  self.main=self.base/'conf/foxytail.conf'
  self.main.write_text('STATS=on\nSTATS_INTERVAL=60\n')
  with self.settings.open('a') as stream:
   stream.write('''
tmo() { echo cli >>"$TS_DIR/cli-calls"; echo '{"Peer":{}}'; }
pids_of_path() { :; }
is_screen_on() { [ "${_test_round:-0}" = 0 ]; }
''')
 def run_loop(self):
  result=subprocess.run(['sh',str(self.script),'start'],cwd=self.base,text=True,capture_output=True,timeout=10)
  self.assertEqual(result.returncode,0,result.stdout+result.stderr)
  self.assertFalse((self.base/'run/pids/foxytail.stats.pid').exists())
 def test_disabled_stats_create_no_worker_and_reenable_preserves_samples(self):
  with self.settings.open('a') as stream:
   stream.write('''
isleep() {
  echo slept >>"$TS_DIR/intervals"
  echo STATS=off >"$TS_CONF_DIR/foxytail.conf"
}
''')
  self.main.write_text('STATS=off\n')
  self.run_loop()
  self.assertFalse((self.base/'cli-calls').exists())
  for expected in [1,2]:
   self.main.write_text('STATS=on\nSTATS_INTERVAL=60\n')
   self.run_loop()
   self.assertEqual(len((self.base/'cli-calls').read_text().splitlines()),expected)
   self.assertEqual(len(next((self.base/'run/stats').glob('*.jsonl')).read_text().splitlines()),expected)
  self.assertEqual((self.base/'intervals').read_text().splitlines(),['slept','slept'])


if __name__=='__main__':unittest.main()
