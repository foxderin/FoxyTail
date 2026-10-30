/* Settings separate appearance, runtime configuration and recovery operations. */
import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot, nativeControl } from '../api';
import { t, tf, languageMode, setLang, type Lang } from '../i18n';
import { NETWORK, BACKGROUND, bindNativeDraft, type Field } from '../settings';
import { settingsDrafts, setSettingsDrafts, restartRequired, setRestartRequired, applyRequested, setApplyRequested } from '../pending';
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
import { Button, Checkbox, Dialog, Select, Switch, TextField } from '../components/ui';
import './tools.css';
import { pollWhileVisible } from '../schedule';
import { viewPollInterval } from '../state';

export default function Settings(): JSX.Element {
  const scope = createApiScope();
  let disposed = false;
  let settingsLoad = 0;
  onCleanup(() => { disposed = true; });
  const [settings, setSettings] = createSignal<Record<string, string> | null>(null);
  const drafts = settingsDrafts;
  const setDrafts = setSettingsDrafts;
  const draftReady = bindNativeDraft('settings', () => ({ drafts: drafts() }), value => {
    if (value.drafts && typeof value.drafts === 'object' && !Array.isArray(value.drafts)) {
      const valid = Object.entries(value.drafts).filter(([key, item]) =>
        [...NETWORK, ...BACKGROUND].some(field => field.key === key) &&
        item && typeof item === 'object' && typeof item.baseline === 'string' && typeof item.value === 'string');
      setDrafts(Object.fromEntries(valid));
    }
  });
  const [settingsError, setSettingsError] = createSignal<string | null>(null);
  const [reviewOpen, setReviewOpen] = createSignal(false);
  const [safeApply, setSafeApply] = createSignal(true);
  /* The trial card exposes a confirmed-start entry for the review flow. */
  let trialStart: ((candidate: string, duration: string) => Promise<void>) | null = null;
  const [trialActive, setTrialActive] = createSignal(true);
  // `null` = never probed; `false` = kernel lacks the interception path; `true`
  // = cached probe confirms the kernel can run that split-DNS mode.
  const [transparentAvailable, setTransparentAvailable] = createSignal<boolean | null>(null);
  const [transparentReason, setTransparentReason] = createSignal<string | null>(null);
  const [hijackAvailable, setHijackAvailable] = createSignal<boolean | null>(null);
  const [hijackReason, setHijackReason] = createSignal<string | null>(null);
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
      const hijackCapable = res.hijackAvailable;
      if (available === true || available === false) {
        setTransparentAvailable(available);
        setTransparentReason(typeof res.transparentUnavailableReason === 'string' ? res.transparentUnavailableReason : null);
      }
      if (hijackCapable === true || hijackCapable === false) {
        setHijackAvailable(hijackCapable);
        setHijackReason(typeof res.hijackUnavailableReason === 'string' ? res.hijackUnavailableReason : null);
      }
      if ((available === true || available === false) && (hijackCapable === true || hijackCapable === false)) return;
    }
    // No cached verdict: run the kernel probes once so the choices reflect the
    // actual device rather than a stale or absent cache. Probes are fast and
    // idempotent; failures still record verdicts in the backend caches.
    const probe = await scope.api('dns-probe');
    if (probe.cancelled || disposed) return;
    if (probe.ok) {
      setTransparentAvailable(probe.transparentAvailable === true);
      setTransparentReason(typeof probe.transparentUnavailableReason === 'string' ? probe.transparentUnavailableReason : null);
      setHijackAvailable(probe.hijackAvailable === true);
      setHijackReason(typeof probe.hijackUnavailableReason === 'string' ? probe.hijackUnavailableReason : null);
    }
  }
  const allFields = () => [...NETWORK, ...BACKGROUND];
  const draftEntries = () =>
    Object.entries(drafts())
      .map(([key, draft]) => ({ field: allFields().find(field => field.key === key), key, ...draft }))
      .filter(entry => entry.field);
  function changeKey(field: Field, value: string) {
    if (locked()) return;
    setDrafts(old => ({ ...old, [field.key]: { baseline: old[field.key]?.baseline ?? settings()?.[field.key] ?? field.defaultValue ?? '', value } }));
  }
  function discardKey(key: string) {
    setDrafts(old => { const next = { ...old }; delete next[key]; return next; });
  }
  async function discardAll() {
    if (!await confirmDialog({ title: t('set_discard_all'), body: t('set_discard_all_confirm'), confirmLabel: t('set_discard_all'), tone: 'danger' })) return;
    setDrafts({});
  }
  /* Every staged draft is validated and written once; conflict review happens
   * once per batch, not once per key. */
  async function applyAll() {
    if (locked()) return;
    const staged = draftEntries();
    if (!staged.length) { setReviewOpen(false); return; }
    for (const entry of staged) {
      const field = entry.field!;
      const value = entry.value.trim();
      if (field.choices && !field.choices.some(choice => choice.value === value && !choice.disabled)) return;
      if (field.range && (!/^\d+$/.test(value) || Number(value) < field.range[0] || Number(value) > field.range[1])) {
        showToast(t(field.label) + ': ' + t('tools_invalid_number') + ` ${field.range[0]}–${field.range[1]}`, 'err');
        return;
      }
      if (field.key === 'DNS_MODE' &&
          ((value === 'transparent' && transparentAvailable() === false) ||
           (value === 'hijack' && hijackAvailable() === false))) return;
    }
    const safe = safeApply();
    setReviewOpen(false);
    const fresh = await loadSettings();
    if (fresh === undefined || locked()) return;
    const stagedKeys = new Set(staged.map(entry => entry.key));
    const conflicts = draftEntries().filter(entry => stagedKeys.has(entry.key) && entry.baseline !== settings()?.[entry.key]);
    if (conflicts.length && !await confirmDialog({
      title: t('confirm_conflict_title'),
      body: t('tools_draft_conflict') + '\n\n' + conflicts.map(entry => t(entry.field!.label)).join('\n'),
      confirmLabel: t('confirm_overwrite'),
    })) return;
    if (locked()) return;
    settingsLoad++;
    let failed = false;
    for (const entry of draftEntries()) {
      if (!stagedKeys.has(entry.key)) continue;
      const res = await startTask('settings-save', 'settings-set', entry.key, entry.value.trim()).promise;
      if (disposed) return;
      if (!res.ok) {
        if (!res.cancelled) toastApiError(t('op_failed'), res);
        failed = true;
        break;
      }
      setSettings(old => ({ ...old, [entry.key]: entry.value.trim() }));
      discardKey(entry.key);
      if (res.applied !== true) setRestartRequired(true);
    }
    void loadSettings();
    if (failed || disposed || !restartRequired()) return;
    if (safe && trialStart) {
      await trialStart('saved', '120');
    } else if (!safe) {
      await applySavedSettings(true);
    }
  }
  async function applySavedSettings(confirmed = false) {
    if (locked() || trialActive()) return;
    if (!confirmed && !await confirmDialog({ title: t('confirm_apply_title'), body: t('tools_network_warning'), confirmLabel: t('tools_restart') })) return;
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
  /* The shell bar routes apply intents here; the review dialog is the single
   * confirmation for the whole batch. The flag survives remounts. */
  createEffect(() => {
    if (applyRequested() && draftEntries().length && !locked() && !reviewOpen()) {
      setApplyRequested(false);
      setSafeApply(true);
      setReviewOpen(true);
    }
  });
  onMount(() => {
    void loadTransparentCapability();
  });
  pollWhileVisible(() => draftReady.then(() => saving() ? undefined : loadSettings()), () => viewPollInterval(10000));
  function fieldRow(field: Field): JSX.Element {
    const value = () => drafts()[field.key]?.value ?? settings()?.[field.key] ?? field.defaultValue ?? '';
    const changed = () => drafts()[field.key] && value() !== settings()?.[field.key];
    // When a kernel probe reports an interception path is impossible, pin the
    // choice as disabled and replace its hint with the reason. Doing it
    // per-row keeps the change scoped to DNS_MODE without touching the shared
    // schema.
    const choices = () => {
      if (field.key !== 'DNS_MODE' || !field.choices) return field.choices;
      return field.choices.map((choice) => {
        if (choice.value === 'transparent' && transparentAvailable() === false) {
          return { ...choice, disabled: true, hint: 'tools_dns_mode_transparent_unavailable' as const };
        }
        if (choice.value === 'hijack' && hijackAvailable() === false) {
          return { ...choice, disabled: true, hint: 'tools_dns_mode_hijack_unavailable' as const };
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
          <Show when={field.key === 'DNS_MODE' && hijackAvailable() === false && hijackReason()}>
            <span class="tool-hint" data-testid="dns-hijack-unavailable">{hijackReason()}</span>
          </Show>
          <Show when={changed()}>
            <p role="status">{t(drafts()[field.key]?.baseline !== settings()?.[field.key] ? 'tools_draft_conflict' : 'tools_draft_changed')}</p>
            <div class="tool-actions">
              <Button variant="text" disabled={locked()} onClick={() => discardKey(field.key)}>{t('tools_discard')}</Button>
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
      <div class="tool-links">
        <For each={[
          { route: 'account', icon: 'person' as const, label: 'acc_title' as const, desc: 'tools_account_desc' as const },
          { route: 'logs', icon: 'article' as const, label: 'logs_title' as const, desc: 'tools_logs_desc' as const },
          { route: 'diag', icon: 'bug_report' as const, label: 'diag_title' as const, desc: 'tools_diag_desc' as const },
        ]}>
          {(item) => (
            <a class="tool-link" href={'#/' + item.route}>
              <span class="tool-link-icon"><MdIcon name={item.icon} size={22} /></span>
              <span class="tool-link-copy">
                <span class="tool-link-name">{t(item.label)}</span>
                <span class="tool-link-desc">{t(item.desc)}</span>
              </span>
              <MdIcon name="chevron_right" size={19} />
            </a>
          )}
        </For>
      </div>
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
          <Show when={draftEntries().length}>
            <div class="tool-pending" role="status">
              <div class="toolbar">
                <MdIcon name="pending" size={20} />
                <strong>{tf('pending_changes', { count: draftEntries().length })}</strong>
              </div>
              <div class="tool-actions">
                <Button variant="text" disabled={locked()} onClick={() => void discardAll()}>
                  {t('set_discard_all')}
                </Button>
                <Button disabled={locked()} onClick={() => { setSafeApply(true); setReviewOpen(true); }}>
                  {t('set_apply_all')}
                </Button>
              </div>
            </div>
          </Show>
        </Show>
      </Show>
      <SettingsTrial locked={locked()} onActive={setTrialActive} onUpdate={loadSettings}
        expose={api => { trialStart = api.start; }} />
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
      <Dialog
        open={reviewOpen()}
        headline={t('set_review_title')}
        onClose={() => setReviewOpen(false)}
        actions={<>
          <Button variant="text" data-dialog-action="cancel" onClick={() => setReviewOpen(false)}>
            {t('cancel')}
          </Button>
          <Button data-dialog-action="confirm" onClick={() => void applyAll()}>
            {t('set_apply_all')}
          </Button>
        </>}
      >
        <div class="pending-review-list">
          <For each={draftEntries()}>
            {(entry) => (
              <div class="pending-review-row">
                <strong>{t(entry.field!.label)}</strong>
                <span class="pending-review-change">
                  <code>{entry.baseline || '—'}</code> → <code>{entry.value}</code>
                </span>
                <Show when={entry.baseline !== settings()?.[entry.key]}>
                  <span class="tool-hint">{t('tools_draft_conflict')}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
        <label class="pending-review-safe">
          <Checkbox
            checked={safeApply()}
            onChange={(event) => setSafeApply((event.target as HTMLInputElement).checked)}
          />
          <span>{t('set_safe_apply')}</span>
        </label>
      </Dialog>
    </div>
  );
}
