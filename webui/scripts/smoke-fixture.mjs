// Shared jsdom and asynchronous root bridge for the smoke scenarios.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
export { JSDOM, VirtualConsole };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = process.argv[2] || join(root, '.smoke/app.js');
if (!existsSync(bundlePath)) {
  console.error('smoke bundle missing; run: vite build --config vite.smoke.config.ts');
  process.exit(1);
}
/* The harness evaluates a prebuilt bundle: fail fast when any source under
 * webui/src/ is newer, so a run can never describe a stale build. */
const bundleMtime = statSync(bundlePath).mtimeMs;
const staleSources = readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && statSync(join(entry.parentPath, entry.name)).mtimeMs > bundleMtime)
  .map(entry => join(entry.parentPath, entry.name));
if (staleSources.length) {
  console.error('smoke bundle is stale; these sources are newer than .smoke/app.js:');
  for (const p of staleSources.slice(0, 5)) console.error('  ' + p);
  console.error('run: vite build --config vite.smoke.config.ts');
  process.exit(1);
}
const bundle = readFileSync(bundlePath, 'utf8');

const ROUTES = [
  'dashboard', 'peers', 'exitnodes', 'account', 'tunnel', 'routing', 'traffic',
  'serve', 'files', 'logs', 'settings', 'diag', 'more',
];

const failures = [];
const vc = new VirtualConsole();
vc.on('error', (...a) => failures.push('console.error: ' + a.join(' ')));
vc.on('jsdomError', (e) => {
  const msg = String(e && e.message ? e.message : e);
  if (/not implemented/i.test(msg)) return;
  failures.push('jsdomError: ' + msg);
});

