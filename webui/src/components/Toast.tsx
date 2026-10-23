/* Global toast service + host component. */
import { createSignal, For, type JSX } from 'solid-js';
import { MdIcon } from '../icons';

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
  setToasts((list) => {
    const next = [...list, { id, msg, kind }];
    return next.length > 4 ? next.slice(next.length - 4) : next;
  });
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
    <div id="toast-root" aria-live="polite" aria-relevant="additions">
      <For each={toasts()}>
        {(it) => <div class={'toast ' + it.kind} role={it.kind === 'err' ? 'alert' : 'status'}><MdIcon name={it.kind === 'err' ? 'error' : it.kind === 'ok' ? 'check_circle' : 'info'} size={18} /><span>{it.msg}</span></div>}
      </For>
    </div>
  );
}
