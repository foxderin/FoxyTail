/** Network overview. The connection card is the single source of truth for
 * service state; every other surface only mirrors or links out. */
import { createEffect, createSignal, For, on, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, nativeControl } from '../api';
import { t, tf } from '../i18n';
import { status, statusError, statusLoading } from '../state';
import { fmtUptime, fmtBytes, keyExpiry } from '../format';
import { SkeletonCard } from '../components/Basics';
import { LoginActions } from '../components/LoginHero';
import { NativeIssueActions, ServiceActions } from '../components/ServiceControls';
import { copyWithToast } from '../clipboard';
import { MdIcon, type IconName } from '../icons';
import { IconButton } from '../components/ui';
import {
  connectionCopy,
  connectionView,
  exitNodeLabel,
  nativeIssue,
  serviceModeLabel,
  serviceRunning,
} from '../service';
import './network.css';

interface DayTraffic { rx: number; tx: number }

export default function Dashboard(): JSX.Element {
  const scope = createApiScope();
  const [compatWarnings, setCompatWarnings] = createSignal<string[]>([]);
  const [today, setToday] = createSignal<DayTraffic | null>(null);
  const keyExpiring = () => keyExpiry(status()?.keyExpiry);
  const copy = () => connectionCopy();
  const view = () => connectionView();
  // Last-known data is only shown when it cannot be confused with live state.
  const stale = () => !serviceRunning() || Boolean(statusError());
  const loading = () => statusLoading() && !status();
  const showDetails = () => !['login', 'unavailable', 'loading'].includes(view());

  const loadToday = async () => {
    const res = await scope.api('traffic');
    if (res.cancelled) return;
    const day = res.ok && Array.isArray(res.days) ? res.days[0] : null;
    setToday(day && typeof day.rx === 'number' && typeof day.tx === 'number' ? { rx: day.rx, tx: day.tx } : null);
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
    void loadToday();
  });
  createEffect(on(() => nativeControl().accountRevision, () => { setToday(null); void loadToday(); }));

  const peersLabel = (): string => {
    const peers = status()?.peers;
    return peers ? `${peers.online} / ${peers.online + peers.offline}` : '—';
  };
  const modeLabel = (): string => {
    const label = serviceModeLabel();
    if (!label) return '—';
    const dns = status()?.magicDns == null ? '' : ` · MagicDNS ${status()!.magicDns ? t('net_enabled') : t('net_disabled')}`;
    return t(label) + dns;
  };
  const rows = (): { icon: IconName; label: string; value: string; href: string }[] => [
    { icon: 'logout', label: t('dash_exitnode'), value: exitNodeLabel(), href: '#/exit' },
    { icon: 'group', label: t('dash_peers_online'), value: peersLabel(), href: '#/peers' },
    { icon: 'monitoring', label: t('dash_today_traffic'), value: today() ? `↓ ${fmtBytes(today()!.rx)} · ↑ ${fmtBytes(today()!.tx)}` : '—', href: '#/traffic' },
    { icon: 'router', label: t('dash_mode'), value: modeLabel(), href: '#/tunnel' },
  ];

  return (
    <div class="page-stack network-page">
      <Show when={keyExpiring()}>
        {(expiry) => (
          <div class={'banner ' + (expiry().expired ? 'error' : 'warn')}>
            <MdIcon name="warning" size={18} />
            <span>{tf(expiry().expired ? 'dash_key_expired_on' : 'dash_key_expires_on', { date: expiry().date })}</span>
          </div>
        )}
      </Show>
      <Show when={compatWarnings().length > 0}>
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
      </Show>

      <Show
        when={!loading()}
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
            <SkeletonCard lines={3} />
          </div>
        }
      >
        <section
          class={
            'panel network-health conn-card' +
            (view() === 'running'
              ? ' is-connected'
              : view() === 'login' || view() === 'starting'
                ? ' needs-attention'
                : '')
          }
          aria-label={t('net_connection')}
          data-testid="conn-card"
        >
          <div class="network-health-icon">
            <MdIcon name={copy().icon} size={32} />
          </div>
          <div class="network-health-copy">
            <h2>{copy().title}</h2>
            <p>{copy().hint}</p>
            <Show when={view() === 'running' && status()?.self}>
              {(self) => (
                <p class="conn-identity">
                  <strong>{self().hostname}</strong>
                  <Show when={self().ips?.length}>
                    <code>{self().ips[0]}</code>
                    <IconButton
                      aria-label={t('net_copy_address') + ': ' + self().ips[0]}
                      onClick={() => copyWithToast(self().ips[0])}
                    >
                      <MdIcon name="content_copy" size={16} />
                    </IconButton>
                  </Show>
                  <Show when={status()?.uptime != null}>
                    <span class="dim">{tf('dash_uptime', { time: fmtUptime(status()!.uptime) })}</span>
                  </Show>
                </p>
              )}
            </Show>
            <Show when={view() === 'login'}>
              <LoginActions />
            </Show>
            <Show when={!['login', 'issue'].includes(view())}>
              <ServiceActions />
            </Show>
            <Show when={nativeIssue()}>
              <NativeIssueActions />
            </Show>
          </div>
        </section>

        <Show when={showDetails()}>
          <Show when={stale()}>
            <p class="network-stale-label">{t('dash_stale_data')}</p>
          </Show>
          <div class="conn-rows" classList={{ 'is-stale': stale() }}>
            <For each={rows()}>
              {(row) => (
                <a class="conn-row" href={row.href}>
                  <MdIcon name={row.icon} size={22} />
                  <div class="conn-row-copy">
                    <strong>{row.label}</strong>
                    <span>{row.value}</span>
                  </div>
                  <MdIcon name="chevron_right" size={18} />
                </a>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
