#!/usr/bin/env node
/*
 * jsdom smoke test:
 *  1. renders the app without a root bridge -> no-root banner, no crash
 *  2. switches all 13 routes x 3 rapid rounds -> no exceptions, no leaks
 *  3. task adoption: start a mock long speedtest task on ExitNodes,
 *     navigate away and back -> still running, progress state adopted;
 *     completing the mock -> cached result shown without re-firing
 *  4. cancel path settles the task as cancelled
 *  5. no-root banner variant (separate jsdom without any bridge)
 *  6. backend error propagation: errno != 0 with {ok:false,error} on stdout
 *  7. task replacement: the replaced run's stale promise must not mark
 *     the new run cancelled
 *  8. tab buttons render non-empty labels
 *
 * Run `pnpm smoke`; the package script builds this bundle first.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(root, '.smoke/app.js');
if (!existsSync(bundlePath)) {
  console.error('smoke bundle missing; run: vite build --config vite.smoke.config.ts');
  process.exit(1);
}
/* The harness evaluates a prebuilt bundle: fail fast when any source under
 * webui/src/ is newer, so a run can never describe a stale build. */
const bundleMtime = statSync(bundlePath).mtimeMs;
const staleSources = [];
const walkSources = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkSources(p);
    else if (statSync(p).mtimeMs > bundleMtime) staleSources.push(p);
  }
};
walkSources(join(root, 'src'));
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
  /* jsdom lacks canvas; that "not implemented" notice is not an app bug */
  const msg = String(e && e.message ? e.message : e);
  if (/not implemented/i.test(msg) && /canvas|getContext|execCommand/i.test(msg + (e.detail || ''))) return;
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
/* jsdom's ElementInternals ARIA reflection is broken (role setter reads an
 * uninitialized internals map); real WebViews implement it. Stub the whole
 * attachInternals surface for the smoke environment. */
const stubInternals = (w) => {
  w.HTMLElement.prototype.attachInternals = function () {
    return new Proxy(
      { shadowRoot: this.shadowRoot ?? null },
      {
        get: (t, p) => (p in t ? t[p] : () => {}),
        set: () => true,
      },
    );
  };
};
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
  stubInternals(w);
};
stubDom(window);

/* --- mock KSU bridge -----------------------------------------------------
 * Answers webapi subcommands with canned JSON. speedtest-exitnodes is held
 * open until the test releases it, simulating a long-running probe. */
let releaseSpeedtest = null;
let holdCancel = false;
const pendingCancels = [];
const commandLog = [];
const holdNext = new Set();
const heldReplies = [];
const canned = {
  status: { ok: true, daemon: 'running', backend: 'NeedsLogin', mode: 'tun', self: { hostname: 'fox', ips: ['100.64.0.1'], relay: 'sin' }, exitNode: null, peers: { online: 1, offline: 0 }, magicDns: true, keyExpiry: null, uptime: 60 },
  peers: { ok: true, peers: [{ id: 'p1', hostname: 'peer-one', ip: '100.64.0.2', os: 'linux', relay: 'sin', online: true, rxBytes: 1024, txBytes: 2048, exitNodeOption: true }] },
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
  'settings-set': { ok: true, saved: true, applied: false, restartRequired: true },
  control: { ok: true, applied: true, restartRequired: false },
  'files-inbox': { ok: true, files: [{ name: 'a.txt', size: 10, mtime: 1700000000 }] },
};

/* Per-command bridge overrides: webapi subcommand -> [errno, stdout, stderr].
 * Drives the errno != 0 failure contract ({ok:false,error} on stdout). */
const overrides = {};

