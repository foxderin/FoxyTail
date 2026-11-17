import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, useContext, type JSX } from 'solid-js';
import { api, createApiScope, nativeControl } from '../api';
import { t, type I18nKey } from '../i18n';
import { fmtBytes, fmtTime } from '../format';
import { Card, SkeletonRows, EmptyState, ErrorState } from '../components/Basics';
import { confirmDialog } from '../components/ConfirmDialog';
import { copyWithToast } from '../clipboard';
import { showToast } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, Checkbox, IconButton, TextField } from '../components/ui';
import { onNativeEvent, requestNative } from '../native';
import { appActive, pollWhileVisible, RouteVisible } from '../schedule';
import { viewPollInterval } from '../state';
import { acceptSnapshot, count, fileName, filesSnapshot, fileText, fileView, initializeFiles, MAX_FILES, record, resultError, snapshotError, updateFileView, type ExportState } from '../files';
import type { InboxFile } from '../types';
import FilesSend from './FilesSend';
import { nativeFilesSection } from '../navigation';
import FilesReceivePreferences from './FilesReceivePreferences';
import './tools.css';
import './files.css';

type ReceiveState = { mode: 'direct' | 'buffered' | 'unavailable'; selfId: string; pending: { name: string; size: number }[]; error?: string; automatic?: { enabled: boolean; state: 'idle' | 'running' | 'blocked'; error?: string; operationId?: string } };

