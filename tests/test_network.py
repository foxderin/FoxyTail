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
 waited=False
 if a[:2]==['-w','2']:waited=True;del a[:2]
 table='filter'
 if '-t' in a: i=a.index('-t');table=a[i+1];del a[i:i+2]
 if cmd=='ip6tables' and table=='nat' and os.environ.get('MOCK_NO_IPV6_NAT')=='1':
  p.write_text(json.dumps(s));sys.stderr.write('ip6tables: nat table does not exist\n');sys.exit(3)
 k=cmd+':'+table; chains=s['chains'].setdefault(k,{'OUTPUT':[],'PREROUTING':[]})
 op=a[0]; ch=a[1] if len(a)>1 else None; rule=a[2:]
 if op in ('-N','-A','-I','-D','-F','-X') and os.environ.get('MOCK_XTABLES_REQUIRE_WAIT')=='1' and not waited:rc=4
 elif op=='-A' and os.environ.get('MOCK_XTABLES_TIMEOUT_ONCE')=='1' and not s.get('xtablesTimedOut'):
  s['xtablesTimedOut']=True;rc=4
 elif op in ('-D','-F','-X') and os.environ.get('MOCK_FAIL_IPTABLES_DELETE')=='1':rc=1
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
   for r in rows:
    if 'proto' in a and ['proto',a[a.index('proto')+1]]!=r[3:5]:continue
    if 'dev' in a and ['dev',a[a.index('dev')+1]]!=r[1:3]:continue
    rendered=list(r)
    # Real Android iproute2 suppresses selectors in its filtered output.
    for field in ('proto','dev'):
     if field in a:i=rendered.index(field);del rendered[i:i+2]
    out.append(' '.join(rendered))
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
load_runtime_conf() { load_conf; }
conf_apply_runtime() { :; }
log() { :; }
pids_of_path() { echo 100; }
jqr() { jq "$@"; }
have_jq() { return 0; }
''')
  settings=(ROOT/'tailscale/scripts/foxytail.lock.sh').read_text()
  with (self.dir/'settings.sh').open('a') as f:f.write(settings[settings.index('_conf_pid_stamp() {'):])
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
 def setup_binder(self):
  (self.dir/'bin/service').write_text('''#!/bin/sh
case "$1" in
 list) printf '%s\\n' "${MOCK_DESCRIPTOR:-176 dnsresolver: [android.net.IDnsResolver]}" ;;
 call)
  printf '%s\\n' "$*" >>"$TEST_DIR/service-calls"
  case "$3" in
   16777215) printf "Result: Parcel( 00000000 %s '........')\\n" "${MOCK_RESOLVER_VERSION:-0000000f}" ;;
   11) printf "Result: Parcel(00000000 '....')\\n" ;;
   *) exit 1 ;;
  esac ;;
