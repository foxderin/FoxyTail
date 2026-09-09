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
