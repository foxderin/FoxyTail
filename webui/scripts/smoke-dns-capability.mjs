import { boot, assert, flush } from './smoke-fixture.mjs';

export async function runDnsCapabilitySmoke() {
  console.log('Settings reads cached DNS capabilities without automatic probes');
  const h = await boot();
  const { fixture, nav, window } = h;
  const row = () => window.document.querySelector('[data-setting="DNS_MODE"]');
  const option = value => row()?.querySelector(`option[value="${value}"]`);
  const probeCount = () => fixture.log.filter(r => r.args?.command === 'dns-probe').length;
  try {
    fixture.data.dns.transparentAvailable = null;
    fixture.data.dns.hijackAvailable = null;
    await nav('settings');
    assert(probeCount() === 0, 'Settings never probes missing capabilities');
    assert(!option('transparent')?.disabled && !option('hijack')?.disabled, 'unknown modes remain selectable');
    assert(!!row()?.querySelector('[data-testid="dns-capability-unknown"] a[href="#/diag"]'), 'unknown capabilities explain explicit diagnostic path');
    await nav('diag');
    fixture.data.dns.transparentAvailable = false;
    fixture.data.dns.hijackAvailable = true;
    await nav('settings');
    assert(option('transparent')?.disabled && !option('hijack')?.disabled, 'returning reads new cached capability verdicts');
    assert(!row()?.querySelector('[data-testid="dns-capability-unknown"]'), 'complete cached verdict removes unknown hint');
    fixture.data.dns.transparentAvailable = true;
    fixture.publishControl({ revision: 41 }); await flush();
    assert(!option('transparent')?.disabled, 'native revision refreshes cached verdict');
    fixture.overrides.set('dns', { ok: false, error: 'Cache read unavailable' });
    fixture.publishControl({ revision: 42 }); await flush();
    assert(!option('transparent')?.disabled && !!row()?.querySelector('[data-testid="dns-capability-unknown"]'), 'failed cache read becomes unknown, not unsupported');
    fixture.overrides.delete('dns');
    fixture.holdNext.add('dns');
    fixture.publishControl({ revision: 43 }); await flush();
    const old = fixture.held.findLast(r => r.key === 'dns');
    assert(!!old, 'capability cache read held');
    await nav('dashboard');
    old.finish({ ok: true, transparentAvailable: false, hijackAvailable: false }); await flush();
    fixture.data.dns.transparentAvailable = true;
    fixture.data.dns.hijackAvailable = true;
    await nav('settings');
    assert(!option('transparent')?.disabled && !option('hijack')?.disabled, 'obsolete hidden response cannot disable fresh choices');
    fixture.holdNext.add('dns');
    fixture.publishControl({ revision: 44 }); await flush();
    const interrupted = fixture.held.findLast(r => r.key === 'dns');
    fixture.emit('lifecycle', { active: false });
    interrupted.finish({ ok: false, cancelled: true }); await flush();
    fixture.data.dns.hijackAvailable = false;
    fixture.emit('lifecycle', { active: true }); await flush();
    assert(option('hijack')?.disabled, 'interrupted cache read resumes after lifecycle recovery');
    assert(probeCount() === 0, 'return/revision/failure recovery never automatically probes');
    assert(fixture.unsupported.length === 0, 'DNS capability regression uses supported commands');
  } finally { h.close(); }
}
