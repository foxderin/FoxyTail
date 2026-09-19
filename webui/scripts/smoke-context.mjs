import { fileURLToPath } from 'node:url';
import { bundle, window, canned, overrides, commandLog, nav, flush, assert, failures, checks } from './smoke-fixture.mjs';

export async function checkContextRules() {
  console.log('visual context rules preserve raw data and confirmed execution state');
  const previous = canned['context-get'];
  const previousSet = canned['context-set'];
  const original = '# Keep this comment\r\nssid:Home:up\r\nssid:Home:exit-node:fd7a:115c:a1e0::2\r\nfuture:unsupported:action\r\ncellular:-:no-exit-node';
  const card = () => window.document.querySelector('[data-testid="context-rules"]');
  const button = pattern => [...(card()?.querySelectorAll('button') || [])].find(item => pattern.test(item.textContent));
  const rows = () => [...(card()?.querySelectorAll('[data-context-line]') || [])];
  const editor = () => card()?.querySelector('[data-testid="context-editor"]');
  const submit = () => editor()?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const change = (field, value) => { field.value = value; field.dispatchEvent(new window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const writes = () => commandLog.filter(entry => entry.sub === 'context-set');
  const writtenRules = () => Buffer.from(writes().at(-1)?.args[0] || '', 'base64').toString('utf8');
  try {
    canned['context-get'] = { ok: true, rules: original, status: { running: true, context: 'ssid:Home', lastResult: null } };
    canned['context-set'] = { ok: true };
    nav('more'); await flush(); nav('settings'); await flush();
    const advanced = window.document.querySelector('.tool-disclosure');
    advanced.open = true;
    advanced.dispatchEvent(new window.Event('toggle'));
    await flush(24);
    assert(card() && rows().length === 4, 'visual rules keep duplicate network actions and every unrecognized line');
    assert(rows()[2]?.querySelector('[role="alert"]') && rows()[2].textContent.includes('future:unsupported:action'), 'unsupported syntax is visible with its original text');
    assert(card()?.textContent.includes('fd7a:115c:a1e0::2'), 'IPv6 exit-node arguments remain a single rule argument');
    assert(!card()?.querySelector('[data-testid="context-status"] .tone-success') && /No confirmed|尚无确认/.test(card()?.textContent || ''), 'missing runtime results never imply execution success');
    button(/Advanced text|高级文本/)?.click();
    overrides['context-set'] = [1, JSON.stringify({ ok: false, error: 'context-rule-validation-failed' }), ''];
    button(/^(Save|保存)$/)?.click(); await flush();
    assert(writtenRules() === original, 'switching to text mode preserves comments, CRLF and no final newline byte-for-byte');
    assert(card()?.textContent.includes('context-rule-validation-failed'), 'backend validation failure leaves the draft visible');
    button(/Visual editor|可视编辑/)?.click();
    rows()[2]?.querySelectorAll('button')[3]?.click();
    assert(rows().length === 3 && !card()?.textContent.includes('future:unsupported:action'), 'only explicit deletion removes an unsupported rule');
    rows()[0]?.querySelectorAll('button')[1]?.click();
    assert(rows()[0]?.textContent.includes('fd7a:115c:a1e0::2'), 'reordering preserves multiple actions for the same SSID');
    rows()[1]?.querySelectorAll('button')[2]?.click();
    change(editor().querySelectorAll('select')[1], 'down'); submit();
    assert(/Stop tunnel|停止隧道/.test(rows()[1]?.textContent || ''), 'editing an existing action updates that rule');
    button(/Add rule|添加规则/)?.click();
    change(editor().querySelector('input'), 'unknown'); submit();
    assert(editor()?.querySelector('[role="alert"]') && rows().length === 3, 'reserved SSID placeholders are rejected without altering the rules');
    change(editor().querySelector('input'), '家里的 Wi-Fi'); submit();
    assert(rows().length === 4 && rows()[3]?.textContent.includes('家里的 Wi-Fi'), 'a valid Unicode SSID can be added');
    canned['context-get'].status.lastResult = { context: 'ssid:Home', ok: false, at: 1700000000, error: 'context-action-failed' };
    button(/Refresh execution status|刷新执行状态/)?.click(); await flush();
    assert(card()?.querySelector('[data-testid="context-status"] .tone-warning') && !card()?.querySelector('[data-testid="context-status"] .tone-success'), 'a partially failed action group is visibly failed');
    assert(rows().length === 4 && rows()[3]?.textContent.includes('家里的 Wi-Fi'), 'refreshing execution status cannot overwrite unsaved edits');
    delete overrides['context-set'];
    button(/^(Save|保存)$/)?.click(); await flush();
    const expected = '# Keep this comment\r\nssid:Home:exit-node:fd7a:115c:a1e0::2\r\nssid:Home:down\r\ncellular:-:no-exit-node\r\nssid:家里的 Wi-Fi:up\r\n';
    assert(writtenRules() === expected, 'visual edits preserve untouched comments, ordering, address arguments and line-ending style');
    assert(card()?.querySelector('[data-testid="context-status"] .tone-warning'), 'saving rules does not claim failed runtime actions have succeeded');
    canned['context-get'].status.lastResult = { context: 'ssid:Home', ok: true };
    button(/Refresh execution status|刷新执行状态/)?.click(); await flush();
    assert(!card()?.querySelector('[data-testid="context-status"] .tone-success'), 'malformed execution results cannot claim success');
    canned['context-get'].status.lastResult = { context: 'ssid:Home', ok: true, at: 1700000010 };
    button(/Refresh execution status|刷新执行状态/)?.click(); await flush();
    assert(card()?.querySelector('[data-testid="context-status"] .tone-success'), 'only a confirmed successful whole-group result displays success');
    button(/Advanced text|高级文本/)?.click();
    const raw = card()?.querySelector('textarea');
    change(raw, 'cellular:-:up\ncellular:-:exit-node:router.example\nssid:Home:down:extra\n\u00a0');
    button(/Visual editor|可视编辑/)?.click();
    assert(rows().length === 4 && rows().filter(row => row.querySelector('[role="alert"]')).length === 2, 'advanced text reparses supported rules without hiding malformed or non-ASCII whitespace lines');
    // Load exact CRLF bytes; native textarea editing normalizes line endings.
    canned['context-get'].rules = '# before\r\nssid:Home:up\r\ncellular:-:down';
    nav('more'); await flush(); nav('settings'); await flush();
    const reopened = window.document.querySelector('.tool-disclosure');
    reopened.open = true; reopened.dispatchEvent(new window.Event('toggle')); await flush(24);
    rows()[1]?.querySelectorAll('button')[0]?.click();
    button(/^(Save|保存)$/)?.click(); await flush();
    assert(writtenRules() === '# before\r\ncellular:-:down\r\nssid:Home:up', 'moving an unterminated last line preserves each position line ending');
    rows()[1]?.querySelectorAll('button')[3]?.click();
    button(/^(Save|保存)$/)?.click(); await flush();
    assert(writtenRules() === '# before\r\ncellular:-:down\r\n', 'deleting the final rule preserves the preceding CRLF line ending');
  } finally {
    canned['context-get'] = previous;
    if (previousSet === undefined) delete canned['context-set']; else canned['context-set'] = previousSet;
    delete overrides['context-set'];
    nav('more'); await flush();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  window.eval(bundle);
  await flush();
  await checkContextRules();
  window.close();
  if (failures.length) console.error(failures.join('\n'));
  else console.log(`CONTEXT SMOKE OK (${checks} assertions)`);
  process.exit(failures.length ? 1 : 0);
}
