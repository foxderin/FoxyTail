/*
 * FoxyTail WebUI — MD3 theme: full --md-sys-color-* token set derived from
 * the fox-orange seed #E0632F via material-color-utilities, with
 * dark / light / auto (prefers-color-scheme) modes persisted to
 * localStorage under "foxy.theme".
 */
import { argbFromHex, themeFromSourceColor, applyTheme as applyMcuTheme } from '@material/material-color-utilities';

export type ThemeMode = 'dark' | 'light' | 'auto';

const SEED = argbFromHex('#E0632F');
const MCU_THEME = themeFromSourceColor(SEED);

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
const [dark, setDark] = createSignal(true);

export { mode, dark };

function resolveDark(m: ThemeMode): boolean {
  if (m === 'auto') return !(mql && mql.matches);
  return m === 'dark';
}

function paint(m: ThemeMode): void {
  const isDark = resolveDark(m);
  setDark(isDark);
  const root = document.documentElement;
  applyMcuTheme(MCU_THEME, { target: root, dark: isDark });
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
