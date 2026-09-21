import { fileURLToPath } from 'node:url';
import { bundle, canned, JSDOM, vc, stubDom, flush, assert, failures } from './smoke-fixture.mjs';

export async function checkPower() {
  console.log('visible polling budgets, suspended timers and idle trials');
  const dom = new JSDOM('<div id="app"></div>', {
    url: 'https://foxytail.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  stubDom(w);
  const fixtures = structuredClone(canned);
  fixtures.status = { ...fixtures.status, daemon: 'running', backend: 'Running', powerSave: false, autoRefresh: true };
  fixtures['trial-status'] = { ok: true, trial: null };
  fixtures['settings-get'] = { ok: true, restartRequired: false, settings: {
    ...fixtures['settings-get'].settings, POWER_SAVE: 'off', WATCHDOG: 'on', WATCHDOG_PROBE: 'on',
    STATS: 'on', CONTEXT: 'on', WEBUI_AUTO_REFRESH: 'on',
  } };
  const calls = [], writes = [];
  const timers = new Map();
  let now = Date.now(), nextId = 0, hidden = false, intervals = 0, finishProbe;
  w.Date.now = () => now;
  Object.defineProperty(w.document, 'hidden', { get: () => hidden });
  Object.defineProperty(w.document, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' });
  const nativeTimeout = w.setTimeout.bind(w), nativeClear = w.clearTimeout.bind(w);
  const nativeInterval = w.setInterval.bind(w);
  // Advance long timers deterministically; keep the native frame/microtask
  // path so real root-bridge cancellation and completion ordering still run.
  w.setTimeout = (run, delay = 0, ...args) => {
    if (delay < 1000) return nativeTimeout(run, delay, ...args);
    const id = --nextId;
    timers.set(id, { at: now + delay, delay, run: () => run(...args) });
    return id;
  };
  w.clearTimeout = id => { if (!timers.delete(id)) nativeClear(id); };
  w.setInterval = (...args) => { intervals++; return nativeInterval(...args); };
  w.ksu = { exec(cmd, _options, callbackName) {
    const [, sub, ...args] = [...cmd.matchAll(/'([^']*)'/g)].map(match => match[1]);
    calls.push(sub);
    if (sub === 'settings-set') {
      writes.push(args);
      fixtures['settings-get'].settings[args[0]] = args[1];
      fixtures['settings-get'].restartRequired = true;
    }
    const reply = result => w[callbackName](0, JSON.stringify(result), '');
    if (sub === 'peer-ping') finishProbe = () => reply({ ok: true });
    else queueMicrotask(() => reply(fixtures[sub] ?? { ok: true }));
  } };
  const count = sub => calls.filter(value => value === sub).length;
  const nav = async route => {
    w.location.hash = '#/' + route;
    w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    await flush();
  };
  const visible = async value => {
    hidden = !value;
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    await flush();
  };
  const advance = async duration => {
    const end = now + duration;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].run();
      await flush();
    }
    now = end;
    await flush();
  };
  const budget = async (route, sub, expected) => {
    await nav(route);
    const before = count(sub);
    await advance(60000);
    const actual = count(sub) - before;
    assert(actual === expected, `${route}: 60s makes ${expected} ${sub} polls, got ${actual}`);
    return actual;
  };
  try {
    w.eval(bundle);
    await flush();
    const measurements = {};
    measurements.status = await budget('dashboard', 'status', 4);
    measurements.peers = await budget('peers', 'peers', 4);
    const beforeHide = calls.length;
    await visible(false);
    assert(timers.size === 0, 'hidden status and peer views release every timer');
    await advance(60000);
    assert(calls.length === beforeHide && timers.size === 0, 'a hidden minute performs no reads and schedules no wakeups');
    const beforeResume = { status: count('status'), peers: count('peers') };
    await visible(true);
    assert(count('status') === beforeResume.status + 1 && count('peers') === beforeResume.peers + 1, 'visible views immediately refresh once without a catch-up burst');
    measurements.tun = await budget('tunnel', 'tun', 4);
    measurements.logs = await budget('logs', 'logs', 12);
    const live = w.document.querySelector('.tool-toggle-list input');
    live.checked = false; live.dispatchEvent(new w.Event('change', { bubbles: true }));
    const beforePause = count('logs');
    await advance(60000);
    assert(count('logs') === beforePause && timers.size === 1, 'paused logs retain only the shared status timer');
    [...w.document.querySelectorAll('#view button')].find(button => /^(Refresh|刷新)$/.test(button.textContent))?.click();
    await flush();
    assert(count('logs') === beforePause + 1, 'explicit log refresh still works while live mode is paused');
    await visible(false);
    const probe = w.__foxy.startTask('power-probe', 'peer-ping', 'p1', '100.64.0.2');
    await flush();
    finishProbe(); await probe.promise; await flush();
    assert(w.__foxy.getTask('power-probe')?.status === 'done' && timers.size === 0, 'explicit task completion is retained while view polling stays suspended');
    const beforeExplicit = count('status');
    const statusRead = w.__foxy.refreshStatus();
    await flush(); await statusRead;
    assert(count('status') === beforeExplicit + 1 && timers.size === 0, 'explicit status refresh works while hidden without restarting polling');
    await visible(true);
    assert(count('logs') === beforePause + 1, 'resuming the app does not resume paused live logs');
    await nav('settings');
    const idleTrialReads = count('trial-status');
    await advance(60000);
    assert(count('trial-status') === idleTrialReads && timers.size === 1, 'an idle trial has no polling or countdown timer');
    const toggle = key => w.document.querySelector(`[data-setting="${key}"] input`);
    for (const [key, enabled] of [['WATCHDOG', false], ['WATCHDOG_PROBE', false], ['STATS', false], ['CONTEXT', false], ['WEBUI_AUTO_REFRESH', false], ['POWER_SAVE', true]]) {
      const field = toggle(key);
      field.checked = enabled; field.dispatchEvent(new w.Event('change', { bubbles: true }));
      await flush();
      assert(writes.at(-1)?.join('|') === `${key}|${enabled ? 'on' : 'off'}`, `${key} uses the existing saved-setting contract`);
    }
    assert(writes.length === 6 && ['WATCHDOG', 'WATCHDOG_PROBE', 'STATS', 'CONTEXT', 'WEBUI_AUTO_REFRESH'].every(key => !toggle(key).checked), 'power saving never rewrites independent disabled preferences');
    assert(w.document.querySelector('.tool-pending') && !w.document.querySelector('[data-testid="power-probe-paused"]'), 'saved power preferences remain pending without claiming applied probe suspension');
    const beforePending = count('status');
    await advance(60000);
    assert(count('status') === beforePending + 4, 'pending power settings do not alter the current polling policy');
    fixtures.status = { ...fixtures.status, powerSave: true };
    const applyPower = w.__foxy.refreshStatus(); await flush(); await applyPower;
    assert(w.document.querySelector('[data-testid="power-probe-paused"]') && !toggle('WATCHDOG_PROBE').checked, 'applied power saving explains probe suspension while retaining its saved off switch');
    const saving = {};
    saving.status = await budget('dashboard', 'status', 2);
    saving.peers = await budget('peers', 'peers', 2);
    saving.tun = await budget('tunnel', 'tun', 2);
    saving.logs = await budget('logs', 'logs', 2);
    fixtures.status = { ...fixtures.status, autoRefresh: false };
    const disableRefresh = w.__foxy.refreshStatus(); await flush(); await disableRefresh;
    assert(w.document.querySelector('.tool-toggle-list input')?.disabled && /Auto-refresh is disabled|自动刷新已在设置中关闭/.test(w.document.querySelector('#view').textContent), 'logs explain the applied global refresh pause');
    const disabledCalls = calls.length;
    await advance(60000);
    assert(calls.length === disabledCalls && timers.size === 0, 'disabled automatic refresh produces no view reads or timer wakeups');
    for (const [route, sub] of [['peers', 'peers'], ['tunnel', 'tun'], ['logs', 'logs']]) {
      const before = count(sub);
      await budget(route, sub, 0);
      assert(count(sub) === before + 1, `${route} still loads once on entry with automatic refresh disabled`);
    }
    const pausedLogs = count('logs');
    [...w.document.querySelectorAll('#view button')].find(button => /^(Refresh|刷新)$/.test(button.textContent))?.click();
    await flush();
    assert(count('logs') === pausedLogs + 1 && timers.size === 0, 'explicit refresh remains available with the global refresh switch off');
    const trial = { id: 'power_trial', status: 'running', deadline: Math.floor(now / 1000) + 120, reason: '',
      previous: { mode: 'bridge', dnsMode: 'legacy', routeScope: 'all' }, candidate: { mode: 'proxy', dnsMode: 'local', routeScope: 'all' } };
    fixtures['trial-status'] = { ok: true, trial };
    await nav('more'); await nav('settings');
    const activeTrialReads = count('trial-status');
    await advance(10000);
    assert(count('trial-status') === activeTrialReads + 3, 'running trials keep three-second checks even with automatic refresh disabled');
    await visible(false);
    assert(timers.size === 0, 'hiding an active trial removes its countdown and status timers');
    const hiddenTrialReads = count('trial-status');
    await advance(60000);
    await visible(true);
    assert(count('trial-status') === hiddenTrialReads + 1, 'returning to an active trial fetches one fresh backend result');
    fixtures['trial-status'] = { ok: true, trial: { ...trial, status: 'confirmed' } };
    const beforeAction = count('settings-get');
    w.document.querySelector('[data-testid="trial-controls"] button')?.click();
    await flush();
    assert(count('settings-get') === beforeAction + 1, 'trial confirmation reloads settings once instead of twice');
    await advance(4000);
    assert(timers.size === 0, 'a confirmed trial releases both timers while automatic refresh remains disabled');
    fixtures['trial-status'] = { ok: true, trial: { ...trial, status: 'rollback-failed', reason: 'retry-needed' } };
    await nav('more'); await nav('settings');
    const failedTrialReads = count('trial-status');
    await advance(60000);
    assert(count('trial-status') === failedTrialReads && timers.size === 0, 'a failed rollback stops polling with power saving on and automatic refresh off');
    const failedControls = w.document.querySelector('[data-testid="trial-controls"]');
    const failedButtons = failedControls?.querySelectorAll('button');
    assert(w.document.querySelector('[data-testid="trial-status"]')?.textContent.includes('retry-needed') &&
      failedButtons?.length === 2 && failedButtons[0].disabled && !failedButtons[1].disabled &&
      [...failedControls.closest('.card').querySelectorAll('select')].every(select => select.disabled),
    'a failed rollback retains its error, blocks new trials and permits manual rollback retry');
    fixtures['trial-status'] = { ok: true, trial: { ...trial, status: 'rolling-back' } };
    const beforeRetry = count('trial-revert');
    failedButtons?.[1].click();
    await flush();
    assert(count('trial-revert') === beforeRetry + 1, 'manual rollback retry still reaches the backend while polling is stopped');
    const retryTrialReads = count('trial-status');
    await advance(9000);
    assert(count('trial-status') === retryTrialReads + 3, 'manual retry resumes three-second checks while rollback is running');
    fixtures['trial-status'] = { ok: true, trial: { ...trial, status: 'rolled-back' } };
    await advance(3000);
    const finishedTrialReads = count('trial-status');
    await advance(60000);
    assert(count('trial-status') === finishedTrialReads && timers.size === 0, 'completed rollback releases the retry polling timer');
    for (const backend of ['NoState', 'Starting']) {
      fixtures.status = { ...fixtures.status, backend, powerSave: true, autoRefresh: true };
      const transition = w.__foxy.refreshStatus();
      await flush(); await transition;
      const beforeTransition = count('status');
      await advance(15000);
      assert(count('status') === beforeTransition + 3, `${backend} retains five-second status polling even with power saving on`);
    }
    const approval = {};
    for (const [powerSave, autoRefresh, expected] of [[false, true, 4], [true, true, 2], [true, false, 0]]) {
      fixtures.status = { ...fixtures.status, backend: 'NeedsMachineAuth', powerSave, autoRefresh };
      const awaitingApproval = w.__foxy.refreshStatus();
      await flush(); await awaitingApproval;
      approval[autoRefresh ? powerSave ? 'saving' : 'normal' : 'disabled'] = await budget('dashboard', 'status', expected);
    }
    assert(intervals === 0, 'the app installs no perpetual setInterval callbacks');
    console.log('POWER 60s command counts (excluding initial reads): normal=' + JSON.stringify(measurements) + ', saving=' + JSON.stringify(saving) + ', approval=' + JSON.stringify(approval) + '; hidden/auto-off timers=0; idle/failed/finished trial timers=0');
  } finally { w.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await checkPower();
  if (failures.length) console.error(failures.join('\n'));
  process.exit(failures.length ? 1 : 0);
}