esac
''')
  (self.dir/'bin/service').chmod(0o755)
  (self.dir/'bin/dumpsys').write_text('#!/bin/sh\nprintf "NetId: 102\\nNetId: 101\\nNetId: 102\\nNetId: -1\\nNetId: invalid\\nNetId: 999999\\n"\n')
  (self.dir/'bin/dumpsys').chmod(0o755)
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
 def test_route_xtables_wait_is_bounded_and_failure_rolls_back(self):
  self.env['MOCK_XTABLES_REQUIRE_WAIT']='1'
  self.run_script('foxytail.route','apply');self.run_script('foxytail.route','check')
  self.run_script('foxytail.route','teardown')
  calls=[c for c in self.read()['calls'] if c[0] in ('iptables','ip6tables')]
  mutations=[c for c in calls if any(op in c for op in ('-N','-A','-I','-D','-F','-X'))]
  reads=[c for c in calls if any(op in c for op in ('-C','-S'))]
  self.assertTrue(mutations);self.assertTrue(reads)
  self.assertTrue(all(c[1:3]==['-w','2'] for c in mutations))
  self.assertTrue(all('-w' not in c for c in reads))
  self.env['MOCK_XTABLES_TIMEOUT_ONCE']='1'
  self.run_script('foxytail.route','apply',ok=False)
  state=self.read();self.assertTrue(state['xtablesTimedOut'])
  self.assertNotIn('FOXY_MARK',state['chains']['iptables:mangle'])
  self.assertNotIn('FOXY_STAT',state['chains']['iptables:filter'])
  self.assertFalse((self.dir/'run/route.state').exists())
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

 def test_installed_proxy_is_inventory_until_dns_conflict_exists(self):
  pm=self.dir/'bin/pm';pm.write_text('#!/bin/sh\necho package:com.follow.clash\n');pm.chmod(0o755)
  data=json.loads(self.run_script('foxytail.compat','probe').stdout)
  self.assertEqual(data['apps'],[{'package':'com.follow.clash','kind':'proxy'}]);self.assertEqual(data['warnings'],[])
  s=self.read();s['chains']['iptables:nat']['OUTPUT']=[['-p','udp','--dport','53','-j','REDIRECT','--to-ports','5353']];self.write(s)
  data=json.loads(self.run_script('foxytail.compat','probe').stdout)
  self.assertEqual(len(data['warnings']),1);self.assertIn('port 53',data['warnings'][0])

 def test_dns_cache_flush_requires_verified_interface_and_targets_existing_networks(self):
  self.setup_binder()
  dns=(ROOT/'tailscale/scripts/foxytail.dns').read_text()
  flush=dns[dns.index('flush_android_dns_cache() {'):dns.index('\ndns_start() {')]
  runner=self.dir/'flush.sh';runner.write_text('. "$TEST_DIR/settings.sh"\n'+flush+'\nflush_android_dns_cache\n')
  def run():return subprocess.run(['sh',str(runner)],env=self.env,text=True,capture_output=True)
  calls=self.dir/'service-calls'
  for version in ('00000004','0000000f'):
   self.env['MOCK_RESOLVER_VERSION']=version;calls.write_text('')
   self.assertEqual(run().returncode,0)
   self.assertEqual(calls.read_text().splitlines(),['call dnsresolver 16777215','call dnsresolver 11 i32 101','call dnsresolver 11 i32 102'])
   self.assertEqual((self.dir/'run/dnsmasq.cache-status').read_text().strip(),'flushed:2')
  for version in ('00000003','00000010','invalid'):
   self.env['MOCK_RESOLVER_VERSION']=version;calls.write_text('')
   self.assertNotEqual(run().returncode,0)
   self.assertEqual(calls.read_text().splitlines(),['call dnsresolver 16777215'])
   self.assertIn('unsupported-version',(self.dir/'run/dnsmasq.cache-status').read_text())
  self.env['MOCK_DESCRIPTOR']='dnsresolver: [vendor.unverified.Resolver]';calls.write_text('')
  self.assertNotEqual(run().returncode,0);self.assertEqual(calls.read_text(),'')

 def test_pinned_native_dns_is_compatible_but_other_quad100_rules_are_not(self):
  native=['!','-d','100.100.100.100/32','!','-o','tun+','-p','udp','-m','udp','--dport','53','-j','DNAT','--to-destination','100.100.100.100:53']
  s=self.read();s['chains']={'iptables:nat':{'OUTPUT':[native]}};self.write(s)
  self.run_script('foxytail.compat','check-dns-hijack')
  v6=['!','-d','fd7a:115c:a1e0::53/128','!','-o','tun+','-p','udp','-m','udp','--dport','53','-j','DNAT','--to-destination','[fd7a:115c:a1e0::53]:53']
  s=self.read();s['chains']['ip6tables:nat']={'OUTPUT':[v6]};self.write(s)
  self.run_script('foxytail.compat','check-dns-hijack')
  for rule in ([x.replace('100.100.100.100:53','192.0.2.1:53') for x in native],['-p','udp','--dport','53','-j','DNAT','--to-destination','100.100.100.100:53']):
   s=self.read();s['chains']['iptables:nat']['OUTPUT']=[rule];self.write(s)
   self.run_script('foxytail.compat','check-dns-hijack',ok=False)

 def test_dns_upstream_is_independent_of_app_scope_and_keeps_owned_routes(self):
  for scope in ('selected','bypass'):
   self.config(ROUTE_SCOPE=scope,UID_LIST='9999 10101',ROUTE_SUBNETS='192.0.2.0/24',IPV6='off')
   self.run_script('foxytail.route','apply')
   s=self.read();rules=s['chains']['iptables:mangle']['FOXY_MARK']
   dns=[r for r in rules if '--uid-owner' in r and r[r.index('--uid-owner')+1]=='9999' and '--dport' in r]
   self.assertEqual(len(dns),2)
   self.assertTrue(all('100.100.100.100/32' in r and r[-1]=='0x40000000/0x40000000' for r in dns))
   self.assertIn(['100.100.100.100/32','dev','tailscale0','proto','186'],s['routes']['-4:1052'])
   self.assertEqual(rules[0],['-m','owner','--uid-owner','0','-j','RETURN'])
  self.config(MAGIC_DNS='off',IPV6='off');self.run_script('foxytail.route','apply')
  self.assertFalse(any('--dport' in r for r in self.read()['chains']['iptables:mangle']['FOXY_MARK']))

 def test_dns_binary_falls_back_to_trusted_system_paths(self):
  dns=(ROOT/'tailscale/scripts/foxytail.dns').read_text()
  select=dns[dns.index('select_dns_binary() {'):dns.index('\nget_state() {')]
  for parent in ('system','vendor'):(self.dir/parent).mkdir()
  select=select.replace('/system/bin/dnsmasq',str(self.dir/'system/dnsmasq')).replace('/vendor/bin/dnsmasq',str(self.dir/'vendor/dnsmasq'))
  runner=self.dir/'binary.sh';runner.write_text('. "$TEST_DIR/settings.sh"\n'+select+'\nselect_dns_binary || exit 1\nprintf "%s" "$DNS_BIN"\n')
  def selected():return subprocess.run(['sh',str(runner)],env=self.env,text=True,capture_output=True)
  self.assertNotEqual(selected().returncode,0)
  for path in (self.dir/'vendor/dnsmasq',self.dir/'system/dnsmasq',self.dir/'bin/dnsmasq'):
   path.write_text('#!/bin/sh\n');path.chmod(0o755)
   self.assertEqual(selected().stdout,str(path))

 def setup_dns_runtime(self):
  self.setup_binder()
  dns=(ROOT/'tailscale/scripts/foxytail.dns').read_text()
  runner=self.dir/'dns-runner.sh'
  runner.write_text(""". "$TEST_DIR/settings.sh"
load_conf
DNS_CONF="$TS_RUN_DIR/dnsmasq.conf"
DNS_STATE_FILE="$TS_RUN_DIR/dnsmasq.state"
DNS_REASON_FILE="$TS_RUN_DIR/dnsmasq.reason"
DNS_CONTEXT_FILE="$TS_RUN_DIR/dnsmasq.context.json"
DNS_BIN="$TS_BIN_DIR/dnsmasq"
DNS_LOG="$TS_RUN_DIR/dnsmasq.log"
PID_FILE="$TS_RUN_DIR/dnsmasq.pid"
TS_SOCKET="$TS_RUN_DIR/tailscaled.sock"
CHAIN_DNS=FOXY_DNS
"""+dns[dns.index('set_state() {'):dns.index('\ncase "$1" in')]+ '\ndns_pids() { [ -f "$TEST_DIR/alive" ] && echo 123; }\nstop_by_pids() { [ "$FAIL_STOP" != 1 ] && rm -f "$TEST_DIR/alive"; }\ntmo() { cat "$TEST_DIR/current.json"; }\nipv6_module_boot() { echo test-boot; }\nipv6_nat_module_dirs() { :; }\ngetprop() { echo 1.1.1.1; }\nrotate_log() { :; }\n"$@"\n')
  wrapper=self.dir/'bin/foxytail.compat';wrapper.write_text('#!/bin/sh\nexec sh "$TEST_DIR/scripts/foxytail.compat" "$@"\n');wrapper.chmod(0o755)
  daemon=self.dir/'bin/dnsmasq';daemon.write_text('#!/bin/sh\ntouch "$TEST_DIR/alive"\n');daemon.chmod(0o755)
  (self.dir/'alive').touch()
  current={'MagicDNSSuffix':'example.ts.net','CurrentTailnet':{'Name':'example','MagicDNSEnabled':True},'Self':{'ID':'device1','DNSName':'phone.example.ts.net.','TailscaleIPs':['100.64.0.1']},'Peer':{'peer1':{'DNSName':'Laptop.example.ts.net.','TailscaleIPs':['100.64.0.2'],'Online':True}}}
  (self.dir/'current.json').write_text(json.dumps(current))
  (self.dir/'run/dnsmasq.context.json').write_text(json.dumps({'suffix':'example.ts.net','tailnet':'example','self':'device1'},separators=(',',':'))+'\n')
  (self.dir/'run/dnsmasq.conf').write_text('port=1053\nlisten-address=::1\nserver=/example.ts.net/100.100.100.100\n')
  def run(*args,ok=True):
   r=subprocess.run(['sh',str(runner),*args],env=self.env,text=True,capture_output=True)
   if ok:self.assertEqual(r.returncode,0,r.stdout+r.stderr)
   else:self.assertNotEqual(r.returncode,0,r.stdout+r.stderr)
   return r.stdout
  return run,current

 def test_dns_missing_ipv6_nat_retains_ipv4_and_recovers_when_available(self):
  run,_=self.setup_dns_runtime()
  self.env['MOCK_NO_IPV6_NAT']='1'
  run('dns_start')
  status=json.loads(run('dns_status','--json'))
  self.assertEqual((status['state'],status['reason']),('running','ipv6-unavailable'))
  state=self.read()
  self.assertEqual(state['chains']['iptables:nat']['OUTPUT'],[['-j','FOXY_DNS']])
  self.assertFalse(any(c[0]=='ip6tables' and c[1:3]==['-t','nat'] and c[3] in ('-A','-I','-N') for c in state['calls']))
  calls=self.dir/'service-calls';before=calls.read_text()
  run('dns_start')
  self.assertEqual(calls.read_text(),before)
  # No configuration fallback: IPv6 tunnel/listener preference is retained.
  self.assertIn('IPV6="on"',(self.dir/'config').read_text())
  self.assertIn('listen-address=::1',(self.dir/'run/dnsmasq.conf').read_text())
  self.env.pop('MOCK_NO_IPV6_NAT')
  self.assertEqual(json.loads(run('dns_status','--json'))['state'],'degraded')
  run('dns_start')
  status=json.loads(run('dns_status','--json'))
  self.assertEqual((status['state'],status['reason']),('running','running'))
  self.assertEqual(self.read()['chains']['ip6tables:nat']['OUTPUT'],[['-j','FOXY_DNS']])
  # Turning IPv6 off never requires or installs its nat table.
  self.config(IPV6='off');self.env['MOCK_NO_IPV6_NAT']='1'
  run('dns_start');status=json.loads(run('dns_status','--json'))
  self.assertEqual((status['state'],status['reason']),('running','running'))

 def test_dns_live_process_preserves_degraded_and_recovers(self):
  run,current=self.setup_dns_runtime()
  current['Peer']['peer1']['TailscaleIPs'].append('fd7a:115c:a1e0::2')
  (self.dir/'current.json').write_text(json.dumps(current))
  state=self.read();state['chains']={'ip6tables:mangle':{'OUTPUT':[['-p','udp','--dport','53','-j','TPROXY']]}};self.write(state)
  run('dns_start');self.assertEqual(json.loads(run('dns_status','--json'))['state'],'degraded')
  state=self.read();state['chains']['ip6tables:mangle']['OUTPUT']=[];self.write(state)
  run('dns_start');self.assertEqual(json.loads(run('dns_status','--json'))['state'],'running')
  # A pinned native DNAT rule stays installed, behind the local resolver.
  native=['!','-o','tun+','!','-d','100.100.100.100','-p','udp','--dport','53','-j','DNAT','--to-destination','100.100.100.100:53']
  state=self.read();state['chains']['iptables:nat']['OUTPUT'].insert(0,native);self.write(state)
  run('dns_start');status=json.loads(run('dns_status','--json'))
  self.assertEqual(status['state'],'running');self.assertTrue(status['upstreamNative'])
  self.assertEqual(self.read()['chains']['iptables:nat']['OUTPUT'],[['-j','FOXY_DNS'],native])
  calls=self.dir/'service-calls';before=calls.read_text()
  run('dns_start');self.assertEqual(calls.read_text(),before)
  conf=(self.dir/'run/dnsmasq.conf').read_text()
  self.assertIn('address=/laptop/100.64.0.2',conf);self.assertIn('address=/phone/100.64.0.1',conf)
  # Full node names must keep their AAAA answer even when native MagicDNS
  # returns only A; older Android dnsmasq supports these inline mappings.
  for name in ('laptop','laptop.example.ts.net'):
   for address in ('100.64.0.2','fd7a:115c:a1e0::2'):
    self.assertIn(f'address=/{name}/{address}\n',conf)
  self.assertIn('address=/phone.example.ts.net/100.64.0.1\n',conf)
  self.assertNotIn('addn-hosts=',conf)
  # Online/traffic fluctuations are excluded from the DNS context. Name and
  # address changes are detected and reconciled by the watchdog status check.
  current['Peer']['peer1']['Online']=False;current['Peer']['peer1']['RxBytes']=100
  (self.dir/'current.json').write_text(json.dumps(current))
  self.assertEqual(json.loads(run('dns_status','--json'))['state'],'running')
  current['Peer']['peer1']['TailscaleIPs']=['100.64.0.3']
  (self.dir/'current.json').write_text(json.dumps(current))
  self.assertEqual(json.loads(run('dns_status','--json'))['state'],'degraded')
  run('dns_start');conf=(self.dir/'run/dnsmasq.conf').read_text()
  self.assertIn('address=/laptop/100.64.0.3\n',conf)
  self.assertIn('address=/laptop.example.ts.net/100.64.0.3\n',conf)
  self.assertNotIn('100.64.0.2',conf);self.assertNotIn('fd7a:115c:a1e0::2',conf)
  self.assertEqual(calls.read_text()[len(before):].splitlines(),['call dnsresolver 16777215','call dnsresolver 11 i32 101','call dnsresolver 11 i32 102'])
  state=self.read()
  for cmd in ('iptables','ip6tables'):
   rules=state['chains'][cmd+':nat']['FOXY_DNS'];self.assertTrue(any('tcp' in r for r in rules));self.assertTrue(any('udp' in r for r in rules))
   exemptions=[i for i,r in enumerate(rules) if r[-1]=='ACCEPT']
   redirects=[i for i,r in enumerate(rules) if 'REDIRECT' in r]
   self.assertEqual(len(exemptions),4);self.assertLess(max(exemptions),min(redirects))
   self.assertFalse(any(r[-1]=='RETURN' for r in rules))
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
  self.assertEqual(json.loads(run('dns_status','--json'))['reason'],'apply-pending')
  self.config(MAGIC_DNS='off');self.assertEqual(json.loads(run('dns_status','--json'))['reason'],'disabled')

if __name__=='__main__':unittest.main()
