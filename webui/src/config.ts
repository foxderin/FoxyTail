import { createSignal } from 'solid-js';

const [savedConfigRevision, setSavedConfigRevision] = createSignal(0);
export { savedConfigRevision };
export function markSavedConfigChanged(): void {
  setSavedConfigRevision(revision => revision + 1);
}

/* Once launched, these transactions must report their real commit outcome. */
export const NONCANCELLABLE_COMMANDS: Readonly<Record<string, true>> = {
  control: true, 'mode-set': true, 'routes-set': true, 'subnet-routes-set': true,
  'settings-set': true, 'context-set': true, backup: true,
  'trial-start': true, 'trial-confirm': true, 'trial-revert': true,
};

export const DATA_DIR = '/data/adb/foxytail';
export const WEBAPI = DATA_DIR + '/scripts/foxytail.webapi.sh';

/* Per-command timeout budget (ms). Heavy probes get a wider budget. */
export const DEFAULT_TIMEOUT_MS = 15000;
export const CLEANUP_TIMEOUT_MS = 8000;

/* View polling intervals (ms). Power saving and startup states widen or
 * tighten the shared status poll; each value is pinned by the smoke suite. */
export const STATUS_POLL_MS = 15000;
export const STATUS_POLL_POWER_SAVE_MS = 30000;
export const STATUS_POLL_STARTING_MS = 5000;
export const LOGS_POLL_MS = 5000;
export const TRIAL_POLL_MS = 3000;
export const TRIAL_COUNTDOWN_MS = 1000;
export const LOGIN_REFRESH_DELAY_MS = 1500;

export const COMMAND_TIMEOUTS: Record<string, number> = {
  'peer-ping': 30000,
  'diag-check': 65000,
  'trial-start': 120000,
  'trial-revert': 120000,
  'restore-preview': 30000,
  restore: 120000,
  'speedtest-exitnodes': 90000,
  'derp-speedtest': 60000,
  // Profile DNS restoration precedes teardown; keep the asynchronous request
  // alive through its bounded CLI calls instead of reporting a false timeout.
  control: 120000,
  'mode-set': 120000,
  'exitnode-set': 100000,
  'exitnode-clear': 100000,
  login: 95000,
  'login-authkey': 130000,
  logout: 95000,
  accounts: 20000,
  switch: 95000,
  'serve-list': 20000,
  'serve-set': 30000,
  'serve-del': 30000,
  'funnel-list': 20000,
  'funnel-set': 30000,
  'funnel-del': 30000,
  apps: 90000,
  compat: 35000,
  'routes-set': 45000,
  'subnet-routes-get': 20000,
  'subnet-routes-set': 35000,
  'context-set': 45000,
  'context-get': 20000,
  'file-send': 320000,
  'file-receive': 70000,
  diag: 130000,
  backup: 60000,
};
