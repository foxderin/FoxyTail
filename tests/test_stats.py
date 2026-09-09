#!/usr/bin/env python3
"""Regression checks for reset-aware counter deltas and bucket attribution."""
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]

@unittest.skipUnless(shutil.which('jq'),'jq is needed for runtime stats filters')
class StatsRegression(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='foxytail-stats-');self.addCleanup(self.tmp.cleanup)
  self.dir=Path(self.tmp.name)
  self.script=self.dir/'query.sh'
  self.script.write_text('. ' + shlex.quote(str(ROOT/'tailscale/scripts/foxytail.stats-lib.sh')) + '\njqr() { jq "$@"; }\nstats_recent_files() { echo "$SAMPLES"; }\nquery "$@"\n')
  self.file=self.dir/'samples.jsonl'
 def query(self,mode,*args):
  r=subprocess.run(['sh',str(self.script),mode,*args],env={**os.environ,'SAMPLES':str(self.file),'TZ':'UTC'},text=True,capture_output=True)
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
 def test_cross_hour_and_day_delta_belongs_to_ending_sample(self):
  self.samples([1000,1500,1700,1900],[3590,3610,86390,86410])
  hours=self.query('hourly','1970-01-01')['hours'];self.assertEqual(hours[1]['iface']['rx'],500)
  days=self.query('daily')['days'];self.assertEqual([d['rx'] for d in days],[700,200])
 def test_generation_change_counts_new_counter_even_if_larger(self):
  self.samples([100,200,300],generations=['a','a','b'])
  self.assertEqual(self.query('daily')['days'][0]['rx'],400)
 def test_errors_and_malformed_rows_do_not_become_zero_samples(self):
  rows=self.samples([100,300],[0,120])
  self.file.write_text(json.dumps(rows[0])+'\nnot-json\n'+json.dumps(dict(ts=60,error='daemon-unreachable'))+'\n'+json.dumps(rows[1])+'\n')
  day=self.query('daily')['days'][0];self.assertEqual(day['samples'],2);self.assertEqual(day['rx'],200)
 def test_hourly_missing_interface_is_not_a_recorded_zero(self):
  self.file.write_text(json.dumps(dict(ts=60,iface=None,peers=[],uids=[]))+'\n')
  hour=self.query('hourly','1970-01-01')['hours'][0]
  self.assertEqual(hour['samples'],0)
  self.assertEqual(self.query('daily')['days'][0]['samples'],0)
 def test_recorded_zero_traffic_remains_a_valid_sample(self):
  self.samples([0,0])
  hour=self.query('hourly','1970-01-01')['hours'][0]
  self.assertEqual(hour['samples'],2)
  self.assertEqual(hour['iface'],dict(rx=0,tx=0))
 def test_legacy_uid_rx_does_not_become_tx(self):
  rows=self.samples([100,200])
  for row in rows:row.pop('uidDirection');row['uids']=[dict(uid='10101',rx=1000,tx=0)]
  self.file.write_text('\n'.join(json.dumps(r) for r in rows))
  self.assertEqual(self.query('uids','10')['uids'],[])
 def test_missing_uid_aggregate_keeps_previous_counter_baseline(self):
  rows=self.samples([100,0,300])
  rows[1]['uids']=None
  self.file.write_text('\n'.join(json.dumps(r) for r in rows))
  self.assertEqual(self.query('uids','10')['uids'],[dict(uid='10101',rx=0,tx=200)])
 def test_uid_collection_sums_ipv4_ipv6_as_transmit_bytes(self):
  runner=self.dir/'collect.sh'
  runner.write_text('. ' + shlex.quote(str(ROOT/'tailscale/scripts/foxytail.stats-lib.sh')) + '\n' + """TS_STATS_DIR="$TEST_DIR"
TS_RUN_DIR="$TEST_DIR"
TS_BIN_DIR="$TEST_DIR"
TS_SOCKET="$TEST_DIR/socket"
jqr() { jq "$@"; }
tmo() { echo '{"Peer":{}}'; }
pids_of_path() { :; }
prune_stats() { :; }
iptables() { printf '%s\\n' '1 100 RETURN all -- * tailscale0 0.0.0.0/0 0.0.0.0/0 owner UID match 10101' '1 30 RETURN all -- * tailscale0 0.0.0.0/0 0.0.0.0/0 owner UID match 10102'; }
ip6tables() { printf '%s\\n' '1 200 RETURN all -- * tailscale0 ::/0 ::/0 owner UID match 10101' '1 50 RETURN all -- * tailscale0 ::/0 ::/0 owner UID match 10102'; }
"""+ '\ncollect_once\n')
  result=subprocess.run(['sh',str(runner)],env={**os.environ,'TEST_DIR':str(self.dir)},text=True,capture_output=True)
  self.assertEqual(result.returncode,0,result.stderr)
  row=json.loads(next(self.dir.glob('????-??-??.jsonl')).read_text())
  self.assertEqual(row['uidDirection'],'tx')
  self.assertEqual(row['uids'],[dict(uid='10101',rx=0,tx=300),dict(uid='10102',rx=0,tx=80)])
 def test_empty_input(self):
  self.file.write_text('')
  self.assertEqual(self.query('daily')['days'],[])
  self.assertEqual(self.query('topn','10')['topn'],[])

if __name__=='__main__':unittest.main()
