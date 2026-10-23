/*
 * LoginHero — the prominent-but-non-blocking login/start card on top of the
 * Dashboard when login is required or the daemon is stopped. Dismissible to a thin
 * banner (sessionStorage, per session, keyed by connection state so a state
 * change re-surfaces the hero). Every other page stays fully usable.
 */
import { createSignal, onCleanup, Show, type JSX } from 'solid-js';
import {
  status,
  statusError,
  statusLoading,
  connState,
  refreshStatus,
  type ConnState,
} from '../state';
import { createApiScope, hasRoot, nativeControl } from '../api';
import { requestNative } from '../native';
import { LOGIN_REFRESH_DELAY_MS } from '../config';
import { t } from '../i18n';
import { copyWithToast } from '../clipboard';
import { MdIcon } from '../icons';
import { showToast, toastApiError } from './Toast';
import {
  Button,
  CircularProgress,
  IconButton,
  LinearProgress,
  TextField,
} from './ui';

const DISMISS_KEY = 'foxy.heroDismissed';

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function LoginHero(props: { showStopped?: boolean } = {}): JSX.Element {
  const scope = createApiScope();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    clearTimeout(refreshTimer);
  });
  const cs = (): ConnState => connState(status());
  const [dismissed, setDismissed] = createSignal<string | null>(
    readDismissed(),
  );

  const heroState = (): 'login' | 'stopped' | null => {
    if (statusLoading() || statusError()) return null;
    const c = cs();
    if (c === 'needs-login') return 'login';
    if (c === 'stopped' && props.showStopped !== false) return 'stopped';
    return null;
  };

  const [loginUrl, setLoginUrl] = createSignal<string | null>(null);
  const [waiting, setWaiting] = createSignal(false);
  const [showAuthkey, setShowAuthkey] = createSignal(false);
  const [authkey, setAuthkey] = createSignal('');
  const [authkeyBusy, setAuthkeyBusy] = createSignal(false);
  const [startBusy, setStartBusy] = createSignal(false);
  const canWrite = () => hasRoot && nativeControl().canWrite && !nativeControl().busy;
  onCleanup(() => { setAuthkey(''); setLoginUrl(null); });

  const dismiss = () => {
    const st = heroState();
    try {
      if (st) sessionStorage.setItem(DISMISS_KEY, st);
    } catch {
      /* ignore */
    }
    setDismissed(st);
  };
  const expand = () => {
    try {
      sessionStorage.removeItem(DISMISS_KEY);
    } catch {
      /* ignore */
    }
    setDismissed(null);
  };

  async function getLoginLink() {
    if (!canWrite() || waiting() || heroState() !== 'login') return;
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
    if (!canWrite() || !key || authkeyBusy() || heroState() !== 'login') return;
    setAuthkeyBusy(true);
    setAuthkey('');
    const res = await scope.api('login-authkey', key);
    setAuthkeyBusy(false);
    if (res.cancelled || disposed) return;
    if (res.ok) {
      showToast(t('acc_logged_in'), 'ok');
      setAuthkey('');
      void refreshStatus({ afterCurrent: true });
    } else toastApiError(t('op_failed'), res);
  }

  async function startService() {
    if (!canWrite() || startBusy()) return;
    setStartBusy(true);
    const res = await scope.api('control', 'start');
    setStartBusy(false);
    if (res.cancelled || disposed) return;
    if (res.ok) showToast(t('dash_action_done'), 'ok');
    else toastApiError(t('op_failed'), res);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refreshStatus({ afterCurrent: true }), LOGIN_REFRESH_DELAY_MS);
  }

  return (
    <Show when={heroState()}>
      {(st) => (
        <Show
          when={dismissed() !== st()}
          fallback={
            <div class="banner info" data-testid="login-hero" data-hero-state={st()}>
              <MdIcon name={st() === 'stopped' ? 'stop' : 'login'} size={18} />
              <span class="spacer">
                {st() === 'stopped'
                  ? t('hero_banner_stopped')
                  : t('hero_banner_login')}
              </span>
              <Button variant="text" onClick={expand}>
                {t('hero_expand')}
              </Button>
            </div>
          }
        >
          <div class="hero-wrap" data-testid="login-hero" data-hero-state={st()}>
            <div class="hero">
              <IconButton
                class="hero-close"
                onClick={dismiss}
                aria-label={t('hero_minimize')}
              >
                <MdIcon name="close" size={20} />
              </IconButton>
              <div class="network-login-heading">
                <div class="network-device-avatar">
                  <MdIcon
                    name={st() === 'stopped' ? 'play_arrow' : 'vpn_key'}
                    size={24}
                  />
                </div>
                <span class="eyebrow">{t('net_login_secure')}</span>
              </div>
              <h2>
                {st() === 'stopped'
                  ? t('hero_stopped_title')
                  : t('hero_login_title')}
              </h2>
              <p>
                {st() === 'stopped'
                  ? t('hero_stopped_desc')
                  : t('hero_login_desc')}
              </p>

              <Show when={st() === 'stopped'}>
                <div class="hero-actions">
                  <Button
                    variant="filled"
                    busy={startBusy()}
                    disabled={!canWrite()}
                    onClick={startService}
                  >
                    <MdIcon name="play_arrow" size={18} />{' '}
                    {t('hero_start_service')}
                  </Button>
                  <Show when={startBusy()}>
                    <CircularProgress size={28} />
                  </Show>
                </div>
              </Show>

              <Show when={st() === 'login'}>
                <div class="hero-actions">
                  <Button
                    variant="filled"
                    busy={waiting()}
                    disabled={!canWrite()}
                    onClick={getLoginLink}
                  >
                    <MdIcon name="login" size={18} /> {t('hero_get_link')}
                  </Button>
                  <Button
                    variant="text"
                    onClick={() => setShowAuthkey(!showAuthkey())}
                  >
                    <MdIcon name="vpn_key" size={18} /> {t('acc_authkey')}
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
                    <div class="mt">
                      <p class="dim">{t('acc_login_url_hint')}</p>
                      <p class="mono">{url()}</p>
                      <div class="btn-row">
                        <Button
                          variant="tonal"
                          onClick={() => copyWithToast(url())}
                        >
                          <MdIcon name="content_copy" size={18} /> {t('copy')}
                        </Button>
                        <Button
                          variant="tonal"
                          onClick={async () => {
                            const result = await requestNative('app.openUrl', { url: url() });
                            if (!result.ok) toastApiError(t('op_failed'), result);
                          }}
                        >
                          <MdIcon name="open_in_new" size={18} />{' '}
                          {t('open_browser')}
                        </Button>
                      </div>
                    </div>
                  )}
                </Show>
                <Show when={showAuthkey()}>
                  <div class="mt">
                    <TextField
                      label={t('acc_authkey')}
                      placeholder={t('acc_authkey_hint')}
                      type="password"
                      autocomplete="off"
                      value={authkey()}
                      onInput={(e: InputEvent) =>
                        setAuthkey((e.target as HTMLInputElement).value)
                      }
                    />
                    <Button
                      variant="tonal"
                      busy={authkeyBusy()}
                      disabled={!authkey().trim() || !canWrite()}
                      onClick={loginWithAuthkey}
                    >
                      <MdIcon name="vpn_key" size={18} />{' '}
                      {t('acc_login_authkey')}
                    </Button>
                  </div>
                </Show>
              </Show>
            </div>
          </div>
        </Show>
      )}
    </Show>
  );
}
