import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, useContext, type JSX } from 'solid-js';
import { api, createApiScope, nativeControl } from '../api';
import { t, type I18nKey } from '../i18n';
import { fmtBytes, fmtTime } from '../format';
import { Card, SkeletonRows, EmptyState, ErrorState, MetricCard } from '../components/Basics';
import { confirmDialog } from '../components/ConfirmDialog';
import { copyWithToast } from '../clipboard';
import { showToast } from '../components/Toast';
import { MdIcon } from '../icons';
import { Checkbox, IconButton, TextField } from '../components/ui';
import { onNativeEvent, requestNative } from '../native';
import { DATA_DIR } from '../config';
import { appActive, RouteVisible } from '../schedule';
import { acceptSnapshot, count, fileName, filesSnapshot, fileText, fileView, initializeFiles, MAX_FILES, record, resultError, snapshotError, updateFileView, type ExportState } from '../files';
import type { InboxFile } from '../types';
import FilesSend from './FilesSend';
import './tools.css';
import './files.css';

export default function Files(): JSX.Element {
  const scope = createApiScope();
  const routeVisible = useContext(RouteVisible);
  const [files, setFiles] = createSignal<InboxFile[] | null>(null);
  const [loadError, setLoadError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [ignored, setIgnored] = createSignal(0);
  const [working, setWorking] = createSignal(false);
  const [notice, setNotice] = createSignal('');
  const [exportState, setExportState] = createSignal<ExportState | null>(null);
  const [page, setPage] = createSignal(0);
  let inboxDirty = false, inboxRevision = 0, observedReceipt = '';
  const visible = () => appActive() && routeVisible() && document.visibilityState !== 'hidden';
  const selected = () => fileView().selected;
  const locked = () => working() || !!exportState()?.busy || nativeControl().busy;
  const canWrite = () => nativeControl().canWrite && !locked();
  const canSelect = () => files() !== null && !loading() && !loadError() && !locked();
  const order = createMemo(() => fileView().sort);
  const query = createMemo(() => fileView().filter.toLocaleLowerCase());
  const ordered = createMemo(() => [...(files() ?? [])].sort((a, b) =>
    (order() === 1 ? a.mtime - b.mtime : order() === 2 ? 0 : order() === 3 ? b.size - a.size : b.mtime - a.mtime) || a.name.localeCompare(b.name)));
  const filtered = createMemo(() => ordered().filter(file => file.name.toLocaleLowerCase().includes(query())));
  const pages = () => Math.max(1, Math.ceil(filtered().length / 100));
  const currentPage = () => Math.min(page(), pages() - 1);
  async function loadInbox() {
    if (loading()) return;
    if (!visible()) { inboxDirty = true; return; }
    setLoading(true); inboxDirty = false;
    const revision = inboxRevision;
    const result = await scope.api('files-inbox'); setLoading(false);
    if (revision !== inboxRevision) { void loadInbox(); return; }
    if (result.cancelled) { inboxDirty = true; return; }
    if (!result.ok || !Array.isArray(result.files) || !result.files.every(file => record(file) && fileName(file.name) && count(file.size) && count(file.mtime)) ||
      new Set(result.files.map(file => file.name)).size !== result.files.length || (result.ignored !== undefined && !count(result.ignored))) {
      setLoadError(result.error || t('files_invalid_response')); return;
    }
    const loaded = result.files as InboxFile[];
    setFiles(loaded); setIgnored(Number(result.ignored ?? 0)); setLoadError('');
    const retained = selected().filter(name => loaded.some(file => file.name === name));
    if (retained.length !== selected().length) updateFileView({selected: retained});
  }
  function toggle(name: string) {
    if (!canSelect()) return;
    if (selected().includes(name)) updateFileView({selected: selected().filter(item => item !== name)});
    else if (selected().length < MAX_FILES) updateFileView({selected: [...selected(), name]});
    else showToast(t('ft_selection_limit'), 'err');
  }
  function selectMatches() {
    const names = [...new Set([...selected(), ...filtered().map(file => file.name)])];
    if (names.length > MAX_FILES) { showToast(t('ft_selection_limit'), 'err'); return; }
    updateFileView({selected: names});
  }
  async function nativeAction(action: string, args: Record<string, unknown> = {}) {
    if (locked()) return;
    setWorking(true); setNotice('');
    const result = await requestNative(action, args); setWorking(false);
    if (!result.ok && !result.cancelled) setNotice(resultError(result));
    else if (action === 'files.save' && result.ok && !result.cancelled) showToast(t('ft_saved'), 'ok');
    if (action === 'files.import') inboxDirty = true;
  }
  async function mutate(command: string, names: string[] = []) {
    if (!canWrite()) return;
    const prompt = command === 'file-clear' ? t('ft_clear_confirm') : command.includes('export') ? t('ft_export_confirm') : t('ft_delete_confirm');
    if (!await confirmDialog(prompt + (names.length ? '\n\n' + names.join('\n') : '')) || !canWrite()) return;
    setWorking(true); setNotice('');
    const result = await api(command, ...(command.endsWith('-many') ? [JSON.stringify(names)] : names));
    setWorking(false);
    if (!result.ok) setNotice(resultError(result));
    else if (command.endsWith('-many')) {
      const rows = result.results;
      if (!Array.isArray(rows) || rows.length !== names.length || !rows.every((row, index) => record(row) && row.name === names[index] && typeof row.ok === 'boolean' && (row.ok || typeof row.error === 'string'))) setNotice(t('files_invalid_response'));
      else {
        const completed = rows.filter(row => row.ok).map(row => row.name);
        updateFileView({selected: selected().filter(name => !completed.includes(name))});
        setNotice([fileText('ft_batch_result', {success: completed.length, failed: rows.length - completed.length}), ...rows.filter(row => !row.ok).map(row => row.name + ': ' + row.error)].join('\n'));
      }
    } else if (command === 'file-clear') {
      if (!count(result.removed) || (result.ignored !== undefined && !count(result.ignored))) setNotice(t('files_invalid_response'));
      else setNotice(t('files_cleared') + ' (' + result.removed + ')' + (result.ignored ? '\n' + fileText('ft_ignored', {count: Number(result.ignored)}) : ''));
    } else if (command === 'file-export') setNotice(t('files_exported_to') + ' ' + String(result.path ?? ''));
    else showToast(t('files_deleted'), 'ok');
    inboxRevision++;
    if (!result.unknown) void loadInbox();
  }
  const subscriptions = [
    onNativeEvent('control', value => {
      const receipt = String(value.id) + ':' + String(value.revision);
      if (typeof value.command === 'string' && value.command.startsWith('file-') && !value.command.startsWith('file-send-') && !value.busy && !value.unknown && record(value.result) && receipt !== observedReceipt) {
        observedReceipt = receipt; inboxRevision++; inboxDirty = true; void loadInbox();
      }
    }),
    onNativeEvent('files', value => {
      const previous = filesSnapshot(); acceptSnapshot(value);
      if (record(value.export)) setExportState(value.export as ExportState);
      if (previous?.busy && !value.busy) { inboxRevision++; inboxDirty = true; void loadInbox(); }
    }),
    onNativeEvent('export', value => setExportState(value as unknown as ExportState)),
    onNativeEvent('lifecycle', value => { if (!value.active) scope.cancelAll(); }),
    onNativeEvent('navigate', value => { if (value.page === 'files') requestAnimationFrame(() => { if (inboxDirty || files() === null) void loadInbox(); }); }),
  ];
  onCleanup(() => subscriptions.forEach(stop => stop()));
  onMount(async () => { await initializeFiles(); setExportState(filesSnapshot()?.export ?? null); void loadInbox(); });
  createEffect(on(() => nativeControl().compatible, compatible => { if (compatible && files() === null) void loadInbox(); }));
  createEffect(on(() => routeVisible() && appActive(), shown => {
    if (!shown) { scope.cancelAll(); return; }
    void initializeFiles().then(() => { if (inboxDirty || files() === null) void loadInbox(); });
  }));
  return <div class="tools-page files-page">
    <Show when={snapshotError()}><ErrorState text={snapshotError()} /></Show>
    <Show when={notice()}><p class="files-notice" role="status">{notice()}</p></Show>
    <Show when={exportState()?.busy}><div class="files-operation" role="status">
      <span>{exportState()?.message || t(exportState()?.committing ? 'ft_committing' : 'ft_exporting')} · {fmtBytes(exportState()?.bytes ?? 0)}</span>
      <IconButton aria-label={t('cancel')} disabled={exportState()?.committing} onClick={() => void requestNative('files.cancelExport').then(result => { if (!result.ok) setNotice(resultError(result)); })}><MdIcon name="close" size={18} /></IconButton>
    </div></Show>
    <Show when={exportState()?.error}><ErrorState text={exportState()!.error!} /></Show>
    <Show when={files() !== null}><div class="metric-grid">
      <MetricCard label={t('files_inbox')} value={files()!.length} caption={t('tools_file_count')} icon="folder" />
      <MetricCard label={t('tools_total_size')} value={fmtBytes(files()!.reduce((sum, file) => sum + file.size, 0))} icon="download" />
    </div></Show>
    <Card title={t('files_inbox')} icon="folder" actions={<IconButton aria-label={t('tools_refresh')} disabled={loading()} onClick={() => void loadInbox()}><MdIcon name="refresh" size={18} /></IconButton>}>
      <Show when={loadError()}><ErrorState text={loadError()} onRetry={() => void loadInbox()} /></Show>
      <Show when={files() !== null} fallback={<Show when={!loadError()}><SkeletonRows rows={3} /></Show>}>
        <Show when={ignored() > 0}><p class="tool-hint">{fileText('ft_ignored', {count: ignored()})}</p></Show>
        <div class="files-toolbar">
          <TextField label={t('tools_file_search')} value={fileView().filter} onInput={event => { updateFileView({filter: (event.target as HTMLInputElement).value}); setPage(0); }} leading-icon={<MdIcon name="search" size={18} />} />
          <details class="files-sort"><summary aria-label={t('ft_sort')} title={t('ft_sort')}><MdIcon name="sort" size={20} /></summary><div role="group" aria-label={t('ft_sort')}>
            <For each={['ft_newest', 'ft_oldest', 'ft_name', 'ft_size'] as I18nKey[]}>{(key, index) => <button type="button" aria-pressed={fileView().sort === index()} onClick={event => { updateFileView({sort: index()}); setPage(0); event.currentTarget.closest('details')?.removeAttribute('open'); }}>{t(key)}</button>}</For>
          </div></details>
          <IconButton aria-label={t('files_clear')} disabled={!canWrite() || !files()?.length} onClick={() => void mutate('file-clear')}><MdIcon name="delete" size={18} /></IconButton>
        </div>
        <div class="files-toolbar">
          <IconButton aria-label={t('ft_matches')} disabled={!canSelect() || !filtered().length} onClick={selectMatches}><MdIcon name="select_all" size={18} /></IconButton>
          <Show when={selected().length}><span class="tool-hint" aria-live="polite">{fileText('ft_selected', {count: selected().length, visible: filtered().length})}</span>
            <IconButton aria-label={t('ft_deselect')} disabled={!canSelect()} onClick={() => updateFileView({selected: []})}><MdIcon name="deselect" size={18} /></IconButton>
            <IconButton aria-label={t('ft_share')} disabled={!canSelect()} onClick={() => void nativeAction('files.share', {names: [...selected()]})}><MdIcon name="share" size={18} /></IconButton>
            <IconButton aria-label={t('ft_batch_export')} disabled={!canSelect() || !canWrite()} onClick={() => void mutate('file-export-many', [...selected()])}><MdIcon name="open_in_new" size={18} /></IconButton>
            <IconButton aria-label={t('ft_batch_delete')} disabled={!canSelect() || !canWrite()} onClick={() => void mutate('file-delete-many', [...selected()])}><MdIcon name="delete" size={18} /></IconButton>
          </Show>
        </div>
        <Show when={filtered().length} fallback={<Show when={!loadError()}><EmptyState text={fileView().filter ? t('empty') : t('files_empty')} icon="folder" /></Show>}>
          <div class="files-list"><For each={filtered().slice(currentPage() * 100, (currentPage() + 1) * 100)}>{file => <div class="files-inbox-row">
            <div class="list-row"><MdIcon name="article" size={20} class="dim" /><div class="main"><div class="title">{file.name}</div><div class="sub">{fmtBytes(file.size)} · {fmtTime(file.mtime)}</div></div>
              <Checkbox aria-label={t('files_select') + ' ' + file.name} checked={selected().includes(file.name)} disabled={!canSelect() || selected().length >= MAX_FILES && !selected().includes(file.name)} onChange={() => toggle(file.name)} />
            </div>
            <div class="files-row-actions">
              <IconButton aria-label={t('tools_copy_path') + ' ' + file.name} onClick={() => void copyWithToast(DATA_DIR + '/files/' + file.name, 'info')}><MdIcon name="content_copy" size={18} /></IconButton>
              <IconButton aria-label={t('ft_save_as') + ' ' + file.name} disabled={locked()} onClick={() => void nativeAction('files.save', {name: file.name})}><MdIcon name="download" size={18} /></IconButton>
              <IconButton aria-label={t('files_export') + ' ' + file.name} disabled={!canWrite()} onClick={() => void mutate('file-export', [file.name])}><MdIcon name="open_in_new" size={18} /></IconButton>
              <IconButton aria-label={t('ft_open') + ' ' + file.name} disabled={locked()} onClick={() => void nativeAction('files.open', {name: file.name})}><MdIcon name="file_open" size={18} /></IconButton>
              <IconButton aria-label={t('ft_share') + ' ' + file.name} disabled={locked()} onClick={() => void nativeAction('files.share', {names: [file.name]})}><MdIcon name="share" size={18} /></IconButton>
              <IconButton aria-label={t('files_delete') + ' ' + file.name} disabled={!canWrite()} onClick={() => void mutate('file-delete', [file.name])}><MdIcon name="delete" size={18} /></IconButton>
            </div>
          </div>}</For></div>
          <Show when={pages() > 1}><nav class="files-toolbar" aria-label={t('files_inbox')}><IconButton aria-label={t('ft_previous')} disabled={!currentPage()} onClick={() => setPage(currentPage() - 1)}><MdIcon name="chevron_right" class="files-back" /></IconButton><span>{fileText('ft_page', {page: currentPage() + 1, total: pages()})}</span><IconButton aria-label={t('ft_next')} disabled={currentPage() + 1 >= pages()} onClick={() => setPage(currentPage() + 1)}><MdIcon name="chevron_right" /></IconButton></nav></Show>
        </Show>
      </Show>
      <IconButton aria-label={t('files_receive')} disabled={!canWrite() || filesSnapshot()?.busy || filesSnapshot()?.unknown} onClick={() => void nativeAction('files.import')}><MdIcon name="download" size={18} /></IconButton>
    </Card>
    <FilesSend inboxSettled={!loading() && (files() !== null || !!loadError())} />
  </div>;
}
