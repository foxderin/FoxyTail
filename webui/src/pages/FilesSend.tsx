import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { api, createApiScope, hasRoot } from '../api';
import { DATA_DIR, TAILDROP_POLL_MS } from '../config';
import { fmtBytes, fmtTime } from '../format';
import { t, type I18nKey } from '../i18n';
import { MdIcon } from '../icons';
import { pollWhileVisible } from '../schedule';
import { Card, EmptyState, ErrorState, SkeletonRows } from '../components/Basics';
import { LoadGate } from '../components/LoadGate';
import { Button, Checkbox, IconButton, Select } from '../components/ui';
import type { BrowseEntry, TaildropTarget, Transfer, TransferStatus } from '../types';

const active = (job: Transfer) => job.status === 'queued' || job.status === 'sending';
const unsuccessful = (job: Transfer) => job.files.filter(file => file.status === 'failed' || file.status === 'cancelled');
const statusKeys: Record<TransferStatus, I18nKey> = {
  queued: 'files_queued', sending: 'files_sending', completed: 'files_completed',
  failed: 'files_failed', cancelled: 'files_cancelled', interrupted: 'files_interrupted',
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const component = (value: string) => !!value && value !== '.' && value !== '..' && !/[\\/\x00-\x1f\x7f]/.test(value);
const relative = (value: unknown): value is string => typeof value === 'string' && (value === '' || value.split('/').every(component));
const sharedPath = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/sdcard/') && value.length > 8 && relative(value.slice(8));
const sourcePath = (value: unknown) => sharedPath(value) || (typeof value === 'string' && value.startsWith(DATA_DIR + '/files/.outgoing/') && value.slice((DATA_DIR + '/files/.outgoing/').length).split('/').length === 2 && relative(value.slice((DATA_DIR + '/files/.outgoing/').length)));
const jobId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]+$/.test(value);
function transfer(value: unknown): value is Transfer {
  if (!record(value) || !jobId(value.id) || !text(value.peerId) || typeof value.peerName !== 'string' || !text(value.peerIp) ||
    !text(value.selfId) || typeof value.status !== 'string' || !Object.prototype.hasOwnProperty.call(statusKeys, value.status) ||
    !number(value.startedAt) || !number(value.updatedAt) || !Array.isArray(value.files) || !value.files.length || value.files.length > 32 ||
    (value.error !== undefined && typeof value.error !== 'string')) return false;
  return new Set(value.files.map(file => record(file) ? file.id : null)).size === value.files.length && value.files.every(file =>
    record(file) && jobId(file.id) && text(file.name) && component(file.name) && sourcePath(file.path) && number(file.size) &&
    number(file.sentBytes) && file.sentBytes <= file.size && typeof file.progressKnown === 'boolean' && number(file.bytesPerSecond) &&
    typeof file.status === 'string' && ['queued', 'sending', 'completed', 'failed', 'cancelled'].includes(file.status) &&
    (file.error === undefined || typeof file.error === 'string'));
}
function target(value: unknown): value is TaildropTarget {
  return record(value) && text(value.id) && typeof value.hostname === 'string' && typeof value.online === 'boolean' &&
    Array.isArray(value.ips) && value.ips.length > 0 && value.ips.every(text);
}

