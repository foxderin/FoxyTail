/* SIMULATED DATA ONLY. Imported by dev/preview.ts and the Node smoke harness,
 * never by the release entry. No shell, root, network, picker or binary I/O. */
export function installFixture(window, { state = 'ready', lang = 'en', theme = 'light', page = 'dashboard', delay = 0 } = {}) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = error => ({ ok: false, error: `Simulated: ${error}` });
  const peers = [
    { id: 'studio', hostname: 'studio-mac', ip: '100.74.12.8', ips: ['100.74.12.8', 'fd7a:115c:a1e0::8'], os: 'macOS', relay: '', online: true, rxBytes: 1468203023, txBytes: 346820302, exitNodeOption: false },
    { id: 'nas', hostname: 'home-server', ip: '100.80.42.16', ips: ['100.80.42.16'], os: 'linux', relay: '', online: true, rxBytes: 3496221452, txBytes: 2102323420, exitNodeOption: true },
    { id: 'tablet', hostname: 'travel-ipad', ip: '100.66.14.7', ips: ['100.66.14.7'], os: 'iOS', relay: '', online: false, rxBytes: 46183473, txBytes: 13282742, exitNodeOption: false },
  ];
  const settings = { TS_MODE: 'tun', SOCKS_PORT: '1099', DNS_PORT: '1053', DNS_MODE: 'local', MAGIC_DNS: 'on', IPV6: 'off', POWER_SAVE: 'off', WATCHDOG: 'on', WATCHDOG_PROBE: 'on', STATS: 'on', CONTEXT: 'on', WEBUI_AUTO_REFRESH: 'on', WATCHDOG_INTERVAL: '30', STATS_INTERVAL: '60', LOG_MAX_KB: '512', ROUTE_TABLE: '1052', FWMARK: '0x40000000', FWMARK_MASK: '0x40000000' };
  const token = 'art-' + 'a'.repeat(32);
  const transfer = { id: 'a1', peerId: 'nas', peerName: 'home-server', peerIp: '100.80.42.16', selfId: 'preview-self', status: 'failed', startedAt: 1788912000, updatedAt: 1788912060, files: [
    { id: 'a2', name: 'notes.txt', path: '/sdcard/Download/notes.txt', size: 120, sentBytes: 120, progressKnown: true, bytesPerSecond: 0, status: 'completed' },
    { id: 'a3', name: 'photo.jpg', path: '/sdcard/Download/photo.jpg', size: 248928, sentBytes: 100, progressKnown: true, bytesPerSecond: 0, status: 'failed', error: 'Simulated receiver unavailable' },
  ] };
  const data = {
    status: { ok: true, daemon: 'running', backend: 'Running', mode: 'tun', self: { id: 'preview-self', hostname: 'oneplus-ace', ips: ['100.69.138.97'], relay: '' }, exitNode: null, peerList: peers, peers: { online: 2, offline: 1 }, magicDns: true, keyExpiry: null, uptime: 184220, autoRefresh: false },
    'exit-routing': { ok: true, selfId: 'preview-self', exitRouting: { known: true, selected: null, effective: 'none', ipv4: false, ipv6: false, warning: '' } },
    'backend-info': { ok: true, protocol: 2, moduleVersion: 'preview', versionCode: 1, disabled: false, upgrading: false, commands: ['status', 'exit-routing', 'context-status', 'settings-get', 'settings-set'] },
    peers: { ok: true, peers }, exitnodes: { ok: true, peers: peers.filter(p => p.exitNodeOption) },
    compat: { ok: true, modules: [], apps: [], warnings: [], alert: null },
    tun: { ok: true, ifaceUp: true, gateway: '100.69.138.97', hevPid: 123, mode: 'tun', socksPort: 1099 },
    dns: { ok: true, mode: 'local', port: 1053, enabled: true, suffix: 'example.ts.net', state: 'running', reason: 'local', listenerReady: true, repairNeeded: false, policyState: 'owned', interception4: false, interception6: false, transparentAvailable: true },
    accounts: { ok: true, accounts: [{ name: 'alex@example.com', label: 'Personal network', current: true }, { name: 'work@example.com', label: 'Work network', current: false }] },
    'serve-list': { ok: true, status: { TCP: { '8443': { HTTPS: true } }, Web: { 'phone.example.ts.net:8443': { Handlers: { '/notes': { Proxy: 'http://127.0.0.1:8080' } } } } } },
    'funnel-list': { ok: true, status: {} },
    traffic: { ok: true, hours: Array.from({ length: 24 }, (_, hour) => ({ hour, samples: 60, iface: { rx: hour * 1048576, tx: hour * 262144 } })), days: [{ date: '2026-10-21', samples: 1440, rx: 12000000, tx: 3000000 }], topn: peers.map(p => ({ id: p.id, rx: p.rxBytes, tx: p.txBytes })), uids: [{ uid: '10234', tx: 604445050 }] },
    'traffic-uids': { ok: true, uids: [{ uid: '10234', tx: 604445050 }] },
    apps: { ok: true, apps: [{ label: 'Firefox', package: 'org.mozilla.firefox', uid: 10234 }, { label: 'Shared UID app', package: 'example.shared', uid: 10234 }, { label: 'Termux', package: 'com.termux', uid: 10372 }] },
    'routes-get': { ok: true, scope: 'all', uids: [], subnets: ['100.64.0.0/10'] },
    'subnet-routes-get': { ok: true, acceptRoutes: false, mode: 'tun', ipv6Enabled: false, peers: [{ id: 'nas', hostname: 'home-server', online: true, routes: [{ cidr: '192.168.10.0/24', primary: true }] }] },
    'settings-get': { ok: true, settings, restartRequired: false },
    'context-get': { ok: true, rules: '# Personal rules\nssid:Home:up\ncellular:-:down\n' },
    'context-status': { ok: true, status: { running: true, context: 'ssid:Home', lastResult: { context: 'ssid:Home', ok: true, at: 1788912000 } } },
    'owner-capability': { ok: true, available: true },
    'hooks-get': { ok: true, hooks: [{ name: 'foxytail.tun.up', content: '# User hook\necho ready\n', missing: false }, { name: 'foxytail.tun.down', content: '', missing: true }] },
    'socks-check': { ok: true, success: true, httpCode: '200', elapsedMs: 18 },
    'dns-probe': { ok: true, transparentAvailable: true, hijackAvailable: true },
    logs: { ok: true, lines: ['2026-10-22 [Info] Simulated tunnel ready', '2026-10-22 [Warning] Simulated peer offline'] },
    'files-inbox': { ok: true, files: [{ name: 'network-notes.pdf', size: 248928, mtime: 1788912000 }, { name: 'camera-roll.zip', size: 15687204, mtime: 1788896200 }], ignored: 0 },
    'taildrop-targets': { ok: true, peers: peers.map(({ id, hostname, ips, online }) => ({ id, hostname, ips, online })) },
    'file-send-history': { ok: true, transfers: [transfer] },
    'trial-status': { ok: true, trial: null },
    'backup-list': { ok: true, backups: [{ name: 'foxytail-backup-preview.tar.gz', path: '/sdcard/Download/foxytail-backup-preview.tar.gz', size: 500, mtime: 1788912000 }] },
  };
  let control = { ok: true, compatible: true, canWrite: true, canStop: true, busy: false, ownsMutation: false, unknown: false, canCancel: false, id: null, command: '', label: '', message: '', sequence: 0, revision: 0, accountRevision: 0, result: null, tasks: [], checking: false };
  let files = { ok: true, selection: [], busy: false, preparing: false, unknown: false, job: null, message: '', transfer: null };
  const drafts = {}, log = [], held = [], holdNext = new Set(), overrides = new Map(), unsupported = [];
  const appearance = { theme, language: lang };
  let sequence = 0;
  let listedDownload = false;
  if (state === 'no-root') control = { ...control, compatible: false, canWrite: false, canStop: false, message: 'Simulated root unavailable', error: 'root_unavailable' };
  if (state === 'unknown') control = { ...control, canWrite: false, busy: true, ownsMutation: true, unknown: true, canCancel: true, id: 'preview-unresolved', command: 'control', label: 'Simulated pending operation', message: 'Simulated receipt unavailable; do not repeat', tasks: [{ id: 'preview-unresolved', command: 'control', label: 'Simulated pending operation', status: 'unknown' }] };
  if (state === 'empty') {
    for (const payload of Object.values(data)) for (const key of ['peers', 'peerList', 'files', 'transfers', 'hours', 'days', 'topn', 'uids', 'accounts', 'apps', 'backups', 'lines']) if (Array.isArray(payload[key])) payload[key] = [];
    data.status.peers = { online: 0, offline: 0 };
    data['serve-list'].status = {}; data['context-get'].rules = '';
  }
  if (state === 'login') data.status.backend = 'NeedsLogin';
  if (state === 'starting') data.status.backend = 'Starting';
  if (state === 'stopped') { data.status.daemon = 'stopped'; data.status.backend = 'NoState'; }
  if (state === 'proxy') { settings.TS_MODE = data.status.mode = data.tun.mode = 'proxy'; }
  const emit = (event, value) => window.FoxyTailNative?.onmessage?.({ data: JSON.stringify({ event, data: clone(value) }) });
  const publishControl = patch => { control = { ...control, ...clone(patch), sequence: control.sequence + 1 }; emit('control', control); };
  const publishFiles = patch => { files = { ...files, ...clone(patch) }; emit('files', files); };
  const unsupportedResult = key => { unsupported.push(key); return fail('unsupported ' + key); };
  function command(name, args) {
    if (state === 'error') return fail('service temporarily unavailable');
    if (state === 'no-root') return fail('root unavailable');
    if (Object.hasOwn(data, name)) return clone(data[name]);
    switch (name) {
      case 'settings-set': {
        if (args.length !== 2 || !Object.hasOwn(settings, args[0]) || args[0] === 'TS_MODE') return fail('invalid setting');
        settings[args[0]] = args[1];
        data['settings-get'].restartRequired = true;
        return { ok: true, saved: true, applied: false, restartRequired: true };
      }
      case 'control':
        data.status.daemon = args[0] === 'stop' ? 'stopped' : 'running'; data.status.backend = args[0] === 'stop' ? 'NoState' : 'Running';
        data.status.mode = data.tun.mode = settings.TS_MODE; data['settings-get'].restartRequired = false;
        return { ok: true, applied: true, restartRequired: false };
      case 'mode-set': settings.TS_MODE = args[0]; return { ok: true, saved: true, restartRequired: true };
      case 'routes-set': data['routes-get'] = { ok: true, scope: args[0], uids: args[1] === '-' ? [] : args[1].split(','), subnets: args[2] === '-' ? [] : args[2].split(',') }; return { ok: true, saved: true, applied: true, restartRequired: false };
      case 'subnet-routes-set': data['subnet-routes-get'].acceptRoutes = args[0] === 'on'; return { ok: true, applied: true, acceptRoutes: args[0] === 'on' };
      case 'context-set': data['context-get'].rules = decodeURIComponent(escape(window.atob(args[0]))); return { ok: true, saved: true, applied: false, restartRequired: true };
      case 'exitnode-set': case 'exitnode-clear': {
        const peer = name === 'exitnode-set' ? peers.find(p => p.id === args[0]) : null;
        if (name === 'exitnode-set' && !peer) return fail('unknown exit node');
        data.status.exitNode = peer ? { ...peer, rx: peer.rxBytes, tx: peer.txBytes } : null;
        data['exit-routing'].exitRouting = { known: true, selected: peer ? { id: peer.id, ip: peer.ip, auto: '', allowLAN: false } : null, effective: peer ? 'daemon-owned' : 'none', ipv4: !!peer, ipv6: false, warning: '' };
        return { ok: true };
      }
      case 'coexist-info': return { ok: true, snapshot: 'preview-1', mode: settings.TS_MODE, socksPort: Number(settings.SOCKS_PORT), ipv6Enabled: false, suffix: data.dns.suffix, dns: clone(data.dns), dnsReady: true, peers: peers.map(p => ({ ...p, dnsName: p.hostname + '.example.ts.net' })), addresses: ['100.69.138.97', 'fd7a:115c:a1e0::8'], environment: clone(data.compat) };
      case 'coexist-check': return { ok: true, snapshot: args[0], name: peers.find(p => p.id === args[1])?.hostname + '.example.ts.net', address: args[2], targetPort: Number(args[3]), path: settings.TS_MODE === 'tun' ? 'system' : 'socks5', checks: ['dns-udp', 'dns-tcp', ...(args[4] !== '-' ? ['resolver-udp', 'resolver-tcp'] : []), 'tcp'].map(id => ({ id, ok: true, addresses: [args[2]], elapsedMs: 3 })) };
      case 'speedtest-exitnodes': return { ok: true, results: peers.filter(p => p.exitNodeOption).map(p => ({ id: p.id, hostname: p.hostname, ip: p.ip, latencyMs: 23, ok: true })) };
      case 'peer-ping': return { ok: true, peerId: args[0], ip: args[1], latencyMs: 23, via: '100.69.138.97:41641', path: 'direct' };
      case 'derp-speedtest': return { ok: true, preferred: 'tok', relays: [{ code: 'tok', latencyMs: 28 }] };
      case 'diag': case 'backup': return { ok: true, path: '/data/adb/foxytail/exports/preview.tar.gz', artifactId: token, mode: args[0] || 'share' };
      case 'restore-preview': return { ok: true, path: args[0], sha256: 'b'.repeat(64), baselineSha256: 'c'.repeat(64), changes: [{ file: 'foxytail.conf', key: 'SOCKS_PORT', before: '1099', after: '1100' }], hooks: ['foxytail.tun.up'] };
      case 'restore': return { ok: true, saved: true, applied: false, restartRequired: true, previous: '/data/adb/foxytail/conf.bak-preview', note: null };
      case 'file-delete-many': case 'file-export-many': {
        const names = JSON.parse(args[0]);
        const results = names.map((name, i) => i === 0 ? { name, ok: true } : { name, ok: false, error: 'Simulated file busy' });
        if (name === 'file-delete-many') data['files-inbox'].files = data['files-inbox'].files.filter(f => !results.some(r => r.ok && r.name === f.name));
        return { ok: true, results };
      }
      case 'file-delete': data['files-inbox'].files = data['files-inbox'].files.filter(f => f.name !== args[0]); return { ok: true };
      case 'file-clear': { const removed = data['files-inbox'].files.length; data['files-inbox'].files = []; return { ok: true, removed, ignored: 0 }; }
      case 'file-export': return { ok: true, path: '/sdcard/Download/' + args[0] };
      case 'file-send-delete': case 'file-send-clear': { const rows = data['file-send-history'].transfers; data['file-send-history'].transfers = name === 'file-send-clear' ? [] : rows.filter(r => r.id !== args[0]); return { ok: true, removed: rows.length - data['file-send-history'].transfers.length, retained: 0 }; }
      case 'file-send-status': return data['file-send-history'].transfers.find(t => t.id === args[0]) ? { ok: true, transfer: clone(data['file-send-history'].transfers.find(t => t.id === args[0])) } : fail('unknown transfer');
      case 'trial-start': { const summary = { mode: settings.TS_MODE, dnsMode: settings.DNS_MODE, routeScope: 'all' }; data['trial-status'].trial = { id: 'preview-trial', status: 'running', remaining: Number(args[0]), reason: '', previous: summary, candidate: summary }; return { ok: true }; }
      case 'trial-confirm': case 'trial-revert': if (!data['trial-status'].trial) return fail('no trial'); data['trial-status'].trial.status = name === 'trial-confirm' ? 'confirmed' : 'rolled-back'; return { ok: true };
      case 'serve-set': case 'serve-del': case 'funnel-set': case 'funnel-del': return fail('mapping edits are not simulated');
      case 'login-authkey': case 'switch': case 'logout': return fail('account changes are not simulated; do not enter credentials');
      default: return unsupportedResult(name);
    }
  }
  function action(name, args) {
    switch (name) {
      case 'app.bootstrap': return { ok: true, appearance, page, control, files, drafts };
      case 'app.navigate': page = args.page; return { ok: true };
      case 'app.appearance': Object.assign(appearance, args); emit('appearance', { appearance }); return { ok: true, appearance };
      case 'app.drafts': if (Object.hasOwn(args, 'value')) drafts[args.key] = clone(args.value); return { ok: true, value: drafts[args.key] ?? null };
      case 'app.close': return { ok: true };
      case 'app.copy': return { ok: true, simulated: true };
      case 'app.openUrl': return fail('external navigation disabled in preview');
      case 'app.login': return { ok: true, url: 'https://login.example.test/simulated' };
      case 'control.refresh': return { ok: true, control };
      case 'control.cancelRead': return { ok: true, cancelled: true };
      case 'control.cancel': if (args.id !== control.id) return fail('operation identity mismatch'); return { ok: true, requested: true };
      case 'control.acknowledge': publishControl({ unknown: false, busy: false, canWrite: true, canCancel: false }); return { ok: true };
      case 'files.snapshot': return clone(files);
      case 'files.clear': publishFiles({ selection: [] }); return { ok: true };
      case 'files.remove': publishFiles({ selection: files.selection.filter(f => f.key !== args.key) }); return { ok: true };
      case 'files.browse':
        if (!['', 'Download'].includes(args.path)) return fail('directory not found');
        listedDownload = args.path === 'Download' && state !== 'empty';
        return { ok: true, path: args.path, entries: state === 'empty' ? [] : args.path === '' ? [{ name: 'Download', directory: true, size: 0, mtime: 1788912000 }] : [{ name: 'notes.txt', directory: false, size: 120, mtime: 1788912000, handle: 'preview-notes' }], truncated: false };
      case 'files.addShared':
        if (!listedDownload || !Array.isArray(args.handles) || args.handles.length !== 1 || args.handles[0] !== 'preview-notes') return fail('unknown source handle');
        publishFiles({ selection: [{ key: 'preview-source', name: 'notes.txt', size: 120, source: 'path', path: '/sdcard/Download/notes.txt' }] }); return { ok: true };
      case 'files.pick': case 'files.import': case 'backup.import': case 'files.open': case 'files.share': case 'files.save': case 'artifact.save': case 'artifact.share':
      case 'files.send': case 'files.retry': case 'files.adopt': case 'files.cancel': case 'files.cancelExport': return fail('requires Android native file I/O; no bytes were read or transferred');
      default: return unsupportedResult(name);
    }
  }
  if (state !== 'no-bridge') window.FoxyTailNative = {
    postMessage(raw) {
      const request = JSON.parse(raw); log.push(clone(request));
      const { id, action: name, args } = request;
      const key = name === 'control.query' || name === 'control.mutate' ? args.command : name;
      const mutation = name === 'control.mutate';
      if (mutation && (!control.canWrite || control.busy) && !(key === 'control' && args.arguments[0] === 'stop' && control.canStop)) {
        window.FoxyTailNative.onmessage?.({ data: JSON.stringify({ id, result: fail('control is unavailable or another operation is pending') }) });
        return;
      }
      const durableId = mutation ? 'preview-operation-' + ++sequence : null;
      // Mirror ControlClient.readOnlyOperation: probe-style commands run as
      // operations but never claim mutation ownership, so reads continue.
      const readOnly = ['peer-ping', 'speedtest-exitnodes', 'derp-speedtest', 'coexist-info', 'coexist-check', 'diag-check', 'socks-check', 'dns-probe'].includes(key);
      if (mutation) publishControl({ id: durableId, command: key, label: key, busy: true, ownsMutation: !readOnly, canWrite: false, canCancel: true, unknown: false, result: null, tasks: [{ id: durableId, command: key, label: key, status: 'running' }] });
      const value = clone(overrides.has(key) ? overrides.get(key) : mutation || name === 'control.query' ? command(key, args.arguments) : action(name, args));
      const finish = (replacement = value) => {
        if (mutation) publishControl({ id: durableId, busy: !!replacement.unknown, ownsMutation: !!replacement.unknown && !readOnly, unknown: !!replacement.unknown, canWrite: control.compatible && !replacement.unknown, canCancel: !!replacement.unknown, revision: control.revision + 1, result: replacement, tasks: [{ id: durableId, command: key, label: key, status: replacement.unknown ? 'unknown' : replacement.ok ? 'done' : 'error', result: replacement }] });
        window.FoxyTailNative?.onmessage?.({ data: JSON.stringify({ id, result: clone(replacement) }) });
      };
      if (holdNext.delete(key)) held.push({ key, request, result: clone(value), finish });
      else window.setTimeout(finish, state === 'slow' ? 1500 : delay);
    },
  };
  return { data, settings, token, transfer, drafts, appearance, log, held, holdNext, overrides, unsupported, emit, publishControl, publishFiles, command, get control() { return control; }, get files() { return files; } };
}
