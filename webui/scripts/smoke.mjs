#!/usr/bin/env node
// pnpm smoke builds the real app once; fixtures exercise native envelopes only.
import { readFileSync } from 'node:fs';
import { boot, assert, checks, failures, flush, copy } from './smoke-fixture.mjs';

async function scenario(name, run) {
  console.log(name);
  const h = await boot();
  try { await run(h); assert(h.fixture.unsupported.length === 0, name + ': all exercised commands are explicit fixture cases'); }
  catch (error) { failures.push(name + ': ' + error.stack); }
  finally { h.close(); }
}

async function openContext({ nav, window }) {
  await nav('settings');
  const advanced = window.document.querySelector('.page-transition:not([hidden]) details.tool-disclosure');
  advanced.open = true; advanced.dispatchEvent(new window.Event('toggle')); await flush();
  return window.document.querySelector('[data-testid="context-rules"]');
}

await scenario('Files gates stale destructive actions and reflects locked rows', async ({ fixture, nav, window, button, click, confirm }) => {
  await nav('files');
  const card = window.document.querySelector('.files-page .card');
  const clear = () => button('files_clear', card);
  const deletion = () => button('files_delete', card);
  const row = () => card.querySelector('.files-row-main');
  const refresh = () => click(button('tools_refresh', card));
  const mutations = () => fixture.log.filter(r => r.action === 'control.mutate' && ['file-clear', 'file-delete', 'file-delete-many'].includes(r.args.command)).length;
  assert(!clear().disabled && !deletion().disabled, 'fresh inbox permits confirmed deletion');
  click(button('ft_matches', card)); await flush();
  fixture.holdNext.add('files-inbox'); refresh(); await flush();
  assert(button('ft_batch_delete', card).disabled && row().disabled, 'pending refresh also disables batch deletion and selection rows');
  assert(clear().disabled && deletion().disabled, 'pending refresh gates clear and individual deletion');
  fixture.held.findLast(r => r.key === 'files-inbox').finish(); await flush();
  click(button('ft_deselect', card)); await flush();
  click(clear()); await flush();
  fixture.overrides.set('files-inbox', { ok: false, error: 'Inbox refresh failed' });
  refresh(); await flush();
  assert(clear().disabled && deletion().disabled && button('ft_matches', card).disabled, 'failed refresh gates all destructive and selection entry points');
  assert(card.textContent.includes('Inbox refresh failed') && card.querySelectorAll('.files-inbox-row').length === 2, 'failed refresh preserves cached rows with visible error');
  await confirm(true);
  assert(mutations() === 0, 'confirmation rechecks freshness before submitting clear');
  clear().click(); deletion().click(); await flush();
  assert(mutations() === 0 && !window.document.querySelector('dialog[open]'), 'disabled stale actions cannot open confirmation or submit');
  fixture.overrides.delete('files-inbox'); refresh(); await flush();
  assert(!clear().disabled && !deletion().disabled, 'successful refresh restores destructive controls');
  fixture.holdNext.add('files-inbox'); refresh(); await flush();
  const cancelled = fixture.held.findLast(r => r.key === 'files-inbox');
  fixture.emit('lifecycle', { active: false }); await flush();
  cancelled.finish(); await flush();
  assert(clear().disabled && deletion().disabled, 'cancelled refresh cannot restore freshness from its late response');
  fixture.emit('lifecycle', { active: true }); await flush();
  assert(!clear().disabled, 'resume refreshes the cancelled inbox before re-enabling deletion');
  fixture.publishControl({ id: 'read-probe', command: 'dns-probe', busy: true, ownsMutation: false, canWrite: true, unknown: false, canCancel: true }); await flush();
  const opens = fixture.log.filter(r => r.action === 'files.open').length;
  assert(row().disabled, 'busy native read visibly disables otherwise inert file row');
  row().click(); await flush();
  assert(fixture.log.filter(r => r.action === 'files.open').length === opens, 'disabled row does not issue a native open');
  fixture.publishControl({ busy: false, canCancel: false }); await flush();
  assert(!row().disabled, 'file row re-enables when native operation settles');
  click(row()); await flush();
  assert(fixture.log.filter(r => r.action === 'files.open').length === opens + 1, 'settled file row opens normally');
});

await scenario('Files exposes daemon-held deliveries and recovers without hiding failures', async ({ fixture, nav, window, button, click }) => {
  fixture.data['files-inbox'].receive = { mode: 'buffered', selfId: 'preview-self', pending: [{ name: 'incoming.txt', size: 23 }] };
  await nav('files');
  const received = () => window.document.querySelector('[data-testid="receive-status"]');
  assert(received()?.textContent.includes('incoming.txt') && received()?.textContent.includes('daemon inbox'), 'daemon-held files are shown separately from downloaded files');
  fixture.overrides.set('file-receive', { ok: false, error: 'Destination conflict; source retained' });
  click(button('ft_receive_file', received())); await flush();
  assert(window.document.querySelector('.files-notice')?.textContent.includes('source retained') && received()?.textContent.includes('incoming.txt'), 'failed recovery keeps pending delivery visible and reports the error');
  fixture.overrides.delete('file-receive');
  click(button('ft_receive_file', received())); await flush();
  assert(!received()?.textContent.includes('incoming.txt') && fixture.data['files-inbox'].files.some(file => file.name === 'incoming.txt'), 'successful recovery refreshes pending and downloaded lists');
  const submitted = fixture.log.findLast(r => r.action === 'control.mutate' && r.args.command === 'file-receive');
  assert(submitted?.args.arguments[0] === 'incoming.txt' && submitted?.args.arguments[1] === 'preview-self', 'recovery binds the named file to the observed account');
  fixture.data['files-inbox'].receive = { mode: 'unavailable', selfId: '', pending: [], error: 'Daemon offline' };
  click(button('tools_refresh', window.document.querySelector('.files-page .card'))); await flush();
  assert(received()?.textContent.includes('Daemon offline') && window.document.querySelector('.files-page').textContent.includes('incoming.txt'), 'unavailable daemon reports receive failure without hiding downloaded files');
});

await scenario('routes, appearance and retained Files UI', async ({ app, nav, window, fixture, input }) => {
  for (const route of Object.keys(app.ROUTES)) {
    await nav(route);
    assert(window.document.querySelector('#view .page-transition:not([hidden])')?.textContent.trim().length > 0, route + ' renders visible content');
  }
  assert(app.state.status()?.self.id === 'preview-self' && app.state.peers()?.length === 3, 'light status supplies current identity and peers');
  assert(app.state.status()?.exitRouting?.known === true, 'deep routing has independent identity-bound result');
  await app.applyTheme('dark'); await app.setLang('zh'); await flush();
  assert(fixture.appearance.theme === 'dark' && fixture.appearance.language === 'zh', 'appearance changes use native preferences');
  await app.setLang('en');
  await nav('files');
  const original = window.document.querySelector('.files-page');
  input(window.document.querySelector('.files-toolbar input'), 'network');
  await nav('peers'); await nav('files');
  assert(window.document.querySelector('.files-page') === original, 'Files keeps its actual mounted UI across routes');
  assert(window.document.querySelector('.files-toolbar input')?.value === 'network', 'Files search survives navigation');
  assert(!fixture.log.some(r => r.action === 'app.drafts'), 'Files view state needs no native draft bridge');
});

await scenario('session drafts restore unmounted Logs but a new document starts clean', async ({ nav, window, input, fixture }) => {
  await nav('logs');
  const original = window.document.querySelector('.tool-log-controls input');
  assert(original.value === '', 'new WebView session starts with empty log search');
  input(original, 'session-only-filter');
  await nav('peers'); await nav('logs');
  const restored = window.document.querySelector('.tool-log-controls input');
  assert(restored !== original && restored.value === 'session-only-filter', 'unmounted Logs restores input from session store');
  assert(!fixture.log.some(r => r.action === 'app.drafts'), 'session edits make no native draft requests');
});
await scenario('fresh document does not inherit prior session edits', async ({ nav, window }) => {
  await nav('logs');
  assert(window.document.querySelector('.tool-log-controls input').value === '', 'new document discards previous session search');
});

