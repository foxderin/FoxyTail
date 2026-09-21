import { onCleanup } from 'solid-js';
import type { ApiResult } from '../api';

/** Coalesce refreshes while retaining a read requested after a mutation.
 * A superseded response is never published. The busy state covers the whole
 * drain, and page disposal prevents a queued read from escaping its scope.
 */
export function createQueuedRefresh(
  read: () => Promise<ApiResult>,
  publish: (result: ApiResult) => void,
  setBusy: (busy: boolean) => void,
): () => Promise<void> {
  let running = false;
  let queued = false;
  let disposed = false;
  let current = Promise.resolve();
  onCleanup(() => {
    disposed = true;
    queued = false;
  });

  async function drain(): Promise<void> {
    try {
      while (queued && !disposed) {
        queued = false;
        const result = await read();
        if (disposed || result.cancelled) {
          queued = false;
          return;
        }
        if (!queued) publish(result);
      }
    } finally {
      running = false;
      setBusy(false);
    }
  }

  return () => {
    if (disposed) return Promise.resolve();
    queued = true;
    if (!running) {
      running = true;
      setBusy(true);
      current = drain();
    }
    return current;
  };
}

/** Single-flight page read for explicit buttons and visible polls. A call made
 * while a read is running is dropped, the busy state covers exactly one read,
 * and a cancelled or superseded reply is never published.
 */
export function createGuardedLoad(
  read: () => Promise<ApiResult>,
  publish: (result: ApiResult) => void,
  setBusy: (busy: boolean) => void,
): () => Promise<void> {
  let busy = false;
  let seq = 0;

  return async () => {
    if (busy) return;
    busy = true;
    setBusy(true);
    const my = ++seq;
    const result = await read();
    busy = false;
    setBusy(false);
    if (result.cancelled || my !== seq) return;
    publish(result);
  };
}
