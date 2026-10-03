import { DATA_DIR } from '../config';
/* Taildrop operations stay in the session task registry across navigation. */
import { createEffect, createMemo, createSignal, For, on, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot } from '../api';
import { t } from '../i18n';
import { getTask, startTask } from '../tasks';
import { fmtBytes, fmtTime } from '../format';
import { Card, SkeletonRows, EmptyState, ErrorState, MetricCard } from '../components/Basics';
import { LoadGate } from '../components/LoadGate';
import { copyWithToast } from '../clipboard';
import { TaskButton, TaskProgress } from '../components/TaskProgress';
import { showToast } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, IconButton, Select, TextField } from '../components/ui';
import type { InboxFile, Peer } from '../types';
import './tools.css';
import { createQueuedRefresh } from './tools-refresh';
const RECV_KEY = 'file-receive';
const SEND_KEY = 'file-send';
export default function Files(): JSX.Element {
  const scope = createApiScope();
  const [files, setFiles] = createSignal<InboxFile[] | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [filter, setFilter] = createSignal('');
  const [path, setPath] = createSignal('');
  const [peer, setPeer] = createSignal('');
  const [peers, setPeers] = createSignal<Peer[] | null>(null);
  const [peerError, setPeerError] = createSignal<string | null>(null);
  const recvTask = () => getTask(RECV_KEY);
  const sendTask = () => getTask(SEND_KEY);
  const visibleFiles = createMemo(() =>
    (files() ?? []).filter((file) =>
      file.name.toLocaleLowerCase().includes(filter().toLocaleLowerCase()),
    ),
  );
  const pathValid = () =>
    path().trim().startsWith('/sdcard/') && path().trim().length > '/sdcard/'.length;
  const loadInbox = createQueuedRefresh(
    () => scope.api('files-inbox'),
    (res) => {
      if (res.ok) {
        setFiles((res.files as InboxFile[]) || []);
        setLoadError(null);
      } else setLoadError(res.error || t('error'));
    },
    setLoading,
  );
  async function loadPeers() {
    setPeerError(null);
    const res = await scope.api('peers');
    if (res.cancelled) return;
    if (!res.ok) {
      setPeers([]);
      setPeerError(res.error || t('error'));
      return;
    }
    const list = ((res.peers as Peer[]) || [])
      .slice()
      .sort((a, b) => Number(b.online) - Number(a.online) || a.hostname.localeCompare(b.hostname));
    setPeers(list);
    if (!list.some((node) => node.hostname === peer())) setPeer(list[0]?.hostname ?? '');
  }
  async function downloadFile(name: string) {
    const res = await scope.api('file-download', name);
    if (!res.ok) {
      showToast(res.error || t('error'), 'err');
      return;
    }
    // Decode base64 → blob → anchor download.
    const b64 = (res.data as string) || '';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    showToast(t('files_download_started'), 'ok');
  }
  async function exportFile(name: string) {
    const res = await scope.api('file-export', name);
    if (!res.ok) {
      showToast(res.error || t('error'), 'err');
      return;
    }
    showToast(t('files_exported_to') + ' ' + ((res.path as string) || ''), 'ok');
  }
  async function deleteFile(name: string) {
    const res = await scope.api('file-delete', name);
    if (!res.ok) {
      showToast(res.error || t('error'), 'err');
      return;
    }
    showToast(t('files_deleted'), 'ok');
    void loadInbox();
  }
  async function clearInbox() {
    const res = await scope.api('file-clear');
    if (!res.ok) {
      showToast(res.error || t('error'), 'err');
      return;
    }
    showToast(t('files_cleared') + ' (' + String(res.removed ?? 0) + ')', 'ok');
    void loadInbox();
  }

  onMount(() => {
    void loadInbox();
    void loadPeers();
  });
  createEffect(
    on(
      () => recvTask()?.status,
      (value, previous) => {
        if (value === 'done' && previous === 'running') {
          showToast(t('files_received'), 'ok');
          void loadInbox();
        }
      },
    ),
  );
  createEffect(
    on(
      () => sendTask()?.status,
      (value, previous) => {
        if (value === 'done' && previous === 'running') showToast(t('files_sent'), 'ok');
      },
    ),
  );
  return (
    <div class="tools-page">
      <Show when={files() !== null}>
        <div class="metric-grid">
          <MetricCard
            label={t('files_inbox')}
            value={files()!.length}
            caption={t('tools_file_count')}
            icon="folder"
          />
          <MetricCard
            label={t('tools_total_size')}
            value={fmtBytes(files()!.reduce((total, file) => total + file.size, 0))}
            icon="download"
          />
        </div>
      </Show>
      <Card
        title={t('files_inbox')}
        icon="folder"
        actions={
          <Button variant="text" busy={loading()} onClick={() => void loadInbox()}>
            <MdIcon name="refresh" size={18} />
            {t('tools_refresh')}
          </Button>
        }
      >
        <Show when={files() !== null || loadError()} fallback={<SkeletonRows rows={4} />}>
          <Show
            when={!loadError()}
            fallback={<ErrorState text={loadError()!} onRetry={() => void loadInbox()} />}
          >
            <Show when={(files()?.length ?? 0) > 0}>
              <div class="tool-row-wrap" style="display:flex;gap:8px;align-items:flex-end;">
                <div style="flex:1">
                  <TextField
                    label={t('tools_file_search')}
                    aria-label={t('tools_file_search')}
                    value={filter()}
                    onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
                    leading-icon={<MdIcon name="search" size={18} />}
                  />
                </div>
                <Button
                  variant="text"
                  disabled={!hasRoot}
                  onClick={() => void clearInbox()}
                  aria-label={t('files_clear')}
                >
                  <MdIcon name="delete" size={18} />
                  {t('files_clear')}
                </Button>
              </div>
            </Show>
            <Show
              when={visibleFiles().length}
              fallback={<EmptyState text={filter() ? t('empty') : t('files_empty')} icon="folder" />}
            >
              <For each={visibleFiles()}>
                {(file) => (
                  <div class="list-row tool-row-wrap">
                    <MdIcon name="article" size={20} class="dim" />
                    <div class="main">
                      <div class="title">{file.name}</div>
                      <div class="sub">
                        {fmtBytes(file.size)} · {fmtTime(file.mtime)}
                      </div>
                    </div>
                    <IconButton
                      aria-label={t('tools_copy_path') + ' ' + file.name}
                      onClick={() => copyWithToast(DATA_DIR + '/files/' + file.name, 'info')}
                    >
                      <MdIcon name="content_copy" size={18} />
                    </IconButton>
                    <IconButton
                      aria-label={t('files_download') + ' ' + file.name}
                      disabled={!hasRoot}
                      onClick={() => void downloadFile(file.name)}
                    >
                      <MdIcon name="download" size={18} />
                    </IconButton>
                    <IconButton
                      aria-label={t('files_export') + ' ' + file.name}
                      disabled={!hasRoot}
                      onClick={() => void exportFile(file.name)}
                    >
                      <MdIcon name="open_in_new" size={18} />
                    </IconButton>
                    <IconButton
                      aria-label={t('files_delete') + ' ' + file.name}
                      disabled={!hasRoot}
                      onClick={() => void deleteFile(file.name)}
                    >
                      <MdIcon name="delete" size={18} />
                    </IconButton>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </Show>
        <TaskProgress taskKey={RECV_KEY} />
        <Show when={recvTask()?.status === 'error'}>
          <ErrorState text={recvTask()?.result?.error || t('error')} />
        </Show>
        <div class="tool-actions">
          <Button
            variant="tonal"
            busy={recvTask()?.status === 'running'}
            disabled={!hasRoot}
            onClick={() => startTask(RECV_KEY, 'file-receive')}
          >
            <MdIcon name="download" size={18} />
            {t('files_receive')}
          </Button>
        </div>
      </Card>
      <Card title={t('files_send')} icon="send">
        <div class="tool-form">
          <TextField
            label={t('files_path')}
            placeholder={t('files_path_hint')}
            value={path()}
            disabled={sendTask()?.status === 'running'}
            onInput={(e) => setPath((e.target as HTMLInputElement).value)}
          />
          <Show when={path().trim() && !pathValid()}>
            <p class="tool-hint lat-bad" role="alert">
              {t('tools_files_path_invalid')}
            </p>
          </Show>
          <LoadGate
            ready={peers() !== null}
            error={peerError()}
            onRetry={() => void loadPeers()}
            skeleton={<SkeletonRows rows={1} />}
            hasContent={(peers()?.length ?? 0) > 0}
            empty={
              <div>
                <EmptyState text={t('tools_no_peers')} icon="group" />
                <Button variant="text" onClick={() => void loadPeers()}>
                  {t('tools_retry')}
                </Button>
              </div>
            }
          >
                <Select
                  label={t('files_peer')}
                  value={peer()}
                  disabled={sendTask()?.status === 'running'}
                  onChange={(e) => setPeer((e.target as HTMLSelectElement).value)}
                >
                  <For each={peers()!}>
                    {(node) => (
                      <option value={node.hostname}>
                        {node.hostname}
                        {node.online ? '' : ' (' + t('offline') + ')'}
                      </option>
                    )}
                  </For>
                </Select>
          </LoadGate>
          <TaskProgress taskKey={SEND_KEY} />
          <Show when={sendTask()?.status === 'done'}>
            <div class="alert ok" role="status">
              <MdIcon name="check_circle" size={18} />
              {t('files_sent')}
            </div>
          </Show>
          <Show when={sendTask()?.status === 'error'}>
            <ErrorState text={sendTask()?.result?.error || t('error')} />
          </Show>
          <div>
            <TaskButton
              taskKey={SEND_KEY}
              cmd="file-send"
              args={[path().trim(), peer()]}
              label={t('files_send_btn')}
              icon={<MdIcon name="send" size={18} />}
              disabled={!pathValid() || !peer() || !hasRoot}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}
