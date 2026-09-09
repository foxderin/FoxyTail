/* Settings separate appearance, runtime configuration and recovery operations. */
import { createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, execRaw, hasRoot } from '../api';
import { t, lang, setLang, type Lang } from '../i18n';
import type { ToolsKey } from '../i18n-tools';
import { refreshStatus } from '../state';
import { getTask } from '../tasks';
import { BACKUP_TASK, backupPath, createBackup } from '../backup';
import { mode, applyTheme, type ThemeMode } from '../theme';
import { Card, SkeletonRows, ErrorState, StatusBadge } from '../components/Basics';
import { copyText } from '../components/LoginHero';
import { confirmDialog } from '../components/ConfirmDialog';
import { TaskProgress } from '../components/TaskProgress';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, Select, Switch, TextField } from '../components/ui';
import './tools.css';

type Field = {
  key: string;
  label: ToolsKey;
  hint?: ToolsKey;
  range?: [number, number];
  bool?: boolean;
  defaultValue?: string;
  choices?: { value: string; label: ToolsKey }[];
};
const DNS_MODE_HINTS: Record<string, ToolsKey> = {
  legacy: 'tools_dns_mode_legacy_hint',
  local: 'tools_dns_mode_local_hint',
  transparent: 'tools_dns_mode_transparent_hint',
};
const NETWORK: Field[] = [
  { key: 'MAGIC_DNS', label: 'tools_magicdns', hint: 'tools_magicdns_desc', bool: true },
  {
    key: 'DNS_MODE', label: 'tools_dns_mode', defaultValue: 'legacy', choices: [
      { value: 'legacy', label: 'tools_dns_mode_legacy' },
      { value: 'local', label: 'tools_dns_mode_local' },
      { value: 'transparent', label: 'tools_dns_mode_transparent_option' },
    ],
  },
  { key: 'IPV6', label: 'tools_ipv6', bool: true },
  { key: 'SOCKS_PORT', label: 'tools_socks_port', range: [1024, 65535] },
  { key: 'DNS_PORT', label: 'tools_dns_port', hint: 'tools_dns_port_hint', range: [1024, 65535] },
];
const BACKGROUND: Field[] = [
  { key: 'WATCHDOG', label: 'tools_watchdog', hint: 'tools_watchdog_desc', bool: true },
  { key: 'WATCHDOG_INTERVAL', label: 'tools_watchdog_interval', range: [5, 300] },
  { key: 'STATS_INTERVAL', label: 'tools_stats_interval', range: [10, 3600] },
  { key: 'LOG_MAX_KB', label: 'tools_log_limit', range: [64, 10240] },
];
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
  const [restartRequired, setRestartRequired] = createSignal(false);
  const [restartBusy, setRestartBusy] = createSignal(false);
  const [saving, setSaving] = createSignal<string | null>(null);
  const [advancedLoaded, setAdvancedLoaded] = createSignal(false);
  const [advancedBusy, setAdvancedBusy] = createSignal(false);
  const [ctxRules, setCtxRules] = createSignal('');
  const [ctxError, setCtxError] = createSignal(false);
  const [ctxBusy, setCtxBusy] = createSignal(false);
  const [hooks, setHooks] = createSignal<Record<string, string>>({});
  const backupTask = () => getTask(BACKUP_TASK);
  const backupBusy = () => backupTask()?.status === 'running';
  const backupFailed = () => ['error', 'cancelled'].includes(backupTask()?.status || '');
  const [restorePath, setRestorePath] = createSignal('');
  const [restoreBusy, setRestoreBusy] = createSignal(false);
  const [restoreResult, setRestoreResult] = createSignal<{ previous: string; note: string } | null>(
    null,
  );
  const locked = () => !hasRoot || Boolean(saving()) || restartBusy() || restoreBusy() || backupBusy();

  async function loadSettings(): Promise<boolean | undefined> {
    const res = await scope.api('settings-get');
    if (res.cancelled) return;
    if (!res.ok) {
      setSettingsError(res.error || t('error'));
      return;
    }
    setSettings((res.settings as Record<string, string>) || {});
    setSettingsError(null);
    const pending = res.restartRequired === true;
    setRestartRequired(pending);
    return pending;
  }
  async function saveKey(field: Field, value: string, el?: HTMLInputElement | HTMLSelectElement) {
    const previous = settings()?.[field.key] ?? field.defaultValue ?? '';
    const restoreInput = () => {
      if (!el) return;
      if (field.bool && 'checked' in el) el.checked = previous === 'on';
      else el.value = previous;
    };
    if (locked()) {
      restoreInput();
      return;
    }
    if (value === previous) return;
    if (field.choices && !field.choices.some((choice) => choice.value === value)) {
      restoreInput();
      return;
    }
    if (
      field.range &&
      (!/^\d+$/.test(value) || Number(value) < field.range[0] || Number(value) > field.range[1])
    ) {
      showToast(t('tools_invalid_number') + ` ${field.range[0]}–${field.range[1]}`, 'err');
      restoreInput();
      return;
    }
    setSaving(field.key);
    const res = await scope.api('settings-set', field.key, value);
    setSaving(null);
    if (res.cancelled) {
      restoreInput();
      return;
    }
    if (res.ok) {
      setSettings((s) => ({ ...(s ?? {}), [field.key]: value }));
      if (res.applied !== true) setRestartRequired(true);
    } else {
      restoreInput();
      toastApiError(t('op_failed'), res);
    }
  }
  async function applySavedSettings() {
    if (locked()) return;
    setRestartBusy(true);
    const res = await scope.api('control', 'restart');
    if (!res.cancelled) {
      if (res.ok) {
        const pending = await loadSettings();
        if (pending !== false) setRestartRequired(true);
        showToast(
          t(pending === false ? 'set_applied' : 'set_restart_required'),
          pending === false ? 'ok' : 'info',
        );
        void refreshStatus({ afterCurrent: true });
      } else toastApiError(t('op_failed'), res);
    }
    setRestartBusy(false);
  }
  async function loadAdvanced() {
    if (advancedBusy()) return;
    setAdvancedBusy(true);
    const res = await scope.api('context-get');
    if (!res.cancelled) {
      setCtxError(!res.ok);
      if (res.ok) setCtxRules((res.rules as string) || '');
    }
    await Promise.all(
      HOOKS.map(async ([file, key]) => {
        try {
          const out = await execRaw(
            'cat /data/adb/foxytail/scripts/' + file + ' 2>/dev/null || echo "(missing)"',
            15000,
            hookAbort.signal,
          );
          if (!hookAbort.signal.aborted)
            setHooks((h) => ({
              ...h,
              [key]: out === '(missing)' ? t('misc_missing') : out || t('misc_empty'),
            }));
        } catch {
          if (!hookAbort.signal.aborted) setHooks((h) => ({ ...h, [key]: t('misc_unavailable') }));
        }
      }),
    );
    setAdvancedBusy(false);
    setAdvancedLoaded(true);
  }
  async function saveContext() {
    if (ctxBusy() || ctxError() || locked()) return;
    setCtxBusy(true);
    try {
      const res = await scope.api('context-set', btoa(unescape(encodeURIComponent(ctxRules()))));
      if (!res.cancelled) {
        if (res.ok) {
          setRestartRequired(true);
          showToast(t('tools_saved_pending'), 'info');
        } else toastApiError(t('op_failed'), res);
      }
    } catch {
      showToast(t('op_failed'), 'err');
    } finally {
      setCtxBusy(false);
    }
  }
  function doBackup() {
    if (locked()) return;
    void createBackup();
  }
  async function doRestore() {
    const path = restorePath().trim();
    if (locked() || !path) return;
    if (!path.startsWith('/sdcard/') || !path.endsWith('.tar.gz')) {
      showToast(t('tools_restore_path'), 'err');
      return;
    }
    if (!(await confirmDialog(t('set_restore_confirm')))) return;
    setRestoreBusy(true);
    const res = await scope.api('restore', path);
    if (!res.cancelled) {
      if (res.ok) {
        setRestoreResult({
          previous: typeof res.previous === 'string' ? res.previous : '',
          note: typeof res.note === 'string' ? res.note : '',
        });
        setRestartRequired(true);
        await loadSettings();
        if (advancedLoaded()) void loadAdvanced();
        showToast(t('tools_saved_pending'), 'info');
      } else toastApiError(t('op_failed'), res);
    }
    setRestoreBusy(false);
  }
  onMount(() => void loadSettings());
  function fieldRow(field: Field): JSX.Element {
    const value = () => settings()?.[field.key] ?? field.defaultValue ?? '';
    return (
      <div class="tool-setting" style={field.choices ? { 'grid-template-columns': 'minmax(0, 1fr)' } : undefined} data-setting={field.key}>
        <div class="tool-setting-copy">
          <span class="tool-setting-label">{t(field.label)}</span>
          <Show when={field.hint}>
            <span class="tool-hint">{t(field.hint!)}</span>
          </Show>
          <Show when={field.key === 'IPV6'}>
            <span class="tool-hint">{t('set_ipv6_hint')}</span>
          </Show>
          <Show when={field.key === 'DNS_MODE'}>
            <span class="tool-hint">{t(DNS_MODE_HINTS[value()] || 'tools_dns_mode_legacy_hint')}</span>
          </Show>
          <Show when={field.range}>
            <span class="tool-hint">
              {t('tools_range')} {field.range![0]}–{field.range![1]}
            </span>
          </Show>
          <Show when={saving() === field.key}>
            <span class="tool-hint" role="status">
              {t('tools_saving')}
            </span>
          </Show>
        </div>
        <Show
          when={field.bool}
          fallback={
            <Show when={field.choices} fallback={
              <TextField
                aria-label={t(field.label)}
                type="number"
                value={value()}
                disabled={locked()}
                onChange={(e) => {
                  const el = e.target as HTMLInputElement;
                  void saveKey(field, el.value.trim(), el);
                }}
              />
            }>
              <Select aria-label={t(field.label)} value={value()} disabled={locked()} style={{ width: '100%' }}
                onChange={(e) => {
                  const el = e.target as HTMLSelectElement;
                  void saveKey(field, el.value, el);
                }}>
                <For each={field.choices}>{(choice) => <option value={choice.value}>{t(choice.label)}</option>}</For>
              </Select>
            </Show>
          }
        >
          <Switch
            aria-label={t(field.label)}
            selected={value() === 'on'}
            disabled={locked()}
            onChange={(e) => {
              const el = e.target as HTMLInputElement;
              void saveKey(field, el.checked ? 'on' : 'off', el);
            }}
          />
        </Show>
      </div>
    );
  }
  return (
    <div class="tools-page">
      <Show when={restartRequired()}>
        <div class="tool-pending" role="status">
          <div class="toolbar">
            <MdIcon name="sync" size={20} />
            <strong>{t('tools_saved_pending')}</strong>
          </div>
          <p class="tool-hint">{t('tools_saved_pending_desc')}</p>
          <div class="tool-actions">
            <Button busy={restartBusy()} disabled={locked()} onClick={() => void applySavedSettings()}>
              <MdIcon name="refresh" size={18} />
              {restartBusy() ? t('loading') : t('tools_restart')}
            </Button>
          </div>
        </div>
      </Show>
      <Card title={t('tools_appearance')} icon="dark_mode">
        <div class="tool-setting wide-control">
          <span class="tool-setting-label">{t('set_theme')}</span>
          <Select
            aria-label={t('set_theme')}
            value={mode()}
            onChange={(e) => applyTheme((e.target as HTMLSelectElement).value as ThemeMode)}
          >
            <For each={['auto', 'light', 'dark'] as ThemeMode[]}>
              {(m) => (
                <option value={m}>
                  {t(
                    m === 'dark'
                      ? 'set_theme_dark'
                      : m === 'light'
                        ? 'set_theme_light'
                        : 'set_theme_auto',
                  )}
                </option>
              )}
            </For>
          </Select>
        </div>
        <div class="tool-setting wide-control">
          <span class="tool-setting-label">{t('set_language')}</span>
          <Select
            aria-label={t('set_language')}
            value={lang()}
            onChange={(e) => setLang((e.target as HTMLSelectElement).value as Lang)}
          >
            <option value="zh">中文</option>
            <option value="en">English</option>
          </Select>
        </div>
      </Card>
      <Show
        when={settings() !== null || settingsError()}
        fallback={
          <Card title={t('tools_network_settings')} icon="router">
            <SkeletonRows rows={5} />
          </Card>
        }
      >
        <Show
          when={!settingsError()}
          fallback={
            <Card>
              <ErrorState text={settingsError()!} onRetry={() => void loadSettings()} />
            </Card>
          }
        >
          <Card title={t('tools_network_settings')} icon="router" description={t('tools_save_mode')}>
            <For each={NETWORK}>{fieldRow}</For>
            <div class="tool-actions spread">
              <StatusBadge tone={restartRequired() ? 'warning' : 'success'}>
                {t(restartRequired() ? 'tools_saved_pending' : 'tools_all_applied')}
              </StatusBadge>
              <a class="tool-text-link" href="#/tunnel">
                {t('tools_mode_link')}
                <MdIcon name="chevron_right" size={16} />
              </a>
            </div>
          </Card>
          <Card title={t('tools_background')} icon="sync">
            <For each={BACKGROUND}>{fieldRow}</For>
          </Card>
        </Show>
      </Show>
      <details
        class="tool-disclosure"
        onToggle={(e) => {
          if (e.currentTarget.open && !advancedLoaded()) void loadAdvanced();
        }}
      >
        <summary>
          <MdIcon name="settings" size={18} /> {t('tools_advanced')}
        </summary>
        <div class="tool-disclosure-body">
          <Show when={settings()}>
            {fieldRow({ key: 'ROUTE_TABLE', label: 'tools_route_table', range: [1000, 65535] })}
            <div class="tool-setting">
              <span class="tool-setting-label">{t('tools_mark')}</span>
              <code>{settings()?.FWMARK}</code>
            </div>
            <div class="tool-setting">
              <span class="tool-setting-label">{t('tools_mark_mask')}</span>
              <code>{settings()?.FWMARK_MASK}</code>
            </div>
          </Show>
          <Show when={advancedLoaded() && !advancedBusy()} fallback={<SkeletonRows rows={5} />}>
            <Card title={t('set_context')} icon="sync" description={t('set_context_hint')}>
              <Show
                when={!ctxError()}
                fallback={
                  <ErrorState text={t('tools_context_load_error')} onRetry={() => void loadAdvanced()} />
                }
              >
                <textarea
                  class="tool-editor"
                  aria-label={t('set_context')}
                  rows={7}
                  value={ctxRules()}
                  disabled={locked() || ctxBusy()}
                  onInput={(e) => setCtxRules(e.currentTarget.value)}
                />
                <div class="tool-actions">
                  <Button busy={ctxBusy()} disabled={locked()} onClick={() => void saveContext()}>
                    <MdIcon name="check_circle" size={18} />
                    {ctxBusy() ? t('loading') : t('save')}
                  </Button>
                </div>
              </Show>
            </Card>
            <Card title={t('set_hooks')} icon="article" description={t('set_hooks_hint')}>
              <For each={HOOKS}>
                {([, key]) => (
                  <div class="tool-result">
                    <p class="tool-hint">{t(key)}</p>
                    <pre class="mono">{hooks()[key] ?? t('loading')}</pre>
                  </div>
                )}
              </For>
            </Card>
          </Show>
        </div>
      </details>
      <Card title={t('set_backup')} icon="backup" description={t('tools_backup_desc')}>
        <TaskProgress taskKey={BACKUP_TASK} cancellable={false} />
        <Show when={backupFailed()}>
          <div data-testid="backup-error">
            <ErrorState text={backupTask()?.status === 'cancelled' ? t('tools_backup_cancelled') : backupTask()?.result?.error || t('tools_backup_failed')} />
          </div>
        </Show>
        <div class="tool-actions" data-testid="backup-controls">
          <Button variant="tonal" busy={backupBusy()} disabled={locked()} onClick={doBackup}>
            <Show when={!backupBusy()}><MdIcon name={backupFailed() ? 'refresh' : 'backup'} size={18} /></Show>
            {backupBusy() ? t('tools_backup_running') : backupFailed() ? t('retry') : t('set_backup')}
          </Button>
        </div>
        <Show when={backupPath()}>
          <div class="tool-result" data-testid="backup-result" role="status">
            <strong>{t('tools_backup_latest')}</strong>
            <p class="mono" data-testid="backup-path">{backupPath()}</p>
            <p class="tool-hint">{t('tools_backup_file_hint')}</p>
            <Button
              variant="text"
              onClick={() => {
                const copied = copyText(backupPath());
                showToast(t(copied ? 'copied' : 'op_failed'), copied ? 'ok' : 'err');
              }}
            >
              <MdIcon name="content_copy" size={18} />
              {t('tools_copy_path')}
            </Button>
          </div>
        </Show>
      </Card>
      <section class="tool-danger">
        <h2>
          <MdIcon name="refresh" size={18} /> {t('set_restore')}
        </h2>
        <p class="tool-hint">{t('tools_restore_desc')}</p>
        <TextField
          label={t('set_restore')}
          placeholder={t('set_restore_hint')}
          value={restorePath()}
          disabled={restoreBusy()}
          onInput={(e) => setRestorePath((e.target as HTMLInputElement).value)}
        />
        <div>
          <Button
            variant="outlined"
            class="danger"
            busy={restoreBusy()}
            disabled={!restorePath().trim() || locked()}
            onClick={() => void doRestore()}
          >
            {restoreBusy() ? t('tools_restore_busy') : t('set_restore')}
          </Button>
        </div>
      </section>
      <Show when={restoreResult()}>
        {(result) => (
          <Card title={t('tools_restore_result')} icon="backup" class="tool-restore-result">
            <StatusBadge tone="success">{t('set_restore')}</StatusBadge>
            <Show when={result().previous}>
              <div class="tool-result">
                <strong>{t('tools_restore_previous')}</strong>
                <p class="mono" data-testid="restore-previous">
                  {result().previous}
                </p>
                <Button
                  variant="text"
                  onClick={() =>
                    showToast(t(copyText(result().previous) ? 'copied' : 'op_failed'), 'info')
                  }
                >
                  <MdIcon name="content_copy" size={18} />
                  {t('tools_copy_path')}
                </Button>
              </div>
            </Show>
            <Show when={result().note}>
              <div class="tool-result">
                <strong>{t('tools_restore_note')}</strong>
                <pre class="mono" data-testid="restore-note">
                  {result().note}
                </pre>
                <Button
                  variant="text"
                  onClick={() => showToast(t(copyText(result().note) ? 'copied' : 'op_failed'), 'info')}
                >
                  <MdIcon name="content_copy" size={18} />
                  {t('copy')}
                </Button>
              </div>
            </Show>
          </Card>
        )}
      </Show>
    </div>
  );
}
