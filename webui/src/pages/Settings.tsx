/* Settings separate appearance, runtime configuration and recovery operations. */
import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot, nativeControl } from '../api';
import { t, languageMode, setLang, type Lang } from '../i18n';
import { NETWORK, BACKGROUND, bindNativeDraft, type Field } from '../settings';
import SettingsMaintenance from './SettingsMaintenance';
import SettingsTrial from './SettingsTrial';
import { refreshStatus, status } from '../state';
import { getTask, startTask } from '../tasks';
import { BACKUP_TASK, RESTORE_TASK } from '../backup';
import { TaskProgress } from '../components/TaskProgress';
import { mode, applyTheme, type ThemeMode } from '../theme';
import { Card, SkeletonRows, ErrorState, StatusBadge } from '../components/Basics';
import { showToast, toastApiError } from '../components/Toast';
import { confirmDialog } from '../components/ConfirmDialog';
import { MdIcon } from '../icons';
import { Button, Select, Switch, TextField } from '../components/ui';
import './tools.css';
import { pollWhileVisible } from '../schedule';
import { viewPollInterval } from '../state';

export default function Settings(): JSX.Element {
  const scope = createApiScope();
  let disposed = false;
  let settingsLoad = 0;
  onCleanup(() => { disposed = true; });
  const [settings, setSettings] = createSignal<Record<string, string> | null>(null);
  const [drafts, setDrafts] = createSignal<Record<string, { baseline: string; value: string }>>({});
  const draftReady = bindNativeDraft('settings', () => ({ drafts: drafts() }), value => {
    if (value.drafts && typeof value.drafts === 'object' && !Array.isArray(value.drafts)) {
      const valid = Object.entries(value.drafts).filter(([key, item]) =>
        [...NETWORK, ...BACKGROUND].some(field => field.key === key) &&
        item && typeof item === 'object' && typeof item.baseline === 'string' && typeof item.value === 'string');
      setDrafts(Object.fromEntries(valid));
    }
  });
  const [settingsError, setSettingsError] = createSignal<string | null>(null);
  const [restartRequired, setRestartRequired] = createSignal(false);
  const [trialActive, setTrialActive] = createSignal(true);
  // `null` = never probed; `false` = kernel lacks transparent capture; `true`
  // = cached probe confirms the kernel can run transparent split DNS.
  const [transparentAvailable, setTransparentAvailable] = createSignal<boolean | null>(null);
  const [transparentReason, setTransparentReason] = createSignal<string | null>(null);
  const backupBusy = () => getTask(BACKUP_TASK)?.status === 'running';
  const saveTask = () => getTask('settings-save');
  const serviceTask = () => getTask('service-control');
  const saving = () => saveTask()?.status === 'running' ? String(saveTask()?.args[0] ?? '') : null;
  const restartBusy = () => serviceTask()?.status === 'running';
  const locked = () => !hasRoot || !nativeControl().canWrite || nativeControl().busy || Boolean(saving()) || restartBusy() || getTask(RESTORE_TASK)?.status === 'running' || backupBusy();

  async function loadSettings(): Promise<boolean | undefined> {
    const load = ++settingsLoad;
    const observation = nativeControl().revision;
    const res = await scope.api('settings-get');
    if (res.cancelled || disposed || load !== settingsLoad || observation !== nativeControl().revision) return;
    if (!res.ok || !res.settings || typeof res.settings !== 'object' || Array.isArray(res.settings) ||
        !Object.values(res.settings).every(value => typeof value === 'string') ||
        ![...NETWORK, ...BACKGROUND].every(field => typeof (res.settings as Record<string, unknown>)[field.key] === 'string') ||
        typeof res.restartRequired !== 'boolean') {
      setSettingsError(res.error || t('error'));
      return;
    }
    setSettings(res.settings as Record<string, string>);
    setDrafts(old => {
      const next = { ...old };
      for (const [key, draft] of Object.entries(old)) {
        if (draft.value === (res.settings as Record<string, string>)[key] || draft.value === draft.baseline) delete next[key];
      }
      return next;
    });
    setSettingsError(null);
    const pending = res.restartRequired === true;
    setRestartRequired(pending);
    return pending;
  }
  async function loadTransparentCapability() {
    const res = await scope.api('dns');
    if (res.cancelled || disposed) return;
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
    if (probe.cancelled || disposed) return;
    if (probe.ok) {
      setTransparentAvailable(probe.transparentAvailable === true);
      setTransparentReason(typeof probe.transparentUnavailableReason === 'string' ? probe.transparentUnavailableReason : null);
    }
  }
  function changeKey(field: Field, value: string) {
    if (locked()) return;
    setDrafts(old => ({ ...old, [field.key]: { baseline: old[field.key]?.baseline ?? settings()?.[field.key] ?? field.defaultValue ?? '', value } }));
  }
  async function saveKey(field: Field) {
    const draft = drafts()[field.key];
    if (locked() || !draft) return;
    const value = draft.value.trim();
    if (field.choices && !field.choices.some(choice => choice.value === value && !choice.disabled)) return;
    if (field.range && (!/^\d+$/.test(value) || Number(value) < field.range[0] || Number(value) > field.range[1])) {
      showToast(t('tools_invalid_number') + ` ${field.range[0]}–${field.range[1]}`, 'err');
      return;
    }
    if (field.key === 'DNS_MODE' && value === 'transparent' && transparentAvailable() === false) return;
    const fresh = await loadSettings();
    if (fresh === undefined || locked() || drafts()[field.key] !== draft) return;
    const conflict = draft.baseline !== settings()?.[field.key];
    if ((conflict || ['MAGIC_DNS', 'DNS_MODE', 'IPV6', 'SOCKS_PORT', 'DNS_PORT'].includes(field.key)) &&
        !await confirmDialog((conflict ? t('tools_draft_conflict') + '\n\n' : '') + t('tools_network_warning'))) return;
    if (locked() || drafts()[field.key] !== draft) return;
    settingsLoad++;
    const res = await startTask('settings-save', 'settings-set', field.key, value).promise;
    if (disposed) return;
    if (res.ok) {
      setSettings(old => ({ ...old, [field.key]: value }));
      setDrafts(old => { const next = { ...old }; if (next[field.key] === draft) delete next[field.key]; return next; });
      if (res.applied !== true) setRestartRequired(true);
    } else if (!res.cancelled) toastApiError(t('op_failed'), res);
    void loadSettings();
  }
  async function applySavedSettings() {
    if (locked() || trialActive()) return;
    if (!await confirmDialog(t('tools_network_warning'))) return;
    const trialState = await scope.api('trial-status');
    const trial = trialState.trial as { status?: string } | null | undefined;
    if (!trialState.ok || trial === undefined || (trial !== null && !['confirmed', 'rolled-back', 'superseded'].includes(trial.status ?? ''))) {
      setTrialActive(true); toastApiError(t('op_failed'), { error: trialState.error || t('trial_invalid_response') }); return;
    }
    if (locked()) return;
    const res = await startTask('service-control', 'control', 'restart').promise;
    if (disposed) return;
    if (!res.cancelled) {
      if (res.ok) {
        const pending = await loadSettings();
        if (disposed) return;
        if (pending !== false) setRestartRequired(true);
        showToast(
          t(pending === false ? 'set_applied' : 'set_restart_required'),
          pending === false ? 'ok' : 'info',
        );
        void refreshStatus({ afterCurrent: true });
      } else toastApiError(t('op_failed'), res);
    }
  }
  createEffect(on(
    () => [saveTask()?.result, serviceTask()?.result, getTask(RESTORE_TASK)?.result],
    results => { if (results.some(result => result != null)) void loadSettings(); },
    { defer: true },
  ));
  onMount(() => {
    void loadTransparentCapability();
  });
  pollWhileVisible(() => draftReady.then(() => saving() ? undefined : loadSettings()), () => viewPollInterval(10000));
  function fieldRow(field: Field): JSX.Element {
    const value = () => drafts()[field.key]?.value ?? settings()?.[field.key] ?? field.defaultValue ?? '';
    const changed = () => drafts()[field.key] && value() !== settings()?.[field.key];
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
          <Show when={changed()}>
            <p role="status">{t(drafts()[field.key]?.baseline !== settings()?.[field.key] ? 'tools_draft_conflict' : 'tools_draft_changed')}</p>
            <div class="tool-actions">
              <Button disabled={locked()} onClick={() => void saveKey(field)}>{t('save')}</Button>
              <Button variant="text" disabled={locked()} onClick={async () => {
                if (!await confirmDialog(t('tools_draft_changed'))) return;
                if (await loadSettings() !== undefined) setDrafts(old => { const next = { ...old }; delete next[field.key]; return next; });
              }}>{t('tools_retry')}</Button>
            </div>
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
                onInput={(e) => changeKey(field, (e.currentTarget as HTMLInputElement).value)}
              />
            }>
              <Select aria-label={t(field.label)} value={value()} disabled={locked()} style={{ width: '100%' }}
                onChange={(e) => changeKey(field, (e.currentTarget as HTMLSelectElement).value)}>
                <For each={choices()}>{(choice) => <option value={choice.value} disabled={choice.disabled}>{t(choice.label)}</option>}</For>
              </Select>
            </Show>
          }
        >
          <Switch
            aria-label={t(field.label)}
            checked={value() === 'on'}
            disabled={locked()}
            onChange={(e) => changeKey(field, (e.currentTarget as HTMLInputElement).checked ? 'on' : 'off')}
          />
        </Show>
      </div>
    );
  }
  return (
    <div class="tools-page">
      <TaskProgress taskKey="settings-save" />
      <TaskProgress taskKey="service-control" />
      <For each={['settings-save', 'service-control']}>{key => {
        const task = () => getTask(key);
        return <Show when={task()?.result}>
          <div class="tool-result" role={task()?.status === 'error' ? 'alert' : 'status'} data-task-result={key} data-task-status={task()?.status}>
            {task()?.result?.ok
              ? t(key === 'settings-save' && task()?.result?.applied !== true ? 'tools_saved_pending' : key === 'settings-save' ? 'tools_all_applied' : 'dash_action_done')
              : String(task()?.result?.error || t('error'))}
          </div>
        </Show>;
      }}</For>
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
            value={languageMode()}
            onChange={(e) => setLang((e.target as HTMLSelectElement).value as Lang | 'auto')}
          >
            <option value="auto">{t('set_theme_auto')}</option>
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
      <SettingsMaintenance locked={locked()} onPending={() => setRestartRequired(true)}>
        <Show when={settings()}>
          <div class="tool-setting">
            <span class="tool-setting-label">{t('tools_route_table')}</span>
            <code>{settings()?.ROUTE_TABLE ?? t('net_unknown')}</code>
          </div>
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