await scenario('native envelopes, read disposal and accepted-write continuation', async ({ app, fixture, window, nav }) => {
  fixture.holdNext.add('logs'); fixture.holdNext.add('speedtest-exitnodes');
  const scope = app.api.createApiScope();
  const read = scope.call('logs');
  const write = scope.call('speedtest-exitnodes');
  scope.cancelAll(); await flush();
  assert(fixture.log.some(r => r.action === 'control.cancelRead' && r.args.id === read.requestId), 'disposed reads cancel their wire request');
  assert(!fixture.log.some(r => r.action === 'control.cancel'), 'scope disposal never cancels accepted writes');
  fixture.held.find(r => r.key === 'logs').finish();
  fixture.held.find(r => r.key === 'speedtest-exitnodes').finish();
  assert((await read.promise).cancelled === true && (await write.promise).ok, 'read completion is fenced while write completion survives');
  fixture.holdNext.add('logs');
  const malformed = app.native.startNative('control.query', { command: 'logs', arguments: [] });
  window.FoxyTailNative.onmessage({ data: JSON.stringify({ id: malformed.id, result: { data: 'missing ok' } }) });
  assert(!(await malformed.promise).ok, 'malformed native result cannot become success');
  const held = fixture.held.findLast(r => r.key === 'logs'); held.finish();
  fixture.overrides.set('speedtest-exitnodes', { ok: false, unknown: true, error: 'Simulated receipt pending' });
  const unknown = app.api.apiCall('speedtest-exitnodes');
  await unknown.promise;
  const durableId = fixture.control.id;
  assert(durableId !== unknown.requestId && app.api.nativeControl().unknown, 'unknown result retains native durable identity, not wire request ID');
  const submissions = fixture.log.filter(r => r.action === 'control.mutate' && r.args.command === 'speedtest-exitnodes').length;
  await nav('peers'); await nav('settings'); await app.api.refreshNativeControl();
  assert(fixture.log.filter(r => r.action === 'control.mutate' && r.args.command === 'speedtest-exitnodes').length === submissions, 'navigation and observation never replay uncertain write');
  await unknown.cancel();
  assert(fixture.log.findLast(r => r.action === 'control.cancel')?.args.id === durableId, 'cancel uses native durable ID');
  assert(!unknown.cancelled && app.api.nativeControl().unknown, 'cancel requested is not a confirmed terminal result');
});

await scenario('account and operation revision stale-response fences', async ({ app, fixture }) => {
  fixture.emit('lifecycle', { active: false });
  fixture.holdNext.add('status');
  const old = app.state.refreshStatus();
  const held = fixture.held.find(r => r.key === 'status');
  fixture.publishControl({ accountRevision: 1, revision: 1 });
  assert(app.state.status() === null && app.state.peers() === null, 'account change immediately clears old identity and peers');
  held.finish(); await old;
  assert(app.state.status() === null, 'late old account response cannot repopulate state');
  fixture.data.status.self.id = 'second-account';
  fixture.data['exit-routing'].selfId = 'second-account';
  await app.state.refreshStatus(); await flush();
  assert(app.state.status()?.self.id === 'second-account', 'fresh account loads normally');
  fixture.holdNext.add('exit-routing');
  const deep = app.state.refreshExitRouting();
  const stale = fixture.held.findLast(r => r.key === 'exit-routing');
  fixture.publishControl({ revision: 2 });
  stale.finish(); await deep;
  assert(app.state.status()?.exitRouting === undefined, 'old deep routing cannot cross operation revision');
  fixture.data['exit-routing'].selfId = 'wrong-device';
  await app.state.refreshExitRouting();
  assert(app.state.status()?.exitRouting === undefined, 'wrong device deep routing is rejected');
});

await scenario('settings apply owns the confirmed batch during preflight', async ({ fixture, nav, window, input, button, click, confirm }) => {
  await nav('settings');
  const field = () => window.document.querySelector('[data-setting="SOCKS_PORT"] input');
  input(field(), '1100'); await flush();
  click(button('set_apply_all')); await flush();
  const safe = window.document.querySelector('#settings-safe-apply');
  const safeLabel = window.document.querySelector('label[for="settings-safe-apply"]');
  const initiallySafe = safe.checked;
  assert(!window.document.querySelector('.pending-review-safe label label'), 'safe-apply labels are not nested');
  click(safeLabel); await flush();
  assert(safe.checked !== initiallySafe, 'safe-apply text toggles its checkbox exactly once');
  click(safeLabel); await flush();
  assert(safe.checked === initiallySafe, 'safe-apply text restores the original choice');
  fixture.holdNext.add('settings-get');
  await confirm(true);
  const preflight = fixture.held.find(r => r.key === 'settings-get');
  assert(!!preflight, 'confirmed settings batch waits for its baseline refresh');
  assert(field().disabled, 'settings editing is locked throughout confirmed-batch preflight');
  assert(button('set_apply_all').disabled, 'a second batch cannot start during preflight');
  // Dispatch explicitly even on the disabled input to verify the action guard,
  // not just the DOM attribute. This reproduces the old mutable-snapshot race.
  input(field(), '1101'); await flush();
  preflight.finish(); await flush();
  const writes = fixture.log.filter(r => r.action === 'control.mutate' && r.args.command === 'settings-set');
  assert(writes.length === 1 && writes[0].args.arguments[1] === '1100', 'only the reviewed and validated value is written once');
  assert(fixture.settings.SOCKS_PORT === '1100', 'preflight edits cannot replace the confirmed value');
  assert(!field().disabled, 'settings editing unlocks after the confirmed batch');
  assert(fixture.log.some(r => r.action === 'control.mutate' && r.args.command === 'trial-start'), 'batch ownership does not block the safe-apply trial');
});

await scenario('settings preflight failure unlocks the batch for retry', async ({ fixture, nav, window, input, button, click, confirm }) => {
  await nav('settings');
  const field = () => window.document.querySelector('[data-setting="SOCKS_PORT"] input');
  input(field(), '1100'); await flush();
  fixture.overrides.set('settings-get', { ok: false, error: 'Simulated settings read failure' });
  click(button('set_apply_all')); await confirm(true);
  assert(fixture.settings.SOCKS_PORT === '1099', 'failed preflight does not write settings');
  fixture.overrides.delete('settings-get');
  click(button('retry')); await flush();
  assert(!field().disabled && !button('set_apply_all').disabled, 'failed preflight releases editing and apply ownership');
  assert(field().value === '1100', 'failed preflight preserves the draft through read retry');
  click(button('set_apply_all')); await confirm(true);
  assert(fixture.settings.SOCKS_PORT === '1100', 'the preserved batch can be reviewed and retried');
});

await scenario('settings drafts survive navigation and conflicts require consent', async ({ app, fixture, nav, window, input, button, click, confirm }) => {
  await nav('settings');
  const row = () => window.document.querySelector('[data-setting="SOCKS_PORT"]');
  input(row()?.querySelector('input'), '1100'); await flush();
  const before = fixture.log.filter(r => r.action === 'control.mutate').length;
  assert(fixture.settings.SOCKS_PORT === '1099', 'editing does not auto-save');
  await nav('peers'); await nav('settings');
  assert(row()?.querySelector('input')?.value === '1100', 'unsaved settings draft is restored');
  fixture.settings.SOCKS_PORT = '1200';
  click(button('set_apply_all')); await flush();
  await confirm(true); // review dialog accepts the batch
  await confirm(false); // declined conflict review aborts the batch
  assert(fixture.log.filter(r => r.action === 'control.mutate').length === before, 'rejecting refreshed conflict does not write');
  assert(row()?.querySelector('input')?.value === '1100', 'rejected conflict preserves user draft');
  click(button('set_apply_all')); await flush();
  await confirm(true); // review dialog accepts the batch
  await confirm(true); // confirmed conflict review overwrites
  assert(fixture.settings.SOCKS_PORT === '1100', 'explicit confirmed save writes chosen value');
  assert(fixture.log.some(r => r.action === 'control.mutate' && r.args.command === 'trial-start'), 'safe apply starts a rollback-protected trial instead of a plain restart');
  assert(!fixture.log.some(r => r.action === 'control.mutate' && r.args.command === 'control'), 'saving configuration never silently applies it');
  fixture.data['trial-status'].trial = null;
  const raw = '# Unrecognized lines are user data\nssid:家:up\nfuture:format:keep\n';

  await nav('peers'); await nav('settings');
  const advanced = window.document.querySelector('.page-transition:not([hidden]) details.tool-disclosure');
  advanced.open = true; advanced.dispatchEvent(new window.Event('toggle')); await flush();
  click(button('context_text')); await flush();
  input(window.document.querySelector('[data-testid="context-rules"] textarea'), raw);
  await nav('peers'); await nav('settings');
  assert([...window.document.querySelectorAll('textarea')].some(e => e.value === raw), 'context draft retains comments, Unicode and unknown lines verbatim');
});

