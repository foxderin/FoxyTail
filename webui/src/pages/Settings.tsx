/*
 * Settings — foxytail.conf editor (bool/num/text per key), network context
 * rules (base64 round-trip), read-only tun hooks, backup / restore,
 * theme + language.
 */
import { createSignal, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, execRaw, hasRoot } from '../api';
import { t, lang, setLang, type Lang } from '../i18n';
import { mode, applyTheme, type ThemeMode } from '../theme';
import { Card, SkeletonRows, EmptyState, ErrorState } from '../components/Basics';
import { confirmDialog } from '../components/ConfirmDialog';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';

const BOOL_KEYS = ['MAGIC_DNS', 'IPV6', 'WATCHDOG'];
const NUM_KEYS = ['SOCKS_PORT', 'DNS_PORT', 'ROUTE_TABLE', 'WATCHDOG_INTERVAL', 'STATS_INTERVAL', 'LOG_MAX_KB'];

const HOOKS: [string, 'set_hook_up' | 'set_hook_down'][] = [
  ['foxytail.tun.up', 'set_hook_up'],
  ['foxytail.tun.down', 'set_hook_down'],
];

export default function Settings(): JSX.Element {
  const scope = createApiScope();
  const [settings, setSettings] = createSignal<Record<string, string> | null>(null);
  const [settingsError, setSettingsError] = createSignal<string | null>(null);
  const [ctxRules, setCtxRules] = createSignal('');
  const [ctxBusy, setCtxBusy] = createSignal(false);
  const [hooks, setHooks] = createSignal<Record<string, string>>({});
  const [restorePath, setRestorePath] = createSignal('');
  const [backupBusy, setBackupBusy] = createSignal(false);

  async function loadSettings() {
    const res = await scope.api('settings-get');
    if (res.cancelled) return;
    if (res.ok) {
      setSettings((res.settings as Record<string, string>) || {});
      setSettingsError(null);
    } else {
      setSettingsError(res.error || t('error'));
    }
  }

  async function saveKey(key: string, value: string): Promise<boolean> {
    const res = await scope.api('settings-set', key, value);
    if (res.cancelled) return false;
    if (res.ok) {
      showToast(t('set_saved') + ': ' + key, 'ok');
      return true;
    }
    toastApiError(t('op_failed'), res);
    return false;
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
    if (res.ok) showToast(t('set_restore_done') + String(res.previous || '') + ')', 'ok');
    else toastApiError(t('op_failed'), res);
  }

  onMount(() => {
    void loadSettings();
    void scope.api('context-get').then((res) => {
      if (!res.cancelled && res.ok) setCtxRules((res.rules as string) || '');
    });
    HOOKS.forEach(([file, key]) => {
      void execRaw('cat /data/adb/foxytail/scripts/' + file + ' 2>/dev/null || echo "(missing)"')
        .then((out) => {
          /* the shell side marks a missing hook with "(missing)"; the
           * displayed string goes through the dictionary */
          setHooks((h) => ({
            ...h,
            [key]: out === '(missing)' ? t('misc_missing') : out || t('misc_empty'),
          }));
        })
        .catch(() => setHooks((h) => ({ ...h, [key]: t('misc_unavailable') })));
    });
  });

  return (
    <>
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
                      <div>{key}</div>
                      <md-switch
                        selected={val() === 'on' || undefined}
                        disabled={!hasRoot || undefined}
                        on:change={(e: Event) => {
                          const el = e.target as unknown as { selected: boolean };
                          void saveKey(key, el.selected ? 'on' : 'off');
                        }}
                      />
                    </div>
                  );
                }
                return (
                  <div class="setting-row">
                    <div>{key}</div>
                    <md-outlined-text-field
                      type={NUM_KEYS.includes(key) ? 'number' : 'text'}
                      value={val()}
                      disabled={!hasRoot || undefined}
                      on:change={(e: Event) => {
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
          <md-filled-button
            disabled={ctxBusy() || !hasRoot || undefined}
            onClick={() => void saveContext()}
          >
            <MdIcon name="check_circle" size={18} /> {t('save')}
          </md-filled-button>
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
          <md-filled-tonal-button
            disabled={backupBusy() || !hasRoot || undefined}
            onClick={() => void doBackup()}
          >
            <MdIcon name="backup" size={18} /> {t('set_backup')}
          </md-filled-tonal-button>
        </div>
        <label class="field mt">
          <md-outlined-text-field
            label={t('set_restore')}
            placeholder={t('set_restore_hint')}
            value={restorePath()}
            onInput={(e: InputEvent) => setRestorePath((e.target as HTMLInputElement).value)}
          />
        </label>
        <div class="btn-row">
          <md-outlined-button
            disabled={!restorePath().trim() || !hasRoot || undefined}
            onClick={() => void doRestore()}
          >
            <MdIcon name="refresh" size={18} /> {t('set_restore')}
          </md-outlined-button>
        </div>
      </Card>

      <Card title={t('set_ui')} icon="dark_mode">
        <div class="setting-row">
          <div>
            <MdIcon name="dark_mode" size={18} class="dim" /> {t('set_theme')}
          </div>
          <md-outlined-select
            style={{ width: '180px' }}
            value={mode()}
            on:change={(e: Event) =>
              applyTheme((e.target as unknown as { value: ThemeMode }).value || 'dark')
            }
          >
            {(['dark', 'light', 'auto'] as ThemeMode[]).map((m) => (
              <md-select-option value={m} selected={m === mode() || undefined}>
                <div slot="headline">
                  {t(m === 'dark' ? 'set_theme_dark' : m === 'light' ? 'set_theme_light' : 'set_theme_auto')}
                </div>
              </md-select-option>
            ))}
          </md-outlined-select>
        </div>
        <div class="setting-row">
          <div>
            <MdIcon name="translate" size={18} class="dim" /> {t('set_language')}
          </div>
          <md-outlined-select
            style={{ width: '180px' }}
            value={lang()}
            on:change={(e: Event) =>
              setLang(((e.target as unknown as { value: Lang }).value || 'zh') as Lang)
            }
          >
            <md-select-option value="zh" selected={lang() === 'zh' || undefined}>
              <div slot="headline">中文</div>
            </md-select-option>
            <md-select-option value="en" selected={lang() === 'en' || undefined}>
              <div slot="headline">English</div>
            </md-select-option>
          </md-outlined-select>
        </div>
      </Card>
    </>
  );
}
