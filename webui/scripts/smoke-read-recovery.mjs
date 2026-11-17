import { boot, assert, failures, flush } from './smoke-fixture.mjs';

async function scenario(name, run) {
  console.log(name);
  const h = await boot();
  try { await run(h); assert(h.fixture.unsupported.length === 0, name + ': explicit fixture commands'); }
  catch (error) { failures.push(name + ': ' + error.stack); }
  finally { h.close(); }
}
const count = (fixture, command) => fixture.log.filter(r => r.action === 'control.query' && r.args.command === command).length;
function open(window, element) {
  assert(!!element, 'disclosure exists');
  element.open = true; element.dispatchEvent(new window.Event('toggle'));
}

await scenario('Logs initial interrupted read resumes without enabling auto refresh', async ({ app, nav, window, fixture, button, click }) => {
  fixture.data.status.autoRefresh = false;
  await app.state.refreshStatus({ afterCurrent: true });
  fixture.holdNext.add('logs');
  await nav('logs');
  const held = fixture.held.findLast(r => r.key === 'logs');
  assert(!!held, 'first log read is pending');
  fixture.emit('lifecycle', { active: false });
  held.finish({ ok: false, cancelled: true }); await flush();
  const paused = count(fixture, 'logs');
  fixture.emit('lifecycle', { active: true }); await flush();
  assert(count(fixture, 'logs') === paused + 1, 'cancelled initial demand retries exactly once');
  assert(window.document.querySelector('.tool-log')?.textContent.includes('Simulated tunnel ready'), 'resumed Logs replaces skeleton with content');
  fixture.emit('lifecycle', { active: false }); await flush();
  fixture.emit('lifecycle', { active: true }); await flush();
  assert(count(fixture, 'logs') === paused + 1, 'settled disabled polling does not refresh on every resume');
  fixture.holdNext.add('logs');
  click(button('tools_refresh', window.document.querySelector('.logs-page'))); await flush();
  const obsolete = fixture.held.findLast(r => r.key === 'logs');
  click(button('logs_service')); await flush();
  fixture.data.logs.lines = ['Fresh service log'];
  obsolete.finish({ ok: true, lines: ['Obsolete daemon log'] }); await flush();
  assert(window.document.querySelector('.tool-log')?.textContent.includes('Fresh service log') &&
    !window.document.querySelector('.tool-log')?.textContent.includes('Obsolete daemon log'), 'queued source switch discards old response and loads latest source');

});

await scenario('Advanced independent reads and persistent DNS probe errors', async ({ nav, window, fixture, button, click }) => {
  await nav('settings');
  fixture.holdNext.add('hooks-get');
  const advanced = window.document.querySelector('.page-transition:not([hidden]) details.tool-disclosure');
  open(window, advanced); await flush();
  const held = fixture.held.findLast(r => r.key === 'hooks-get');
  assert(!!held, 'hook read remains pending');
  assert(!!advanced.querySelector('[data-testid="context-rules"]'), 'context rules do not wait for hook contents');
  const dnsBefore = count(fixture, 'dns');
  assert(!!window.document.querySelector('.page-transition:not([hidden]) a[href="#/diag"]'), 'existing diagnostics link remains available before hooks settle');
  assert(!advanced.querySelector('[data-testid="diagnostic-details"]'), 'settings no longer mounts a second diagnostics interface');
  fixture.emit('lifecycle', { active: false });
  held.finish({ ok: false, cancelled: true }); await flush();
  const paused = count(fixture, 'hooks-get');
  fixture.emit('lifecycle', { active: true }); await flush();
  assert(count(fixture, 'hooks-get') === paused + 1 && advanced.textContent.includes('echo ready'), 'hook demand recovers without closing disclosure');
  assert(count(fixture, 'dns') === dnsBefore, 'settings maintenance does not fetch duplicate DNS facts');
  await nav('diag');
  const diagnostics = window.document.querySelector('[data-testid="diagnostic-details"]');
  open(window, diagnostics); await flush();
  fixture.overrides.set('dns-probe', { ok: false, error: 'Probe regression failure' });
  click(button('dns_check', diagnostics)); await flush();
  assert(diagnostics.textContent.includes('Probe regression failure'), 'successful status read does not erase failed probe');
  fixture.overrides.delete('dns-probe');
  click(button('dns_check', diagnostics)); await flush();
  assert(!diagnostics.textContent.includes('Probe regression failure'), 'next explicit successful probe clears old probe failure');
});

await scenario('DNS probe failure survives successful observation refresh', async ({ nav, window, fixture, button, click }) => {
  await nav('settings');
  await nav('diag');
  const diagnostics = window.document.querySelector('[data-testid="diagnostic-details"]');
  open(window, diagnostics); await flush();
  fixture.overrides.set('dns-probe', { ok: false, error: 'Probe regression failure' });
  click(button('dns_check', diagnostics)); await flush();
  assert(diagnostics.textContent.includes('Probe regression failure'), 'probe error remains after successful dns and status reads');
});

await scenario('Network summary invalidates after revision and failed refresh', async ({ nav, window, fixture, app }) => {
  await nav('network');
  const summary = () => window.document.querySelector('.page-transition:not([hidden]) a[href="#/tunnel"]')?.textContent;
  assert(summary()?.includes('tailscale0') && summary()?.includes(app.t('tun_up')), 'initial summary uses actual tunnel response');
  fixture.data.tun.ifaceUp = false;
  fixture.publishControl({ revision: fixture.control.revision + 1 }); await flush();
  assert(summary()?.includes(app.t('tun_down')), 'configuration revision refreshes tunnel summary');
  fixture.overrides.set('tun', { ok: false, error: 'Unavailable' });
  fixture.publishControl({ revision: fixture.control.revision + 1 }); await flush();
  assert(!summary()?.includes('tailscale0') && summary()?.includes(app.t('tools_tunnel_desc')), 'failed refresh does not retain previous up/down claim');
  fixture.overrides.delete('tun'); fixture.data.tun.ifaceUp = true;
  await nav('dashboard'); await nav('network');
  assert(summary()?.includes(app.t('tun_up')), 'returning to cached Network reads current summary');
});
