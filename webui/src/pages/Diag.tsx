/*
 * Diagnostics — one-tap bundle collection as a cancellable session task
 * (can take ~30s), result path shown inline.
 */
import { Show, type JSX } from 'solid-js';
import { t } from '../i18n';
import { getTask } from '../tasks';
import { Card, ErrorState } from '../components/Basics';
import { TaskButton, TaskProgress } from '../components/TaskProgress';
import { MdIcon } from '../icons';

const TASK_KEY = 'diag';

export default function Diag(): JSX.Element {
  const task = () => getTask(TASK_KEY);

  return (
    <Card title={t('diag_title')} icon="bug_report">
      <p class="dim">{t('diag_hint')}</p>

      <TaskProgress taskKey={TASK_KEY} />
      <Show when={task()?.status === 'running'}>
        <div class="dim">{t('diag_running')}</div>
      </Show>
      <Show when={task()?.status === 'done'}>
        <div class="banner ok">
          <MdIcon name="check_circle" size={18} />
          <span>{t('diag_done')}</span>
        </div>
        <p class="mono">{String(task()?.result?.path ?? '')}</p>
      </Show>
      <Show when={task()?.status === 'error'}>
        <ErrorState text={task()?.result?.error || t('error')} />
      </Show>

      <div class="btn-row">
        <TaskButton
          taskKey={TASK_KEY}
          cmd="diag"
          label={t('diag_run')}
          icon={<MdIcon name="bug_report" size={18} />}
        />
      </div>
    </Card>
  );
}