await scenario('Select keeps the value and indicator in one accessible row', async ({ nav, window, app }) => {
  await nav('diag');
  const field = [...window.document.querySelectorAll('.select-field')].find(f => f.querySelector('summary')?.getAttribute('aria-label') === app.t('diag_bundle_mode'));
  const summary = field.querySelector('summary'), label = summary.querySelector('.text-field-label');
  const value = summary.querySelector('.select-value'), caret = summary.querySelector('.select-caret');
  assert(label && value && caret && caret.parentElement === value.parentElement, 'label, value and indicator belong to the same dropdown trigger');
  assert(window.document.getElementById(summary.getAttribute('aria-describedby')) === value, 'selected value is exposed alongside the dropdown accessible label');
  const style = window.document.createElement('style');
  style.textContent = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8'); window.document.head.append(style);
  const computed = element => window.getComputedStyle(element);
  assert(computed(summary).display === 'grid' && computed(label).position === 'static' && computed(label).gridColumn === '1 / -1', 'label occupies its own wrapping row, not an absolute overlay');
  assert(computed(value).gridColumn === '1' && computed(caret).gridColumn === '2' && computed(summary).alignItems === 'center', 'value and indicator share a vertically centered grid row');
  const longText = 'VeryLongDiagnosticBundleContentWithoutBreaks'.repeat(4);
  const selected = field.querySelector('select').selectedOptions[0]; selected.textContent = longText; await flush();
  label.textContent = longText;
  assert(value.textContent === longText && computed(value).overflowWrap === 'anywhere' && computed(label).overflowWrap === 'anywhere', 'long label and selected option stay complete and wrap without covering the indicator');
  await nav('settings');
  const unlabeled = window.document.querySelector('.select-field.no-label summary');
  assert(unlabeled && !unlabeled.querySelector('.text-field-label') && computed(unlabeled).minHeight === '44px', 'unlabeled dropdowns retain a compact centered touch target');
});

await scenario('Select owns disabled state and dismissal', async ({ fixture, nav, window, app }) => {
  await nav('settings');
  const field = [...window.document.querySelectorAll('.select-field')].find(f => f.querySelector('summary')?.getAttribute('aria-label') === app.t('trial_candidate'));
  const popup = field.querySelector('.select-pop');
  const open = async () => { popup.open = true; popup.dispatchEvent(new window.Event('toggle')); await flush(); };
  await open();
  const staleOption = [...popup.querySelectorAll('[role="option"]')].find(option => option.textContent === 'proxy');
  fixture.publishControl({ busy: true, canWrite: false }); await flush();
  assert(!popup.open && field.querySelector('select').disabled, 'becoming disabled dismisses an open selection');
  staleOption.click(); await flush();
  assert(field.querySelector('select').value === 'saved', 'a stale option cannot change a disabled selection');
  fixture.publishControl({ busy: false, canWrite: true }); await flush();
  await open();
  popup.querySelector('summary').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert(!popup.open && window.document.activeElement === popup.querySelector('summary'), 'Escape dismisses selection and restores trigger focus');
  await open();
  window.document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert(!popup.open, 'outside interaction dismisses selection');
  await open();
  const option = [...popup.querySelectorAll('[role="option"]')].find(item => item.textContent === 'proxy');
  field.querySelector('option[value="proxy"]').disabled = true;
  option.click(); await flush();
  assert(field.querySelector('select').value === 'saved', 'changed option availability is respected before the observer runs');
});

await scenario('Back closes active popup before disclosure and parent links unwind history', async ({ fixture, nav, window }) => {
  await nav('settings');
  const advanced = window.document.querySelector('.page-transition:not([hidden]) details.tool-disclosure');
  advanced.open = true; advanced.dispatchEvent(new window.Event('toggle')); await flush();
  const popup = window.document.querySelector('#restore-backup').closest('.select-field').querySelector('details');
  popup.open = true; popup.dispatchEvent(new window.Event('toggle')); await flush();
  fixture.emit('back', {}); await flush();
  assert(!popup.open && advanced.open, 'Back closes the active popup without collapsing an unrelated disclosure');
  await nav('network'); await nav('routing');
  window.document.querySelector('.page-transition:not([hidden]) .back-link').click(); await flush();
  assert(window.location.hash === '#/network', 'visible parent link returns to the named hub');
  fixture.emit('back', {}); await flush();
  assert(window.location.hash === '#/settings', 'Android Back continues earlier history instead of reopening the detail just left');
});

await scenario('popup selects open option lists and dispatch native change events', async ({ nav, window, fixture, click }) => {
  await nav('settings');
  const field = name => [...window.document.querySelectorAll('.select-field')]
    .find(f => f.querySelector('.select-pop summary')?.getAttribute('aria-label') === window.__foxy.t(name));
  const theme = field('set_theme');
  assert(!!theme?.querySelector('select[hidden]') && !!theme.querySelector('.select-pop > summary'), 'selects keep a hidden option carrier behind a popup trigger');
  assert(!!theme.querySelector('.select-value')?.textContent.trim(), 'trigger shows the current option text');
  const open = pop => { pop.open = true; pop.dispatchEvent(new window.Event('toggle')); };
  open(theme.querySelector('.select-pop')); await flush();
  const options = [...theme.querySelectorAll('.select-pop [role="option"]')];
  assert(options.length === 3 && options.filter(o => o.getAttribute('aria-selected') === 'true').length === 1, 'listbox rebuilds from native options with one selection');
  click(options.find(o => o.textContent.trim() === window.__foxy.t('set_theme_dark'))); await flush();
  const themePop = theme.querySelector('.select-pop');
  assert(theme.querySelector('select').value === 'dark' && fixture.appearance.theme === 'dark' && !themePop.open, 'popup option dispatches native change and closes');
  assert(themePop.querySelector('.select-value')?.textContent.trim() === window.__foxy.t('set_theme_dark'), 'trigger reflects the chosen option');
  const dns = field('tools_dns_mode');
  open(dns.querySelector('.select-pop')); await flush();
  const dnsOption = [...dns.querySelectorAll('.select-pop [role="option"]')].find(o => o.getAttribute('aria-selected') !== 'true' && !o.disabled);
  click(dnsOption); await flush();
  assert(dns.querySelector('select').value !== 'local' && fixture.settings.DNS_MODE === 'local', 'settings popup stages a draft without auto-saving');
  assert(!!window.document.querySelector('[data-setting="DNS_MODE"] [role="status"]'), 'staged popup change marks the field as pending review');
});

await scenario('peer detail probes run from the address row and render a result panel', async ({ nav, window, click }) => {
  await nav('peers');
  click([...window.document.querySelectorAll('.network-peer-main')].find(r => r.textContent.includes('home-server'))); await flush();
  const dialog = window.document.querySelector('dialog[open], [role="dialog"]');
  assert(!!dialog, 'peer detail dialog opens');
  const address = dialog.querySelector('.network-address');
  assert(!!address?.querySelector('.peer-probe-trigger') && address.querySelectorAll('.icon-btn').length === 2, 'address row pairs a probe trigger with the copy button');
  assert(!dialog.querySelector('[data-peer-probe] .btn'), 'no standalone probe buttons remain');
  click(address.querySelector('.peer-probe-trigger')); await flush();
  const panel = dialog.querySelector('.peer-probe-result');
  assert(!!panel && panel.textContent.includes('23 ms') && !!panel.querySelector('code'), 'probe result renders latency, path and endpoint in a panel');
});

await scenario('Incoming notification targets retained inbox and supersedes pending history focus', async ({ fixture, nav, window, app }) => {
  fixture.emit('navigate', { page: 'files', section: 'inbox' }); await flush();
  assert(window.document.activeElement?.id === 'files-inbox', 'incoming intent before Files mounts is restored after initialization');
  const page = window.document.querySelector('.files-page');
  fixture.publishFiles({ selection: [{ key: 'one', name: 'notes.txt', size: 120, source: 'uri' }] });
  app.files.updateFileView({ peer: 'nas', filter: 'network' }); await flush();
  const scrolled = [];
  window.Element.prototype.scrollIntoView = function () { scrolled.push(this.id); };
  fixture.holdNext.add('file-send-history');
  fixture.emit('navigate', { page: 'files', section: 'history' }); await flush();
  const history = fixture.held.findLast(r => r.key === 'file-send-history');
  assert(!!history, 'history refresh is pending when the newer inbox intent arrives');
  const reads = fixture.log.filter(r => r.action === 'control.query' && r.args.command === 'files-inbox').length;
  scrolled.length = 0;
  fixture.emit('navigate', { page: 'files', section: 'inbox' }); await flush();
  history.finish(); await flush();
  assert(scrolled.at(-1) === 'files-inbox' && !scrolled.includes('files-history'), 'incoming inbox intent supersedes the delayed history scroll');
  assert(window.document.activeElement?.id === 'files-inbox', 'incoming navigation focuses the inbox destination');
  assert(fixture.log.filter(r => r.action === 'control.query' && r.args.command === 'files-inbox').length > reads, 'incoming notification refreshes an already retained inbox');
  assert(window.document.querySelector('.files-page') === page && app.files.fileView().peer === 'nas' && app.files.fileView().filter === 'network' && fixture.files.selection.length === 1, 'section navigation retains files page, filters and pending send data');
  await nav('settings');
  fixture.emit('navigate', { page: 'files', section: 'inbox' }); await flush();
  assert(window.location.hash === '#/files' && scrolled.at(-1) === 'files-inbox' && window.document.activeElement?.id === 'files-inbox', 'notification from another route also lands at the retained inbox');
});

