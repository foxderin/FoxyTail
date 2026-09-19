import type { I18nKey } from './i18n';

export type Field = {
  key: string;
  label: I18nKey;
  hint?: I18nKey;
  range?: [number, number];
  bool?: boolean;
  defaultValue?: string;
  choices?: { value: string; label: I18nKey; hint: I18nKey }[];
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
  { key: 'WATCHDOG', label: 'tools_watchdog', hint: 'tools_watchdog_desc', bool: true },
  { key: 'WATCHDOG_INTERVAL', label: 'tools_watchdog_interval', range: [5, 300] },
  { key: 'STATS_INTERVAL', label: 'tools_stats_interval', range: [10, 3600] },
  { key: 'LOG_MAX_KB', label: 'tools_log_limit', range: [64, 10240] },
];
export const ROUTE_TABLE: Field = { key: 'ROUTE_TABLE', label: 'tools_route_table', range: [1000, 65535] };