let execCount = 0;
let speedtestExecCount = 0;
window.ksu = {
  exec(cmd, opts, cbName) {
    execCount++;
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
      if (holdCancel) pendingCancels.push({ requestId: apiArgs[0], acknowledge });
      else queueMicrotask(acknowledge);
      return;
    }
    if (sub && overrides[sub]) {
      const [e, out, err] = overrides[sub];
      return void queueMicrotask(() => cb(e, out, err));
    }
    if (sub === 'speedtest-exitnodes') {
      speedtestExecCount++;
      /* held open until released by the test */
      new Promise((resolve) => (releaseSpeedtest = resolve)).then(() => {
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
let nativeExecCount = 0;
let throwSpawn = false;
const spawnLog = [];
window.ksu.exec = (...args) => { nativeExecCount++; return mockExec(...args); };
window.ksu.spawn = (cmd, args, options, callbackName) => {
  spawnLog.push({ cmd, args, options });
  if (throwSpawn) throw new Error('spawn-shell-unavailable');
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

function assert(cond, label) {
  if (!cond) failures.push('assert failed: ' + label);
  else console.log('  ok — ' + label);
}

/* --- boot --------------------------------------------------------------- */
try {
  window.eval(bundle);
} catch (e) {
  console.error('bundle evaluation threw:', e);
  process.exit(1);
}
assert(execCount === 0 && spawnLog.length === 0, 'first UI renders before any native bridge invocation');
await flush();

console.log('[1] boot without root bridge is covered separately; here a mock bridge exists');
assert(window.document.querySelector('#app-header'), 'header rendered');
assert(window.document.querySelectorAll('#bottom-nav .nav-item').length === 5, 'bottom nav has 5 items');
assert(window.document.querySelector('#view'), 'view outlet exists');

console.log('[2] 13 routes x 3 rapid rounds');
for (let round = 0; round < 3; round++) {
  const beforeNavigation = execCount;
  for (const r of ROUTES) {
    nav(r);
    /* same-frame check: navigation is synchronous, skeleton is immediate */
    const view = window.document.querySelector('#view');
    assert(view && view.childNodes.length > 0, `route ${r} (round ${round + 1}) rendered synchronously`);
  }
  await flush(3);
  assert(execCount === beforeNavigation, 'rapid routes drop abandoned reads before launch without cancel calls (round ' + (round + 1) + '): ' + commandLog.slice(beforeNavigation).map((entry) => entry.sub || entry.cmd).join(', '));
}
await flush();

console.log('[3] task adoption across navigation');
nav('exitnodes');
await flush();
const beforeCount = execCount;
window.__foxy.startTask('speedtest-exitnodes', 'speedtest-exitnodes');
await flush();
assert(window.__foxy.getTask('speedtest-exitnodes')?.status === 'running', 'task running after start');
assert(
  window.document.querySelector('#view .progress-row'),
  'progress row visible on originating page',
);

nav('dashboard');
await flush();
assert(
  window.__foxy.getTask('speedtest-exitnodes')?.status === 'running',
  'task survives navigation away',
);
assert(window.document.querySelector('.task-menu a[href="#/exitnodes"]'), 'global activity links a running probe back to its originating page');

nav('exitnodes');
await flush();
assert(
  window.document.querySelector('#view .progress-row'),
  'progress state adopted on re-entry',
);
assert(
  window.__foxy.getTask('speedtest-exitnodes')?.status === 'running',
  'task still running after round trip',
);

releaseSpeedtest();
await flush();
assert(window.__foxy.getTask('speedtest-exitnodes')?.status === 'done', 'task done after release');
const speedtestCountAfterDone = speedtestExecCount;
assert(/23\s*ms/.test(window.document.querySelector('#view').textContent), 'cached result rendered (23ms)');

/* re-enter again: cached result, no new speedtest exec (list/status light
 * reads DO refire by design — only the heavy task must not) */
nav('dashboard');
nav('exitnodes');
await flush();
assert(
  speedtestExecCount === speedtestCountAfterDone,
  'no refire on re-entry (cached result adopted)',
);
assert(/23\s*ms/.test(window.document.querySelector('#view').textContent), 'result still shown from cache');

console.log('[4] cancel path');
window.__foxy.startTask('speedtest-exitnodes', 'speedtest-exitnodes');
await flush();
window.__foxy.cancelTask('speedtest-exitnodes');
await flush();
assert(
  window.__foxy.getTask('speedtest-exitnodes')?.status === 'cancelled',
  'cancel settles task as cancelled',
);

console.log('[5] no-root banner variant');
{
  /* separate jsdom without any bridge */
  const failures2 = [];
  const vc2 = new VirtualConsole();
  vc2.on('error', (...a) => failures2.push(a.join(' ')));
  vc2.on('jsdomError', (e) => {
    const msg = String(e && e.message ? e.message : e);
    if (/not implemented/i.test(msg)) return;
    failures2.push(msg);
  });
  const dom2 = new JSDOM(
    '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
    { url: 'https://foxytail.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc2 },
  );
  stubDom(dom2.window);
  try {
    dom2.window.eval(bundle);
  } catch (e) {
    failures2.push('eval threw: ' + e);
  }
  await flush();
  assert(
    !!dom2.window.document.querySelector('.root-banner'),
    'no-root banner shown when no bridge present',
  );
  for (const r of ROUTES) {
    dom2.window.location.hash = '#/' + r;
    dom2.window.dispatchEvent(new dom2.window.HashChangeEvent('hashchange'));
  }
  await flush();
  assert(
    dom2.window.document.querySelector('#view').childNodes.length > 0,
    'no-root: routes render without crash',
  );
  if (failures2.length) failures.push(...failures2.map((f) => 'no-root env: ' + f));
  dom2.window.close();
}

console.log('[6] backend error propagation (errno != 0, {ok:false,error} on stdout)');
overrides['routes-get'] = [1, '{"ok":false,"error":"boom-reason"}', ''];
nav('routing');
await flush();
assert(
  (window.document.querySelector('#view [role="alert"]')?.textContent || '').includes('boom-reason'),
  'backend error reason surfaces in the UI (boom-reason)',
);
delete overrides['routes-get'];

console.log('[7] task replacement: stale promise cannot poison the new run');
window.__foxy.startTask('speedtest-exitnodes', 'speedtest-exitnodes');
await flush();
window.__foxy.startTask('speedtest-exitnodes', 'speedtest-exitnodes');
await flush();
assert(
  window.__foxy.getTask('speedtest-exitnodes')?.status === 'running',
  'new run stays running after the old promise settles cancelled',
);
releaseSpeedtest();
await flush();
assert(
  window.__foxy.getTask('speedtest-exitnodes')?.status === 'done',
  'new run completes done after release',
);

console.log('[8] tab buttons render non-empty labels');
nav('logs');
await flush();
const tabButtons = [...window.document.querySelectorAll('[role="tab"]')];
assert(tabButtons.length > 0, 'tabbed route renders tab buttons');
assert(
  tabButtons.every((el) => (el.textContent || '').trim() !== ''),
  'every tab button label is non-empty',
);

console.log('[9] first-load failures render recoverable errors');
for (const [route, command] of [['peers', 'peers'], ['exitnodes', 'exitnodes'], ['files', 'files-inbox']]) {
  nav('dashboard');
  await flush();
  overrides[command] = [1, JSON.stringify({ ok: false, error: 'first-load-' + route }), ''];
  nav(route);
  await flush();
  const view = window.document.querySelector('#view');
  assert(view.textContent.includes('first-load-' + route), route + ': first failure visible');
  assert(!view.querySelector('.skeleton'), route + ': first failure leaves no loading skeleton');
  const retry = view.querySelector('.state-box button');
  assert(retry, route + ': retry offered');
  delete overrides[command];
  retry?.click();
  await flush();
  assert(!view.textContent.includes('first-load-' + route), route + ': retry recovers data');
}

console.log('[10] cancellation identity, delayed acknowledgement and replacement ordering');
const old = window.__foxy.startTask('identity', 'speedtest-exitnodes');
await flush();
const oldFinish = releaseSpeedtest;
const countBeforeReplace = speedtestExecCount;
holdCancel = true;
const replacement = window.__foxy.startTask('identity', 'speedtest-exitnodes');
await flush();
assert(speedtestExecCount === countBeforeReplace, 'replacement waits for cancellation acknowledgement');
assert(pendingCancels.some((entry) => entry.requestId === old.requestId), 'cancel targets only the old request id');
oldFinish();
await flush();
assert(window.__foxy.getTask('identity')?.status === 'running', 'late old response does not finish replacement');
for (const entry of pendingCancels.splice(0)) entry.acknowledge();
holdCancel = false;
await flush();
assert(speedtestExecCount === countBeforeReplace + 1, 'replacement launches once after acknowledgement');
assert(replacement.requestId !== old.requestId, 'replacement has a distinct identity');
releaseSpeedtest();
await flush();
assert(!commandLog.some(({ cmd }) => cmd.includes('pkill')), 'no cancellation uses process-name matching');

const cannotCancel = window.__foxy.startTask('denied', 'speedtest-exitnodes');
await flush();
overrides.cancel = [1, JSON.stringify({ ok: false, error: 'still running' }), ''];
const beforeDenied = speedtestExecCount;
window.__foxy.startTask('denied', 'speedtest-exitnodes');
await flush();
assert(speedtestExecCount === beforeDenied, 'failed cancellation blocks replacement');
assert(window.__foxy.getTask('denied')?.status === 'error', 'failed cancellation is visible as an error');
window.__foxy.startTask('denied', 'speedtest-exitnodes');
await flush();
assert(speedtestExecCount === beforeDenied, 'repeated replacement cannot bypass a failed cancellation');
delete overrides.cancel;
releaseSpeedtest();
await flush();

console.log('[11] native TUN capabilities and SOCKS5 protocol');
nav('tunnel');
await flush();
assert(!window.document.querySelector('#view').textContent.includes('SOCKS5'), 'native TUN has no SOCKS probe');
canned.tun = { ...canned.tun, mode: 'bridge' };
nav('dashboard');
nav('tunnel');
await flush();
const probe = [...window.document.querySelectorAll('#view button')].find((button) => button.textContent.includes('SOCKS5'));
assert(probe, 'bridge mode exposes SOCKS probe');
probe?.click();
await flush();
assert(commandLog.some(({ cmd }) => cmd.startsWith('curl --proxy socks5h://127.0.0.1:1099')), 'probe explicitly uses SOCKS5 with proxy-side DNS');
nav('routing');
await flush();
const scopeButtons = [...window.document.querySelectorAll('#view [role="radio"]')];
assert(scopeButtons.length === 3 && !scopeButtons[0].disabled && scopeButtons.slice(1).every((b) => b.disabled), 'native TUN disables selected/bypass but permits All');

console.log('[12] ServeConfig protocols, paths and Funnel visibility');
const serveFixture = {
  TCP: { '8443': { HTTPS: true }, '8080': { HTTP: true }, '2222': { TCPForward: 'localhost:22' }, '9443': { TCPForward: 'localhost:9000', TerminateTLS: 'fox.ts.net' } },
  Web: {
    'fox.ts.net:8443': { Handlers: { '/': { Proxy: 'http://localhost:3000' }, '/api': { Proxy: 'http://localhost:4000' } } },
    'fox.ts.net:8080': { Handlers: { '/docs': { Path: '/srv/docs' } } },
  },
  AllowFunnel: { 'fox.ts.net:8443': true },
};
canned['serve-list'] = { ok: true, status: serveFixture };
canned['funnel-list'] = { ok: true, status: serveFixture };
nav('serve');
await flush();
const serveCards = window.document.querySelectorAll('#view .card');
assert(serveCards[0].querySelectorAll('.list-row').length === 3, 'private section contains HTTP, TCP, and TLS terminated TCP only');
assert(serveCards[1].querySelectorAll('.list-row').length === 2, 'public section preserves both HTTPS paths');
assert(serveCards[1].textContent.includes('https fox.ts.net:8443/api'), 'HTTPS on 8443 remains HTTPS');
assert(!serveCards[0].textContent.includes('8443'), 'HTTPS listener is not duplicated as TCP');
const apiRow = [...serveCards[1].querySelectorAll('.list-row')].find((row) => row.textContent.includes('/api'));
apiRow?.querySelector('button')?.click();
await flush();
const cancelAction = window.document.querySelector('.md-dialog-actions button[autofocus]');
assert(/Cancel|取消/.test(cancelAction?.textContent || ''), 'confirmation defaults to the non-destructive Cancel action');
window.document.querySelector('.md-dialog-actions .btn-filled')?.click();
await flush();
assert(commandLog.some(({ sub, args }) => sub === 'funnel-del' && JSON.stringify(args) === JSON.stringify(['https', '8443', '/api'])), 'deletion preserves HTTPS protocol and the selected path');

console.log('[13] saved settings distinguish pending application');
nav('settings');
await flush();
assert(window.document.querySelector('#view').textContent.includes('fd7a:115c:a1e0::/48'), 'IPv6 switch explains the required routed subnet');
const portField = window.document.querySelector('#view input[type="number"]');
assert(portField, 'numeric settings field exists');
if (portField) {
  portField.value = '1100';
  portField.dispatchEvent(new window.Event('change', { bubbles: true }));
}
await flush();
assert(window.document.querySelector('#view .tool-pending'), 'saved but unapplied settings show a persistent restart notice');
canned.control = { ok: true, applied: false, restartRequired: true };
canned['settings-get'].restartRequired = true;
const restartButton = window.document.querySelector('#view .tool-pending button');
restartButton?.click();
await flush();
assert(commandLog.some(({ sub, args }) => sub === 'control' && args[0] === 'restart'), 'settings can apply through service restart');
assert(window.document.querySelector('#view .tool-pending'), 'a newer configuration revision stays pending after restart');
const latestToast = [...window.document.querySelectorAll('#toast-root .toast')].at(-1)?.textContent || '';
assert(!/配置已应用|Configuration applied/.test(latestToast), 'partial application does not report all settings applied');
canned.control = { ok: true, applied: true, restartRequired: false };
canned['settings-get'].restartRequired = false;
window.document.querySelector('#view .tool-pending button')?.click();
await flush();
assert(!window.document.querySelector('#view .tool-pending'), 'restart that applies the latest revision clears the pending notice');

console.log('[14] lightweight page reads and explicit DNS checks');
assert(!commandLog.some(({ sub }) => sub === 'key-expiry'), 'Dashboard derives key expiry from the shared status snapshot');
nav('more');
await flush();
const beforeTraffic = commandLog.length;
nav('traffic');
await flush();
const trafficCalls = commandLog.slice(beforeTraffic);
assert(!trafficCalls.some(({ sub }) => sub === 'apps' || sub === 'peers'), 'empty traffic skips package enumeration and peer-name queries');
nav('routing');
await flush();
assert(!commandLog.slice(beforeTraffic).some(({ sub }) => sub === 'apps'), 'native TUN routing skips unsupported per-app enumeration');
canned.dns = { ok: true, enabled: false, state: 'stopped', reason: 'disabled', upstreamNative: true, suffix: 'fox.ts.net' };
const beforeDns = commandLog.filter(({ sub }) => sub === 'dns').length;
nav('tunnel');
await flush();
assert(commandLog.filter(({ sub }) => sub === 'dns').length === beforeDns, 'DNS inspection is not an automatic page probe');
const dnsButton = [...window.document.querySelectorAll('#view button')].find((button) => /Check DNS status|检查 DNS 状态/.test(button.textContent));
assert(dnsButton, 'manual DNS status check is available');
dnsButton?.click();
await flush();
const dnsCard = [...window.document.querySelectorAll('#view .card')].find((card) => card.textContent.includes('MagicDNS'));
assert(dnsCard?.textContent.includes('Tailnet MagicDNS may still be enabled') || dnsCard?.textContent.includes('不代表 Tailnet MagicDNS 关闭'), 'disabled local resolver is distinguished from Tailnet MagicDNS');
assert(dnsCard?.textContent.includes('fox.ts.net') && /Detected|已检测到|已检测/.test(dnsCard?.textContent || ''), 'DNS inspection shows native routing configuration and suffix');
const originalDns = canned.dns;
canned.dns = { ...originalDns, enabled: true, state: 'running', reason: 'ipv6-unavailable' };
dnsButton?.click();
await flush();
const ipv4OnlyDns = dnsCard?.querySelector('.status-badge');
assert(ipv4OnlyDns?.classList.contains('tone-warning') && /Transparent IPv6 DNS forwarding unavailable\.|IPv6 DNS 透明转发不可用/.test(ipv4OnlyDns.textContent), 'DNS warns specifically about unavailable transparent IPv6 forwarding without claiming IPv6 connectivity is disabled');
assert(dnsCard?.querySelectorAll('.status-badge').length === 1 && !dnsCard.textContent.includes('ipv6-unavailable'), 'partial DNS availability has one localized status without duplicate indicators');
assert(!dnsCard?.querySelector('[data-testid="dns-ipv6-path"]'), 'an older backend without path fields does not invent an IPv6 detection result');
canned.dns = { ...originalDns, enabled: true, state: 'running', reason: 'running' };
dnsButton?.click();
await flush();
assert(dnsCard?.querySelector('.status-badge.tone-success') && !dnsCard.textContent.includes('IPv6'), 'a fresh healthy DNS result replaces the earlier IPv6 limitation');
const dnsPathCases = [
  ['available', 'not-needed', /^(Native|原生)$/],
  ['module-loaded', 'loaded', /^(Kernel module|内核模块)$/],
  ['fallback', 'missing', /^(Compatibility \(No module available\)|兼容 \(无可用模块\))$/],
  ['fallback', 'load-failed', /^(Compatibility \(Module load failed\)|兼容 \(模块加载失败\))$/],
  ['fallback', 'loader-unavailable', /^(Compatibility \(Module loader unavailable\)|兼容 \(无模块加载工具\))$/],
  ['fallback', 'not-checked', /^(Compatibility \(Module not checked\)|兼容 \(模块尚未检查\))$/],
  ['disabled', 'not-needed', /^(Disabled|已关闭)$/],
];
for (const [interception, moduleStatus, expectedLabel] of dnsPathCases) {
  canned.dns = { ...originalDns, enabled: true, state: 'running', reason: interception === 'fallback' ? 'ipv6-unavailable' : 'running', ipv6DnsInterception: interception, ipv6ModuleStatus: moduleStatus };
  const callsBeforePathCheck = commandLog.filter(entry => entry.sub === 'dns').length;
  dnsButton?.click();
  await flush();
  const pathRow = dnsCard?.querySelector('[data-testid="dns-ipv6-path"]');
  assert(pathRow && expectedLabel.test(pathRow.querySelector('.v')?.textContent || ''), interception + '/' + moduleStatus + ': manual DNS inspection identifies the detected IPv6 path');
  assert(Boolean(pathRow?.querySelector('.tool-hint')) === (interception === 'fallback'), interception + '/' + moduleStatus + ': only the compatibility path explains its interception limit');
  assert(dnsCard?.querySelectorAll('.status-badge').length === 1 && /^(Running|运行中)$/.test(dnsCard.querySelector('.status-badge')?.textContent || ''), interception + '/' + moduleStatus + ': the badge reports overall DNS health without duplicating the path');
  assert(commandLog.filter(entry => entry.sub === 'dns').length === callsBeforePathCheck + 1, interception + '/' + moduleStatus + ': detection does not trigger additional DNS requests');
}

// Exercise translated detection details through the real language setting.
const previousLanguage = window.document.documentElement.lang.startsWith('zh') ? 'zh' : 'en';
nav('settings');
await flush();
const languageSelector = () => [...window.document.querySelectorAll('#view select')].find(select => select.querySelector('option[value="zh"]') && select.querySelector('option[value="en"]'));
const languageControl = languageSelector();
assert(languageControl, 'the UI language can be changed for the DNS inspection');
if (languageControl) {
  languageControl.value = 'zh';
  languageControl.dispatchEvent(new window.Event('change', { bubbles: true }));
}
canned.dns = { ...originalDns, enabled: true, state: 'running', reason: 'ipv6-unavailable', ipv6DnsInterception: 'fallback', ipv6ModuleStatus: 'missing' };
const beforeLocalizedDns = commandLog.filter(entry => entry.sub === 'dns').length;
nav('tunnel');
await flush();
assert(commandLog.filter(entry => entry.sub === 'dns').length === beforeLocalizedDns && !window.document.querySelector('[data-testid="dns-ipv6-path"]'), 'changing language and reopening Tunnel leaves DNS inspection manual');
const localizedDnsCard = [...window.document.querySelectorAll('#view .card')].find(card => card.querySelector('h2')?.textContent.includes('MagicDNS'));
localizedDnsCard?.querySelector('button')?.click();
await flush();
const localizedPath = localizedDnsCard?.querySelector('[data-testid="dns-ipv6-path"]');
assert(localizedPath?.querySelector('.k')?.textContent === 'IPv6 DNS 路径' && localizedPath.querySelector('.v')?.textContent === '兼容 (无可用模块)' && localizedPath.querySelector('.tool-hint')?.textContent === '兼容路径不拦截 IPv6 DNS', 'Chinese detection copy distinguishes missing NAT modules from IPv6 connectivity');
nav('settings');
await flush();
const restoreLanguage = languageSelector();
if (restoreLanguage) {
  restoreLanguage.value = previousLanguage;
  restoreLanguage.dispatchEvent(new window.Event('change', { bubbles: true }));
}
canned.dns = originalDns;

console.log('[15] native asynchronous spawn selection, errors and shell quoting');
assert(spawnLog.length > 0 && nativeExecCount === 0, 'modern manager uses spawn for every read, task and cancellation');
assert(spawnLog.every((entry) => entry.args === '[]' && entry.options === '{}'), 'spawn never concatenates unquoted arguments or environment options');
overrides['login-authkey'] = [0, '{\n  "ok": true,\n  "message": "streamed"\n}', ''];
const hostileArgument = "alpha';$(echo unsafe)`echo unsafe`\nlast";
const quotedCall = window.__foxy.startTask('spawn-quote', 'login-authkey', hostileArgument);
await flush();
assert((await quotedCall.promise).message === 'streamed', 'line-oriented stdout reconstructs complete multiline JSON');
assert(spawnLog.some(({ cmd }) => cmd.endsWith("'alpha'\\'';$(echo unsafe)`echo unsafe`\nlast'")), 'quotes, substitutions and newlines remain within the prequoted command argument');
delete overrides['login-authkey'];
overrides['mode-get'] = [1, '', 'first stderr line\nsecond stderr line'];
const stderrFailure = window.__foxy.startTask('spawn-stderr', 'mode-get');
await flush();
assert((await stderrFailure.promise).error === 'first stderr line\nsecond stderr line', 'stderr lines survive a nonzero streamed exit');
delete overrides['mode-get'];
overrides['subnet-routes-get'] = [1, JSON.stringify({
  ok: false, error: 'subnet-inspection-failed', acceptRoutes: true, mode: 'tun', ipv6Enabled: true, peers: [],
}, null, 2), 'subnet command exited with an error'];
const beforePartialSpawn = spawnLog.length;
const partialSubnetCall = window.__foxy.startTask('spawn-partial-subnet', 'subnet-routes-get');
await flush();
const partialSubnetResult = await partialSubnetCall.promise;
assert(spawnLog.slice(beforePartialSpawn).some(entry => entry.cmd.includes('subnet-routes-get')) && nativeExecCount === 0, 'partial subnet errors use the native streamed stdout and nonzero exit path');
assert(partialSubnetResult.ok === false && partialSubnetResult.error === 'subnet-inspection-failed' && partialSubnetResult.acceptRoutes === true && partialSubnetResult.mode === 'tun' && partialSubnetResult.ipv6Enabled === true, 'a failed streamed command preserves authoritative preference fields while retaining ok false');
overrides['subnet-routes-get'] = [1, JSON.stringify({ ok: true, acceptRoutes: true, mode: 'tun', ipv6Enabled: true }), 'subnet-command-failed'];
const invalidSubnetSuccess = window.__foxy.startTask('spawn-false-success', 'subnet-routes-get');
await flush();
assert((await invalidSubnetSuccess.promise).ok === false && window.__foxy.getTask('spawn-false-success')?.status === 'error', 'a nonzero exit cannot become successful because its JSON claims ok true');
delete overrides['subnet-routes-get'];
throwSpawn = true;
const failedSpawn = window.__foxy.startTask('spawn-error', 'mode-get');
await flush();
assert((await failedSpawn.promise).error.includes('spawn-shell-unavailable'), 'synchronous spawn failure settles immediately instead of waiting for timeout');
throwSpawn = false;

console.log('[16] redesigned navigation, filtering and explicit actions');
for (const route of ROUTES) {
  nav(route);
  assert(window.document.querySelectorAll('#view h1').length === 1, route + ': one accessible page heading');
  const selected = window.document.querySelectorAll('#bottom-nav [aria-current="page"]');
  const parentRoute = ['dashboard', 'peers', 'exitnodes', 'traffic'].includes(route) ? route : 'more';
  assert(selected.length === 1 && selected[0].getAttribute('href') === '#/' + parentRoute, route + ': navigation identifies the active destination');
}
await flush();
canned.peers.peers.push({ ...canned.peers.peers[0], id: 'p2', hostname: 'offline-tablet', ip: '100.64.0.3', online: false });
nav('peers');
assert(window.document.querySelector('#view [aria-busy="true"]'), 'device inventory immediately exposes a loading state');
await flush();
const search = window.document.querySelector('#view input[type="search"]');
const beforeSearch = commandLog.length;
search.value = '100.64.0.3';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
assert(window.document.querySelectorAll('.network-peer-row').length === 1 && window.document.querySelector('.network-peer-row').textContent.includes('offline-tablet'), 'device search matches IP addresses');
const onlineFilter = [...window.document.querySelectorAll('#view .filter-chip')].find(button => /^(Online|在线)$/.test(button.textContent));
onlineFilter?.click();
assert(window.document.querySelectorAll('.network-peer-row').length === 0, 'device search combines with online filtering');
assert(commandLog.length === beforeSearch, 'search and filters never launch native bridge calls');

nav('exitnodes');
await flush();
const beforeSelection = commandLog.length;
window.document.querySelector('input[name="exit-node"][value="p1"]')?.click();
await flush();
assert(!commandLog.slice(beforeSelection).some(({ sub }) => sub === 'exitnode-set'), 'selecting an exit does not change the connection');
canned['exitnode-set'] = { ok: true };
const applyExit = [...window.document.querySelectorAll('#view button')].find(button => /Apply selected exit|应用所选出口/.test(button.textContent));
assert(applyExit && !applyExit.disabled, 'a valid changed exit selection enables the explicit Apply action');
applyExit?.click();
await flush();
assert(commandLog.slice(beforeSelection).filter(({ sub }) => sub === 'exitnode-set').length === 1 && commandLog.some(({ sub, args }) => sub === 'exitnode-set' && args[0] === '100.64.0.2'), 'Apply changes the exit exactly once using the selected peer IP');

nav('logs');
await flush();
const beforeLogSearch = commandLog.length;
const logSearch = window.document.querySelector('#view .tool-log-controls input');
logSearch.value = 'TWO';
logSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
assert(window.document.querySelectorAll('.tool-log-line').length === 1 && window.document.querySelector('.tool-log-line')?.textContent.includes('line two'), 'log filtering is case insensitive by default');
const caseSwitch = [...window.document.querySelectorAll('#view [role="switch"]')].find(input => /Case sensitive|区分大小写/.test(input.getAttribute('aria-label') || ''));
caseSwitch?.click();
assert(window.document.querySelectorAll('.tool-log-line').length === 0, 'case sensitive search respects capitalization');
assert(commandLog.length === beforeLogSearch, 'log search does not reread the device log');
const liveSwitch = [...window.document.querySelectorAll('#view [role="switch"]')].find(input => /Auto-refresh|自动刷新/.test(input.getAttribute('aria-label') || ''));
liveSwitch?.click();
assert(liveSwitch && !liveSwitch.checked && /paused|已暂停/.test(window.document.querySelector('#view').textContent), 'auto-refresh can be paused with visible feedback');

const beforeAdvanced = commandLog.length;
nav('settings');
await flush();
assert([...window.document.querySelectorAll('#view [role="switch"]')].every(input => input.getAttribute('aria-label')?.trim()), 'every settings switch has an accessible name');
assert(!commandLog.slice(beforeAdvanced).some(({ sub }) => sub === 'context-get'), 'advanced configuration is not eagerly loaded');

console.log('[17] rejected settings and post-mutation refresh races');
const ipv6 = window.document.querySelector('[data-setting="IPV6"] input');
assert(ipv6 && !ipv6.checked, 'IPv6 starts disabled in the server snapshot');
overrides['settings-set'] = [1, JSON.stringify({ ok: false, error: 'IPv6 subnet required' }), ''];
ipv6?.click();
await flush();
assert(ipv6 && !ipv6.checked, 'a rejected switch change rolls back the native checked state');
delete overrides['settings-set'];

nav('serve');
await flush();
holdNext.add('funnel-list');
const publicCard = window.document.querySelectorAll('#view .card')[1];
[...publicCard.querySelectorAll('button')].find(button => /^(Refresh|刷新)$/.test(button.textContent))?.click();
await flush();
const staleFunnel = heldReplies.find(reply => reply.sub === 'funnel-list');
assert(staleFunnel, 'a pre-mutation service refresh is in flight');
const changedServeFixture = JSON.parse(JSON.stringify(serveFixture));
delete changedServeFixture.Web['fox.ts.net:8443'].Handlers['/api'];
canned['funnel-list'] = { ok: true, status: changedServeFixture };
const selectedPath = [...publicCard.querySelectorAll('.list-row')].find(row => row.textContent.includes('/api'));
selectedPath?.querySelector('button')?.click();
await flush();
window.document.querySelector('.md-dialog-actions .btn-filled')?.click();
await flush();
staleFunnel?.finish();
await flush();
assert(!window.document.querySelectorAll('#view .card')[1].textContent.includes('/api'), 'a stale refresh cannot resurrect a deleted service mapping');

nav('files');
await flush();
holdNext.add('files-inbox');
const inboxCard = window.document.querySelector('#view .card');
[...inboxCard.querySelectorAll('button')].find(button => /^(Refresh|刷新)$/.test(button.textContent))?.click();
await flush();
const staleInbox = heldReplies.find(reply => reply.sub === 'files-inbox');
assert(staleInbox, 'an inbox refresh is in flight before receiving');
canned['files-inbox'] = { ok: true, files: [{ name: 'new-arrival.txt', size: 20, mtime: 1700000000 }] };
canned['file-receive'] = { ok: true };
window.__foxy.startTask('file-receive', 'file-receive');
await flush();
staleInbox?.finish();
await flush();
assert(window.document.querySelector('#view').textContent.includes('new-arrival.txt'), 'receive completion queues a fresh inbox read after an older refresh');

nav('settings');
await flush();
canned.restore = { ok: true, previous: '/data/adb/foxytail/backups/before-restore', note: 'Hooks staged in /data/adb/foxytail/backups/restored-hooks' };
canned['settings-get'].restartRequired = true;
const restoreInput = window.document.querySelector('.tool-danger input');
restoreInput.value = '/sdcard/Download/backup.tar.gz';
restoreInput.dispatchEvent(new window.Event('input', { bubbles: true }));
window.document.querySelector('.tool-danger button')?.click();
await flush();
window.document.querySelector('.md-dialog-actions .btn-filled')?.click();
await flush();
assert(window.document.querySelector('[data-testid="restore-previous"]')?.textContent === canned.restore.previous, 'restore keeps the previous configuration location visible');
assert(window.document.querySelector('[data-testid="restore-note"]')?.textContent === canned.restore.note, 'restore keeps the hook staging instructions visible');

console.log('[18] exit confirmation waits for a snapshot started after the mutation');
canned.status = { ...canned.status, backend: 'Running', exitNode: null };
await window.__foxy.refreshStatus();
nav('exitnodes');
await flush();
holdNext.add('status');
const statusCount = commandLog.filter(entry => entry.sub === 'status').length;
const oldStatusRead = window.__foxy.refreshStatus();
await flush();
const staleStatus = heldReplies.find(reply => reply.sub === 'status');
assert(staleStatus, 'a status read that began before the exit change is held');
window.document.querySelector('input[name="exit-node"][value="p1"]')?.click();
const applyAfterOldRead = [...window.document.querySelectorAll('#view button')].find(button => /Apply selected exit|应用所选出口/.test(button.textContent));
applyAfterOldRead?.click();
await flush();
assert(window.document.querySelector('input[name="exit-node"]:checked')?.value === 'p1', 'the requested exit remains selected while its status is unconfirmed');
assert(commandLog.filter(entry => entry.sub === 'status').length === statusCount + 1, 'post-mutation status waits for the old read rather than launching concurrently');
const queuedA = window.__foxy.refreshStatus({ afterCurrent: true });
const queuedB = window.__foxy.refreshStatus({ afterCurrent: true });
assert(queuedA === queuedB, 'multiple post-mutation refreshes share a single queued read');
canned.status = { ...canned.status, exitNode: { ...canned.exitnodes.peers[0], rx: 0, tx: 0 } };
staleStatus?.finish();
await flush();
await Promise.all([oldStatusRead, queuedA, queuedB]);
assert(commandLog.filter(entry => entry.sub === 'status').length === statusCount + 2, 'exactly one fresh status read follows the stale response');
const confirmedExit = window.document.querySelector('input[name="exit-node"]:checked');
assert(confirmedExit?.value === 'p1' && /Current|当前/.test(confirmedExit.closest('label').textContent), 'fresh confirmation marks the selected radio as the current exit');
overrides.status = [1, JSON.stringify({ ok: false, error: 'status-unavailable' }), ''];
await window.__foxy.refreshStatus();
assert(!window.document.querySelector('.network-current-exit .network-small-badge'), 'an unavailable status is not mislabeled as a confirmed current exit');
delete overrides.status;
await window.__foxy.refreshStatus();

console.log('[19] absent interface samples and recorded zero traffic are distinct');
canned.traffic = { ok: true, hours: [{ hour: 0, samples: 0, iface: { rx: 0, tx: 0 } }], days: [], topn: [] };
nav('traffic');
await flush();
assert(!window.document.querySelector('#view svg[role="img"]') && window.document.querySelector('.network-traffic-empty'), 'missing interface samples render an empty state instead of a fabricated zero chart');
canned.traffic.hours[0].samples = 1;
nav('more');
nav('traffic');
await flush();
assert(window.document.querySelector('#view svg[role="img"]') && !window.document.querySelector('.network-traffic-empty'), 'a recorded zero sample renders the chart instead of an empty state');

console.log('[20] service and mode controls stay at the page header');
const headerToggle = window.document.querySelector('#app-header [role="switch"]');
const headerMode = window.document.querySelector('#app-header select');
assert(headerToggle && headerMode, 'service switch and mode selector are available in the persistent header');
for (const route of ROUTES) {
  nav(route);
  assert(window.document.querySelector('#app-header [role="switch"]') === headerToggle && window.document.querySelector('#app-header select') === headerMode, route + ': primary controls persist at the top');
}
await flush();
const beforeCancelControl = commandLog.length;
headerToggle?.click();
await flush();
window.document.querySelector('.md-dialog-actions button[autofocus]')?.click();
await flush();
assert(headerToggle?.checked && !commandLog.slice(beforeCancelControl).some(({ sub }) => sub === 'control'), 'cancelling Stop preserves the service switch and sends no command');
if (headerMode) {
  headerMode.value = 'bridge';
  headerMode.dispatchEvent(new window.Event('change', { bubbles: true }));
}
await flush();
window.document.querySelector('.md-dialog-actions button[autofocus]')?.click();
await flush();
assert(headerMode?.value === 'tun' && !commandLog.slice(beforeCancelControl).some(({ sub }) => sub === 'mode-set'), 'cancelling a mode change restores the canonical mode');
canned['mode-set'] = { ok: true };
holdNext.add('mode-set');
if (headerMode) {
  headerMode.value = 'bridge';
  headerMode.dispatchEvent(new window.Event('change', { bubbles: true }));
}
await flush();
window.document.querySelector('.md-dialog-actions .btn-filled')?.click();
await flush();
const modeReply = heldReplies.find(reply => reply.sub === 'mode-set');
assert(modeReply && headerMode?.disabled && headerToggle?.disabled, 'a mode change locks conflicting header controls');
nav('peers');
assert(window.document.querySelector('#app-header select') === headerMode && headerMode?.disabled, 'an in-flight header action survives page navigation');
canned.status.mode = 'bridge';
modeReply?.finish();
await flush();
assert(headerMode?.value === 'bridge' && !headerMode.disabled && !headerToggle.disabled, 'a fresh status confirms the new mode and restores controls');

console.log('[21] service controls reconcile completion, failure and unknown device state');
const runningSnapshot = { ...canned.status, daemon: 'running', backend: 'Running' };
const stoppedSnapshot = { ...runningSnapshot, daemon: 'stopped', backend: 'Stopped', self: null, exitNode: null, uptime: 0 };
const serviceFeedback = () => window.document.querySelector('.service-controls-feedback');
const serviceRetry = () => window.document.querySelector('.service-controls-retry');
async function requestStop() {
  headerToggle?.click();
  await flush();
  const approve = window.document.querySelector('.md-dialog-actions .btn-filled');
  assert(approve, 'stopping a running service requires confirmation');
  approve?.click();
  await flush();
}
function switchHasFeedback() {
  const ids = (headerToggle?.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  return ids.some(id => window.document.getElementById(id)?.textContent.trim());
}

canned.status = runningSnapshot;
await window.__foxy.refreshStatus();
holdNext.add('control');
const beforeStopReplies = heldReplies.length;
await requestStop();
const successfulStop = heldReplies.slice(beforeStopReplies).find(reply => reply.sub === 'control');
assert(successfulStop && headerToggle?.checked && headerToggle.disabled, 'Stop retains the confirmed running state while the command is in flight');
nav('traffic');
assert(window.document.querySelector('#app-header [role="switch"]') === headerToggle && headerToggle?.disabled, 'a Stop operation remains active after page navigation');
canned.status = stoppedSnapshot;
successfulStop?.finish();
await flush();
assert(headerToggle && !headerToggle.checked && !headerToggle.indeterminate && !headerToggle.disabled, 'a successful Stop displays the confirmed stopped state and unlocks the switch');
nav('dashboard');
await flush();
assert(/^(Stopped|已停止)$/.test(window.document.querySelector('.network-health h2')?.textContent.trim() || ''), 'the dashboard agrees with a confirmed stopped service');

holdNext.add('control');
const beforeStartReplies = heldReplies.length;
headerToggle?.click();
await flush();
const successfulStart = heldReplies.slice(beforeStartReplies).find(reply => reply.sub === 'control');
assert(successfulStart && !headerToggle?.checked && headerToggle?.disabled, 'Start retains the confirmed stopped state while the command is in flight');
nav('peers');
canned.status = runningSnapshot;
successfulStart?.finish();
await flush();
assert(headerToggle?.checked && !headerToggle.indeterminate && !headerToggle.disabled, 'a successful Start displays the confirmed running state after navigation');

// Model an immediate timeout result from the bridge, avoiding a real 30s wait.
// The daemon may have stopped before that response was lost, so only a fresh
// status read determines which state the switch can truthfully display.
overrides.control = [1, JSON.stringify({ ok: false, error: 'timed out waiting for control stop' }), ''];
canned.status = stoppedSnapshot;
const beforeTimedOutStop = commandLog.length;
await requestStop();
const timedOutStopCalls = commandLog.slice(beforeTimedOutStop);
const stopCallIndex = timedOutStopCalls.findIndex(entry => entry.sub === 'control' && entry.args[0] === 'stop');
assert(stopCallIndex >= 0 && timedOutStopCalls.slice(stopCallIndex + 1).some(entry => entry.sub === 'status'), 'a timed-out Stop always verifies state using a read after the command');
assert(headerToggle && !headerToggle.checked && !headerToggle.indeterminate && !headerToggle.disabled, 'a timed-out response with confirmed stopped state does not leave the service running or locked in the UI');
assert(/confirmed stopped|已确认服务停止/i.test(serviceFeedback()?.textContent || ''), 'a lost Stop response still reports that the observed service is stopped');

canned.status = runningSnapshot;
await window.__foxy.refreshStatus();
await requestStop();
assert(headerToggle?.checked && !headerToggle.indeterminate && !headerToggle.disabled, 'a failed Stop with a running snapshot rolls back the native switch and allows recovery');
assert(serviceFeedback()?.textContent.trim() && serviceRetry() && !serviceRetry().disabled, 'a failed Stop keeps actionable feedback beside the switch');
assert(/currently running|当前服务仍在运行/i.test(serviceFeedback()?.textContent || ''), 'failed Stop feedback identifies the observed running state');
assert(switchHasFeedback(), 'the service switch describes its persistent failure feedback accessibly');
const failedStopFeedback = serviceFeedback()?.textContent;
nav('dashboard');
await flush();
assert(failedStopFeedback?.trim() && serviceFeedback()?.textContent === failedStopFeedback && headerToggle?.checked, 'failed Stop feedback and actual running state survive page navigation');

overrides.status = [1, JSON.stringify({ ok: false, error: 'status-unavailable-after-stop' }), ''];
await requestStop();
assert(headerToggle?.indeterminate && headerToggle.disabled, 'a failed state read marks the switch indeterminate and prevents an uninformed service mutation');
assert(serviceFeedback()?.textContent.trim() && switchHasFeedback() && serviceRetry(), 'an unknown service state has accessible feedback and a recovery action');
assert(/state is unconfirmed|服务状态待确认/i.test(serviceFeedback()?.textContent || ''), 'a failed verification reports uncertainty instead of repeating the earlier running state');
assert(!/^(Stopped|已停止)$/.test(window.document.querySelector('.network-health h2')?.textContent.trim() || ''), 'a failed state read is not presented as a stopped service on the dashboard');
delete overrides.status;
canned.status = stoppedSnapshot;
serviceRetry()?.click();
await flush();
assert(headerToggle && !headerToggle.checked && !headerToggle.indeterminate && !headerToggle.disabled, 'retrying the status read replaces uncertainty with the confirmed stopped state');

for (const daemon of ['unknown', 'stopped']) {
  canned.status = { ...stoppedSnapshot, daemon, backend: 'unreachable' };
  await window.__foxy.refreshStatus();
  assert(headerToggle?.indeterminate && headerToggle.disabled, daemon + '/unreachable status is visibly uncertain and cannot be toggled');
  assert(!/^(Stopped|已停止)$/.test(window.document.querySelector('.network-health h2')?.textContent.trim() || ''), daemon + '/unreachable status never reports a confirmed stopped service');
}
delete overrides.control;
canned.status = { ...runningSnapshot, backend: 'unreachable' };
await window.__foxy.refreshStatus();
const serviceRestart = window.document.querySelector('[data-testid="service-restart"] button');
assert(headerToggle?.checked && !headerToggle.indeterminate && !headerToggle.disabled && serviceRestart && !serviceRestart.disabled, 'a confirmed live daemon remains stoppable and restartable when its connection status is unreachable');
assert(!/^(Stopped|已停止)$/.test(window.document.querySelector('.network-health h2')?.textContent.trim() || '') && !window.document.querySelector('.network-health.is-connected'), 'an unreachable connection is neither stopped nor connected on the dashboard');
canned.status = stoppedSnapshot;
await requestStop();
assert(headerToggle && !headerToggle.checked && !headerToggle.indeterminate && !headerToggle.disabled, 'a live daemon with an unreachable connection can be stopped and confirmed');
canned.status = runningSnapshot;
await window.__foxy.refreshStatus();
assert(headerToggle?.checked && !headerToggle.indeterminate && !headerToggle.disabled, 'a later healthy snapshot clears uncertainty and restores service controls');

console.log('[22] advertised subnet routes and local policy drafts remain independent');
const subnetControls = () => window.document.querySelector('[data-testid="subnet-routes-controls"]');
const acceptSubnetSwitch = () => subnetControls()?.querySelector('[role="switch"]');
const refreshSubnetButton = () => [...(subnetControls()?.querySelectorAll('button') || [])].find(button => /Refresh subnet routes|刷新节点路由/.test(button.getAttribute('aria-label') || ''));
const advertisedSubnet = (cidr) => window.document.querySelector('[data-route-cidr="' + cidr + '"]');
const customSubnets = () => [...window.document.querySelectorAll('[data-custom-cidr]')].map(row => row.getAttribute('data-custom-cidr'));
const routeWrites = (since) => commandLog.slice(since).filter(entry => ['subnet-routes-set', 'routes-set', 'settings-set', 'control', 'mode-set'].includes(entry.sub));
async function addCustomSubnet(value) {
  const input = window.document.querySelector('#custom-route-cidr');
  assert(input, 'custom subnet input is available');
  if (input) {
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  window.document.querySelector('[data-testid="route-add-subnet"] button[type="submit"]')?.click();
  await flush();
}
async function changeSubnetAcceptance(approve = true) {
  acceptSubnetSwitch()?.click();
  await flush();
  const confirmation = window.document.querySelector('.md-dialog-actions ' + (approve ? '.btn-filled' : 'button[autofocus]'));
  assert(confirmation, 'changing accepted subnet routes requires confirmation');
  confirmation?.click();
  await flush();
}
const advertisedFixture = {
  ok: true, acceptRoutes: false, mode: 'bridge', ipv6Enabled: true,
  peers: [
    { id: 'router-1', hostname: 'office-router', online: true, routes: [{ cidr: '192.168.44.0/24', primary: true }] },
    { id: 'router-2', hostname: 'backup-router', online: false, routes: [{ cidr: '2001:db8:40::/64', primary: false }] },
  ],
};
canned['subnet-routes-get'] = advertisedFixture;
nav('more');
await flush();
holdNext.add('subnet-routes-get');
const subnetInitialReplyIndex = heldReplies.length;
nav('routing');
await flush();
const initialSubnetReply = heldReplies.slice(subnetInitialReplyIndex).find(reply => reply.sub === 'subnet-routes-get');
assert(initialSubnetReply && acceptSubnetSwitch()?.disabled, 'loading subnet preferences prevents a concurrent preference mutation');
assert(window.document.querySelector('#view .skeleton') || window.document.querySelector('[data-route-peer]'), 'loading advertisements retain cached nodes or show a placeholder');
initialSubnetReply?.finish();
await flush();
assert(acceptSubnetSwitch() && !acceptSubnetSwitch().checked && !acceptSubnetSwitch().indeterminate && !acceptSubnetSwitch().disabled, 'the receive switch reflects the confirmed disabled Tailscale preference');
assert(window.document.querySelector('[data-route-peer="router-1"]')?.textContent.includes('office-router') && advertisedSubnet('192.168.44.0/24'), 'online node advertisements display their associated CIDR');
assert(window.document.querySelector('[data-route-peer="router-2"]')?.textContent.includes('backup-router') && advertisedSubnet('2001:db8:40::/64'), 'an offline node retains its advertised IPv6 route');

const beforeSubnetDraft = commandLog.length;
await addCustomSubnet('192.168.50.129/24');
assert(customSubnets().includes('192.168.50.0/24') && !customSubnets().includes('192.168.50.129/24'), 'a custom IPv4 CIDR is normalized to its network address');
await addCustomSubnet('192.168.50.254/24');
assert(customSubnets().filter(cidr => cidr === '192.168.50.0/24').length === 1 && window.document.querySelector('#view [role="alert"]'), 'equivalent IPv4 host addresses cannot create duplicate local routes');
await addCustomSubnet('2001:0DB8:0:1::1234/64');
assert(customSubnets().includes('2001:db8:0:1::/64'), 'a custom IPv6 CIDR is compressed, lowercased and masked');
await addCustomSubnet('2001:db8:0:1:ffff::/64');
assert(customSubnets().filter(cidr => cidr === '2001:db8:0:1::/64').length === 1, 'equivalent IPv6 representations cannot create duplicate local routes');
await addCustomSubnet('::ffff:192.0.2.129/120');
assert(customSubnets().includes('::ffff:c000:200/120'), 'an IPv4-embedded IPv6 CIDR is normalized to the same network form as the backend');
await addCustomSubnet('0:0:0:0:0:ffff:c000:2ff/120');
assert(customSubnets().filter(cidr => cidr === '::ffff:c000:200/120').length === 1, 'embedded and hexadecimal IPv6 forms identify one network instead of duplicate routes');
const customCountBeforeInvalid = customSubnets().length;
await addCustomSubnet('256.1.1.1/24');
await addCustomSubnet('2001:db8::/129');
await addCustomSubnet('::ffff:256.0.2.1/120');
assert(customSubnets().length === customCountBeforeInvalid && window.document.querySelector('#view [role="alert"]'), 'invalid IPv4 addresses and IPv6 prefixes leave the draft untouched');
advertisedSubnet('192.168.44.0/24')?.querySelector('button')?.click();
await flush();
assert(customSubnets().includes('192.168.44.0/24') && advertisedSubnet('192.168.44.0/24')?.querySelector('button')?.disabled, 'selecting an advertised route adds it once to the local draft');
assert(routeWrites(beforeSubnetDraft).length === 0 && !acceptSubnetSwitch()?.checked, 'editing and importing CIDRs does not save local rules or enable route reception');

const draftBeforeAnnouncementRefresh = customSubnets();
const unfinishedCidr = window.document.querySelector('#custom-route-cidr');
if (unfinishedCidr) {
  unfinishedCidr.value = '10.123.45.7/16';
  unfinishedCidr.dispatchEvent(new window.Event('input', { bubbles: true }));
}
canned['subnet-routes-get'] = { ...advertisedFixture, peers: [...advertisedFixture.peers, { id: 'router-3', hostname: 'new-router', online: true, routes: [{ cidr: '172.16.32.0/20', primary: true }] }] };
const beforeAnnouncementRefresh = commandLog.length;
assert(refreshSubnetButton(), 'subnet advertisements have a named refresh action');
refreshSubnetButton()?.click();
await flush();
assert(advertisedSubnet('172.16.32.0/20'), 'refreshing advertisements displays new node routes');
assert(JSON.stringify(customSubnets()) === JSON.stringify(draftBeforeAnnouncementRefresh) && window.document.querySelector('#custom-route-cidr')?.value === '10.123.45.7/16', 'refreshing node advertisements preserves unsaved rules and unfinished input');
assert(commandLog.slice(beforeAnnouncementRefresh).filter(entry => entry.sub === 'subnet-routes-get').length === 1 && !commandLog.slice(beforeAnnouncementRefresh).some(entry => entry.sub === 'routes-get'), 'advertisement refresh does not reload the local policy draft');

const beforeCancelledSubnetChange = commandLog.length;
await changeSubnetAcceptance(false);
assert(!acceptSubnetSwitch()?.checked && routeWrites(beforeCancelledSubnetChange).length === 0, 'cancelling route reception leaves its preference unchanged and sends no mutation');
canned['subnet-routes-set'] = { ok: true, acceptRoutes: true, applied: true };
holdNext.add('subnet-routes-set');
const beforeAcceptReplyIndex = heldReplies.length;
const beforeAcceptWrite = commandLog.length;
await changeSubnetAcceptance();
const acceptReply = heldReplies.slice(beforeAcceptReplyIndex).find(reply => reply.sub === 'subnet-routes-set');
assert(acceptReply && acceptSubnetSwitch()?.disabled && window.__foxy.getTask('subnet-routes')?.status === 'running', 'an accepted preference change remains busy until its backend result arrives');
nav('traffic');
await flush();
assert(window.__foxy.getTask('subnet-routes')?.status === 'running', 'changing route reception survives navigation away');
nav('routing');
await flush();
assert(acceptSubnetSwitch()?.disabled, 'the routing page adopts an in-flight reception change after navigation');
canned['subnet-routes-get'] = { ...canned['subnet-routes-get'], acceptRoutes: true };
acceptReply?.finish();
await flush();
assert(acceptSubnetSwitch()?.checked && !acceptSubnetSwitch()?.indeterminate && !acceptSubnetSwitch()?.disabled, 'the backend-confirmed enabled preference is shown after completion');
assert(JSON.stringify(routeWrites(beforeAcceptWrite).map(entry => [entry.sub, entry.args])) === JSON.stringify([['subnet-routes-set', ['on']]]), 'enabling reception sends only subnet-routes-set on, without changing local routes or other settings');

overrides['subnet-routes-set'] = [1, JSON.stringify({ ok: false, error: 'subnet-preference-rejected' }), ''];
const beforeRejectedSubnetWrite = commandLog.length;
await changeSubnetAcceptance();
assert(acceptSubnetSwitch()?.checked && !acceptSubnetSwitch()?.disabled, 'a rejected preference change rolls the native switch back to the confirmed enabled value');
assert(window.document.body.textContent.includes('subnet-preference-rejected'), 'a failed subnet preference write exposes the backend reason');
assert(JSON.stringify(routeWrites(beforeRejectedSubnetWrite).map(entry => [entry.sub, entry.args])) === JSON.stringify([['subnet-routes-set', ['off']]]), 'a failed disable attempt still sends only the explicitly requested preference command');
delete overrides['subnet-routes-set'];
canned['subnet-routes-set'] = { ok: true, acceptRoutes: false, applied: true };
canned['subnet-routes-get'] = { ...canned['subnet-routes-get'], acceptRoutes: false };
await changeSubnetAcceptance();
assert(!acceptSubnetSwitch()?.checked && !acceptSubnetSwitch()?.indeterminate && !acceptSubnetSwitch()?.disabled, 'a confirmed disable operation updates the receive switch');

for (const observedAfterFailure of [false, null]) {
  const requestedAcceptance = !acceptSubnetSwitch()?.checked;
  canned['subnet-routes-get'] = { ...canned['subnet-routes-get'], acceptRoutes: observedAfterFailure };
  overrides['subnet-routes-set'] = [1, JSON.stringify({ ok: false, error: 'subnet-write-response-lost' }), ''];
  await changeSubnetAcceptance();
  assert(subnetControls()?.querySelector('.subnet-route-feedback')?.textContent.trim(), 'a failed subnet change retains feedback until its target state is observed');
  delete overrides['subnet-routes-set'];
  canned['subnet-routes-get'] = { ...canned['subnet-routes-get'], acceptRoutes: requestedAcceptance };
  const beforeReconciledSubnetRefresh = commandLog.length;
  refreshSubnetButton()?.click();
  await flush();
  assert(acceptSubnetSwitch()?.checked === requestedAcceptance && !acceptSubnetSwitch()?.indeterminate && !acceptSubnetSwitch()?.disabled, 'a manual refresh confirms the requested preference after an earlier failed change');
  assert(!subnetControls()?.querySelector('.subnet-route-feedback')?.textContent.trim(), 'a fresh matching snapshot clears obsolete mismatch or unconfirmed feedback');
  assert(routeWrites(beforeReconciledSubnetRefresh).length === 0, 'clearing stale preference feedback uses a read without repeating the mutation');
}

canned['subnet-routes-get'] = { ...advertisedFixture, acceptRoutes: null };
refreshSubnetButton()?.click();
await flush();
assert(acceptSubnetSwitch()?.indeterminate && acceptSubnetSwitch()?.disabled, 'a null backend preference is shown as unknown, not as disabled');
overrides['subnet-routes-get'] = [1, JSON.stringify({ ok: false, error: 'subnet-read-unavailable' }), ''];
refreshSubnetButton()?.click();
await flush();
assert(acceptSubnetSwitch()?.indeterminate && acceptSubnetSwitch()?.disabled && window.document.querySelector('#view')?.textContent.includes('subnet-read-unavailable'), 'a failed advertisement read has an explicit error and keeps the receive state unknown');
delete overrides['subnet-routes-get'];
canned['subnet-routes-get'] = { ...advertisedFixture, peers: [] };
refreshSubnetButton()?.click();
await flush();
assert(!window.document.querySelector('[data-route-peer]') && window.document.querySelector('#view .state-box') && !window.document.querySelector('#view .skeleton'), 'an empty advertisement result renders an empty state without stale peers or loading skeletons');
assert(!acceptSubnetSwitch()?.indeterminate && !acceptSubnetSwitch()?.disabled, 'a successful refresh recovers the known route reception state');
canned['subnet-routes-get'] = { ...advertisedFixture, ipv6Enabled: false };
refreshSubnetButton()?.click();
await flush();
assert(advertisedSubnet('2001:db8:40::/64')?.querySelector('button')?.disabled && !acceptSubnetSwitch()?.disabled, 'disabled local IPv6 routing blocks IPv6 import without disabling Tailscale route reception');
await addCustomSubnet('2001:db8:88::abcd/64');
assert(customSubnets().includes('2001:db8:88::/64'), 'a custom IPv6 destination can still be prepared while IPv6 routing is disabled');
const pendingIpv6 = customSubnets().filter(cidr => cidr.includes(':'));
canned['routes-set'] = {
  ok: true, saved: true, applied: false, restartRequired: true,
  note: 'saved; IPv4 routing applied; IPv6 destinations are not applied while IPv6 is disabled',
  subnets: customSubnets(), ipv6Skipped: pendingIpv6, requiresIpv6: true,
};
const beforeIpv6DraftSave = commandLog.length;
window.document.querySelector('#view .tool-sticky-actions button')?.click();
await flush();
const ipv6SkippedNotice = window.document.querySelector('[data-testid="route-ipv6-skipped"]');
assert(ipv6SkippedNotice?.textContent.includes('IPv6') && pendingIpv6.every(cidr => ipv6SkippedNotice?.textContent.includes(cidr)) && ipv6SkippedNotice?.querySelector('a[href="#/settings"]'), 'saving a draft lists its unapplied IPv6 networks and provides the required settings action');
assert(window.document.querySelector('#view .tool-sticky-actions .status-badge.tone-warning') && !window.document.querySelector('#view .tool-sticky-actions .status-badge.tone-success'), 'saved IPv6 destinations are visibly pending instead of falsely reported as fully applied');
assert(routeWrites(beforeIpv6DraftSave).length === 1 && routeWrites(beforeIpv6DraftSave)[0]?.sub === 'routes-set' && !acceptSubnetSwitch()?.checked, 'saving local IPv6 destinations writes only local policy and does not enable Tailscale route reception');
canned['routes-get'] = { ...canned['routes-get'], subnets: [...customSubnets()] };
nav('more');
nav('routing');
await flush();
const restoredIpv6Notice = window.document.querySelector('[data-testid="route-ipv6-skipped"]');
assert(restoredIpv6Notice?.textContent.includes('IPv6') && pendingIpv6.every(cidr => restoredIpv6Notice?.textContent.includes(cidr)) && window.document.querySelector('#view .tool-sticky-actions .status-badge.tone-warning'), 'returning to saved IPv6 rules derives their pending enablement state from fresh configuration');
await addCustomSubnet('10.240.12.99/24');
canned['routes-set'] = { ...canned['routes-set'], subnets: customSubnets(), applyError: 'routing reload failed for mocked interface' };
window.document.querySelector('#view .tool-sticky-actions button')?.click();
await flush();
assert(window.document.querySelector('#view')?.textContent.includes('routing reload failed for mocked interface'), 'an IPv6 limitation does not hide the actual routing application failure reason');
assert(window.document.querySelector('[data-testid="route-ipv6-skipped"]') && window.document.querySelector('#view .tool-sticky-actions .status-badge.tone-warning'), 'a saved draft with an application failure retains both IPv6 enablement details and pending state');

console.log('[23] Funnel listener capabilities remain distinct from the local target protocol');
nav('serve');
await flush();
const mappingForm = () => window.document.querySelector('[data-testid="serve-add-form"]');
const mappingField = id => window.document.getElementById(id);
const mappingSubmit = () => mappingForm()?.querySelector('button.btn-filled');
const mappingWrites = since => commandLog.slice(since).filter(entry => entry.sub === 'serve-set' || entry.sub === 'funnel-set');
function editMappingField(id, value) {
  const field = mappingField(id);
  assert(field, 'mapping form field ' + id + ' is available');
  if (!field) return;
  field.value = value;
  field.dispatchEvent(new window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}
async function submitMapping() {
  mappingSubmit()?.click();
  await flush();
}
assert(mappingForm() && mappingField('serve-protocol')?.querySelector('option[value="http"]'), 'Serve exposes an HTTP listener independently from Funnel');
editMappingField('serve-protocol', 'http');
editMappingField('serve-port', '8080');
editMappingField('serve-target', 'http://localhost:3000');
const beforeFunnelDraft = commandLog.length;
editMappingField('serve-kind', 'funnel');
assert(mappingField('serve-protocol')?.value === 'https' && mappingField('serve-port')?.value === '443' && mappingField('serve-target')?.value === 'http://localhost:3000', 'switching an HTTP Serve draft to Funnel selects HTTPS and an allowed public port while preserving its HTTP target');
assert(JSON.stringify([...mappingField('serve-protocol').options].map(option => option.value).sort()) === JSON.stringify(['https', 'tcp', 'tls-terminated-tcp'].sort()), 'Funnel offers HTTPS, TCP and TLS-terminated TCP without an unsupported HTTP listener');
assert(mappingField('serve-port')?.tagName === 'SELECT' && JSON.stringify([...mappingField('serve-port').options].map(option => option.value).filter(Boolean).sort()) === JSON.stringify(['443', '8443', '10000'].sort()), 'Funnel offers only its three supported public ports');
assert(mappingWrites(beforeFunnelDraft).length === 0, 'normalizing an incompatible draft does not create a public listener');
editMappingField('serve-port', '8080');
await submitMapping();
assert(mappingWrites(beforeFunnelDraft).length === 0, 'an unsupported Funnel port cannot submit a listener command');
editMappingField('serve-port', '443');
const publicHttpTargetFixture = {
  TCP: { '443': { HTTPS: true } },
  Web: { 'fox.ts.net:443': { Handlers: { '/': { Proxy: 'http://localhost:3000' } } } },
  AllowFunnel: { 'fox.ts.net:443': true },
};
canned['serve-list'] = { ok: true, status: publicHttpTargetFixture };
canned['funnel-list'] = { ok: true, status: publicHttpTargetFixture };
const beforePublicMapping = commandLog.length;
await submitMapping();
assert(JSON.stringify(mappingWrites(beforePublicMapping).map(entry => [entry.sub, entry.args])) === JSON.stringify([['funnel-set', ['https', '443', 'http://localhost:3000']]]), 'an HTTP local target is submitted with an HTTPS public Funnel listener');
const publicHttpTargetRow = window.document.querySelectorAll('#view .card')[1]?.querySelector('.list-row');
assert(publicHttpTargetRow?.textContent.includes('https fox.ts.net:443') && publicHttpTargetRow?.textContent.includes('http://localhost:3000'), 'the refreshed public mapping displays HTTPS separately from its HTTP local target');

editMappingField('serve-kind', 'serve');
assert(mappingField('serve-protocol')?.querySelector('option[value="http"]') && mappingField('serve-port')?.tagName === 'INPUT', 'returning to Serve restores HTTP and arbitrary valid listener ports');
editMappingField('serve-protocol', 'http');
editMappingField('serve-port', '8080');
editMappingField('serve-target', 'http://localhost:8081');
const beforePrivateHttpMapping = commandLog.length;
await submitMapping();
assert(JSON.stringify(mappingWrites(beforePrivateHttpMapping).map(entry => [entry.sub, entry.args])) === JSON.stringify([['serve-set', ['http', '8080', 'http://localhost:8081']]]), 'Serve HTTP remains HTTP instead of inheriting Funnel HTTPS restrictions');
editMappingField('serve-protocol', 'tls-terminated-tcp');
editMappingField('serve-port', '8443');
editMappingField('serve-target', 'localhost:3000');
const beforeCompatibleFunnelDraft = commandLog.length;
editMappingField('serve-kind', 'funnel');
assert(mappingField('serve-protocol')?.value === 'tls-terminated-tcp' && mappingField('serve-port')?.value === '8443' && mappingField('serve-target')?.value === 'localhost:3000', 'a compatible TLS-terminated TCP draft retains its protocol, allowed port and target when switching to Funnel');
assert(mappingWrites(beforeCompatibleFunnelDraft).length === 0, 'switching a compatible draft also requires an explicit submit to publish');

for (const variant of ['kernelsu-spawn', 'legacy-exec']) {
  const isolated = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
    url: 'https://foxytail.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = isolated.window;
  stubDom(w);
  let calls = 0;
  if (variant === 'kernelsu-spawn') {
    w.kernelsu = { spawn(cmd, args, options, name) {
      calls++;
      w.setTimeout(() => {
        w[name].stdout.emit('data', JSON.stringify(canned.status));
        w[name].emit('exit', 0);
      }, 0);
    } };
  } else {
    w.ksu = { exec(cmd, options, name) {
      calls++;
      w.setTimeout(() => w[name](0, JSON.stringify(canned.status), ''), 0);
    } };
  }
  w.eval(bundle);
  await flush();
  assert(calls > 0 && !w.document.querySelector('.root-banner'), variant + ' bridge remains supported');
  isolated.window.close();
}

if (failures.length) {
  console.error('\nSMOKE FAILURES:');
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('\nSMOKE OK');
process.exit(0);
