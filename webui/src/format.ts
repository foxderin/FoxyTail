/* Formatting helpers ported from webroot/js/dom.js. */

export function fmtBytes(n: number | null | undefined): string {
  let v = Number(n) || 0;
  if (!isFinite(v)) v = 0;
  if (v < 1024) return v + ' B';
  if (v < 1048576) return (v / 1024).toFixed(1) + ' KiB';
  if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MiB';
  return (v / 1073741824).toFixed(2) + ' GiB';
}

export function fmtUptime(sec: number | null | undefined): string {
  const s = Number(sec) || 0;
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}

export function fmtTime(epochSec: number | null | undefined): string {
  if (!epochSec) return '-';
  const d = new Date(epochSec * 1000);
  const p = (x: number) => (x < 10 ? '0' : '') + x;
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

type LatClass = 'lat-good' | 'lat-mid' | 'lat-bad' | '';

export function latClass(ms: number | null | undefined): LatClass {
  if (ms == null) return '';
  if (ms < 100) return 'lat-good';
  if (ms <= 300) return 'lat-mid';
  return 'lat-bad';
}
