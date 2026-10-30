import { createEffect, createRoot, createSignal, on } from 'solid-js';
import { api, hasRoot, nativeControl, refreshNativeControl } from './api';
import { getTask, startTask, type Task } from './tasks';
import { t, type I18nKey } from './i18n';
import { connState, refreshStatus, status, statusError, statusLoading, type StatusSnapshot } from './state';
import type { IconName } from './icons';
import { requestNative } from './native';
import { confirmDialog } from './components/ConfirmDialog';
import { showToast, toastApiError } from './components/Toast';

export type ServiceAction = 'start' | 'stop' | 'restart' | 'mode';
export const RUN_MODES = ['tun', 'bridge', 'proxy'] as const;
export type RunMode = (typeof RUN_MODES)[number];
export const MODE_LABELS: Record<RunMode, I18nKey> = { tun: 'net_mode_tun', bridge: 'net_mode_bridge', proxy: 'net_mode_proxy' };
type ExpectedState = { running: boolean; mode: string; action: ServiceAction; configPending?: boolean };
type Feedback = { key: I18nKey; tone: 'info' | 'warning'; settings?: boolean; unconfirmed?: boolean };

const [busy, setBusy] = createSignal<ServiceAction | 'refresh' | null>(null);
const [phase, setPhase] = createSignal<'confirm' | 'run' | 'verify' | null>(null);
const [pending, setPending] = createSignal<ExpectedState | null>(null);
const [feedback, setFeedback] = createSignal<Feedback | null>(null);
export { busy as serviceBusy, pending as servicePending, feedback as serviceFeedback };

export function knownSnapshot(snapshot: StatusSnapshot | null): snapshot is StatusSnapshot {
  return Boolean(snapshot?.ok && ['running', 'stopped'].includes(snapshot.daemon || '') &&
    !(snapshot.daemon === 'stopped' && snapshot.backend === 'unreachable') &&
    RUN_MODES.includes(snapshot.mode as RunMode));
}
export const serviceKnown = () => !statusLoading() && !statusError() && knownSnapshot(status());
export const serviceRunning = () => status()?.daemon === 'running';
export const serviceMode = () => status()?.mode || '';
export const serviceModeLabel = (): I18nKey | null => RUN_MODES.includes(serviceMode() as RunMode) ? MODE_LABELS[serviceMode() as RunMode] : null;
const serviceTask = () => getTask('service-control');
export const serviceOperationRunning = () => serviceTask()?.status === 'running' || (serviceTask()?.status === 'unknown' && nativeControl().unknown);
export const serviceCanWrite = () => hasRoot && serviceKnown() && nativeControl().canWrite && !nativeControl().busy;
export const serviceLocked = () => !serviceCanWrite() || Boolean(busy()) || Boolean(pending()) || serviceOperationRunning();
export const emergencyStopAvailable = () => nativeControl().canStop && !nativeControl().canWrite && !nativeControl().busy;

const matches = (snapshot: StatusSnapshot | null, expected: ExpectedState) =>
  knownSnapshot(snapshot) && (snapshot.daemon === 'running') === expected.running && snapshot.mode === expected.mode;

function finish(expected: ExpectedState) {
  if (expected.configPending) {
    setFeedback({ key: 'net_controls_config_pending', tone: 'warning', settings: true });
    showToast(t('set_restart_required'), 'info');
  } else {
    setFeedback(null);
    showToast(t(expected.action === 'mode' ? 'net_controls_mode_applied' : 'dash_action_done'), 'ok');
  }
}

async function reconcile(task: Task) {
  if (!task.result) return;
  if (!task.args.length) { await refreshStatus({ afterCurrent: true }); return; }
  const action = task.cmd === 'mode-set' ? 'mode' : task.args[0] as ServiceAction;
  const expected: ExpectedState = {
    action,
    running: action !== 'stop',
    mode: action === 'mode' ? String(task.args[0]) : serviceMode(),
    configPending: task.result.applied === false || task.result.restartRequired === true,
  };
  setBusy(action);
  setPhase('verify');
  try {
    const observed = await refreshStatus({ afterCurrent: true });
    if (serviceTask()?.call !== task.call) return;
    if (!task.result.ok || task.result.cancelled) {
      setFeedback({ key: 'net_controls_result_unknown', tone: 'warning', unconfirmed: true });
      if (!task.result.cancelled && !(action !== 'restart' && action !== 'mode' && matches(observed, expected))) toastApiError(t('op_failed'), task.result);
    } else if (!observed || !matches(observed, expected)) {
      setPending(expected);
      setFeedback({ key: 'net_controls_pending', tone: 'warning' });
    } else finish(expected);
  } finally {
    setBusy(null);
    setPhase(null);
  }
}

