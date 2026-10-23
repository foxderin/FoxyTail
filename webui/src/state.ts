import { createSignal } from 'solid-js';
import { api, hasRoot, nativeControl, type ApiResult } from './api';
import { onNativeEvent } from './native';
import { STATUS_POLL_MS, STATUS_POLL_POWER_SAVE_MS, STATUS_POLL_STARTING_MS } from './config';
import { pollWhileVisible, appActive } from './schedule';
import type { ExitRouting, Peer } from './types';
import type { I18nKey } from './i18n';

export interface StatusSnapshot extends ApiResult {
  daemon?: string; backend?: string; mode?: string;
  self?: { id?: string; hostname: string; ips: string[]; relay: string } | null;
  exitNode?: { id: string; hostname: string; ip: string; online: boolean; rx: number; tx: number } | null;
  exitRouting?: ExitRouting; peers?: { online: number; offline: number }; peerList?: Peer[];
  magicDns?: boolean; keyExpiry?: string | null; uptime?: number; powerSave?: boolean; autoRefresh?: boolean;
}
const [status, setStatus] = createSignal<StatusSnapshot | null>(null);
const [statusError, setStatusError] = createSignal<string | null>(null);
const [statusLoading, setStatusLoading] = createSignal(true);
const [peers, setPeers] = createSignal<Peer[] | null>(null);
export { status, statusError, statusLoading, peers };
let revision = 0;
let accountRevision = 0;
let operationRevision = 0;
let wasCompatible = false;
let inFlight: Promise<StatusSnapshot | null> | null = null;
let afterCurrent: Promise<StatusSnapshot | null> | null = null;
let exitRead: Promise<ApiResult> | null = null;
let exitReadKey = '';
function identity(value: StatusSnapshot | null): string {
  return [value?.self?.id, value?.mode, value?.daemon, value?.backend, value?.exitNode?.id].join('|');
}
export function invalidateAccountState(): void {
  revision++;
  setStatus(null); setPeers(null); setStatusError(null); setStatusLoading(true);
}
onNativeEvent('control', () => {
  const current = nativeControl();
  const changed = current.revision !== operationRevision || current.accountRevision !== accountRevision || (current.compatible && !wasCompatible);
  wasCompatible = current.compatible;
  if (current.accountRevision !== accountRevision) {
    accountRevision = current.accountRevision;
    invalidateAccountState();
  } else if (current.revision !== operationRevision) {
    revision++;
    setStatus(previous => previous ? { ...previous, exitRouting: undefined } : previous);
  }
  if (changed) {
    operationRevision = current.revision;
    if (appActive()) void refreshStatus({ afterCurrent: true });
  }
});
export function exitRoutingLabel(): I18nKey {
  const route = status()?.exitRouting;
  if (statusError() || !route?.known) return 'net_exit_unknown_hint';
  if (route.effective === 'not-effective') return 'net_exit_failed';
  if (!route.selected) return 'net_no_exit_hint';
  if (route.effective === 'explicit-proxy') return 'net_exit_proxy';
  if (route.effective === 'daemon-owned') return 'net_exit_daemon';
  if (route.effective !== 'bridge-policy') return 'net_exit_failed';
  return route.ipv6 ? 'net_exit_bridge_dual' : 'net_exit_bridge_v4';
}
export function viewPollInterval(normalMs = STATUS_POLL_MS): number | false {
  if (!hasRoot || status()?.autoRefresh === false) return false;
  return status()?.powerSave === true ? STATUS_POLL_POWER_SAVE_MS : normalMs;
}
export function refreshExitRouting(): Promise<ApiResult> {
  const snapshot = status();
  if (!snapshot?.self?.id || statusError()) return Promise.resolve({ ok: false, error: 'Device identity is unavailable' });
  const started = revision, expected = identity(snapshot);
  const key = started + ':' + expected;
  if (exitRead) return exitReadKey === key ? exitRead : exitRead.then(() => refreshExitRouting());
  exitReadKey = key;
  const read = api('exit-routing').then(result => {
    if (started === revision && expected === identity(status())) {
      const valid = result.ok && result.selfId === snapshot.self!.id && result.exitRouting && typeof result.exitRouting === 'object';
      setStatus(previous => previous ? { ...previous, exitRouting: valid ? result.exitRouting as ExitRouting : undefined } : previous);
    }
    return result;
  }).finally(() => { if (exitRead === read) exitRead = null; });
  exitRead = read;
  return read;
}
async function readStatus(): Promise<StatusSnapshot | null> {
  const started = revision;
  try {
    const result = await api('status') as StatusSnapshot;
    if (started !== revision) return null;
    if (!result.ok) { setStatusError(result.error || 'Status is unavailable'); return null; }
    const same = identity(result) === identity(status());
    setStatus({ ...result, exitRouting: same ? status()?.exitRouting : undefined });
    setStatusError(null);
    setPeers(result.self?.id && Array.isArray(result.peerList) ? result.peerList.map(peer => ({
      ...peer, ips: (Array.isArray(peer.ips) ? peer.ips : [peer.ip]).filter(ip => typeof ip === 'string' && ip !== '' && ip !== '-'),
    })) : null);
    void refreshExitRouting();
    return status();
  } finally { if (started === revision) setStatusLoading(false); }
}
export function refreshStatus(options: { afterCurrent?: boolean } = {}): Promise<StatusSnapshot | null> {
  if (inFlight) {
    if (!options.afterCurrent) return inFlight;
    if (!afterCurrent) afterCurrent = inFlight.then(() => { afterCurrent = null; return refreshStatus(); });
    return afterCurrent;
  }
  const read = readStatus().finally(() => { if (inFlight === read) inFlight = null; });
  inFlight = read;
  return read;
}
export async function refreshPeers(): Promise<ApiResult> {
  const snapshot = await refreshStatus();
  return snapshot && peers() ? { ok: true, peers: peers()!, selfId: snapshot.self?.id } : { ok: false, error: statusError() || 'Device identity is unavailable' };
}
export function startStatusPolling(): void {
  pollWhileVisible(refreshStatus, () => {
    const interval = viewPollInterval();
    const starting = status()?.daemon === 'running' && ['NoState', 'Starting'].includes(status()?.backend ?? '');
    return interval !== false && starting ? STATUS_POLL_STARTING_MS : interval;
  });
}
export type ConnState = 'running' | 'needs-login' | 'starting' | 'stopped' | 'unknown';
export function connState(snapshot: StatusSnapshot | null): ConnState {
  if (!snapshot || !snapshot.ok || snapshot.backend === 'unreachable') return 'unknown';
  if (snapshot.daemon === 'stopped') return 'stopped';
  if (snapshot.daemon !== 'running') return 'unknown';
  if (snapshot.backend === 'Running') return 'running';
  return snapshot.backend === 'NeedsLogin' ? 'needs-login' : 'starting';
}
