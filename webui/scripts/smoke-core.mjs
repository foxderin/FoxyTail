import { window, bundle, ROUTES, failures, vc, stubDom, bridge, pendingCancels, commandLog, holdNext, heldReplies, canned, overrides, spawnLog, flush, nav, assert, JSDOM, VirtualConsole } from './smoke-fixture.mjs';

export async function checkCore() {
  /* --- boot --------------------------------------------------------------- */
  try {
    window.eval(bundle);
  } catch (e) {
    console.error('bundle evaluation threw:', e);
    process.exit(1);
  }
  assert(bridge.execCount === 0 && spawnLog.length === 0, 'first UI renders before any native bridge invocation');
  await flush();

  const firstLoginHero = window.document.querySelector('[data-testid="login-hero"][data-hero-state="login"]');
  assert(firstLoginHero && !firstLoginHero.querySelector('.hero-actions button.btn-filled')?.disabled, 'an initial explicit NeedsLogin snapshot exposes an enabled login action');
  const beforeFirstLogin = commandLog.length;
  firstLoginHero?.querySelector('.hero-actions button.btn-filled')?.click();
  await flush();
  assert(commandLog.slice(beforeFirstLogin).filter(entry => entry.sub === 'login').length === 1 && firstLoginHero?.textContent.includes('https://login.example.test/device'), 'an initially unauthenticated user can explicitly request a login link');

  console.log('rapid navigation and remounting');
  for (let round = 0; round < 2; round++) {
    const beforeNavigation = bridge.execCount;
    for (const r of ROUTES) {
      nav(r);
      /* same-frame check: navigation is synchronous, skeleton is immediate */
      const view = window.document.querySelector('#view');
      assert(view && view.childNodes.length > 0, `route ${r} (round ${round + 1}) rendered synchronously`);
    }
    await flush(3);
    assert(bridge.execCount === beforeNavigation, 'rapid routes drop abandoned reads before launch without cancel calls (round ' + (round + 1) + '): ' + commandLog.slice(beforeNavigation).map((entry) => entry.sub || entry.cmd).join(', '));
  }
  await flush();

  console.log('task adoption across navigation');
  nav('exitnodes');
  await flush();
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

  bridge.releaseSpeedtest();
  await flush();
  assert(window.__foxy.getTask('speedtest-exitnodes')?.status === 'done', 'task done after release');
  const speedtestCountAfterDone = bridge.speedtestExecCount;
  assert(/23\s*ms/.test(window.document.querySelector('#view').textContent), 'cached result rendered (23ms)');

  /* re-enter again: cached result, no new speedtest exec (list/status light
   * reads DO refire by design — only the heavy task must not) */
  nav('dashboard');
  nav('exitnodes');
  await flush();
  assert(
    bridge.speedtestExecCount === speedtestCountAfterDone,
    'no refire on re-entry (cached result adopted)',
  );
  assert(/23\s*ms/.test(window.document.querySelector('#view').textContent), 'result still shown from cache');

  console.log('cancel path');
  window.__foxy.startTask('speedtest-exitnodes', 'speedtest-exitnodes');
  await flush();
  const speedtestCancelButton = window.document.querySelector('#view .task-progress button');
  assert(speedtestCancelButton && !speedtestCancelButton.disabled && /Cancel|取消/.test(speedtestCancelButton.textContent), 'cancellable speed tests retain their enabled Cancel action');
  speedtestCancelButton?.click();
  await flush();
  assert(
    window.__foxy.getTask('speedtest-exitnodes')?.status === 'cancelled',
    'cancel settles task as cancelled',
  );

  console.log('no-root banner variant');
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

  console.log('backend error propagation (errno != 0, {ok:false,error} on stdout)');
  overrides['routes-get'] = [1, '{"ok":false,"error":"boom-reason"}', ''];
  nav('routing');
  await flush();
  assert(
    (window.document.querySelector('#view [role="alert"]')?.textContent || '').includes('boom-reason'),
    'backend error reason surfaces in the UI (boom-reason)',
  );
  delete overrides['routes-get'];

  console.log('tab buttons render non-empty labels');
  nav('logs');
  await flush();
  const tabButtons = [...window.document.querySelectorAll('[role="tab"]')];
  assert(tabButtons.length > 0, 'tabbed route renders tab buttons');
  assert(
    tabButtons.every((el) => (el.textContent || '').trim() !== ''),
    'every tab button label is non-empty',
  );

  console.log('first-load failures render recoverable errors');
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

  console.log('cancellation identity and retained ownership');
  const old = window.__foxy.startTask('identity', 'speedtest-exitnodes');
  await flush();
  const oldFinish = bridge.releaseSpeedtest;
  const countBeforeReplace = bridge.speedtestExecCount;
  const adopted = window.__foxy.startTask('identity', 'speedtest-exitnodes');
  assert(adopted === old, 'starting a pending key returns its exact existing call');
  bridge.holdCancel = true;
  const cancelling = old.cancel();
  await flush();
  assert(bridge.speedtestExecCount === countBeforeReplace && old.cancellation === 'requested', 'requesting cancellation retains the running task without replacement');
  assert(pendingCancels.some((entry) => entry.requestId === old.requestId), 'cancel targets only the owned request id');
  oldFinish();
  await flush();
  assert(window.__foxy.getTask('identity')?.status === 'done', 'real completion wins while cancellation acknowledgement is pending');
  for (const entry of pendingCancels.splice(0)) entry.acknowledge();
  bridge.holdCancel = false;
  const completedCancel = await cancelling;
  assert(completedCancel.completed && !completedCancel.cancelled && window.__foxy.getTask('identity')?.result?.ok, 'late cancellation acknowledgement cannot replace successful completion');
  const replacement = window.__foxy.startTask('identity', 'speedtest-exitnodes');
  await flush();
  assert(replacement.requestId !== old.requestId && bridge.speedtestExecCount === countBeforeReplace + 1, 'only a deliberate start after terminal completion launches a new request');
  bridge.releaseSpeedtest();
  await flush();
  assert(!commandLog.some(({ cmd }) => cmd.includes('pkill')), 'no cancellation uses process-name matching');

  nav('exitnodes');
  await flush();
  const cannotCancel = window.__foxy.startTask('speedtest-exitnodes', 'speedtest-exitnodes');
  await flush();
  overrides.cancel = [1, JSON.stringify({ ok: false, error: 'still running' }), ''];
  const beforeDenied = bridge.speedtestExecCount;
  const denied = cannotCancel.cancel();
  await flush();
  assert(!(await denied).ok && cannotCancel.cancellation === 'failed' && !cannotCancel.cancelled, 'failed cancellation does not claim confirmed termination');
  assert(window.__foxy.getTask('speedtest-exitnodes')?.status === 'running' && !window.__foxy.getTask('speedtest-exitnodes')?.result, 'failed cancellation leaves task pending without a cached terminal error');
  assert(window.document.querySelector('[data-task-key="speedtest-exitnodes"][data-cancellation="failed"] button:not(:disabled)'), 'failed cancellation exposes a usable retry action');
  assert(window.__foxy.startTask('speedtest-exitnodes', 'speedtest-exitnodes') === cannotCancel && bridge.speedtestExecCount === beforeDenied, 'failed cancellation cannot be bypassed by another start');
  const attemptsBeforeRetry = commandLog.filter(entry => entry.sub === 'cancel').length;
  const retry = cannotCancel.cancel();
  await flush();
  await retry;
  assert(commandLog.filter(entry => entry.sub === 'cancel').length === attemptsBeforeRetry + 1, 'retry performs a new cancellation attempt instead of replaying the failed promise');
  bridge.releaseSpeedtest();
  await flush();
  assert(window.__foxy.getTask('speedtest-exitnodes')?.status === 'done' && window.__foxy.getTask('speedtest-exitnodes')?.result?.ok, 'late real completion remains available after repeated cancellation failure');
  delete overrides.cancel;

  const confirmed = window.__foxy.startTask('confirmed', 'speedtest-exitnodes');
  await flush();
  const confirmedFinish = bridge.releaseSpeedtest;
  const confirmedCancel = confirmed.cancel();
  await flush();
  assert((await confirmedCancel).cancelled && confirmed.cancelled && window.__foxy.getTask('confirmed')?.status === 'cancelled', 'backend acknowledgement alone permits cancelled terminal status');
  confirmedFinish();
  await flush();
  assert(window.__foxy.getTask('confirmed')?.status === 'cancelled', 'a response after confirmed termination cannot overwrite cancellation');

  console.log('restore commit races and abandoned read observers');
  canned.restore = { ok: true, restored: true };
  holdNext.add('restore');
  const restoreReplyStart = heldReplies.length;
  const restore = window.__foxy.startTask('restore-owner-smoke', 'restore', '/backup', 'archive', 'baseline');
  await flush();
  overrides.cancel = [1, JSON.stringify({ ok: false, error: 'restore commit already owns the transaction' }), ''];
  const rejectedRestoreCancel = restore.cancel();
  await flush();
  assert(!(await rejectedRestoreCancel).ok && restore.cancellation === 'failed' && window.__foxy.getTask('restore-owner-smoke')?.status === 'running', 'commit rejection leaves the destructive mutation owned and awaiting its true result');
  overrides.cancel = [0, JSON.stringify({ ok: true, completed: true }), ''];
  const commitCancel = restore.cancel();
  await flush();
  assert((await commitCancel).completed && !restore.cancelled && window.__foxy.getTask('restore-owner-smoke')?.status === 'running', 'completed commit acknowledgement waits for the original bridge result rather than claiming cancellation');
  assert(window.__foxy.startTask('restore-owner-smoke', 'restore', '/different') === restore, 'a crossing commit response still blocks duplicate destructive action');
  heldReplies.slice(restoreReplyStart).find(reply => reply.sub === 'restore')?.finish();
  await flush();
  assert(window.__foxy.getTask('restore-owner-smoke')?.status === 'done', 'restore publishes its actual commit outcome after the acknowledgement race');
  overrides.cancel = [1, JSON.stringify({ ok: false, error: 'cannot stop read yet' }), ''];
  const scope = window.__foxy.createApiScope();
  holdNext.add('peers');
  const readReplyStart = heldReplies.length;
  const abandoned = scope.api('peers');
  let appliedLateRead = false;
  abandoned.then(result => { if (!result.cancelled) appliedLateRead = true; });
  await flush();
  scope.cancelAll();
  await flush();
  heldReplies.slice(readReplyStart).find(reply => reply.sub === 'peers')?.finish();
  await flush();
  assert((await abandoned).cancelled && !appliedLateRead, 'detached page observers never apply late read data even when backend cancellation failed');
  delete overrides.cancel;
  const freshRead = scope.api('peers');
  await flush();
  assert((await freshRead).ok, 'a reused scope can issue fresh reads after detaching its old generation');

  console.log('timeouts report ownership instead of false completion');
  const originalSetTimeout = window.setTimeout;
  const deadlines = [];
  window.setTimeout = function (callback, delay, ...args) {
    if (delay === 120000 || delay === 90000) {
      deadlines.push(() => callback(...args));
      return originalSetTimeout.call(window, () => {}, 2147483647);
    }
    return originalSetTimeout.call(window, callback, delay, ...args);
  };
  holdNext.add('control');
  const timeoutReplyStart = heldReplies.length;
  const committing = window.__foxy.startTask('timeout-commit', 'control', 'restart');
  await flush();
  window.setTimeout = originalSetTimeout;
  const cancelCount = commandLog.filter(entry => entry.sub === 'cancel').length;
  assert(deadlines.length === 1, 'commit command installs its deadline');
  deadlines[0]?.();
  await flush();
  assert(committing.timedOut && window.__foxy.getTask('timeout-commit')?.status === 'running' && commandLog.filter(entry => entry.sub === 'cancel').length === cancelCount, 'a committing timeout stays owned without dispatching unsafe cancellation');
  heldReplies.slice(timeoutReplyStart).find(reply => reply.sub === 'control')?.finish();
  await flush();
  assert(window.__foxy.getTask('timeout-commit')?.status === 'done', 'commit success arriving beyond the deadline is preserved');

  deadlines.length = 0;
  window.setTimeout = function (callback, delay, ...args) {
    if (delay === 90000) {
      deadlines.push(() => callback(...args));
      return originalSetTimeout.call(window, () => {}, 2147483647);
    }
    return originalSetTimeout.call(window, callback, delay, ...args);
  };
  overrides.cancel = [1, JSON.stringify({ ok: false, error: 'timeout cancellation failed' }), ''];
  const timedProbe = window.__foxy.startTask('speedtest-exitnodes', 'speedtest-exitnodes');
  await flush();
  window.setTimeout = originalSetTimeout;
  const timedProbeFinish = bridge.releaseSpeedtest;
  assert(deadlines.length === 1, 'cancellable command installs its deadline');
  deadlines[0]?.();
  await flush();
  assert(timedProbe.timedOut && timedProbe.cancellation === 'failed' && window.document.querySelector('[data-task-key="speedtest-exitnodes"][data-timed-out="true"]'), 'failed deadline cancellation remains visibly running and timed out');
  delete overrides.cancel;
  const timeoutRetry = timedProbe.cancel();
  await flush();
  await timeoutRetry;
  assert(window.__foxy.getTask('speedtest-exitnodes')?.result?.timedOut && window.__foxy.getTask('speedtest-exitnodes')?.result?.stopped && window.__foxy.getTask('speedtest-exitnodes')?.status === 'error', 'confirmed timeout termination becomes a truthful stopped timeout result');
  timedProbeFinish();
  await flush();

  console.log('native TUN capabilities and SOCKS5 protocol');
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
  const scopeButtons = [...window.document.querySelectorAll('#view input[name="route-scope"]')];
  assert(scopeButtons.length === 3 && !scopeButtons[0].disabled && scopeButtons.slice(1).every((b) => b.disabled), 'native TUN disables selected/bypass but permits All');

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

}