await scenario('Blocked automatic receipt preserves manual recovery', async ({ fixture, nav, window, app }) => {
  fixture.data['files-inbox'].receive = { mode: 'buffered', selfId: 'preview-self', pending: [{ name: 'pending.txt', size: 12 }],
    automatic: { enabled: true, state: 'blocked', error: 'Simulated storage unavailable' } };
  await nav('files');
  const status = window.document.querySelector('[data-testid="receive-status"]');
  assert(status.textContent.includes('Simulated storage unavailable') && status.textContent.includes(app.t('ft_auto_receive_blocked')), 'blocked automatic status names the error and manual alternative');
  const receive = [...status.querySelectorAll('button')].find(b => b.textContent.trim() === app.t('ft_receive_file'));
  assert(receive && !receive.disabled, 'blocked automatic recovery leaves the manual receive action available');
});

await scenario('Incoming notifications report preference separately from system permission', async ({ fixture, nav, window, app }) => {
  await nav('files');
  const control = () => [...window.document.querySelectorAll('input[role="switch"]')].find(input => input.getAttribute('aria-label') === app.t('ft_receive_notifications'));
  assert(!control().checked && !control().disabled, 'incoming notifications default to opt-out');
  fixture.overrides.set('files.receiveNotifications', { ok: true, enabled: true, allowed: false });
  fixture.holdNext.add('files.receiveNotifications');
  control().click(); await flush();
  assert(!control().checked && control().disabled, 'preference is not optimistically enabled while native confirmation is pending');
  fixture.held.findLast(r => r.key === 'files.receiveNotifications').finish(); await flush();
  assert(control().checked && window.document.querySelector('#files-notifications-hint')?.textContent === app.t('ft_receive_notifications_blocked'), 'denied permission retains opt-in and explains the system restriction');
  assert(!window.document.querySelector('.files-receive-preferences [role="alert"]'), 'permission denial is not reported as a receive failure');
  fixture.overrides.delete('files.receiveNotifications');
  fixture.publishFiles({ receiveNotifications: { ok: true, enabled: true, allowed: true } }); await flush();
  assert(control().checked && !window.document.querySelector('#files-notifications-hint'), 'permission callback snapshot updates the visible status');
  fixture.emit('lifecycle', { active: false }); await flush();
  fixture.files.receiveNotifications.allowed = false;
  fixture.emit('lifecycle', { active: true }); await flush();
  assert(!!window.document.querySelector('#files-notifications-hint'), 'resume rechecks system notification permission');
  control().click(); await flush();
  assert(!control().checked && !fixture.files.receiveNotifications.enabled, 'turning notifications off stores only the notification preference');
});

await scenario('Automatic buffered receipt writes one fresh setting without restart', async ({ fixture, nav, window, app, button, click }) => {
  await nav('files');
  const control = () => [...window.document.querySelectorAll('input[role="switch"]')].find(input => input.getAttribute('aria-label') === app.t('ft_auto_receive'));
  assert(!control().checked && !control().disabled, 'automatic buffered receipt defaults off');
  const before = JSON.stringify(fixture.settings);
  fixture.holdNext.add('settings-get');
  fixture.holdNext.add('settings-set');
  control().click(); await flush();
  assert(!control().checked && control().disabled && !fixture.log.some(r => r.action === 'control.mutate' && r.args.command === 'settings-set'), 'automatic receipt waits for a fresh baseline before writing');
  fixture.held.findLast(r => r.key === 'settings-get').finish(); await flush();
  assert(!control().checked && control().disabled, 'accepted setting is not shown as enabled before its receipt and readback');
  fixture.held.findLast(r => r.key === 'settings-set').finish(); await flush();
  const writes = fixture.log.filter(r => r.action === 'control.mutate' && r.args.command === 'settings-set');
  assert(control().checked && writes.length === 1 && JSON.stringify(writes[0].args.arguments) === JSON.stringify(['TAILDROP_AUTO_RECEIVE', '1']), 'automatic receipt saves and confirms only its own setting');
  const expected = JSON.parse(before); expected.TAILDROP_AUTO_RECEIVE = '1';
  assert(JSON.stringify(fixture.settings) === JSON.stringify(expected), 'other saved settings are unchanged');
  assert(!fixture.log.some(r => r.action === 'control.mutate' && ['control', 'trial-start'].includes(r.args.command)), 'hot receipt preference does not restart the daemon or start a trial');
  fixture.holdNext.add('settings-set');
  control().click(); await flush();
  fixture.overrides.set('settings-get', { ok: false, cancelled: true });
  fixture.held.findLast(r => r.key === 'settings-set').finish(); await flush();
  assert(control().disabled && control().indeterminate, 'cancelled post-save readback does not present the prior value as current');
  fixture.overrides.delete('settings-get');
  click(button('retry', window.document.querySelector('.files-receive-preferences'))); await flush();
  assert(!control().checked && !control().disabled, 'readback retry restores the confirmed value without another write');
  fixture.overrides.set('settings-set', { ok: false, unknown: true, error: 'Pending receipt' });
  control().click(); await flush();
  assert(control().disabled && control().indeterminate && window.document.querySelector('.files-receive-preferences')?.textContent.includes(app.t('ft_unknown')), 'an unknown save stays indeterminate rather than claiming the requested value');
});

await scenario('Files composer groups sources and keeps browser navigation available', async ({ fixture, nav, window, app, button, click }) => {
  await nav('files');
  const send = window.document.querySelector('#files-send');
  assert(!!send.querySelector('.files-recipient-group h3') && !!send.querySelector('.files-recipient-group [role="radiogroup"]'), 'recipient choice has its own visible group');
  const sources = send.querySelector('.files-source-group');
  assert(!!sources.querySelector('.files-source-actions .files-labeled') && !sources.querySelector('.files-selection-list'), 'file sources have one action row without an empty selection list');
  click(button('files_choose', sources)); await flush();
  const browser = () => sources.querySelector('#taildrop-browser');
  assert(!!browser() && !!button('files_close_browser', browser()), 'shared storage opens with its own close control');
  click([...browser().querySelectorAll('button')].find(b => b.getAttribute('aria-label') === app.t('files_open_directory') + ' Download')); await flush();
  assert(fixture.log.some(r => r.action === 'files.browse' && r.args.path === 'Download'), 'folder navigation remains available');
  click(button('ft_shared', browser())); await flush();
  assert(fixture.log.findLast(r => r.action === 'files.browse')?.args.path === '', 'root breadcrumb replaces the redundant parent action');
  click(button('files_close_browser', browser())); await flush();
  assert(!browser(), 'browser close does not remove the file-source toolbar');
  fixture.publishFiles({ selection: [{ key: 'one', name: 'notes.txt', size: 120, source: 'uri' }] }); await flush();
  assert(!!button('ft_clear_selection', sources.querySelector('.files-source-actions')) && !!sources.querySelector('.files-selection-list'), 'pending files and clear action share the source group');
  click(button('ft_clear_selection', sources)); await flush();
  assert(fixture.files.selection.length === 0 && !sources.querySelector('.files-selection-list'), 'clear still removes the pending selection');
});

await scenario('Files partial outcomes, native snapshots and selection limits', async ({ app, fixture, nav, window, button, click, confirm }) => {
  await nav('files');
  click(button('ft_matches')); await flush();
  assert(app.files.fileView().selected.length === 2, 'select matches uses current inbox');
  click(button('ft_batch_delete')); await confirm(true);
  assert(app.files.fileView().selected.length === 1 && app.files.fileView().selected[0] === 'camera-roll.zip', 'partial delete removes only successful selected items');
  assert(window.document.querySelector('.files-notice')?.textContent.includes('camera-roll.zip'), 'partial failure identifies the failed file');
  const snapshot = copy(fixture.files);
  const good = { key: 'one', name: 'notes.txt', size: 120, source: 'uri' };
  fixture.publishFiles({ selection: [good] });
  assert(app.files.filesSnapshot().selection.length === 1, 'native selection snapshot is accepted');
  fixture.publishFiles({ selection: Array.from({ length: 33 }, (_, i) => ({ ...good, key: String(i) })) });
  assert(app.files.filesSnapshot().selection.length === 1 && app.files.snapshotError(), 'oversized native selection cannot replace accepted snapshot');
  fixture.publishFiles({ ...snapshot, selection: [{ ...good, size: 2 ** 31 + 1 }] });
  assert(app.files.filesSnapshot().selection[0].size === 120, 'over-2-GiB source cannot replace accepted snapshot');
  fixture.publishFiles({ ...snapshot, selection: Array.from({ length: 32 }, (_, i) => ({ ...good, key: String(i), size: 2 ** 31 })) });
  assert(app.files.filesSnapshot().selection.length === 32 && !app.files.snapshotError(), 'exact 32-file and 2-GiB boundaries remain accepted');
  fixture.publishFiles(snapshot);
  const history = copy(fixture.transfer);
  assert(app.files.transfer(history) && app.files.unsuccessful(history).length === 1, 'retry candidates exclude completed files');
  history.files[1].sentBytes = history.files[1].size + 1;
  assert(!app.files.transfer(history), 'impossible transfer progress is rejected');
  const result = await app.native.requestNative('files.pick');
  assert(!result.ok && fixture.files.selection.length === 0, 'preview never claims real picker or binary transfer success');
  fixture.data['files-inbox'].files = Array.from({ length: 33 }, (_, i) => ({ name: `file-${i}.txt`, size: 1, mtime: 1 }));
  const inboxCard = window.document.querySelector('.files-page .card');
  click(button('tools_refresh', inboxCard)); await flush();
  app.files.updateFileView({ selected: [] });
  click(button('ft_matches')); await flush();
  assert(app.files.fileView().selected.length === 0, 'select-all rejects more than 32 without silently truncating');
});

