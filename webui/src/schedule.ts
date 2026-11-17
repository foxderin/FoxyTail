import { createContext, createEffect, createMemo, createSignal, onCleanup, untrack, useContext, type Accessor } from 'solid-js';
import { onNativeEvent } from './native';

export const RouteVisible = createContext<Accessor<boolean>>(() => true);
const [appActive, setAppActive] = createSignal(true);
export { appActive };
onNativeEvent('lifecycle', event => setAppActive(event.active === true));

/** View reads have no timer while hidden or disabled. Resume immediately,
 * then wait from completion so a slow root command never creates a backlog. */
export function pollWhileVisible(run: () => unknown | Promise<unknown>, intervalMs: () => number | false): void {
  const routeVisible = useContext(RouteVisible);
  const [visible, setVisible] = createSignal(!document.hidden);
  const visibilityChanged = () => setVisible(!document.hidden);
  document.addEventListener('visibilitychange', visibilityChanged);
  onCleanup(() => document.removeEventListener('visibilitychange', visibilityChanged));
  const available = () => visible() && appActive() && routeVisible();
  const delay = createMemo(() => available() ? intervalMs() : false);
  let loaded = false;
  createEffect(() => {
    const ms = delay();
    if (!available() || (loaded && ms === false)) return;
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
