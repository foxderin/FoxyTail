/*
 * Global status store: ONE 5s poller for `webapi status`, shared by the
 * header StatusDot, the Dashboard cards and the LoginHero. Pages never call
 * status on their own — they subscribe to this store or trigger
 * refreshStatus() after a mutating action.
 *
 * The poller is pure view refresh (not a user task): it stops when the
 * shell unmounts and pauses while document.hidden.
 */
import { createSignal, onCleanup } from 'solid-js';
import { api, type ApiResult } from './api';

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
  peers?: { online: number; offline: number };
  magicDns?: boolean;
  keyExpiry?: string | null;
  uptime?: number;
}

const [status, setStatus] = createSignal<StatusSnapshot | null>(null);
const [statusError, setStatusError] = createSignal<string | null>(null);
const [statusLoading, setStatusLoading] = createSignal(true);

export { status, statusError, statusLoading };

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
export function startStatusPolling(intervalMs = 5000): void {
  void refreshStatus();
  const id = setInterval(() => {
    if (!document.hidden) void refreshStatus();
  }, intervalMs);
  onCleanup(() => clearInterval(id));
}

/* Backend state classification for the header dot / hero. */
export type ConnState = 'running' | 'needs-login' | 'starting' | 'stopped' | 'unknown';

export function connState(s: StatusSnapshot | null): ConnState {
  if (!s || !s.ok || s.backend === 'unreachable') return 'unknown';
  if (s.daemon === 'stopped') return 'stopped';
  if (s.daemon !== 'running') return 'unknown';
  const b = s.backend || '';
  if (b === 'Running') return 'running';
  if (b === 'NeedsLogin' || b === 'NeedsMachineAuth' || b === 'NoState') return 'needs-login';
  return 'starting';
}
