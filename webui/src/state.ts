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

let inFlight = false;

export async function refreshStatus(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = (await api('status')) as StatusSnapshot;
    if (res.ok) {
      setStatus(res);
      setStatusError(null);
    } else {
      setStatusError(res.error || 'error');
    }
  } finally {
    inFlight = false;
    setStatusLoading(false);
  }
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
  if (!s || !s.ok) return 'unknown';
  if (s.daemon !== 'running') return 'stopped';
  const b = s.backend || '';
  if (b === 'Running') return 'running';
  if (b === 'NeedsLogin' || b === 'NeedsMachineAuth' || b === 'NoState') return 'needs-login';
  return 'starting';
}
