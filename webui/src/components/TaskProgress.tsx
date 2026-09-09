/* Progress row + cancel button for a session-level heavy task, plus a
 * start-button helper. Pages render task results themselves from
 * getTask(key).result. */
import { createSignal, Show, type JSX } from 'solid-js';
import { getTask, cancelTask, startTask } from '../tasks';
import { t } from '../i18n';
import { showToast, toastApiError } from './Toast';
import { hasRoot } from '../api';
import { MdIcon } from '../icons';
import { Button, LinearProgress } from './ui';

export function TaskProgress(props: { taskKey: string; cancellable?: boolean }): JSX.Element {
  const running = () => getTask(props.taskKey)?.status === 'running';
  const [cancelling, setCancelling] = createSignal(false);
  return (
    <Show when={running()}>
      <div class="task-progress" role="status">
        <div class="task-progress-heading"><span class="task-progress-icon"><MdIcon name="sync" size={18} /></span><span><strong>{t('shell_task_running')}</strong><span class="task-progress-hint">{t('shell_task_keep_running')}</span></span></div>
        <div class="progress-row">
        <LinearProgress indeterminate aria-label={t('shell_task_running')} />
        <Show when={props.cancellable !== false}>
        <Button
          variant="text"
          busy={cancelling()}
          onClick={() => {
            if (cancelling()) return;
            setCancelling(true);
            void cancelTask(props.taskKey).then((res) => {
              setCancelling(false);
              if (res.ok) showToast(t('cancelled'), 'info');
              else toastApiError(t('op_failed'), res);
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