export default function Files(): JSX.Element {
  const scope = createApiScope();
  const routeVisible = useContext(RouteVisible);
  const [files, setFiles] = createSignal<InboxFile[] | null>(null);
  const [receive, setReceive] = createSignal<ReceiveState | null>(null);
  const [loadError, setLoadError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [inboxFresh, setInboxFresh] = createSignal(false);
  const [selectMode, setSelectMode] = createSignal(false);
  const [working, setWorking] = createSignal(false);
  const [notice, setNotice] = createSignal('');
  const [exportState, setExportState] = createSignal<ExportState | null>(null);
  const [page, setPage] = createSignal(0);
  const [inboxRequested, setInboxRequested] = createSignal(false);
  let inboxSection!: HTMLElement;
  let inboxFrame: number | undefined;
  let inboxDirty = false, inboxRevision = 0, observedReceipt = '';
  const visible = () => appActive() && routeVisible() && document.visibilityState !== 'hidden';
  const selected = () => fileView().selected;
  const locked = () => working() || !!exportState()?.busy || nativeControl().busy;
  const canWrite = () => inboxFresh() && nativeControl().canWrite && !locked();
  const canSelect = () => inboxFresh() && !locked();
  const order = createMemo(() => fileView().sort);
  const query = createMemo(() => fileView().filter.toLocaleLowerCase());
  const ordered = createMemo(() => [...(files() ?? [])].sort((a, b) =>
    (order() === 1 ? a.mtime - b.mtime : order() === 2 ? 0 : order() === 3 ? b.size - a.size : b.mtime - a.mtime) || a.name.localeCompare(b.name)));
  const filtered = createMemo(() => ordered().filter(file => file.name.toLocaleLowerCase().includes(query())));
  const pages = () => Math.max(1, Math.ceil(filtered().length / 100));
  const currentPage = () => Math.min(page(), pages() - 1);
  async function loadInbox() {
    if (loading()) return;
    setInboxFresh(false);
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
    const incoming = result.receive;
    setReceive(record(incoming) && typeof incoming.mode === 'string' && ['direct', 'buffered', 'unavailable'].includes(incoming.mode) &&
      typeof incoming.selfId === 'string' && Array.isArray(incoming.pending) &&
      incoming.pending.every(item => record(item) && fileName(item.name) && count(item.size))
      ? { ...incoming, automatic: record(incoming.automatic) && typeof incoming.automatic.enabled === 'boolean' &&
          ['idle', 'running', 'blocked'].includes(String(incoming.automatic.state)) &&
          (incoming.automatic.error === undefined || typeof incoming.automatic.error === 'string')
          ? incoming.automatic : undefined } as ReceiveState : null);
    const loaded = result.files as InboxFile[];
    setFiles(loaded); setLoadError(''); setInboxFresh(true);
    const retained = selected().filter(name => loaded.some(file => file.name === name));
    if (retained.length !== selected().length) updateFileView({selected: retained});
  }
  async function receiveFile(name: string) {
    const state = receive();
    if (!canWrite() || !state?.selfId || !state.pending.some(item => item.name === name)) return;
    setWorking(true); setNotice('');
    const result = await api('file-receive', name, state.selfId);
    setWorking(false);
    if (!result.ok) setNotice(resultError(result));
    else if (result.name !== name || result.received !== true || typeof result.sourceDeleted !== 'boolean') setNotice(t('files_invalid_response'));
    else setNotice(result.sourceDeleted ? t('ft_received_downloads') : result.error || t('ft_receive_source_retained'));
    inboxRevision++;
    if (!result.unknown) void loadInbox();
  }
  function toggle(name: string) {
    if (!canSelect()) return;
    if (selected().includes(name)) updateFileView({selected: selected().filter(item => item !== name)});
    else if (selected().length < MAX_FILES) updateFileView({selected: [...selected(), name]});
    else showToast(t('ft_selection_limit'), 'err');
  }
  function selectMatches() {
    if (!canSelect()) return;
    const names = [...new Set([...selected(), ...filtered().map(file => file.name)])];
    if (names.length > MAX_FILES) { showToast(t('ft_selection_limit'), 'err'); return; }
    setSelectMode(true);
    updateFileView({selected: names});
  }
  function exitSelectMode() {
    setSelectMode(false);
    updateFileView({selected: []});
  }
  /* Long-press on a row starts selection; a normal tap opens the file. */
  let pressTimer: number | undefined, longPressed = false;
  const startPress = (name: string) => {
    longPressed = false;
    if (!canSelect()) return;
    pressTimer = window.setTimeout(() => { if (!canSelect()) return; longPressed = true; setSelectMode(true); toggle(name); }, 500);
  };
  const endPress = () => { if (pressTimer !== undefined) { clearTimeout(pressTimer); pressTimer = undefined; } };
  function tapRow(name: string) {
    if (longPressed) { longPressed = false; return; }
    if (selectMode()) toggle(name);
    else void nativeAction('files.open', {name});
  }
  function menuAction(event: Event, action: () => void) {
    (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
    action();
  }
  async function nativeAction(action: string, args: Record<string, unknown> = {}) {
    if (locked()) return;
    setWorking(true); setNotice('');
    const result = await requestNative(action, args); setWorking(false);
    if (!result.ok && !result.cancelled) setNotice(resultError(result));
  }
  async function mutate(command: string, names: string[] = []) {
    if (!canWrite()) return;
    const prompt = command === 'file-clear' ? t('ft_clear_confirm') : t('ft_delete_confirm');
    if (!await confirmDialog({
      title: t(command === 'file-clear' ? 'confirm_clear_inbox_title' : 'confirm_delete_title'),
      body: prompt + (names.length ? '\n\n' + names.join('\n') : ''),
      confirmLabel: t(command === 'file-clear' ? 'files_clear' : 'delete'),
      tone: 'danger',
    }) || !canWrite()) return;
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
    } else showToast(t('files_deleted'), 'ok');
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
    onNativeEvent('navigate', value => {
      if (value.page !== 'files') return;
      if (inboxFrame !== undefined) cancelAnimationFrame(inboxFrame);
      setInboxRequested(value.section === 'inbox');
      if (value.section === 'inbox') { inboxRevision++; inboxDirty = true; }
      requestAnimationFrame(() => { if (inboxDirty || files() === null) void loadInbox(); });
    }),
  ];
  onCleanup(() => { subscriptions.forEach(stop => stop()); if (inboxFrame !== undefined) cancelAnimationFrame(inboxFrame); });
  // Refresh shared files and daemon-held pending deliveries while visible.
  pollWhileVisible(loadInbox, () => viewPollInterval(5000));
  onMount(async () => {
    await initializeFiles(); setExportState(filesSnapshot()?.export ?? null);
    setInboxRequested(nativeFilesSection() === 'inbox'); void loadInbox();
  });
  createEffect(() => {
    if (!inboxRequested() || !visible() || loading() || files() === null && !loadError()) return;
    setInboxRequested(false);
    inboxFrame = requestAnimationFrame(() => {
      inboxFrame = undefined;
      if (!visible()) return;
      inboxSection.scrollIntoView({ block: 'start' });
      inboxSection.focus({ preventScroll: true });
    });
  });
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
    <section ref={inboxSection} id="files-inbox" tabIndex={-1} aria-label={t('files_inbox')}>
    <Card title={t('files_inbox')} icon="folder"
      description={files() !== null ? files()!.length + ' ' + t('tools_file_count') + ' · ' + fmtBytes(files()!.reduce((sum, file) => sum + file.size, 0)) : undefined}
      actions={<>
        <IconButton aria-label={t('tools_refresh')} disabled={loading()} onClick={() => void loadInbox()}><MdIcon name="refresh" size={18} /></IconButton>
        <details class="menu-pop"><summary aria-label={t('more')} title={t('more')}><MdIcon name="more_horiz" size={20} /></summary><div>
          <button type="button" aria-label={t('ft_matches')} disabled={!canSelect() || !filtered().length} onClick={event => menuAction(event, selectMatches)}>{t('ft_matches')}</button>
          <button type="button" aria-label={t('files_clear')} class="danger" disabled={!canWrite() || !files()?.length} onClick={event => menuAction(event, () => void mutate('file-clear'))}>{t('files_clear')}</button>
        </div></details>
      </>}>
      <FilesReceivePreferences />
      <Show when={receive()}>{state => <div class="files-receive-status" data-testid="receive-status">
        <Show when={state().mode !== 'direct'}><p class="tool-hint">{t(state().mode === 'buffered' ? 'ft_receive_buffered' : 'ft_receive_unavailable')}</p></Show>
        <Show when={state().automatic?.state === 'blocked'}>
          <p class="tool-hint" role="status">{t('ft_auto_receive_blocked')}</p>
          <Show when={state().automatic?.error}><ErrorState text={state().automatic!.error!} /></Show>
        </Show>
        <Show when={state().error && (state().automatic?.state !== 'blocked' || state().error !== state().automatic?.error)}><ErrorState text={state().error!} /></Show>
        <Show when={state().pending.length}>
          <h3>{t('ft_pending_receive')}</h3>
          <For each={state().pending}>{file => <div class="list-row">
            <div class="main"><div class="title">{file.name}</div><div class="sub">{fmtBytes(file.size)}</div></div>
            <Button variant="tonal" disabled={!canWrite() || !state().selfId} onClick={() => void receiveFile(file.name)}>{t('ft_receive_file')}</Button>
          </div>}</For>
        </Show>
      </div>}</Show>
      <Show when={loadError()}><ErrorState text={loadError()} onRetry={() => void loadInbox()} /></Show>
      <Show when={files() !== null} fallback={<Show when={!loadError()}><SkeletonRows rows={3} /></Show>}>
        <div class="files-toolbar">
          <TextField label={t('tools_file_search')} value={fileView().filter} onInput={event => { updateFileView({filter: (event.target as HTMLInputElement).value}); setPage(0); }} leading-icon={<MdIcon name="search" size={18} />} />
          <details class="menu-pop"><summary aria-label={t('ft_sort')} title={t('ft_sort')}><MdIcon name="sort" size={20} /></summary><div role="group" aria-label={t('ft_sort')}>
            <For each={['ft_newest', 'ft_oldest', 'ft_name', 'ft_size'] as I18nKey[]}>{(key, index) => <button type="button" aria-pressed={fileView().sort === index()} onClick={event => { updateFileView({sort: index()}); setPage(0); event.currentTarget.closest('details')?.removeAttribute('open'); }}>{t(key)}</button>}</For>
          </div></details>
        </div>
        <Show when={selectMode()}>
          <div class="files-toolbar files-selection-bar" role="group" aria-label={t('files_select')}>
            <span class="tool-hint" aria-live="polite">{fileText('ft_selected', {count: selected().length, visible: filtered().length})}</span>
            <IconButton aria-label={t('ft_share')} disabled={!canSelect() || !selected().length} onClick={() => void nativeAction('files.share', {names: [...selected()]})}><MdIcon name="share" size={18} /></IconButton>
            <IconButton aria-label={t('ft_batch_delete')} disabled={!canSelect() || !canWrite() || !selected().length} onClick={() => void mutate('file-delete-many', [...selected()])}><MdIcon name="delete" size={18} /></IconButton>
            <IconButton aria-label={t('ft_deselect')} disabled={!canSelect()} onClick={exitSelectMode}><MdIcon name="deselect" size={18} /></IconButton>
          </div>
        </Show>
        <Show when={filtered().length} fallback={<Show when={!loadError()}><EmptyState text={fileView().filter ? t('empty') : t('files_empty')} icon="folder" /></Show>}>
          <div class="files-list"><For each={filtered().slice(currentPage() * 100, (currentPage() + 1) * 100)}>{file => <div class="files-inbox-row">
            <button type="button" class="list-row files-row-main" disabled={selectMode() ? !canSelect() : locked()}
              aria-label={t(selectMode() ? 'files_select' : 'ft_open') + ' ' + file.name}
              onPointerDown={() => startPress(file.name)}
              onPointerUp={endPress} onPointerLeave={endPress} onPointerCancel={endPress}
              onClick={() => tapRow(file.name)}>
              <MdIcon name="article" size={20} class="dim" /><div class="main"><div class="title">{file.name}</div><div class="sub">{fmtBytes(file.size)} · {fmtTime(file.mtime)}</div></div>
            </button>
            <Show when={selectMode()}>
              <Checkbox aria-label={t('files_select') + ' ' + file.name} checked={selected().includes(file.name)} disabled={!canSelect() || selected().length >= MAX_FILES && !selected().includes(file.name)} onChange={() => toggle(file.name)} />
            </Show>
            <details class="menu-pop files-row-menu"><summary aria-label={t('more') + ': ' + file.name}><MdIcon name="more_horiz" size={20} /></summary><div>
              <button type="button" disabled={locked()} onClick={event => menuAction(event, () => void nativeAction('files.open', {name: file.name}))}>{t('ft_open')}</button>
              <button type="button" onClick={event => menuAction(event, () => void copyWithToast('/sdcard/Download/Taildrop/' + file.name, 'info'))}>{t('tools_copy_path')}</button>
              <button type="button" disabled={locked()} onClick={event => menuAction(event, () => void nativeAction('files.share', {names: [file.name]}))}>{t('ft_share')}</button>
              <button type="button" aria-label={t('files_select') + ' ' + file.name} disabled={!canSelect()} onClick={event => menuAction(event, () => { setSelectMode(true); if (!selected().includes(file.name)) toggle(file.name); })}>{t('files_select')}</button>
              <button type="button" class="danger" disabled={!canWrite()} onClick={event => menuAction(event, () => void mutate('file-delete', [file.name]))}>{t('files_delete')}</button>
            </div></details>
          </div>}</For></div>
          <Show when={pages() > 1}><nav class="files-toolbar" aria-label={t('files_inbox')}><IconButton aria-label={t('ft_previous')} disabled={!currentPage()} onClick={() => setPage(currentPage() - 1)}><MdIcon name="chevron_right" class="files-back" /></IconButton><span>{fileText('ft_page', {page: currentPage() + 1, total: pages()})}</span><IconButton aria-label={t('ft_next')} disabled={currentPage() + 1 >= pages()} onClick={() => setPage(currentPage() + 1)}><MdIcon name="chevron_right" /></IconButton></nav></Show>
        </Show>
      </Show>
    </Card>
    </section>
    <FilesSend inboxSettled={!loading() && (files() !== null || !!loadError())} />
  </div>;
}
