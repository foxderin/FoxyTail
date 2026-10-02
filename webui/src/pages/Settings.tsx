/* Settings separate appearance, runtime configuration and recovery operations. */
import { createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot } from '../api';
import { t, lang, setLang, type Lang } from '../i18n';
import { NETWORK, BACKGROUND, ROUTE_TABLE, type Field } from '../settings';
import SettingsMaintenance from './SettingsMaintenance';
import SettingsTrial from './SettingsTrial';
import { refreshStatus, status } from '../state';
import { getTask } from '../tasks';
import { BACKUP_TASK } from '../backup';
import { mode, applyTheme, type ThemeMode } from '../theme';
import { Card, SkeletonRows, ErrorState, StatusBadge } from '../components/Basics';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, Select, Switch, TextField } from '../components/ui';
import './tools.css';

export default function Settings(): JSX.Element {
  const scope = createApiScope();
  const [settings, setSettings] = createSignal<Record<string, string> | null>(null);
  const [settingsError, setSettingsError] = createSignal<string | null>(null);
  const [restartRequired, setRestartRequired] = createSignal(false);
  const [restartBusy, setRestartBusy] = createSignal(false);
  const [trialActive, setTrialActive] = createSignal(false);
  const [saving, setSaving] = createSignal<string | null>(null);
  const [restoreBusy, setRestoreBusy] = createSignal(false);
  // `null` = never probed; `false` = kernel lacks transparent capture; `true`
  // = cached probe confirms the kernel can run transparent split DNS.
  const [transparentAvailable, setTransparentAvailable] = createSignal<boolean | null>(null);
  const [transparentReason, setTransparentReason] = createSignal<string | null>(null);
  const backupBusy = () => getTask(BACKUP_TASK)?.status === 'running';
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
  async function loadTransparentCapability() {
    const res = await scope.api('dns');
    if (res.cancelled) return;
    if (res.ok) {
      const available = res.transparentAvailable;
      if (available === true || available === false) {
        setTransparentAvailable(available);
        setTransparentReason(typeof res.transparentUnavailableReason === 'string' ? res.transparentUnavailableReason : null);
        return;
      }
    }
    // No cached verdict: run the kernel probe once so the choice reflects the
    // actual device rather than a stale or absent cache. Probe is fast and
    // idempotent; failures still record a verdict in the backend cache.
    const probe = await scope.api('dns-probe');
    if (probe.cancelled) return;
    if (probe.ok) {
      setTransparentAvailable(probe.transparentAvailable === true);
      setTransparentReason(typeof probe.transparentUnavailableReason === 'string' ? probe.transparentUnavailableReason : null);
    }
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
    if (locked() || trialActive()) return;
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
  onMount(() => {
    void loadSettings();
    void loadTransparentCapability();
  });
  function fieldRow(field: Field): JSX.Element {
    const value = () => settings()?.[field.key] ?? field.defaultValue ?? '';
    // When the kernel probe reports transparent capture is impossible, pin
    // the transparent choice as disabled and replace its hint with the
    // reason. Doing it per-row keeps the change scoped to DNS_MODE without
    // touching the shared schema.
    const choices = () => {
      if (field.key !== 'DNS_MODE' || !field.choices) return field.choices;
      return field.choices.map((choice) => {
        if (choice.value !== 'transparent') return choice;
        if (transparentAvailable() === false) {
          return { ...choice, disabled: true, hint: 'tools_dns_mode_transparent_unavailable' as const };
        }
        return choice;
      });
    };
    const hint = () => choices()?.find(choice => choice.value === value())?.hint ?? field.hint;
    return (
      <div class="tool-setting" style={field.choices ? { 'grid-template-columns': 'minmax(0, 1fr)' } : undefined} data-setting={field.key}>
        <div class="tool-setting-copy">
          <span class="tool-setting-label">{t(field.label)}</span>
          <Show when={hint()}>{key => <span class="tool-hint">{t(key())}</span>}</Show>
          <Show when={field.key === 'WATCHDOG_PROBE' && status()?.powerSave === true}>
            <span class="tool-hint" data-testid="power-probe-paused">{t('tools_probe_paused')}</span>
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
          <Show when={field.key === 'DNS_MODE' && transparentAvailable() === false && transparentReason()}>
            <span class="tool-hint" data-testid="dns-transparent-unavailable">{transparentReason()}</span>
          </Show>
        </div>
        <Show
          when={field.bool}
          fallback={
            <Show when={field.choices} fallback={
              <TextField
                aria-label={t(field.label)}
                type="number"
                min={field.range?.[0]}
                max={field.range?.[1]}
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
                <For each={choices()}>{(choice) => <option value={choice.value} disabled={choice.disabled}>{t(choice.label)}</option>}</For>
              </Select>
            </Show>
          }
        >
          <Switch
            aria-label={t(field.label)}
            checked={value() === 'on'}
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
            <Button busy={restartBusy()} disabled={locked() || trialActive()} onClick={() => void applySavedSettings()}>
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
      <SettingsTrial locked={locked()} onActive={setTrialActive} onUpdate={loadSettings} />
      <SettingsMaintenance locked={locked()} busy={restoreBusy()} setBusy={setRestoreBusy}
        onPending={() => setRestartRequired(true)} onRestore={loadSettings}>
        <Show when={settings()}>
          {fieldRow(ROUTE_TABLE)}
          <div class="tool-setting">
            <span class="tool-setting-label">{t('tools_mark')}</span>
            <code>{settings()?.FWMARK}</code>
          </div>
          <div class="tool-setting">
            <span class="tool-setting-label">{t('tools_mark_mask')}</span>
            <code>{settings()?.FWMARK_MASK}</code>
          </div>
        </Show>
      </SettingsMaintenance>
    </div>
  );
}