await scenario('backup, Serve and coexistence consumers retain safety boundaries', async ({ app, fixture }) => {
  const preview = fixture.command('restore-preview', [fixture.token]);
  assert(app.backup.validRestorePreview(preview), 'opaque artifact token and double-hash preview are accepted');
  for (const patch of [{ sha256: '' }, { baselineSha256: '' }, { path: '/data/private/key' }, { hooks: ['arbitrary.sh'] }, { changes: [{ file: 'secret', key: 'x', before: null, after: 'x' }] }])
    assert(!app.backup.validRestorePreview({ ...preview, ...patch }), 'invalid restore boundary rejected: ' + Object.keys(patch)[0]);
  await app.backup.restoreBackup(preview);
  const request = fixture.log.findLast(r => r.action === 'control.mutate' && r.args.command === 'restore');
  assert(JSON.stringify(request?.args.arguments) === JSON.stringify([preview.path, preview.sha256, preview.baselineSha256]), 'restore submits token and both exact hashes');
  const mapping = app.serve.serveMappings(fixture.data['serve-list'].status)[0];
  assert(JSON.stringify(app.serve.serveDeleteArgs(mapping)) === JSON.stringify(['https', '8443', '/notes']), 'Serve deletion retains listener protocol and non-root path');
  const unknown = app.serve.serveMappings({ Web: { 'host:443': { Handlers: { '/': { Proxy: 'http://localhost' } } } } })[0];
  assert(!unknown.canDelete, 'port number alone cannot invent HTTPS protocol');
  const info = fixture.command('coexist-info', []);
  const snippet = app.coexistence.coexistSnippet(info, 'rule');
  assert(snippet.includes('100.69.138.97/32') && snippet.includes('/128') && !snippet.includes('100.64.0.0/10'), 'coexistence grants exact current host CIDRs, not full Tailnet range');
  assert(snippet.includes('DOMAIN-SUFFIX,example.ts.net,real-ip'), 'fake-IP rule matches only current DNS suffix');
  for (const patch of [{ suffix: 'ts.net' }, { addresses: ['127.0.0.1'] }, { dnsReady: false }]) {
    let rejected = false; try { app.coexistence.coexistSnippet({ ...info, ...patch }, 'rule'); } catch { rejected = true; }
    assert(rejected, 'unsafe coexistence input rejected: ' + Object.keys(patch)[0]);
  }
});

await scenario('full log text and missing-versus-zero traffic', async ({ fixture, nav, window, input, button, click, app }) => {
  const line = '[Info] <script>not markup</script>\t' + '长'.repeat(9000) + '\u001b[31m';
  fixture.data.logs.lines = [line, '[Warning] another line'];
  await nav('logs');
  assert(!window.document.querySelector('#view script'), 'untrusted log text cannot become executable markup');
  click(button('tools_logs_copy')); await flush();
  assert(fixture.log.findLast(r => r.action === 'app.copy')?.args.text === fixture.data.logs.lines.join('\n'), 'copy retains full Unicode, control characters and line boundaries');
  input(window.document.querySelector('.tool-log-controls input'), 'another');
  click(button('tools_logs_copy')); await flush();
  assert(fixture.log.findLast(r => r.action === 'app.copy')?.args.text === '[Warning] another line', 'local filtering copies only visible original lines');
  input(window.document.querySelector('.tool-log-controls input'), '');
  click(button('tools_logs_level_warn')); await flush();
  assert(window.document.querySelectorAll('.tool-log-line').length === 1 && window.document.querySelector('.tool-log-line.is-warn'), 'warning filter keeps warning and error lines with warn styling');
  click(button('tools_logs_level_error')); await flush();
  assert(!window.document.querySelector('.tool-log-line'), 'error filter shows an empty state when no error lines are loaded');
  click(button('tools_logs_level_all')); await flush();
  assert(window.document.querySelectorAll('.tool-log-line').length === 2, 'all filter restores every loaded line');
  const liveToggle = window.document.querySelector('.logs-live-toggle');
  assert(liveToggle?.disabled && liveToggle.getAttribute('aria-pressed') === 'false' && window.document.querySelector('.logs-meta')?.textContent.includes(window.__foxy.t('tools_logs_paused')), 'disabled auto-refresh shows a paused, disabled live toggle');
  fixture.data.status.autoRefresh = true;
  await app.state.refreshStatus(); await flush();
  assert(!liveToggle.disabled && liveToggle.getAttribute('aria-pressed') === 'true', 'live toggle resumes when auto-refresh is available');
  click(liveToggle); await flush();
  assert(liveToggle.getAttribute('aria-pressed') === 'false', 'play/pause toggle pauses live refresh');
  fixture.data.status.autoRefresh = false;
  await app.state.refreshStatus(); await flush();
  fixture.data.traffic = { ok: true, hours: [{ hour: 1, samples: 0, iface: { rx: 0, tx: 0 } }], days: [], topn: [], uids: [] };
  await nav('traffic');
  assert(window.document.querySelector('.network-traffic-metrics .metric-value')?.textContent === '—', 'missing traffic samples are unknown, not zero');
  fixture.data.traffic.hours[0].samples = 1;
  click(button('net_refresh')); await flush();
  assert(window.document.querySelector('.network-traffic-metrics .metric-value')?.textContent.includes('0'), 'recorded zero traffic remains a real measurement');
  assert(app.state.status()?.ok, 'traffic navigation preserves status');
});

await scenario('account transfer preflight, secret disposal and trial recovery', async ({ fixture, nav, window, input, button, click, confirm }) => {
  fixture.data['file-send-history'].transfers[0].status = 'sending';
  await nav('account');
  click(button('acc_login')); await confirm(true);
  assert(!fixture.log.some(r => r.action === 'app.login'), 'active transfer blocks account login before native submission');
  fixture.overrides.set('file-send-history', { ok: false, error: 'Simulated history unavailable' });
  click(button('acc_login')); await confirm(true);
  assert(!fixture.log.some(r => r.action === 'app.login'), 'unknown transfer state cannot bypass account preflight');
  input(window.document.querySelector('input[type="password"]'), 'SIMULATED-NOT-A-CREDENTIAL');
  fixture.emit('lifecycle', { active: false }); await flush();
  assert(window.document.querySelector('input[type="password"]')?.value === '', 'backgrounding clears account secrets');
  assert(!fixture.log.some(r => r.action === 'app.drafts'), 'auth input never crosses a native draft bridge');
  fixture.emit('lifecycle', { active: true });
  fixture.data['trial-status'] = { ok: true, trial: { status: 'running' } };
  await nav('settings');
  assert(button('trial_start')?.disabled, 'malformed trial state cannot enable a new trial');
  const summary = { mode: 'tun', dnsMode: 'local', routeScope: 'all' };
  fixture.data['trial-status'].trial = { id: 'expired', status: 'running', remaining: 0, reason: '', previous: summary, candidate: summary };
  click(button('retry')); await flush();
  assert(button('trial_confirm')?.disabled && !button('trial_revert')?.disabled, 'expired trial cannot confirm but retains recovery action');
});

