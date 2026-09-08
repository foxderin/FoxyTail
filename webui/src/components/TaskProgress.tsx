/* Progress row + cancel button for a session-level heavy task, plus a
 * start-button helper. Pages render task results themselves from
 * getTask(key).result. */
import { Show, type JSX } from 'solid-js';
import { getTask, cancelTask, startTask } from '../tasks';
import { t } from '../i18n';
import { showToast } from './Toast';
import { hasRoot } from '../api';

export function TaskProgress(props: { taskKey: string }): JSX.Element {
  const running = () => getTask(props.taskKey)?.status === 'running';
  return (
    <Show when={running()}>
      <div class="progress-row" role="status">
        <md-linear-progress indeterminate />
        <md-text-button
          onClick={() => {
            cancelTask(props.taskKey);
            showToast(t('cancelled'), 'info');
          }}
        >
          {t('cancel')}
        </md-text-button>
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
    <md-filled-button
      disabled={running() || props.disabled || !hasRoot || undefined}
      onClick={() => {
        if (running()) return;
        startTask(props.taskKey, props.cmd, ...(props.args ?? []));
      }}
    >
      {props.icon}
      {props.label}
    </md-filled-button>
  );
}
