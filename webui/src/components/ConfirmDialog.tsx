/* Promise-based confirm dialog. */
import { createSignal, Show, type JSX } from 'solid-js';
import { t } from '../i18n';
import { Button, Dialog } from './ui';

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
      <Dialog
        open
        headline={t('confirm_title')}
        onClose={() => settle(false)}
      >
        {message()}
        <div class="md-dialog-actions">
          <Button variant="text" onClick={() => settle(false)}>{t('cancel')}</Button>
          <Button variant="filled" onClick={() => settle(true)}>{t('confirm')}</Button>
        </div>
      </Dialog>
    </Show>
  );
}