let initialized = false;
export function initServiceControl(): void {
  if (initialized) return;
  initialized = true;
  createRoot(() => {
    createEffect(() => {
      const expected = pending();
      if (expected && serviceKnown() && matches(status(), expected)) {
        setPending(null);
        finish(expected);
      }
    });
    let reconciledCall = serviceTask()?.result ? serviceTask()?.call : undefined;
    createEffect(on(serviceTask, task => {
      if (!task?.result || task.call === reconciledCall) return;
      reconciledCall = task.call;
      void reconcile(task);
    }));
  });
}

export async function runService(action: ServiceAction, nextMode?: string, options: { confirm?: boolean } = {}): Promise<void> {
  if (serviceLocked()) return;
  if (action === 'mode' && (!nextMode || !RUN_MODES.includes(nextMode as RunMode) || nextMode === serviceMode())) return;
  setBusy(action);
  setFeedback(null);
  try {
    if (action !== 'start' && options.confirm !== false) {
      setPhase('confirm');
      const approved = await confirmDialog(
        action === 'mode'
          ? { title: t('confirm_mode_title'), body: t('net_mode_confirm'), confirmLabel: t('net_mode_switch') }
          : action === 'stop'
            ? { title: t('confirm_stop_title'), body: t('net_stop_confirm'), confirmLabel: t('native_stop'), tone: 'danger' }
            : { title: t('confirm_restart_title'), body: t('net_restart_confirm'), confirmLabel: t('dash_restart') },
      );
      if (!approved) return;
    }
    if (!serviceCanWrite() || serviceOperationRunning()) return;
    setPhase('run');
    if (action === 'mode') startTask('service-control', 'mode-set', nextMode!);
    else startTask('service-control', 'control', action);
  } finally {
    setBusy(null);
    setPhase(null);
  }
}

export async function verifyService(): Promise<void> {
  if (busy()) return;
  setBusy('refresh');
  setPhase('verify');
  try {
    const expected = pending();
    const observed = await refreshStatus({ afterCurrent: true });
    if (!expected && knownSnapshot(observed)) setFeedback(null);
    if (expected && knownSnapshot(observed) && !matches(observed, expected)) {
      setPending(null);
      setFeedback({ key: 'net_controls_mismatch', tone: 'warning' });
    }
  } finally {
    setBusy(null);
    setPhase(null);
  }
}

export async function emergencyStop(): Promise<void> {
  if (!await confirmDialog({ title: t('confirm_stop_title'), body: t('net_stop_confirm'), confirmLabel: t('native_stop'), tone: 'danger' })) return;
  const result = await api('control', 'stop');
  if (!result.ok) toastApiError(t('op_failed'), result);
  await refreshStatus({ afterCurrent: true });
}

export const serviceMessage = (): string =>
  serviceOperationRunning() && serviceTask()?.call.timedOut ? t('task_timeout_running')
    : serviceOperationRunning() && !busy() ? t('net_working')
      : phase() === 'confirm' ? t('net_controls_awaiting_confirm')
        : phase() === 'verify' ? t('net_controls_verifying')
          : phase() === 'run' ? t('net_working')
            : feedback()?.unconfirmed ? t(!serviceKnown() ? 'net_controls_result_unknown' : serviceRunning() ? 'net_controls_response_running' : 'net_controls_response_stopped')
              : feedback() ? t(feedback()!.key)
                : !serviceKnown() && !statusLoading() ? t('net_controls_unknown') : '';
export const serviceNeedsVerify = () => !busy() && !serviceOperationRunning() && Boolean(pending() || !serviceKnown() || feedback()?.unconfirmed);
export const serviceWarning = () => feedback()?.tone === 'warning' || !serviceKnown();

