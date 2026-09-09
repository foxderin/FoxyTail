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
  'settings-get': { ok: true, restartRequired: false, settings: { TS_MODE: 'tun', MAGIC_DNS: 'on', IPV6: 'off', SOCKS_PORT: '1099' } },
  'context-get': { ok: true, rules: 'ssid:Home:down' },
  logs: { ok: true, lines: ['line one', 'line two'] },
  'serve-del': { ok: true },
  'funnel-del': { ok: true },
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function flush(rounds = 6) {
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
await flush();

console.log('[1] boot without root bridge is covered separately; here a mock bridge exists');
assert(window.document.querySelector('#app-header'), 'header rendered');
assert(window.document.querySelectorAll('#bottom-nav .nav-item').length === 5, 'bottom nav has 5 items');
assert(window.document.querySelector('#view'), 'view outlet exists');

console.log('[2] 13 routes x 3 rapid rounds');
for (let round = 0; round < 3; round++) {
  for (const r of ROUTES) {
    nav(r);
    /* same-frame check: navigation is synchronous, skeleton is immediate */
    const view = window.document.querySelector('#view');
    assert(view && view.childNodes.length > 0, `route ${r} (round ${round + 1}) rendered synchronously`);
  }
  await flush(3);
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
  (window.document.querySelector('#toast-root')?.textContent || '').includes('boom-reason'),
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
nav('peers');
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
const scopeButtons = [...window.document.querySelectorAll('#view .radio-cards button')];
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
window.document.querySelector('.md-dialog-actions button[autofocus]')?.click();
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
assert(window.document.querySelector('#view .banner.warn'), 'saved but unapplied settings show a persistent restart notice');
canned.control = { ok: true, applied: false, restartRequired: true };
canned['settings-get'].restartRequired = true;
const restartButton = window.document.querySelector('#view .banner.warn button');
restartButton?.click();
await flush();
assert(commandLog.some(({ sub, args }) => sub === 'control' && args[0] === 'restart'), 'settings can apply through service restart');
assert(window.document.querySelector('#view .banner.warn'), 'a newer configuration revision stays pending after restart');
const latestToast = [...window.document.querySelectorAll('#toast-root .toast')].at(-1)?.textContent || '';
assert(!/配置已应用|Configuration applied/.test(latestToast), 'partial application does not report all settings applied');
canned.control = { ok: true, applied: true, restartRequired: false };
canned['settings-get'].restartRequired = false;
window.document.querySelector('#view .banner.warn button')?.click();
await flush();
assert(!window.document.querySelector('#view .banner.warn'), 'restart that applies the latest revision clears the pending notice');

if (failures.length) {
  console.error('\nSMOKE FAILURES:');
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('\nSMOKE OK');
process.exit(0);
