/* Native preferences are authoritative; WebView follows the system palette. */
import { THEME_TOKENS } from './theme.generated';
import { onNativeEvent, requestNative } from './native';
import { toastApiError } from './components/Toast';
import { t } from './i18n';

export type ThemeMode = 'dark' | 'light' | 'auto';

import { createSignal } from 'solid-js';

const mql: MediaQueryList | null =
  typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;

const [mode, setModeSignal] = createSignal<ThemeMode>('auto');

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
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark ? '#15181e' : '#f5f6f8');
}

export function installTheme(appearance: Record<string, unknown>): void {
  const theme = appearance.theme;
  if (theme !== 'auto' && theme !== 'light' && theme !== 'dark') return;
  setModeSignal(theme);
  paint(theme);
}
export function applyTheme(theme: ThemeMode): void {
  void requestNative('app.appearance', { theme }).then(result => {
    if (result.ok && result.appearance) installTheme(result.appearance as Record<string, unknown>);
    else toastApiError(t('op_failed'), result);
  });
}
onNativeEvent('appearance', result => {
  if (result.appearance) installTheme(result.appearance as Record<string, unknown>);
});

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
