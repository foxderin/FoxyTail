import { createEffect, createSignal, onCleanup } from 'solid-js';
import { requestNative } from './native';
import { toastApiError } from './components/Toast';
import { t } from './i18n';
import type { I18nKey } from './i18n';

export type Field = {
  key: string;
  label: I18nKey;
  hint?: I18nKey;
  range?: [number, number];
  bool?: boolean;
  defaultValue?: string;
  choices?: { value: string; label: I18nKey; hint: I18nKey; disabled?: boolean; disabledHint?: I18nKey }[];
};
export const NETWORK: Field[] = [
  { key: 'MAGIC_DNS', label: 'tools_magicdns', hint: 'tools_magicdns_desc', bool: true },
  {
    key: 'DNS_MODE', label: 'tools_dns_mode', defaultValue: 'legacy', choices: [
      { value: 'legacy', label: 'tools_dns_mode_legacy', hint: 'tools_dns_mode_legacy_hint' },
      { value: 'local', label: 'tools_dns_mode_local', hint: 'tools_dns_mode_local_hint' },
      { value: 'transparent', label: 'tools_dns_mode_transparent_option', hint: 'tools_dns_mode_transparent_hint' },
    ],
  },
  { key: 'IPV6', label: 'tools_ipv6', hint: 'set_ipv6_hint', bool: true },
  { key: 'SOCKS_PORT', label: 'tools_socks_port', range: [1024, 65535] },
  { key: 'DNS_PORT', label: 'tools_dns_port', hint: 'tools_dns_port_hint', range: [1024, 65535] },
];
export const BACKGROUND: Field[] = [
  { key: 'POWER_SAVE', label: 'tools_power_save', hint: 'tools_power_save_desc', bool: true, defaultValue: 'off' },
  { key: 'WATCHDOG', label: 'tools_watchdog', hint: 'tools_watchdog_desc', bool: true, defaultValue: 'on' },
  { key: 'WATCHDOG_PROBE', label: 'tools_watchdog_probe', hint: 'tools_watchdog_probe_desc', bool: true, defaultValue: 'on' },
  { key: 'STATS', label: 'tools_stats_enabled', hint: 'tools_stats_enabled_desc', bool: true, defaultValue: 'on' },
  { key: 'CONTEXT', label: 'tools_context_enabled', hint: 'tools_context_enabled_desc', bool: true, defaultValue: 'on' },
  { key: 'WEBUI_AUTO_REFRESH', label: 'tools_auto_refresh', hint: 'tools_auto_refresh_desc', bool: true, defaultValue: 'on' },
  { key: 'WATCHDOG_INTERVAL', label: 'tools_watchdog_interval', range: [5, 300] },
  { key: 'STATS_INTERVAL', label: 'tools_stats_interval', range: [10, 3600] },
  { key: 'LOG_MAX_KB', label: 'tools_log_limit', range: [64, 10240] },
];

/** Bundle-backed non-secret drafts survive Activity recreation, not app restarts. */
export function bindNativeDraft(
  key: 'settings' | 'routes' | 'context' | 'serve' | 'logs' | 'coexist' | 'trial' | 'exit',
  snapshot: () => Record<string, unknown>,
  restore: (value: Record<string, unknown>) => void,
): Promise<void> {
  const [ready, setReady] = createSignal(false);
  let disposed = false;
  let reported = false;
  onCleanup(() => { disposed = true; });
  createEffect(() => {
    const value = snapshot();
    if (!ready()) return;
    void requestNative('app.drafts', { key, value }).then(result => {
      if (!result.ok && !reported && !disposed) { reported = true; toastApiError(t('op_failed'), result); }
    });
  });
  return requestNative('app.drafts', { key }).then(result => {
    if (disposed) return;
    if (result.ok && result.value && typeof result.value === 'object' && !Array.isArray(result.value))
      restore(result.value as Record<string, unknown>);
    else if (!result.ok) toastApiError(t('op_failed'), result);
    setReady(true);
  });
}
