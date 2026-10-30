import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, useContext, type JSX } from 'solid-js';
import { api, createApiScope, nativeControl } from '../api';
import { fmtBytes, fmtTime } from '../format';
import { t } from '../i18n';
import { MdIcon } from '../icons';
import { Card, EmptyState, ErrorState, SkeletonRows } from '../components/Basics';
import { confirmDialog } from '../components/ConfirmDialog';
import { Button, Checkbox, IconButton, Select } from '../components/ui';
import { onNativeEvent, requestNative } from '../native';
import { nativeFilesSection } from '../navigation';
import { appActive, RouteVisible } from '../schedule';
import { acceptSnapshot, active, count, fileName, filesSnapshot, fileText, fileView, initializeFiles, MAX_FILES, MAX_SIZE, record, relative, resultError, statusKeys, target, transfer, unsuccessful, updateFileView } from '../files';
import type { TaildropTarget, Transfer } from '../types';

type Entry = {name: string; directory: boolean; size: number; mtime: number; handle?: string};
export default function FilesSend(props: {inboxSettled: boolean}): JSX.Element {
  const scope = createApiScope();
  const routeVisible = useContext(RouteVisible);
  const [requestedSection, setRequestedSection] = createSignal('');
  const [peers, setPeers] = createSignal<TaildropTarget[] | null>(null);
  const [peerError, setPeerError] = createSignal('');
  const [peerLoading, setPeerLoading] = createSignal(false);
  const [entries, setEntries] = createSignal<Entry[] | null>(null);
  const [listedDirectory, setListedDirectory] = createSignal('');
  const [truncated, setTruncated] = createSignal(false);
  const [browseError, setBrowseError] = createSignal('');
  const [browsing, setBrowsing] = createSignal(false);
  const [history, setHistory] = createSignal<Transfer[] | null>(null);
  const [historyError, setHistoryError] = createSignal('');
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [historyReady, setHistoryReady] = createSignal(false);
  const [actionError, setActionError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [cancelling, setCancelling] = createSignal(false);
  const [cancelRequested, setCancelRequested] = createSignal('');
  let sendSection!: HTMLElement, historySection!: HTMLElement;
  let browseGeneration = 0, historyRevision = 0, ready = false, lastTransfer = '', deletedIds = new Set<string>();
  const selection = () => filesSnapshot()?.selection ?? [];
  const current = createMemo(() => history()?.find(active));
  const locked = () => submitting() || filesSnapshot() === null || !!filesSnapshot()?.busy || !!filesSnapshot()?.preparing || !!filesSnapshot()?.unknown || !!current();
  const writable = () => nativeControl().canWrite && !nativeControl().busy;
  const visible = () => appActive() && routeVisible() && document.visibilityState !== 'hidden';
  const sendAllowed = () => writable() && !locked() && historyReady() && !historyError() && peers() !== null && !peerError();
  function accept(job: Transfer) {
    if (deletedIds.has(job.id)) return;
    const existing = history()?.find(item => item.id === job.id);
    if (existing && (existing.updatedAt > job.updatedAt || !active(existing) && active(job))) return;
    historyRevision++;
    setHistory(previous => [job, ...(previous ?? []).filter(item => item.id !== job.id)].sort((a, b) => b.startedAt - a.startedAt).slice(0, 100));
  }
  async function loadPeers() {
    if (peerLoading() || !visible()) return;
    setPeerLoading(true); const revision = nativeControl().accountRevision;
    const result = await scope.api('taildrop-targets'); setPeerLoading(false);
    if (result.cancelled || revision !== nativeControl().accountRevision) return;
    if (!result.ok || !Array.isArray(result.peers) || result.peers.length > 10000 || !result.peers.every(target) || new Set(result.peers.map(item => item.id)).size !== result.peers.length) {
      setPeerError(result.error || t('files_invalid_response')); return;
    }
    const list = [...result.peers].sort((a, b) => Number(b.online) - Number(a.online) || a.hostname.localeCompare(b.hostname) || a.id.localeCompare(b.id));
    setPeers(list); setPeerError('');
    if (!list.some(item => item.id === fileView().peer)) updateFileView({peer: list[0]?.id ?? ''});
  }
  async function browse(path: string) {
    if (!relative(path)) return;
    const generation = ++browseGeneration;
    updateFileView({opened: true, directory: path}); setBrowsing(true); setBrowseError('');
    const result = await requestNative('files.browse', {path});
    if (generation !== browseGeneration) return;
    setBrowsing(false);
    if (result.cancelled) return;
    if (!result.ok || result.path !== path || !Array.isArray(result.entries) || result.entries.length > 1000 || typeof result.truncated !== 'boolean' ||
      !result.entries.every(entry => record(entry) && fileName(entry.name) && typeof entry.directory === 'boolean' && count(entry.size) && count(entry.mtime) && (entry.directory || entry.size > MAX_SIZE || typeof entry.handle === 'string' && !!entry.handle)) ||
      new Set(result.entries.map(entry => entry.name)).size !== result.entries.length) {
      setBrowseError(result.error || t('files_invalid_response')); return;
    }
    setEntries(result.entries as Entry[]); setListedDirectory(path); setTruncated(result.truncated);
  }
  async function loadHistory() {
    if (historyLoading() || !visible()) return;
    setHistoryLoading(true); const revision = historyRevision;
    const result = await scope.api('file-send-history'); setHistoryLoading(false);
    if (result.cancelled) return;
    if (!result.ok || !Array.isArray(result.transfers) || result.transfers.length > 100 || !result.transfers.every(transfer) ||
      new Set(result.transfers.map(job => job.id)).size !== result.transfers.length || result.transfers.filter(active).length > 1) {
      setHistoryError(result.error || t('files_invalid_response')); return;
    }
    const loaded = result.transfers as Transfer[];
    if (revision !== historyRevision) {
      const live = history() ?? [];
      setHistory(loaded.filter(job => !deletedIds.has(job.id)).map(job => {
        const newer = live.find(item => item.id === job.id);
        return newer && (newer.updatedAt > job.updatedAt || !active(newer) && active(job)) ? newer : job;
      }).concat(live.filter(job => !loaded.some(item => item.id === job.id) && !deletedIds.has(job.id))).sort((a, b) => b.startedAt - a.startedAt).slice(0, 100));
    } else setHistory(loaded.filter(job => !deletedIds.has(job.id)));
    setHistoryReady(true); setHistoryError('');
    const job = current();
    if (job && !filesSnapshot()?.busy) void nativeAction('files.adopt', {job: job.id});
  }
  async function nativeAction(action: string, args: Record<string, unknown> = {}) {
    const cancel = action === 'files.cancel';
    if (cancel ? cancelling() : submitting()) return;
    if (cancel) setCancelling(true); else setSubmitting(true);
    setActionError('');
    const result = await requestNative(action, args);
    if (cancel) setCancelling(false); else setSubmitting(false);
    if (!result.ok && !result.cancelled) setActionError(resultError(result));
    if (action === 'files.cancel' && result.ok) setCancelRequested(String(args.job ?? filesSnapshot()?.job ?? 'preparing'));
    const snapshot = await requestNative('files.snapshot'); acceptSnapshot(snapshot);
    if ((action === 'files.send' || action === 'files.retry') && result.ok) setCancelRequested('');
  }
  async function send(job?: Transfer) {
    if (!sendAllowed()) return;
    const destination = peers()?.find(node => node.id === (job?.peerId ?? fileView().peer));
    if (!destination) return;
    const sources = job ? unsuccessful(job) : selection();
    const selectionKeys = selection().map(file => file.key).join('\n'), accountRevision = nativeControl().accountRevision;
    if (!sources.length || sources.length > MAX_FILES) return;
    if (!await confirmDialog({ title: t('confirm_send_title'), body: fileText(job ? 'ft_retry_confirm' : 'ft_send_confirm', {peer: destination.hostname || destination.id}) + '\n\n' + sources.map(file => file.name).join('\n'), confirmLabel: t('files_send_btn') }) || !sendAllowed()) return;
    if (accountRevision !== nativeControl().accountRevision || (!job && selectionKeys !== selection().map(file => file.key).join('\n')) ||
      !peers()?.some(node => node.id === destination.id && node.ips[0] === destination.ips[0])) {
      setActionError(t('ft_selection_changed')); return;
    }
    await nativeAction(job ? 'files.retry' : 'files.send', {peer: destination.id, ip: destination.ips[0], ...(job ? {job: job.id} : {})});
  }
  async function toggle(entry: Entry) {
    if (locked()) return;
    const path = '/sdcard/' + (listedDirectory() ? listedDirectory() + '/' : '') + entry.name;
    const selected = selection().find(file => file.source === 'path' && file.path === path);
    if (selected) await nativeAction('files.remove', {key: selected.key});
    else if (entry.size > MAX_SIZE) setActionError(t('ft_file_limit'));
    else if (selection().length >= MAX_FILES) setActionError(t('ft_selection_limit'));
    else await nativeAction('files.addShared', {handles: [entry.handle]});
  }
  async function removeHistory(job?: Transfer) {
    if (!writable() || submitting() || !historyReady() || historyError() || job && active(job)) return;
    if (!await confirmDialog({ title: t('confirm_history_title'), body: t('ft_history_confirm'), confirmLabel: t('delete'), tone: 'danger' }) || !writable() || submitting()) return;
    setSubmitting(true); setActionError('');
    const candidates = (history() ?? []).filter(item => !active(item) && (!job || item.id === job.id)).map(item => item.id);
    const result = await api(job ? 'file-send-delete' : 'file-send-clear', ...(job ? [job.id] : [])); setSubmitting(false);
    if (!result.ok) setActionError(resultError(result));
    else if (!count(result.removed) || !count(result.retained)) setActionError(t('files_invalid_response'));
    else {
      historyRevision++;
      for (const id of candidates) deletedIds.add(id);
      setHistory(previous => previous?.filter(item => !deletedIds.has(item.id)) ?? null);
      updateFileView({expanded: fileView().expanded.filter(id => !deletedIds.has(id))});
      setNotice(fileText('ft_history_result', {removed: result.removed, retained: result.retained}));
    }
    if (!result.unknown) void loadHistory();
  }
  function focusSection(section: unknown) {
    if (section === 'send' || section === 'history') setRequestedSection(section);
  }
  const subscriptions = [
    onNativeEvent('control', value => {
      if ((value.command === 'file-send-delete' || value.command === 'file-send-clear') && !value.busy && !value.unknown && record(value.result)) void loadHistory();
    }),
    onNativeEvent('navigate', value => { if (value.page === 'files') { focusSection(value.section); requestAnimationFrame(() => { void loadPeers(); void loadHistory(); }); } }),
    onNativeEvent('lifecycle', value => { if (!value.active) scope.cancelAll(); }),
  ];
  onCleanup(() => { subscriptions.forEach(stop => stop()); browseGeneration++; });
  createEffect(() => {
    const job = filesSnapshot()?.transfer;
    if (job && transfer(job)) { const serialized = JSON.stringify(job); if (serialized !== lastTransfer) { lastTransfer = serialized; accept(job); } }
  });
  createEffect(on(() => nativeControl().accountRevision, (_value, previous) => {
    if (previous === undefined || !ready) return;
    setPeerError(t('loading')); void loadPeers();
  }));
  createEffect(on(() => nativeControl().compatible, compatible => { if (compatible && ready) { void loadPeers(); void loadHistory(); } }));
  createEffect(on(() => routeVisible() && appActive(), shown => {
    if (!shown) { scope.cancelAll(); return; }
    void initializeFiles().then(() => { void loadPeers(); void loadHistory(); });
  }));
  createEffect(() => {
    const section = requestedSection();
    if (!section || !visible() || !props.inboxSettled || peerLoading() || historyLoading() ||
      peers() === null && !peerError() || !historyReady() && !historyError()) return;
    setRequestedSection('');
    requestAnimationFrame(() => (section === 'send' ? sendSection : historySection)?.scrollIntoView({block: 'start'}));
  });
  onMount(async () => { await initializeFiles(); ready = true; void loadPeers(); void loadHistory(); if (fileView().opened) void browse(fileView().directory); focusSection(nativeFilesSection()); });
  return <>
    <section ref={sendSection} id="files-send">
      <Card title={t('files_send')} icon="send" actions={<IconButton aria-label={t('files_refresh_targets')} disabled={peerLoading()} onClick={() => void loadPeers()}><MdIcon name="refresh" size={18} /></IconButton>}>
        <Show when={filesSnapshot()?.message}><p class="files-notice" role="status">{filesSnapshot()?.message}</p></Show>
        <Show when={filesSnapshot()?.unknown}><div class="files-toolbar"><p role="alert">{t('ft_unknown')}</p><IconButton aria-label={t('ft_acknowledge')} disabled={submitting() || filesSnapshot()?.busy} onClick={async () => {
          if (await confirmDialog({ body: t('ft_acknowledge_confirm'), confirmLabel: t('ft_acknowledge') })) await nativeAction('files.acknowledge');
        }}><MdIcon name="check_circle" size={18} /></IconButton></div></Show>
        <Show when={filesSnapshot()?.preparing}><p role="status">{t('ft_preparing')}</p></Show>
        <Show when={filesSnapshot()?.busy}><IconButton aria-label={t('files_cancel_send')} disabled={cancelling()} onClick={() => void nativeAction('files.cancel', filesSnapshot()?.job ? {job: filesSnapshot()!.job} : {})}><MdIcon name="close" size={18} /></IconButton></Show>
        <Show when={peerError()}><ErrorState text={peerError()} onRetry={() => void loadPeers()} /></Show>
        <Show when={peers() !== null} fallback={<Show when={!peerError()}><SkeletonRows rows={1} /></Show>}>
          <Show when={peers()?.length} fallback={<Show when={!peerError()}><EmptyState text={t('tools_no_peers')} icon="group" /></Show>}>
            <Select label={t('files_peer')} aria-label={t('files_peer')} value={fileView().peer} disabled={locked()} onChange={event => updateFileView({peer: (event.target as HTMLSelectElement).value})}>
              <For each={peers() ?? []}>{node => <option value={node.id}>{node.hostname} · {node.ips[0]}{node.online ? '' : ' (' + t('offline') + ')'}</option>}</For>
            </Select>
          </Show>
        </Show>
        <div class="files-toolbar">
          <Button variant="tonal" disabled={locked()} aria-expanded={fileView().opened} aria-controls="taildrop-browser" onClick={() => fileView().opened ? updateFileView({opened: false}) : void browse(fileView().directory)}><MdIcon name="folder" size={18} />{t(fileView().opened ? 'files_close_browser' : 'files_choose')}</Button>
          <IconButton aria-label={t('ft_pick')} disabled={locked()} onClick={() => void nativeAction('files.pick')}><MdIcon name="add" size={18} /></IconButton>
        </div>
        <Show when={fileView().opened}><section id="taildrop-browser" aria-label={t('files_choose')} aria-busy={browsing()}>
          <nav class="files-toolbar" aria-label={t('files_location')}>
            <Button variant="text" onClick={() => void browse('')}>{t('ft_shared')}</Button>
            <For each={fileView().directory.split('/').filter(Boolean)}>{(part, index) => <Button variant="text" onClick={() => void browse(fileView().directory.split('/').slice(0, index() + 1).join('/'))}>{part}</Button>}</For>
            <IconButton aria-label={t('files_parent')} disabled={!fileView().directory} onClick={() => void browse(fileView().directory.split('/').slice(0, -1).join('/'))}><MdIcon name="chevron_right" class="files-back" size={18} /></IconButton>
            <IconButton aria-label={t('tools_refresh')} disabled={browsing()} onClick={() => void browse(fileView().directory)}><MdIcon name="refresh" size={18} /></IconButton>
          </nav>
          <Show when={browseError()}><ErrorState text={browseError()} onRetry={() => void browse(fileView().directory)} /></Show>
          <Show when={entries() !== null} fallback={<Show when={!browseError()}><SkeletonRows rows={3} /></Show>}>
            <Show when={listedDirectory() !== fileView().directory}><p class="tool-hint">{t('files_location')}: {listedDirectory() || t('ft_shared')}</p></Show>
            <div class="files-list"><For each={entries() ?? []}>{entry => <div class="list-row">
              <MdIcon name={entry.directory ? 'folder' : 'article'} size={20} class="dim" /><div class="main"><div class="title">{entry.name}</div><div class="sub">{entry.directory ? t('files_directory') : fmtBytes(entry.size)} · {fmtTime(entry.mtime)}{!entry.directory && entry.size > MAX_SIZE ? ' · ' + t('ft_file_limit') : ''}</div></div>
              <Show when={entry.directory} fallback={<Checkbox aria-label={t('files_select') + ' ' + entry.name}
                checked={selection().some(file => file.path === '/sdcard/' + (listedDirectory() ? listedDirectory() + '/' : '') + entry.name)}
                disabled={locked() || browsing() || !!browseError() || entry.size > MAX_SIZE || selection().length >= MAX_FILES && !selection().some(file => file.path === '/sdcard/' + (listedDirectory() ? listedDirectory() + '/' : '') + entry.name)} onChange={() => void toggle(entry)} />}>
                <IconButton aria-label={t('files_open_directory') + ' ' + entry.name} onClick={() => void browse((listedDirectory() ? listedDirectory() + '/' : '') + entry.name)}><MdIcon name="chevron_right" size={18} /></IconButton>
              </Show>
            </div>}</For></div>
            <Show when={!entries()?.length && !browseError() && !browsing()}><EmptyState text={t('files_directory_empty')} icon="folder" /></Show>
            <Show when={truncated()}><p class="tool-hint" role="status">{t('files_truncated')}</p></Show>
          </Show>
        </section></Show>
        <Show when={filesSnapshot()}>
        <div class="files-toolbar"><p class="tool-hint" aria-live="polite">{t('files_selected')} {selection().length}/32 · {selection().some(file => file.size < 0) ? t('ft_size_unknown') : fmtBytes(selection().reduce((sum, file) => sum + file.size, 0))}</p>
          <Show when={selection().length}><IconButton aria-label={t('ft_clear_selection')} disabled={locked()} onClick={() => void nativeAction('files.clear')}><MdIcon name="deselect" size={18} /></IconButton></Show>
        </div>
        <Show when={!selection().length}><p class="tool-hint">{t('ft_pending_empty')}</p></Show>
        <For each={selection()}>{file => <div class="list-row"><div class="main"><div class="title">{file.name}</div><div class="sub">{file.size < 0 ? t('ft_size_unknown') : fmtBytes(file.size)}</div></div><IconButton aria-label={t('files_remove_selection') + ' ' + file.name} disabled={locked()} onClick={() => void nativeAction('files.remove', {key: file.key})}><MdIcon name="close" size={18} /></IconButton></div>}</For>
        </Show>
        <Button busy={submitting()} disabled={!sendAllowed() || !selection().length || !peers()?.some(node => node.id === fileView().peer)} onClick={() => void send()}><MdIcon name="send" size={18} />{t('files_send_btn')}</Button>
        <Show when={actionError()}><ErrorState text={actionError()} /></Show>
        <Show when={notice()}><p class="files-notice" role="status">{notice()}</p></Show>
      </Card>
    </section>
    <section ref={historySection} id="files-history"><Card title={t('files_history')} icon="send" actions={<div class="files-toolbar">
      <IconButton aria-label={t('tools_refresh')} disabled={historyLoading()} onClick={() => void loadHistory()}><MdIcon name="refresh" size={18} /></IconButton>
      <IconButton aria-label={t('ft_clear_history')} disabled={!writable() || submitting() || !historyReady() || !!historyError() || !history()?.some(job => !active(job))} onClick={() => void removeHistory()}><MdIcon name="delete" size={18} /></IconButton>
    </div>}>
      <Show when={historyError()}><ErrorState text={historyError()} onRetry={() => void loadHistory()} /></Show>
      <Show when={history() !== null} fallback={<Show when={!historyError()}><SkeletonRows rows={2} /></Show>}>
        <Show when={history()?.length} fallback={<Show when={historyReady() && !historyError()}><EmptyState text={t('files_history_empty')} icon="send" /></Show>}>
          <div class="files-history"><For each={(history() ?? []).map(job => job.id)}>{id => {
            const job = () => history()!.find(item => item.id === id)!;
            return <section class="files-transfer" data-transfer-id={id}>
              <div class="files-toolbar"><h3>{job().peerName || job().peerId} · {job().peerIp}</h3>
                <Show when={!active(job())}><IconButton aria-label={t('ft_delete_history')} disabled={!writable() || submitting()} onClick={() => void removeHistory(job())}><MdIcon name="delete" size={18} /></IconButton></Show>
              </div>
              <p class="tool-hint">{fmtTime(job().startedAt)} · {t('files_completed_count')} {job().files.filter(file => file.status === 'completed').length}/{job().files.length}</p>
              <p role="status">{t(statusKeys[job().status])}</p>
              <Show when={job().error}><ErrorState text={job().error!} /></Show>
              <details open={fileView().expanded.includes(id) || active(job())} onToggle={event => {
                const expanded = event.currentTarget.open;
                if (expanded !== fileView().expanded.includes(id)) updateFileView({expanded: expanded ? [...fileView().expanded, id] : fileView().expanded.filter(item => item !== id)});
              }}><summary>{t('ft_details')}</summary>
                <For each={job().files}>{file => <div class="list-row"><div class="main"><div class="title">{file.name}</div><div class="sub">{t(statusKeys[file.status])} · {fmtBytes(file.size)}</div>
                  <Show when={file.status === 'sending'}><Show when={file.progressKnown} fallback={<p class="tool-hint">{t('files_progress_unknown')}</p>}>
                    <p class="tool-hint">{fmtBytes(file.sentBytes)} / {fmtBytes(file.size)} · {fmtBytes(file.bytesPerSecond)}/s</p><progress max={file.size || 1} value={file.sentBytes} aria-label={t('files_sending') + ' ' + file.name} />
                  </Show></Show>
                  <Show when={file.error}><p class="files-notice lat-bad" role="alert">{file.error}</p></Show>
                </div></div>}</For>
              </details>
              <div class="files-toolbar"><Show when={active(job())}>
                <IconButton aria-label={t('files_cancel_send')} disabled={cancelling()} onClick={() => void nativeAction('files.cancel', {job: id})}><MdIcon name="close" size={18} /></IconButton>
                <Show when={!filesSnapshot()?.busy}><IconButton aria-label={t('ft_adopt')} disabled={submitting()} onClick={() => void nativeAction('files.adopt', {job: id})}><MdIcon name="sync" size={18} /></IconButton></Show>
                <Show when={cancelRequested() === id}><span role="status">{t('files_cancel_requested')}</span></Show>
              </Show>
              <Show when={!active(job()) && unsuccessful(job()).length}><IconButton aria-label={t('files_retry_unsuccessful') + ' (' + unsuccessful(job()).length + ')'} disabled={!sendAllowed() || !peers()?.some(node => node.id === job().peerId)} onClick={() => void send(job())}><MdIcon name="refresh" size={18} /></IconButton>
                <Show when={peers() !== null && !peerError() && !peers()?.some(node => node.id === job().peerId)}><span class="tool-hint">{t('files_retry_target_missing')}</span></Show>
              </Show></div>
            </section>;
          }}</For></div>
        </Show>
      </Show>
    </Card></section>
  </>;
}
