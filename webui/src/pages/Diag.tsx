import { Show, type JSX } from 'solid-js';
import { t } from '../i18n';
import { getTask } from '../tasks';
import { Card, EmptyState, ErrorState, StatusBadge } from '../components/Basics';
import { copyText } from '../components/LoginHero';
import { showToast } from '../components/Toast';
import { TaskButton, TaskProgress } from '../components/TaskProgress';
import { MdIcon } from '../icons';
import { Button } from '../components/ui';
import './tools.css';
const TASK_KEY = 'diag';
export default function Diag(): JSX.Element {
  const task = () => getTask(TASK_KEY);
  const path = () => String(task()?.result?.path ?? '');
  return (
    <div class="tools-page">
      <Card title={t('tools_diag_collect')} icon="bug_report" description={t('tools_diag_contents')}>
        <TaskProgress taskKey={TASK_KEY} />
        <Show when={task()?.status === 'running'}>
          <div class="tool-result" aria-live="polite">
            <StatusBadge tone="accent">{t('diag_running')}</StatusBadge>
          </div>
        </Show>
        <Show when={task()?.status === 'error'}>
          <ErrorState text={task()?.result?.error || t('error')} />
        </Show>
        <div class="tool-actions">
          <TaskButton
            taskKey={TASK_KEY}
            cmd="diag"
            label={t('diag_run')}
            icon={<MdIcon name="bug_report" size={18} />}
          />
        </div>
      </Card>
      <Card title={t('tools_diag_ready')} icon="folder">
        <Show
          when={task()?.status === 'done' && path()}
          fallback={<EmptyState text={t('tools_diag_waiting')} icon="folder" />}
        >
          <StatusBadge tone="success">{t('diag_done')}</StatusBadge>
          <div class="tool-result">
            <p class="mono">{path()}</p>
            <Button
              variant="tonal"
              onClick={() => showToast(t(copyText(path()) ? 'copied' : 'op_failed'), 'info')}
            >
              <MdIcon name="content_copy" size={18} />
              {t('tools_copy_path')}
            </Button>
          </div>
        </Show>
      </Card>
    </div>
  );
}
