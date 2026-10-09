import { window, commandLog, holdNext, heldReplies, canned, overrides, flush, nav, magicDnsCard, assert } from './smoke-fixture.mjs';

export async function checkSettings() {
  console.log('backup actions show progress and retain recoverable results across pages');
  nav('settings');
  await flush();
  const backupControls = () => window.document.querySelector('[data-testid="backup-controls"]');
  const backupButton = () => backupControls()?.querySelector('button');
  const backupPath = () => window.document.querySelector('[data-testid="backup-path"]')?.textContent.trim();
  const backupError = () => window.document.querySelector('[data-testid="backup-error"]');
  const firstBackupPath = '/sdcard/Download/foxytail-backup-smoke-first.tar.gz';
  canned.backup = { ok: true, path: firstBackupPath };
  holdNext.add('backup');
  const beforeBackupReplyIndex = heldReplies.length;
  const beforeBackupClick = commandLog.length;
  assert(backupButton() && !backupButton().disabled, 'Settings exposes an enabled backup button');
  backupButton()?.click();
  assert(backupButton()?.disabled && backupButton()?.getAttribute('aria-busy') === 'true', 'clicking Backup immediately shows busy feedback before a backend response');
  backupButton()?.click();
  await flush();
  const heldBackup = heldReplies.slice(beforeBackupReplyIndex).find(reply => reply.sub === 'backup');
  const backupRequestId = window.__foxy.getTask('backup')?.call.requestId;
  assert(heldBackup && window.__foxy.getTask('backup')?.status === 'running' && commandLog.slice(beforeBackupClick).filter(entry => entry.sub === 'backup').length === 1, 'the real backup button starts one session task and rejects duplicate clicks');
  const backupProgress = window.document.querySelector('#view .task-progress');
  assert(backupProgress?.querySelector('[role="progressbar"]') && !backupProgress.querySelector('button'), 'a running backup keeps its progress indicator without an unsupported Cancel action');
  nav('dashboard');
  await flush();
  assert(window.__foxy.getTask('backup')?.status === 'running' && window.document.querySelector('.task-menu a[href="#/settings"]'), 'a running backup survives navigation and links back to Settings from activity');
  assert(!commandLog.slice(beforeBackupClick).some(entry => entry.sub === 'cancel' && entry.args[0] === backupRequestId), 'leaving Settings does not cancel its backup request');
  heldBackup?.finish();
  await flush();
  assert(window.__foxy.getTask('backup')?.status === 'done', 'a backup can complete while its original page is closed');
  nav('settings');
  await flush();
  assert(backupPath() === firstBackupPath && commandLog.slice(beforeBackupClick).filter(entry => entry.sub === 'backup').length === 1, 'returning to Settings recovers the completed archive path without running another backup');
  const copyBackupButton = window.document.querySelector('[data-testid="backup-result"] button');
  const previousCopyCommand = window.document.execCommand;
  let copiedBackupPath = null;
  window.document.execCommand = command => {
    if (command === 'copy') copiedBackupPath = window.document.querySelector('textarea[readonly]')?.value;
    return true;
  };
  copyBackupButton?.click();
  window.document.execCommand = previousCopyCommand;
  assert(copyBackupButton && copiedBackupPath === firstBackupPath, 'the recovered backup result has a working copy-path action');

  overrides.backup = [1, JSON.stringify({ ok: false, error: 'backup-archive-write-failed' }), ''];
  backupButton()?.click();
  await flush();
  assert(window.__foxy.getTask('backup')?.status === 'error' && backupError()?.textContent.includes('backup-archive-write-failed'), 'a failed backup shows its actual error instead of silently clearing the busy state');
  nav('dashboard');
  nav('settings');
  await flush();
  assert(backupError()?.textContent.includes('backup-archive-write-failed') && backupButton() && !backupButton().disabled, 'backup failure feedback and an enabled retry survive page navigation');
  assert(backupPath() === firstBackupPath, 'a failed attempt preserves the previous successful backup path');
  delete overrides.backup;
  const recoveredBackupPath = '/sdcard/Download/foxytail-backup-smoke-recovered.tar.gz';
  canned.backup = { ok: true, path: recoveredBackupPath };
  const beforeBackupRetry = commandLog.length;
  backupButton()?.click();
  await flush();
  assert(commandLog.slice(beforeBackupRetry).filter(entry => entry.sub === 'backup').length === 1 && window.__foxy.getTask('backup')?.status === 'done' && backupPath() === recoveredBackupPath && !backupError(), 'retrying a backup clears its failure and presents the new verified result');

  for (const invalidBackupResult of [{ ok: true }, { ok: true, path: '   ' }, { ok: true, path: 'relative-backup.tar.gz' }]) {
    canned.backup = invalidBackupResult;
    const earlierToasts = new Set(window.document.querySelectorAll('#toast-root .toast'));
    backupButton()?.click();
    await flush();
    const latestBackup = window.__foxy.getTask('backup');
    assert(latestBackup?.status === 'error' && latestBackup.result?.ok === false && backupError()?.textContent.trim(), 'a backup response without a valid absolute archive path is a visible task error');
    assert(backupPath() === recoveredBackupPath, 'an invalid backup result cannot replace the previous successful archive path');
    assert(![...window.document.querySelectorAll('#toast-root .toast.ok')].some(toast => !earlierToasts.has(toast)), 'an invalid backup result never emits a new success notification');
  }

  console.log('generic DNS modes preserve pending settings and report measured capabilities');
  const savedDnsSettings = structuredClone(canned['settings-get']);
  const savedDnsResponse = canned.dns;
  canned['settings-get'] = { ok: true, restartRequired: false, settings: {
    TS_MODE: 'tun', MAGIC_DNS: 'on', DNS_PORT: '1053', IPV6: 'on', SOCKS_PORT: '1099',
  } };
  nav('dashboard');
  await flush();
  const beforeDnsModeRead = commandLog.length;
  nav('settings');
  await flush();
  const dnsModeSelect = () => window.document.querySelector('[data-setting="DNS_MODE"] select');
  assert(dnsModeSelect()?.value === 'legacy' && dnsModeSelect()?.options.length === 3, 'older settings without DNS_MODE retain the compatible default and offer three generic modes');
  assert(!commandLog.slice(beforeDnsModeRead).some(entry => entry.sub === 'settings-set'), 'opening settings does not silently migrate or enable DNS interception');
  assert(/already uses|占用/.test(window.document.querySelector('[data-setting="DNS_PORT"]')?.textContent || ''), 'the DNS port setting explains how to resolve an occupied listener');
  const beforeInvalidDnsMode = commandLog.length;
  dnsModeSelect().value = 'unexpected';
  dnsModeSelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  assert(dnsModeSelect().value === 'legacy' && !commandLog.slice(beforeInvalidDnsMode).some(entry => entry.sub === 'settings-set'), 'invalid DNS mode values are restored without a backend mutation');

  console.log('transparent mode greys out when the kernel probe denies it');
  const savedDnsForGrey = canned.dns;
  canned.dns = { ok: true, mode: 'local', enabled: true, state: 'running', reason: 'local',
    listenerReady: true, interception4: false, interception6: false, repairNeeded: false,
    policyState: 'owned', suffix: 'fox.ts.net', port: 1053,
    transparentAvailable: false, transparentUnavailableReason: 'NFQUEUE kernel does not support required conntrack queue metadata' };
  nav('dashboard');
  await flush();
  nav('settings');
  await flush();
  const transparentOption = () => [...(dnsModeSelect()?.options ?? [])].find(opt => opt.value === 'transparent');
  assert(transparentOption()?.disabled === true, 'a denied transparent probe disables the kernel-dependent choice');
  const dnsModeCard = () => window.document.querySelector('[data-setting="DNS_MODE"]');
  canned['settings-get'].settings.DNS_MODE = 'transparent';
  nav('dashboard');
  await flush();
  nav('settings');
  await flush();
  assert(/kernel lacks|缺少透明分流能力/.test(dnsModeCard()?.textContent || ''), 'the transparent current value explains the kernel limitation');
  canned['settings-get'].settings.DNS_MODE = 'legacy';
  assert(/NFQUEUE kernel/.test(window.document.querySelector('[data-testid="dns-transparent-unavailable"]')?.textContent || ''), 'the actual probe reason surfaces beside the DNS mode setting');
  canned.dns = savedDnsForGrey;

  holdNext.add('settings-set');
  const heldModeIndex = heldReplies.length;
  const beforeLocalMode = commandLog.length;
  dnsModeSelect().value = 'local';
  dnsModeSelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(dnsModeSelect().disabled, 'saving a DNS mode immediately locks competing settings changes');
  await flush();
  const heldModeWrite = heldReplies.slice(heldModeIndex).find(reply => reply.sub === 'settings-set');
  assert(heldModeWrite && JSON.stringify(commandLog.slice(beforeLocalMode).filter(entry => entry.sub === 'settings-set').map(entry => entry.args)) === JSON.stringify([['DNS_MODE', 'local']]), 'local DNS mode uses the existing settings-set contract exactly once');
  canned['settings-get'].settings.DNS_MODE = 'local';
  canned['settings-get'].restartRequired = true;
  heldModeWrite?.finish();
  await flush();
  assert(dnsModeSelect().value === 'local' && window.document.querySelector('.tool-pending'), 'a saved DNS mode is visibly pending until service application');
  nav('dashboard');
  await flush();
  nav('settings');
  await flush();
  assert(dnsModeSelect().value === 'local' && window.document.querySelector('.tool-pending'), 'saved DNS mode and its pending state survive navigation');
  overrides['settings-set'] = [1, JSON.stringify({ ok: false, error: 'dns-mode-save-rejected' }), ''];
  dnsModeSelect().value = 'transparent';
  dnsModeSelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  assert(dnsModeSelect().value === 'local' && [...window.document.querySelectorAll('#toast-root .toast')].some(toast => toast.textContent.includes('dns-mode-save-rejected')), 'a rejected mode save restores the selected value and exposes the error');
  delete overrides['settings-set'];
  canned['settings-get'].settings.DNS_MODE = 'transparent';
  dnsModeSelect().value = 'transparent';
  dnsModeSelect().dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  assert(dnsModeSelect().value === 'transparent' && /DoH\s*\/\s*DoT/.test(window.document.querySelector('[data-setting="DNS_MODE"]')?.textContent || ''), 'transparent mode states the encrypted-DNS boundary without client-specific instructions');

  const localDns = { ok: true, mode: 'local', enabled: true, state: 'running', reason: 'local',
    listenerReady: true, interception4: false, interception6: false, repairNeeded: false,
    policyState: 'owned', suffix: 'fox.ts.net', port: 1054 };
  canned.dns = localDns;
  const beforeDnsModeNavigation = commandLog.filter(entry => entry.sub === 'dns').length;
  nav('tunnel');
  await flush();
  const modernDnsCard = magicDnsCard;
  const modernDnsCheck = () => window.document.querySelector('[data-testid="dns-actions"] > button');
  const modernDnsBadge = () => window.document.querySelector('[data-testid="dns-capability"] .status-badge');
  assert(commandLog.filter(entry => entry.sub === 'dns').length === beforeDnsModeNavigation && !modernDnsBadge(), 'a DNS mode change never starts an automatic inspection or fabricates an applied status');
  modernDnsCheck()?.click();
  await flush();
  assert(modernDnsBadge()?.classList.contains('tone-success') && /Local resolver ready|本地解析可用/.test(modernDnsBadge()?.textContent || ''), 'runtime local mode remains local while transparent settings are still pending');
  assert(window.document.querySelector('[data-testid="dns-endpoint"] code')?.textContent === '127.0.0.1:1054' && !/Transparent split DNS active|透明分流已启用/.test(modernDnsCard()?.textContent || ''), 'local mode reports the actual listener port without claiming interception');
  assert(!modernDnsCard()?.textContent.includes('Native DNS rules installed') && !modernDnsCard()?.textContent.includes('原生 DNS 规则已安装'), 'modern mode does not interpret deliberately disabled native interception as a failure');
  let copiedDnsEndpoint = null;
  const priorDnsCopy = window.document.execCommand;
  window.document.execCommand = command => {
    if (command === 'copy') copiedDnsEndpoint = window.document.querySelector('textarea[readonly]')?.value;
    return true;
  };
  window.document.querySelector('[data-testid="dns-endpoint"] button')?.click();
  window.document.execCommand = priorDnsCopy;
  assert(copiedDnsEndpoint === '127.0.0.1:1054', 'copy local DNS upstream copies the measured endpoint');

  const transparentDns = { ...localDns, mode: 'transparent', reason: 'running', interception4: true, interception6: true };
  const dnsCapabilityCases = [
    ['kernel unavailable', { ...transparentDns, reason: 'transparent-unavailable', interception4: false, interception6: false }, 'warning', /Local resolver only|仅本地解析可用/, true],
    ['both families active', transparentDns, 'success', /Transparent split DNS active|透明分流已启用/, true],
    ['IPv4 interception only', { ...transparentDns, reason: 'ipv6-unavailable', interception6: false }, 'success', /Transparent split DNS \(IPv4\)|透明分流（IPv4）/, true],
    ['listener unavailable', { ...transparentDns, listenerReady: false }, 'warning', /Local resolver not ready|本地解析尚未就绪/, false],
    ['unconfirmed policy', { ...transparentDns, policyState: 'unknown' }, 'warning', /Transparent split DNS inactive|透明分流未启用/, true],
    ['repair required', { ...transparentDns, repairNeeded: true }, 'warning', /Transparent split DNS inactive|透明分流未启用/, true],
    ['interception missing', { ...transparentDns, interception4: false }, 'warning', /Transparent split DNS inactive|透明分流未启用/, true],
    ['policy changed externally', { ...transparentDns, state: 'degraded', reason: 'native-policy-changed', policyState: 'changed' }, 'warning', /Native DNS policy changed|原生 DNS 策略已变更/, true],
    ['inconsistent healthy process state', { ...transparentDns, reason: 'native-policy-unavailable' }, 'warning', /Could not coordinate native DNS policy|无法协调原生 DNS 策略/, true],
    ['occupied local port', { ...localDns, state: 'degraded', reason: 'listener-failed', listenerReady: false, policyState: 'restored' }, 'warning', /port is in use|端口是否被占用/, false],
    ['missing first-party helper', { ...localDns, state: 'degraded', reason: 'missing-binary', listenerReady: false }, 'warning', /FoxyTail DNS helper not found|找不到 FoxyTail DNS 组件/, false],
    ['queue health failure', { ...transparentDns, reason: 'queue-failed' }, 'warning', /Transparent split DNS interrupted|透明分流已中断/, true],
    ['guard unavailable', { ...transparentDns, reason: 'guard-failed' }, 'warning', /guard is not ready|透明分流保护未就绪/, true],
    ['reserved mark conflict', { ...transparentDns, reason: 'capture-mark-conflict', interception4: false, interception6: false }, 'warning', /mark conflicts|标记与其他规则冲突/, true],
  ];
  for (const [name, response, tone, expected, endpointExpected] of dnsCapabilityCases) {
    canned.dns = response;
    const beforeCheck = commandLog.filter(entry => entry.sub === 'dns').length;
    modernDnsCheck()?.click();
    await flush();
    assert(modernDnsBadge()?.classList.contains('tone-' + tone) && expected.test(modernDnsBadge()?.textContent || ''), name + ': DNS badge reflects measured capability rather than process state alone');
    assert(Boolean(window.document.querySelector('[data-testid="dns-endpoint"]')) === endpointExpected, name + ': only a ready listener exposes an upstream endpoint');
    assert(commandLog.filter(entry => entry.sub === 'dns').length === beforeCheck + 1 && modernDnsCard()?.querySelectorAll('.status-badge').length === 1, name + ': one check produces one concise status without hidden probes');
  }
  for (const invalidPort of [undefined, 0, 65536, '1054']) {
    canned.dns = { ...localDns, port: invalidPort };
    modernDnsCheck()?.click();
    await flush();
    assert(!window.document.querySelector('[data-testid="dns-endpoint"]'), 'an invalid or missing DNS port never becomes a fabricated copyable endpoint');
  }
  overrides.dns = [1, JSON.stringify({ ok: false, error: 'dns-status-unavailable' }), ''];
  modernDnsCheck()?.click();
  await flush();
  assert(modernDnsCard()?.textContent.includes('dns-status-unavailable') && !modernDnsBadge() && !window.document.querySelector('[data-testid="dns-endpoint"]'), 'a failed DNS status read replaces previously successful capability and endpoint data');
  delete overrides.dns;
  canned.dns = transparentDns;
  nav('settings');
  await flush();
  nav('tunnel');
  await flush();
  assert(!modernDnsBadge(), 'returning to Tunnel does not reuse potentially stale DNS capability');
  modernDnsCheck()?.click();
  await flush();
  assert(modernDnsBadge()?.classList.contains('tone-success') && window.document.querySelector('[data-testid="dns-coexist-hint"]')?.textContent.includes('DoH'), 'a fresh successful check restores transparent status with its scope boundary');
  canned['settings-get'] = savedDnsSettings;
  canned.dns = savedDnsResponse;

}
