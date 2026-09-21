/* Clipboard access shared by every copy button, plus the toast they all show.
 * Lives outside the components so no page has to import the login hero. */
import { t } from './i18n';
import { showToast, type ToastKind } from './components/Toast';

export function copyText(text: string): boolean {
  /* navigator.clipboard requires a secure context and is unavailable on
   * file:// WebUI pages; the legacy execCommand path is the one that works
   * in KSU/MMRL WebViews. */
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const ta = document.createElement('textarea');
  try {
    ta.value = text;
    ta.readOnly = true;
    ta.tabIndex = -1;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
}

/* Copy and report the outcome. Without a kind, a successful copy toasts 'ok'
 * and a failure 'err'; callers that pass a kind use it for both outcomes. */
export function copyWithToast(text: string, kind?: ToastKind): void {
  const copied = copyText(text);
  showToast(t(copied ? 'copied' : 'op_failed'), kind ?? (copied ? 'ok' : 'err'));
}
