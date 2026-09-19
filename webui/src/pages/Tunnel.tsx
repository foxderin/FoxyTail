/*
 * Tunnel — tailscale0 interface state (visible 15s poll), SOCKS5 self-check
 * (button-triggered), DERP relay speed test as a cancellable session task.
 */
import { createSignal, onCleanup, Show, type JSX } from 'solid-js';
import { createApiScope, execRaw, hasRoot, type ApiResult } from '../api';
import { pollWhileVisible } from '../schedule';
import { viewPollInterval } from '../state';
import { t, type I18nKey } from '../i18n';
import './tools.css';
import { getTask } from '../tasks';
import { latClass } from '../format';
import {
  Card,
  KvRow,
  MetricCard,
  StatusBadge,
  EmptyState,
  SkeletonCard,
  ErrorState,
  type StatusTone,
} from '../components/Basics';
import { copyText } from '../components/LoginHero';
import { showToast } from '../components/Toast';
import { TaskButton, TaskProgress } from '../components/TaskProgress';
import { MdIcon } from '../icons';
import { Button, LinearProgress } from '../components/ui';
import type { DerpRelay } from '../types';

const TASK_KEY = 'derp-speedtest';

interface TunInfo {
  ifaceUp: boolean;
  gateway: string | null;
  hevPid: number | null;
  mode: string;
  socksPort: number;
}

