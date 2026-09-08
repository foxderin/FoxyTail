/* Promise-based confirm dialog on top of md-dialog. */
import { createSignal, Show, type JSX } from 'solid-js';
import { t } from '../i18n';

const [message, setMessage] = createSignal<string | null>(null);
let resolver: ((ok: boolean) => void) | null = null;

export function confirmDialog(msg: string): Promise<boolean> {
  setMessage(msg);
  return new Promise<boolean>((resolve) => {
    resolver = resolve;
  });
}

function settle(ok: boolean): void {
  setMessage(null);
  const r = resolver;
  resolver = null;
  if (r) r(ok);
}

export function ConfirmHost(): JSX.Element {
  return (
    <Show when={message() !== null}>
      <md-dialog open on:closed={() => settle(false)}>
        <div slot="headline">{t('confirm_title')}</div>
        <div slot="content">{message()}</div>
        <div slot="actions">
          <md-text-button onClick={() => settle(false)}>{t('cancel')}</md-text-button>
          <md-filled-button onClick={() => settle(true)}>{t('confirm')}</md-filled-button>
        </div>
      </md-dialog>
    </Show>
  );
}
