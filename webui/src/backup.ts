/** Backup artifacts stay native; the frontend only holds opaque identifiers. */
import { createSignal } from 'solid-js';
import type { ApiResult } from './api';
import { getTask, startValidatedTask } from './tasks';
import { showToast, toastApiError } from './components/Toast';
import { t } from './i18n';
import { onNativeEvent } from './native';
import type { ExportState } from './files';

const [artifactExport, setArtifactExport] = createSignal<ExportState | null>(null);
export { artifactExport };
onNativeEvent('export', result => {
  if (typeof result.busy === 'boolean' && typeof result.committing === 'boolean' &&
      typeof result.bytes === 'number' && typeof result.message === 'string') setArtifactExport({
        busy: result.busy, committing: result.committing, bytes: result.bytes, message: result.message, error: result.error,
      });
});

export const BACKUP_TASK = 'backup';
export const RESTORE_TASK = 'restore';
const [latestPath, setBackupPath] = createSignal('');
const [latestToken, setBackupToken] = createSignal('');
export function backupPath(): string {
  const result = getTask(BACKUP_TASK)?.result;
  return result?.ok && validateBackup(result).ok ? String(result.path) : latestPath();
}
export function backupToken(): string {
  const result = getTask(BACKUP_TASK)?.result;
  return result?.ok && validateBackup(result).ok ? String(result.artifactId) : latestToken();
}

function validateBackup(result: ApiResult): ApiResult {
  const path = typeof result.path === 'string' ? result.path.trim() : '';
  if (!path.startsWith('/') || !path.endsWith('.tar.gz') || /[\u0000-\u001f\u007f]/.test(path) ||
      typeof result.artifactId !== 'string' || !/^art-[a-f0-9]{32}$/.test(result.artifactId)) {
    return { ok: false, error: t('tools_backup_path_missing') };
  }
  return { ...result, path };
}

export async function createBackup(): Promise<void> {
  if (getTask(BACKUP_TASK)?.status === 'running') return;
  const call = startValidatedTask(BACKUP_TASK, 'backup', validateBackup);
  const result = await call.promise;
  // A replaced request may settle later; only its current owner publishes feedback.
  if (getTask(BACKUP_TASK)?.call !== call) return;
  if (result.cancelled) return;
  if (result.ok) {
    setBackupPath(result.path as string);
    setBackupToken(result.artifactId as string);
    showToast(t('tools_backup_ready'), 'ok');
  } else toastApiError(t('tools_backup_failed'), result);
}

/** Match the module's discoverable backup name without guessing a SAF path. */
export function backupExportName(): string {
  return 'foxytail-backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.tar.gz';
}

export type BackupFile = { name: string; path: string; size: number; mtime: number };
export type RestorePreview = {
  path: string; sha256: string; baselineSha256: string;
  changes: { file: string; key: string; before: string | null; after: string | null }[];
  hooks: string[];
};

export function validBackups(value: unknown): value is BackupFile[] {
  return Array.isArray(value) && value.every(item => item &&
    typeof item.name === 'string' && typeof item.path === 'string' &&
    /^\/sdcard\/Download\/foxytail-backup(?:-[A-Za-z0-9._-]+)?\.tar\.gz$/.test(item.path) &&
    Number.isSafeInteger(item.size) && item.size >= 0 && Number.isSafeInteger(item.mtime) && item.mtime >= 0);
}

export function validRestorePreview(value: unknown): value is RestorePreview {
  if (!value || typeof value !== 'object') return false;
  const preview = value as Partial<RestorePreview>;
  return typeof preview.path === 'string' && /^(?:art-[a-f0-9]{32}|\/sdcard\/Download\/foxytail-backup(?:-[A-Za-z0-9._-]+)?\.tar\.gz)$/.test(preview.path) &&
    typeof preview.sha256 === 'string' && /^[a-f0-9]{64}$/.test(preview.sha256) &&
    typeof preview.baselineSha256 === 'string' && /^[a-f0-9]{64}$/.test(preview.baselineSha256) &&
    Array.isArray(preview.changes) && preview.changes.every(change => change &&
      ['foxytail.conf', 'routes.conf', 'context.conf'].includes(change.file) && typeof change.key === 'string' &&
      (change.before === null || typeof change.before === 'string') && (change.after === null || typeof change.after === 'string')) &&
    Array.isArray(preview.hooks) && preview.hooks.every(hook => ['foxytail.tun.up', 'foxytail.tun.down'].includes(hook));
}

export async function restoreBackup(preview: RestorePreview): Promise<void> {
  if (getTask(RESTORE_TASK)?.status === 'running') return;
  const call = startValidatedTask(RESTORE_TASK, 'restore', result => {
    if (typeof result.previous !== 'string' || !result.previous.startsWith('/') ||
        (result.note !== null && typeof result.note !== 'string') || result.saved !== true || result.restartRequired !== true) {
      return { ok: false, error: t('backup_invalid_response') };
    }
    return result;
  }, preview.path, preview.sha256, preview.baselineSha256);
  const result = await call.promise;
  if (getTask(RESTORE_TASK)?.call !== call || result.cancelled) return;
  if (result.ok) showToast(t('tools_saved_pending'), 'info');
  else toastApiError(t('op_failed'), result);
}
