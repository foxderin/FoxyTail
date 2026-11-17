import {boot, assert, flush} from './smoke-fixture.mjs';
export async function runAccountDetailsSmoke() {
  const h = await boot();
  const {window, fixture, nav, app, click} = h;
  try {
    fixture.data.accounts.accounts[0].id = 'profile-personal';
    fixture.data.accounts.accounts[0].tailnet = 'example.ts.net';
    await nav('account');
    const facts = () => window.document.querySelector('[data-testid="account-device-details"]');
    assert(facts()?.textContent.includes('preview-self'), 'account page shows current device identity');
    assert(window.document.querySelector('.account-profile-facts')?.textContent.includes('profile-personal'), 'account list shows actual profile ID');
    assert(window.document.querySelector('.tools-page').textContent.includes('example.ts.net'), 'account list shows reported tailnet');
    assert(facts()?.textContent.includes(window.__foxy.t('acc_not_reported')), 'missing key expiry is not represented as never-expiring');
    const ip = fixture.data.status.self.ips[0];
    click(facts().querySelector('.account-address button')); await flush();
    assert(fixture.log.some(row => row.action === 'app.copy' && row.args.text === ip), 'address copy contains only selected address');
    fixture.overrides.set('status', {ok:false,error:'Device status unavailable'});
    await app.state.refreshStatus(); await flush();
    assert(!facts(), 'failed refresh hides stale device identity');
    fixture.overrides.delete('status');
    fixture.data.status.self = null; fixture.data.status.backend = 'NeedsLogin';
    await app.state.refreshStatus(); await flush();
    assert(facts()?.textContent.includes('NeedsLogin') && !facts()?.textContent.includes('preview-self'), 'logged-out status has no stale device details');
    assert(!fixture.log.some(row => row.action === 'control.mutate'), 'details viewing and copying never submits account mutation');
    assert(fixture.unsupported.length === 0, 'account details use supported existing reads only');
  } finally {h.close();}
}
