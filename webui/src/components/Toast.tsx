/* Global toast service + host component. */
import { createSignal, For, Show, type JSX } from 'solid-js';
import { MdIcon } from '../icons';
import { t } from '../i18n';
import { requestNative } from '../native';

export type ToastKind = 'ok' | 'err' | 'info';

interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastItem {
  id: number;
  msg: string;
  kind: ToastKind;
  action?: ToastAction;
}

const [toasts, setToasts] = createSignal<ToastItem[]>([]);
let nextId = 0;

function dismiss(id: number): void {
  setToasts((list) => list.filter((it) => it.id !== id));
}

export function showToast(msg: string, kind: ToastKind = 'info', action?: ToastAction): void {
  const id = nextId++;
  setToasts((list) => {
    const next = [...list, { id, msg, kind, action }];
    return next.length > 4 ? next.slice(next.length - 4) : next;
  });
  if (kind !== 'err') setTimeout(() => dismiss(id), action ? 6000 : 3200);
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
        {(it) => (
          <div class={'toast ' + it.kind} role={it.kind === 'err' ? 'alert' : 'status'}>
            <MdIcon name={it.kind === 'err' ? 'error' : it.kind === 'ok' ? 'check_circle' : 'info'} size={18} />
            <span class="toast-message">{it.msg}</span>
            <Show when={it.action}>
              {(action) => <button type="button" class="toast-action" onClick={() => { dismiss(it.id); action().run(); }}>{action().label}</button>}
            </Show>
            <Show when={it.kind === 'err'}>
              <button type="button" class="toast-icon" aria-label={t('copy')} title={t('copy')} onClick={() => void requestNative('app.copy', { text: it.msg })}>
                <MdIcon name="content_copy" size={16} />
              </button>
              <button type="button" class="toast-icon" aria-label={t('close')} title={t('close')} onClick={() => dismiss(it.id)}>
                <MdIcon name="close" size={16} />
              </button>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
