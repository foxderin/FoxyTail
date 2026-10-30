/** Persistent shell controls. Shared status is the only source of visible state. */
import {
  createEffect,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  Show,
  type JSX,
} from 'solid-js';
import { hasRoot, nativeControl, api } from '../api';
import { getTask, startTask, type Task } from '../tasks';
import { t, type I18nKey } from '../i18n';
import {
  refreshStatus,
  status,
  statusError,
  statusLoading,
  type StatusSnapshot,
} from '../state';
import { MdIcon } from '../icons';
import { confirmDialog } from './ConfirmDialog';
import { showToast, toastApiError } from './Toast';
import { Button, CircularProgress, IconButton, Select, Switch } from './ui';

type ServiceAction = 'start' | 'stop' | 'restart' | 'mode';
type ExpectedState = {
  running: boolean;
  mode: string;
  action: ServiceAction;
  configPending?: boolean;
};
type Feedback = { key: I18nKey; tone: 'info' | 'warning'; settings?: boolean; unconfirmed?: boolean };
const MODES = ['tun', 'bridge', 'proxy'] as const;

export function ServiceControls(): JSX.Element {
  const feedbackId = createUniqueId();
  let container!: HTMLDivElement;
  let disposed = false;
  const [busy, setBusy] = createSignal<ServiceAction | 'refresh' | null>(null);
  const [phase, setPhase] = createSignal<'confirm' | 'run' | 'verify' | null>(
    null,
  );
  const [pending, setPending] = createSignal<ExpectedState | null>(null);
  const [feedback, setFeedback] = createSignal<Feedback | null>(null);
  onCleanup(() => {
    disposed = true;
  });

  const knownSnapshot = (
    snapshot: StatusSnapshot | null,
  ): snapshot is StatusSnapshot =>
    Boolean(
      snapshot?.ok &&
        ['running', 'stopped'].includes(snapshot.daemon || '') &&
        !(snapshot.daemon === 'stopped' && snapshot.backend === 'unreachable') &&
        MODES.includes(snapshot.mode as (typeof MODES)[number]),
    );
  const known = () =>
    !statusLoading() && !statusError() && knownSnapshot(status());
  const running = () => status()?.daemon === 'running';
  const mode = () => status()?.mode || '';
  const serviceTask = () => getTask('service-control');
  const operationRunning = () => serviceTask()?.status === 'running' || (serviceTask()?.status === 'unknown' && nativeControl().unknown);
  const canWrite = () => !disposed && hasRoot && known() && nativeControl().canWrite && !nativeControl().busy;
  const locked = () => !canWrite() || Boolean(busy()) || Boolean(pending()) || operationRunning();
  const matches = (snapshot: StatusSnapshot | null, expected: ExpectedState) =>
    knownSnapshot(snapshot) &&
    (snapshot.daemon === 'running') === expected.running &&
    snapshot.mode === expected.mode;

  // Native controls change before an async handler runs. Restore them explicitly;
  // unchanged Solid props alone do not roll back a rejected checkbox/select.
  function syncControls() {
    if (!container) return;
    const toggle = container.querySelector<HTMLInputElement>(
      'input[role="switch"]',
    );
    const select = container.querySelector<HTMLSelectElement>('select');
    if (toggle) toggle.checked = running();
    if (select) select.value = knownSnapshot(status()) ? mode() : '';
  }
  function confirmed(action: ServiceAction) {
    setFeedback(null);
    showToast(
      t(action === 'mode' ? 'net_controls_mode_applied' : 'dash_action_done'),
      'ok',
    );
  }
  function finish(expected: ExpectedState) {
    if (expected.configPending) {
      setFeedback({
        key: 'net_controls_config_pending',
        tone: 'warning',
        settings: true,
      });
      showToast(t('set_restart_required'), 'info');
    } else confirmed(expected.action);
  }

  // A later shared poll can resolve a pending result without a new private poller.
  createEffect(() => {
    const expected = pending();
    const snapshot = status();
    if (expected && known() && matches(snapshot, expected)) {
      setPending(null);
      finish(expected);
    }
  });

  async function reconcile(task: Task) {
    if (!task.result) return;
    if (!task.args.length) { await refreshStatus({ afterCurrent: true }); return; }
    const action = task.cmd === 'mode-set' ? 'mode' : task.args[0] as ServiceAction;
    const expected: ExpectedState = {
      action,
      running: action !== 'stop',
      mode: action === 'mode' ? String(task.args[0]) : mode(),
      configPending: task.result.applied === false || task.result.restartRequired === true,
    };
    setBusy(action);
    setPhase('verify');
    try {
      const observed = await refreshStatus({ afterCurrent: true });
      if (disposed || serviceTask()?.call !== task.call) return;
      if (!task.result.ok || task.result.cancelled) {
        setFeedback({ key: 'net_controls_result_unknown', tone: 'warning', unconfirmed: true });
        if (!task.result.cancelled && !(action !== 'restart' && action !== 'mode' && matches(observed, expected))) {
          toastApiError(t('op_failed'), task.result);
        }
      } else if (!observed || !matches(observed, expected)) {
        setPending(expected);
        setFeedback({ key: 'net_controls_pending', tone: 'warning' });
      } else finish(expected);
    } finally {
      if (!disposed) {
        setBusy(null);
        setPhase(null);
        syncControls();
      }
    }
  }
  let reconciledCall = serviceTask()?.result ? serviceTask()?.call : undefined;
  createEffect(on(serviceTask, task => {
    if (!task?.result || task.call === reconciledCall) return;
    reconciledCall = task.call;
    void reconcile(task);
  }));

  async function mutate(action: ServiceAction, nextMode?: string) {
    if (locked()) {
      syncControls();
      return;
    }
    if (
      action === 'mode' &&
      (!nextMode ||
        !MODES.includes(nextMode as (typeof MODES)[number]) ||
        nextMode === mode())
    )
      return;
    setBusy(action);
    setFeedback(null);
    try {
      if (action !== 'start') {
        setPhase('confirm');
        const approved = await confirmDialog(
          t(
            action === 'mode'
              ? 'net_mode_confirm'
              : action === 'stop'
                ? 'net_stop_confirm'
                : 'net_restart_confirm',
          ),
        );
        if (!approved || !canWrite()) return;
      }
      if (!canWrite()) return;
      setPhase('run');
      if (operationRunning()) return;
      if (action === 'mode') startTask('service-control', 'mode-set', nextMode!);
      else startTask('service-control', 'control', action);
    } finally {
      setBusy(null);
      setPhase(null);
      syncControls();
    }
  }

  async function verify() {
    if (busy() || disposed) return;
    setBusy('refresh');
    setPhase('verify');
    try {
      const expected = pending();
      const observed = await refreshStatus({ afterCurrent: true });
      if (!disposed && !expected && knownSnapshot(observed)) setFeedback(null);
      if (
        !disposed &&
        expected &&
        knownSnapshot(observed) &&
        !matches(observed, expected)
      ) {
        // An explicit check has confirmed a different device state. Release the
        // controls so the user can recover instead of trapping them in pending.
        setPending(null);
        setFeedback({ key: 'net_controls_mismatch', tone: 'warning' });
      }
    } finally {
      setBusy(null);
      setPhase(null);
      syncControls();
    }
  }
  const message = (): string =>
    operationRunning() && serviceTask()?.call.timedOut
      ? t('task_timeout_running')
      : operationRunning() && !busy()
        ? t('net_working')
      : phase() === 'confirm'
      ? t('net_controls_awaiting_confirm')
      : phase() === 'verify'
        ? t('net_controls_verifying')
        : phase() === 'run'
          ? t('net_working')
          : feedback()?.unconfirmed
            ? t(!known() ? 'net_controls_result_unknown' : running() ? 'net_controls_response_running' : 'net_controls_response_stopped')
          : feedback()
            ? t(feedback()!.key)
            : !known() && !statusLoading()
              ? t('net_controls_unknown')
              : '';

  return (
    <div
      ref={container}
      class="service-controls"
      role="group"
      aria-label={t('net_controls_label')}
      aria-busy={Boolean(busy()) || operationRunning()}
    >
      <div class="service-controls-row">
        <div class="service-controls-toggle" data-testid="service-toggle">
          <div class="service-controls-label">
            <span>{t('net_controls_service')}</span>
          </div>
          <Switch
            aria-label={t('net_controls_service') + (!known() ? ` (${t('net_unknown')})` : '')}
            aria-describedby={message() ? feedbackId : undefined}
            checked={running()}
            indeterminate={!known()}
            disabled={locked()}
            onChange={(event) => {
              const input = event.target as HTMLInputElement;
              const next = input.checked;
              input.checked = running();
              if (next !== running()) void mutate(next ? 'start' : 'stop');
            }}
          />
        </div>
        <div class="service-controls-mode" data-testid="service-mode">
          <Select
            aria-label={t('dash_mode')}
            value={knownSnapshot(status()) ? mode() : ''}
            disabled={locked()}
            onChange={(event) => {
              const select = event.target as HTMLSelectElement;
              const next = select.value;
              select.value = knownSnapshot(status()) ? mode() : '';
              void mutate('mode', next);
            }}
          >
            <option value="" disabled>
              {t('net_unknown')}
            </option>
            <option value="tun">{t('net_mode_tun')}</option>
            <option value="bridge">{t('net_mode_bridge')}</option>
            <option value="proxy">{t('net_mode_proxy')}</option>
          </Select>
        </div>
        <div class="service-controls-restart" data-testid="service-restart">
          <IconButton
            aria-label={t('dash_restart')}
            disabled={locked() || !running()}
            onClick={() => void mutate('restart')}
          >
            <Show
              when={busy() === 'restart'}
              fallback={<MdIcon name="restart_alt" size={20} />}
            >
              <CircularProgress size={20} />
            </Show>
          </IconButton>
        </div>
        <Show when={nativeControl().canStop && !nativeControl().canWrite && !nativeControl().busy}>
          <Button variant="outlined" class="danger" onClick={async () => {
            if (!await confirmDialog(t('net_stop_confirm'))) return;
            const result = await api('control', 'stop');
            if (!result.ok) toastApiError(t('op_failed'), result);
            await refreshStatus({ afterCurrent: true });
          }}><MdIcon name="stop" size={18} />{t('native_emergency_stop')}</Button>
        </Show>
      </div>
      <Show when={message()}>
        <div
          id={feedbackId}
          class="service-controls-feedback"
          classList={{
            warning: feedback()?.tone === 'warning' || !known(),
            pending: Boolean(pending()),
          }}
          role="status"
        >
          <Show
            when={busy() || operationRunning()}
            fallback={
              <MdIcon
                name={
                  feedback()?.tone === 'warning' || !known()
                    ? 'warning'
                    : 'info'
                }
                size={16}
              />
            }
          >
            <CircularProgress size={16} />
          </Show>
          <span>{message()}</span>
          <Show when={!busy() && !operationRunning() && (pending() || !known() || feedback()?.unconfirmed)}>
            <Button
              variant="text"
              class="service-controls-retry"
              onClick={() => void verify()}
            >
              {t('retry')}
            </Button>
          </Show>
          <Show when={!busy() && feedback()?.settings}>
            <a href="#/settings">{t('set_title')}</a>
          </Show>
        </div>
      </Show>
    </div>
  );
}
