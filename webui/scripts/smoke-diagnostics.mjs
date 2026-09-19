import { window, commandLog, canned, overrides, flush, nav, assert } from './smoke-fixture.mjs';

export async function checkDiagnostics() {
  const before = commandLog.length;
  nav('diag');
  await flush();
  assert(!commandLog.slice(before).some(({ sub }) => sub === 'diag-check'), 'diagnostics are explicitly requested, not run on navigation');
  const run = () => window.document.querySelector('[data-testid="diag-checks"]').closest('.card').querySelector('button');
  canned['diag-check'] = { ok: true, checks: [
    { id: 'service', level: 'pass', reason: 'connected', page: 'dashboard' },
    { id: 'dns', level: 'warn', reason: 'dns_conflict', page: 'tunnel' },
  ] };
  run().click();
  await flush();
  assert(window.document.querySelectorAll('[data-testid="diag-checks"] .tool-result').length === 2, 'health summary displays actual per-component results');
  assert(window.document.querySelector('[data-level="warn"] a')?.getAttribute('href') === '#/tunnel', 'a DNS conflict links to existing DNS details');
  overrides['diag-check'] = [1, '{"ok":false,"error":"probe-unavailable"}', ''];
  run().click();
  await flush();
  assert(!window.document.querySelector('[data-testid="diag-checks"] .tool-result') && window.document.querySelector('#view').textContent.includes('probe-unavailable'), 'failed recheck clears stale healthy results and reports failure');
  delete overrides['diag-check'];
  const select = window.document.querySelector('#view select');
  assert(select?.value === 'share', 'bundle export defaults to anonymized sharing mode');
  select.value = 'local';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  canned.diag = { ok: true, path: '/sdcard/Download/fixture-diag.tar.gz', mode: 'local' };
  select.closest('.card').querySelector('button').click();
  await flush();
  assert(commandLog.some(({ sub, args }) => sub === 'diag' && args[0] === 'local'), 'detailed collection requires an explicit local mode choice');
  assert(window.document.querySelector('#view').textContent.includes('/sdcard/Download/fixture-diag.tar.gz'), 'completed bundle exposes its real response path');
}
