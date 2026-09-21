/** Network overview. Status remains subscribed to the single shared poller. */
import { createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { createApiScope } from '../api';
import { t } from '../i18n';
import {
  connState,
  status,
  statusError,
  statusLoading,
  refreshStatus,
} from '../state';
import { fmtUptime, fmtBytes } from '../format';
import { Card, KvRow, StatusDot, SkeletonCard } from '../components/Basics';
import { LoginHero } from '../components/LoginHero';
import { copyWithToast } from '../clipboard';
import { MdIcon } from '../icons';
import { Button, IconButton } from '../components/ui';
import './network.css';

export default function Dashboard(): JSX.Element {
  const scope = createApiScope();
  const [compatWarnings, setCompatWarnings] = createSignal<string[]>([]);
  const keyExpiring = () => {
    const date = status()?.keyExpiry;
    return date && Date.parse(date) - Date.now() < 7 * 24 * 60 * 60 * 1000
      ? date
      : null;
  };

  onMount(() => {
    void scope.api('compat').then((res) => {
      if (res.cancelled || !res.ok) return;
      const warnings = Array.isArray(res.warnings)
        ? res.warnings.filter((w): w is string => typeof w === 'string')
        : [];
      if (typeof res.alert === 'string' && res.alert) warnings.push(res.alert);
      setCompatWarnings(warnings);
    });
  });

  const running = () => status()?.daemon === 'running';
  const connection = () => connState(status());
  const connected = () => connection() === 'running';
  const connectionTitle = () =>
    statusError() || connection() === 'unknown'
      ? t('net_status_stale')
      : connected()
        ? t('net_connected')
        : connection() === 'stopped'
          ? t('dash_stopped')
          : connection() === 'needs-login'
            ? t('hero_login_title')
            : t('net_connecting');
  const connectionHint = () =>
    statusError() || connection() === 'unknown'
      ? t('net_unknown_hint')
      : connected()
        ? t('net_connected_hint')
        : connection() === 'stopped'
          ? t('net_stopped_hint')
          : connection() === 'needs-login'
            ? t('net_login_hint')
            : t('net_connecting_hint');
  // Keep clipboard access within the original click event on file:// WebViews.
  const copyAddress = (address: string) => copyWithToast(address);

  return (
    <div class="page-stack network-page">
      <Show when={keyExpiring()}>
        <div class="banner warn">
          <MdIcon name="warning" size={18} />
          <span>{t('dash_key_expiring') + keyExpiring()}</span>
        </div>
      </Show>
      <For each={compatWarnings()}>
        {(warning) => (
          <div class="banner warn">
            <MdIcon name="warning" size={18} />
            <span>
              <strong>{t('dash_compat_warning')}: </strong>
              {warning}
            </span>
          </div>
        )}
      </For>

      <Show
        when={!statusLoading()}
        fallback={
          <div class="page-stack">
            <div
              class="panel network-health network-health-skeleton"
              role="status"
              aria-busy="true"
              aria-label={t('loading')}
            >
              <span class="sr-only">{t('loading')}</span>
              <div class="skeleton network-health-icon" />
              <div class="network-health-copy">
                <div class="skeleton skel-title" />
              </div>
            </div>
            <div class="metric-grid network-metrics network-dashboard-metrics">
              <For each={[0, 1]}>
                {() => (
                  <div class="metric-card">
                    <div class="skeleton skel-line" />
                    <div class="skeleton skel-title" />
                  </div>
                )}
              </For>
            </div>
            <div class="content-grid network-detail-grid">
              <SkeletonCard lines={3} />
              <SkeletonCard lines={3} />
            </div>
          </div>
        }
      >
        <Show
          when={status()}
          fallback={
            <div class="panel network-health">
              <div class="network-health-icon">
                <MdIcon name="error" size={32} />
              </div>
              <div class="network-health-copy">
                <h2>{t('net_status_stale')}</h2>
                <p>{t('net_unknown_hint')}</p>
                <Button variant="outlined" onClick={() => void refreshStatus()}>
                  <MdIcon name="refresh" size={18} />
                  {t('retry')}
                </Button>
              </div>
            </div>
          }
        >
          {(s) => (
            <>
              <section
                class={
                  'panel network-health' +
                  (connected() && !statusError()
                    ? ' is-connected'
                    : !statusError() && (connection() === 'needs-login' || connection() === 'starting')
                      ? ' needs-attention'
                      : '')
                }
                aria-label={t('net_connection')}
              >
                <div class="network-health-icon">
                  <MdIcon
                    name={
                      connected() && !statusError()
                        ? 'check_circle'
                        : statusError() || connection() === 'unknown'
                          ? 'error'
                          : connection() === 'needs-login'
                            ? 'vpn_key'
                            : running()
                              ? 'sync'
                              : 'stop'
                    }
                    size={32}
                  />
                </div>
                <div class="network-health-copy">
                  <h2>{connectionTitle()}</h2>
                  <Show when={!connected() || statusError()}>
                    <p>{connectionHint()}</p>
                  </Show>
                </div>
              </section>

              <LoginHero showStopped={false} />

              <div class="metric-grid network-metrics network-dashboard-metrics">
                <div class="metric-card">
                  <div class="metric-label">
                    <MdIcon name="group" size={18} />
                    {t('dash_peers_online')}
                  </div>
                  <div class="metric-value">
                    {s().peers?.online ?? '—'}
                    <span class="network-metric-unit">
                      {' '}
                      /{' '}
                      {s().peers ? s().peers!.online + s().peers!.offline : '—'}
                    </span>
                  </div>
                  <div class="metric-caption">
                    {s().peers
                      ? `${s().peers!.offline} ${t('net_offline_count')}`
                      : t('net_unknown')}
                  </div>
                </div>
                <div class="metric-card">
                  <div class="metric-label">
                    <MdIcon name="monitoring" size={18} />
                    {t('net_service_runtime')}
                  </div>
                  <div class="metric-value">
                    {s().uptime == null ? '—' : fmtUptime(s().uptime)}
                  </div>
                </div>
              </div>

              <div class="content-grid network-detail-grid">
                <Card title={t('dash_self')} icon="person">
                  <Show
                    when={s().self}
                    fallback={
                      <div class="empty-state">{t('net_address_pending')}</div>
                    }
                  >
                    {(self) => (
                      <>
                        <div class="network-device-heading">
                          <div class="network-device-avatar">
                            <MdIcon name="router" size={24} />
                          </div>
                          <div>
                            <strong>{self().hostname}</strong>
                            <span>{t('net_device_address')}</span>
                          </div>
                        </div>
                        <div class="network-addresses">
                          <For each={self().ips || []}>
                            {(ip) => (
                              <div class="network-address">
                                <code>{ip}</code>
                                <IconButton
                                  aria-label={t('net_copy_address') + ': ' + ip}
                                  onClick={() => copyAddress(ip)}
                                >
                                  <MdIcon name="content_copy" size={18} />
                                </IconButton>
                              </div>
                            )}
                          </For>
                        </div>
                        <KvRow
                          k={t('net_relay_region')}
                          v={self().relay || '—'}
                        />
                        <KvRow
                          k={t('dash_magicdns')}
                          v={
                            <span
                              class={
                                'network-status-label' +
                                (s().magicDns ? ' is-online' : '')
                              }
                            >
                              {s().magicDns
                                ? t('net_enabled')
                                : t('net_disabled')}
                            </span>
                          }
                        />
                      </>
                    )}
                  </Show>
                </Card>
                <Card title={t('dash_exitnode')} icon="logout">
                  <div class="network-exit-summary">
                    <div class="network-device-avatar">
                      <MdIcon
                        name={s().exitNode ? 'logout' : 'language'}
                        size={24}
                      />
                    </div>
                    <div>
                      <strong>
                        {s().exitNode?.hostname || t('net_exit_local')}
                      </strong>
                      <p>
                        {s().exitNode
                          ? s().exitNode!.ip
                          : t('net_no_exit_hint')}
                      </p>
                    </div>
                    <Show when={s().exitNode}>
                      <StatusDot state={s().exitNode?.online ? 'on' : 'off'} />
                    </Show>
                  </div>
                  <Show when={s().exitNode}>
                    {(node) => (
                      <>
                        <p class="network-supporting">{t('net_exit_hint')}</p>
                        <KvRow
                          k={t('dash_traffic')}
                          v={
                            <span class="network-transfer">
                              <span>↓ {fmtBytes(node().rx)}</span>
                              <span>↑ {fmtBytes(node().tx)}</span>
                            </span>
                          }
                        />
                        <Show when={!node().online}>
                          <div class="banner warn">
                            <MdIcon name="warning" size={18} />
                            <span>{t('net_exit_unavailable')}</span>
                          </div>
                        </Show>
                      </>
                    )}
                  </Show>
                  <a class="network-text-link" href="#/exitnodes">
                    {t('net_manage_exit')}
                    <MdIcon name="chevron_right" size={18} />
                  </a>
                </Card>
              </div>
            </>
          )}
        </Show>
      </Show>

      <section aria-label={t('net_quick_access')}>
        <div class="section-heading">
          <h2>{t('net_quick_access')}</h2>
        </div>
        <div class="network-shortcuts">
          <a href="#/peers">
            <MdIcon name="group" size={22} />
            <div>
              <strong>{t('peers_title')}</strong>
              <span>{t('net_quick_peers')}</span>
            </div>
            <MdIcon name="chevron_right" size={18} />
          </a>
          <a href="#/routing">
            <MdIcon name="alt_route" size={22} />
            <div>
              <strong>{t('route_title')}</strong>
              <span>{t('net_quick_routing')}</span>
            </div>
            <MdIcon name="chevron_right" size={18} />
          </a>
          <a href="#/tunnel">
            <MdIcon name="dns" size={22} />
            <div>
              <strong>{t('tun_title')} / DNS</strong>
              <span>{t('net_quick_dns')}</span>
            </div>
            <MdIcon name="chevron_right" size={18} />
          </a>
          <a href="#/logs">
            <MdIcon name="article" size={22} />
            <div>
              <strong>{t('logs_title')}</strong>
              <span>{t('net_quick_logs')}</span>
            </div>
            <MdIcon name="chevron_right" size={18} />
          </a>
        </div>
      </section>
    </div>
  );
}