export default function FilesSend(): JSX.Element {
  const scope = createApiScope();
  const [peers, setPeers] = createSignal<TaildropTarget[] | null>(null);
  const [peer, setPeer] = createSignal('');
  const [peerError, setPeerError] = createSignal<string | null>(null);
  const [peerLoading, setPeerLoading] = createSignal(false);
  const [opened, setOpened] = createSignal(false);
  const [directory, setDirectory] = createSignal('');
  const [entries, setEntries] = createSignal<BrowseEntry[] | null>(null);
  const [truncated, setTruncated] = createSignal(false);
  const [browseError, setBrowseError] = createSignal<string | null>(null);
  const [browsing, setBrowsing] = createSignal(false);
  const [selection, setSelection] = createSignal<BrowseEntry[]>([]);
  const [history, setHistory] = createSignal<Transfer[] | null>(null);
  const [historyError, setHistoryError] = createSignal<string | null>(null);
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [observationError, setObservationError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [cancelling, setCancelling] = createSignal(false);
  const [cancelRequested, setCancelRequested] = createSignal('');
  const current = createMemo(() => history()?.find(active));
  const locked = () => submitting() || !!current();
  let disposed = false, revision = 0, observing = false;
  onCleanup(() => { disposed = true; });

  function accept(job: Transfer) {
    revision++;
    setHistory(previous => {
      const existing = previous?.find(item => item.id === job.id);
      if (existing && (existing.updatedAt > job.updatedAt || (!active(existing) && active(job)))) return previous;
      return [job, ...(previous ?? []).filter(item => item.id !== job.id)]
        .sort((a, b) => b.startedAt - a.startedAt).slice(0, 100);
    });
  }
  async function loadPeers() {
    if (!hasRoot || peerLoading()) return;
    setPeerLoading(true);
    const result = await scope.api('taildrop-targets');
    setPeerLoading(false);
    if (result.cancelled) return;
    if (!result.ok || !Array.isArray(result.peers) || !result.peers.every(target) || new Set(result.peers.map(item => item.id)).size !== result.peers.length) {
      setPeerError(result.error || t('files_invalid_response'));
      return;
    }
    const list = [...result.peers].sort((a, b) => Number(b.online) - Number(a.online) || a.hostname.localeCompare(b.hostname) || a.id.localeCompare(b.id));
    setPeers(list);
    setPeerError(null);
    if (!list.some(item => item.id === peer())) setPeer(list[0]?.id ?? '');
  }
  async function browse(path: string) {
    if (!hasRoot || browsing()) return;
    setOpened(true);
    setDirectory(path);
    setEntries(null);
    setBrowseError(null);
    setBrowsing(true);
    const result = await scope.api('files-browse', path || '-');
    setBrowsing(false);
    if (result.cancelled) return;
    if (!result.ok || result.path !== path || !relative(result.path) || typeof result.truncated !== 'boolean' || !Array.isArray(result.entries) || result.entries.length > 1000 ||
      !result.entries.every(entry => record(entry) && text(entry.name) && component(entry.name) && entry.path === '/sdcard/' + (path ? path + '/' : '') + entry.name &&
        typeof entry.directory === 'boolean' && number(entry.size) && number(entry.mtime))) {
      setBrowseError(result.error || t('files_invalid_response'));
      return;
    }
    setEntries(result.entries as BrowseEntry[]);
    setTruncated(result.truncated);
  }
  async function loadHistory() {
    if (!hasRoot || historyLoading()) return;
    setHistoryLoading(true);
    const started = revision;
    const result = await scope.api('file-send-history');
    setHistoryLoading(false);
    if (result.cancelled || started !== revision) return;
    if (!result.ok || !Array.isArray(result.transfers) || result.transfers.length > 100 || !result.transfers.every(transfer) ||
      new Set(result.transfers.map(job => job.id)).size !== result.transfers.length || result.transfers.filter(active).length > 1) {
      setHistoryError(result.error || t('files_invalid_response'));
      return;
    }
    setHistory(result.transfers);
    setHistoryError(null);
  }
  async function observe() {
    const job = current();
    if (!job || observing || !hasRoot) return;
    observing = true;
    const result = await scope.api('file-send-status', job.id);
    observing = false;
    if (result.cancelled || disposed) return;
    if (!result.ok || !transfer(result.transfer) || result.transfer.id !== job.id) {
      setObservationError(result.error || t('files_invalid_response'));
      return;
    }
    setObservationError(null);
    accept(result.transfer);
  }
  async function send(paths: string[], destination: TaildropTarget) {
    if (locked() || !hasRoot || history() === null || historyError() || peerError() || !paths.length || paths.length > 32) return;
    setSubmitting(true);
    setActionError(null);
    // Detached backend jobs must not inherit page-observer cancellation.
    const result = await api('file-send-start', destination.id, destination.ips[0], JSON.stringify(paths));
    if (disposed) return;
    setSubmitting(false);
    if (!result.ok || !transfer(result.transfer) || result.transfer.peerId !== destination.id || result.transfer.peerIp !== destination.ips[0] ||
      result.transfer.files.length !== paths.length || result.transfer.files.some((file, index) => file.path !== paths[index])) {
      setActionError(result.error || t('files_invalid_response'));
      void loadHistory();
      return;
    }
    accept(result.transfer);
    setSelection([]);
    setCancelRequested('');
    setObservationError(null);
  }
  async function cancel(job: Transfer) {
    if (cancelling() || !hasRoot) return;
    setCancelling(true);
    setActionError(null);
    const result = await api('file-send-cancel', job.id);
    if (disposed) return;
    setCancelling(false);
    if (!result.ok || !transfer(result.transfer) || result.transfer.id !== job.id) {
      setActionError(result.error || t('files_invalid_response'));
      return;
    }
    setCancelRequested(job.id);
    accept(result.transfer);
  }
  function toggle(entry: BrowseEntry) {
    setSelection(previous => previous.some(file => file.path === entry.path)
      ? previous.filter(file => file.path !== entry.path)
      : previous.length < 32 ? [...previous, entry] : previous);
  }
  onMount(() => { void loadPeers(); void loadHistory(); });
  pollWhileVisible(observe, () => hasRoot && current() ? TAILDROP_POLL_MS : false);

  return <>
    <Card title={t('files_send')} icon="send">
      <Show when={hasRoot} fallback={<EmptyState text={t('files_root_required')} icon="folder" />}>
        <p class="tool-hint">{t('files_send_hint')}</p>
        <LoadGate ready={peers() !== null} error={peerError()} onRetry={() => void loadPeers()}
          skeleton={<SkeletonRows rows={1} />} hasContent={(peers()?.length ?? 0) > 0}
          empty={<EmptyState text={t('tools_no_peers')} icon="group" />}>
          <Select label={t('files_peer')} aria-label={t('files_peer')} value={peer()} disabled={locked()}
            onChange={event => setPeer((event.target as HTMLSelectElement).value)}>
            <For each={peers() ?? []}>{node => <option value={node.id}>
              {node.hostname} · {node.ips[0]}{node.online ? '' : ' (' + t('offline') + ')'}
            </option>}</For>
          </Select>
        </LoadGate>
        <div class="tool-actions">
          <Button variant="text" busy={peerLoading()} disabled={locked()} onClick={() => void loadPeers()}>{t('files_refresh_targets')}</Button>
          <Button variant="tonal" disabled={locked()} aria-expanded={opened()} aria-controls="taildrop-browser"
            onClick={() => opened() ? setOpened(false) : void browse(directory())}>
            <MdIcon name="folder" size={18} />{opened() ? t('files_close_browser') : t('files_choose')}
          </Button>
        </div>
        <Show when={opened()}>
          <section id="taildrop-browser" aria-label={t('files_choose')} aria-busy={browsing()}>
            <nav class="tool-actions" aria-label={t('files_location')}>
              <Button variant="text" disabled={browsing()} onClick={() => void browse('')}>/sdcard</Button>
              <For each={directory().split('/').filter(Boolean)}>{(part, index) =>
                <Button variant="text" disabled={browsing()} onClick={() => void browse(directory().split('/').slice(0, index() + 1).join('/'))}>{part}</Button>
              }</For>
              <Button variant="text" disabled={browsing() || !directory()} onClick={() => void browse(directory().split('/').slice(0, -1).join('/'))}>{t('files_parent')}</Button>
              <Button variant="text" busy={browsing()} onClick={() => void browse(directory())}>{t('tools_refresh')}</Button>
            </nav>
            <LoadGate ready={entries() !== null} error={browseError()} onRetry={() => void browse(directory())}
              skeleton={<SkeletonRows rows={3} />} hasContent={(entries()?.length ?? 0) > 0}
              empty={<EmptyState text={t('files_directory_empty')} icon="folder" />}>
              <For each={entries() ?? []}>{entry => <div class="list-row tool-row-wrap">
                <MdIcon name={entry.directory ? 'folder' : 'article'} size={20} class="dim" />
                <div class="main"><div class="title" style="overflow-wrap:anywhere">{entry.name}</div>
                  <div class="sub">{entry.directory ? t('files_directory') : fmtBytes(entry.size)} · {fmtTime(entry.mtime)}</div>
                </div>
                <Show when={entry.directory} fallback={<Checkbox aria-label={t('files_select') + ' ' + entry.name}
                  checked={selection().some(file => file.path === entry.path)}
                  disabled={locked() || (selection().length >= 32 && !selection().some(file => file.path === entry.path))}
                  onChange={() => toggle(entry)} />}>
                  <Button variant="text" aria-label={t('files_open_directory') + ' ' + entry.name} disabled={browsing()}
                    onClick={() => void browse(entry.path.slice(8))}>{t('files_open_directory')}</Button>
                </Show>
              </div>}</For>
            </LoadGate>
            <Show when={!browsing() && !browseError() && truncated()}><p class="tool-hint" role="status">{t('files_truncated')}</p></Show>
            <Show when={browseError()}><p class="tool-hint">{t('files_storage_hint')}</p></Show>
          </section>
        </Show>
        <p class="tool-hint" aria-live="polite">{t('files_selected')} {selection().length}/32 · {fmtBytes(selection().reduce((sum, file) => sum + file.size, 0))}</p>
        <Show when={selection().length === 0}><p class="tool-hint">{t('files_selection_empty')}</p></Show>
        <For each={selection()}>{file => <div class="list-row tool-row-wrap">
          <div class="main"><div class="title" style="overflow-wrap:anywhere">{file.name}</div><div class="sub" style="overflow-wrap:anywhere">{file.path} · {fmtBytes(file.size)}</div></div>
          <IconButton aria-label={t('files_remove_selection') + ' ' + file.name} disabled={locked()} onClick={() => toggle(file)}><MdIcon name="close" size={18} /></IconButton>
        </div>}</For>
        <Button busy={submitting()} disabled={locked() || history() === null || !!historyError() || !!peerError() || !selection().length || !peers()?.some(node => node.id === peer())}
          onClick={() => { const destination = peers()?.find(node => node.id === peer()); if (destination) void send(selection().map(file => file.path), destination); }}>
          <MdIcon name="send" size={18} />{t('files_send_btn')}
        </Button>
        <Show when={actionError()}><ErrorState text={actionError()!} /></Show>
      </Show>
    </Card>
    <Card title={t('files_history')} icon="send" actions={<Button variant="text" busy={historyLoading()} disabled={!hasRoot || submitting()} onClick={() => void loadHistory()}>{t('tools_refresh')}</Button>}>
      <Show when={hasRoot} fallback={<EmptyState text={t('files_root_required')} icon="folder" />}>
        <LoadGate ready={history() !== null} error={historyError()} onRetry={() => void loadHistory()}
          skeleton={<SkeletonRows rows={2} />} hasContent={(history()?.length ?? 0) > 0}
          empty={<EmptyState text={t('files_history_empty')} icon="send" />}>
          <Show when={observationError()}><ErrorState text={observationError()!} onRetry={() => void observe()} /><p class="tool-hint">{t('files_observation_hint')}</p></Show>
          <For each={history() ?? []}>{job => <section class="tool-form" aria-label={job.peerName + ' · ' + fmtTime(job.startedAt)} data-transfer-id={job.id}>
            <h3 style="overflow-wrap:anywhere">{job.peerName || job.peerId} · {job.peerIp}</h3>
            <p class="tool-hint">{fmtTime(job.startedAt)} · {t('files_completed_count')} {job.files.filter(file => file.status === 'completed').length}/{job.files.length}</p>
            <p role="status">{t(statusKeys[job.status])}</p>
            <Show when={active(job)}><p class="tool-hint">{t('files_accepted_hint')}</p></Show>
            <Show when={job.error}><ErrorState text={job.error!} /></Show>
            <For each={job.files}>{file => <div class="list-row tool-row-wrap">
              <div class="main"><div class="title" style="overflow-wrap:anywhere">{file.name}</div>
                <div class="sub">{t(statusKeys[file.status])} · {fmtBytes(file.size)}</div>
                <Show when={file.status === 'sending'}>
                  <Show when={file.progressKnown} fallback={<p class="tool-hint">{t('files_progress_unknown')}</p>}>
                    <p class="tool-hint">{fmtBytes(file.sentBytes)} / {fmtBytes(file.size)} · {fmtBytes(file.bytesPerSecond)}/s</p>
                    <progress style="width:100%" max={file.size || 1} value={file.sentBytes} aria-label={t('files_sending') + ' ' + file.name} />
                  </Show>
                </Show>
                <Show when={file.error}><p class="tool-hint lat-bad" role="alert">{file.error}</p></Show>
              </div>
            </div>}</For>
            <Show when={active(job)}>
              <Button variant="text" busy={cancelling()} disabled={cancelRequested() === job.id} onClick={() => void cancel(job)}>{t('files_cancel_send')}</Button>
              <Show when={cancelRequested() === job.id}><p role="status">{t('files_cancel_requested')}</p></Show>
            </Show>
            <Show when={!active(job) && unsuccessful(job).length > 0}>
              <Button variant="tonal" disabled={locked() || !!historyError() || !!peerError() || !peers()?.some(node => node.id === job.peerId)} onClick={() => {
                const destination = peers()?.find(node => node.id === job.peerId);
                if (destination) { setPeer(destination.id); void send(unsuccessful(job).map(file => file.path), destination); }
              }}>{t('files_retry_unsuccessful')} ({unsuccessful(job).length})</Button>
              <Show when={!peers()?.some(node => node.id === job.peerId)}><p class="tool-hint">{t('files_retry_target_missing')}</p></Show>
            </Show>
          </section>}</For>
        </LoadGate>
      </Show>
    </Card>
  </>;
}
