/* DNS capability logic for the Tunnel page: reason and path labels, badge tone
 * and the measured listener endpoint. Pure helpers, no component state. */
import type { ApiResult } from '../api';
import { t, type I18nKey } from '../i18n';
import type { StatusTone } from '../components/Basics';

export interface DnsInfo extends ApiResult {
  mode?: 'legacy' | 'local' | 'transparent';
  enabled?: boolean;
  state?: string;
  reason?: string;
  suffix?: string;
  port?: number;
  listenerReady?: boolean;
  interception4?: boolean;
  interception6?: boolean;
  repairNeeded?: boolean;
  policyState?: string;
  upstreamNative?: boolean;
  ipv6DnsInterception?: 'available' | 'module-loaded' | 'fallback' | 'disabled';
  ipv6ModuleStatus?: 'not-needed' | 'loaded' | 'missing' | 'load-failed' | 'loader-unavailable' | 'not-checked';
}

export const DNS_REASONS: Record<string, I18nKey> = {
  running: 'dns_running',
  disabled: 'dns_disabled',
  'apply-pending': 'dns_apply_pending',
  'disable-pending': 'dns_disable_pending',
  'tailnet-unavailable': 'dns_tailnet_unavailable',
  'missing-binary': 'dns_missing_binary',
  conflict: 'dns_conflict',
  'redirect-failed': 'dns_redirect_failed',
  'cleanup-failed': 'dns_cleanup_failed',
  'process-failed': 'dns_process_failed',
  'reconcile-needed': 'dns_reconcile_needed',
  'private-dns': 'dns_private_dns',
  'ipv6-unavailable': 'tools_dns_ipv6_unavailable',
  local: 'tools_dns_local_ready',
  'transparent-unavailable': 'tools_dns_local_only',
  'native-policy-unavailable': 'tools_dns_native_policy_unavailable',
  'native-policy-changed': 'tools_dns_native_policy_changed',
  'restore-pending': 'tools_dns_restore_pending',
  'invalid-config': 'tools_dns_invalid_config',
  'listener-failed': 'tools_dns_listener_failed',
  'interception-failed': 'tools_dns_interception_failed',
  'context-changed': 'tools_dns_context_changed',
  'interception-lost': 'tools_dns_interception_lost',
  'queue-failed': 'tools_dns_interception_lost',
  'guard-failed': 'tools_dns_guard_failed',
  'capture-mark-conflict': 'tools_dns_mark_conflict',
  'packet-policy-conflict': 'tools_dns_packet_policy_conflict',
  'dns-interception-conflict': 'tools_dns_interception_conflict',
  stopped: 'dns_stopped',
  degraded: 'dns_degraded',
};

export const modernDns = (info: DnsInfo) => info.mode === 'local' || info.mode === 'transparent';
export const modernDnsReady = (info: DnsInfo) =>
  info.listenerReady === true && info.state === 'running' && info.repairNeeded === false &&
  info.policyState === 'owned' && info.enabled !== false &&
  (info.mode === 'local' ? info.reason === 'local' : ['running', 'ipv6-unavailable'].includes(info.reason || ''));
export const transparentDnsReady = (info: DnsInfo) =>
  modernDnsReady(info) && info.mode === 'transparent' && info.interception4 === true;

export function dnsEndpoint(info: DnsInfo): string | null {
  const port = info.port;
  return modernDns(info) && info.listenerReady === true && typeof port === 'number' &&
    Number.isInteger(port) && port > 0 && port <= 65535 ? `127.0.0.1:${port}` : null;
}

export function dnsStatusTone(info: DnsInfo): StatusTone {
  if (modernDns(info)) {
    if (info.state === 'stopped' && info.enabled === false) return 'neutral';
    return (info.mode === 'local' && modernDnsReady(info)) || transparentDnsReady(info)
      ? 'success' : 'warning';
  }
  return (info.reason === 'ipv6-unavailable' && info.ipv6DnsInterception !== 'fallback') || info.state === 'degraded'
    ? 'warning' : info.state === 'running' ? 'success' : 'neutral';
}

export const IPV6_DNS_PATHS: Record<NonNullable<DnsInfo['ipv6DnsInterception']>, I18nKey> = {
  available: 'tools_dns_ipv6_native',
  'module-loaded': 'tools_dns_ipv6_module',
  fallback: 'tools_dns_ipv6_fallback',
  disabled: 'tools_dns_ipv6_disabled',
};
export const IPV6_MODULE_DETAILS: Partial<Record<NonNullable<DnsInfo['ipv6ModuleStatus']>, I18nKey>> = {
  missing: 'tools_dns_ipv6_module_missing',
  'load-failed': 'tools_dns_ipv6_module_failed',
  'loader-unavailable': 'tools_dns_ipv6_loader_missing',
  'not-checked': 'tools_dns_ipv6_module_unchecked',
};

export function ipv6DnsPathLabel(info: DnsInfo): string | null {
  const path = info.ipv6DnsInterception;
  if (!path || !IPV6_DNS_PATHS[path]) return null;
  const label = t(IPV6_DNS_PATHS[path]);
  const detail = path === 'fallback' && info.ipv6ModuleStatus
    ? IPV6_MODULE_DETAILS[info.ipv6ModuleStatus]
    : undefined;
  return detail ? `${label} (${t(detail)})` : label;
}

export function dnsStatusLabel(info: DnsInfo): string {
  if (modernDns(info)) {
    const reason = info.reason;
    if (reason === 'missing-binary') return t('tools_dns_helper_missing');
    if (reason && !['running', 'local', 'transparent-unavailable', 'ipv6-unavailable'].includes(reason)) {
      return DNS_REASONS[reason] ? t(DNS_REASONS[reason]) : t('dns_degraded');
    }
    if (info.listenerReady !== true) return t('tools_dns_listener_unready');
    if (info.mode === 'local') return t(modernDnsReady(info) ? 'tools_dns_local_ready' : 'dns_degraded');
    if (transparentDnsReady(info)) {
      return t(info.interception6 === true ? 'tools_dns_transparent_ready' : 'tools_dns_transparent_ipv4');
    }
    return t(reason === 'transparent-unavailable' ? 'tools_dns_local_only' : 'tools_dns_transparent_inactive');
  }
  // Current backends report the IPv6 limitation in its own path row. Keep
  // the reason visible in the badge when talking to an older backend.
  const reason = info.ipv6DnsInterception === 'fallback' && info.reason === 'ipv6-unavailable'
    ? info.state
    : info.reason || info.state;
  return reason && DNS_REASONS[reason] ? t(DNS_REASONS[reason]) : reason || '—';
}
