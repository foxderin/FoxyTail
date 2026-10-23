/** Tailnet membership diagram. Every edge classifies the established path of
 * its device: a direct connection, a relay over a named DERP region, or an
 * offline member. */
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from 'solid-js';
import { t } from '../i18n';
import { StatusDot } from './Basics';
import type { Peer } from '../types';

type PeerPath = 'direct' | 'relay' | 'off';

export function TopologyChart(props: {
  self: { hostname: string } | null;
  peers: Peer[];
  exitNodeId?: string | null;
  onPeerClick: (peer: Peer) => void;
}): JSX.Element {
  let root!: HTMLDivElement;
  const [width, setWidth] = createSignal(640);
  const columns = () => (width() >= 560 ? 3 : 2);
  // Older backends omit the path fields: an online device without curAddr is
  // rendered as relayed rather than claiming an established direct path.
  const path = (peer: Peer): PeerPath =>
    !peer.online ? 'off' : (peer.curAddr || '') !== '' ? 'direct' : 'relay';
  const region = (peer: Peer) => (peer.relay || '—').toUpperCase();
  const rank: Record<PeerPath, number> = { direct: 0, relay: 1, off: 2 };
  // Direct devices first, then relay groups by region, then offline members.
  // A large Tailnet remains readable: the diagram is bounded, the list is complete.
  const visible = createMemo(() =>
    [...props.peers]
      .sort(
        (a, b) =>
          rank[path(a)] - rank[path(b)] ||
          (path(a) === 'relay' ? region(a).localeCompare(region(b)) : 0) ||
          a.hostname.localeCompare(b.hostname),
      )
      .slice(0, 12),
  );
  const cardWidth = () => (width() - 20 - (columns() - 1) * 14) / columns();
  const x = (index: number) => 10 + (index % columns()) * (cardWidth() + 14);
  // One pill per DERP region in use by the visible relayed devices, centered
  // over its member cards.
  const pills = createMemo(() => {
    const regions = new Map<string, number[]>();
    visible().forEach((peer, index) => {
      if (path(peer) !== 'relay') return;
      regions.set(region(peer), [...(regions.get(region(peer)) || []), index]);
    });
    return [...regions.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, indices]) => {
        const center =
          indices.reduce((sum, index) => sum + x(index) + cardWidth() / 2, 0) /
          indices.length;
        return {
          code,
          indices,
          cx: Math.min(Math.max(center, 50), width() - 50),
          width: Math.max(36, code.length * 7 + 16),
        };
      });
  });
  // The relay band only exists while a relayed device is on screen.
  const band = () => (pills().length ? 40 : 0);
  const pillTop = () => 109;
  const pillBottom = () => pillTop() + 18;
  const gridTop = () => 118 + band();
  const height = () => gridTop() + Math.ceil(visible().length / columns()) * 88;
  const y = (index: number) => gridTop() + Math.floor(index / columns()) * 88;
  const label = (value: string) => {
    const max = Math.max(11, Math.floor((cardWidth() - 26) / 7));
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  };
  const pathLabel = (peer: Peer) =>
    path(peer) === 'direct'
      ? t('net_topo_direct')
      : path(peer) === 'relay'
        ? t('net_topo_relay') + ' ' + region(peer)
        : t('net_filter_offline');
  const edgeClass = (peer: Peer) =>
    'network-topology-edge is-' +
    (path(peer) === 'off' ? 'offline' : path(peer));
  const isExit = (peer: Peer) => props.exitNodeId === peer.id;
  const addrHint = (peer: Peer) =>
    path(peer) === 'direct' && peer.curAddr ? ' · ' + peer.curAddr : '';
  const exitHint = (peer: Peer) =>
    isExit(peer) ? ' · ' + t('net_topo_exit') : '';

  onMount(() => {
    const resize = () =>
      setWidth(Math.max(260, Math.round(root.clientWidth || 640)));
    resize();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(root);
    window.addEventListener('resize', resize);
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    });
  });

  return (
    <div ref={root}>
      <div class="network-chart-legend">
        <span>
          <StatusDot state="on" />
          {t('net_filter_online')}
        </span>
        <span>
          <StatusDot state="off" />
          {t('net_filter_offline')}
        </span>
        <span>
          <svg
            class="network-chart-sample"
            viewBox="0 0 22 8"
            aria-hidden="true"
          >
            <path
              d="M1,4 H21"
              stroke="var(--md-sys-color-primary)"
              stroke-width="1.5"
              fill="none"
            />
          </svg>
          {t('net_topo_direct')}
        </span>
        <span>
          <svg
            class="network-chart-sample"
            viewBox="0 0 22 8"
            aria-hidden="true"
          >
            <path
              d="M1,4 H21"
              stroke="var(--md-sys-color-outline-variant)"
              stroke-width="1.5"
              stroke-dasharray="4 3"
              fill="none"
            />
          </svg>
          {t('net_topo_relay')}
        </span>
        <span class="network-chart-hint">
          {visible().length} / {props.peers.length} {t('net_peer_total')}
        </span>
      </div>
      <svg
        class="network-topology-svg"
        viewBox={`0 0 ${width()} ${height()}`}
        role="group"
        aria-label={t('peers_topology')}
      >
        <path
          d={`M${width() / 2},71 V93`}
          stroke="var(--md-sys-color-outline-variant)"
          fill="none"
          stroke-width="1.5"
        />
        <For each={visible()}>
          {(peer, index) => (
            <Show when={path(peer) !== 'relay'}>
              <path
                class={edgeClass(peer)}
                d={`M${width() / 2},93 H${x(index()) + cardWidth() / 2} V${gridTop()}`}
                stroke={
                  path(peer) === 'direct'
                    ? 'var(--md-sys-color-primary)'
                    : 'var(--md-sys-color-outline-variant)'
                }
                opacity={path(peer) === 'direct' ? '.4' : '.6'}
                stroke-dasharray={path(peer) === 'direct' ? undefined : '4 4'}
                fill="none"
                stroke-width="1.25"
              />
            </Show>
          )}
        </For>
        <For each={pills()}>
          {(pill) => (
            <path
              class="network-topology-edge is-relay"
              d={`M${width() / 2},93 H${pill.cx} V${pillTop()}`}
              stroke="var(--md-sys-color-outline-variant)"
              stroke-dasharray="6 4"
              fill="none"
              stroke-width="1.25"
            />
          )}
        </For>
        <For each={pills()}>
          {(pill) => (
            <For each={pill.indices}>
              {(index) => (
                <path
                  class="network-topology-edge is-relay"
                  d={`M${pill.cx},${pillBottom()} V${
                    (pillBottom() + gridTop()) / 2
                  } H${x(index) + cardWidth() / 2} V${gridTop()}`}
                  stroke="var(--md-sys-color-outline-variant)"
                  stroke-dasharray="6 4"
                  fill="none"
                  stroke-width="1.25"
                />
              )}
            </For>
          )}
        </For>
        <For each={pills()}>
          {(pill) => (
            <g class="network-topology-relay">
              <rect
                x={pill.cx - pill.width / 2}
                y={pillTop()}
                width={pill.width}
                height="18"
              />
              <text x={pill.cx} y={pillTop() + 12.5} text-anchor="middle">
                {pill.code}
              </text>
            </g>
          )}
        </For>
        <rect
          x={width() / 2 - 92}
          y="6"
          width="184"
          height="65"
          rx="15"
          fill="var(--md-sys-color-primary-container)"
        />
        <text
          x={width() / 2}
          y="31"
          text-anchor="middle"
          fill="var(--md-sys-color-on-primary-container)"
          font-size="13"
          font-weight="650"
        >
          {(props.self?.hostname || t('dash_self')).slice(0, 25)}
        </text>
        <text
          x={width() / 2}
          y="51"
          text-anchor="middle"
          fill="var(--md-sys-color-on-primary-container)"
          font-size="10"
          opacity=".8"
        >
          {t('dash_self')} · Tailnet
        </text>
        <For each={visible()}>
          {(peer, index) => (
            <g
              class={
                'network-topology-peer' + (isExit(peer) ? ' is-exit' : '')
              }
              role="button"
              tabindex="0"
              aria-label={t('net_peer_details') + ': ' + peer.hostname}
              onClick={() => props.onPeerClick(peer)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  props.onPeerClick(peer);
                }
              }}
            >
              <title>
                {peer.hostname} · {peer.ips?.join(' · ') || peer.ip} ·{' '}
                {peer.online ? t('net_filter_online') : t('net_filter_offline')}
                {addrHint(peer)}
                {exitHint(peer)}
              </title>
              <rect
                x={x(index())}
                y={y(index())}
                width={cardWidth()}
                height="66"
                rx="12"
                fill="var(--md-sys-color-surface)"
                stroke={
                  isExit(peer)
                    ? 'var(--md-sys-color-primary)'
                    : 'var(--md-sys-color-outline-variant)'
                }
                stroke-width={isExit(peer) ? '2' : undefined}
              />
              <circle
                cx={x(index()) + 14}
                cy={y(index()) + 21}
                r="3.5"
                fill={
                  peer.online ? 'var(--ft-ok)' : 'var(--md-sys-color-outline)'
                }
              />
              <text
                class="network-topology-label"
                x={x(index()) + 25}
                y={y(index()) + 25}
                font-weight="600"
              >
                {label(peer.hostname)}
              </text>
              <text
                class="network-topology-detail"
                x={x(index()) + 14}
                y={y(index()) + 46}
              >
                {peer.os || '—'} · {pathLabel(peer)}
              </text>
            </g>
          )}
        </For>
      </svg>
      <details class="network-chart-data">
        <summary>
          {t('net_topology_list')} · {props.peers.length}
        </summary>
        <div class="network-topology-list">
          <For each={props.peers}>
            {(peer) => (
              <button type="button" onClick={() => props.onPeerClick(peer)}>
                <StatusDot state={peer.online ? 'on' : 'off'} />
                {peer.hostname}
              </button>
            )}
          </For>
        </div>
      </details>
    </div>
  );
}
