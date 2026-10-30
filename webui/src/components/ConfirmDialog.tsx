/* Promise-based confirm dialog. */
import { createSignal, Show, type JSX } from 'solid-js';
import { t } from '../i18n';
import { Button, Dialog } from './ui';

export interface ConfirmOptions {
  title?: string;
  body?: string;
  confirmLabel?: string;
  tone?: 'default' | 'danger';
}

const [request, setRequest] = createSignal<ConfirmOptions | null>(null);
let resolver: ((ok: boolean) => void) | null = null;

export function confirmDialog(input: string | ConfirmOptions): Promise<boolean> {
  if (resolver) settle(false);
  setRequest(typeof input === 'string' ? { body: input } : input);
  return new Promise<boolean>((resolve) => {
    resolver = resolve;
  });
}

function settle(ok: boolean): void {
  setRequest(null);
  const r = resolver;
  resolver = null;
  if (r) r(ok);
}

export function ConfirmHost(): JSX.Element {
  return (
    <Show when={request()}>
      {(value) => (
        <Dialog
          open
          headline={value().title ?? t('confirm_title')}
          onClose={() => settle(false)}
          actions={<>
            <Button variant="outlined" autofocus data-dialog-action="cancel" onClick={() => settle(false)}>{t('cancel')}</Button>
            <Button variant="filled" class={value().tone === 'danger' ? 'danger' : undefined} data-dialog-action="confirm" onClick={() => settle(true)}>
              {value().confirmLabel ?? t('confirm')}
            </Button>
          </>}
        >
          <Show when={value().body}><p class="md-dialog-body">{value().body}</p></Show>
        </Dialog>
      )}
    </Show>
  );
}
