/*
 * Account — login URL flow (copy / open), authkey login, Headscale custom
 * server, multi-account switch, logout with confirm.
 */
import { createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot } from '../api';
import { t } from '../i18n';
import './tools.css';
import { createQueuedRefresh } from './tools-refresh';
import { refreshStatus } from '../state';
import { Card, SkeletonRows, EmptyState, StatusBadge } from '../components/Basics';
import { LoadGate } from '../components/LoadGate';
import { copyWithToast } from '../clipboard';
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
  const [accountsError, setAccountsError] = createSignal<string | null>(null);
  const [accountsLoading, setAccountsLoading] = createSignal(false);
  const [switching, setSwitching] = createSignal<string | null>(null);
  const [loggingOut, setLoggingOut] = createSignal(false);
  const actionBusy = () => waiting() || authkeyBusy() || switching() !== null || loggingOut();

  async function doLogin(extraArgs: string[] = []) {
    if (actionBusy()) return;
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
    if (!key || actionBusy()) return;
    setAuthkeyBusy(true);
    const res = await scope.api('login-authkey', key);
    setAuthkeyBusy(false);
    if (res.cancelled) return;
    if (res.ok) {
      showToast(t('acc_logged_in'), 'ok');
      setAuthkey('');
      void loadAccounts();
      void refreshStatus({ afterCurrent: true });
    } else toastApiError(t('op_failed'), res);
  }

  function loginHeadscale() {
    const u = hsServer().trim();
    try {
      if (!['http:', 'https:'].includes(new URL(u).protocol)) throw new Error();
    } catch {
      showToast(t('tools_server_invalid'), 'err');
      return;
    }
    void doLogin(['--login-server=' + u]);
  }

  const loadAccounts = createQueuedRefresh(
    () => scope.api('accounts'),
    (res) => {
      if (res.ok) {
        setAccounts((res.accounts as AccountEntry[]) || []);
        setAccountsError(null);
      } else {
        setAccounts([]);
        setAccountsError(res.error || t('error'));
      }
    },
    setAccountsLoading,
  );

  async function switchAccount(name: string) {
    if (actionBusy()) return;
    setSwitching(name);
    const res = await scope.api('switch', name);
    setSwitching(null);
    if (res.cancelled) return;
    if (res.ok) {
      showToast(t('acc_switched'), 'ok');
      void loadAccounts();
      void refreshStatus({ afterCurrent: true });
    } else toastApiError(t('op_failed'), res);
  }

  async function doLogout() {
    if (actionBusy()) return;
    if (!(await confirmDialog(t('acc_logout_confirm')))) return;
    setLoggingOut(true);
    const res = await scope.api('logout');
    setLoggingOut(false);
    if (res.cancelled) return;
    if (res.ok) {
      showToast(t('acc_logged_out'), 'ok');
      void loadAccounts();
      void refreshStatus({ afterCurrent: true });
    } else toastApiError(t('op_failed'), res);
  }

  onMount(() => void loadAccounts());

  return (
    <div class="tools-page">
      <Card
        title={t('acc_accounts')}
        icon="person"
        description={t('tools_account_list_desc')}
        actions={
          <Button variant="text" busy={accountsLoading()} onClick={() => void loadAccounts()}>
            <MdIcon name="refresh" size={18} />
            {t('tools_refresh')}
          </Button>
        }
      >
        <LoadGate
          ready={accounts() !== null}
          error={accountsError()}
          onRetry={() => void loadAccounts()}
          skeleton={<SkeletonRows rows={3} />}
          hasContent={(accounts()?.length ?? 0) > 0}
          empty={<EmptyState text={t('acc_not_logged_in')} icon="person" />}
        >
              <For each={accounts()!}>
                {(account) => (
                  <div class="list-row tool-row-wrap">
                    <span class="tool-link-icon">
                      <MdIcon name="person" size={20} />
                    </span>
                    <div class="main">
                      <div class="title">{account.label || account.name}</div>
                      <Show when={account.current}>
                        <StatusBadge tone="success">{t('acc_current_badge')}</StatusBadge>
                      </Show>
                    </div>
                    <Button
                      variant="outlined"
                      busy={switching() === account.name}
                      disabled={account.current || actionBusy() || !hasRoot}
                      onClick={() => void switchAccount(account.name)}
                    >
                      {t('acc_switch')}
                    </Button>
                  </div>
                )}
              </For>
        </LoadGate>
      </Card>
      <Card title={t('acc_login')} icon="login">
        <Show when={waiting()}>
          <div class="progress-row">
            <LinearProgress indeterminate />
            <span class="dim">{t('acc_waiting')}</span>
          </div>
        </Show>
        <Show when={already()}>
          <div class="tool-result">
            <StatusBadge tone="success">{t('acc_already')}</StatusBadge>
          </div>
        </Show>
        <Show when={loginUrl()}>
          {(url) => (
            <div class="tool-result" role="status">
              <p class="mono">{url()}</p>
              <div class="tool-actions">
                <Button
                  variant="tonal"
                  onClick={() => copyWithToast(url(), 'info')}
                >
                  <MdIcon name="content_copy" size={18} />
                  {t('copy')}
                </Button>
                <Button onClick={() => window.open(url(), '_blank', 'noopener,noreferrer')}>
                  <MdIcon name="open_in_new" size={18} />
                  {t('open_browser')}
                </Button>
              </div>
            </div>
          )}
        </Show>
        <div class="tool-actions">
          <Button busy={waiting()} disabled={actionBusy() || !hasRoot} onClick={() => void doLogin()}>
            <MdIcon name="login" size={18} />
            {t('acc_login')}
          </Button>
        </div>
      </Card>
      <details class="tool-disclosure">
        <summary>
          <MdIcon name="vpn_key" size={18} /> {t('tools_advanced_login')}
        </summary>
        <div class="tool-disclosure-body">
          <Card title={t('acc_authkey')} icon="vpn_key">
            <div class="tool-form">
              <TextField
                label={t('acc_authkey')}
                placeholder={t('acc_authkey_hint')}
                type="password"
                value={authkey()}
                disabled={actionBusy()}
                onInput={(e) => setAuthkey((e.target as HTMLInputElement).value)}
              />
              <div>
                <Button
                  variant="tonal"
                  busy={authkeyBusy()}
                  disabled={!authkey().trim() || actionBusy() || !hasRoot}
                  onClick={() => void loginAuthkey()}
                >
                  <MdIcon name="vpn_key" size={18} />
                  {t('acc_login_authkey')}
                </Button>
              </div>
            </div>
          </Card>
          <Card title={t('acc_headscale')} icon="dns">
            <div class="tool-form">
              <TextField
                label={t('acc_headscale')}
                placeholder={t('acc_headscale_hint')}
                value={hsServer()}
                type="url"
                disabled={actionBusy()}
                onInput={(e) => setHsServer((e.target as HTMLInputElement).value)}
              />
              <div>
                <Button
                  variant="tonal"
                  disabled={!hsServer().trim() || actionBusy() || !hasRoot}
                  onClick={loginHeadscale}
                >
                  <MdIcon name="login" size={18} />
                  {t('acc_login_server')}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </details>
      <Show when={accounts()?.some((account) => account.current)}>
        <section class="tool-danger">
          <h2>
            <MdIcon name="logout" size={18} /> {t('acc_logout')}
          </h2>
          <p class="tool-hint">{t('tools_logout_desc')}</p>
          <div>
            <Button
              variant="outlined"
              class="danger"
              busy={loggingOut()}
              disabled={actionBusy() || !hasRoot}
              onClick={() => void doLogout()}
            >
              {t('acc_logout')}
            </Button>
          </div>
        </section>
      </Show>
    </div>
  );
}
