/*
 * Tunnel — tailscale0 interface state (visible 15s poll), SOCKS5 self-check
 * (button-triggered), DERP relay speed test as a cancellable session task.
 */
import { createEffect, createSignal, on, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot, nativeControl } from '../api';
import { pollWhileVisible } from '../schedule';
import { viewPollInterval } from '../state';
import { t } from '../i18n';
import './tools.css';
import { getTask } from '../tasks';
import { latClass } from '../format';
import {
  Card,
  KvRow,
  StatusBadge,
  EmptyState,
  SkeletonCard,
  ErrorState,
} from '../components/Basics';
import { copyWithToast } from '../clipboard';
import { TaskButton, TaskProgress } from '../components/TaskProgress';
import { MdIcon } from '../icons';
import { Button, IconButton, LinearProgress } from '../components/ui';
import {
  dnsEndpoint,
  privateDnsHint,
  dnsStatusLabel,
  dnsStatusTone,
  ipv6DnsPathLabel,
  modernDns,
  type DnsInfo,
} from './tunnel-dns';
import { createGuardedLoad } from './tools-refresh';
import type { DerpRelay } from '../types';
import Coexistence from './Coexistence';

const TASK_KEY = 'derp-speedtest';

interface TunInfo {
  ifaceUp: boolean;
  gateway: string | null;
  hevPid: number | null;
  mode: string;
  socksPort: number;
}

export default function Tunnel(): JSX.Element {
  const scope = createApiScope();
  const [tun, setTun] = createSignal<TunInfo | null>(null);
  const [tunError, setTunError] = createSignal<string | null>(null);
  const [socksResult, setSocksResult] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [socksBusy, setSocksBusy] = createSignal(false);
  const [dns, setDns] = createSignal<DnsInfo | null>(null);
  const [dnsBusy, setDnsBusy] = createSignal(false);
  const [tunBusy, setTunBusy] = createSignal(false);

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

  const loadTun = createGuardedLoad(
    () => scope.api('tun'),
    (res) => {
      if (res.ok) {
        setTun(res as unknown as TunInfo);
        setTunError(null);
      } else {
        setTunError(res.error || t('error'));
      }
    },
    setTunBusy,
  );

  async function checkSocks() {
    if (socksBusy() || !nativeControl().canWrite || nativeControl().busy || !tun() || !['bridge', 'proxy'].includes(tun()!.mode)) return;
    setSocksBusy(true);
    setSocksResult(null);
    const result = await scope.api('socks-check');
    setSocksBusy(false);
    if (result.cancelled) return;
    const valid = result.ok && typeof result.success === 'boolean' &&
      typeof result.httpCode === 'string' && typeof result.elapsedMs === 'number';
    setSocksResult({
      ok: valid && result.success === true,
      text: valid
        ? `${t(result.success ? 'tun_socks_ok' : 'tun_socks_fail')} · HTTP ${result.httpCode} · ${result.elapsedMs}ms${result.error ? '\n' + result.error : ''}`
        : `${t('tun_socks_fail')}: ${result.error || t('net_unknown')}`,
    });
  }
  createEffect(on(() => nativeControl().accountRevision, () => {
    setTun(null); setDns(null); setSocksResult(null);
    void loadTun();
  }));

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
      <div class="tool-actions" data-testid="tunnel-actions">
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
            disabled={!hasRoot || !nativeControl().canWrite || nativeControl().busy}
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
            <KvRow
              k={t('tun_iface')}
              v={<StatusBadge tone={tun()!.ifaceUp ? 'success' : 'neutral'}>{tun()!.ifaceUp ? t('tun_up') : t('tun_down')}</StatusBadge>}
            />
            <KvRow
              k={t('tun_gateway')}
              v={<Show when={tun()!.gateway} fallback="—">{gateway => <span class="tool-copy-value"><code>{gateway()}</code>
                <IconButton aria-label={t('net_copy_address') + ': ' + gateway()} onClick={() => copyWithToast(gateway())}><MdIcon name="content_copy" size={18} /></IconButton></span>}</Show>}
            />
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
              {t('route_title')}
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
                <Show when={privateDnsHint(info())}>
                  {(hint) => <p class="tool-hint" data-testid="dns-private-policy">{hint()}</p>}
                </Show>
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
                        <Button variant="text" onClick={() => copyWithToast(endpoint())}>
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
                <Show when={info().mode === 'hijack' && info().listenerReady === true}>
                  <p class="tool-hint" data-testid="dns-hijack-hint">{t(info().reason === 'hijack-unavailable'
                    ? 'tools_dns_hijack_unavailable' : 'tools_dns_hijack_limit')}</p>
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
          <a class="tool-text-link" href="#/settings">
            {t('tools_dns_settings')}
            <MdIcon name="chevron_right" size={16} />
          </a>
          <Button variant="tonal" busy={dnsBusy()} disabled={!hasRoot} onClick={() => void checkDns()}>
            <MdIcon name="network_check" size={18} />
            {dnsBusy() ? t('loading') : dns() ? t('tools_dns_check_again') : t('dns_check')}
          </Button>
        </div>
      </Card>
      <Coexistence />
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
