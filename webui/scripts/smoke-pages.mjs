import { window, ROUTES, bridge, commandLog, holdNext, heldReplies, canned, overrides, spawnLog, flush, nav, assert } from './smoke-fixture.mjs';

export async function checkPages() {
  console.log('ServeConfig protocols, paths and Funnel visibility');
  const serveFixture = {
    TCP: { '8443': { HTTPS: true }, '8080': { HTTP: true }, '2222': { TCPForward: 'localhost:22' }, '9443': { TCPForward: 'localhost:9000', TerminateTLS: 'fox.ts.net' } },
    Web: {
      'fox.ts.net:8443': { Handlers: { '/': { Proxy: 'http://localhost:3000' }, '/api': { Proxy: 'http://localhost:4000' } } },
      'fox.ts.net:8080': { Handlers: { '/docs': { Path: '/srv/docs' } } },
    },
    AllowFunnel: { 'fox.ts.net:8443': true },
  };
  canned['serve-list'] = { ok: true, status: serveFixture };
  canned['funnel-list'] = { ok: true, status: serveFixture };
  nav('serve');
  await flush();
  const serveCards = window.document.querySelectorAll('#view .card');
  assert(serveCards[0].querySelectorAll('.list-row').length === 3, 'private section contains HTTP, TCP, and TLS terminated TCP only');
  assert(serveCards[1].querySelectorAll('.list-row').length === 2, 'public section preserves both HTTPS paths');
  assert(serveCards[1].textContent.includes('https fox.ts.net:8443/api'), 'HTTPS on 8443 remains HTTPS');
  assert(!serveCards[0].textContent.includes('8443'), 'HTTPS listener is not duplicated as TCP');
  const apiRow = [...serveCards[1].querySelectorAll('.list-row')].find((row) => row.textContent.includes('/api'));
  apiRow?.querySelector('button')?.click();
  await flush();
  const cancelAction = window.document.querySelector('.md-dialog-actions button[autofocus]');
  assert(/Cancel|取消/.test(cancelAction?.textContent || ''), 'confirmation defaults to the non-destructive Cancel action');
  window.document.querySelector('.md-dialog-actions .btn-filled')?.click();
  await flush();
  assert(commandLog.some(({ sub, args }) => sub === 'funnel-del' && JSON.stringify(args) === JSON.stringify(['https', '8443', '/api'])), 'deletion preserves HTTPS protocol and the selected path');

  console.log('saved settings distinguish pending application');
  nav('settings');
  await flush();
  assert(window.document.querySelector('#view').textContent.includes('fd7a:115c:a1e0::/48'), 'IPv6 switch explains the required routed subnet');
  const portField = window.document.querySelector('#view input[type="number"]');
  assert(portField, 'numeric settings field exists');
  if (portField) {
    portField.value = '1100';
    portField.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  await flush();
  assert(window.document.querySelector('#view .tool-pending'), 'saved but unapplied settings show a persistent restart notice');
  canned.control = { ok: true, applied: false, restartRequired: true };
  canned['settings-get'].restartRequired = true;
  const restartButton = window.document.querySelector('#view .tool-pending button');
  restartButton?.click();
  await flush();
  assert(commandLog.some(({ sub, args }) => sub === 'control' && args[0] === 'restart'), 'settings can apply through service restart');
  assert(window.document.querySelector('#view .tool-pending'), 'a newer configuration revision stays pending after restart');
  const latestToast = [...window.document.querySelectorAll('#toast-root .toast')].at(-1)?.textContent || '';
  assert(!/配置已应用|Configuration applied/.test(latestToast), 'partial application does not report all settings applied');
  canned.control = { ok: true, applied: true, restartRequired: false };
  canned['settings-get'].restartRequired = false;
  window.document.querySelector('#view .tool-pending button')?.click();
  await flush();
  assert(!window.document.querySelector('#view .tool-pending'), 'restart that applies the latest revision clears the pending notice');

  console.log('lightweight page reads and explicit DNS checks');
  assert(!commandLog.some(({ sub }) => sub === 'key-expiry'), 'Dashboard derives key expiry from the shared status snapshot');
  nav('more');
  await flush();
  const beforeTraffic = commandLog.length;
  nav('traffic');
  await flush();
  const trafficCalls = commandLog.slice(beforeTraffic);
  assert(!trafficCalls.some(({ sub }) => sub === 'apps' || sub === 'peers'), 'empty traffic skips package enumeration and peer-name queries');
  nav('routing');
  await flush();
  assert(!commandLog.slice(beforeTraffic).some(({ sub }) => sub === 'apps'), 'native TUN routing skips unsupported per-app enumeration');
  canned.dns = { ok: true, enabled: false, state: 'stopped', reason: 'disabled', upstreamNative: true, suffix: 'fox.ts.net' };
  const beforeDns = commandLog.filter(({ sub }) => sub === 'dns').length;
  nav('tunnel');
  await flush();
  assert(commandLog.filter(({ sub }) => sub === 'dns').length === beforeDns, 'DNS inspection is not an automatic page probe');
  const dnsButton = [...window.document.querySelectorAll('#view button')].find((button) => /Check DNS status|检查 DNS 状态/.test(button.textContent));
  assert(dnsButton, 'manual DNS status check is available');
  dnsButton?.click();
  await flush();
  const dnsCard = [...window.document.querySelectorAll('#view .card')].find((card) => card.textContent.includes('MagicDNS'));
  assert(dnsCard?.textContent.includes('Tailnet MagicDNS may still be enabled') || dnsCard?.textContent.includes('不代表 Tailnet MagicDNS 关闭'), 'disabled local resolver is distinguished from Tailnet MagicDNS');
  assert(dnsCard?.textContent.includes('fox.ts.net') && /Detected|已检测到|已检测/.test(dnsCard?.textContent || ''), 'DNS inspection shows native routing configuration and suffix');
  const originalDns = canned.dns;
  canned.dns = { ...originalDns, enabled: true, state: 'running', reason: 'ipv6-unavailable' };
  dnsButton?.click();
  await flush();
  const ipv4OnlyDns = dnsCard?.querySelector('.status-badge');
  assert(ipv4OnlyDns?.classList.contains('tone-warning') && /Transparent IPv6 DNS forwarding unavailable\.|IPv6 DNS 透明转发不可用/.test(ipv4OnlyDns.textContent), 'DNS warns specifically about unavailable transparent IPv6 forwarding without claiming IPv6 connectivity is disabled');
  assert(dnsCard?.querySelectorAll('.status-badge').length === 1 && !dnsCard.textContent.includes('ipv6-unavailable'), 'partial DNS availability has one localized status without duplicate indicators');
  assert(!dnsCard?.querySelector('[data-testid="dns-ipv6-path"]'), 'an older backend without path fields does not invent an IPv6 detection result');
  canned.dns = { ...originalDns, enabled: true, state: 'running', reason: 'running' };
  dnsButton?.click();
  await flush();
  assert(dnsCard?.querySelector('.status-badge.tone-success') && !dnsCard.textContent.includes('IPv6'), 'a fresh healthy DNS result replaces the earlier IPv6 limitation');
  const dnsPathCases = [
    ['available', 'not-needed', /^(Native|原生)$/],
    ['module-loaded', 'loaded', /^(Kernel module|内核模块)$/],
    ['fallback', 'missing', /^(Compatibility \(No module available\)|兼容 \(无可用模块\))$/],
    ['fallback', 'load-failed', /^(Compatibility \(Module load failed\)|兼容 \(模块加载失败\))$/],
    ['fallback', 'loader-unavailable', /^(Compatibility \(Module loader unavailable\)|兼容 \(无模块加载工具\))$/],
    ['fallback', 'not-checked', /^(Compatibility \(Module not checked\)|兼容 \(模块尚未检查\))$/],
    ['disabled', 'not-needed', /^(Disabled|已关闭)$/],
  ];
  for (const [interception, moduleStatus, expectedLabel] of dnsPathCases) {
    canned.dns = { ...originalDns, enabled: true, state: 'running', reason: interception === 'fallback' ? 'ipv6-unavailable' : 'running', ipv6DnsInterception: interception, ipv6ModuleStatus: moduleStatus };
    const callsBeforePathCheck = commandLog.filter(entry => entry.sub === 'dns').length;
    dnsButton?.click();
    await flush();
    const pathRow = dnsCard?.querySelector('[data-testid="dns-ipv6-path"]');
    assert(pathRow && expectedLabel.test(pathRow.querySelector('.v')?.textContent || ''), interception + '/' + moduleStatus + ': manual DNS inspection identifies the detected IPv6 path');
    assert(Boolean(pathRow?.querySelector('.tool-hint')) === (interception === 'fallback'), interception + '/' + moduleStatus + ': only the compatibility path explains its interception limit');
    assert(dnsCard?.querySelectorAll('.status-badge').length === 1 && /^(Running|运行中)$/.test(dnsCard.querySelector('.status-badge')?.textContent || ''), interception + '/' + moduleStatus + ': the badge reports overall DNS health without duplicating the path');
    assert(commandLog.filter(entry => entry.sub === 'dns').length === callsBeforePathCheck + 1, interception + '/' + moduleStatus + ': detection does not trigger additional DNS requests');
  }

  // Exercise translated detection details through the real language setting.
  const previousLanguage = window.document.documentElement.lang.startsWith('zh') ? 'zh' : 'en';
  nav('settings');
  await flush();
  const languageSelector = () => [...window.document.querySelectorAll('#view select')].find(select => select.querySelector('option[value="zh"]') && select.querySelector('option[value="en"]'));
  const languageControl = languageSelector();
  assert(languageControl, 'the UI language can be changed for the DNS inspection');
  if (languageControl) {
    languageControl.value = 'zh';
    languageControl.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  canned.dns = { ...originalDns, enabled: true, state: 'running', reason: 'ipv6-unavailable', ipv6DnsInterception: 'fallback', ipv6ModuleStatus: 'missing' };
  const beforeLocalizedDns = commandLog.filter(entry => entry.sub === 'dns').length;
  nav('tunnel');
  await flush();
  assert(commandLog.filter(entry => entry.sub === 'dns').length === beforeLocalizedDns && !window.document.querySelector('[data-testid="dns-ipv6-path"]'), 'changing language and reopening Tunnel leaves DNS inspection manual');
  const localizedDnsCard = [...window.document.querySelectorAll('#view .card')].find(card => card.querySelector('h2')?.textContent.includes('MagicDNS'));
  localizedDnsCard?.querySelector('button')?.click();
  await flush();
  const localizedPath = localizedDnsCard?.querySelector('[data-testid="dns-ipv6-path"]');
  assert(localizedPath?.querySelector('.k')?.textContent === 'IPv6 DNS 路径' && localizedPath.querySelector('.v')?.textContent === '兼容 (无可用模块)' && localizedPath.querySelector('.tool-hint')?.textContent === '兼容路径不拦截 IPv6 DNS', 'Chinese detection copy distinguishes missing NAT modules from IPv6 connectivity');
  nav('settings');
  await flush();
  const restoreLanguage = languageSelector();
  if (restoreLanguage) {
    restoreLanguage.value = previousLanguage;
    restoreLanguage.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  canned.dns = originalDns;

  console.log('native asynchronous spawn selection, errors and shell quoting');
  assert(spawnLog.length > 0 && bridge.nativeExecCount === 0, 'modern manager uses spawn for every read, task and cancellation');
  assert(spawnLog.every((entry) => entry.args === '[]' && entry.options === '{}'), 'spawn never concatenates unquoted arguments or environment options');
  overrides['login-authkey'] = [0, '{\n  "ok": true,\n  "message": "streamed"\n}', ''];
  const hostileArgument = "alpha';$(echo unsafe)`echo unsafe`\nlast";
  const quotedCall = window.__foxy.startTask('spawn-quote', 'login-authkey', hostileArgument);
  await flush();
  assert((await quotedCall.promise).message === 'streamed', 'line-oriented stdout reconstructs complete multiline JSON');
  assert(spawnLog.some(({ cmd }) => cmd.endsWith("'alpha'\\'';$(echo unsafe)`echo unsafe`\nlast'")), 'quotes, substitutions and newlines remain within the prequoted command argument');
  delete overrides['login-authkey'];
  overrides['mode-get'] = [1, '', 'first stderr line\nsecond stderr line'];
  const stderrFailure = window.__foxy.startTask('spawn-stderr', 'mode-get');
  await flush();
  assert((await stderrFailure.promise).error === 'first stderr line\nsecond stderr line', 'stderr lines survive a nonzero streamed exit');
  delete overrides['mode-get'];
  overrides['subnet-routes-get'] = [1, JSON.stringify({
    ok: false, error: 'subnet-inspection-failed', acceptRoutes: true, mode: 'tun', ipv6Enabled: true, peers: [],
  }, null, 2), 'subnet command exited with an error'];
  const beforePartialSpawn = spawnLog.length;
  const partialSubnetCall = window.__foxy.startTask('spawn-partial-subnet', 'subnet-routes-get');
  await flush();
  const partialSubnetResult = await partialSubnetCall.promise;
  assert(spawnLog.slice(beforePartialSpawn).some(entry => entry.cmd.includes('subnet-routes-get')) && bridge.nativeExecCount === 0, 'partial subnet errors use the native streamed stdout and nonzero exit path');
  assert(partialSubnetResult.ok === false && partialSubnetResult.error === 'subnet-inspection-failed' && partialSubnetResult.acceptRoutes === true && partialSubnetResult.mode === 'tun' && partialSubnetResult.ipv6Enabled === true, 'a failed streamed command preserves authoritative preference fields while retaining ok false');
  overrides['subnet-routes-get'] = [1, JSON.stringify({ ok: true, acceptRoutes: true, mode: 'tun', ipv6Enabled: true }), 'subnet-command-failed'];
  const invalidSubnetSuccess = window.__foxy.startTask('spawn-false-success', 'subnet-routes-get');
  await flush();
  assert((await invalidSubnetSuccess.promise).ok === false && window.__foxy.getTask('spawn-false-success')?.status === 'error', 'a nonzero exit cannot become successful because its JSON claims ok true');
  delete overrides['subnet-routes-get'];
  bridge.throwSpawn = true;
  const failedSpawn = window.__foxy.startTask('spawn-error', 'mode-get');
  await flush();
  assert((await failedSpawn.promise).error.includes('spawn-shell-unavailable'), 'synchronous spawn failure settles immediately instead of waiting for timeout');
  bridge.throwSpawn = false;

  console.log('redesigned navigation, filtering and explicit actions');
  for (const route of ROUTES) {
    nav(route);
    assert(window.document.querySelectorAll('#view h1').length === 1, route + ': one accessible page heading');
    const selected = window.document.querySelectorAll('#bottom-nav [aria-current="page"]');
    const parentRoute = ['dashboard', 'peers', 'exitnodes', 'traffic'].includes(route) ? route : 'more';
    assert(selected.length === 1 && selected[0].getAttribute('href') === '#/' + parentRoute, route + ': navigation identifies the active destination');
  }
  await flush();
  canned.peers.peers.push({ ...canned.peers.peers[0], id: 'p2', hostname: 'offline-tablet', ip: '100.64.0.3', ips: undefined, online: false });
  nav('peers');
  assert(window.document.querySelector('#view [aria-busy="true"]'), 'device inventory immediately exposes a loading state');
  await flush();
  const search = window.document.querySelector('#view input[type="search"]');
  const beforeSearch = commandLog.length;
  const peerIpv6 = canned.peers.peers[0].ips[1];
  const peerRow = window.document.querySelector('.network-peer-row');
  assert(peerRow?.textContent.includes('100.64.0.2') && peerRow.textContent.includes(peerIpv6), 'device list preserves IPv4 and IPv6 even with IPv6 routing disabled');
  search.value = peerIpv6.toUpperCase();
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(window.document.querySelectorAll('.network-peer-row').length === 1 && window.document.querySelector('.network-peer-row').textContent.includes('peer-one'), 'device search matches IPv6 addresses case-insensitively');
  let copiedAddress;
  const originalCopy = window.document.execCommand;
  window.document.execCommand = () => { copiedAddress = window.document.querySelector('body > textarea')?.value; return true; };
  try {
    window.document.querySelector(`.network-copy-inline[aria-label$="${peerIpv6}"]`)?.click();
    assert(copiedAddress === peerIpv6, 'device list copies the selected IPv6 address');
    window.document.querySelector('.network-peer-main')?.click();
    await flush();
    const peerDialog = window.document.querySelector('dialog[open]');
    assert(peerDialog?.querySelectorAll('.network-address').length === 2 && peerDialog.textContent.includes(peerIpv6), 'device details retain both address families');
    copiedAddress = undefined;
    peerDialog?.querySelector(`button[aria-label$="${peerIpv6}"]`)?.click();
    assert(copiedAddress === peerIpv6, 'device details copy the selected IPv6 address');
    peerDialog?.close();
  } finally {
    window.document.execCommand = originalCopy;
  }
  search.value = '100.64.0.3';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(window.document.querySelectorAll('.network-peer-row').length === 1 && window.document.querySelector('.network-peer-row').textContent.includes('offline-tablet'), 'device search matches IP addresses');
  const onlineFilter = [...window.document.querySelectorAll('#view .filter-chip')].find(button => /^(Online|在线)$/.test(button.textContent));
  onlineFilter?.click();
  assert(window.document.querySelectorAll('.network-peer-row').length === 0, 'device search combines with online filtering');
  assert(commandLog.length === beforeSearch, 'search and filters never launch native bridge calls');
  await checkPeerProbes();

  nav('exitnodes');
  await flush();
  const beforeSelection = commandLog.length;
  window.document.querySelector('input[name="exit-node"][value="p1"]')?.click();
  await flush();
  assert(!commandLog.slice(beforeSelection).some(({ sub }) => sub === 'exitnode-set'), 'selecting an exit does not change the connection');
  canned['exitnode-set'] = { ok: true };
  const applyExit = [...window.document.querySelectorAll('#view button')].find(button => /Apply selected exit|应用所选出口/.test(button.textContent));
  assert(applyExit && !applyExit.disabled, 'a valid changed exit selection enables the explicit Apply action');
  applyExit?.click();
  await flush();
  assert(commandLog.slice(beforeSelection).filter(({ sub }) => sub === 'exitnode-set').length === 1 && commandLog.some(({ sub, args }) => sub === 'exitnode-set' && args[0] === '100.64.0.2'), 'Apply changes the exit exactly once using the selected peer IP');

  nav('logs');
  await flush();
  const beforeLogSearch = commandLog.length;
  const logSearch = window.document.querySelector('#view .tool-log-controls input');
  logSearch.value = 'TWO';
  logSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert(window.document.querySelectorAll('.tool-log-line').length === 1 && window.document.querySelector('.tool-log-line')?.textContent.includes('line two'), 'log filtering is case insensitive by default');
  const caseSwitch = [...window.document.querySelectorAll('#view [role="switch"]')].find(input => /Case sensitive|区分大小写/.test(input.getAttribute('aria-label') || ''));
  caseSwitch?.click();
  assert(window.document.querySelectorAll('.tool-log-line').length === 0, 'case sensitive search respects capitalization');
  assert(commandLog.length === beforeLogSearch, 'log search does not reread the device log');
  const liveSwitch = [...window.document.querySelectorAll('#view [role="switch"]')].find(input => /Auto-refresh|自动刷新/.test(input.getAttribute('aria-label') || ''));
  liveSwitch?.click();
  assert(liveSwitch && !liveSwitch.checked && /paused|已暂停/.test(window.document.querySelector('#view').textContent), 'auto-refresh can be paused with visible feedback');

  const beforeAdvanced = commandLog.length;
  nav('settings');
  await flush();
  assert([...window.document.querySelectorAll('#view [role="switch"]')].every(input => input.getAttribute('aria-label')?.trim()), 'every settings switch has an accessible name');
  assert(!commandLog.slice(beforeAdvanced).some(({ sub }) => sub === 'context-get'), 'advanced configuration is not eagerly loaded');

  console.log('rejected settings and post-mutation refresh races');
  const ipv6 = window.document.querySelector('[data-setting="IPV6"] input');
  assert(ipv6 && !ipv6.checked, 'IPv6 starts disabled in the server snapshot');
  overrides['settings-set'] = [1, JSON.stringify({ ok: false, error: 'IPv6 subnet required' }), ''];
  ipv6?.click();
  await flush();
  assert(ipv6 && !ipv6.checked, 'a rejected switch change rolls back the native checked state');
  delete overrides['settings-set'];

  nav('serve');
  await flush();
  holdNext.add('funnel-list');
  const publicCard = window.document.querySelectorAll('#view .card')[1];
  [...publicCard.querySelectorAll('button')].find(button => /^(Refresh|刷新)$/.test(button.textContent))?.click();
  await flush();
  const staleFunnel = heldReplies.find(reply => reply.sub === 'funnel-list');
  assert(staleFunnel, 'a pre-mutation service refresh is in flight');
  const changedServeFixture = JSON.parse(JSON.stringify(serveFixture));
  delete changedServeFixture.Web['fox.ts.net:8443'].Handlers['/api'];
  canned['funnel-list'] = { ok: true, status: changedServeFixture };
  const selectedPath = [...publicCard.querySelectorAll('.list-row')].find(row => row.textContent.includes('/api'));
  selectedPath?.querySelector('button')?.click();
  await flush();
  window.document.querySelector('.md-dialog-actions .btn-filled')?.click();
  await flush();
  staleFunnel?.finish();
  await flush();
  assert(!window.document.querySelectorAll('#view .card')[1].textContent.includes('/api'), 'a stale refresh cannot resurrect a deleted service mapping');

  nav('files');
  await flush();
  holdNext.add('files-inbox');
  const inboxCard = window.document.querySelector('#view .card');
  [...inboxCard.querySelectorAll('button')].find(button => /^(Refresh|刷新)$/.test(button.textContent))?.click();
  await flush();
  const staleInbox = heldReplies.find(reply => reply.sub === 'files-inbox');
  assert(staleInbox, 'an inbox refresh is in flight before receiving');
  canned['files-inbox'] = { ok: true, files: [{ name: 'new-arrival.txt', size: 20, mtime: 1700000000 }] };
  canned['file-receive'] = { ok: true };
  window.__foxy.startTask('file-receive', 'file-receive');
  await flush();
  staleInbox?.finish();
  await flush();
  assert(window.document.querySelector('#view').textContent.includes('new-arrival.txt'), 'receive completion queues a fresh inbox read after an older refresh');

  nav('settings');
  await flush();
  canned.restore = { ok: true, previous: '/data/adb/foxytail/backups/before-restore', note: 'Hooks staged in /data/adb/foxytail/backups/restored-hooks' };
  canned['settings-get'].restartRequired = true;
  const restoreInput = window.document.querySelector('#restore-backup');
  restoreInput.value = canned['backup-list'].backups[0].path;
  restoreInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  window.document.querySelector('.restore-preview')?.click();
  await flush();
  window.document.querySelector('.restore-apply')?.click();
  await flush();
  window.document.querySelector('.md-dialog-actions .btn-filled')?.click();
  await flush();
  assert(commandLog.findLast(entry => entry.sub === 'restore')?.args.join('|') === [restoreInput.value, canned['restore-preview'].sha256].join('|'), 'restore submits the selected archive and preview hash');
  assert(window.document.querySelector('[data-testid="restore-previous"]')?.textContent === canned.restore.previous, 'restore keeps the previous configuration location visible');
  assert(window.document.querySelector('[data-testid="restore-note"]')?.textContent === canned.restore.note, 'restore keeps the hook staging instructions visible');

  console.log('exit confirmation waits for a snapshot started after the mutation');
  canned.status = { ...canned.status, backend: 'Running', exitNode: null };
  await window.__foxy.refreshStatus();
  nav('exitnodes');
  await flush();
  holdNext.add('status');
  const statusCount = commandLog.filter(entry => entry.sub === 'status').length;
  const oldStatusRead = window.__foxy.refreshStatus();
  await flush();
  const staleStatus = heldReplies.find(reply => reply.sub === 'status');
  assert(staleStatus, 'a status read that began before the exit change is held');
  window.document.querySelector('input[name="exit-node"][value="p1"]')?.click();
  const applyAfterOldRead = [...window.document.querySelectorAll('#view button')].find(button => /Apply selected exit|应用所选出口/.test(button.textContent));
  applyAfterOldRead?.click();
  await flush();
  assert(window.document.querySelector('input[name="exit-node"]:checked')?.value === 'p1', 'the requested exit remains selected while its status is unconfirmed');
  assert(commandLog.filter(entry => entry.sub === 'status').length === statusCount + 1, 'post-mutation status waits for the old read rather than launching concurrently');
  const queuedA = window.__foxy.refreshStatus({ afterCurrent: true });
  const queuedB = window.__foxy.refreshStatus({ afterCurrent: true });
  assert(queuedA === queuedB, 'multiple post-mutation refreshes share a single queued read');
  canned.status = { ...canned.status, exitNode: { ...canned.exitnodes.peers[0], rx: 0, tx: 0 } };
  staleStatus?.finish();
  await flush();
  await Promise.all([oldStatusRead, queuedA, queuedB]);
  assert(commandLog.filter(entry => entry.sub === 'status').length === statusCount + 2, 'exactly one fresh status read follows the stale response');
  const confirmedExit = window.document.querySelector('input[name="exit-node"]:checked');
  assert(confirmedExit?.value === 'p1' && /Current|当前/.test(confirmedExit.closest('label').textContent), 'fresh confirmation marks the selected radio as the current exit');
  overrides.status = [1, JSON.stringify({ ok: false, error: 'status-unavailable' }), ''];
  await window.__foxy.refreshStatus();
  assert(!window.document.querySelector('.network-current-exit .network-small-badge'), 'an unavailable status is not mislabeled as a confirmed current exit');
  delete overrides.status;
  await window.__foxy.refreshStatus();

  console.log('exit preferences require a readable backend, including clear confirmation');
  {
    const savedStatus = canned.status;
    const localExit = () => window.document.querySelector('input[name="exit-node"][value=""]');
    const exitApply = () => window.document.querySelector('.network-apply-bar .btn-filled');
    const confirmingExit = () => /Change sent; waiting for gateway confirmation|变更已发送，等待当前出口确认/.test(window.document.querySelector('.network-apply-bar')?.textContent || '');
    const currentExitBadges = () => window.document.querySelectorAll('#view .network-small-badge');
    for (const [daemon, backend, known] of [
      ['running', 'Running', true],
      ['running', 'NeedsLogin', true],
      ['stopped', '-', false],
      ['running', 'unreachable', false],
    ]) {
      canned.status = { ...savedStatus, daemon, backend, exitNode: null };
      await window.__foxy.refreshStatus();
      assert(localExit()?.checked === known && localExit()?.disabled === !known && currentExitBadges().length === Number(known), daemon + '/' + backend + ': only readable exit preferences select and mark the local exit current');
      assert(Boolean(window.document.querySelector('.network-current-exit')) === !known && exitApply()?.disabled, daemon + '/' + backend + ': unknown preferences expose recovery without enabling Apply');
    }
    const liveDaemon = window.document.querySelector('#app-header [role="switch"]');
    assert(liveDaemon?.checked && !liveDaemon.indeterminate && !liveDaemon.disabled, 'unreadable exit preferences do not prevent stopping the confirmed live daemon');
    canned.status = savedStatus;
    await window.__foxy.refreshStatus();
    overrides.status = [1, JSON.stringify({ ok: false, error: 'exit-status-read-failed' }), ''];
    await window.__foxy.refreshStatus();
    assert(!window.document.querySelector('input[name="exit-node"]:checked') && currentExitBadges().length === 0 && localExit()?.disabled && exitApply()?.disabled, 'a failed status read invalidates the cached current exit and disables preference changes');
    delete overrides.status;
    window.document.querySelector('.network-current-exit button')?.click();
    await flush();
    assert(window.document.querySelector('input[name="exit-node"]:checked')?.value === 'p1' && currentExitBadges().length === 1 && !localExit()?.disabled, 'retrying a failed status read restores the confirmed exit preference');

    localExit()?.click();
    overrides['exitnode-clear'] = [1, JSON.stringify({ ok: false, error: 'exit-clear-rejected' }), ''];
    const beforeClear = commandLog.length;
    const earlierToasts = new Set(window.document.querySelectorAll('#toast-root .toast'));
    const newClearSuccess = () => [...window.document.querySelectorAll('#toast-root .toast.ok')].some(toast => !earlierToasts.has(toast) && /Exit node cleared|已取消出口节点/.test(toast.textContent));
    exitApply()?.click();
    await flush();
    assert([...window.document.querySelectorAll('#toast-root .toast.err')].some(toast => toast.textContent.includes('exit-clear-rejected')) && !confirmingExit() && !exitApply()?.disabled, 'a rejected exit clear exposes its error and allows retry');
    assert(!localExit()?.closest('label').querySelector('.network-small-badge') && !newClearSuccess(), 'a rejected clear never marks the local exit current or reports success');
    delete overrides['exitnode-clear'];
    canned['exitnode-clear'] = { ok: true };
    canned.status = { ...savedStatus, backend: 'unreachable', exitNode: null };
    exitApply()?.click();
    await flush();
    assert(confirmingExit() && currentExitBadges().length === 0 && localExit()?.disabled && exitApply()?.disabled && !newClearSuccess(), 'an acknowledged clear followed by unreachable status stays pending without a current badge or success toast');

    overrides.status = [1, JSON.stringify({ ok: false, error: 'exit-clear-confirmation-failed' }), ''];
    window.document.querySelector('.network-apply-bar .btn-text')?.click();
    await flush();
    assert(confirmingExit() && currentExitBadges().length === 0 && !newClearSuccess(), 'a failed confirmation read preserves the pending clear without claiming success');
    delete overrides.status;
    canned.status = savedStatus;
    window.document.querySelector('.network-apply-bar .btn-text')?.click();
    await flush();
    assert(confirmingExit() && !localExit()?.closest('label').querySelector('.network-small-badge') && !newClearSuccess(), 'a recovered snapshot with the old exit still cannot confirm the pending clear');
    canned.status = { ...savedStatus, exitNode: null };
    window.document.querySelector('.network-apply-bar .btn-text')?.click();
    await flush();
    assert(!confirmingExit() && localExit()?.checked && !localExit()?.disabled && localExit()?.closest('label').querySelector('.network-small-badge') && newClearSuccess(), 'a fresh readable snapshot with no exit confirms the clear and restores controls');
    assert(commandLog.slice(beforeClear).filter(entry => entry.sub === 'exitnode-clear').length === 2, 'confirmation retries only read status and never repeat the clear mutation');
    canned.status = savedStatus;
    delete canned['exitnode-clear'];
    await window.__foxy.refreshStatus();
  }

  console.log('absent interface samples and recorded zero traffic are distinct');
  canned.traffic = { ok: true, hours: [{ hour: 0, samples: 0, iface: { rx: 0, tx: 0 } }], days: [], topn: [] };
  nav('traffic');
  await flush();
  assert(!window.document.querySelector('#view svg[role="img"]') && window.document.querySelector('.network-traffic-empty'), 'missing interface samples render an empty state instead of a fabricated zero chart');
  canned.traffic.hours[0].samples = 1;
  nav('more');
  nav('traffic');
  await flush();
  assert(window.document.querySelector('#view svg[role="img"]') && !window.document.querySelector('.network-traffic-empty'), 'a recorded zero sample renders the chart instead of an empty state');

}

export async function checkPeerProbes() {
  console.log('per-address peer probes and live device details');
  const previousPeers = structuredClone(canned.peers);
  const previousPing = canned['peer-ping'];
  const peer = { ...canned.peers.peers[0], online: true, ips: ['100.64.0.2', 'fd7a:115c:a1e0::2'] };
  canned.peers = { ok: true, peers: [peer] };
  const probe = ip => window.document.querySelector(`[data-peer-probe="${ip}"]`);
  const openDetails = () => window.document.querySelector('.network-peer-main')?.click();
  const refreshPeers = () => window.document.querySelector('.network-inventory-summary button')?.click();
  try {
    nav('more'); await flush(); nav('peers'); await flush();
    const beforeOpen = commandLog.length;
    openDetails(); await flush();
    assert(!commandLog.slice(beforeOpen).some(entry => entry.sub === 'peer-ping'), 'opening device details never sends an unsolicited connectivity probe');
    assert(peer.ips.every(ip => probe(ip)?.querySelector('button')), 'each advertised address has its own explicit probe action');
    canned['peer-ping'] = { ok: true, peerId: peer.id, ip: peer.ips[0], latencyMs: 4, path: 'direct', via: '192.0.2.1:41641' };
    probe(peer.ips[0])?.querySelector('button')?.click(); await flush();
    assert(/Direct|直连/.test(probe(peer.ips[0])?.textContent || '') && probe(peer.ips[0])?.textContent.includes('4 ms'), 'IPv4 displays the response path and measured latency, independently of the peer Relay field');
    canned['peer-ping'] = { ok: true, peerId: peer.id, ip: peer.ips[1], latencyMs: 23, path: 'derp', via: 'DERP(tok)' };
    holdNext.add('peer-ping');
    const firstHeld = heldReplies.length;
    probe(peer.ips[1])?.querySelector('button')?.click(); await flush();
    const reply = heldReplies.slice(firstHeld).find(entry => entry.sub === 'peer-ping');
    assert(reply && probe(peer.ips[1])?.querySelector('.task-progress'), 'IPv6 probing exposes cancellable progress');
    nav('more'); await flush();
    assert(window.__foxy.getTask(`peer-ping:${peer.id}:${peer.ips[1]}`)?.status === 'running', 'an explicit peer probe survives navigation');
    nav('peers'); await flush(); openDetails(); await flush();
    assert(probe(peer.ips[1])?.querySelector('.task-progress'), 'reopening the peer adopts its in-flight address probe');
    reply?.finish(); await flush();
    assert(probe(peer.ips[1])?.textContent.includes('DERP(tok)') && probe(peer.ips[1])?.textContent.includes('23 ms') && probe(peer.ips[0])?.textContent.includes('4 ms'), 'IPv6 and IPv4 results stay separate after navigation');
    assert(JSON.stringify(commandLog.slice(beforeOpen).filter(entry => entry.sub === 'peer-ping').map(entry => entry.args)) === JSON.stringify(peer.ips.map(ip => [peer.id, ip])), 'probing forwards the selected peer identity and exact address only');
    canned.peers.peers[0] = { ...peer, hostname: 'updated-peer', online: false, rxBytes: 9999 };
    refreshPeers(); await flush();
    const dialog = window.document.querySelector('dialog[open]');
    assert(dialog?.textContent.includes('updated-peer') && /Offline|离线/.test(dialog.querySelector('.network-device-heading')?.textContent || ''), 'an open device detail tracks refreshed identity and online state by id');
    holdNext.add('peer-ping');
    probe(peer.ips[0])?.querySelector('button')?.click(); await flush();
    probe(peer.ips[0])?.querySelector('.task-progress button')?.click(); await flush();
    assert(window.__foxy.getTask(`peer-ping:${peer.id}:${peer.ips[0]}`)?.status === 'cancelled' && /Cancelled|已取消/.test(probe(peer.ips[0])?.textContent || ''), 'cancelling a peer probe settles only its selected address task');
    overrides['peer-ping'] = [1, JSON.stringify({ ok: false, error: 'peer-test-no-reply' }), ''];
    probe(peer.ips[0])?.querySelector('button')?.click(); await flush();
    assert(probe(peer.ips[0])?.textContent.includes('peer-test-no-reply'), 'peer probe errors are visible with a retry action');
    delete overrides['peer-ping'];
    canned['peer-ping'] = { ok: true, peerId: 'different-peer', ip: peer.ips[0], latencyMs: 0, path: 'direct', via: '192.0.2.1:1' };
    probe(peer.ips[0])?.querySelector('button')?.click(); await flush();
    assert(probe(peer.ips[0])?.querySelector('.state-box') && !probe(peer.ips[0])?.textContent.includes('0 ms'), 'a mismatched success payload cannot claim connectivity for the selected peer');
    canned.peers = { ok: true, peers: [] };
    refreshPeers(); await flush();
    assert(!window.document.querySelector('dialog[open]'), 'a peer removed from the fresh device list closes its stale detail');
  } finally {
    canned.peers = previousPeers;
    if (previousPing === undefined) delete canned['peer-ping']; else canned['peer-ping'] = previousPing;
    delete overrides['peer-ping'];
    nav('more'); await flush();
  }
}
