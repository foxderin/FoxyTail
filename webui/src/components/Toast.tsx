/* Global toast service + host component. */
import { createSignal, For, type JSX } from 'solid-js';

export type ToastKind = 'ok' | 'err' | 'info';

interface ToastItem {
  id: number;
  msg: string;
  kind: ToastKind;
}

const [toasts, setToasts] = createSignal<ToastItem[]>([]);
let nextId = 0;

export function showToast(msg: string, kind: ToastKind = 'info'): void {
  const id = nextId++;
  setToasts((list) => [...list, { id, msg, kind }]);
  setTimeout(() => {
    setToasts((list) => list.filter((it) => it.id !== id));
  }, 3200);
}

/* Toast helper for API failures; cancellation gets its own quiet message. */
export function toastApiError(prefix: string, res: { error?: string; cancelled?: unknown }): void {
  if (res.cancelled) {
    showToast(prefix, 'info');
    return;
  }
  showToast(prefix + (res.error ? ': ' + res.error : ''), 'err');
}

export function ToastRoot(): JSX.Element {
  return (
    <div id="toast-root" aria-live="assertive">
      <For each={toasts()}>
        {(it) => <div class={'toast' + (it.kind === 'err' ? ' err' : '')}>{it.msg}</div>}
      </For>
    </div>
  );
}
