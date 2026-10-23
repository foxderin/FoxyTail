import { createSignal } from 'solid-js';

const [savedConfigRevision, setSavedConfigRevision] = createSignal(0);
export { savedConfigRevision };
export function markSavedConfigChanged(): void {
  setSavedConfigRevision(revision => revision + 1);
}

export const DATA_DIR = '/data/adb/foxytail';
/* View polling intervals (ms). Power saving and startup states widen or
 * tighten the shared status poll; each value is pinned by the smoke suite. */
export const STATUS_POLL_MS = 15000;
export const STATUS_POLL_POWER_SAVE_MS = 30000;
export const STATUS_POLL_STARTING_MS = 5000;
export const LOGS_POLL_MS = 5000;
export const TRIAL_POLL_MS = 3000;
export const TRIAL_COUNTDOWN_MS = 1000;
export const TAILDROP_POLL_MS = 1500;
export const LOGIN_REFRESH_DELAY_MS = 1500;

