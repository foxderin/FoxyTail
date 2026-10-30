import { createEffect, createSignal, For, Show, untrack, onMount, onCleanup, type JSX } from 'solid-js';
import { createApiScope, nativeControl } from '../api';
import { t } from '../i18n';
import { getTask } from '../tasks';
import { BACKUP_TASK, RESTORE_TASK, backupPath, backupToken, artifactExport, createBackup, restoreBackup, validBackups, validRestorePreview, type BackupFile, type RestorePreview } from '../backup';
import { savedConfigRevision } from '../config';
import { Card, ErrorState } from '../components/Basics';
import { copyWithToast } from '../clipboard';
import { confirmDialog } from '../components/ConfirmDialog';
import { TaskProgress } from '../components/TaskProgress';
import { Button, Select } from '../components/ui';
import { createGuardedLoad } from './tools-refresh';
import { requestNative, onNativeEvent, type NativeResult } from '../native';
import { toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';

export default function SettingsBackup(props: {
  locked: boolean;
}): JSX.Element {
  const scope = createApiScope();
  const [backups, setBackups] = createSignal<BackupFile[]>([]);
  const [selected, setSelected] = createSignal('');
  const [preview, setPreview] = createSignal<RestorePreview | null>(null);
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [previewBusy, setPreviewBusy] = createSignal(false);
  const [importBusy, setImportBusy] = createSignal(false);
  const [exportBusy, setExportBusy] = createSignal(false);
  const [imported, setImported] = createSignal('');
  function recoverImport(result: NativeResult) {
    const backup = result.backup as { busy?: boolean; token?: string; error?: string } | undefined;
    if (!backup) return;
    setImportBusy(backup.busy === true);
    if (backup.error) setError(backup.error);
    if (backup.token && /^art-[a-f0-9]{32}$/.test(backup.token) && backup.token !== imported()) {
      setImported(backup.token); setSelected(backup.token); setPreview(null);
    }
  }
  onMount(() => { void requestNative('files.snapshot').then(recoverImport); });
  onCleanup(onNativeEvent('files', recoverImport));
  async function importBackup() {
    if (props.locked || importBusy()) return;
    setImportBusy(true); setPreview(null);
    const result = await requestNative('backup.import');
    setImportBusy(false);
    if (result.ok && typeof result.token === 'string' && /^art-[a-f0-9]{32}$/.test(result.token)) {
      setImported(result.token); setSelected(result.token); await inspect();
    } else if (!result.cancelled) setError(result.error || t('backup_invalid_response'));
  }
  async function exportBackup(token: string, share: boolean) {
    if (!token || exportBusy()) return;
    if (share && !await confirmDialog({ title: t('confirm_share_title'), body: t('tools_backup_sensitive'), confirmLabel: t('tools_share') })) return;
    setExportBusy(true);
    const result = await requestNative(share ? 'artifact.share' : 'artifact.save', { token, name: 'foxytail-backup.tar.gz' });
    setExportBusy(false);
    if (!result.ok && !result.cancelled) toastApiError(t('op_failed'), result);
  }
  const restoreTask = () => getTask(RESTORE_TASK);
  const restoreBusy = () => restoreTask()?.status === 'running';
  const restored = () => restoreTask()?.status === 'done' ? restoreTask()?.result : null;
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
      if (!/^art-[a-f0-9]{32}$/.test(selected()) && !backups().some(item => item.path === selected())) { setSelected(''); setPreview(null); }
    },
    setLoading,
  );
  createEffect(() => { backupPath(); void untrack(load); });
  createEffect(() => { savedConfigRevision(); nativeControl().revision; setPreview(null); });
  async function inspect() {
    if (!selected() || props.locked || previewBusy()) return;
    setPreviewBusy(true);
    setPreview(null);
    const revision = savedConfigRevision();
    const observation = nativeControl().revision;
    const res = await scope.api('restore-preview', selected());
    setPreviewBusy(false);
    if (res.cancelled || revision !== savedConfigRevision() || observation !== nativeControl().revision) return;
    if (res.ok && validRestorePreview(res) && res.path === selected()) { setPreview(res); setError(''); }
    else setError(res.error || t('backup_invalid_response'));
  }
  async function restore() {
    const choice = preview();
    if (props.locked || restoreBusy() || !choice || choice.path !== selected()) return;
    if (!(await confirmDialog({ title: t('confirm_restore_title'), body: `${t('set_restore_confirm')}\nSHA-256: ${choice.sha256}\nBaseline SHA-256: ${choice.baselineSha256}`, confirmLabel: t('set_restore'), tone: 'danger' }))) return;
    if (preview() !== choice || props.locked || restoreBusy()) return;
    setPreview(null);
    await restoreBackup(choice);
  }
  return <>
    <Show when={artifactExport()?.busy}>
      <div class="tool-result" role="status">
        <p>{artifactExport()?.message} · {artifactExport()?.bytes} B</p>
        <Button disabled={artifactExport()?.committing} onClick={async () => {
          const result = await requestNative('files.cancelExport'); if (!result.ok) toastApiError(t('op_failed'), result);
        }}>{t('cancel')}</Button>
      </div>
    </Show>
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
        <div class="tool-actions">
          <Button disabled={exportBusy() || !backupToken()} onClick={() => void exportBackup(backupToken(), false)}><MdIcon name="save" size={18} />{t('save')}</Button>
          <Button disabled={exportBusy() || !backupToken()} onClick={() => void exportBackup(backupToken(), true)}><MdIcon name="share" size={18} />{t('tools_share')}</Button>
          <Button variant="text" disabled={!backupToken()} onClick={() => { setSelected(backupToken()); setPreview(null); }}>{t('backup_select')}</Button>
        </div>
      </div></Show>
    </Card>
    <Card title={t('set_restore')} icon="refresh" description={t('backup_picker_hint')}>
      <TaskProgress taskKey={RESTORE_TASK} />
      <Show when={restoreTask()?.status === 'error'}><ErrorState text={restoreTask()?.result?.error || t('op_failed')} /></Show>
      <Show when={error()}><ErrorState text={error()} onRetry={() => void load()} /></Show>
      <Select id="restore-backup" aria-label={t('backup_select')} value={selected()} disabled={props.locked || previewBusy() || restoreBusy()}
        onChange={e => { setSelected((e.target as HTMLSelectElement).value); setPreview(null); }}>
        <option value="">{t('backup_select')}</option>
        <Show when={/^art-[a-f0-9]{32}$/.test(selected())}><option value={selected()}>{t('tools_imported_archive')}</option></Show>
        <For each={backups()}>{item => <option value={item.path}>{item.name} ({item.size} B)</option>}</For>
      </Select>
      <div class="tool-actions">
        <Button variant="text" busy={loading()} disabled={loading() || props.locked} onClick={() => void load()}>{t('backup_refresh')}</Button>
        <Button disabled={props.locked || importBusy()} busy={importBusy()} onClick={() => void importBackup()}><MdIcon name="upload_file" size={18} />{t('tools_import')}</Button>
        <Button class="restore-preview" busy={previewBusy()} disabled={!selected() || props.locked || previewBusy() || restoreBusy()} onClick={() => void inspect()}>{t('backup_preview')}</Button>
      </div>
      <Show when={imported()}>
        <div class="tool-actions">
          <Button disabled={exportBusy()} onClick={() => void exportBackup(imported(), false)}>{t('save')}</Button>
          <Button disabled={exportBusy()} onClick={() => void exportBackup(imported(), true)}>{t('tools_share')}</Button>
        </div>
      </Show>
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
        <Button variant="outlined" class="danger restore-apply" busy={restoreBusy()} disabled={props.locked || restoreBusy()} onClick={() => void restore()}>{t('set_restore')}</Button>
      </div>}</Show>
    </Card>
    <Show when={restored()}>{result => <Card title={t('tools_restore_result')} icon="backup" class="tool-restore-result">
      <p class="tool-hint">{t('tools_restore_previous')}</p>
      <p class="mono" data-testid="restore-previous">{String(result().previous ?? '')}</p>
      <Show when={result().note}><pre class="mono" data-testid="restore-note">{String(result().note)}</pre></Show>
    </Card>}</Show>
  </>;
}
