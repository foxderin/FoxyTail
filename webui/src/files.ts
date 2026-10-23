import { createSignal } from 'solid-js';
import { t, type I18nKey } from './i18n';
import { requestNative, type NativeResult } from './native';
import type { Transfer, TransferStatus, TaildropTarget } from './types';

export const MAX_FILES = 32;
export const MAX_SIZE = 2 * 1024 * 1024 * 1024;
export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export function fileText(key: I18nKey, values: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match));
}
export const fileName = (value: unknown): value is string => text(value) && value !== '.' && value !== '..' && !/[\\/\x00-\x1f\x7f-\x9f]/.test(value) && new TextEncoder().encode(value).length <= 255;
export const relative = (value: unknown): value is string => typeof value === 'string' && (value === '' || value.split('/').every(fileName));
export const active = (job: Transfer) => job.status === 'queued' || job.status === 'sending';
export const unsuccessful = (job: Transfer) => job.files.filter(file => file.status === 'failed' || file.status === 'cancelled');
export const statusKeys: Record<TransferStatus, I18nKey> = {
  queued: 'files_queued', sending: 'files_sending', completed: 'files_completed',
  failed: 'files_failed', cancelled: 'files_cancelled', interrupted: 'files_interrupted',
};
export function transfer(value: unknown): value is Transfer {
  if (!record(value) || !text(value.id) || !/^[a-f0-9]+$/.test(value.id) || !text(value.peerId) || typeof value.peerName !== 'string' ||
    !text(value.peerIp) || !text(value.selfId) || typeof value.status !== 'string' || !Object.prototype.hasOwnProperty.call(statusKeys, value.status) ||
    !count(value.startedAt) || !count(value.updatedAt) || !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES ||
    (value.error !== undefined && typeof value.error !== 'string')) return false;
  return new Set(value.files.map(file => record(file) ? file.id : null)).size === value.files.length && value.files.every(file =>
    record(file) && text(file.id) && fileName(file.name) && count(file.size) && file.size <= MAX_SIZE && count(file.sentBytes) && file.sentBytes <= file.size &&
    typeof file.progressKnown === 'boolean' && typeof file.bytesPerSecond === 'number' && Number.isFinite(file.bytesPerSecond) && file.bytesPerSecond >= 0 &&
    typeof file.status === 'string' && ['queued', 'sending', 'completed', 'failed', 'cancelled'].includes(file.status) &&
    (file.error === undefined || typeof file.error === 'string'));
}
export function target(value: unknown): value is TaildropTarget {
  return record(value) && text(value.id) && typeof value.hostname === 'string' && typeof value.online === 'boolean' &&
    Array.isArray(value.ips) && value.ips.length > 0 && value.ips.every(text);
}
export type PendingFile = {key: string; name: string; size: number; source: 'uri' | 'path'; path?: string};
export type ExportState = {busy: boolean; committing: boolean; bytes: number; message: string; error?: string};
export type FilesSnapshot = {ok: true; selection: PendingFile[]; busy: boolean; preparing: boolean; unknown: boolean; job: string | null; message: string; transfer: Transfer | null; export?: ExportState};
export const [filesSnapshot, setFilesSnapshot] = createSignal<FilesSnapshot | null>(null);
export const [snapshotError, setSnapshotError] = createSignal('');
export function acceptSnapshot(value: NativeResult) {
  if (!value.ok || !Array.isArray(value.selection) || value.selection.length > MAX_FILES ||
    !value.selection.every(file => record(file) && text(file.key) && fileName(file.name) && typeof file.size === 'number' && (file.size === -1 || count(file.size) && file.size <= MAX_SIZE) && ['uri', 'path'].includes(String(file.source))) ||
    typeof value.busy !== 'boolean' || typeof value.preparing !== 'boolean' || typeof value.unknown !== 'boolean' || typeof value.message !== 'string' ||
    (value.job !== null && typeof value.job !== 'string') || (value.transfer !== null && !transfer(value.transfer))) {
    setSnapshotError(value.error || t('files_invalid_response')); return;
  }
  setFilesSnapshot(value as unknown as FilesSnapshot); setSnapshotError('');
}
export type FileViewState = {filter: string; sort: number; selected: string[]; peer: string; directory: string; opened: boolean; expanded: string[]};
export const [fileView, setFileView] = createSignal<FileViewState>({filter: '', sort: 0, selected: [], peer: '', directory: '', opened: false, expanded: []});
let initialized: Promise<void> | undefined;
let saving = false;
let pendingSave: FileViewState | undefined;
export function updateFileView(patch: Partial<FileViewState>) {
  const next = {...fileView(), ...patch}; setFileView(next); pendingSave = next; void saveView();
}
async function saveView() {
  if (saving) return;
  saving = true;
  while (pendingSave) {
    const value = pendingSave; pendingSave = undefined;
    const result = await requestNative('app.drafts', {key: 'files', value});
    if (!result.ok) setSnapshotError(result.error || t('error'));
  }
  saving = false;
}
export function initializeFiles(): Promise<void> {
  return initialized ??= (async () => {
    const [snapshot, draft] = await Promise.all([requestNative('files.snapshot'), requestNative('app.drafts', {key: 'files'})]);
    acceptSnapshot(snapshot);
    const value = draft.value;
    if (draft.ok && record(value)) setFileView({
      filter: typeof value.filter === 'string' ? value.filter : '',
      sort: count(value.sort) && value.sort < 4 ? value.sort : 0,
      selected: Array.isArray(value.selected) && value.selected.length <= MAX_FILES && value.selected.every(fileName) ? value.selected : [],
      peer: typeof value.peer === 'string' ? value.peer : '', directory: relative(value.directory) ? value.directory : '',
      opened: value.opened === true,
      expanded: Array.isArray(value.expanded) ? value.expanded.filter((id): id is string => typeof id === 'string' && /^[a-f0-9]+$/.test(id)).slice(0, 100) : [],
    });
  })();
}
export function resultError(result: NativeResult): string {
  return result.unknown ? [result.error, t('ft_unknown')].filter(Boolean).join('\n') : result.error || t('error');
}