const dom = new JSDOM(
  '<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>',
  {
    url: 'https://foxytail.local/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  },
);

const { window } = dom;

/* --- environment stubs ------------------------------------------------- */
const stubDom = (w) => {
  // Keep real frame/task ordering while making frame cadence deterministic.
  w.requestAnimationFrame = (run) => w.setTimeout(() => run(w.performance.now()), 0);
  w.cancelAnimationFrame = (id) => w.clearTimeout(id);
  w.matchMedia = (q) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  w.scrollTo = () => {};
  w.Element.prototype.scrollTo = function () {};
  w.Element.prototype.scrollIntoView = function () {};
  w.document.execCommand = () => true;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
};
stubDom(window);

/* --- mock KSU bridge -----------------------------------------------------
 * Answers webapi subcommands with canned JSON. speedtest-exitnodes is held
 * open until the test releases it, simulating a long-running probe. */
const bridge = { releaseSpeedtest: null, holdCancel: false, execCount: 0, speedtestExecCount: 0, nativeExecCount: 0, throwSpawn: false };
const pendingCancels = [];
const commandLog = [];
const holdNext = new Set();
const heldReplies = [];
const canned = {
  status: { ok: true, daemon: 'running', backend: 'NeedsLogin', mode: 'tun', self: { hostname: 'fox', ips: ['100.64.0.1'], relay: 'sin' }, exitNode: null, peers: { online: 1, offline: 0 }, magicDns: true, keyExpiry: null, uptime: 60 },
  peers: { ok: true, peers: [{ id: 'p1', hostname: 'peer-one', ip: '100.64.0.2', ips: ['100.64.0.2', 'fd7a:115c:a1e0::2'], os: 'linux', relay: 'sin', online: true, rxBytes: 1024, txBytes: 2048, exitNodeOption: true }] },
  exitnodes: { ok: true, peers: [{ id: 'p1', hostname: 'peer-one', ip: '100.64.0.2', os: 'linux', relay: 'sin', online: true, rxBytes: 1024, txBytes: 2048, exitNodeOption: true }] },
  'key-expiry': { ok: true, expiring: false, date: null },
  compat: { ok: true, modules: [], apps: [], warnings: [], alert: null },
  tun: { ok: true, ifaceUp: true, gateway: '100.64.0.1', hevPid: 123, mode: 'tun', socksPort: 1099 },
  dns: { ok: true, state: 'running', suffix: 'fox.ts.net', port: 1055 },
  accounts: { ok: true, accounts: [{ name: 'me@example.com', current: true }] },
  'serve-list': { ok: true, status: {} },
  'funnel-list': { ok: true, status: {} },
  traffic: { ok: true, hours: [], days: [], topn: [] },
  'traffic-uids': { ok: true, uids: [] },
  apps: { ok: true, apps: [{ label: 'com.example.app', package: 'com.example.app', uid: 10234 }] },
  'routes-get': { ok: true, scope: 'all', uids: [], subnets: ['100.64.0.0/10'] },
  'subnet-routes-get': {
    ok: true, acceptRoutes: false, mode: 'tun', ipv6Enabled: true,
    peers: [{ id: 'router-1', hostname: 'office-router', online: true, routes: [{ cidr: '192.168.44.0/24', primary: true }] }],
  },
  'subnet-routes-set': { ok: true, acceptRoutes: true, applied: true },
  'settings-get': { ok: true, restartRequired: false, settings: { TS_MODE: 'tun', MAGIC_DNS: 'on', IPV6: 'off', SOCKS_PORT: '1099' } },
  'context-get': { ok: true, rules: 'ssid:Home:down' },
  logs: { ok: true, lines: ['line one', 'line two'] },
  'serve-del': { ok: true },
  'funnel-del': { ok: true },
  'serve-set': { ok: true },
  'funnel-set': { ok: true },
  login: { ok: true, url: 'https://login.example.test/device' },
  logout: { ok: true },
  backup: { ok: true, path: '/sdcard/Download/foxytail-backup-smoke-first.tar.gz' },
  'settings-set': { ok: true, saved: true, applied: false, restartRequired: true },
  control: { ok: true, applied: true, restartRequired: false },
  'files-inbox': { ok: true, files: [{ name: 'a.txt', size: 10, mtime: 1700000000 }] },
};

/* Per-command bridge overrides: webapi subcommand -> [errno, stdout, stderr].
 * Drives the errno != 0 failure contract ({ok:false,error} on stdout). */
const overrides = {};

window.ksu = {
  exec(cmd, opts, cbName) {
    bridge.execCount++;
    const cb = window[cbName];
    const apiArgs = cmd.includes('foxytail.webapi.sh')
      ? (cmd.slice(cmd.indexOf('foxytail.webapi.sh') + 'foxytail.webapi.sh'.length)
          .match(/'[^']*'|[^\s]+/g) || []).map((arg) => arg.startsWith("'") ? arg.slice(1, -1) : arg)
      : [];
    const requestId = apiArgs[0] === '--request-id' ? apiArgs[1] : null;
    if (requestId) apiArgs.splice(0, 2);
    const sub = apiArgs.shift();
    commandLog.push({ cmd, sub, requestId, args: apiArgs });
    if (holdNext.delete(sub)) {
      const output = JSON.stringify(canned[sub]);
      heldReplies.push({ sub, finish: () => cb(0, output, '') });
      return;
    }
    if (sub === 'cancel' && !overrides.cancel) {
      const acknowledge = () => cb(0, JSON.stringify({ ok: true }), '');
      if (bridge.holdCancel) pendingCancels.push({ requestId: apiArgs[0], acknowledge });
      else queueMicrotask(acknowledge);
      return;
    }
    if (sub && overrides[sub]) {
      const [e, out, err] = overrides[sub];
      return void queueMicrotask(() => cb(e, out, err));
    }
    if (sub === 'speedtest-exitnodes') {
      bridge.speedtestExecCount++;
      /* held open until released by the test */
      new Promise((resolve) => (bridge.releaseSpeedtest = resolve)).then(() => {
        cb(0, JSON.stringify({ ok: true, results: [{ id: 'p1', hostname: 'peer-one', ip: '100.64.0.2', latencyMs: 23, ok: true }] }), '');
      });
      return;
    }
    if (sub && canned[sub]) {
      queueMicrotask(() => cb(0, JSON.stringify(canned[sub]), ''));
      return;
    }
    if (sub) return void queueMicrotask(() => cb(1, JSON.stringify({ ok: false, error: 'unmocked API command: ' + sub }), ''));
    if (cmd.startsWith('iptables -m owner --help') || cmd.startsWith('cat /data/adb/foxytail/scripts/foxytail.tun.')) {
      queueMicrotask(() => cb(0, 'yes', ''));
      return;
    }
    if (cmd.startsWith('curl --proxy socks5h://127.0.0.1:')) {
      queueMicrotask(() => cb(0, '200', ''));
      return;
    }
    failures.push('unexpected raw command: ' + cmd);
    queueMicrotask(() => cb(1, '', 'unmocked raw command'));
  },
};

/* Modern managers provide both APIs. exec can synchronously block for the
 * whole command, while spawn returns before its separate output events. */
const mockExec = window.ksu.exec.bind(window.ksu);
const spawnLog = [];
window.ksu.exec = (...args) => { bridge.nativeExecCount++; return mockExec(...args); };
window.ksu.spawn = (cmd, args, options, callbackName) => {
  spawnLog.push({ cmd, args, options });
  if (bridge.throwSpawn) throw new Error('spawn-shell-unavailable');
  const receiver = window[callbackName];
  const resultName = callbackName + '_mock_result';
  window[resultName] = (errno, stdout, stderr) => {
    delete window[resultName];
    if (stdout) stdout.split('\n').forEach((line) => receiver.stdout.emit('data', line));
    if (stderr) stderr.split('\n').forEach((line) => receiver.stderr.emit('data', line));
    receiver.emit('exit', errno);
    // KernelSU also reports error after a failed exit; it must not settle
    // a request twice or lose the stdout JSON error in favor of stderr.
    if (errno !== 0) window.setTimeout(() => window[callbackName]?.emit('error', new Error(stderr)), 0);
  };
  window.setTimeout(() => mockExec(cmd, options, resultName), 0);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) await sleep(0);
}

function nav(route) {
  window.location.hash = '#/' + route;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
}

let checks = 0;
function assert(cond, label) {
  checks++;
  if (!cond) failures.push('assert failed: ' + label);
}

export { window, bundle, ROUTES, failures, vc, stubDom, bridge, pendingCancels, commandLog, holdNext, heldReplies, canned, overrides, spawnLog, flush, nav, assert, checks };
