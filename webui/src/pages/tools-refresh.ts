import { createEffect, createSignal, onCleanup, untrack, useContext } from 'solid-js';
import { nativeControl, type ApiResult } from '../api';
import { appActive, RouteVisible } from '../schedule';

/** Read-only scheduling: interruption keeps demand, not the obsolete response.
 * Ordinary failures publish once; only lifecycle/revision invalidation or an
 * explicit refresh can restart a cancelled read. Accepted writes never enter here.
 */
function createRefresh(
  read: () => Promise<ApiResult>,
  publish: (result: ApiResult) => void,
  setBusy: (busy: boolean) => void,
  queueWhileRunning: boolean,
): () => Promise<void> {
  const routeVisible = useContext(RouteVisible);
  const [documentVisible, setDocumentVisible] = createSignal(!document.hidden);
  const visibilityChanged = () => setDocumentVisible(!document.hidden);
  document.addEventListener('visibilitychange', visibilityChanged);
  let running = false;
  let pending = false;
  let disposed = false;
  let generation = 0;
  let blockedGeneration = -1;
  let previousState = untrack(() => [appActive(), routeVisible(), documentVisible(), nativeControl().ownsMutation, nativeControl().revision, nativeControl().accountRevision].join('|'));
  let current = Promise.resolve();
  const available = () => appActive() && routeVisible() && documentVisible() && !nativeControl().ownsMutation;

  function start(): Promise<void> {
    if (disposed || running || !pending || !available() || blockedGeneration === generation) return current;
    pending = false;
    running = true;
    setBusy(true);
    const started = generation;
    const revision = nativeControl().revision, account = nativeControl().accountRevision;
    current = (async () => {
      try {
        const result = await read();
        if (disposed) return;
        const superseded = started !== generation || revision !== nativeControl().revision || account !== nativeControl().accountRevision;
        if (superseded || result.cancelled) {
          const requestedAgain = pending;
          pending = true;
          // A cancellation without a lifecycle/revision change must not spin.
          blockedGeneration = !superseded && !requestedAgain ? generation : -1;
        } else if (!pending) publish(result);
      } finally {
        running = false;
        if (!disposed) {
          setBusy(false);
          if (pending && available() && blockedGeneration !== generation) await start();
        }
      }
    })();
    return current;
  }

  createEffect(() => {
    const control = nativeControl();
    const state = [appActive(), routeVisible(), documentVisible(), control.ownsMutation, control.revision, control.accountRevision].join('|');
    if (state !== previousState) { previousState = state; generation++; }
    untrack(() => { if (pending) void start(); });
  });
  onCleanup(() => {
    disposed = true;
    pending = false;
    document.removeEventListener('visibilitychange', visibilityChanged);
  });
  return () => {
    if (disposed || running && !queueWhileRunning) return current;
    pending = true;
    blockedGeneration = -1;
    return start();
  };
}

/** Coalesce explicit refreshes requested while a read is in flight. */
export function createQueuedRefresh(
  read: () => Promise<ApiResult>,
  publish: (result: ApiResult) => void,
  setBusy: (busy: boolean) => void,
): () => Promise<void> {
  return createRefresh(read, publish, setBusy, true);
}

/** Single flight: extra calls are dropped, but interrupted reads resume. */
export function createGuardedLoad(
  read: () => Promise<ApiResult>,
  publish: (result: ApiResult) => void,
  setBusy: (busy: boolean) => void,
): () => Promise<void> {
  return createRefresh(read, publish, setBusy, false);
}
