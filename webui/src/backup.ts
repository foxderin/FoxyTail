/** Backup execution and its latest successful file belong to the WebUI session. */
import { createSignal } from 'solid-js';
import type { ApiResult } from './api';
import { getTask, startValidatedTask } from './tasks';
import { showToast, toastApiError } from './components/Toast';
import { t } from './i18n';

export const BACKUP_TASK = 'backup';
const [backupPath, setBackupPath] = createSignal('');
export { backupPath };

function validateBackup(result: ApiResult): ApiResult {
  const path = typeof result.path === 'string' ? result.path.trim() : '';
  if (!path.startsWith('/') || !path.endsWith('.tar.gz') || /[\u0000-\u001f\u007f]/.test(path)) {
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
    showToast(t('tools_backup_ready'), 'ok');
  } else toastApiError(t('tools_backup_failed'), result);
}
