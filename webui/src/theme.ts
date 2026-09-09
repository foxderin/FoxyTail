/*
 * FoxyTail WebUI — MD3 theme: full --md-sys-color-* token set derived from
 * the fox-orange seed #E0632F via precomputed material-color-utilities, with
 * dark / light / auto (prefers-color-scheme) modes persisted to
 * localStorage under "foxy.theme".
 */
import { THEME_TOKENS } from './theme.generated';

export type ThemeMode = 'dark' | 'light' | 'auto';

import { createSignal } from 'solid-js';

const mql: MediaQueryList | null =
  typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;

function loadSaved(): ThemeMode {
  try {
    const m = localStorage.getItem('foxy.theme');
    if (m === 'dark' || m === 'light' || m === 'auto') return m;
  } catch {
    /* ignore */
  }
  return 'dark';
}

const [mode, setModeSignal] = createSignal<ThemeMode>(loadSaved());

export { mode };

function resolveDark(m: ThemeMode): boolean {
  if (m === 'auto') return !(mql && mql.matches);
  return m === 'dark';
}

function paint(m: ThemeMode): void {
  const isDark = resolveDark(m);
  const root = document.documentElement;
  for (const [token, value] of Object.entries(THEME_TOKENS[isDark ? 'dark' : 'light'])) {
    root.style.setProperty(token, value);
  }
  root.setAttribute('data-theme', m);
  root.setAttribute('data-theme-effective', isDark ? 'dark' : 'light');
  root.style.colorScheme = isDark ? 'dark' : 'light';
}

export function applyTheme(m: ThemeMode): void {
  setModeSignal(m);
  paint(m);
  try {
    localStorage.setItem('foxy.theme', m);
  } catch {
    /* ignore */
  }
}

export function initTheme(): void {
  paint(mode());
  if (mql) {
    const onChange = () => {
      if (mode() === 'auto') paint('auto');
    };
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange);
    else if (typeof mql.addListener === 'function') mql.addListener(onChange);
  }
}

/* Read a resolved MD3 token (used by the canvas charts). */
export function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
