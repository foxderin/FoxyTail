/*
 * Account — login URL flow (copy / open), authkey login, Headscale custom
 * server, multi-account switch, logout with confirm.
 */
import { createSignal, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot } from '../api';
import { t } from '../i18n';
import { refreshStatus } from '../state';
import { Card, SkeletonRows } from '../components/Basics';
import { copyText } from '../components/LoginHero';
import { confirmDialog } from '../components/ConfirmDialog';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import type { AccountEntry } from '../types';
import { Button, LinearProgress, TextField } from '../components/ui';

export default function Account(): JSX.Element {
  const scope = createApiScope();
  const [loginUrl, setLoginUrl] = createSignal<string | null>(null);
  const [already, setAlready] = createSignal(false);
  const [waiting, setWaiting] = createSignal(false);
  const [authkey, setAuthkey] = createSignal('');
  const [authkeyBusy, setAuthkeyBusy] = createSignal(false);
  const [hsServer, setHsServer] = createSignal('');
  const [accounts, setAccounts] = createSignal<AccountEntry[] | null>(null);
  const [accountsDenied, setAccountsDenied] = createSignal(false);
  const [switching, setSwitching] = createSignal<string | null>(null);
  const [loggingOut, setLoggingOut] = createSignal(false);

  async function doLogin(extraArgs: string[] = []) {
    if (waiting()) return;
    setWaiting(true);
    setLoginUrl(null);
    setAlready(false);
    const res = await scope.api('login', ...extraArgs);
    setWaiting(false);
    if (res.cancelled) return;
    if (res.ok && typeof res.url === 'string') setLoginUrl(res.url);
    else if (res.ok && res.already) setAlready(true);
    else toastApiError(t('op_failed'), res);
  }

  async function loginAuthkey() {
    const key = authkey().trim();
    if (!key || authkeyBusy()) return;
    setAuthkeyBusy(true);
    const res = await scope.api('login-authkey', key);
    setAuthkeyBusy(false);
    if (res.cancelled) return;
    if (res.ok) {
      showToast(t('acc_logged_in'), 'ok');
      setAuthkey('');
      void loadAccounts();
      void refreshStatus();
    } else toastApiError(t('op_failed'), res);
  }

  function loginHeadscale() {
    const u = hsServer().trim();
    if (!/^https?:\/\//.test(u)) {
      showToast(t('acc_headscale_hint'), 'err');
      return;
    }
    void doLogin(['--login-server=' + u]);
  }

  async function loadAccounts() {
    const res = await scope.api('accounts');
    if (res.cancelled) return;
    if (res.ok) {
      setAccounts((res.accounts as AccountEntry[]) || []);
      setAccountsDenied(false);
    } else {
      setAccounts([]);
      setAccountsDenied(true);
    }
  }

  async function switchAccount(name: string) {
    if (switching()) return;
    setSwitching(name);
    const res = await scope.api('switch', name);
    setSwitching(null);
    if (res.cancelled) return;
    if (res.ok) {
      showToast(t('acc_switched'), 'ok');
      void loadAccounts();
    } else toastApiError(t('op_failed'), res);
  }

  async function doLogout() {
    if (loggingOut()) return;
    if (!(await confirmDialog(t('acc_logout_confirm')))) return;
    setLoggingOut(true);
    const res = await scope.api('logout');
    setLoggingOut(false);
    if (res.cancelled) return;
    if (res.ok) {
      showToast(t('acc_logged_out'), 'ok');
      void loadAccounts();
      void refreshStatus();
    } else toastApiError(t('op_failed'), res);
  }

  onMount(() => void loadAccounts());

  return (
    <>
      <Card title={t('acc_login')} icon="login">
        <Show when={waiting()}>
          <div class="progress-row">
            <LinearProgress indeterminate />
            <span class="dim">{t('acc_waiting')}</span>
          </div>
        </Show>
        <Show when={already()}>
          <div class="banner ok">
            <MdIcon name="check_circle" size={18} />
            <span>{t('acc_already')}</span>
          </div>
        </Show>
        <Show when={loginUrl()}>
          {(url) => (
            <>
              <p class="dim">{t('acc_login_url_hint')}</p>
              <p class="mono">{url()}</p>
              <div class="btn-row">
                <Button
                  variant="tonal"
                  onClick={() => {
                    if (copyText(url())) showToast(t('copied'), 'ok');
                    else showToast(t('op_failed'), 'err');
                  }}
                >
                  <MdIcon name="content_copy" size={18} /> {t('copy')}
                </Button>
                <Button variant="tonal" onClick={() => window.open(url(), '_blank')}>
                  <MdIcon name="open_in_new" size={18} /> {t('open_browser')}
                </Button>
              </div>
            </>
          )}
        </Show>
        <div class="btn-row">
          <Button variant="filled" disabled={waiting() || !hasRoot} onClick={() => void doLogin()}>
            <MdIcon name="login" size={18} /> {t('acc_login')}
          </Button>
        </div>
      </Card>

      <Card title={t('acc_authkey')} icon="vpn_key">
        <TextField
          label={t('acc_authkey')}
          placeholder={t('acc_authkey_hint')}
          type="password"
          value={authkey()}
          onInput={(e: InputEvent) => setAuthkey((e.target as HTMLInputElement).value)}
        />
        <Button
          variant="tonal"
          disabled={!authkey().trim() || authkeyBusy() || !hasRoot}
          onClick={() => void loginAuthkey()}
        >
          <MdIcon name="vpn_key" size={18} /> {t('acc_login_authkey')}
        </Button>
      </Card>

      <Card title={t('acc_headscale')} icon="dns">
        <TextField
          label={t('acc_headscale')}
          placeholder={t('acc_headscale_hint')}
          value={hsServer()}
          onInput={(e: InputEvent) => setHsServer((e.target as HTMLInputElement).value)}
        />
        <Button variant="tonal" disabled={waiting() || !hasRoot} onClick={loginHeadscale}>
          <MdIcon name="login" size={18} /> {t('acc_login_server')}
        </Button>
      </Card>

      <Card title={t('acc_accounts')} icon="person">
        <Show when={accounts() !== null} fallback={<SkeletonRows rows={2} />}>
          <Show
            when={!accountsDenied()}
            fallback={<EmptyStateInline text={t('acc_not_logged_in')} />}
          >
            {accounts()!.map((a) => (
              <div class="list-row">
                <div class="main">
                  <div class="title">
                    {a.name}
                    <Show when={a.current}>
                      <span class="badge">{t('acc_current_badge')}</span>
                    </Show>
                  </div>
                </div>
                <Button
                  variant="outlined"
                  disabled={a.current || switching() !== null || !hasRoot}
                  onClick={() => void switchAccount(a.name)}
                >
                  {t('acc_switch')}
                </Button>
              </div>
            ))}
          </Show>
        </Show>
        <div class="btn-row">
          <Button
            variant="filled"
            class="danger"
            disabled={accountsDenied() || loggingOut() || !hasRoot}
            onClick={() => void doLogout()}
          >
            <MdIcon name="logout" size={18} /> {t('acc_logout')}
          </Button>
        </div>
      </Card>
    </>
  );
}

function EmptyStateInline(props: { text: string }): JSX.Element {
  return (
    <div class="state-box">
      <MdIcon name="info" size={20} class="dim" />
      <span class="grow">{props.text}</span>
    </div>
  );
}
