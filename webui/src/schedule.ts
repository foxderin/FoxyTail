import { createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';

/** View reads have no timer while hidden or disabled. Resume immediately,
 * then wait from completion so a slow root command never creates a backlog. */
export function pollWhileVisible(run: () => unknown | Promise<unknown>, intervalMs: () => number | false): void {
  const [visible, setVisible] = createSignal(!document.hidden);
  const visibilityChanged = () => setVisible(!document.hidden);
  document.addEventListener('visibilitychange', visibilityChanged);
  onCleanup(() => document.removeEventListener('visibilitychange', visibilityChanged));
  const delay = createMemo(() => visible() ? intervalMs() : false);
  let loaded = false;
  createEffect(() => {
    const ms = delay();
    if (!visible() || (loaded && ms === false)) return;
    // Disabling automatic refresh still allows a page's first visible read.
    loaded = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try { await untrack(run); }
      finally { if (!stopped && ms !== false) timer = setTimeout(() => void tick(), ms); }
    };
    onCleanup(() => { stopped = true; clearTimeout(timer); });
    void tick();
  });
}

/* A resolved Promise / queueMicrotask still runs before the WebView can
 * paint. Native exec may synchronously enter Java or wait for a root shell,
 * so cross that boundary only after the current UI has had a frame. */
export function afterPaint(run: () => void): () => void {
  let frame: number | undefined;
  let task: ReturnType<typeof setTimeout> | undefined;
  let complete = false;
  const invoke = () => {
    if (complete) return;
    complete = true;
    clearTimeout(fallback);
    if (frame !== undefined) cancelAnimationFrame(frame);
    run();
  };
  // Background WebViews can suspend animation frames. Work must still be
  // able to finish or acknowledge cancellation while the screen is hidden.
  const fallback = setTimeout(invoke, 100);
  if (typeof requestAnimationFrame === 'function' && !document.hidden) {
    frame = requestAnimationFrame(() => { task = setTimeout(invoke, 0); });
  } else {
    task = setTimeout(invoke, 0);
  }
  return () => {
    complete = true;
    clearTimeout(fallback);
    clearTimeout(task);
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
