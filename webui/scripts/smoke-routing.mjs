import { window, commandLog, holdNext, heldReplies, canned, overrides, flush, nav, assert } from './smoke-fixture.mjs';

export async function checkRouting() {
  console.log('advertised subnet routes and local policy drafts remain independent');
  const subnetControls = () => window.document.querySelector('[data-testid="subnet-routes-controls"]');
  const acceptSubnetSwitch = () => subnetControls()?.querySelector('[role="switch"]');
  const refreshSubnetButton = () => [...(subnetControls()?.querySelectorAll('button') || [])].find(button => /Refresh subnet routes|刷新节点路由/.test(button.getAttribute('aria-label') || ''));
  const advertisedSubnet = (cidr) => window.document.querySelector('[data-route-cidr="' + cidr + '"]');
  const customSubnets = () => [...window.document.querySelectorAll('[data-custom-cidr]')].map(row => row.getAttribute('data-custom-cidr'));
  const routeWrites = (since) => commandLog.slice(since).filter(entry => ['subnet-routes-set', 'routes-set', 'settings-set', 'control', 'mode-set'].includes(entry.sub));
  async function addCustomSubnet(value) {
    const input = window.document.querySelector('#custom-route-cidr');
    assert(input, 'custom subnet input is available');
    if (input) {
      input.value = value;
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    }
    window.document.querySelector('[data-testid="route-add-subnet"] button[type="submit"]')?.click();
    await flush();
  }
  async function changeSubnetAcceptance(approve = true) {
    acceptSubnetSwitch()?.click();
    await flush();
    const confirmation = window.document.querySelector('.md-dialog-actions ' + (approve ? '.btn-filled' : 'button[autofocus]'));
    assert(confirmation, 'changing accepted subnet routes requires confirmation');
    confirmation?.click();
    await flush();
  }
  const advertisedFixture = {
    ok: true, acceptRoutes: false, mode: 'bridge', ipv6Enabled: true,
    peers: [
      { id: 'router-1', hostname: 'office-router', online: true, routes: [{ cidr: '192.168.44.0/24', primary: true }] },
      { id: 'router-2', hostname: 'backup-router', online: false, routes: [{ cidr: '2001:db8:40::/64', primary: false }] },
    ],
  };
  canned['subnet-routes-get'] = advertisedFixture;
  nav('more');
  await flush();
  holdNext.add('subnet-routes-get');
  const subnetInitialReplyIndex = heldReplies.length;
  nav('routing');
  await flush();
  const initialSubnetReply = heldReplies.slice(subnetInitialReplyIndex).find(reply => reply.sub === 'subnet-routes-get');
  assert(initialSubnetReply && acceptSubnetSwitch()?.disabled, 'loading subnet preferences prevents a concurrent preference mutation');
  assert(window.document.querySelector('#view .skeleton') || window.document.querySelector('[data-route-peer]'), 'loading advertisements retain cached nodes or show a placeholder');
  initialSubnetReply?.finish();
  await flush();
  assert(acceptSubnetSwitch() && !acceptSubnetSwitch().checked && !acceptSubnetSwitch().indeterminate && !acceptSubnetSwitch().disabled, 'the receive switch reflects the confirmed disabled Tailscale preference');
  assert(window.document.querySelector('[data-route-peer="router-1"]')?.textContent.includes('office-router') && advertisedSubnet('192.168.44.0/24'), 'online node advertisements display their associated CIDR');
  assert(window.document.querySelector('[data-route-peer="router-2"]')?.textContent.includes('backup-router') && advertisedSubnet('2001:db8:40::/64'), 'an offline node retains its advertised IPv6 route');

  const beforeSubnetDraft = commandLog.length;
  await addCustomSubnet('192.168.50.129/24');
  assert(customSubnets().includes('192.168.50.0/24') && !customSubnets().includes('192.168.50.129/24'), 'a custom IPv4 CIDR is normalized to its network address');
  await addCustomSubnet('192.168.50.254/24');
  assert(customSubnets().filter(cidr => cidr === '192.168.50.0/24').length === 1 && window.document.querySelector('#view [role="alert"]'), 'equivalent IPv4 host addresses cannot create duplicate local routes');
  await addCustomSubnet('2001:0DB8:0:1::1234/64');
  assert(customSubnets().includes('2001:db8:0:1::/64'), 'a custom IPv6 CIDR is compressed, lowercased and masked');
  await addCustomSubnet('2001:db8:0:1:ffff::/64');
  assert(customSubnets().filter(cidr => cidr === '2001:db8:0:1::/64').length === 1, 'equivalent IPv6 representations cannot create duplicate local routes');
  await addCustomSubnet('::ffff:192.0.2.129/120');
  assert(customSubnets().includes('::ffff:c000:200/120'), 'an IPv4-embedded IPv6 CIDR is normalized to the same network form as the backend');
  await addCustomSubnet('0:0:0:0:0:ffff:c000:2ff/120');
  assert(customSubnets().filter(cidr => cidr === '::ffff:c000:200/120').length === 1, 'embedded and hexadecimal IPv6 forms identify one network instead of duplicate routes');
  const customCountBeforeInvalid = customSubnets().length;
  await addCustomSubnet('256.1.1.1/24');
  await addCustomSubnet('2001:db8::/129');
  await addCustomSubnet('::ffff:256.0.2.1/120');
  assert(customSubnets().length === customCountBeforeInvalid && window.document.querySelector('#view [role="alert"]'), 'invalid IPv4 addresses and IPv6 prefixes leave the draft untouched');
  advertisedSubnet('192.168.44.0/24')?.querySelector('button')?.click();
  await flush();
  assert(customSubnets().includes('192.168.44.0/24') && advertisedSubnet('192.168.44.0/24')?.querySelector('button')?.disabled, 'selecting an advertised route adds it once to the local draft');
  assert(routeWrites(beforeSubnetDraft).length === 0 && !acceptSubnetSwitch()?.checked, 'editing and importing CIDRs does not save local rules or enable route reception');

  const draftBeforeAnnouncementRefresh = customSubnets();
  const unfinishedCidr = window.document.querySelector('#custom-route-cidr');
  if (unfinishedCidr) {
    unfinishedCidr.value = '10.123.45.7/16';
    unfinishedCidr.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  canned['subnet-routes-get'] = { ...advertisedFixture, peers: [...advertisedFixture.peers, { id: 'router-3', hostname: 'new-router', online: true, routes: [{ cidr: '172.16.32.0/20', primary: true }] }] };
  const beforeAnnouncementRefresh = commandLog.length;
  assert(refreshSubnetButton(), 'subnet advertisements have a named refresh action');
  refreshSubnetButton()?.click();
  await flush();
  assert(advertisedSubnet('172.16.32.0/20'), 'refreshing advertisements displays new node routes');
  assert(JSON.stringify(customSubnets()) === JSON.stringify(draftBeforeAnnouncementRefresh) && window.document.querySelector('#custom-route-cidr')?.value === '10.123.45.7/16', 'refreshing node advertisements preserves unsaved rules and unfinished input');
  assert(commandLog.slice(beforeAnnouncementRefresh).filter(entry => entry.sub === 'subnet-routes-get').length === 1 && !commandLog.slice(beforeAnnouncementRefresh).some(entry => entry.sub === 'routes-get'), 'advertisement refresh does not reload the local policy draft');

  const beforeCancelledSubnetChange = commandLog.length;
  await changeSubnetAcceptance(false);
  assert(!acceptSubnetSwitch()?.checked && routeWrites(beforeCancelledSubnetChange).length === 0, 'cancelling route reception leaves its preference unchanged and sends no mutation');
  canned['subnet-routes-set'] = { ok: true, acceptRoutes: true, applied: true };
  holdNext.add('subnet-routes-set');
  const beforeAcceptReplyIndex = heldReplies.length;
  const beforeAcceptWrite = commandLog.length;
  await changeSubnetAcceptance();
  const acceptReply = heldReplies.slice(beforeAcceptReplyIndex).find(reply => reply.sub === 'subnet-routes-set');
  assert(acceptReply && acceptSubnetSwitch()?.disabled && window.__foxy.getTask('subnet-routes')?.status === 'running', 'an accepted preference change remains busy until its backend result arrives');
  nav('traffic');
  await flush();
  assert(window.__foxy.getTask('subnet-routes')?.status === 'running', 'changing route reception survives navigation away');
  nav('routing');
  await flush();
  assert(acceptSubnetSwitch()?.disabled, 'the routing page adopts an in-flight reception change after navigation');
  canned['subnet-routes-get'] = { ...canned['subnet-routes-get'], acceptRoutes: true };
  acceptReply?.finish();
  await flush();
  assert(acceptSubnetSwitch()?.checked && !acceptSubnetSwitch()?.indeterminate && !acceptSubnetSwitch()?.disabled, 'the backend-confirmed enabled preference is shown after completion');
  assert(JSON.stringify(routeWrites(beforeAcceptWrite).map(entry => [entry.sub, entry.args])) === JSON.stringify([['subnet-routes-set', ['on']]]), 'enabling reception sends only subnet-routes-set on, without changing local routes or other settings');

  overrides['subnet-routes-set'] = [1, JSON.stringify({ ok: false, error: 'subnet-preference-rejected' }), ''];
  const beforeRejectedSubnetWrite = commandLog.length;
  await changeSubnetAcceptance();
  assert(acceptSubnetSwitch()?.checked && !acceptSubnetSwitch()?.disabled, 'a rejected preference change rolls the native switch back to the confirmed enabled value');
  assert(window.document.body.textContent.includes('subnet-preference-rejected'), 'a failed subnet preference write exposes the backend reason');
  assert(JSON.stringify(routeWrites(beforeRejectedSubnetWrite).map(entry => [entry.sub, entry.args])) === JSON.stringify([['subnet-routes-set', ['off']]]), 'a failed disable attempt still sends only the explicitly requested preference command');
  delete overrides['subnet-routes-set'];
  canned['subnet-routes-set'] = { ok: true, acceptRoutes: false, applied: true };
  canned['subnet-routes-get'] = { ...canned['subnet-routes-get'], acceptRoutes: false };
  await changeSubnetAcceptance();
  assert(!acceptSubnetSwitch()?.checked && !acceptSubnetSwitch()?.indeterminate && !acceptSubnetSwitch()?.disabled, 'a confirmed disable operation updates the receive switch');

  for (const observedAfterFailure of [false, null]) {
    const requestedAcceptance = !acceptSubnetSwitch()?.checked;
    canned['subnet-routes-get'] = { ...canned['subnet-routes-get'], acceptRoutes: observedAfterFailure };
    overrides['subnet-routes-set'] = [1, JSON.stringify({ ok: false, error: 'subnet-write-response-lost' }), ''];
    await changeSubnetAcceptance();
    assert(subnetControls()?.querySelector('.subnet-route-feedback')?.textContent.trim(), 'a failed subnet change retains feedback until its target state is observed');
    delete overrides['subnet-routes-set'];
    canned['subnet-routes-get'] = { ...canned['subnet-routes-get'], acceptRoutes: requestedAcceptance };
    const beforeReconciledSubnetRefresh = commandLog.length;
    refreshSubnetButton()?.click();
    await flush();
    assert(acceptSubnetSwitch()?.checked === requestedAcceptance && !acceptSubnetSwitch()?.indeterminate && !acceptSubnetSwitch()?.disabled, 'a manual refresh confirms the requested preference after an earlier failed change');
    assert(!subnetControls()?.querySelector('.subnet-route-feedback')?.textContent.trim(), 'a fresh matching snapshot clears obsolete mismatch or unconfirmed feedback');
    assert(routeWrites(beforeReconciledSubnetRefresh).length === 0, 'clearing stale preference feedback uses a read without repeating the mutation');
  }

  canned['subnet-routes-get'] = { ...advertisedFixture, acceptRoutes: null };
  refreshSubnetButton()?.click();
  await flush();
  assert(acceptSubnetSwitch()?.indeterminate && acceptSubnetSwitch()?.disabled, 'a null backend preference is shown as unknown, not as disabled');
  overrides['subnet-routes-get'] = [1, JSON.stringify({ ok: false, error: 'subnet-read-unavailable' }), ''];
  refreshSubnetButton()?.click();
  await flush();
  assert(acceptSubnetSwitch()?.indeterminate && acceptSubnetSwitch()?.disabled && window.document.querySelector('#view')?.textContent.includes('subnet-read-unavailable'), 'a failed advertisement read has an explicit error and keeps the receive state unknown');
  delete overrides['subnet-routes-get'];
  canned['subnet-routes-get'] = { ...advertisedFixture, peers: [] };
  refreshSubnetButton()?.click();
  await flush();
  assert(!window.document.querySelector('[data-route-peer]') && window.document.querySelector('#view .state-box') && !window.document.querySelector('#view .skeleton'), 'an empty advertisement result renders an empty state without stale peers or loading skeletons');
  assert(!acceptSubnetSwitch()?.indeterminate && !acceptSubnetSwitch()?.disabled, 'a successful refresh recovers the known route reception state');
  canned['subnet-routes-get'] = { ...advertisedFixture, ipv6Enabled: false };
  refreshSubnetButton()?.click();
  await flush();
  assert(advertisedSubnet('2001:db8:40::/64')?.querySelector('button')?.disabled && !acceptSubnetSwitch()?.disabled, 'disabled local IPv6 routing blocks IPv6 import without disabling Tailscale route reception');
  await addCustomSubnet('2001:db8:88::abcd/64');
  assert(customSubnets().includes('2001:db8:88::/64'), 'a custom IPv6 destination can still be prepared while IPv6 routing is disabled');
  const pendingIpv6 = customSubnets().filter(cidr => cidr.includes(':'));
  canned['routes-set'] = {
    ok: true, saved: true, applied: false, restartRequired: true,
    note: 'saved; IPv4 routing applied; IPv6 destinations are not applied while IPv6 is disabled',
    subnets: customSubnets(), ipv6Skipped: pendingIpv6, requiresIpv6: true,
  };
  const beforeIpv6DraftSave = commandLog.length;
  window.document.querySelector('#view .tool-sticky-actions button')?.click();
  await flush();
  const ipv6SkippedNotice = window.document.querySelector('[data-testid="route-ipv6-skipped"]');
  assert(ipv6SkippedNotice?.textContent.includes('IPv6') && pendingIpv6.every(cidr => ipv6SkippedNotice?.textContent.includes(cidr)) && ipv6SkippedNotice?.querySelector('a[href="#/settings"]'), 'saving a draft lists its unapplied IPv6 networks and provides the required settings action');
  assert(window.document.querySelector('#view .tool-sticky-actions .status-badge.tone-warning') && !window.document.querySelector('#view .tool-sticky-actions .status-badge.tone-success'), 'saved IPv6 destinations are visibly pending instead of falsely reported as fully applied');
  assert(routeWrites(beforeIpv6DraftSave).length === 1 && routeWrites(beforeIpv6DraftSave)[0]?.sub === 'routes-set' && !acceptSubnetSwitch()?.checked, 'saving local IPv6 destinations writes only local policy and does not enable Tailscale route reception');
  canned['routes-get'] = { ...canned['routes-get'], subnets: [...customSubnets()] };
  nav('more');
  nav('routing');
  await flush();
  const restoredIpv6Notice = window.document.querySelector('[data-testid="route-ipv6-skipped"]');
  assert(restoredIpv6Notice?.textContent.includes('IPv6') && pendingIpv6.every(cidr => restoredIpv6Notice?.textContent.includes(cidr)) && window.document.querySelector('#view .tool-sticky-actions .status-badge.tone-warning'), 'returning to saved IPv6 rules derives their pending enablement state from fresh configuration');
  await addCustomSubnet('10.240.12.99/24');
  canned['routes-set'] = { ...canned['routes-set'], subnets: customSubnets(), applyError: 'routing reload failed for mocked interface' };
  window.document.querySelector('#view .tool-sticky-actions button')?.click();
  await flush();
  assert(window.document.querySelector('#view')?.textContent.includes('routing reload failed for mocked interface'), 'an IPv6 limitation does not hide the actual routing application failure reason');
  assert(window.document.querySelector('[data-testid="route-ipv6-skipped"]') && window.document.querySelector('#view .tool-sticky-actions .status-badge.tone-warning'), 'a saved draft with an application failure retains both IPv6 enablement details and pending state');

  console.log('Funnel listener capabilities remain distinct from the local target protocol');
  nav('serve');
  await flush();
  const mappingForm = () => window.document.querySelector('[data-testid="serve-add-form"]');
  const mappingField = id => window.document.getElementById(id);
  const mappingSubmit = () => mappingForm()?.querySelector('button.btn-filled');
  const mappingWrites = since => commandLog.slice(since).filter(entry => entry.sub === 'serve-set' || entry.sub === 'funnel-set');
  function editMappingField(id, value) {
    const field = mappingField(id);
    assert(field, 'mapping form field ' + id + ' is available');
    if (!field) return;
    field.value = value;
    field.dispatchEvent(new window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  }
  async function submitMapping() {
    mappingSubmit()?.click();
    await flush();
  }
  assert(mappingForm() && mappingField('serve-protocol')?.querySelector('option[value="http"]'), 'Serve exposes an HTTP listener independently from Funnel');
  editMappingField('serve-protocol', 'http');
  editMappingField('serve-port', '8080');
  editMappingField('serve-target', 'http://localhost:3000');
  const beforeFunnelDraft = commandLog.length;
  editMappingField('serve-kind', 'funnel');
  assert(mappingField('serve-protocol')?.value === 'https' && mappingField('serve-port')?.value === '443' && mappingField('serve-target')?.value === 'http://localhost:3000', 'switching an HTTP Serve draft to Funnel selects HTTPS and an allowed public port while preserving its HTTP target');
  assert(JSON.stringify([...mappingField('serve-protocol').options].map(option => option.value).sort()) === JSON.stringify(['https', 'tcp', 'tls-terminated-tcp'].sort()), 'Funnel offers HTTPS, TCP and TLS-terminated TCP without an unsupported HTTP listener');
  assert(mappingField('serve-port')?.tagName === 'SELECT' && JSON.stringify([...mappingField('serve-port').options].map(option => option.value).filter(Boolean).sort()) === JSON.stringify(['443', '8443', '10000'].sort()), 'Funnel offers only its three supported public ports');
  assert(mappingWrites(beforeFunnelDraft).length === 0, 'normalizing an incompatible draft does not create a public listener');
  editMappingField('serve-port', '8080');
  await submitMapping();
  assert(mappingWrites(beforeFunnelDraft).length === 0, 'an unsupported Funnel port cannot submit a listener command');
  editMappingField('serve-port', '443');
  const publicHttpTargetFixture = {
    TCP: { '443': { HTTPS: true } },
    Web: { 'fox.ts.net:443': { Handlers: { '/': { Proxy: 'http://localhost:3000' } } } },
    AllowFunnel: { 'fox.ts.net:443': true },
  };
  canned['serve-list'] = { ok: true, status: publicHttpTargetFixture };
  canned['funnel-list'] = { ok: true, status: publicHttpTargetFixture };
  const beforePublicMapping = commandLog.length;
  await submitMapping();
  assert(JSON.stringify(mappingWrites(beforePublicMapping).map(entry => [entry.sub, entry.args])) === JSON.stringify([['funnel-set', ['https', '443', 'http://localhost:3000']]]), 'an HTTP local target is submitted with an HTTPS public Funnel listener');
  const publicHttpTargetRow = window.document.querySelectorAll('#view .card')[1]?.querySelector('.list-row');
  assert(publicHttpTargetRow?.textContent.includes('https fox.ts.net:443') && publicHttpTargetRow?.textContent.includes('http://localhost:3000'), 'the refreshed public mapping displays HTTPS separately from its HTTP local target');

  editMappingField('serve-kind', 'serve');
  assert(mappingField('serve-protocol')?.querySelector('option[value="http"]') && mappingField('serve-port')?.tagName === 'INPUT', 'returning to Serve restores HTTP and arbitrary valid listener ports');
  editMappingField('serve-protocol', 'http');
  editMappingField('serve-port', '8080');
  editMappingField('serve-target', 'http://localhost:8081');
  const beforePrivateHttpMapping = commandLog.length;
  await submitMapping();
  assert(JSON.stringify(mappingWrites(beforePrivateHttpMapping).map(entry => [entry.sub, entry.args])) === JSON.stringify([['serve-set', ['http', '8080', 'http://localhost:8081']]]), 'Serve HTTP remains HTTP instead of inheriting Funnel HTTPS restrictions');
  editMappingField('serve-protocol', 'tls-terminated-tcp');
  editMappingField('serve-port', '8443');
  editMappingField('serve-target', 'localhost:3000');
  const beforeCompatibleFunnelDraft = commandLog.length;
  editMappingField('serve-kind', 'funnel');
  assert(mappingField('serve-protocol')?.value === 'tls-terminated-tcp' && mappingField('serve-port')?.value === '8443' && mappingField('serve-target')?.value === 'localhost:3000', 'a compatible TLS-terminated TCP draft retains its protocol, allowed port and target when switching to Funnel');
  assert(mappingWrites(beforeCompatibleFunnelDraft).length === 0, 'switching a compatible draft also requires an explicit submit to publish');

}
