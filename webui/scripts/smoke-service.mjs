import { window, ROUTES, commandLog, holdNext, heldReplies, canned, overrides, flush, nav, assert, JSDOM, vc, stubDom, bundle } from './smoke-fixture.mjs';

export async function checkService() {
  console.log('service and mode controls stay at the page header');
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

  console.log('service controls reconcile completion, failure and unknown device state');
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
  return { runningSnapshot, headerToggle };
}

export async function checkAuthentication({ runningSnapshot, headerToggle }) {
  console.log('initialization and machine approval do not masquerade as a lost login');
  const loginHero = () => window.document.querySelector('[data-testid="login-hero"][data-hero-state="login"]');
  const loginWrites = since => commandLog.slice(since).filter(entry => entry.sub === 'login' || entry.sub === 'login-authkey');
  const dashboardSaysStopped = () => /^(Stopped|已停止)$/.test(window.document.querySelector('.network-health h2')?.textContent.trim() || '');
  canned.status = { ...runningSnapshot, backend: 'Running' };
  await window.__foxy.refreshStatus();
  nav('dashboard');
  await flush();
  holdNext.add('control');
  const beforeRestartReplyIndex = heldReplies.length;
  const beforeRestartLogin = commandLog.length;
  window.document.querySelector('[data-testid="service-restart"] button')?.click();
  await flush();
  const approveRestart = window.document.querySelector('.md-dialog-actions .btn-filled');
  assert(approveRestart, 'restarting the running service has an explicit confirmation');
  approveRestart?.click();
  await flush();
  const restartReply = heldReplies.slice(beforeRestartReplyIndex).find(reply => reply.sub === 'control');
  assert(restartReply && headerToggle?.disabled, 'the restart remains active while its control command is pending');
  canned.status = { ...runningSnapshot, backend: 'NoState', self: null, uptime: 0 };
  await window.__foxy.refreshStatus();
  assert(!loginHero() && !dashboardSaysStopped(), 'NoState during restart is initialization, not a login request or a stopped service');
  nav('peers');
  nav('dashboard');
  await flush();
  assert(!loginHero() && headerToggle?.disabled, 'the restart and its initializing presentation survive page navigation');
  overrides.status = [1, JSON.stringify({ ok: false, error: 'restart-status-unavailable' }), ''];
  await window.__foxy.refreshStatus();
  assert(!loginHero() && !dashboardSaysStopped() && headerToggle?.indeterminate, 'a failed status read during restart shows uncertainty without claiming logout or a stopped service');
  delete overrides.status;
  restartReply?.finish();
  await flush();
  assert(!loginHero() && !dashboardSaysStopped() && headerToggle?.checked && !headerToggle?.disabled, 'a completed restart may still initialize without presenting a login form');
  canned.status = { ...runningSnapshot, backend: 'Running' };
  await window.__foxy.refreshStatus();
  assert(window.document.querySelector('.network-health.is-connected') && !loginHero(), 'Running after initialization restores the connected dashboard');
  assert(loginWrites(beforeRestartLogin).length === 0, 'initialization, recovery and navigation never initiate an authentication request');

  canned.status = { ...runningSnapshot, backend: 'NeedsMachineAuth' };
  const beforeApprovalLogin = commandLog.length;
  await window.__foxy.refreshStatus();
  assert(!loginHero() && !dashboardSaysStopped() && loginWrites(beforeApprovalLogin).length === 0, 'a machine awaiting administrator approval is not prompted to sign in again');
  canned.status = { ...runningSnapshot, backend: 'NeedsLogin' };
  await window.__foxy.refreshStatus();
  assert(loginHero(), 'a genuine NeedsLogin state still exposes login immediately');
  const staleLoginAction = loginHero()?.querySelector('.hero-actions button.btn-filled');
  overrides.status = [1, JSON.stringify({ ok: false, error: 'login-status-unavailable' }), ''];
  await window.__foxy.refreshStatus();
  assert(!loginHero() && !dashboardSaysStopped(), 'a failed refresh hides the cached login form instead of presenting stale authentication state');
  const beforeStaleLoginClick = commandLog.length;
  staleLoginAction?.click();
  await flush();
  assert(loginWrites(beforeStaleLoginClick).length === 0, 'a stale login button cannot dispatch authentication after the state becomes unconfirmed');
  delete overrides.status;
  await window.__foxy.refreshStatus();
  assert(loginHero(), 'a fresh confirmed NeedsLogin snapshot restores the login entry');
  await window.__foxy.refreshStatus();
  assert(loginHero(), 'a persistent genuine NeedsLogin state remains actionable');

  canned.status = { ...runningSnapshot, backend: 'Running' };
  await window.__foxy.refreshStatus();
  nav('account');
  await flush();
  const beforeManualLogout = commandLog.length;
  window.document.querySelector('#view .tool-danger button')?.click();
  await flush();
  const approveLogout = window.document.querySelector('.md-dialog-actions .btn-filled');
  assert(approveLogout, 'manual logout retains its confirmation');
  canned.status = { ...runningSnapshot, backend: 'NeedsLogin', self: null };
  approveLogout?.click();
  await flush();
  nav('dashboard');
  await flush();
  assert(commandLog.slice(beforeManualLogout).filter(entry => entry.sub === 'logout').length === 1 && loginHero(), 'a confirmed manual logout still returns the user to an immediate login entry');
  assert(loginWrites(beforeManualLogout).length === 0, 'manual logout does not automatically start a new authentication flow');
  canned.status = { ...runningSnapshot, backend: 'Running' };
  await window.__foxy.refreshStatus();

  for (const initialBackend of ['NoState', 'NeedsMachineAuth']) {
    const initializingDom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
      url: 'https://foxytail.local/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    });
    const initializingWindow = initializingDom.window;
    stubDom(initializingWindow);
    const initialCommands = [];
    initializingWindow.ksu = { spawn(cmd, args, options, callbackName) {
      initialCommands.push(cmd);
      initializingWindow.setTimeout(() => {
        const response = cmd.includes("'status'") ? { ...runningSnapshot, backend: initialBackend, self: null } : { ok: true, modules: [], warnings: [] };
        initializingWindow[callbackName].stdout.emit('data', JSON.stringify(response));
        initializingWindow[callbackName].emit('exit', 0);
      }, 0);
    } };
    initializingWindow.eval(bundle);
    await flush();
    assert(!initializingWindow.document.querySelector('[data-testid="login-hero"]') && initializingWindow.document.querySelector('.network-health h2'), initialBackend + ' on the first snapshot renders initialization without a login card');
    assert(!initialCommands.some(cmd => /'login(?:-authkey)?'/.test(cmd)), initialBackend + ' on first load sends no authentication request');
    initializingDom.window.close();
  }

}
