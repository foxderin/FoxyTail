/*
 * Canvas line chart (rAF-throttled touch tooltip), ported from
 * webroot/js/charts.js drawLineChart; colors now come from MD3 tokens.
 */
import { onCleanup, onMount, type JSX } from 'solid-js';
import { token } from '../theme';
import { fmtBytes } from '../format';

export interface ChartSeries {
  name: string;
  color: string;
  values: number[];
}

export function chartColors(): { rx: string; tx: string } {
  return {
    rx: token('--md-sys-color-primary', '#e0632f'),
    tx: token('--md-sys-color-tertiary', '#8fd0c3'),
  };
}

export function LineChart(props: { labels: string[]; series: ChartSeries[] }): JSX.Element {
  let canvas!: HTMLCanvasElement;

  onMount(() => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 320;
    const hgt = 220;
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    canvas.style.height = hgt + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const cFg = token('--md-sys-color-on-surface', '#e8e6f0');
    const cDim = token('--md-sys-color-on-surface-variant', '#6d6a7c');
    const cLine = token('--md-sys-color-outline-variant', '#33333f');

    const padL = 46, padR = 10, padT = 12, padB = 26;
    const iw = w - padL - padR, ih = hgt - padT - padB;
    const labels = props.labels;
    const series = props.series;
    const n = labels.length;

    let maxV = 1;
    series.forEach((s) => s.values.forEach((v) => { if (v > maxV) maxV = v; }));

    const xAt = (i: number) => padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const yAt = (v: number) => padT + ih - (v / maxV) * ih;

    /* gradients depend only on (color, geometry); build once per series */
    const gradCache: Record<string, CanvasGradient> = {};
    const gradFor = (s: ChartSeries) => {
      const key = s.color + '|' + padT + '|' + ih;
      if (!gradCache[key]) {
        const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
        grad.addColorStop(0, s.color + '55');
        grad.addColorStop(1, s.color + '00');
        gradCache[key] = grad;
      }
      return gradCache[key];
    };

    const paint = (hoverIdx: number | null) => {
      ctx.clearRect(0, 0, w, hgt);
      ctx.font = '10px system-ui, sans-serif';
      ctx.strokeStyle = cLine;
      ctx.fillStyle = cDim;
      ctx.textAlign = 'right';
      for (let g = 0; g <= 4; g++) {
        const v = (maxV / 4) * g;
        const y = yAt(v);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.globalAlpha = 0.4;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillText(fmtBytes(v), padL - 6, y + 3);
      }
      ctx.textAlign = 'center';
      const step = Math.ceil(n / 6) || 1;
      for (let i = 0; i < n; i += step) {
        ctx.fillText(String(labels[i]), xAt(i), hgt - 8);
      }
      series.forEach((s) => {
        ctx.beginPath();
        ctx.moveTo(xAt(0), yAt(s.values[0] ?? 0));
        for (let j = 1; j < n; j++) ctx.lineTo(xAt(j), yAt(s.values[j] ?? 0));
        ctx.lineTo(xAt(n - 1), padT + ih);
        ctx.lineTo(xAt(0), padT + ih);
        ctx.closePath();
        ctx.fillStyle = gradFor(s);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(xAt(0), yAt(s.values[0] ?? 0));
        for (let j = 1; j < n; j++) ctx.lineTo(xAt(j), yAt(s.values[j] ?? 0));
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.stroke();
      });
      if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < n) {
        const hx = xAt(hoverIdx);
        ctx.strokeStyle = cFg;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(hx, padT);
        ctx.lineTo(hx, padT + ih);
        ctx.stroke();
        ctx.globalAlpha = 1;
        let txt = String(labels[hoverIdx]);
        series.forEach((s) => {
          txt += '  ' + s.name + ' ' + fmtBytes(s.values[hoverIdx] ?? 0);
        });
        ctx.textAlign = 'center';
        ctx.fillStyle = cFg;
        ctx.fillText(txt, Math.min(Math.max(hx, 90), w - 90), padT + 2);
      }
    };
    paint(null);

    /* rAF throttle: collapse a burst of pointer/touch moves into one repaint
     * per frame; clientX is captured synchronously because touch point lists
     * are not guaranteed to survive until the frame fires */
    let rafPending = false;
    let pendingX: number | null = null;
    const onTouch = (e: Event) => {
      const te = e as TouchEvent;
      const src = te.touches ? te.touches[0] : (e as PointerEvent);
      if (!src) return;
      pendingX = src.clientX;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        const rect = canvas.getBoundingClientRect();
        const px = (pendingX ?? 0) - rect.left;
        const idx = Math.round(((px - padL) / iw) * (n - 1));
        paint(Math.max(0, Math.min(n - 1, idx)));
      });
    };
    canvas.addEventListener('pointermove', onTouch);
    canvas.addEventListener('touchstart', onTouch, { passive: true });
    canvas.addEventListener('touchmove', onTouch, { passive: true });
    onCleanup(() => {
      canvas.removeEventListener('pointermove', onTouch);
      canvas.removeEventListener('touchstart', onTouch);
      canvas.removeEventListener('touchmove', onTouch);
    });
  });

  return <canvas ref={canvas} class="chart" />;
}
