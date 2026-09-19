import { window, commandLog, canned, overrides, flush, nav, assert } from './smoke-fixture.mjs';

export async function checkRecovery() {
  console.log('configuration trials survive page lifetimes and restore requires a valid preview');
  const controls = () => window.document.querySelector('[data-testid="trial-controls"]');
  const trialStatus = () => window.document.querySelector('[data-testid="trial-status"]');
  const status = { id: 'trial_smoke', status: 'running', deadline: Math.floor(Date.now() / 1000) + 120, reason: '',
    previous: { mode: 'bridge', dnsMode: 'legacy', routeScope: 'all' }, candidate: { mode: 'proxy', dnsMode: 'local', routeScope: 'all' } };
  canned['trial-status'] = { ok: true, trial: null };
  nav('settings');
  await flush();
  const card = controls()?.closest('.card');
  const choices = card?.querySelectorAll('select');
  if (choices?.length === 2) {
    choices[0].value = 'proxy'; choices[0].dispatchEvent(new window.Event('change', { bubbles: true }));
    choices[1].value = '60'; choices[1].dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  canned['trial-status'] = { ok: true, trial: status };
  controls()?.querySelector('button')?.click();
  await flush();
  assert(commandLog.findLast(entry => entry.sub === 'trial-start')?.args.join('|') === '60|proxy', 'trial start submits the explicit duration and candidate mode');
  assert(trialStatus()?.textContent.includes('proxy / local') && controls()?.querySelectorAll('button').length === 2, 'running trial exposes candidate, baseline and confirm/revert actions');
  nav('dashboard');
  await flush();
  nav('settings');
  await flush();
  assert(trialStatus()?.textContent.includes('bridge / legacy'), 'returning to Settings recovers the backend trial and rollback target');
  canned['trial-status'] = { ok: true, trial: { ...status, status: 'confirmed' } };
  controls()?.querySelector('button')?.click();
  await flush();
  assert(commandLog.findLast(entry => entry.sub === 'trial-confirm')?.args[0] === status.id, 'confirmation includes the currently displayed trial id');
  canned['trial-status'] = { ok: true, trial: { ...status, status: 'rollback-failed', reason: 'trial-rollback-retry-needed' } };
  nav('dashboard'); await flush(); nav('settings'); await flush();
  const failedButtons = controls()?.querySelectorAll('button');
  assert(trialStatus()?.textContent.includes('trial-rollback-retry-needed') && failedButtons?.[0].disabled && !failedButtons?.[1].disabled, 'rollback failure remains visible with only revert retry enabled');
  canned['trial-status'] = { ok: true, trial: { ...status, status: 'rolled-back', reason: 'trial expired without confirmation' } };
  failedButtons?.[1].click();
  await flush();
  assert(commandLog.findLast(entry => entry.sub === 'trial-revert')?.args[0] === status.id && trialStatus()?.textContent.includes('trial expired'), 'revert retries the active id and displays the final backend result');
  for (const bad of [{ ok: true, trial: {} }, { ok: false, error: 'trial-status-unavailable' }]) {
    overrides['trial-status'] = [bad.ok ? 0 : 1, JSON.stringify(bad), ''];
    nav('dashboard'); await flush(); nav('settings'); await flush();
    assert(controls()?.querySelector('button')?.disabled && !trialStatus(), 'unknown or malformed trial status disables mutation instead of guessing inactivity');
  }
  delete overrides['trial-status'];
  canned['trial-status'] = { ok: true, trial: null };
  nav('dashboard'); await flush(); nav('settings'); await flush();
  const picker = window.document.querySelector('#restore-backup');
  picker.value = canned['backup-list'].backups[0].path;
  picker.dispatchEvent(new window.Event('change', { bubbles: true }));
  window.document.querySelector('.restore-preview')?.click();
  await flush();
  assert(window.document.querySelector('[data-testid="restore-diff"]')?.textContent.includes('SOCKS_PORT') && window.document.querySelector('.restore-apply'), 'a validated archive preview renders the diff before offering restore');
  picker.value = ''; picker.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(!window.document.querySelector('[data-testid="restore-diff"]') && !window.document.querySelector('.restore-apply'), 'changing the selected archive invalidates its preview and restore action');
  picker.value = canned['backup-list'].backups[0].path;
  picker.dispatchEvent(new window.Event('change', { bubbles: true }));
  overrides['restore-preview'] = [0, JSON.stringify({ ok: true, path: picker.value, sha256: 'invalid', changes: [], hooks: [] }), ''];
  window.document.querySelector('.restore-preview')?.click();
  await flush();
  assert(!window.document.querySelector('.restore-apply'), 'a malformed preview cannot authorize restoring an archive');
  delete overrides['restore-preview'];
}
