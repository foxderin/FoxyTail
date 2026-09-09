#!/usr/bin/env python3
"""Run shell network controllers against a stateful fake kernel, never host iptables."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MOCK = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
p=Path(os.environ['MOCK_STATE']); s=json.loads(p.read_text())
a=sys.argv[1:]; cmd=Path(sys.argv[0]).name
s['calls'].append([cmd,*a]); rc=0; out=[]
if cmd in ('iptables','ip6tables'):
 table='filter'
 if '-t' in a: i=a.index('-t');table=a[i+1];del a[i:i+2]
 k=cmd+':'+table; chains=s['chains'].setdefault(k,{'OUTPUT':[],'PREROUTING':[]})
 op=a[0]; ch=a[1] if len(a)>1 else None; rule=a[2:]
 if op in ('-D','-F','-X') and os.environ.get('MOCK_FAIL_IPTABLES_DELETE')=='1':rc=1
 elif op=='-N':
  if ch in chains:rc=1
  else:chains[ch]=[]
 elif op in ('-A','-I'):
  if ch not in chains:rc=1
  elif os.environ.get('MOCK_NO_OWNER')=='1' and 'owner' in rule:rc=1
  else:
   if op=='-I' and rule and rule[0].isdigit():rule=rule[1:]
   chains[ch].insert(0,rule) if op=='-I' else chains[ch].append(rule)
 elif op=='-C':rc=0 if rule in chains.get(ch,[]) else 1
 elif op=='-D':
  if rule in chains.get(ch,[]):chains[ch].remove(rule)
  else:rc=1
 elif op=='-F':
  if ch in chains:chains[ch]=[]
  else:rc=1
 elif op=='-X':
  if ch in chains:del chains[ch]
  else:rc=1
 elif op=='-S':
  selected=chains if ch is None else {ch:chains[ch]} if ch in chains else {}
  if not selected:rc=1
  for name,rules in selected.items():
   if name not in ('OUTPUT','PREROUTING'):out.append('-N '+name)
   for r in rules:out.append(' '.join(['-A',name,*r]))
 elif op in ('-L','-nvxL'):rc=0 if ch in chains else 1
 else:raise ValueError(a)
elif cmd=='ip':
 fam='-4'
 if a[0] in ('-4','-6'):fam=a.pop(0)
 if a[:2]==['link','show']:rc=0
 elif a[0]=='route':
  table=a[a.index('table')+1];key=fam+':'+table;rows=s['routes'].setdefault(key,[])
  if a[1]=='show':
   out=[' '.join(r) for r in rows if ('proto' not in a or ['proto',a[a.index('proto')+1]]==r[3:5]) and ('dev' not in a or ['dev',a[a.index('dev')+1]]==r[1:3])]
  else:
   net=a[2];dev=a[a.index('dev')+1];proto=a[a.index('proto')+1];row=[net,'dev',dev,'proto',proto]
   if a[1]=='add':
    if any(r[0]==net for r in rows):rc=1
    else:rows.append(row)
   elif a[1]=='del':
    if os.environ.get('MOCK_FAIL_DELETE')=='1':rc=1
    elif row in rows:rows.remove(row)
    else:rc=1
   else:raise ValueError('UNSAFE ROUTE ACTION '+str(a))
 elif a[0]=='rule':
  rows=s['rules'].setdefault(fam,[])
  if a[1]=='show':out=[' '.join(r) for r in rows]
  else:
   pref=a[a.index('pref')+1] if 'pref' in a else '32765'; mark=a[a.index('fwmark')+1];table=a[a.index('table')+1]
   row=[pref+':','from','all','fwmark',mark,'lookup',table]
   if a[1]=='add':rows.append(row)
   elif row in rows:rows.remove(row)
   else:rc=1
 else:raise ValueError(a)
p.write_text(json.dumps(s))
print('\n'.join(out),end='\n' if out else '')
sys.exit(rc)
'''

class NetworkRegression(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='foxytail-network-');self.addCleanup(self.tmp.cleanup)
  self.dir=Path(self.tmp.name);(self.dir/'scripts').mkdir();(self.dir/'bin').mkdir();(self.dir/'run').mkdir()
  for name in ('foxytail.route','foxytail.compat','foxytail.dns'):
   shutil.copy(ROOT/'tailscale/scripts'/name,self.dir/'scripts'/name)
  (self.dir/'settings.sh').write_text('''TS_RUN_DIR="$TEST_DIR/run"
TS_SCRIPTS_DIR="$TEST_DIR/scripts"
TS_BIN_DIR="$TEST_DIR/bin"
TS_PID_DIR="$TS_RUN_DIR/pids"
ensure_run_dirs() { mkdir -p "$TS_RUN_DIR" "$TS_PID_DIR"; }
load_conf() { . "$TEST_DIR/config"; }
log() { :; }
pids_of_path() { echo 100; }
jqr() { jq "$@"; }
''')
  settings=(ROOT/'tailscale/settings.sh').read_text()
  with (self.dir/'settings.sh').open('a') as f:f.write(settings[settings.index('_conf_pid_stamp() {'):settings.index('# Read both files under the writer lock')])
  (self.dir/'bin/mock').write_text(MOCK);(self.dir/'bin/mock').chmod(0o755)
  for name in ('ip','iptables','ip6tables'):(self.dir/'bin'/name).symlink_to('mock')
  self.state=self.dir/'state.json';self.state.write_text(json.dumps({'calls':[],'chains':{},'routes':{},'rules':{}}))
  self.env={**os.environ,'TEST_DIR':str(self.dir),'MOCK_STATE':str(self.state),'PATH':str(self.dir/'bin')+os.pathsep+os.environ['PATH']}
  self.config()
 def config(self,**kw):
  c=dict(TS_MODE='bridge',ROUTE_SCOPE='selected',UID_LIST='10101 10102',ROUTE_SUBNETS='100.64.0.0/10 fd7a:115c:a1e0::/48',IPV6='on',ROUTE_TABLE='1052',FWMARK='0x40000000',FWMARK_MASK='0x40000000',MAGIC_DNS='on',DNS_PORT='1053');c.update(kw)
  (self.dir/'config').write_text('\n'.join(f'{k}="{v}"' for k,v in c.items()))
 def run_script(self,name,*args,ok=True):
  r=subprocess.run(['sh',str(self.dir/'scripts'/name),*args],env=self.env,text=True,capture_output=True)
  if ok:self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  else:self.assertNotEqual(r.returncode,0,r.stdout+r.stderr)
  return r
 def read(self):return json.loads(self.state.read_text())
 def write(self,s):self.state.write_text(json.dumps(s))
 def test_reserved_table_and_native_uid_refused_before_mutation(self):
  for table in ('0','52','253','254','255','999','garbage'):
   self.config(ROUTE_TABLE=table);self.run_script('foxytail.route','apply',ok=False)
  self.config(TS_MODE='tun');self.run_script('foxytail.route','apply',ok=False)
  self.config(IPV6='on',ROUTE_SUBNETS='100.64.0.0/10');self.run_script('foxytail.route','apply',ok=False)
  self.assertEqual(self.read()['calls'],[])
 def test_safe_teardown_corrupt_state(self):
  marker=self.dir/'executed'
  (self.dir/'run/route.state').write_text(f'ROUTE_TABLE=254\nBAD=$(touch {marker})\n')
  self.run_script('foxytail.route','teardown')
  self.assertFalse(marker.exists())
  self.assertFalse(any('route' in call for call in self.read()['calls']))
 def test_idempotence_repair_and_exact_ownership(self):
  self.run_script('foxytail.route','apply');self.run_script('foxytail.route','check')
  s=self.read();start=len(s['calls']);self.run_script('foxytail.route','apply')
  self.assertFalse(any(any(x in c for x in ('-A','-F','add','del')) for c in self.read()['calls'][start:]))
  changes=[lambda s:s['chains']['iptables:mangle']['OUTPUT'].clear(),lambda s:s['chains']['iptables:filter']['FOXY_STAT'].clear(),lambda s:s['chains']['iptables:mangle']['OUTPUT'].append(['-j','FOXY_MARK']),lambda s:s['routes']['-4:1052'].clear(),lambda s:s['rules']['-6'].clear()]
  for change in changes:
   s=self.read();change(s);self.write(s)
   self.run_script('foxytail.route','check',ok=False);self.run_script('foxytail.route','apply');self.run_script('foxytail.route','check')
  self.config(UID_LIST='10103');self.run_script('foxytail.route','apply')
  rules=self.read()['chains']['iptables:mangle']['FOXY_MARK'];self.assertFalse(any('10101' in r for r in rules));self.assertTrue(any('10103' in r for r in rules))
  self.assertTrue(all(r[-1]=='0x40000000/0x40000000' and '-d' in r for r in rules if '--set-xmark' in r))
  self.assertIn(['-m','owner','--uid-owner','0','-j','RETURN'],rules)
  stat=self.read()['chains']['iptables:filter']['FOXY_STAT'];self.assertIn('--uid-owner',stat[0]);self.assertEqual(stat[-1],['-j','RETURN']);self.assertIn('tailscale0',stat[0])
  # Teardown leaves a foreign route in the same table intact.
  s=self.read();s['routes']['-4:1052'].append(['192.0.2.0/24','dev','other0','proto','99']);self.write(s)
  self.run_script('foxytail.route','teardown');self.assertEqual(len(self.read()['routes']['-4:1052']),1)
  self.assertFalse(any('flush' in c for c in self.read()['calls']))
 def test_foreign_table_conflict_and_owner_failure_fail_closed(self):
  s=self.read();s['routes']['-4:1052']=[['0.0.0.0/0','dev','foreign0','proto','99']];self.write(s)
  self.run_script('foxytail.route','apply',ok=False)
  self.assertEqual(self.read()['routes']['-4:1052'],s['routes']['-4:1052'])
  s=self.read();s['routes']['-4:1052']=[];self.write(s);self.env['MOCK_NO_OWNER']='1'
  self.run_script('foxytail.route','apply',ok=False)
  self.assertNotIn('FOXY_MARK',self.read()['chains']['iptables:mangle'])
 def test_cleanup_failure_retains_ownership_for_retry(self):
  self.run_script('foxytail.route','apply');self.env['MOCK_FAIL_DELETE']='1'
  self.run_script('foxytail.route','teardown',ok=False)
  self.assertTrue((self.dir/'run/route.state').exists())
  self.assertTrue(self.read()['routes']['-4:1052'])
  self.env.pop('MOCK_FAIL_DELETE');self.run_script('foxytail.route','teardown')
  self.assertFalse((self.dir/'run/route.state').exists())
  self.assertFalse(self.read()['routes']['-4:1052'])
 def test_dns_detection_families_tables_and_targets(self):
  for cmd,table,target in (('iptables','nat','REDIRECT'),('ip6tables','mangle','TPROXY'),('ip6tables','nat','DNAT')):
   s=self.read();s['chains']={cmd+':'+table:{'OUTPUT':[['-p','udp','--dport','53','-j','OTHER_DNS']],'OTHER_DNS':[['-j',target]]}};self.write(s)
   self.run_script('foxytail.compat','check-dns-hijack',ok=False)
  for chains in ({'OUTPUT':[['-p','udp','--dport','53','-j','ACCEPT']]},{'OUTPUT':[],'ORPHAN':[['-p','udp','--dport','53','-j','REDIRECT']]},{'OUTPUT':[['-j','FOXY_DNS']],'FOXY_DNS':[['-p','udp','--dport','53','-j','REDIRECT']]}):
   s=self.read();s['chains']={'iptables:nat':chains};self.write(s);self.run_script('foxytail.compat','check-dns-hijack')

 def test_dns_live_process_preserves_degraded_and_recovers(self):
  dns=(ROOT/'tailscale/scripts/foxytail.dns').read_text()
  runner=self.dir/'dns-runner.sh'
  runner.write_text(""". "$TEST_DIR/settings.sh"
