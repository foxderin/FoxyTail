import { readFileSync } from 'node:fs';
import { boot, assert, flush } from './smoke-fixture.mjs';
export async function runFieldsSmoke() {
  const h = await boot();
  const { nav, window } = h;
  try {
    await nav('diag');
    const field = window.document.querySelector('.page-transition:not([hidden]) .select-field');
    const popup = field.querySelector('details'), summary = popup.querySelector('summary'), native = field.querySelector('select');
    let changes = 0, scrolled = null;
    native.addEventListener('change', () => changes++);
    window.Element.prototype.scrollIntoView = function () { scrolled = this; };
    const disabled = window.document.createElement('option'); disabled.value = 'test-disabled'; disabled.text = 'Disabled'; disabled.disabled = true;
    native.insertBefore(disabled, native.options[1]); await flush();
    const key = (element, value) => element.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
    summary.focus(); key(summary, 'ArrowDown'); await flush();
    const items = () => [...popup.querySelectorAll('[role=option]')];
    assert(window.document.activeElement === items().find(item => item.getAttribute('aria-selected') === 'true'), 'opening Select focuses selected enabled option');
    assert(scrolled === window.document.activeElement, 'focused option scrolls into view');
    key(window.document.activeElement, 'Home');
    assert(window.document.activeElement === items()[0], 'Home focuses first enabled option');
    key(window.document.activeElement, 'ArrowDown');
    assert(window.document.activeElement === items()[2], 'ArrowDown skips disabled option');
    key(window.document.activeElement, 'End');
    assert(window.document.activeElement === items().at(-1), 'End focuses last enabled option');
    key(window.document.activeElement, 'ArrowUp');
    assert(window.document.activeElement === items()[0], 'ArrowUp skips disabled option');
    assert(changes === 0, 'keyboard browsing never commits a value');
    key(window.document.activeElement, 'Escape');
    assert(!popup.open && window.document.activeElement === summary && changes === 0, 'Escape restores trigger focus without selection');
    key(summary, 'ArrowDown'); await flush();
    key(window.document.activeElement, 'End'); window.document.activeElement.click(); await flush();
    assert(changes === 1 && !popup.open && window.document.activeElement === summary, 'explicit activation commits exactly once and restores focus');
    key(summary, 'ArrowDown'); await flush();
    const outside = window.document.createElement('button'); window.document.body.append(outside); outside.focus(); await flush();
    assert(!popup.open && window.document.activeElement === outside, 'Tab/focus departure closes popup without stealing focus');
    outside.remove(); summary.focus(); key(summary, 'End'); await flush();
    assert(window.document.activeElement === items().at(-1), 'End on closed Select opens at last enabled option');
    key(window.document.activeElement, 'Escape');
    const group = window.document.createElement('optgroup'); group.disabled = true;
    const groupedOption = window.document.createElement('option'); groupedOption.value = 'group-disabled'; groupedOption.text = 'Disabled group';
    group.append(groupedOption); native.append(group); await flush();
    key(summary, 'End'); await flush();
    assert(items().at(-1).disabled && window.document.activeElement !== items().at(-1), 'disabled optgroup options cannot gain keyboard focus');
    key(window.document.activeElement, 'Escape');
    await nav('account');
    const input = window.document.querySelector('.page-transition:not([hidden]) .input-field');
    const style = window.document.createElement('style'); style.textContent = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8'); window.document.head.append(style);
    assert(window.getComputedStyle(input).display === 'grid', 'TextField uses flow rows rather than fixed label overlay');
    const label = input.querySelector('.text-field-label');
    if (label) { label.textContent = 'LongAccessibleLabel'.repeat(20); assert(window.getComputedStyle(label).position !== 'absolute', 'long TextField label remains in normal flow'); }
    assert(h.fixture.unsupported.length === 0, 'field interactions use existing native contract');
  } finally { h.close(); }
}