await scenario('snapshot sequence and displayed cancellation ownership', async ({ app, fixture, window, button, click }) => {
  fixture.publishControl({ id: 'old-operation', command: 'speedtest-exitnodes', busy: true, canWrite: false, canCancel: true });
  fixture.holdNext.add('control.refresh');
  const refresh = app.api.refreshNativeControl();
  const stale = fixture.held.find(r => r.key === 'control.refresh');
  const revision = fixture.control.revision;
  fixture.publishControl({ busy: false, canWrite: true, canCancel: false, result: { ok: true } });
  const latestSequence = fixture.control.sequence;
  stale.finish(); await refresh;
  assert(app.api.nativeControl().sequence === latestSequence && !app.api.nativeControl().busy && app.api.nativeControl().revision === revision,
    'older refresh snapshot cannot overwrite newer read-only completion with unchanged mutation revision');
  fixture.publishControl({ id: 'displayed-operation', busy: true, canWrite: false, canCancel: true });
  fixture.holdNext.add('control.cancel');
  click(window.document.querySelector('.status-chip')); await flush();
  click(button('native_cancel_operation', window.document.querySelector('[data-testid="status-sheet"]')));
  const cancellation = fixture.held.find(r => r.key === 'control.cancel');
  fixture.publishControl({ id: 'replacement-operation', busy: true, canWrite: false, canCancel: true });
  assert(cancellation.request.args.id === 'displayed-operation' && cancellation.request.args.id !== fixture.control.id,
    'global Cancel carries the displayed durable ID rather than targeting whichever operation arrives later');
  cancellation.finish({ ok: false, error: 'Simulated operation identity changed' }); await flush();
  assert(app.api.nativeControl().id === 'replacement-operation' && app.api.nativeControl().busy, 'stale cancellation rejection does not finish replacement operation');
});

await scenario('Traffic cancellation releases busy state and resumes retained page', async ({ fixture, nav, button, window }) => {
  fixture.holdNext.add('traffic');
  await nav('traffic');
  const held = fixture.held.find(r => r.key === 'traffic');
  const before = fixture.log.filter(r => r.action === 'control.query' && r.args.command === 'traffic').length;
  fixture.emit('lifecycle', { active: false });
  held.finish({ ok: false, cancelled: true, error: 'Simulated native pause' }); await flush();
  fixture.emit('lifecycle', { active: true }); await flush();
  assert(fixture.log.filter(r => r.action === 'control.query' && r.args.command === 'traffic').length === before + 1,
    'foregrounding retries the cancelled shared summary exactly once');
  assert(button('net_refresh') && !button('net_refresh').disabled, 'cancelled chart/top/apps loaders release their loading guards');
  assert(window.document.querySelector('.network-traffic-metrics .metric-value')?.textContent !== '—', 'resumed read publishes actual traffic data');
});

await scenario('validated task failure remains authoritative after native success', async ({ app, fixture }) => {
  fixture.overrides.set('backup', { ok: true, path: '/sdcard/Download/foxytail-backup-invalid.tar.gz' });
  await app.backup.createBackup();
  const task = app.tasks.getTask(app.backup.BACKUP_TASK);
  assert(fixture.control.result.ok && task?.status === 'error' && task.result?.ok === false,
    'startValidatedTask rejection survives getTask native/local result merging');
  await app.api.refreshNativeControl();
  assert(app.tasks.getTask(app.backup.BACKUP_TASK)?.status === 'error', 'refreshing native successful receipt cannot erase consumer validation error');
});

await scenario('Native navigation dismisses retained page modal without discarding state', async ({ fixture, nav, window, click, input }) => {
  await nav('settings');
  const settingsPage = window.document.querySelector('.page-transition:not([hidden])');
  input(settingsPage.querySelector('[data-setting="SOCKS_PORT"] input'), '1100'); await flush();
  await nav('peers');
  const peersPage = window.document.querySelector('.page-transition:not([hidden])');
  const peer = () => [...peersPage.querySelectorAll('.network-peer-main')].find(row => row.textContent.includes('home-server'));
  click(peer()); await flush();
  const modal = peersPage.querySelector('dialog[open]');
  assert(!!modal, 'peer detail starts as a modal on the active route');
  fixture.emit('navigate', { page: 'files' }); await flush();
  assert(window.location.hash === '#/files' && !modal.open, 'native navigation closes the old modal');
  assert(!window.document.activeElement?.closest('[hidden]'), 'route dismissal never restores focus into the hidden page');
  fixture.emit('back', {}); await flush();
  assert(window.location.hash === '#/peers' && !peersPage.querySelector('dialog[open]'), 'returning does not reopen the dismissed modal');
  assert(window.document.querySelector('.page-transition:not([hidden])') === peersPage && !!peer(), 'dismissal preserves the retained page and data');
  click(peer()); await flush();
  assert(!!peersPage.querySelector('dialog[open]'), 'peer detail remains available after returning');
  fixture.emit('back', {}); await flush();
  assert(window.location.hash === '#/peers' && !peersPage.querySelector('dialog[open]'), 'Back closes the reopened modal before navigating');
  await nav('settings');
  assert(settingsPage.querySelector('[data-setting="SOCKS_PORT"] input').value === '1100', 'in-session edits survive native navigation');
});

await scenario('Back ignores hidden retained disclosures', async ({ fixture, nav, window }) => {
  await nav('files');
  const details = window.document.querySelector('.menu-pop');
  details.querySelector('summary').click(); await flush();
  assert(details.open, 'Files sorting disclosure is open before navigation');
  await nav('dashboard');
  fixture.emit('back', {}); await flush();
  assert(window.location.hash === '#/files' && details.open, 'Back navigates history without closing a disclosure on the hidden retained route');
});

await scenario('exit rows switch with one tap after confirmation and recheck account', async ({ app, fixture, nav, window, click, confirm }) => {
  await nav('exit');
  const choose = value => click([...window.document.querySelectorAll('input[name="exit-node"]')].find(input => input.value === value));
  const writes = () => fixture.log.filter(r => r.action === 'control.mutate' && ['exitnode-set', 'exitnode-clear'].includes(r.args.command));
  choose('nas'); await confirm(false);
  assert(writes().length === 0, 'declined exit switch does not submit a mutation');
  choose('nas'); await confirm(true);
  assert(writes().length === 1 && writes()[0].args.command === 'exitnode-set' && writes()[0].args.arguments[0] === 'nas', 'confirmed tap submits the chosen peer');
  await app.state.refreshStatus(); await nav('dashboard'); await flush();
  assert([...window.document.querySelectorAll('.conn-row')].find(r => r.textContent.includes(window.__foxy.t('dash_exitnode')))?.textContent.includes('home-server'), 'dashboard exit row shows the peer hostname instead of the raw node id');
  await nav('exit');
  choose(''); await confirm(false);
  assert(writes().length === 1, 'declined exit clear retains current exit');
  choose(''); await confirm(true);
  assert(writes().length === 2 && writes()[1].args.command === 'exitnode-clear', 'explicitly confirmed clear submits once');
  choose('nas'); await flush();
  fixture.data.status.self.id = 'changed-account';
  fixture.data['exit-routing'].selfId = 'changed-account';
  fixture.publishControl({ accountRevision: fixture.control.accountRevision + 1 });
  await app.state.refreshStatus({ afterCurrent: true }); await flush();
  await confirm(true);
  assert(writes().length === 2, 'account change while confirmation is open invalidates the tapped target');
});

await scenario('failed context baseline cannot enable replacement editing', async h => {
  const { fixture, button, click } = h;
  const original = fixture.data['context-get'].rules;
  fixture.overrides.set('context-get', { ok: false, error: 'Simulated rules unavailable' });
  const context = await openContext(h);
  assert(context && (!button('context_add', context) || button('context_add', context).disabled), 'failed initial context read cannot enable Add');
  assert(!button('save', context) || button('save', context).disabled, 'failed initial context read cannot enable Save');
  assert(!context.querySelector('textarea:not([disabled]), [data-testid="context-editor"] input:not([disabled])'), 'failed baseline exposes no editable rules');
  assert(!fixture.log.some(r => r.action === 'control.mutate' && r.args.command === 'context-set'), 'failed read never becomes an empty replacement write');
  fixture.overrides.delete('context-get');
  click(button('context_refresh', context)); await flush();
  assert(button('context_add', context) && !button('context_add', context).disabled, 'successful retry explicitly unlocks editing');
  assert(fixture.data['context-get'].rules === original, 'read failure and recovery retain saved rules verbatim');
});

await scenario('open visual context draft retains original rule baseline', async h => {
  const { fixture, window, input, button, click } = h;
  const original = fixture.data['context-get'].rules;
  const context = await openContext(h);
  click(button('context_edit', context)); await flush();
  input(context.querySelector('[data-testid="context-editor"] input'), 'Unsaved SSID');
  fixture.data['context-get'].rules = 'ssid:Replacement:down\nssid:Home:up\n';
  click(button('context_refresh', context)); await flush();
  assert(context.querySelector('[data-testid="context-editor"] input')?.value === 'Unsaved SSID', 'changed backend rules cannot overwrite an open visual draft');
  click(button('context_apply_rule', context)); await flush();
  click(button('context_text', context)); await flush();
  assert(context.querySelector('textarea')?.value === original.replace('ssid:Home:up', 'ssid:Unsaved SSID:up'),
    'applying an existing visual draft edits its original row, not the replacement backend row at the same index');
  assert(!fixture.log.some(r => r.action === 'control.mutate' && r.args.command === 'context-set'), 'visual editing remains local until explicit save');
  assert(window.document.querySelector('[data-testid="context-rules"]') === context, 'context editor remains mounted during refresh');
});