load_conf
DNS_CONF="$TS_RUN_DIR/dnsmasq.conf"
DNS_STATE_FILE="$TS_RUN_DIR/dnsmasq.state"
DNS_CONTEXT_FILE="$TS_RUN_DIR/dnsmasq.context.json"
DNS_BIN="$TS_BIN_DIR/dnsmasq"
DNS_LOG="$TS_RUN_DIR/dnsmasq.log"
PID_FILE="$TS_RUN_DIR/dnsmasq.pid"
TS_SOCKET="$TS_RUN_DIR/tailscaled.sock"
CHAIN_DNS=FOXY_DNS
"""+dns[dns.index('set_state() {'):dns.index('\ncase "$1" in')]+ '\ndns_pids() { [ -f "$TEST_DIR/alive" ] && echo 123; }\nstop_by_pids() { [ "$FAIL_STOP" != 1 ] && rm -f "$TEST_DIR/alive"; }\ntmo() { cat "$TEST_DIR/current.json"; }\ngetprop() { echo 1.1.1.1; }\nrotate_log() { :; }\n"$@"\n')
  wrapper=self.dir/'bin/foxytail.compat';wrapper.write_text('#!/bin/sh\nexec sh "$TEST_DIR/scripts/foxytail.compat" "$@"\n');wrapper.chmod(0o755)
  daemon=self.dir/'bin/dnsmasq';daemon.write_text('#!/bin/sh\ntouch "$TEST_DIR/alive"\n');daemon.chmod(0o755)
  (self.dir/'alive').touch()
  current={'MagicDNSSuffix':'example.ts.net','CurrentTailnet':{'Name':'example','MagicDNSEnabled':True},'Self':{'ID':'device1'}}
  (self.dir/'current.json').write_text(json.dumps(current))
  (self.dir/'run/dnsmasq.context.json').write_text(json.dumps({'suffix':'example.ts.net','tailnet':'example','self':'device1'},separators=(',',':'))+'\n')
  (self.dir/'run/dnsmasq.conf').write_text('port=1053\nlisten-address=::1\nserver=/example.ts.net/100.100.100.100\n')
  def run(*args,ok=True):
   r=subprocess.run(['sh',str(runner),*args],env=self.env,text=True,capture_output=True)
   if ok:self.assertEqual(r.returncode,0,r.stdout+r.stderr)
   else:self.assertNotEqual(r.returncode,0,r.stdout+r.stderr)
   return r.stdout
  state=self.read();state['chains']={'ip6tables:mangle':{'OUTPUT':[['-p','udp','--dport','53','-j','TPROXY']]}};self.write(state)
  run('dns_start');self.assertEqual(json.loads(run('dns_status','--json'))['state'],'degraded')
  state=self.read();state['chains']['ip6tables:mangle']['OUTPUT']=[];self.write(state)
  run('dns_start');self.assertEqual(json.loads(run('dns_status','--json'))['state'],'running')
  state=self.read()
  for cmd in ('iptables','ip6tables'):
   rules=state['chains'][cmd+':nat']['FOXY_DNS'];self.assertTrue(any('tcp' in r for r in rules));self.assertTrue(any('udp' in r for r in rules))
  state['chains']['iptables:nat']['OUTPUT']=[];self.write(state)
  self.assertEqual(json.loads(run('dns_status','--json'))['state'],'degraded')
  run('dns_start');self.assertEqual(json.loads(run('dns_status','--json'))['state'],'running')
  # An account switch invalidates a live process until its suffix is rebuilt.
  current['MagicDNSSuffix']='other.ts.net';current['CurrentTailnet']['Name']='other';current['Self']['ID']='device2'
  (self.dir/'current.json').write_text(json.dumps(current))
  self.assertEqual(json.loads(run('dns_status','--json'))['state'],'degraded')
  run('dns_start');status=json.loads(run('dns_status','--json'));self.assertEqual(status['state'],'running');self.assertEqual(status['suffix'],'other.ts.net')
  # Neither surviving kernel rules nor a surviving daemon may report stopped.
  self.env['MOCK_FAIL_IPTABLES_DELETE']='1';run('dns_stop',ok=False)
  self.assertEqual((self.dir/'run/dnsmasq.state').read_text().strip(),'degraded')
  self.env.pop('MOCK_FAIL_IPTABLES_DELETE');run('dns_start')
  self.env['FAIL_STOP']='1';run('dns_stop',ok=False)
  self.assertEqual(json.loads(run('dns_status','--json'))['state'],'degraded')
  self.env.pop('FAIL_STOP');run('dns_stop');self.assertEqual(json.loads(run('dns_status','--json'))['state'],'stopped')

 def test_route_lock_reclaims_stale_owner_without_parallel_entry(self):
  route=(ROOT/'tailscale/scripts/foxytail.route').read_text()
  runner=self.dir/'lock-runner.sh'
  runner.write_text('. "$TEST_DIR/settings.sh"\n'+route[route.index('route_lock() {'):route.index('\niface_exists()')]+ '\nroute_lock || exit 1\necho enter >>"$TEST_DIR/events"\nsleep 0.03\necho leave >>"$TEST_DIR/events"\n')
  (self.dir/'run/.conf-write-lock').symlink_to('99999999:-')
  procs=[subprocess.Popen(['sh',str(runner)],env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(12)]
  for proc in procs:
   out,err=proc.communicate(timeout=20);self.assertEqual(proc.returncode,0,out+err)
  events=(self.dir/'events').read_text().splitlines()
  self.assertEqual(events,['enter','leave']*12)
  self.assertFalse((self.dir/'run/.conf-write-lock').is_symlink())

if __name__=='__main__':unittest.main()
