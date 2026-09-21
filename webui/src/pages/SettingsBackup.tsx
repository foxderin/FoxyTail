import { createEffect, createSignal, For, Show, untrack, type JSX } from 'solid-js';
import { createApiScope } from '../api';
import { t } from '../i18n';
import { getTask } from '../tasks';
import { BACKUP_TASK, backupPath, createBackup, validBackups, validRestorePreview, type BackupFile, type RestorePreview } from '../backup';
import { Card, ErrorState } from '../components/Basics';
import { copyWithToast } from '../clipboard';
import { confirmDialog } from '../components/ConfirmDialog';
import { TaskProgress } from '../components/TaskProgress';
import { showToast, toastApiError } from '../components/Toast';
import { Button, Select } from '../components/ui';
import { createGuardedLoad } from './tools-refresh';

export default function SettingsBackup(props: {
  locked: boolean; busy: boolean; setBusy: (busy: boolean) => void;
  onPending: () => void; onRestore: () => Promise<unknown>;
}): JSX.Element {
  const scope = createApiScope();
  const [backups, setBackups] = createSignal<BackupFile[]>([]);
  const [selected, setSelected] = createSignal('');
  const [preview, setPreview] = createSignal<RestorePreview | null>(null);
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [previewBusy, setPreviewBusy] = createSignal(false);
  const [restored, setRestored] = createSignal<{ previous: string; note: string } | null>(null);
  const backupTask = () => getTask(BACKUP_TASK);
  const backupBusy = () => backupTask()?.status === 'running';
  const backupFailed = () => ['error', 'cancelled'].includes(backupTask()?.status || '');
  const load = createGuardedLoad(
    () => scope.api('backup-list'),
    (res) => {
      if (!res.ok || !validBackups(res.backups)) {
        setError(res.error || t('backup_invalid_response'));
        setBackups([]); setSelected(''); setPreview(null);
        return;
      }
      setBackups(res.backups);
      setError('');
      if (!backups().some(item => item.path === selected())) { setSelected(''); setPreview(null); }
    },
    setLoading,
  );
  createEffect(() => { backupPath(); void untrack(load); });
  async function inspect() {
    if (!selected() || props.locked || previewBusy()) return;
    setPreviewBusy(true);
    setPreview(null);
    const res = await scope.api('restore-preview', selected());
    setPreviewBusy(false);
    if (res.cancelled) return;
    if (res.ok && validRestorePreview(res) && res.path === selected()) { setPreview(res); setError(''); }
    else setError(res.error || t('backup_invalid_response'));
  }
  async function restore() {
    const choice = preview();
    if (props.locked || !choice || choice.path !== selected()) return;
    if (!(await confirmDialog(t('set_restore_confirm')))) return;
    props.setBusy(true);
    const res = await scope.api('restore', choice.path, choice.sha256);
    if (!res.cancelled) {
      if (res.ok) {
        setRestored({ previous: String(res.previous ?? ''), note: String(res.note ?? '') });
        setPreview(null);
        props.onPending();
        await props.onRestore();
        showToast(t('tools_saved_pending'), 'info');
      } else toastApiError(t('op_failed'), res);
    }
    props.setBusy(false);
  }
  return <>
    <Card title={t('set_backup')} icon="backup" description={t('tools_backup_desc')}>
      <TaskProgress taskKey={BACKUP_TASK} cancellable={false} />
      <Show when={backupFailed()}><div data-testid="backup-error"><ErrorState text={backupTask()?.result?.error || t('tools_backup_failed')} /></div></Show>
      <div class="tool-actions" data-testid="backup-controls">
        <Button variant="tonal" busy={backupBusy()} disabled={props.locked} onClick={() => void createBackup()}>
          {backupBusy() ? t('tools_backup_running') : backupFailed() ? t('retry') : t('set_backup')}
        </Button>
      </div>
      <Show when={backupPath()}><div class="tool-result" data-testid="backup-result" role="status">
        <strong>{t('tools_backup_latest')}</strong>
        <p class="mono" data-testid="backup-path">{backupPath()}</p>
        <p class="tool-hint">{t('tools_backup_file_hint')}</p>
        <Button variant="text" onClick={() => copyWithToast(backupPath(), 'info')}>{t('tools_copy_path')}</Button>
      </div></Show>
    </Card>
    <Card title={t('set_restore')} icon="refresh" description={t('backup_picker_hint')}>
      <Show when={error()}><ErrorState text={error()} onRetry={() => void load()} /></Show>
      <Select id="restore-backup" aria-label={t('backup_select')} value={selected()} disabled={props.locked || previewBusy()}
        onChange={e => { setSelected((e.target as HTMLSelectElement).value); setPreview(null); }}>
        <option value="">{t('backup_select')}</option>
        <For each={backups()}>{item => <option value={item.path}>{item.name} ({item.size} B)</option>}</For>
      </Select>
      <div class="tool-actions">
        <Button variant="text" busy={loading()} disabled={loading() || props.locked} onClick={() => void load()}>{t('backup_refresh')}</Button>
        <Button class="restore-preview" busy={previewBusy()} disabled={!selected() || props.locked || previewBusy()} onClick={() => void inspect()}>{t('backup_preview')}</Button>
      </div>
      <Show when={preview()}>{value => <div class="tool-result" data-testid="restore-diff">
        <strong>{t('backup_changes')}</strong>
        <Show when={value().changes.length} fallback={<p>{t('backup_unchanged')}</p>}>
          <For each={value().changes}>{change => <div class="tool-result">
            <strong>{change.file} · {change.key}</strong>
            <p class="tool-hint">{t('backup_before')}</p><pre class="mono">{change.before ?? '—'}</pre>
            <p class="tool-hint">{t('backup_after')}</p><pre class="mono">{change.after ?? '—'}</pre>
          </div>}</For>
        </Show>
        <Show when={value().hooks.length}><p class="tool-hint">{t('backup_hooks')}: {value().hooks.join(', ')}</p></Show>
        <Button variant="outlined" class="danger restore-apply" busy={props.busy} disabled={props.locked} onClick={() => void restore()}>{t('set_restore')}</Button>
      </div>}</Show>
    </Card>
    <Show when={restored()}>{result => <Card title={t('tools_restore_result')} icon="backup" class="tool-restore-result">
      <p class="tool-hint">{t('tools_restore_previous')}</p>
      <p class="mono" data-testid="restore-previous">{result().previous}</p>
      <Show when={result().note}><pre class="mono" data-testid="restore-note">{result().note}</pre></Show>
    </Card>}</Show>
  </>;
}
