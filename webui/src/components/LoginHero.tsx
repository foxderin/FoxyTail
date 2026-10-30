/* Login actions shown inside the dashboard connection card while the daemon
 * needs authorization. Secrets never leave this component's signals. */
import { createSignal, onCleanup, Show, type JSX } from 'solid-js';
import { refreshStatus } from '../state';
import { createApiScope, hasRoot, nativeControl } from '../api';
import { requestNative, onNativeEvent } from '../native';
import { t } from '../i18n';
import { copyWithToast } from '../clipboard';
import { MdIcon } from '../icons';
import { showToast, toastApiError } from './Toast';
import { Button, LinearProgress, TextField } from './ui';

export function LoginActions(): JSX.Element {
  const scope = createApiScope();
  let disposed = false;
  const [loginUrl, setLoginUrl] = createSignal<string | null>(null);
  const [waiting, setWaiting] = createSignal(false);
  const [showAuthkey, setShowAuthkey] = createSignal(false);
  const [authkey, setAuthkey] = createSignal('');
  const [authkeyBusy, setAuthkeyBusy] = createSignal(false);
  const canWrite = () => hasRoot && nativeControl().canWrite && !nativeControl().busy;
  const clear = () => { setAuthkey(''); setLoginUrl(null); };
  const stopLifecycle = onNativeEvent('lifecycle', event => { if (event.active === false) clear(); });
  onCleanup(() => { disposed = true; clear(); stopLifecycle(); });

  async function getLoginLink() {
    if (!canWrite() || waiting()) return;
    setWaiting(true);
    setLoginUrl(null);
    const res = await scope.api('login');
    setWaiting(false);
    if (res.cancelled || disposed) return;
    if (res.ok && typeof res.url === 'string') setLoginUrl(res.url);
    else if (res.ok && res.already) {
      showToast(t('acc_already'), 'ok');
      void refreshStatus({ afterCurrent: true });
    } else toastApiError(t('op_failed'), res);
  }

  async function loginWithAuthkey() {
    const key = authkey().trim();
    if (!canWrite() || !key || authkeyBusy()) return;
    setAuthkeyBusy(true);
    setAuthkey('');
    const res = await scope.api('login-authkey', key);
    setAuthkeyBusy(false);
    if (res.cancelled || disposed) return;
    if (res.ok) {
      showToast(t('acc_logged_in'), 'ok');
      void refreshStatus({ afterCurrent: true });
    } else toastApiError(t('op_failed'), res);
  }

  return (
    <div class="login-actions" data-testid="login-actions">
      <div class="service-actions-row">
        <Button busy={waiting()} disabled={!canWrite()} onClick={() => void getLoginLink()}>
          <MdIcon name="login" size={18} />{t('hero_get_link')}
        </Button>
        <Button variant="text" aria-expanded={showAuthkey()} onClick={() => setShowAuthkey(!showAuthkey())}>
          <MdIcon name="vpn_key" size={18} />{t('acc_authkey')}
        </Button>
      </div>
      <Show when={waiting()}>
        <div class="progress-row">
          <LinearProgress indeterminate />
          <span class="dim">{t('acc_waiting')}</span>
        </div>
      </Show>
      <Show when={loginUrl()}>
        {(url) => (
          <div class="login-url">
            <p class="dim">{t('acc_login_url_hint')}</p>
            <p class="mono">{url()}</p>
            <div class="btn-row">
              <Button variant="tonal" onClick={() => copyWithToast(url())}>
                <MdIcon name="content_copy" size={18} />{t('copy')}
              </Button>
              <Button variant="tonal" onClick={async () => {
                const result = await requestNative('app.openUrl', { url: url() });
                if (!result.ok) toastApiError(t('op_failed'), result);
              }}>
                <MdIcon name="open_in_new" size={18} />{t('open_browser')}
              </Button>
            </div>
          </div>
        )}
      </Show>
      <Show when={showAuthkey()}>
        <form class="login-authkey" onSubmit={(event) => { event.preventDefault(); void loginWithAuthkey(); }}>
          <TextField
            label={t('acc_authkey')}
            placeholder={t('acc_authkey_hint')}
            type="password"
            autocomplete="off"
            value={authkey()}
            onInput={(e: InputEvent) => setAuthkey((e.target as HTMLInputElement).value)}
          />
          <Button type="submit" variant="tonal" busy={authkeyBusy()} disabled={!authkey().trim() || !canWrite()}>
            <MdIcon name="vpn_key" size={18} />{t('acc_login_authkey')}
          </Button>
        </form>
      </Show>
    </div>
  );
}