export type NativeIssue = { kind: 'unknown' | 'busy' | 'checking' | 'incompatible'; message: string };
export function nativeIssue(): NativeIssue | null {
  const control = nativeControl();
  if (!hasRoot) return null;
  if (control.unknown) return { kind: 'unknown', message: t('native_unknown') };
  if (control.checking) return { kind: 'checking', message: t('native_checking') };
  if (!control.compatible) return { kind: 'incompatible', message: control.message || t('native_incompatible') };
  if (control.busy && !serviceOperationRunning()) return { kind: 'busy', message: control.message || t('shell_task_running') };
  return null;
}
export type ConnectionView = 'loading' | 'unavailable' | 'issue' | 'error' | 'stopped' | 'login' | 'starting' | 'running' | 'unknown';
export function connectionView(): ConnectionView {
  if (!hasRoot) return 'unavailable';
  const issue = nativeIssue();
  if (issue && issue.kind !== 'busy') return 'issue';
  if (statusLoading() && !status()) return 'loading';
  if (statusError() || !status()) return 'error';
  const state = connState(status());
  return state === 'needs-login' ? 'login' : state;
}
const VIEW_COPY: Record<ConnectionView, { title: I18nKey; hint: I18nKey; icon: IconName; tone: 'ok' | 'warn' | 'off' }> = {
  loading: { title: 'loading', hint: 'loading', icon: 'sync', tone: 'off' },
  unavailable: { title: 'dash_unavailable', hint: 'no_root_banner', icon: 'error', tone: 'warn' },
  issue: { title: 'dash_unavailable', hint: 'native_incompatible', icon: 'warning', tone: 'warn' },
  error: { title: 'dash_status_error', hint: 'net_unknown_hint', icon: 'error', tone: 'warn' },
  stopped: { title: 'shell_stopped', hint: 'net_stopped_hint', icon: 'power_settings_new', tone: 'off' },
  login: { title: 'hero_login_title', hint: 'net_login_hint', icon: 'vpn_key', tone: 'warn' },
  starting: { title: 'net_connecting', hint: 'net_connecting_hint', icon: 'sync', tone: 'warn' },
  running: { title: 'net_connected', hint: 'net_connected_hint', icon: 'check_circle', tone: 'ok' },
  unknown: { title: 'net_status_stale', hint: 'net_unknown_hint', icon: 'error', tone: 'warn' },
};
export function connectionCopy() {
  const view = connectionView();
  const copy = VIEW_COPY[view];
  const issue = view === 'issue' ? nativeIssue() : null;
  return {
    view, icon: copy.icon, tone: copy.tone,
    title: issue?.kind === 'unknown' ? t('shell_task_unknown') : issue?.kind === 'checking' ? t('native_checking') : t(copy.title),
    hint: issue ? issue.message : view === 'error' && statusError() ? statusError()! : t(copy.hint),
  };
}
export function exitNodeLabel(): string {
  const route = status()?.exitRouting;
  if (!status()?.ok || !route?.known) return t('net_exit_unknown');
  const selected = route.selected;
  if (!selected) return t('net_exit_local');
  if (selected.auto) return `${t('dash_exit_auto')} · ${selected.auto}`;
  const peer = selected.id ? status()?.peerList?.find(p => p.id === selected.id) : undefined;
  return peer?.hostname || selected.ip || selected.id || t('net_exit_unknown');
}
export function connectionChip(): { label: I18nKey; tone: 'ok' | 'warn' | 'off' } {
  const view = connectionView();
  if (view === 'running') return { label: 'shell_connected', tone: 'ok' };
  if (view === 'stopped') return { label: 'shell_stopped', tone: 'off' };
  if (view === 'login') return { label: 'shell_login', tone: 'warn' };
  if (view === 'starting' || view === 'loading') return { label: 'shell_starting', tone: 'warn' };
  if (view === 'error') return { label: 'dash_status_stale', tone: 'warn' };
  return { label: 'shell_unknown', tone: 'warn' };
}
export function recheckNative(): void { void refreshNativeControl(); }
export function cancelNativeOperation(): void {
  const id = nativeControl().id;
  if (id) void requestNative('control.cancel', { id }).then(result => { if (!result.ok) toastApiError(t('op_failed'), result); });
}
export function acknowledgeNative(): void {
  void requestNative('control.acknowledge').then(result => { if (!result.ok) toastApiError(t('op_failed'), result); });
}
