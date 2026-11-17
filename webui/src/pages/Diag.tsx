import { createSignal, For, Show, type JSX } from 'solid-js';
import { t, type I18nKey } from '../i18n';
import { getTask, startTask } from '../tasks';
import { Card, EmptyState, ErrorState, StatusBadge } from '../components/Basics';
import { copyWithToast } from '../clipboard';
import { TaskButton, TaskProgress } from '../components/TaskProgress';
import { MdIcon } from '../icons';
import { Button, Select } from '../components/ui';
import { requestNative } from '../native';
import { confirmDialog } from '../components/ConfirmDialog';
import { toastApiError } from '../components/Toast';
import { artifactExport } from '../backup';
import { nativeControl } from '../api';
import DiagnosticDetails from './DiagnosticDetails';
import './tools.css';
const TASK_KEY = 'diag';
const LABELS: Record<string, I18nKey> = {
  config: 'diag_item_config', service: 'diag_item_service', tunnel: 'diag_item_tunnel',
  routes: 'diag_item_routes', dns: 'dns_title',
};
const REASONS: Record<string, I18nKey> = {
  invalid_config: 'diag_invalid_config', pending: 'diag_pending', applied: 'diag_applied',
  stopped: 'diag_stopped', connected: 'diag_connected', login: 'diag_login', unreachable: 'diag_unreachable',
  needs_connection: 'diag_needs_connection', proxy: 'diag_proxy', interface_ready: 'diag_interface_ready',
  interface_missing: 'diag_interface_missing', managed_routes: 'diag_managed_routes',
  routes_ready: 'diag_routes_ready', routes_incomplete: 'diag_routes_incomplete',
  dns_disabled: 'diag_dns_disabled', dns_conflict: 'diag_dns_conflict', dns_limited: 'diag_dns_limited',
  dns_ready: 'diag_dns_ready', dns_unavailable: 'diag_dns_unavailable',
};
interface Check { id: string; level: string; reason: string; page: string }
export default function Diag(): JSX.Element {
  const [mode, setMode] = createSignal('share');
  const [exportBusy, setExportBusy] = createSignal(false);
  async function collect() {
    const selected = mode();
    if (selected === 'local' && !await confirmDialog({ body: t('diag_local_hint'), confirmLabel: t('diag_run') })) return;
    if (!nativeControl().canWrite || nativeControl().busy) return;
    await startTask(TASK_KEY, 'diag', selected).promise;
  }
  async function exportBundle(share: boolean) {
    const result = task()?.result;
    if (exportBusy() || !result || !path()) return;
    if (share && !await confirmDialog({ title: t('confirm_share_title'), body: t(result.mode === 'local' ? 'diag_local_hint' : 'tools_diag_sensitive'), confirmLabel: t('tools_share') })) return;
    setExportBusy(true);
    const exported = await requestNative(share ? 'artifact.share' : 'artifact.save', {
      token: result.artifactId, name: `foxytail-diagnostics-${result.mode}.tar.gz`,
    });
    setExportBusy(false);
    if (!exported.ok && !exported.cancelled) toastApiError(t('op_failed'), exported);
  }
  const task = () => getTask(TASK_KEY);
  const check = () => getTask('diag-check');
  const checks = () => {
    const rows = check()?.status === 'done' ? check()?.result?.checks : null;
    return Array.isArray(rows) && rows.every(row => row &&
      typeof row.id === 'string' && typeof row.reason === 'string' &&
      ['pass', 'warn', 'fail', 'skip'].includes(row.level) &&
      ['settings', 'dashboard', 'account', 'logs', 'tunnel', 'routing'].includes(row.page)) ? rows as Check[] : [];
  };
  const path = () => {
    const value = task()?.result?.path;
    return task()?.status === 'done' && typeof task()?.result?.artifactId === 'string' &&
      /^art-[a-f0-9]{32}$/.test(String(task()?.result?.artifactId)) && ['share', 'local'].includes(String(task()?.result?.mode)) &&
      typeof value === 'string' && value.startsWith('/') && value.endsWith('.tar.gz') &&
      !/[\x00-\x1f\x7f]/.test(value) ? value : '';
  };
  return (
    <div class="tools-page">
      <Show when={artifactExport()?.busy}>
        <div class="tool-result" role="status">
          <p>{artifactExport()?.message} · {artifactExport()?.bytes} B</p>
          <Button disabled={artifactExport()?.committing} onClick={async () => {
            const result = await requestNative('files.cancelExport'); if (!result.ok) toastApiError(t('op_failed'), result);
          }}>{t('cancel')}</Button>
        </div>
      </Show>
      <Card title={t('diag_check')} icon="network_check" description={t('diag_check_hint')}>
        <TaskProgress taskKey="diag-check" />
        <div class="tool-actions"><TaskButton taskKey="diag-check" cmd="diag-check" label={t('diag_check')} /></div>
        <Show when={check()?.status === 'error'}><ErrorState text={check()?.result?.error || t('error')} /></Show>
        <Show when={check()?.status === 'done' && !checks().length}><ErrorState text={t('diag_unknown')} /></Show>
        <div aria-live="polite" data-testid="diag-checks">
          <For each={checks()}>{row => <div class="tool-result" data-level={row.level}>
            <StatusBadge tone={row.level === 'pass' ? 'success' : row.level === 'fail' ? 'danger' : row.level === 'warn' ? 'warning' : 'neutral'}>
              {t(LABELS[row.id] || 'diag_title')} · {t(('diag_level_' + row.level) as I18nKey)}
            </StatusBadge>
            <p>{t(REASONS[row.reason] || 'diag_unknown')}</p>
            <Show when={row.level === 'fail' || row.level === 'warn'}>
              <a href={'#/' + row.page}>{t('diag_view_details')}</a>
            </Show>
          </div>}</For>
        </div>
      </Card>
      <DiagnosticDetails locked={!nativeControl().canWrite || nativeControl().busy} />
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
        <Select label={t('diag_bundle_mode')} aria-label={t('diag_bundle_mode')} value={mode()}
          disabled={task()?.status === 'running'} onChange={event => setMode((event.target as HTMLSelectElement).value)}>
          <option value="share">{t('diag_share')}</option>
          <option value="local">{t('diag_local')}</option>
        </Select>
        <p class="tool-hint">{t(mode() === 'share' ? 'diag_share_hint' : 'diag_local_hint')}</p>
        <div class="tool-actions">
          <Button disabled={!nativeControl().canWrite || nativeControl().busy || task()?.status === 'running'} busy={task()?.status === 'running'} onClick={() => void collect()}>
            <MdIcon name="bug_report" size={18} />{t('diag_run')}
          </Button>
        </div>
      </Card>
      <Card title={t(path() ? 'tools_diag_ready' : 'tools_diag_bundle')} icon="folder">
        <Show when={task()?.status === 'done' && !path()}><ErrorState text={t('diag_unknown')} /></Show>
        <Show
          when={task()?.status === 'done' && path()}
          fallback={<EmptyState text={t('tools_diag_waiting')} icon="folder" />}
        >
          <StatusBadge tone="success">{t('diag_done')}</StatusBadge>
          <p class="tool-hint">{t(task()?.result?.mode === 'share' ? 'diag_share' : 'diag_local')}</p>
          <div class="tool-result">
            <p class="mono">{path()}</p>
            <Button
              variant="tonal"
              onClick={() => copyWithToast(path(), 'info')}
            >
              <MdIcon name="content_copy" size={18} />
              {t('tools_copy_path')}
            </Button>
            <div class="tool-actions">
              <Button disabled={exportBusy()} onClick={() => void exportBundle(false)}><MdIcon name="save" size={18} />{t('save')}</Button>
              <Button disabled={exportBusy()} onClick={() => void exportBundle(true)}><MdIcon name="share" size={18} />{t('tools_share')}</Button>
            </div>
          </div>
        </Show>
      </Card>
    </div>
  );
}
