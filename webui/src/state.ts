/*
 * Global status store: one visible poller for `webapi status`, shared by the
 * header StatusDot, the Dashboard cards and the LoginHero. Pages never call
 * status on their own — they subscribe to this store or trigger
 * refreshStatus() after a mutating action.
 *
 * The poller is pure view refresh (not a user task): it stops when the
 * shell unmounts and pauses while document.hidden.
 */
import { createSignal } from 'solid-js';
import { api, hasRoot, type ApiResult } from './api';
import { STATUS_POLL_MS, STATUS_POLL_POWER_SAVE_MS, STATUS_POLL_STARTING_MS } from './config';
import { pollWhileVisible } from './schedule';
import type { ExitRouting } from './types';
import type { I18nKey } from './i18n';

export interface StatusSnapshot extends ApiResult {
  daemon?: string;
  backend?: string;
  mode?: string;
  self?: { hostname: string; ips: string[]; relay: string } | null;
  exitNode?: {
    id: string;
    hostname: string;
    ip: string;
    online: boolean;
    rx: number;
    tx: number;
  } | null;
  exitRouting?: ExitRouting;
  peers?: { online: number; offline: number };
  magicDns?: boolean;
  keyExpiry?: string | null;
  uptime?: number;
  powerSave?: boolean;
  autoRefresh?: boolean;
}

const [status, setStatus] = createSignal<StatusSnapshot | null>(null);
const [statusError, setStatusError] = createSignal<string | null>(null);
const [statusLoading, setStatusLoading] = createSignal(true);

export { status, statusError, statusLoading };

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

/** Applied runtime preferences govern view reads; unsaved/pending settings
 * never change polling. Explicit refreshes and user tasks bypass this. */
export function viewPollInterval(normalMs = STATUS_POLL_MS): number | false {
  if (!hasRoot || status()?.autoRefresh === false) return false;
  return status()?.powerSave === true ? STATUS_POLL_POWER_SAVE_MS : normalMs;
}

type StatusRead = Promise<StatusSnapshot | null>;
let inFlight: StatusRead | null = null;
let afterCurrent: StatusRead | null = null;

async function readStatus(): StatusRead {
  try {
    const res = (await api('status')) as StatusSnapshot;
    if (res.ok) {
      setStatus(res);
      setStatusError(null);
      return res;
    } else {
      setStatusError(res.error || 'error');
      return null;
    }
  } catch {
    setStatusError('error');
    return null;
  } finally {
    setStatusLoading(false);
  }
}

/** Polls share their pending read. A read started before a mutation cannot
 * confirm it, so mutation callers request one coalesced follow-up read. */
export function refreshStatus(options: { afterCurrent?: boolean } = {}): StatusRead {
  if (inFlight) {
    if (!options.afterCurrent) return inFlight;
    if (!afterCurrent) {
      afterCurrent = inFlight.then(() => {
        afterCurrent = null;
        return refreshStatus();
      });
    }
    return afterCurrent;
  }
  const read = readStatus().finally(() => {
    if (inFlight === read) inFlight = null;
  });
  inFlight = read;
  return read;
}

/* Start the shared poller. Called once from the AppShell; returns via
 * onCleanup registration of the caller. */
export function startStatusPolling(): void {
  if (!hasRoot) { void refreshStatus(); return; }
  pollWhileVisible(refreshStatus, () => {
    const interval = viewPollInterval();
    const starting = status()?.daemon === 'running' && ['NoState', 'Starting'].includes(status()?.backend ?? '');
    return interval !== false && starting ? STATUS_POLL_STARTING_MS : interval;
  });
}

/* Backend state classification for the header dot / hero. */
export type ConnState = 'running' | 'needs-login' | 'starting' | 'stopped' | 'unknown';

export function connState(s: StatusSnapshot | null): ConnState {
  if (!s || !s.ok || s.backend === 'unreachable') return 'unknown';
  if (s.daemon === 'stopped') return 'stopped';
  if (s.daemon !== 'running') return 'unknown';
  const b = s.backend || '';
  if (b === 'Running') return 'running';
  if (b === 'NeedsLogin') return 'needs-login';
  // NoState means the control client has not determined its state yet.
  // NeedsMachineAuth awaits administrator approval, not another user login.
  return 'starting';
}
