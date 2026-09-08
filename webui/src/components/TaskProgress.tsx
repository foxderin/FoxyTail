/* Progress row + cancel button for a session-level heavy task, plus a
 * start-button helper. Pages render task results themselves from
 * getTask(key).result. */
import { Show, type JSX } from 'solid-js';
import { getTask, cancelTask, startTask } from '../tasks';
import { t } from '../i18n';
import { showToast } from './Toast';
import { hasRoot } from '../api';
import { Button, LinearProgress } from './ui';

export function TaskProgress(props: { taskKey: string }): JSX.Element {
  const running = () => getTask(props.taskKey)?.status === 'running';
  return (
    <Show when={running()}>
      <div class="progress-row" role="status">
        <LinearProgress indeterminate />
        <Button
          variant="text"
          onClick={() => {
            cancelTask(props.taskKey);
            showToast(t('cancelled'), 'info');
          }}
        >
          {t('cancel')}
        </Button>
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
      disabled={running() || props.disabled || !hasRoot || false}
      onClick={() => {
        if (running()) return;
        startTask(props.taskKey, props.cmd, ...(props.args ?? []));
      }}
    >
      {props.icon}
      {props.label}
    </Button>
  );
}
