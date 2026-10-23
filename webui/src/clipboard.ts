import { t } from './i18n';
import { requestNative } from './native';
import { showToast, type ToastKind } from './components/Toast';

export async function copyText(text: string): Promise<boolean> {
  return (await requestNative('app.copy', { text })).ok;
}
export function copyWithToast(text: string, kind?: ToastKind): void {
  void copyText(text).then(copied => {
    showToast(t(copied ? 'copied' : 'op_failed'), kind ?? (copied ? 'ok' : 'err'));
  });
}
