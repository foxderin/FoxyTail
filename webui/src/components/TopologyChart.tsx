/** Tailnet membership diagram. Edges deliberately do not imply direct paths. */
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';
import { t } from '../i18n';
import { StatusDot } from './Basics';
import type { Peer } from '../types';

export function TopologyChart(props: {
  self: { hostname: string } | null;
  peers: Peer[];
  onPeerClick: (peer: Peer) => void;
}): JSX.Element {
  let root!: HTMLDivElement;
  const [width, setWidth] = createSignal(640);
  const columns = () => (width() >= 560 ? 3 : 2);
  // A large Tailnet remains readable: the diagram is bounded, the list is complete.
  const visible = createMemo(() =>
    [...props.peers]
      .sort(
        (a, b) =>
          a.relay.localeCompare(b.relay) ||
          Number(b.online) - Number(a.online) ||
          a.hostname.localeCompare(b.hostname),
      )
      .slice(0, 12),
  );
  const cardWidth = () => (width() - 20 - (columns() - 1) * 14) / columns();
  const height = () => 118 + Math.ceil(visible().length / columns()) * 88;
  const x = (index: number) => 10 + (index % columns()) * (cardWidth() + 14);
  const y = (index: number) => 118 + Math.floor(index / columns()) * 88;
  const label = (value: string) => {
    const max = Math.max(11, Math.floor((cardWidth() - 26) / 7));
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  };

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
            <path
              d={`M${width() / 2},93 H${x(index()) + cardWidth() / 2} V${y(index())}`}
              stroke={
                peer.online
                  ? 'var(--md-sys-color-primary)'
                  : 'var(--md-sys-color-outline-variant)'
              }
              opacity={peer.online ? '.4' : '.6'}
              stroke-dasharray={peer.online ? undefined : '4 4'}
              fill="none"
              stroke-width="1.25"
            />
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
              class="network-topology-peer"
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
              </title>
              <rect
                x={x(index())}
                y={y(index())}
                width={cardWidth()}
                height="66"
                rx="12"
                fill="var(--md-sys-color-surface)"
                stroke="var(--md-sys-color-outline-variant)"
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
                {peer.os || '—'} · {peer.relay || '—'}
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
