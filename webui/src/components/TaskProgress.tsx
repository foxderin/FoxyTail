/* Progress row + cancel button for a session-level heavy task, plus a
 * start-button helper. Pages render task results themselves from
 * getTask(key).result. */
import { Show, type JSX } from 'solid-js';
import { getTask, cancelTask, startTask } from '../tasks';
import { t } from '../i18n';
import { showToast, toastApiError } from './Toast';
import { hasRoot } from '../api';
import { MdIcon } from '../icons';
import { Button, LinearProgress } from './ui';

export function TaskProgress(props: { taskKey: string; cancellable?: boolean }): JSX.Element {
  const task = () => getTask(props.taskKey);
  const running = () => task()?.status === 'running';
  const cancelling = () => task()?.call.cancellation === 'requested';
  return (
    <Show when={running()}>
      <div class="task-progress" role="status" data-task-key={props.taskKey} data-cancellation={task()?.call.cancellation} data-timed-out={task()?.call.timedOut || undefined}>
        <div class="task-progress-heading"><span class="task-progress-icon"><MdIcon name="sync" size={18} /></span><span><strong>{t(task()?.call.timedOut ? 'task_timeout_running' : 'shell_task_running')}</strong><span class="task-progress-hint">{t(cancelling() ? 'task_cancel_pending' : task()?.call.cancellation === 'failed' ? 'task_cancel_failed' : 'shell_task_keep_running')}</span></span></div>
        <Show when={task()?.call.cancellationError}><p class="tool-hint">{task()?.call.cancellationError}</p></Show>
        <div class="progress-row">
        <LinearProgress indeterminate aria-label={t('shell_task_running')} />
        <Show when={props.cancellable !== false && task()?.call.cancellable}>
        <Button
          variant="text"
          busy={cancelling()}
          onClick={() => {
            if (cancelling()) return;
            void cancelTask(props.taskKey).then((res) => {
              if (res.cancelled) showToast(t('cancelled'), 'info');
              else if (!res.ok) toastApiError(t('op_failed'), res);
            });
          }}
        >
          {t('cancel')}
        </Button>
        </Show>
        </div>
      </div>
    </Show>
  );
}

/* Filled button that starts a task; disables itself (no double-click) while
 * the same-key task is running. Re-pressing after completion replaces the
 * cached result with a fresh run. */
export function TaskButton(props: {
  taskKey: string;
  cmd: string;
  args?: (string | number)[];
  label: string;
  icon?: JSX.Element;
  disabled?: boolean;
}): JSX.Element {
  const running = () => getTask(props.taskKey)?.status === 'running';
  return (
    <Button
      variant="filled"
      busy={running()}
      disabled={running() || props.disabled || !hasRoot}
      onClick={() => {
        if (running()) return;
        startTask(props.taskKey, props.cmd, ...(props.args ?? []));
      }}
    >
      <Show when={!running()}>{props.icon}</Show>
      {props.label}
    </Button>
  );
}
