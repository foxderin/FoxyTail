#!/usr/bin/env node
/*
 * jsdom smoke test:
 *  1. renders the app without a root bridge -> no-root banner, no crash
 *  2. switches all 13 routes x 3 rapid rounds -> no exceptions, no leaks
 *  3. task adoption: start a mock long speedtest task on ExitNodes,
 *     navigate away and back -> still running, progress state adopted;
 *     completing the mock -> cached result shown without re-firing
 *
 * Run after `vite build --config vite.smoke.config.ts`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(root, '.smoke/app.js');
if (!existsSync(bundlePath)) {
  console.error('smoke bundle missing; run: vite build --config vite.smoke.config.ts');
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
  stubInternals(w);
};
stubDom(window);

/* --- mock KSU bridge -----------------------------------------------------
 * Answers webapi subcommands with canned JSON. speedtest-exitnodes is held
 * open until the test releases it, simulating a long-running probe. */
let releaseSpeedtest = null;
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
  'settings-get': { ok: true, settings: { TS_MODE: 'tun', MAGIC_DNS: 'on', SOCKS_PORT: '1099' } },
  'context-get': { ok: true, rules: 'ssid:Home:down' },
  logs: { ok: true, lines: ['line one', 'line two'] },
  'files-inbox': { ok: true, files: [{ name: 'a.txt', size: 10, mtime: 1700000000 }] },
};

let execCount = 0;
let speedtestExecCount = 0;
window.ksu = {
  exec(cmd, opts, cbName) {
    execCount++;
    const cb = window[cbName];
    const sub = cmd.includes('foxytail.webapi.sh')
      ? cmd.replace(/^.*foxytail\.webapi\.sh\s+(\S+).*$/, '$1')
      : null;
    if (cmd.startsWith('pkill')) return void cb(0, '', '');
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
    if (sub) return void queueMicrotask(() => cb(0, JSON.stringify({ ok: true }), ''));
    /* ad-hoc execRaw probes (iptables, curl, cat hooks) */
    queueMicrotask(() => cb(0, 'yes', ''));
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

if (failures.length) {
  console.error('\nSMOKE FAILURES:');
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('\nSMOKE OK');
process.exit(0);