interface DnsInfo extends ApiResult {
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

const DNS_REASONS: Record<string, I18nKey> = {
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

const modernDns = (info: DnsInfo) => info.mode === 'local' || info.mode === 'transparent';
const modernDnsReady = (info: DnsInfo) =>
  info.listenerReady === true && info.state === 'running' && info.repairNeeded === false &&
  info.policyState === 'owned' && info.enabled !== false &&
  (info.mode === 'local' ? info.reason === 'local' : ['running', 'ipv6-unavailable'].includes(info.reason || ''));
const transparentDnsReady = (info: DnsInfo) =>
  modernDnsReady(info) && info.mode === 'transparent' && info.interception4 === true;

function dnsEndpoint(info: DnsInfo): string | null {
  const port = info.port;
  return modernDns(info) && info.listenerReady === true && typeof port === 'number' &&
    Number.isInteger(port) && port > 0 && port <= 65535 ? `127.0.0.1:${port}` : null;
}

function dnsStatusTone(info: DnsInfo): StatusTone {
  if (modernDns(info)) {
    if (info.state === 'stopped' && info.enabled === false) return 'neutral';
    return (info.mode === 'local' && modernDnsReady(info)) || transparentDnsReady(info)
      ? 'success' : 'warning';
  }
  return (info.reason === 'ipv6-unavailable' && info.ipv6DnsInterception !== 'fallback') || info.state === 'degraded'
    ? 'warning' : info.state === 'running' ? 'success' : 'neutral';
}

const IPV6_DNS_PATHS: Record<NonNullable<DnsInfo['ipv6DnsInterception']>, I18nKey> = {
  available: 'tools_dns_ipv6_native',
  'module-loaded': 'tools_dns_ipv6_module',
  fallback: 'tools_dns_ipv6_fallback',
  disabled: 'tools_dns_ipv6_disabled',
};
const IPV6_MODULE_DETAILS: Partial<Record<NonNullable<DnsInfo['ipv6ModuleStatus']>, I18nKey>> = {
  missing: 'tools_dns_ipv6_module_missing',
  'load-failed': 'tools_dns_ipv6_module_failed',
  'loader-unavailable': 'tools_dns_ipv6_loader_missing',
  'not-checked': 'tools_dns_ipv6_module_unchecked',
};

function ipv6DnsPathLabel(info: DnsInfo): string | null {
  const path = info.ipv6DnsInterception;
  if (!path || !IPV6_DNS_PATHS[path]) return null;
  const label = t(IPV6_DNS_PATHS[path]);
  const detail = path === 'fallback' && info.ipv6ModuleStatus
    ? IPV6_MODULE_DETAILS[info.ipv6ModuleStatus]
    : undefined;
  return detail ? `${label} (${t(detail)})` : label;
}

function dnsStatusLabel(info: DnsInfo): string {
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

export default function Tunnel(): JSX.Element {
  const scope = createApiScope();
  let seq = 0;
  let loading = false;
  const [tun, setTun] = createSignal<TunInfo | null>(null);
  const [tunError, setTunError] = createSignal<string | null>(null);
  const [socksResult, setSocksResult] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [socksBusy, setSocksBusy] = createSignal(false);
  const [dns, setDns] = createSignal<DnsInfo | null>(null);
  const [dnsBusy, setDnsBusy] = createSignal(false);
  const [tunBusy, setTunBusy] = createSignal(false);
  const probeAbort = new AbortController();
  onCleanup(() => probeAbort.abort());

  async function checkDns() {
    if (dnsBusy()) return;
    setDnsBusy(true);
    const res = await scope.api('dns');
    if (!res.cancelled) setDns(res as DnsInfo);
    setDnsBusy(false);
  }

  const task = () => getTask(TASK_KEY);
  const relays = (): DerpRelay[] =>
    task()?.result?.ok ? (task()!.result!.relays as DerpRelay[]) || [] : [];
  const preferred = (): string | null =>
    task()?.result?.ok ? ((task()!.result!.preferred as string) ?? null) : null;

  async function loadTun() {
    if (loading) return;
    loading = true;
    setTunBusy(true);
    const my = ++seq;
    const res = await scope.api('tun');
    loading = false;
    setTunBusy(false);
    if (res.cancelled || my !== seq) return;
    if (res.ok) {
      setTun(res as unknown as TunInfo);
      setTunError(null);
    } else {
      setTunError(res.error || t('error'));
    }
  }

  /* SOCKS5 self check via curl through the local proxy (user-triggered). */
  async function checkSocks() {
    if (socksBusy() || !tun() || !['bridge', 'proxy'].includes(tun()!.mode)) return;
    setSocksBusy(true);
    setSocksResult(null);
    const port = Number(tun()?.socksPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setSocksResult({ ok: false, text: t('tun_socks_fail') });
      setSocksBusy(false);
      return;
    }
    const started = Date.now();
    try {
      const out = await execRaw(
        'curl --proxy socks5h://127.0.0.1:' +
          port +
          ' -sI --max-time 10 -o /dev/null -w "%{http_code}" https://1.1.1.1',
        15000,
        probeAbort.signal,
      );
      const ms = Date.now() - started;
      const code = String(out).trim();
      const ok = /^[23]/.test(code);
      setSocksResult({
        ok,
        text:
          (ok ? t('tun_socks_ok') : t('tun_socks_fail')) +
          ' · HTTP ' +
          (code || '???') +
          ' · ' +
          ms +
          'ms',
      });
    } catch (err) {
      setSocksResult({ ok: false, text: t('tun_socks_fail') + ': ' + String(err) });
    } finally {
      setSocksBusy(false);
    }
  }

  pollWhileVisible(loadTun, viewPollInterval);

  const modeDescription = () =>
    t(
      tun()?.mode === 'tun'
        ? 'tools_tun_desc'
        : tun()?.mode === 'proxy'
          ? 'tools_proxy_desc'
          : 'tools_bridge_desc',
    );
  return (
    <div class="tools-page">
      <div class="toolbar" data-testid="tunnel-actions">
        <TaskButton
          taskKey={TASK_KEY}
          cmd="derp-speedtest"
          label={task()?.status === 'running' ? t('tun_derp_testing') : t('tun_derp')}
          icon={<MdIcon name="speed" size={18} />}
        />
        <Show when={tun() && ['bridge', 'proxy'].includes(tun()!.mode)}>
          <Button
            variant="tonal"
            busy={socksBusy()}
            disabled={!hasRoot}
            onClick={() => void checkSocks()}
          >
            <MdIcon name="network_check" size={18} />
            {socksBusy() ? t('tun_socks_checking') : t('tun_socks_check')}
          </Button>
        </Show>
      </div>
      <Show when={tun() !== null || tunError() !== null} fallback={<SkeletonCard lines={4} />}>
        <Card
          title={t('tools_tunnel_overview')}
          icon="router"
          actions={
            <Button variant="text" busy={tunBusy()} onClick={() => void loadTun()}>
              <MdIcon name="refresh" size={18} />
              {tunBusy() ? t('loading') : t('tools_refresh')}
            </Button>
          }
        >
          <Show
            when={!tunError()}
            fallback={<ErrorState text={tunError()!} onRetry={() => void loadTun()} />}
          >
            <Show when={tun()?.mode !== 'bridge'}>
              <p class="tool-hint">{modeDescription()}</p>
            </Show>
            <div class="metric-grid">
              <MetricCard
                label={t('tun_iface')}
                value={tun()!.ifaceUp ? t('tun_up') : t('tun_down')}
                caption="tailscale0"
                icon="router"
                tone={tun()!.ifaceUp ? 'success' : 'neutral'}
              />
              <MetricCard label={t('tun_gateway')} value={tun()!.gateway || '—'} icon="alt_route" />
            </div>
            <Show when={tun()!.mode === 'bridge'}>
              <KvRow
                k={t('tun_hev')}
                v={
                  <StatusBadge tone={tun()!.hevPid ? 'success' : 'warning'}>
                    {tun()!.hevPid ? 'PID ' + tun()!.hevPid : t('tun_not_running')}
                  </StatusBadge>
                }
              />
            </Show>
            <a class="tool-text-link" href="#/routing">
              {t('more_routing')}
              <MdIcon name="chevron_right" size={16} />
            </a>
          </Show>
        </Card>
      </Show>
      <Card title={t('dns_title')} icon="dns">
        <Show when={dns()} fallback={<EmptyState text={t('tools_dns_unchecked')} icon="dns" />}>
          {(info) => (
            <Show
              when={info().ok}
              fallback={<ErrorState text={info().error || t('error')} onRetry={() => void checkDns()} />}
            >
              <div class="tool-result" aria-live="polite">
                <div data-testid="dns-capability" data-dns-mode={info().mode || 'legacy'}>
                  <StatusBadge tone={dnsStatusTone(info())}>{dnsStatusLabel(info())}</StatusBadge>
                </div>
                <Show when={!modernDns(info()) && ipv6DnsPathLabel(info())}>
                  {(label) => (
                    <div data-testid="dns-ipv6-path">
                      <KvRow k={t('tools_dns_ipv6_path')} v={label()} />
                      <Show when={info().ipv6DnsInterception === 'fallback'}>
                        <p class="tool-hint">{t('tools_dns_ipv6_fallback_hint')}</p>
                      </Show>
                    </div>
                  )}
                </Show>
                <Show when={!modernDns(info())}>
                  <KvRow
                    k={t('dns_native')}
                    v={t(info().upstreamNative ? 'tools_dns_native_yes' : 'tools_dns_native_no')}
                  />
                </Show>
                <Show when={dnsEndpoint(info())}>
                  {(endpoint) => (
                    <div data-testid="dns-endpoint">
                      <KvRow k={t('tools_dns_endpoint')} v={<code>{endpoint()}</code>} />
                      <div class="tool-actions spread">
                        <span class="tool-hint">{t('tools_dns_endpoint_hint')}</span>
                        <Button variant="text" onClick={() => {
                          const copied = copyText(endpoint());
                          showToast(t(copied ? 'copied' : 'op_failed'), copied ? 'ok' : 'err');
                        }}>
                          <MdIcon name="content_copy" size={18} />{t('tools_dns_endpoint_copy')}
                        </Button>
                      </div>
                    </div>
                  )}
                </Show>
                <Show when={info().mode === 'transparent' && info().listenerReady === true}>
                  <p class="tool-hint" data-testid="dns-coexist-hint">{t(info().reason === 'transparent-unavailable'
                    ? 'tools_dns_transparent_unavailable' : 'tools_dns_transparent_limit')}</p>
                </Show>
                <Show when={info().suffix}>
                  <KvRow k={t('dns_suffix')} v={info().suffix || '—'} />
                </Show>
              </div>
            </Show>
          )}
        </Show>
        <Show when={dnsBusy()}>
          <div class="progress-row">
            <LinearProgress indeterminate />
            <span class="dim">{t('loading')}</span>
          </div>
        </Show>
        <div class="tool-actions spread" data-testid="dns-actions">
          <Button variant="tonal" busy={dnsBusy()} disabled={!hasRoot} onClick={() => void checkDns()}>
            <MdIcon name="network_check" size={18} />
            {dnsBusy() ? t('loading') : dns() ? t('tools_dns_check_again') : t('dns_check')}
          </Button>
          <a class="tool-text-link" href="#/settings">
            {t('tools_dns_settings')}
            <MdIcon name="chevron_right" size={16} />
          </a>
        </div>
      </Card>
      <Show when={tun() && ['bridge', 'proxy'].includes(tun()!.mode) && (socksBusy() || socksResult())}>
        <Card title={t('tun_socks_check')} icon="network_check">
          <KvRow k="SOCKS5" v={<code>127.0.0.1:{tun()?.socksPort}</code>} />
          <Show when={socksBusy()}>
            <div class="progress-row">
              <LinearProgress indeterminate />
              <span class="dim">{t('tun_socks_checking')}</span>
            </div>
          </Show>
          <Show when={socksResult()}>
            {(result) => (
              <div class="tool-result" role="status">
                <StatusBadge tone={result().ok ? 'success' : 'danger'}>{result().text}</StatusBadge>
              </div>
            )}
          </Show>
        </Card>
      </Show>
      <Show when={task()?.status === 'running' || task()?.status === 'error' || relays().length > 0}>
        <Card title={t('tun_derp')} icon="speed">
          <TaskProgress taskKey={TASK_KEY} />
          <Show when={task()?.status === 'error'}>
            <ErrorState text={task()?.result?.error || t('error')} />
          </Show>
          <Show when={relays().length > 0}>
            {relays().map((relay) => (
              <div class="list-row">
                <div class="main">
                  <div class="title mono">{relay.code}</div>
                  <Show when={relay.code === preferred()}>
                    <StatusBadge tone="accent">{t('tun_preferred')}</StatusBadge>
                  </Show>
                </div>
                <strong class={latClass(relay.latencyMs)}>{relay.latencyMs} ms</strong>
              </div>
            ))}
          </Show>
        </Card>
      </Show>
    </div>
  );
}
