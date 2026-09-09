/* Development-only fixture. Vite builds index.html exclusively, so neither
 * this bridge nor its simulated data can enter the shipped WebUI. */
const peers = [
  { id: 'studio', hostname: 'studio-mac', ip: '100.74.12.8', os: 'macOS', relay: '', online: true, rxBytes: 1468203023, txBytes: 346820302, exitNodeOption: false },
  { id: 'nas', hostname: 'home-server', ip: '100.80.42.16', os: 'linux', relay: '', online: true, rxBytes: 3496221452, txBytes: 2102323420, exitNodeOption: true },
  { id: 'gateway', hostname: 'tokyo-gateway', ip: '100.92.18.24', os: 'linux', relay: 'tok', online: true, rxBytes: 882468333, txBytes: 243082322, exitNodeOption: true },
  { id: 'work', hostname: 'office-laptop', ip: '100.76.40.10', os: 'windows', relay: 'sin', online: true, rxBytes: 784083302, txBytes: 134082312, exitNodeOption: false },
  { id: 'tablet', hostname: 'travel-ipad', ip: '100.66.14.7', os: 'iOS', relay: '', online: false, rxBytes: 46183473, txBytes: 13282742, exitNodeOption: false },
  { id: 'phone', hostname: 'pixel-9', ip: '100.70.21.9', os: 'android', relay: '', online: false, rxBytes: 70843771, txBytes: 22645287, exitNodeOption: false },
];
const config: Record<string,string> = { TS_MODE:'tun',SOCKS_PORT:'1099',DNS_PORT:'1053',MAGIC_DNS:'on',IPV6:'off',ROUTE_TABLE:'1052',FWMARK:'0x40000000',FWMARK_MASK:'0x40000000',WATCHDOG:'on',WATCHDOG_INTERVAL:'30',STATS_INTERVAL:'60',LOG_MAX_KB:'512' };
let running = true, pending = false;
let selected: typeof peers[number] | null = null;
const params = new URLSearchParams(location.search);
const scenario = params.get('state') || 'ready';
if(params.has('theme')) localStorage.setItem('foxy.theme', params.get('theme')!);
localStorage.setItem('foxy.lang', params.get('lang') || 'zh');
const hours = Array.from({length:24},(_,hour)=>({hour,iface:{rx: Math.round((hour<7?8:45+Math.sin(hour*.74)*30+(hour>15?40:0))*1048576),tx:Math.round((hour<7?2:10+Math.sin(hour*.74)*6)*1048576)}}));
const logs = ['2026-09-09 09:41:00 [Info] tailscaled started successfully','2026-09-09 09:41:01 [Info] Network state: connected','2026-09-09 09:41:01 [Success] Tunnel interface is ready','2026-09-09 09:41:02 [Info] MagicDNS resolver is ready','2026-09-09 09:42:00 [Info] Traffic samples collected','2026-09-09 09:43:00 [Warning] Peer travel-ipad is offline'];
function result(cmd:string,args:string[]) {
  if(scenario==='error' && ['status','peers','dns','settings-get','traffic'].includes(cmd)) return {ok:false,error:'Preview: service temporarily unavailable'};
  switch(cmd){
    case 'status': return {ok:true,daemon:running?'running':'stopped',backend:scenario==='login'?'NeedsLogin':running?'Running':'NoState',mode:config.TS_MODE,self:{hostname:'oneplus-ace',ips:['100.69.138.97','fd7a:115c:a1e0::873a:6110'],relay:''},exitNode:selected?{...selected,rx:selected.rxBytes,tx:selected.txBytes}:null,peers:{online:4,offline:2},magicDns:true,keyExpiry:null,uptime:running?184220:0};
    case 'peers':return {ok:true,peers:scenario==='empty'?[]:peers};
    case 'exitnodes':return {ok:true,peers:scenario==='empty'?[]:peers.filter(p=>p.exitNodeOption)};
    case 'mode-get':return {ok:true,mode:config.TS_MODE};
    case 'tun':return {ok:true,ifaceUp:running,gateway:'100.69.138.97',hevPid:null,mode:config.TS_MODE,socksPort:1099};
    case 'dns':return {ok:true,state:'running',reason:'running',enabled:true,suffix:'example.ts.net',port:1053,binary:'/system/bin/dnsmasq',upstreamNative:true};
    case 'compat':return {ok:true,modules:[],apps:[],warnings:[],alert:null};
    case 'accounts':return {ok:true,accounts:[{name:'alex@example.com',label:'Personal network',current:true}]};
    case 'traffic':return {ok:true,hours:scenario==='empty'?[]:hours,days:scenario==='empty'?[]:Array.from({length:7},(_,i)=>({date:`2026-09-0${i+3}`,rx:(1200+Math.sin(i)*600)*1048576,tx:(230+i*45)*1048576})),topn:scenario==='empty'?[]:peers.slice(0,4).map(p=>({id:p.id,rx:p.rxBytes,tx:p.txBytes}))};
    case 'traffic-uids':return {ok:true,uids:scenario==='empty'?[]:[{uid:'10234',tx:604445050},{uid:'10402',tx:229307021},{uid:'10372',tx:98605230}]};
    case 'apps':return {ok:true,apps:[{label:'Firefox',package:'org.mozilla.firefox',uid:10234},{label:'Syncthing',package:'com.github.catfriend1.syncthingandroid',uid:10402},{label:'Termux',package:'com.termux',uid:10372}]};
    case 'routes-get':return {ok:true,scope:'all',uids:[],subnets:['100.64.0.0/10']};
    case 'settings-get':return {ok:true,settings:config,restartRequired:pending};
    case 'settings-set':config[args[0]]=args[1];pending=true;return {ok:true,saved:true,applied:false,restartRequired:true};
    case 'control':running=args[0]!=='stop';pending=false;return {ok:true,applied:true,restartRequired:false};
    case 'mode-set':config.TS_MODE=args[0];return {ok:true};
    case 'exitnode-set':selected=peers.find(p=>p.ip===args[0])||null;return {ok:true};
    case 'exitnode-clear':selected=null;return {ok:true};
    case 'context-get':return {ok:true,rules:''};
    case 'logs':return {ok:true,lines:scenario==='empty'?[]:logs};
    case 'files-inbox':return {ok:true,files:scenario==='empty'?[]:[{name:'network-notes.pdf',size:248928,mtime:1788912000},{name:'camera-roll.zip',size:15687204,mtime:1788896200}]};
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
  const delay=scenario==='slow'?4000:sub.includes('speedtest')||sub==='diag'?1200:180;
  setTimeout(()=>{const cb=(window as any)[callback];if(!cb)return;const output=typeof payload==='string'?payload:JSON.stringify(payload);cb.stdout.emit('data',output);cb.emit('exit',(payload as any)?.ok===false?1:0);},delay);
}};
await import('../src/main');
const previewNotice = document.createElement('div');
previewNotice.textContent = params.get('lang') === 'en' ? 'Preview · simulated data' : '设计预览 · 模拟数据';
previewNotice.setAttribute('role', 'note');
previewNotice.style.cssText = 'position:fixed;bottom:calc(var(--ft-bottom-nav-height,74px) + 8px);right:12px;z-index:45;padding:4px 9px;border:1px solid var(--ft-border);border-radius:6px;background:var(--ft-surface);color:var(--ft-muted);font:10px system-ui;pointer-events:none;opacity:.9';
document.body.append(previewNotice);
export {};
