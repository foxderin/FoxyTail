/*
 * Canvas star topology (Self centered, peers grouped by relay on rings),
 * ported from webroot/js/charts.js drawTopology; colors from MD3 tokens.
 * Emits hit-tests through onPeerClick.
 */
import { onCleanup, onMount, type JSX } from 'solid-js';
import { token } from '../theme';
import { t } from '../i18n';
import type { Peer } from '../types';

interface Placed {
  x: number;
  y: number;
  peer: Peer;
}

export function TopologyChart(props: {
  self: { hostname: string } | null;
  peers: Peer[];
  onPeerClick: (p: Peer) => void;
}): JSX.Element {
  let canvas!: HTMLCanvasElement;
  let nodes: Placed[] = [];

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 320;
    const hgt = Math.max(280, Math.min(420, w));
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    canvas.style.height = hgt + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const cFg = token('--md-sys-color-on-surface', '#e8e6f0');
    const cDim = token('--md-sys-color-on-surface-variant', '#a5a2b3');
    const cOk = token('--ft-ok', '#7fd88f');
    const cOff = token('--md-sys-color-outline', '#6d6a7c');
    const cPri = token('--md-sys-color-primary', '#e0632f');

    const cx = w / 2, cy = hgt / 2;
    const radius = Math.min(w, hgt) / 2 - 46;

    /* group peers by relay */
    const groups: Record<string, Peer[]> = {};
    props.peers.forEach((p) => {
      const r = p.relay || '-';
      (groups[r] = groups[r] || []).push(p);
    });
    const relays = Object.keys(groups);

    let maxTraffic = 1;
    props.peers.forEach((p) => {
      const s = (p.rxBytes || 0) + (p.txBytes || 0);
      if (s > maxTraffic) maxTraffic = s;
    });

    nodes = [];
    ctx.clearRect(0, 0, w, hgt);

    /* edges first */
    const placed: Placed[] = [];
    relays.forEach((relay, gi) => {
      const list = groups[relay];
      const sector = (Math.PI * 2) / relays.length;
      const start = gi * sector - Math.PI / 2;
      list.forEach((p, pi) => {
        const frac = list.length === 1 ? 0.5 : (pi + 0.5) / list.length;
        const ang = start + frac * sector;
        const ring = radius * (list.length > 3 ? (pi % 2 ? 0.72 : 1) : 1);
        placed.push({ x: cx + Math.cos(ang) * ring, y: cy + Math.sin(ang) * ring, peer: p });
      });
    });

    placed.forEach((n) => {
      const share = ((n.peer.rxBytes || 0) + (n.peer.txBytes || 0)) / maxTraffic;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(n.x, n.y);
      ctx.lineWidth = 1 + share * 7;
      ctx.strokeStyle = n.peer.online ? cPri : cOff;
      ctx.globalAlpha = n.peer.online ? 0.7 : 0.35;
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    /* peer nodes */
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    placed.forEach((n) => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = n.peer.online ? cOk : cOff;
      ctx.fill();
      ctx.fillStyle = cDim;
      ctx.fillText(n.peer.hostname || '-', n.x, n.y + 24);
      nodes.push(n);
    });

    /* self node */
    ctx.beginPath();
    ctx.arc(cx, cy, 16, 0, Math.PI * 2);
    ctx.fillStyle = cPri;
    ctx.fill();
    ctx.fillStyle = cFg;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText(props.self?.hostname || t('dash_self'), cx, cy + 32);
  };

  const onClick = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    for (const n of nodes) {
      const dx = n.x - x;
      const dy = n.y - y;
      if (dx * dx + dy * dy < 22 * 22) {
        props.onPeerClick(n.peer);
        return;
      }
    }
  };

  const onResize = () => draw();

  onMount(() => {
    draw();
    canvas.addEventListener('click', onClick);
    window.addEventListener('resize', onResize);
  });
  onCleanup(() => {
    canvas.removeEventListener('click', onClick);
    window.removeEventListener('resize', onResize);
  });

  return <canvas ref={canvas} class="topo" />;
}
