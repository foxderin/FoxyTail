// Behavioral checks intentionally never dispatch animationend: motion cannot
// own navigation, retained-page lifetime, dismissal or focus restoration.
import { readFileSync } from 'node:fs';
import { boot, assert, flush } from './smoke-fixture.mjs';

export async function runMotionSmoke() {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  const pageFrames = css.match(/@keyframes ft-page-in\s*\{([^\n]+)/)?.[1] || '';
  assert(pageFrames.includes('opacity') && !pageFrames.includes('transform'), 'page motion cannot create a fixed-menu containing block');
  assert(css.includes('.page-transition:not([hidden])'), 'retained page entrance resets when hidden');
  assert(/prefers-reduced-motion: reduce[\s\S]*animation: none !important/.test(css), 'reduced motion explicitly disables decorative entrances');
  const h = await boot();
  try {
    await h.nav('settings');
    const page = h.window.document.querySelector('.page-transition:not([hidden])');
    const menu = page.querySelector('.select-pop');
    menu.open = true; menu.dispatchEvent(new h.window.Event('toggle')); await flush();
    const summary = menu.querySelector('summary');
    summary.focus();
    summary.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert(!menu.open && h.window.document.activeElement === summary, 'dropdown Escape dismisses and restores focus without animation completion');
    menu.open = true; menu.dispatchEvent(new h.window.Event('toggle')); await flush();
    h.fixture.emit('back', {}); await flush();
    assert(!menu.open && h.window.location.hash === '#/settings', 'Back closes animated dropdown before navigating');
    await h.nav('files'); await h.nav('settings');
    assert(h.window.document.querySelector('.page-transition:not([hidden])') === page, 'rapid route return preserves page identity instead of replaying setup');
    assert(h.window.document.querySelectorAll('.page-transition:not([hidden])').length === 1, 'only one route participates in focus and layout during transition');
    assert(!menu.open, 'returning to retained page does not reopen dismissed menu');
    assert(h.fixture.unsupported.length === 0, 'motion uses no unsupported native commands');
  } finally { h.close(); }
}
