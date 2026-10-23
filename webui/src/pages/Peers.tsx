/** Searchable device inventory; page-scoped reads pause while hidden. */
import {
  createMemo,
  createSignal,
  For,
  Show,
  type JSX,
} from 'solid-js';
import { pollWhileVisible } from '../schedule';
import { getTask } from '../tasks';
import { TaskButton, TaskProgress } from '../components/TaskProgress';
import { t } from '../i18n';
import { status, viewPollInterval, peers, refreshPeers } from '../state';
import ExitNodes from './ExitNodes';
import { fmtBytes } from '../format';
import {
  KvRow,
  StatusDot,
  SkeletonRows,
  EmptyState,
  ErrorState,
} from '../components/Basics';
import { LoadGate } from '../components/LoadGate';
import { copyWithToast } from '../clipboard';
import { RefreshButton } from '../components/RefreshButton';
import { TopologyChart } from '../components/TopologyChart';
import { OsIcon } from '../components/OsIcon';
import { MdIcon } from '../icons';
import { Button, Dialog, IconButton, TextField } from '../components/ui';
import './network.css';
import { createGuardedLoad } from './tools-refresh';

type PeerFilter = 'all' | 'online' | 'offline';

export default function Peers(): JSX.Element {
  const [loading, setLoading] = createSignal(false);
  const [tab, setTab] = createSignal<'list' | 'topo'>('list');
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [detailId, setDetailId] = createSignal<string | null>(null);
  const detail = createMemo(() => peers()?.find(peer => peer.id === detailId()));
  const [query, setQuery] = createSignal('');
  const [filter, setFilter] = createSignal<PeerFilter>('all');
  const onlineCount = () =>
    (peers() || []).filter((peer) => peer.online).length;
  const visiblePeers = createMemo(() => {
    const text = query().trim().toLocaleLowerCase();
    return (peers() || [])
      .filter(
        (peer) =>
          (filter() === 'all' || peer.online === (filter() === 'online')) &&
          (!text ||
            [peer.hostname, ...(peer.ips || []), peer.os].some((value) =>
              value?.toLocaleLowerCase().includes(text),
            )),
      )
      .sort(
        (a, b) =>
          Number(b.online) - Number(a.online) ||
          a.hostname.localeCompare(b.hostname),
      );
  });

  const loadPeers = createGuardedLoad(
    refreshPeers,
    (res) => {
      if (res.ok) {
        // The shared light status snapshot owns the peer list and identity.
        if (detailId() && !detail()) setDetailId(null);
        setLoadError(null);
      } else setLoadError(res.error || t('error'));
    },
    setLoading,
  );

  function copyAddress(ip: string) {
    copyWithToast(ip);
  }

  pollWhileVisible(loadPeers, viewPollInterval);

  return (
    <div class="page-stack network-page">
      <div class="network-inventory-summary">
        <div>
          <span class="network-inventory-count">{peers()?.length ?? '—'}</span>
          <span>{t('net_peer_total')}</span>
        </div>
        <div class="network-inventory-status">
          <span>
            <StatusDot state="on" />
            {onlineCount()} {t('net_filter_online')}
          </span>
          <span>
            <StatusDot state="off" />
            {(peers()?.length ?? 0) - onlineCount()} {t('net_filter_offline')}
          </span>
        </div>
        <RefreshButton loading={loading()} onClick={() => void loadPeers()} />
      </div>

      <div class="panel network-inventory-panel">
        <div class="network-inventory-toolbar">
          <TextField
            type="search"
            aria-label={t('net_peers_search')}
            placeholder={t('net_peers_search')}
            value={query()}
            onInput={(event) =>
              setQuery((event.target as HTMLInputElement).value)
            }
            leading-icon={<MdIcon name="search" size={20} />}
          />
          <div
            class="network-view-switch"
            role="group"
            aria-label={t('peers_title')}
          >
            <button
              type="button"
              classList={{ active: tab() === 'list' }}
              aria-pressed={tab() === 'list'}
              onClick={() => setTab('list')}
            >
              <MdIcon name="group" size={18} />
              {t('peers_list')}
            </button>
            <button
              type="button"
              classList={{ active: tab() === 'topo' }}
              aria-pressed={tab() === 'topo'}
              onClick={() => setTab('topo')}
            >
              <MdIcon name="router" size={18} />
              {t('peers_topology')}
            </button>
          </div>
        </div>
        <div class="network-filter-row">
          <div
            class="filter-chips"
            role="group"
            aria-label={t('net_connection_state')}
          >
            <For each={['all', 'online', 'offline'] as const}>
              {(value) => (
                <button
                  type="button"
                  class="filter-chip"
                  classList={{ active: filter() === value }}
                  aria-pressed={filter() === value}
                  onClick={() => setFilter(value)}
                >
                  {t(
                    value === 'all'
                      ? 'net_filter_all'
                      : value === 'online'
                        ? 'net_filter_online'
                        : 'net_filter_offline',
                  )}
                </button>
              )}
            </For>
          </div>
          <span class="network-result-count" aria-live="polite">
            {visiblePeers().length} {t('net_result_count')}
          </span>
        </div>
        <LoadGate
          ready={peers() !== null}
          error={loadError()}
          onRetry={() => void loadPeers()}
          skeleton={<SkeletonRows rows={5} />}
          hasContent={(peers() || []).length > 0}
          empty={<EmptyState text={t('peers_empty')} icon="group" />}
        >
            <Show
              when={visiblePeers().length > 0}
              fallback={
                <div class="empty-state">
                  <MdIcon name="search" size={32} />
                  <strong>{t('net_no_results')}</strong>
                  <p>{t('net_no_results_hint')}</p>
                  <Button
                    variant="text"
                    onClick={() => {
                      setQuery('');
                      setFilter('all');
                    }}
                  >
                    {t('net_reset_filter')}
                  </Button>
                </div>
              }
            >
              <Show
                when={tab() === 'list'}
                fallback={
                  <>
                    <p class="network-supporting">{t('net_topology_hint')}</p>
                    <TopologyChart
                      self={status()?.self ?? null}
                      peers={visiblePeers()}
                      exitNodeId={status()?.exitNode?.id ?? null}
                      onPeerClick={peer => setDetailId(peer.id)}
                    />
                  </>
                }
              >
                <div class="network-peer-list">
                  <For each={visiblePeers()}>
                    {(peer) => (
                      <article
                        class={
                          'network-peer-row' +
                          (!peer.online ? ' is-offline' : '')
                        }
                      >
                        <button
                          type="button"
                          class="network-peer-main"
                          onClick={() => setDetailId(peer.id)}
                          aria-label={
                            t('net_peer_details') + ': ' + peer.hostname
                          }
                        >
                          <OsIcon os={peer.os} />
                          <span class="network-peer-identity">
                            <strong>{peer.hostname}</strong>
                            <span class="network-peer-meta">
                              <span>{peer.os || t('net_unknown')}</span>
                              <Show when={peer.relay && peer.relay !== '-'}>
                                <span>
                                  · {t('net_relay_region')}{' '}
                                  {peer.relay.toUpperCase()}
                                </span>
                              </Show>
                              <Show when={peer.exitNodeOption}>
                                <span class="network-small-badge">
                                  {t('exit_title')}
                                </span>
                              </Show>
                            </span>
                          </span>
                          <span
                            class={
                              'network-status-label' +
                              (peer.online ? ' is-online' : '')
                            }
                          >
                            <StatusDot state={peer.online ? 'on' : 'off'} />
                            {peer.online
                              ? t('net_filter_online')
                              : t('net_filter_offline')}
                          </span>
                        </button>
                        <div class="network-peer-bottom">
                          <div class="network-peer-addresses">
                            <For each={peer.ips} fallback={<span>{t('net_address_pending')}</span>}>
                              {ip => (
                                <button
                                  type="button"
                                  class="network-copy-inline"
                                  onClick={() => copyAddress(ip)}
                                  aria-label={t('net_copy_address') + ': ' + ip}
                                >
                                  <code>{ip}</code>
                                  <MdIcon name="content_copy" size={15} />
                                </button>
                              )}
                            </For>
                          </div>
                          <span class="network-peer-traffic">
                            <span>↓ {fmtBytes(peer.rxBytes)}</span>
                            <span>↑ {fmtBytes(peer.txBytes)}</span>
                          </span>
                          <IconButton
                            aria-label={
                              t('net_peer_details') + ': ' + peer.hostname
                            }
                            onClick={() => setDetailId(peer.id)}
                          >
                            <MdIcon name="chevron_right" size={20} />
                          </IconButton>
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
        </LoadGate>
      </div>
      <section aria-label={t('exit_title')}>
        <h2>{t('exit_title')}</h2>
        <ExitNodes />
      </section>

      <Show when={detail()}>
        {(peer) => (
          <Dialog
            open
            headline={t('peers_detail')}
            onClose={() => setDetailId(null)}
          >
            <div class="network-device-heading">
              <OsIcon os={peer().os} />
              <div>
                <strong>{peer().hostname}</strong>
                <span>
                  <StatusDot state={peer().online ? 'on' : 'off'} />
                  {peer().online
                    ? t('net_filter_online')
                    : t('net_filter_offline')}
                </span>
              </div>
            </div>
            <div class="network-addresses">
              <For each={peer().ips} fallback={<span>{t('net_address_pending')}</span>}>
                {ip => (
                  <div>
                    <div class="network-address">
                      <code>{ip}</code>
                      <IconButton
                        aria-label={t('net_copy_address') + ': ' + ip}
                        onClick={() => copyAddress(ip)}
                      >
                        <MdIcon name="content_copy" size={18} />
                      </IconButton>
                    </div>
                    <PeerProbe peerId={peer().id} ip={ip} disabled={Boolean(loadError())} />
                  </div>
                )}
              </For>
            </div>
            <p class="tool-hint">{t('net_peer_probe_hint')}</p>
            <KvRow k={t('net_os')} v={peer().os || '—'} />
            <KvRow k={t('net_relay_region')} v={peer().relay || '—'} />
            <KvRow k={t('peers_rx')} v={fmtBytes(peer().rxBytes)} />
            <KvRow k={t('peers_tx')} v={fmtBytes(peer().txBytes)} />
            <KvRow
              k={t('exit_title')}
              v={peer().exitNodeOption ? t('net_enabled') : t('net_disabled')}
            />
            <div class="md-dialog-actions">
              <Button variant="text" onClick={() => setDetailId(null)}>
                {t('close')}
              </Button>
            </div>
          </Dialog>
        )}
      </Show>
    </div>
  );
}

function PeerProbe(props: { peerId: string; ip: string; disabled: boolean }): JSX.Element {
  const key = () => 'peer-ping:' + props.peerId + ':' + props.ip;
  const task = () => getTask(key());
  const result = () => {
    const value = task()?.result;
    return value?.ok && value.peerId === props.peerId && value.ip === props.ip &&
      typeof value.latencyMs === 'number' && Number.isFinite(value.latencyMs) && value.latencyMs >= 0 &&
      typeof value.via === 'string' ? value : null;
  };
  const path = () => {
    switch (result()?.path) {
      case 'direct': return t('net_peer_direct');
      case 'derp': return 'DERP';
      case 'peer-relay': return t('net_peer_relay');
      default: return t('net_unknown');
    }
  };
  return (
    <div data-peer-probe={props.ip}>
      <TaskButton taskKey={key()} cmd="peer-ping" args={[props.peerId, props.ip]}
        label={t('net_peer_probe') + (props.ip.includes(':') ? ' IPv6' : ' IPv4')}
        disabled={props.disabled} />
      <TaskProgress taskKey={key()} />
      <Show when={task()?.status === 'done' && result()?.ok}>
        <p role="status">{path()} · {Number(result()?.latencyMs)} ms <code>{String(result()?.via ?? '')}</code></p>
      </Show>
      <Show when={task()?.status === 'error' || (task()?.status === 'done' && !result())}>
        <ErrorState text={String(task()?.result?.error || t('net_peer_probe_invalid'))} />
      </Show>
      <Show when={task()?.status === 'cancelled'}><p role="status">{t('cancelled')}</p></Show>
    </div>
  );
}
