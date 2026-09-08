/*
 * LoginHero — the prominent-but-non-blocking login/start card on top of the
 * Dashboard whenever the backend is not Running. Dismissible to a thin
 * banner (sessionStorage, per session, keyed by connection state so a state
 * change re-surfaces the hero). Every other page stays fully usable.
 */
import { createSignal, Show, type JSX } from 'solid-js';
import { status, connState, refreshStatus, type ConnState } from '../state';
import { createApiScope, hasRoot } from '../api';
import { t } from '../i18n';
import { MdIcon } from '../icons';
import { showToast, toastApiError } from './Toast';

const DISMISS_KEY = 'foxy.heroDismissed';

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function copyText(text: string): boolean {
  /* navigator.clipboard requires a secure context and is unavailable on
   * file:// WebUI pages; the legacy execCommand path is the one that works
   * in KSU/MMRL WebViews. */
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function LoginHero(): JSX.Element {
  const scope = createApiScope();
  const cs = (): ConnState => connState(status());
  const [dismissed, setDismissed] = createSignal<string | null>(readDismissed());

  const heroState = (): 'login' | 'stopped' | null => {
    const c = cs();
    if (c === 'needs-login' || c === 'starting') return 'login';
    if (c === 'stopped') return 'stopped';
    return null;
  };

  const [loginUrl, setLoginUrl] = createSignal<string | null>(null);
  const [waiting, setWaiting] = createSignal(false);
  const [showAuthkey, setShowAuthkey] = createSignal(false);
  const [authkey, setAuthkey] = createSignal('');
  const [authkeyBusy, setAuthkeyBusy] = createSignal(false);
  const [startBusy, setStartBusy] = createSignal(false);

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
    if (waiting()) return;
    setWaiting(true);
    setLoginUrl(null);
    const res = await scope.api('login');
    setWaiting(false);
    if (res.cancelled) return;
    if (res.ok && typeof res.url === 'string') setLoginUrl(res.url);
    else if (res.ok && res.already) {
      showToast(t('acc_already'), 'ok');
      void refreshStatus();
    } else toastApiError(t('op_failed'), res);
  }

  async function loginWithAuthkey() {
    const key = authkey().trim();
    if (!key || authkeyBusy()) return;
    setAuthkeyBusy(true);
    const res = await scope.api('login-authkey', key);
    setAuthkeyBusy(false);
    if (res.cancelled) return;
    if (res.ok) {
      showToast(t('acc_logged_in'), 'ok');
      setAuthkey('');
      void refreshStatus();
    } else toastApiError(t('op_failed'), res);
  }

  async function startService() {
    if (startBusy()) return;
    setStartBusy(true);
    const res = await scope.api('control', 'start');
    setStartBusy(false);
    if (res.cancelled) return;
    if (res.ok) showToast(t('dash_action_done'), 'ok');
    else toastApiError(t('op_failed'), res);
    setTimeout(() => void refreshStatus(), 1500);
  }

  return (
    <Show when={heroState()}>
      {(st) => (
        <Show
          when={dismissed() !== st()}
          fallback={
            <div class="banner info">
              <MdIcon name={st() === 'stopped' ? 'stop' : 'login'} size={18} />
              <span class="spacer">
                {st() === 'stopped' ? t('hero_banner_stopped') : t('hero_banner_login')}
              </span>
              <md-text-button onClick={expand}>{t('hero_expand')}</md-text-button>
            </div>
          }
        >
          <div class="hero-wrap">
            <div class="hero">
              <md-icon-button class="hero-close" onClick={dismiss} aria-label={t('hero_minimize')}>
                <MdIcon name="close" size={20} />
              </md-icon-button>
              <h2>{st() === 'stopped' ? t('hero_stopped_title') : t('hero_login_title')}</h2>
              <p>{st() === 'stopped' ? t('hero_stopped_desc') : t('hero_login_desc')}</p>

              <Show when={st() === 'stopped'}>
                <div class="hero-actions">
                  <md-filled-button disabled={startBusy() || !hasRoot || undefined} onClick={startService}>
                    <MdIcon name="play_arrow" size={18} /> {t('hero_start_service')}
                  </md-filled-button>
                  <Show when={startBusy()}>
                    <md-circular-progress indeterminate style={{ width: '28px', height: '28px' }} />
                  </Show>
                </div>
              </Show>

              <Show when={st() === 'login'}>
                <div class="hero-actions">
                  <md-filled-button disabled={waiting() || !hasRoot || undefined} onClick={getLoginLink}>
                    <MdIcon name="login" size={18} /> {t('hero_get_link')}
                  </md-filled-button>
                  <md-text-button onClick={() => setShowAuthkey(!showAuthkey())}>
                    <MdIcon name="vpn_key" size={18} /> {t('acc_authkey')}
                  </md-text-button>
                </div>
                <Show when={waiting()}>
                  <div class="progress-row">
                    <md-linear-progress indeterminate />
                    <span class="dim">{t('acc_waiting')}</span>
                  </div>
                </Show>
                <Show when={loginUrl()}>
                  {(url) => (
                    <div class="mt">
                      <p class="dim">{t('acc_login_url_hint')}</p>
                      <p class="mono">{url()}</p>
                      <div class="btn-row">
                        <md-filled-tonal-button
                          onClick={() => {
                            if (copyText(url())) showToast(t('copied'), 'ok');
                            else showToast(t('op_failed'), 'err');
                          }}
                        >
                          <MdIcon name="content_copy" size={18} /> {t('copy')}
                        </md-filled-tonal-button>
                        <md-filled-tonal-button onClick={() => window.open(url(), '_blank')}>
                          <MdIcon name="open_in_new" size={18} /> {t('open_browser')}
                        </md-filled-tonal-button>
                      </div>
                    </div>
                  )}
                </Show>
                <Show when={showAuthkey()}>
                  <div class="mt">
                    <label class="field">
                      <md-outlined-text-field
                        label={t('acc_authkey')}
                        placeholder={t('acc_authkey_hint')}
                        type="password"
                        value={authkey()}
                        onInput={(e: InputEvent) =>
                          setAuthkey((e.target as HTMLInputElement).value)
                        }
                      />
                    </label>
                    <md-filled-tonal-button
                      disabled={!authkey().trim() || authkeyBusy() || !hasRoot || undefined}
                      onClick={loginWithAuthkey}
                    >
                      <MdIcon name="vpn_key" size={18} /> {t('acc_login_authkey')}
                    </md-filled-tonal-button>
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
