/*
 * Account — login URL flow (copy / open), authkey login, Headscale custom
 * server, multi-account switch, logout with confirm.
 */
import { createEffect, createSignal, For, on, onCleanup, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot, nativeControl } from '../api';
import { t } from '../i18n';
import './tools.css';
import { createQueuedRefresh } from './tools-refresh';
import { refreshStatus, invalidateAccountState } from '../state';
import { Card, SkeletonRows, EmptyState, StatusBadge } from '../components/Basics';
import { LoadGate } from '../components/LoadGate';
import { copyWithToast } from '../clipboard';
import { confirmDialog, type ConfirmOptions } from '../components/ConfirmDialog';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import type { AccountEntry } from '../types';
import { Button, LinearProgress, TextField } from '../components/ui';
import AccountDetails from './AccountDetails';
import AccountIdentity from './AccountIdentity';
import { requestNative, onNativeEvent } from '../native';

export default function Account(): JSX.Element {
  const scope = createApiScope();
  let disposed = false;
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
  const [checking, setChecking] = createSignal(false);
  const [nickname, setNickname] = createSignal('');
  const [renaming, setRenaming] = createSignal(false);
  const currentAccount = () => accounts()?.find(account => account.current);
  createEffect(() => { setNickname(currentAccount()?.label || ''); });
  const actionBusy = () => disposed || renaming() || checking() || waiting() || authkeyBusy() || switching() !== null || loggingOut() || !nativeControl().canWrite || nativeControl().busy;
  async function preflight(confirm: ConfirmOptions) {
    if (actionBusy() || !await confirmDialog({ body: t('tools_network_warning'), ...confirm })) return false;
    if (actionBusy()) return false;
    setChecking(true);
    const result = await scope.api('file-send-history');
    setChecking(false);
    const rows = result.transfers;
    if (!result.ok || !Array.isArray(rows) || rows.some(row => !row || !['completed', 'failed', 'cancelled', 'interrupted', 'queued', 'sending'].includes(row.status))) {
      if (!result.cancelled) toastApiError(t('op_failed'), { error: result.error || t('net_unknown') });
      return false;
    }
    if (rows.some(row => ['queued', 'sending'].includes(row.status))) { showToast(t('tools_transfer_active'), 'err'); return false; }
    return nativeControl().canWrite && !nativeControl().busy;
  }
  const clearSecrets = () => { setAuthkey(''); setLoginUrl(null); };
  const stopNavigation = onNativeEvent('navigate', clearSecrets);
  const stopLifecycle = onNativeEvent('lifecycle', event => { if (event.active === false) clearSecrets(); });
  const onHash = () => { if (location.hash !== '#/account') clearSecrets(); };
  window.addEventListener('hashchange', onHash);
  onCleanup(() => { disposed = true; clearSecrets(); stopNavigation(); stopLifecycle(); window.removeEventListener('hashchange', onHash); });

  async function doLogin(extraArgs: string[] = []) {
    if (!await preflight({ title: t('confirm_login_title'), confirmLabel: t('acc_login') })) return;
    setWaiting(true);
    setLoginUrl(null);
    setAlready(false);
    const res = await scope.api('login', ...extraArgs);
    invalidateAccountState();
    setWaiting(false);
    if (res.cancelled) return;
    if (res.ok && typeof res.url === 'string') setLoginUrl(res.url);
    else if (res.ok && res.already) setAlready(true);
    else toastApiError(t('op_failed'), res);
  }

  async function loginAuthkey() {
    const key = authkey().trim();
    if (!key || !await preflight({ title: t('confirm_login_title'), confirmLabel: t('acc_login_authkey') })) return;
    setAuthkey('');
    setAuthkeyBusy(true);
    const res = await scope.api('login-authkey', key);
    invalidateAccountState();
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
      const url = new URL(u);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[\x00-\x20\x7f]/.test(u)) throw new Error();
    } catch {
      showToast(t('tools_server_invalid'), 'err');
      return;
    }
    void doLogin(['--login-server=' + u]);
  }

  const loadAccounts = createQueuedRefresh(
    () => scope.api('accounts'),
    (res) => {
      if (res.ok && Array.isArray(res.accounts) && res.accounts.every(account => account &&
          typeof account.name === 'string' && typeof account.current === 'boolean' &&
          (account.id === undefined || typeof account.id === 'string') && (account.tailnet === undefined || typeof account.tailnet === 'string'))) {
        setAccounts((res.accounts as AccountEntry[]) || []);
        setAccountsError(null);
      } else {
        setAccounts([]);
        setAccountsError(res.error || t('error'));
      }
    },
    setAccountsLoading,
  );

  async function renameAccount() {
    const current = currentAccount(), name = nickname().trim();
    if (!current || actionBusy() || !name || name.length > 128 || /[\r\n\x00-\x1f\x7f\u2028\u2029]/.test(name)) return;
    if (!await confirmDialog({title:t('acc_rename'), body:t('acc_rename_hint') + '\n' + name, confirmLabel:t('save')})) return;
    if (actionBusy() || current !== currentAccount() || name !== nickname().trim()) return;
    setRenaming(true);
    const result = await scope.api('account-rename', current.id || current.name, name);
    setRenaming(false);
    if (result.ok) await loadAccounts();
    else if (!result.cancelled) toastApiError(t('op_failed'), result);
  }

  async function switchAccount(name: string) {
    if (!await preflight({ title: t('confirm_switch_title'), body: t('tools_account_list_desc'), confirmLabel: t('acc_switch') })) return;
    setLoginUrl(null);
    setSwitching(name);
    const res = await scope.api('switch', name);
    invalidateAccountState();
    setSwitching(null);
    if (res.cancelled) return;
    if (res.ok) {
      showToast(t('acc_switched'), 'ok');
      void loadAccounts();
      void refreshStatus({ afterCurrent: true });
    } else toastApiError(t('op_failed'), res);
  }

  async function doLogout() {
    if (!await preflight({ title: t('confirm_logout_title'), body: t('tools_logout_desc'), confirmLabel: t('acc_logout'), tone: 'danger' })) return;
    setLoginUrl(null);
    setLoggingOut(true);
    const res = await scope.api('logout');
    invalidateAccountState();
    setLoggingOut(false);
    if (res.cancelled) return;
    if (res.ok) {
      showToast(t('acc_logged_out'), 'ok');
      void loadAccounts();
      void refreshStatus({ afterCurrent: true });
    } else toastApiError(t('op_failed'), res);
  }

  createEffect(on(() => nativeControl().accountRevision, () => {
    setAccounts(null); setLoginUrl(null); void loadAccounts();
  }));

  return (
    <div class="tools-page">
      <AccountDetails />
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
                      <div class="account-profile-facts">{t('acc_profile_id')}: <code>{account.id || account.name}</code></div>
                      <Show when={account.tailnet}><div class="account-profile-facts">{t('acc_tailnet')}: {account.tailnet}</div></Show>
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
        <Show when={currentAccount()}>
          <div class="tool-form">
            <TextField label={t('acc_nickname')} value={nickname()} disabled={actionBusy()}
              onInput={event => setNickname((event.target as HTMLInputElement).value)} />
            <p class="tool-hint">{t('acc_rename_hint')}</p>
            <Button variant="outlined" busy={renaming()} disabled={actionBusy() || !hasRoot || !nickname().trim() || nickname().trim().length > 128 || /[\r\n\x00-\x1f\x7f\u2028\u2029]/.test(nickname())}
              onClick={() => void renameAccount()}>{t('acc_rename')}</Button>
          </div>
        </Show>
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
                <Button onClick={async () => { const result = await requestNative('app.openUrl', { url: url() }); if (!result.ok) toastApiError(t('op_failed'), result); }}>
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
                autocomplete="off"
                value={authkey()}
                disabled={actionBusy()}
                onInput={(e) => setAuthkey((e.target as HTMLInputElement).value)}
              />
              <div class="tool-actions">
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
              <div class="tool-actions">
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
      <AccountIdentity />
      <Show when={accounts()?.some((account) => account.current)}>
        <section class="tool-danger">
          <h2>
            <MdIcon name="logout" size={18} /> {t('acc_logout')}
          </h2>
          <p class="tool-hint">{t('tools_logout_desc')}</p>
          <div class="tool-actions">
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
