/*
 * Settings — foxytail.conf editor (bool/num/text per key), network context
 * rules (base64 round-trip), read-only tun hooks, backup / restore,
 * theme + language.
 */
import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, execRaw, hasRoot } from '../api';
import { t, lang, setLang, type Lang } from '../i18n';
import { refreshStatus } from '../state';
import { mode, applyTheme, type ThemeMode } from '../theme';
import { Card, SkeletonRows, EmptyState, ErrorState } from '../components/Basics';
import { confirmDialog } from '../components/ConfirmDialog';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, Select, Switch, TextField } from '../components/ui';

const BOOL_KEYS = ['MAGIC_DNS', 'IPV6', 'WATCHDOG'];
const NUM_KEYS = ['SOCKS_PORT', 'DNS_PORT', 'ROUTE_TABLE', 'WATCHDOG_INTERVAL', 'STATS_INTERVAL', 'LOG_MAX_KB'];

const HOOKS: [string, 'set_hook_up' | 'set_hook_down'][] = [
  ['foxytail.tun.up', 'set_hook_up'],
  ['foxytail.tun.down', 'set_hook_down'],
];

export default function Settings(): JSX.Element {
  const scope = createApiScope();
  const hookAbort = new AbortController();
  onCleanup(() => hookAbort.abort());
  const [settings, setSettings] = createSignal<Record<string, string> | null>(null);
  const [settingsError, setSettingsError] = createSignal<string | null>(null);
  const [ctxRules, setCtxRules] = createSignal('');
  const [ctxBusy, setCtxBusy] = createSignal(false);
  const [hooks, setHooks] = createSignal<Record<string, string>>({});
  const [restorePath, setRestorePath] = createSignal('');
  const [backupBusy, setBackupBusy] = createSignal(false);
  const [restartRequired, setRestartRequired] = createSignal(false);
  const [restartBusy, setRestartBusy] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  async function loadSettings(): Promise<boolean | undefined> {
    const res = await scope.api('settings-get');
    if (res.cancelled) return;
    if (res.ok) {
      setSettings((res.settings as Record<string, string>) || {});
      setSettingsError(null);
      if (typeof res.restartRequired === 'boolean') {
        setRestartRequired(res.restartRequired);
        return res.restartRequired;
      }
    } else {
      setSettingsError(res.error || t('error'));
    }
  }

  async function saveKey(key: string, value: string): Promise<boolean> {
    if (saving() || restartBusy()) return false;
    setSaving(true);
    const res = await scope.api('settings-set', key, value);
    setSaving(false);
    if (res.cancelled) return false;
    if (res.ok) {
      const pending = res.applied !== true;
      if (pending) setRestartRequired(true);
      showToast(t(pending ? 'set_restart_required' : 'set_saved') + ': ' + key, pending ? 'info' : 'ok');
      return true;
    }
    toastApiError(t('op_failed'), res);
    return false;
  }

  async function applySavedSettings() {
    if (restartBusy() || saving()) return;
    setRestartBusy(true);
    const res = await scope.api('control', 'restart');
    if (res.cancelled) { setRestartBusy(false); return; }
    if (res.ok) {
      let pending = res.applied !== true || res.restartRequired === true;
      setRestartRequired(pending);
      const observedPending = await loadSettings();
      if (observedPending !== undefined) pending = observedPending;
      showToast(t(pending ? 'set_restart_required' : 'set_applied'), pending ? 'info' : 'ok');
      void refreshStatus();
    } else toastApiError(t('op_failed'), res);
    setRestartBusy(false);
  }

  async function saveContext() {
    if (ctxBusy()) return;
    setCtxBusy(true);
    try {
      const b64 = btoa(unescape(encodeURIComponent(ctxRules())));
      const res = await scope.api('context-set', b64);
      if (res.cancelled) return;
      if (res.ok) showToast(t('set_saved'), 'ok');
      else toastApiError(t('op_failed'), res);
    } catch {
      showToast(t('op_failed'), 'err');
    } finally {
      setCtxBusy(false);
    }
  }

  async function doBackup() {
    if (backupBusy()) return;
    setBackupBusy(true);
    const res = await scope.api('backup');
    setBackupBusy(false);
    if (res.cancelled) return;
    if (res.ok) showToast(t('set_backup_done') + String(res.path), 'ok');
    else toastApiError(t('op_failed'), res);
  }

  async function doRestore() {
    const p = restorePath().trim();
    if (!p) return;
    if (!(await confirmDialog(t('set_restore_confirm')))) return;
    const res = await scope.api('restore', p);
    if (res.cancelled) return;
    if (res.ok) {
      setRestartRequired(true);
      void loadSettings();
      showToast(t('set_restore_done') + String(res.previous || '') + ')', 'info');
    }
    else toastApiError(t('op_failed'), res);
  }

  onMount(() => {
    void loadSettings();
    void scope.api('context-get').then((res) => {
      if (!res.cancelled && res.ok) setCtxRules((res.rules as string) || '');
    });
    HOOKS.forEach(([file, key]) => {
      void execRaw('cat /data/adb/foxytail/scripts/' + file + ' 2>/dev/null || echo "(missing)"', 15000, hookAbort.signal)
        .then((out) => {
          /* the shell side marks a missing hook with "(missing)"; the
           * displayed string goes through the dictionary */
          setHooks((h) => ({
            ...h,
            [key]: out === '(missing)' ? t('misc_missing') : out || t('misc_empty'),
          }));
        })
        .catch(() => {
          if (!hookAbort.signal.aborted) setHooks((h) => ({ ...h, [key]: t('misc_unavailable') }));
        });
    });
  });

  return (
    <>
      <Show when={restartRequired()}>
        <div class="banner warn">
          <span class="spacer">{t('set_restart_required')}</span>
          <Button variant="tonal" disabled={!hasRoot || restartBusy() || saving()} onClick={() => void applySavedSettings()}>{t('set_apply_restart')}</Button>
        </div>
      </Show>
      <Card title={t('set_general')} icon="settings">
        <Show when={settings() !== null || settingsError() !== null} fallback={<SkeletonRows rows={4} />}>
          <Show
            when={!settingsError()}
            fallback={<ErrorState text={settingsError()!} onRetry={() => void loadSettings()} />}
          >
            <Show
              when={Object.keys(settings() ?? {}).length > 0}
              fallback={<EmptyState text={t('empty')} icon="settings" />}
            >
              {Object.keys(settings() ?? {}).map((key) => {
                const val = () => settings()![key];
                if (key === 'TS_MODE') {
                  return (
                    <div class="setting-row">
                      <div>
                        <div>{key}</div>
                        <div class="desc">{t('dash_mode')}</div>
                      </div>
                      <span class="dim">{val()}</span>
                    </div>
                  );
                }
                if (BOOL_KEYS.includes(key)) {
                  return (
                    <div class="setting-row">
                      <div>
                        {key}
                        <Show when={key === 'IPV6'}><div class="desc">{t('set_ipv6_hint')}</div></Show>
                      </div>
                      <Switch
                        selected={val() === 'on'}
                        disabled={!hasRoot || saving() || restartBusy()}
                        onChange={(e: Event) => {
                          const el = e.target as unknown as { selected: boolean };
                          const v = el.selected ? 'on' : 'off';
                          void saveKey(key, v).then((ok) => {
                            if (ok) setSettings((s) => ({ ...(s ?? {}), [key]: v }));
                          });
                        }}
                      />
                    </div>
                  );
                }
                return (
                  <div class="setting-row">
                    <div>{key}</div>
                    <TextField
                      type={NUM_KEYS.includes(key) ? 'number' : 'text'}
                      value={val()}
                      disabled={!hasRoot || saving() || restartBusy()}
                      onChange={(e: Event) => {
                        const el = e.target as HTMLInputElement;
                        const v = el.value.trim();
                        if (v === val()) return;
                        void saveKey(key, v).then((ok) => {
                          if (ok) setSettings((s) => ({ ...(s ?? {}), [key]: v }));
                          else el.value = val();
                        });
                      }}
                    />
                  </div>
                );
              })}
            </Show>
          </Show>
        </Show>
      </Card>

      <Card title={t('set_context')} icon="sync">
        <p class="dim">{t('set_context_hint')}</p>
        <textarea
          class="ctx-editor"
          rows={7}
          value={ctxRules()}
          onInput={(e) => setCtxRules(e.currentTarget.value)}
        />
        <div class="btn-row">
          <Button
            variant="filled"
            disabled={ctxBusy() || !hasRoot}
            onClick={() => void saveContext()}
          >
            <MdIcon name="check_circle" size={18} /> {t('save')}
          </Button>
        </div>
      </Card>

      <Card title={t('set_hooks')} icon="article">
        <p class="dim">{t('set_hooks_hint')}</p>
        {HOOKS.map(([, key]) => (
          <div class="mt">
            <div class="dim">{t(key)}</div>
            <pre class="log-view">{hooks()[key] ?? t('loading')}</pre>
          </div>
        ))}
      </Card>

      <Card title={t('set_backup') + ' / ' + t('set_restore')} icon="backup">
        <div class="btn-row" style={{ 'margin-top': '0' }}>
          <Button
            variant="tonal"
            disabled={backupBusy() || !hasRoot}
            onClick={() => void doBackup()}
          >
            <MdIcon name="backup" size={18} /> {t('set_backup')}
          </Button>
        </div>
        <TextField
          label={t('set_restore')}
          placeholder={t('set_restore_hint')}
          value={restorePath()}
          onInput={(e: InputEvent) => setRestorePath((e.target as HTMLInputElement).value)}
        />
        <div class="btn-row">
          <Button
            variant="outlined"
            disabled={!restorePath().trim() || !hasRoot}
            onClick={() => void doRestore()}
          >
            <MdIcon name="refresh" size={18} /> {t('set_restore')}
          </Button>
        </div>
      </Card>

      <Card title={t('set_ui')} icon="dark_mode">
        <div class="setting-row">
          <div>
            <MdIcon name="dark_mode" size={18} class="dim" /> {t('set_theme')}
          </div>
          <Select
            style={{ width: '180px' }}
            value={mode()}
            onChange={(e: Event) =>
              applyTheme((e.target as HTMLSelectElement).value as ThemeMode || 'dark')
            }
          >
            {(['dark', 'light', 'auto'] as ThemeMode[]).map((m) => (
              <option value={m} selected={m === mode()}>
                {t(m === 'dark' ? 'set_theme_dark' : m === 'light' ? 'set_theme_light' : 'set_theme_auto')}
              </option>
            ))}
          </Select>
        </div>
        <div class="setting-row">
          <div>
            <MdIcon name="translate" size={18} class="dim" /> {t('set_language')}
          </div>
          <Select
            style={{ width: '180px' }}
            value={lang()}
            onChange={(e: Event) => setLang((e.target as HTMLSelectElement).value as Lang || 'zh')}
          >
            <option value="zh" selected={lang() === 'zh'}>中文</option>
            <option value="en" selected={lang() === 'en'}>English</option>
          </Select>
        </div>
      </Card>
    </>
  );
}
