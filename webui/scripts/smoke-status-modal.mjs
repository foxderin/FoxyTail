import { boot, assert, flush } from './smoke-fixture.mjs';
export async function runStatusModalSmoke() {
  const h = await boot();
  const {window, fixture, nav, click} = h;
  try {
    const sheet = window.document.querySelector('.status-sheet');
    const trigger = sheet.querySelector('summary');
    const panel = sheet.querySelector('.status-sheet-panel');
    assert(panel.tagName === 'DIALOG', 'status sheet delegates focus containment and inert background to native dialog');
    click(trigger); await flush();
    assert(sheet.open && panel.open, 'trigger opens status as modal');
    assert(window.document.activeElement === panel.querySelector('.status-sheet-head button'), 'status opening focuses close control');
    fixture.emit('back', {}); await flush();
    assert(!sheet.open && !panel.open && window.document.activeElement === trigger, 'Back closes modal once and restores its trigger');
    click(trigger); await flush();
    panel.dispatchEvent(new window.Event('cancel', {cancelable: true})); await flush();
    assert(!sheet.open && !panel.open, 'native dialog cancellation synchronizes details trigger');
    click(trigger); await flush();
    await nav('settings');
    assert(!sheet.open && !panel.open, 'navigation removes modal top layer without retaining a hidden dialog');
    click(trigger); await flush();
    panel.dispatchEvent(new window.MouseEvent('click', {bubbles: true, clientX: -1, clientY: -1})); await flush();
    assert(!panel.open && window.document.activeElement === trigger, 'backdrop dismissal restores trigger');
    assert(fixture.unsupported.length === 0, 'modal polish introduces no unsupported native commands');
  } finally { h.close(); }
}