await scenario('context rules publish before slow status and status resumes only when visible', async h => {
  const { fixture, nav, button } = h;
  fixture.holdNext.add('context-status');
  const context = await openContext(h);
  const stale = fixture.held.find(r => r.key === 'context-status');
  assert(context.querySelector('[data-context-line]') && button('context_add', context) && !button('context_add', context).disabled,
    'slow runtime observation does not block saved rules or local editing');
  await nav('dashboard');
  const statusReads = () => fixture.log.filter(r => r.action === 'control.query' && r.args.command === 'context-status').length;
  const hiddenReads = statusReads();
  fixture.emit('lifecycle', { active: false });
  stale.finish(); await flush();
  assert(!context.querySelector('[data-testid="context-status"]')?.textContent.includes('ssid:Home'), 'late successful observation invalidated by lifecycle cannot republish stale status');
  fixture.emit('lifecycle', { active: true }); await flush();
  assert(statusReads() === hiddenReads, 'hidden retained Settings does not resume context-status reads');
  fixture.data['context-status'].status.context = 'ssid:FreshObservation';
  await nav('settings');
  assert(statusReads() > hiddenReads, 'visible context resumes fresh runtime observation');
  assert(context.querySelector('[data-testid="context-status"]')?.textContent.includes('ssid:FreshObservation'), 'resumed status replaces unknown observation without replacing rules');
  const advanced = context.closest('details.tool-disclosure');
  advanced.open = false; advanced.dispatchEvent(new h.window.Event('toggle')); await flush();
  const closedReads = statusReads();
  fixture.publishControl({ revision: fixture.control.revision + 1 }); await flush();
  assert(statusReads() === closedReads, 'closed Advanced disclosure does not issue status reads on revision change');
  advanced.open = true; advanced.dispatchEvent(new h.window.Event('toggle')); await flush();
  assert(statusReads() > closedReads, 'reopening Advanced resumes deferred status observation');
});

for (const factory of ['createGuardedLoad', 'createQueuedRefresh']) {
  await scenario(factory + ' reschedules superseded and interrupted native reads', async ({ app, fixture }) => {
    const published = [], busy = [];
    const root = app.createRoot(dispose => ({
      dispose,
      refresh: app.toolsRefresh[factory](() => app.api.api('tun'), result => published.push(result), value => busy.push(value)),
    }));
    try {
      fixture.holdNext.add('tun');
      const first = root.refresh();
      const stale = fixture.held.find(r => r.key === 'tun');
      fixture.data.tun.mode = 'proxy';
      fixture.publishControl({ revision: fixture.control.revision + 1 });
      stale.finish(); await first; await flush();
      assert(published.length === 1 && published[0].mode === 'proxy', factory + ' drops superseded reply and publishes its fresh retry');
      fixture.holdNext.add('tun');
      const interrupted = root.refresh();
      const held = fixture.held.findLast(r => r.key === 'tun');
      fixture.emit('lifecycle', { active: false });
      held.finish({ ok: false, cancelled: true, error: 'Simulated background cancellation' }); await interrupted; await flush();
      assert(busy.at(-1) === false, factory + ' releases busy after interrupted read');
      const before = published.length;
      fixture.emit('lifecycle', { active: true }); await flush();
      assert(published.length === before + 1 && published.at(-1).mode === 'proxy', factory + ' retries pending read on foreground resume');
    } finally { root.dispose(); }
  });
}

await scenario('native file preflight cancellation and repeated active cancellation', async ({ fixture, nav, window, button, click, confirm }) => {
  await nav('files');
  fixture.publishFiles({ selection: [{ key: 'simulated-source', name: 'notes.txt', size: 120, source: 'uri' }] });
  // Only response envelopes are simulated; no picker or binary transfer is exercised.
  fixture.overrides.set('files.send', { ok: true, accepted: true });
  fixture.overrides.set('files.cancel', { ok: true, requested: true });
  fixture.holdNext.add('files.send');
  click(button('files_send_btn')); await confirm(true);
  const send = fixture.held.find(r => r.key === 'files.send');
  fixture.publishFiles({ busy: true, preparing: true, job: null });
  const sendSection = window.document.querySelector('#files-send');
  fixture.holdNext.add('files.cancel');
  click(button('files_cancel_send', sendSection));
  const preflightCancel = fixture.held.find(r => r.key === 'files.cancel');
  assert(preflightCancel && !Object.hasOwn(preflightCancel.request.args, 'job'), 'pending native send remains cancellable without sending an old job ID');
  assert(button('files_cancel_send', sendSection).disabled, 'duplicate cancellation is blocked only while cancellation request is in flight');
  preflightCancel.finish(); await flush();
  assert(!button('files_cancel_send', sendSection).disabled, 'accepted preflight cancellation does not latch the button while send still awaits a result');
  const transfer = copy(fixture.transfer);
  transfer.id = 'b1'; transfer.status = 'sending'; transfer.updatedAt++;
  transfer.files[1].status = 'sending';
  fixture.publishFiles({ busy: true, preparing: false, job: transfer.id, transfer });
  send.finish(); await flush();
  fixture.overrides.set('files.cancel', { ok: false, error: 'Simulated cancellation not confirmed' });
  click(button('files_cancel_send', sendSection)); await flush();
  assert(!button('files_cancel_send', sendSection).disabled, 'failed active cancellation leaves manual retry enabled');
  fixture.overrides.set('files.cancel', { ok: true, requested: true });
  click(button('files_cancel_send', sendSection)); await flush();
  const cancels = fixture.log.filter(r => r.action === 'files.cancel');
  assert(cancels.length === 3 && cancels[1].args.job === 'b1' && cancels[2].args.job === 'b1', 'manual cancellation retries target the current active job after send acceptance');
  assert(!button('files_cancel_send', sendSection).disabled && fixture.files.busy, 'requested cancellation is feedback, not a fabricated terminal transfer outcome');
});

await scenario('feedback primitives keep errors readable and name destructive actions', async ({ app, window }) => {
  app.toast.showToast('Simulated failure detail', 'err'); await flush();
  const error = [...window.document.querySelectorAll('.toast.err')].find(node => node.textContent.includes('Simulated failure detail'));
  assert(error?.querySelector(`button[aria-label="${app.t('close')}"]`) && error.querySelector(`button[aria-label="${app.t('copy')}"]`), 'error toast offers copy and explicit dismissal');
  const answer = app.confirm.confirmDialog({ title: 'Stop?', body: 'Body', confirmLabel: 'Stop now', tone: 'danger' }); await flush();
  const accept = window.document.querySelector('dialog[open] [data-dialog-action="confirm"]');
  assert(accept?.textContent.trim() === 'Stop now' && accept.classList.contains('danger'), 'destructive confirmation uses a verb and danger styling');
  window.document.querySelector('dialog[open] [data-dialog-action="cancel"]').click();
  assert(await answer === false, 'cancel resolves the confirmation as declined');
});

await scenario('dashboard states expose one status and a direct recovery action', async ({ app, fixture, nav, window, button, click }) => {
  const now = Date.UTC(2026, 9, 30);
  assert(app.format.keyExpiry('0001-01-01T00:00:00Z', now) === null, 'disabled key expiry sentinel is not reported');
  assert(app.format.keyExpiry(new Date(now + 30 * 864e5).toISOString(), now) === null, 'distant key expiry is not reported');
  assert(app.format.keyExpiry(new Date(now + 2 * 864e5).toISOString(), now)?.expired === false, 'near key expiry is reported as expiring');
  assert(app.format.keyExpiry(new Date(now - 864e5).toISOString(), now)?.expired === true, 'past key expiry is reported as expired');
  fixture.data.status.daemon = 'stopped'; fixture.data.status.backend = 'NoState';
  await app.state.refreshStatus(); await nav('dashboard');
  assert(window.document.querySelector('.network-page .is-stale'), 'stopped dashboard marks last known data as stale');
  click(button('dash_start_service')); await flush();
  assert(fixture.log.some(r => r.action === 'control.mutate' && r.args.command === 'control' && r.args.arguments[0] === 'start'), 'stopped dashboard starts the service from its status card');
  fixture.data.status.daemon = 'running'; fixture.data.status.backend = 'NeedsLogin';
  await app.state.refreshStatus(); await flush();
  const titles = [...window.document.querySelectorAll('.page-transition:not([hidden]) h2')].filter(h => h.textContent.includes(app.t('hero_login_title')));
  assert(titles.length === 1, 'login state renders a single login status card');
});

