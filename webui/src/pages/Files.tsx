/*
 * Files (Taildrop) — inbox list (light), pull waiting files as a
 * cancellable session task, send form targeting a peer hostname.
 */
import { createEffect, createSignal, on, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot } from '../api';
import { t } from '../i18n';
import { getTask, startTask } from '../tasks';
import { fmtBytes, fmtTime } from '../format';
import { Card, SkeletonRows, EmptyState, ErrorState } from '../components/Basics';
import { TaskButton, TaskProgress } from '../components/TaskProgress';
import { showToast } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, Select, TextField } from '../components/ui';
import type { InboxFile, Peer } from '../types';

const RECV_KEY = 'file-receive';
const SEND_KEY = 'file-send';

export default function Files(): JSX.Element {
  const scope = createApiScope();
  const [files, setFiles] = createSignal<InboxFile[] | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [path, setPath] = createSignal('');
  const [peer, setPeer] = createSignal('');
  const [peers, setPeers] = createSignal<Peer[]>([]);

  const recvTask = () => getTask(RECV_KEY);
  const sendTask = () => getTask(SEND_KEY);

  async function loadInbox() {
    const res = await scope.api('files-inbox');
    if (res.cancelled) return;
    if (res.ok) {
      setFiles((res.files as InboxFile[]) || []);
      setLoadError(null);
    } else {
      setLoadError(res.error || t('error'));
    }
  }

  onMount(() => {
    void loadInbox();
    void scope.api('peers').then((res) => {
      if (res.cancelled || !res.ok) return;
      const list = (res.peers as Peer[]) || [];
      setPeers(list);
      if (list.length && !peer()) setPeer(list[0].hostname);
    });
  });

  /* Adopt task outcomes: refresh inbox + toast when a receive finishes. */
  createEffect(
    on(
      () => recvTask()?.status,
      (s, prev) => {
        if (s === 'done' && prev === 'running') {
          showToast(t('files_received'), 'ok');
          void loadInbox();
        }
      },
    ),
  );
  createEffect(
    on(
      () => sendTask()?.status,
      (s, prev) => {
        if (s === 'done' && prev === 'running') showToast(t('files_sent'), 'ok');
      },
    ),
  );

  return (
    <>
      <Card title={t('files_inbox')} icon="folder">
        <Show when={files() !== null} fallback={<SkeletonRows rows={3} />}>
          <Show
            when={!loadError()}
            fallback={<ErrorState text={loadError()!} onRetry={() => void loadInbox()} />}
          >
            <Show
              when={files()!.length > 0}
              fallback={<EmptyState text={t('files_empty')} icon="folder" />}
            >
              {files()!.map((f) => (
                <div class="list-row">
                  <MdIcon name="article" size={20} class="dim" />
                  <div class="main">
                    <div class="title mono">{f.name}</div>
                    <div class="sub">{fmtBytes(f.size) + ' · ' + fmtTime(f.mtime)}</div>
                  </div>
                </div>
              ))}
            </Show>
          </Show>
        </Show>
        <TaskProgress taskKey={RECV_KEY} />
        <Show when={recvTask()?.status === 'error'}>
          <ErrorState text={recvTask()?.result?.error || t('error')} />
        </Show>
        <div class="btn-row">
          <Button
            variant="outlined"
            disabled={recvTask()?.status === 'running' || !hasRoot}
            onClick={() => startTask(RECV_KEY, 'file-receive')}
          >
            <MdIcon name="download" size={18} /> {t('files_receive')}
          </Button>
        </div>
      </Card>

      <Card title={t('files_send')} icon="send">
        <TextField
          label={t('files_path')}
          placeholder={t('files_path_hint')}
          value={path()}
          onInput={(e: InputEvent) => setPath((e.target as HTMLInputElement).value)}
        />
        <Select
          label={t('files_peer')}
          value={peer()}
          onChange={(e: Event) => setPeer((e.target as HTMLSelectElement).value)}
        >
          {peers().map((p) => (
            <option value={p.hostname}>
              {p.hostname + (p.online ? '' : ' (' + t('offline') + ')')}
            </option>
          ))}
        </Select>
        <TaskProgress taskKey={SEND_KEY} />
        <Show when={sendTask()?.status === 'done'}>
          <div class="banner ok">
            <MdIcon name="check_circle" size={18} />
            <span>{t('files_sent')}</span>
          </div>
        </Show>
        <Show when={sendTask()?.status === 'error'}>
          <ErrorState text={sendTask()?.result?.error || t('error')} />
        </Show>
        <div class="btn-row">
          <TaskButton
            taskKey={SEND_KEY}
            cmd="file-send"
            args={[path().trim(), peer()]}
            label={t('files_send_btn')}
            icon={<MdIcon name="send" size={18} />}
            disabled={!path().trim() || !peer()}
          />
        </div>
      </Card>
    </>
  );
}
