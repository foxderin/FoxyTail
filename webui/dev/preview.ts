/* Development-only fixture. Vite builds index.html exclusively, so neither
 * this bridge nor its simulated data can enter the shipped WebUI. */
import type { CoexistCheck, CoexistInfo } from '../src/coexistence';
import type { Transfer } from '../src/types';
const transfers: Transfer[] = [];
let transferSequence = 0;
const peers = [
  { id: 'studio', hostname: 'studio-mac', ip: '100.74.12.8', ips: ['100.74.12.8', 'fd7a:115c:a1e0::8'], os: 'macOS', relay: '', online: true, rxBytes: 1468203023, txBytes: 346820302, exitNodeOption: false },
  { id: 'nas', hostname: 'home-server', ip: '100.80.42.16', os: 'linux', relay: '', online: true, rxBytes: 3496221452, txBytes: 2102323420, exitNodeOption: true },
  { id: 'gateway', hostname: 'tokyo-gateway', ip: '100.92.18.24', os: 'linux', relay: 'tok', online: true, rxBytes: 882468333, txBytes: 243082322, exitNodeOption: true },
  { id: 'work', hostname: 'office-laptop', ip: '100.76.40.10', os: 'windows', relay: 'sin', online: true, rxBytes: 784083302, txBytes: 134082312, exitNodeOption: false },
  { id: 'tablet', hostname: 'travel-ipad', ip: '100.66.14.7', os: 'iOS', relay: '', online: false, rxBytes: 46183473, txBytes: 13282742, exitNodeOption: false },
  { id: 'phone', hostname: 'pixel-9', ip: '100.70.21.9', os: 'android', relay: '', online: false, rxBytes: 70843771, txBytes: 22645287, exitNodeOption: false },
];
const config: Record<string,string> = { TS_MODE:'tun',SOCKS_PORT:'1099',DNS_PORT:'1053',DNS_MODE:'legacy',MAGIC_DNS:'on',IPV6:'off',ROUTE_TABLE:'1052',FWMARK:'0x40000000',FWMARK_MASK:'0x40000000',WATCHDOG:'on',WATCHDOG_INTERVAL:'30',STATS_INTERVAL:'60',LOG_MAX_KB:'512' };
let running = true, pending = false, acceptRoutes = false;
let customRoutes = { scope: 'all', uids: [] as string[], subnets: ['100.64.0.0/10'] };
let selected: typeof peers[number] | null = null;
const params = new URLSearchParams(location.search);
const scenario = params.get('state') || 'ready';
// Named wizard scenarios: coexist-bridge/proxy/tun/failed/unready/empty/stale/error.
if (scenario.startsWith('coexist-')) {
  config.DNS_MODE = 'local';
  config.TS_MODE = scenario === 'coexist-tun' ? 'tun' : scenario === 'coexist-proxy' ? 'proxy' : 'bridge';
  config.SOCKS_PORT = '1109';
  config.DNS_PORT = '1153';
}
if (['legacy', 'local', 'transparent'].includes(params.get('dns') || '')) config.DNS_MODE = params.get('dns')!;
let appliedDns = { mode: config.DNS_MODE, port: Number(config.DNS_PORT), enabled: true, ipv6: false };
if(params.has('theme')) localStorage.setItem('foxy.theme', params.get('theme')!);
localStorage.setItem('foxy.lang', params.get('lang') || 'zh');
const hours = Array.from({length:24},(_,hour)=>({hour,iface:{rx: Math.round((hour<7?8:45+Math.sin(hour*.74)*30+(hour>15?40:0))*1048576),tx:Math.round((hour<7?2:10+Math.sin(hour*.74)*6)*1048576)}}));
const logs = ['2026-09-09 09:41:00 [Info] tailscaled started successfully','2026-09-09 09:41:01 [Info] Network state: connected','2026-09-09 09:41:01 [Success] Tunnel interface is ready','2026-09-09 09:41:02 [Info] MagicDNS resolver is ready','2026-09-09 09:42:00 [Info] Traffic samples collected','2026-09-09 09:43:00 [Warning] Peer travel-ipad is offline'];
function coexistInfo(): CoexistInfo {
  const ready = running && appliedDns.enabled && appliedDns.mode !== 'legacy' && !['coexist-unready', 'dns-port-busy'].includes(scenario);
  const currentPeers = ['coexist-empty', 'empty'].includes(scenario) ? [] : peers.map(peer => ({
    id: peer.id, hostname: peer.hostname, dnsName: peer.hostname + '.example.ts.net',
    ips: peer.ips || [peer.ip], online: peer.online,
  }));
  return {
    ok: true, snapshot: `preview:${config.TS_MODE}:${appliedDns.mode}:${appliedDns.port}:${ready}`,
    mode: config.TS_MODE as CoexistInfo['mode'], socksPort: Number(config.SOCKS_PORT), ipv6Enabled: appliedDns.ipv6,
    suffix: 'example.ts.net', dnsReady: ready,
    dns: { ok: true, mode: appliedDns.mode as CoexistInfo['dns']['mode'], port: appliedDns.port,
      enabled: appliedDns.enabled, suffix: 'example.ts.net', state: ready ? 'running' : 'degraded',
      reason: ready ? appliedDns.mode === 'local' ? 'local' : 'running' : 'listener-failed',
      listenerReady: ready, repairNeeded: false, policyState: ready ? 'owned' : 'restored',
      interception4: ready && appliedDns.mode === 'transparent', interception6: false },
    peers: currentPeers, addresses: ['100.69.138.97', 'fd7a:115c:a1e0::873a:6110', ...currentPeers.flatMap(peer => peer.ips)],
    environment: { modules: [{ name: 'Surfing', kind: 'proxy' }], apps: [{ package: 'com.github.metacubex.clash.meta', kind: 'proxy' }], warnings: [], alert: null },
  };
}
function result(cmd:string,args:string[]) {
  if(scenario==='error' && ['status','peers','dns','coexist-info','coexist-check','settings-get','traffic','subnet-routes-get'].includes(cmd)) return {ok:false,error:'Preview: service temporarily unavailable'};
  switch(cmd){
    case 'status': return {ok:true,daemon:running?'running':'stopped',backend:scenario==='login'?'NeedsLogin':scenario==='starting'?'NoState':scenario==='approval'?'NeedsMachineAuth':running?'Running':'NoState',mode:config.TS_MODE,self:{hostname:'oneplus-ace',ips:['100.69.138.97','fd7a:115c:a1e0::873a:6110'],relay:''},exitNode:selected?{...selected,rx:selected.rxBytes,tx:selected.txBytes}:null,peers:{online:4,offline:2},magicDns:true,keyExpiry:null,uptime:running?184220:0};
    case 'peers':return {ok:true,peers:scenario==='empty'?[]:peers};
    case 'exitnodes':return {ok:true,peers:scenario==='empty'?[]:peers.filter(p=>p.exitNodeOption)};
    case 'tun':return {ok:true,ifaceUp:running,gateway:'100.69.138.97',hevPid:null,mode:config.TS_MODE,socksPort:1099};
    case 'dns': {
      if (appliedDns.mode === 'legacy') return {ok:true,mode:'legacy',state:running?'running':'stopped',reason:running?'running':'stopped',enabled:appliedDns.enabled,suffix:'example.ts.net',port:appliedDns.port,binary:'/system/bin/dnsmasq',upstreamNative:true};
      const listenerReady = running && appliedDns.enabled && scenario !== 'dns-port-busy';
      const interception4 = listenerReady && appliedDns.mode === 'transparent' && scenario !== 'dns-unsupported';
      return {ok:true,mode:appliedDns.mode,state:listenerReady?'running':appliedDns.enabled?'degraded':'stopped',
        reason:!appliedDns.enabled?'disabled':!listenerReady?'listener-failed':appliedDns.mode==='local'?'local':interception4?'running':'transparent-unavailable',
        enabled:appliedDns.enabled,suffix:'example.ts.net',port:appliedDns.port,listenerReady,
        interception4,interception6:interception4&&appliedDns.ipv6,repairNeeded:false,policyState:listenerReady?'owned':'restored',upstreamNative:false};
    }
    case 'coexist-info': return scenario === 'coexist-error' ? {ok:false,error:'Preview: applied state is unavailable'} : coexistInfo();
    case 'coexist-check': {
      const current = coexistInfo();
      const [snapshot, id, address, port, resolver] = args;
      const peer = current.peers.find(item => item.id === id);
      if (scenario === 'coexist-stale' || snapshot !== current.snapshot || !current.dnsReady) return {ok:false,error:'Preview: context changed; detect again'};
      if (!peer || !peer.ips.includes(address) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 ||
        (resolver !== '-' && (!/^\d{1,5}$/.test(resolver) || Number(resolver) < 1 || Number(resolver) > 65535 || Number(resolver) === current.dns.port))) {
        return {ok:false,error:'Preview: invalid current target or port'};
      }
      const failed = scenario === 'coexist-failed';
      const checks: CoexistCheck['checks'] = [
        {id:'dns-udp',ok:true,addresses:[address],elapsedMs:3},
        {id:'dns-tcp',ok:!failed,addresses:failed?['198.18.0.7']:[address],elapsedMs:5,...(failed?{error:'Preview: unexpected DNS address (fake-IP)'}:{})},
      ];
      if (resolver !== '-') checks.push(
        {id:'resolver-udp',ok:!failed,addresses:failed?[]:[address],elapsedMs:failed?2000:6,...(failed?{error:'Preview: DNS request timed out'}:{})},
        {id:'resolver-tcp',ok:true,addresses:[address],elapsedMs:8},
      );
      checks.push({id:'tcp',ok:!failed,elapsedMs:18,...(failed?{error:'Preview: connection refused'}:{})});
      return {ok:true,snapshot,name:peer.dnsName,address,targetPort:Number(port),path:current.mode==='tun'?'system':'socks5',checks};
    }
    case 'compat':return {ok:true,modules:[],apps:[],warnings:[],alert:null};
    case 'accounts':return {ok:true,accounts:[{name:'alex@example.com',label:'Personal network',current:true}]};
    case 'traffic':return {ok:true,hours:scenario==='empty'?[]:hours,days:scenario==='empty'?[]:Array.from({length:7},(_,i)=>({date:`2026-09-0${i+3}`,rx:(1200+Math.sin(i)*600)*1048576,tx:(230+i*45)*1048576})),topn:scenario==='empty'?[]:peers.slice(0,4).map(p=>({id:p.id,rx:p.rxBytes,tx:p.txBytes}))};
    case 'traffic-uids':return {ok:true,uids:scenario==='empty'?[]:[{uid:'10234',tx:604445050},{uid:'10402',tx:229307021},{uid:'10372',tx:98605230}]};
    case 'apps':return {ok:true,apps:[{label:'Firefox',package:'org.mozilla.firefox',uid:10234},{label:'Syncthing',package:'com.github.catfriend1.syncthingandroid',uid:10402},{label:'Termux',package:'com.termux',uid:10372}]};
    case 'routes-get':return {ok:true,...customRoutes};
    case 'routes-set': {
      customRoutes = {scope: args[0], uids: args[1] === '-' ? [] : args[1].split(','), subnets: args[2] === '-' ? [] : args[2].split(',')};
      const ipv6Skipped = config.IPV6 === 'on' ? [] : customRoutes.subnets.filter(cidr => cidr.includes(':'));
      return {ok:true,saved:true,applied:ipv6Skipped.length === 0,restartRequired:ipv6Skipped.length > 0,subnets:customRoutes.subnets,ipv6Skipped,requiresIpv6:ipv6Skipped.length > 0};
    }
    case 'subnet-routes-get':return {ok:true,acceptRoutes,mode:config.TS_MODE,ipv6Enabled:config.IPV6 === 'on',peers:scenario==='empty'?[]:[{id:'nas',hostname:'home-server',online:true,routes:[{cidr:'192.168.10.0/24',primary:true},{cidr:'fd12:3456:789a::/64',primary:true}]},{id:'work',hostname:'office-laptop',online:false,routes:[{cidr:'10.20.0.0/16',primary:false}]}]};
    case 'subnet-routes-set':acceptRoutes=args[0] === 'on';return {ok:true,acceptRoutes,applied:true};
    case 'settings-get':return {ok:true,settings:config,restartRequired:pending};
    case 'settings-set':config[args[0]]=args[1];pending=true;return {ok:true,saved:true,applied:false,restartRequired:true};
    case 'control':running=args[0]!=='stop';pending=false;appliedDns={mode:config.DNS_MODE,port:Number(config.DNS_PORT),enabled:config.MAGIC_DNS==='on',ipv6:config.IPV6==='on'};return {ok:true,applied:true,restartRequired:false};
    case 'mode-set':config.TS_MODE=args[0];return {ok:true};
    case 'exitnode-set':selected=peers.find(p=>p.ip===args[0])||null;return {ok:true};
    case 'exitnode-clear':selected=null;return {ok:true};
    case 'context-get':return {ok:true,rules:''};
    case 'logs':return {ok:true,lines:scenario==='empty'?[]:logs};
    case 'files-inbox':return {ok:true,files:scenario==='empty'?[]:[{name:'network-notes.pdf',size:248928,mtime:1788912000},{name:'camera-roll.zip',size:15687204,mtime:1788896200}]};
    case 'taildrop-targets': return scenario === 'error' || scenario === 'login'
      ? {ok:false,error:'Preview: sign in and start Tailscale to find receiving devices'}
      : {ok:true,peers:scenario==='empty'?[]:peers.map(peer=>({id:peer.id,hostname:peer.hostname,ips:peer.ips || [peer.ip],online:peer.online}))};
    case 'files-browse': {
      if (scenario === 'error') return {ok:false,error:'Preview: shared storage is locked or permission was denied'};
      const path = args[0] === '-' ? '' : args[0];
      if (!['', 'Download', 'Pictures'].includes(path)) return {ok:false,error:'Preview: directory not found'};
      const entries = path === '' ? [
        {name:'Download',path:'/sdcard/Download',directory:true,size:0,mtime:1788912000},
        {name:'Pictures',path:'/sdcard/Pictures',directory:true,size:0,mtime:1788912000},
      ] : [{name:path === 'Download'?'network-notes.pdf':'photo.jpg',path:'/sdcard/'+path+'/'+(path === 'Download'?'network-notes.pdf':'photo.jpg'),directory:false,size:248928,mtime:1788912000},
        {name:'camera-roll.zip',path:'/sdcard/'+path+'/camera-roll.zip',directory:false,size:15687204,mtime:1788896200}];
      return {ok:true,path,entries:scenario==='empty'?[]:entries,truncated:false};
    }
    case 'file-send-start': {
      const peer = peers.find(peer => peer.id === args[0] && (peer.ips || [peer.ip]).includes(args[1]));
      const paths: unknown = JSON.parse(args[2]);
      if (!peer || !Array.isArray(paths) || !paths.length || paths.length > 32 || paths.some(path => typeof path !== 'string' || !path.startsWith('/sdcard/')))
        return {ok:false,error:'Preview: invalid receiving device or selection'};
      if (transfers.some(job => job.status === 'queued' || job.status === 'sending')) return {ok:false,error:'Preview: a transfer is already active'};
      const now = Math.floor(Date.now()/1000);
      const job: Transfer = {id:(++transferSequence).toString(16),peerId:peer.id,peerName:peer.hostname,peerIp:args[1],selfId:'preview-self',status:'queued',startedAt:now,updatedAt:now,
        files:paths.map((path, index)=>({id:(++transferSequence).toString(16),name:path.split('/').pop()!,path,size:index?15687204:248928,sentBytes:0,progressKnown:false,bytesPerSecond:0,status:'queued'}))};
      transfers.unshift(job);
      transfers.splice(100);
      return {ok:true,transfer:job};
    }
    case 'file-send-status': {
      const job = transfers.find(job=>job.id===args[0]);
      if (!job) return {ok:false,error:'Preview: transfer not found'};
      if (job.status === 'queued' || job.status === 'sending') {
        const file = job.files.find(file=>file.status === 'queued' || file.status === 'sending');
        if (file) {
          if (file.status === 'queued') file.status = 'sending';
          else {
            file.progressKnown = true;
            file.sentBytes = Math.min(file.size,file.sentBytes+Math.ceil(file.size/3));
            file.bytesPerSecond = Math.ceil(file.size/4.5);
            if (file.sentBytes === file.size) {file.status = 'completed';file.bytesPerSecond = 0;}
          }
        }
        job.status = job.files.every(file=>file.status==='completed') ? 'completed' : 'sending';
        job.updatedAt = Math.floor(Date.now()/1000);
      }
      return {ok:true,transfer:job};
    }
    case 'file-send-cancel': {
      const job = transfers.find(job=>job.id===args[0]);
      if (!job) return {ok:false,error:'Preview: transfer not found'};
      if (job.status === 'queued' || job.status === 'sending') {
        job.status = 'cancelled';job.updatedAt = Math.floor(Date.now()/1000);
        for (const file of job.files) if (file.status === 'queued' || file.status === 'sending') {file.status = 'cancelled';file.bytesPerSecond = 0;}
      }
      return {ok:true,transfer:job};
    }
    case 'file-send-history': return scenario === 'error' ? {ok:false,error:'Preview: transfer history is unavailable'} : {ok:true,transfers};
    case 'serve-list':case 'funnel-list':return {ok:true,status:{}};
    case 'speedtest-exitnodes':return {ok:true,results:peers.filter(p=>p.exitNodeOption).map((p,i)=>({id:p.id,hostname:p.hostname,ip:p.ip,latencyMs:18+i*32,ok:true}))};
    case 'derp-speedtest':return {ok:true,preferred:'tok',relays:[{code:'tok',latencyMs:28},{code:'sin',latencyMs:56},{code:'hkg',latencyMs:33}]};
    case 'diag':return {ok:true,path:'/sdcard/Download/foxytail-diagnostics-preview.tar.gz'};
    case 'backup':return {ok:true,path:'/sdcard/Download/foxytail-backup-preview.tar.gz'};
    case 'login':return {ok:true,url:'https://login.tailscale.com/'};
    default:return {ok:true};
  }
}
/* Only tokenize quoted data; never evaluate shell text in a preview. */
function words(command:string):string[]{
  const tokens:string[]=[];let out='',quote='';let started=false;
  for(let i=0;i<command.length;i++){
    const c=command[i];
    if(quote){if(c===quote)quote='';else out+=c;started=true;}
    else if(c==='\''||c==='"'){quote=c;started=true;}
    else if(c==='\\'&&i+1<command.length){out+=command[++i];started=true;}
    else if(/\s/.test(c)){if(started){tokens.push(out);out='';started=false;}}
    else{out+=c;started=true;}
  }if(started)tokens.push(out);return tokens;
}
if(scenario!=='no-root') (window as any).ksu={spawn(command:string,_args:string,_opts:string,callback:string){
  const args=words(command);const api=args.findIndex(x=>x.endsWith('/foxytail.webapi.sh'));
  let sub='',payload:unknown='';
  if(api>=0){args.splice(0,api+1);if(args[0]==='--request-id')args.splice(0,2);sub=args.shift()||'';payload=result(sub,args);}
  else payload=command.startsWith('cat ')?'# Custom hooks may be configured on this device.':'yes';
  const delay=scenario==='slow'?4000:sub.includes('speedtest')||sub==='diag'||sub==='coexist-check'?1200:180;
  setTimeout(()=>{const cb=(window as any)[callback];if(!cb)return;const output=typeof payload==='string'?payload:JSON.stringify(payload);cb.stdout.emit('data',output);cb.emit('exit',(payload as any)?.ok===false?1:0);},delay);
}};
await import('../src/main');
const previewNotice = document.createElement('div');
previewNotice.textContent = params.get('lang') === 'en' ? 'Preview · simulated data' : '设计预览 · 模拟数据';
previewNotice.setAttribute('role', 'note');
previewNotice.style.cssText = 'position:fixed;bottom:calc(var(--ft-bottom-nav-height,74px) + 8px);right:12px;z-index:45;padding:4px 9px;border:1px solid var(--ft-border);border-radius:6px;background:var(--ft-surface);color:var(--ft-muted);font:10px system-ui;pointer-events:none;opacity:.9';
document.body.append(previewNotice);
export {};