await scenario('status sheet mirrors the connection card without top-bar controls', async ({ app, fixture, nav, window, button, click, confirm }) => {
  await nav('dashboard');
  assert(!window.document.querySelector('#app-header select, #app-header .service-controls'), 'service controls no longer occupy the top bar');
  const chip = window.document.querySelector('.status-chip');
  assert(!!chip, 'header exposes a compact status chip');
  chip.click(); await flush();
  const sheet = window.document.querySelector('[data-testid="status-sheet"]');
  assert(sheet?.open && sheet.querySelector('.service-actions'), 'chip opens the shared service status sheet');
  click(button('native_stop', sheet)); await confirm(true);
  assert(fixture.log.some(r => r.action === 'control.mutate' && r.args.command === 'control' && r.args.arguments[0] === 'stop'), 'sheet stop confirms before mutating');
  await app.state.refreshStatus({ afterCurrent: true }); await flush();
  const start = button('dash_start_service', sheet);
  assert(!!start && !start.disabled, 'stopped sheet offers the start action');
  click(start); await flush();
  assert(fixture.log.filter(r => r.action === 'control.mutate' && r.args.command === 'control').length === 2, 'sheet start runs through the shared store');
  const modeRow = sheet.querySelector('.status-sheet-row');
  assert(modeRow?.getAttribute('href') === '#/network' && !window.document.querySelector('#app-header select'), 'run mode is reachable from the sheet, not the top bar');
  const bottomItems = [...window.document.querySelectorAll('#bottom-nav .nav-item')].map(item => item.getAttribute('href'));
  assert(bottomItems.length === 5 && bottomItems.includes('#/network') && bottomItems.includes('#/settings') && !bottomItems.includes('#/more'), 'primary navigation is home, devices, files, network, settings');
  await nav('network');
  assert(window.document.querySelector('[data-testid="mode-picker"]'), 'run mode picker lives on the network page');
  assert(window.document.querySelector('.tool-links'), 'network hub links into the detail tools');
  await nav('tunnel');
  assert(window.document.querySelector('.back-link')?.getAttribute('href') === '#/network', 'tunnel detail navigates back to the network hub');
  await nav('exit');
  assert(window.document.querySelector('.back-link')?.getAttribute('href') === '#/network', 'exit detail navigates back to the network hub');
  assert(window.document.querySelectorAll('input[name="exit-node"]').length > 0, 'exit page renders switchable rows');
  assert(window.document.querySelectorAll('.network-exit-options button').length === 0, 'exit switching has no separate apply button');
  const hubExit = [...window.document.querySelectorAll('a')].find(a => a.getAttribute('href') === '#/exit');
  assert(!!hubExit, 'exit page is reachable through a link');
  await nav('peers');
  assert(!window.document.querySelector('input[name="exit-node"]'), 'device inventory no longer embeds the exit workflow');
});

await scenario('manual DNS checks own their local progress and cancellation', async ({ fixture, nav, window, button, click }) => {
  await nav('diag');
  const details = window.document.querySelector('[data-testid="diagnostic-details"]');
  details.open = true; details.dispatchEvent(new window.Event('toggle')); await flush();
  fixture.holdNext.add('dns-probe');
  click(button('dns_check', details)); await flush();
  const progress = details.querySelector('[data-task-key="dns-probe"]');
  assert(progress && !window.document.querySelector('.status-notice'), 'explicit probe progress stays beside the requested diagnostics');
  click(progress.querySelector('button')); await flush();
  assert(fixture.log.some(r => r.action === 'control.cancel' && r.args.id === fixture.control.id), 'local probe cancel targets the active durable operation');
  fixture.held.findLast(r => r.key === 'dns-probe').finish({ ok: false, cancelled: true }); await flush();
  assert(!details.querySelector('[data-task-key="dns-probe"]'), 'terminal cancelled probe removes local progress');
});

await scenario('critical feedback is compact and uses availability errors, not task messages', async ({ fixture, nav, window, button, click }) => {
  await nav('settings');
  fixture.publishControl({ checking: true, compatible: true, busy: false, unknown: false }); await flush();
  assert(!window.document.querySelector('.status-notice') && !window.document.querySelector('.root-banner'), 'background access check does not create a page warning');
  assert(!!window.document.querySelector('.status-chip .circular-progress'), 'background check uses the existing compact status indicator');
  fixture.publishControl({ checking: false, compatible: false, canWrite: false, busy: true, ownsMutation: false, command: 'dns-probe', id: 'probe', error: 'Module version is incompatible', message: 'Running dns-probe' }); await flush();
  const notice = window.document.querySelector('.status-notice');
  assert(notice && notice.querySelectorAll('button').length === 1 && !notice.querySelector('.native-issue-actions'), 'critical failure retains one compact details entry instead of a second action row');
  click(notice.querySelector('button')); await flush();
  const sheet = window.document.querySelector('[data-testid="status-sheet"]');
  assert(sheet.open && sheet.textContent.includes('Module version is incompatible') && !sheet.textContent.includes('Running dns-probe'), 'availability failure cannot display an unrelated task progress message');
  assert(!!button('native_recheck', sheet), 'retry remains discoverable in the existing status sheet');
  fixture.publishControl({ compatible: true, unknown: true, canWrite: false, canCancel: true, error: '', command: 'settings-set' }); await flush();
  assert(window.document.querySelector('.status-notice')?.textContent.includes('unconfirmed'), 'unknown outcome remains a persistent visible warning');
  assert(!!button('native_unlock', sheet) && !!button('native_cancel_operation', sheet), 'unknown confirmation and available cancellation remain accessible');
  fixture.publishControl({ unknown: false, busy: false, compatible: true, canWrite: true, canCancel: false }); await flush();
  assert(!window.document.querySelector('.status-notice'), 'resolved state removes the compact warning');
});

await scenario('untracked native busy lives in the status chip, not a page banner', async ({ fixture, nav, window, button, click }) => {
  await nav('files');
  fixture.publishControl({ busy: true, canWrite: false, canCancel: true, id: 'op-busy-1', message: 'Operation in progress: simulated' });
  await flush();
  assert(!window.document.querySelector('.root-banner'), 'untracked busy does not raise a page banner');
  const chip = window.document.querySelector('.status-chip');
  assert(chip?.querySelector('.circular-progress'), 'status chip spins while the backend is busy');
  chip.click(); await flush();
  const sheet = window.document.querySelector('[data-testid="status-sheet"]');
  assert(sheet?.open && button('native_cancel_operation', sheet), 'busy operations remain cancellable from the status sheet');
  click(button('native_cancel_operation', sheet)); await flush();
  assert(fixture.log.some(r => r.action === 'control.cancel'), 'sheet cancel reaches the native channel');
  fixture.publishControl({ busy: false, canWrite: true, canCancel: false, message: '' });
  await flush();
  assert(!chip.querySelector('.circular-progress'), 'chip settles once the backend is idle');
});

await (await import('./smoke-account-identity.mjs')).runAccountIdentitySmoke();
await (await import('./smoke-account-details.mjs')).runAccountDetailsSmoke();
await (await import('./smoke-toast-dedup.mjs')).runToastDedupSmoke();
await (await import('./smoke-status-modal.mjs')).runStatusModalSmoke();
await (await import('./smoke-motion.mjs')).runMotionSmoke();
await (await import('./smoke-back-state.mjs')).runBackStateSmoke();
await import('./smoke-read-recovery.mjs');
await (await import('./smoke-dns-capability.mjs')).runDnsCapabilitySmoke();

for (const state of ['empty', 'error', 'no-root', 'no-bridge', 'unknown']) {
  console.log('availability: ' + state);
  const h = await boot({ state });
  try {
    assert(!!h.window.document.querySelector('#view'), state + ' renders shell');
    if (state === 'no-root' || state === 'no-bridge') {
      assert(!h.app.api.nativeControl().canWrite, state + ' cannot enable mutations');
      assert(!!h.window.document.querySelector('.status-notice'), state + ' access problem remains visibly discoverable');
    }
    if (state === 'empty') assert(h.app.state.peers()?.length === 0, 'empty peers are not a load failure');
    if (state === 'error') assert(!!h.app.state.statusError(), 'failed read stays explicit failure');
    if (state === 'unknown') {
      assert(h.app.api.nativeControl().unknown && h.app.api.nativeControl().id === 'preview-unresolved', 'bootstrap adopts native unresolved operation');
      assert(!h.fixture.log.some(r => r.action === 'control.mutate'), 'recreation does not resubmit unresolved operation');
    }
    assert(h.fixture.unsupported.length === 0, state + ' uses supported fixture actions');
  } finally { h.close(); }
}

await (await import('./smoke-fields.mjs')).runFieldsSmoke();

if (failures.length) {
  console.error('SMOKE FAILURES:\n' + failures.map(failure => ' - ' + failure).join('\n'));
  process.exitCode = 1;
} else console.log(`SMOKE OK (${checks} assertions)`);
