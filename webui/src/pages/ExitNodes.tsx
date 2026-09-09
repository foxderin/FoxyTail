/*
 * Exit Nodes — list (light read), latency speed test as a session-level
 * cancellable task with progress (never auto-started), one-tap switch.
 */
import { createSignal, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot } from '../api';
import { t } from '../i18n';
import { status, refreshStatus } from '../state';
import { getTask } from '../tasks';
import { latClass } from '../format';
import { Card, StatusDot, SkeletonRows, EmptyState, ErrorState } from '../components/Basics';
import { TaskButton, TaskProgress } from '../components/TaskProgress';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button } from '../components/ui';
import type { Peer, ExitNodeProbe } from '../types';

const TASK_KEY = 'speedtest-exitnodes';

export default function ExitNodes(): JSX.Element {
  const scope = createApiScope();
  const [peers, setPeers] = createSignal<Peer[] | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [switching, setSwitching] = createSignal<string | null>(null);
  const [clearing, setClearing] = createSignal(false);

  const task = () => getTask(TASK_KEY);
  const latMap = (): Record<string, number | null> => {
    const tsk = task();
    if (!tsk || !tsk.result?.ok) return {};
    const out: Record<string, number | null> = {};
    ((tsk.result.results as ExitNodeProbe[]) || []).forEach((r) => {
      out[r.id] = r.latencyMs;
    });
    return out;
  };
  /* After a successful speed test, rows follow the latency-sorted order. */
  const sortedIds = (): string[] => {
    const tsk = task();
    if (!tsk || !tsk.result?.ok) return [];
    return ((tsk.result.results as ExitNodeProbe[]) || []).map((r) => r.id);
  };

  const currentId = () => status()?.exitNode?.id ?? null;

  const rows = (): Peer[] => {
    const list = peers() ?? [];
    const order = sortedIds();
    if (!order.length) return list;
    const byId = new Map(list.map((p) => [p.id, p]));
    const sorted: Peer[] = [];
    order.forEach((id) => {
      const p = byId.get(id);
      if (p) {
        sorted.push(p);
        byId.delete(id);
      }
    });
    return [...sorted, ...byId.values()];
  };

  async function loadList() {
    const res = await scope.api('exitnodes');
    if (res.cancelled) return;
    if (res.ok) {
      setPeers((res.peers as Peer[]) || []);
      setLoadError(null);
    } else {
      setLoadError(res.error || t('error'));
    }
  }

  async function useNode(p: Peer) {
    if (switching()) return;
    setSwitching(p.id);
    const res = await scope.api('exitnode-set', p.ip);
    setSwitching(null);
    if (res.cancelled) return;
    if (res.ok) {
      showToast(t('exit_set_done'), 'ok');
      void refreshStatus();
    } else toastApiError(t('op_failed'), res);
  }

  async function clearNode() {
    if (clearing()) return;
    setClearing(true);
    const res = await scope.api('exitnode-clear');
    setClearing(false);
    if (res.cancelled) return;
    if (res.ok) {
      showToast(t('exit_cleared'), 'ok');
      void refreshStatus();
    } else toastApiError(t('op_failed'), res);
  }

  onMount(() => {
    void loadList();
    void refreshStatus();
  });

  return (
    <>
      <Card title={t('exit_title')} icon="logout">
        <Show when={peers() !== null || loadError() !== null} fallback={<SkeletonRows rows={3} />}>
          <Show
            when={!loadError()}
            fallback={<ErrorState text={loadError()!} onRetry={() => void loadList()} />}
          >
            <Show
              when={rows().length > 0}
              fallback={<EmptyState text={t('exit_empty')} icon="logout" />}
            >
              {rows().map((p) => {
                const lat = () => (p.id in latMap() ? latMap()[p.id] : undefined);
                return (
                  <div class="list-row">
                    <StatusDot state={p.online ? 'on' : 'off'} />
                    <div class="main">
                      <div class="title">
                        {p.hostname}
                        <Show when={p.id === currentId()}>
                          <span class="badge">{t('exit_current')}</span>
                        </Show>
                      </div>
                      <div class="sub">
                        {p.ip + ' · ' + p.relay}
                        <Show when={lat() !== undefined}>
                          {' · '}
                          <span class={lat() === null ? 'dim' : latClass(lat())}>
                            {lat() === null ? '✗' : lat() + 'ms'}
                          </span>
                        </Show>
                      </div>
                    </div>
                    <Button
                      variant="tonal"
                      disabled={
                        p.id === currentId() || switching() !== null || !hasRoot
                      }
                      onClick={() => void useNode(p)}
                    >
                      {p.id === currentId() ? t('exit_current') : t('exit_use')}
                    </Button>
                  </div>
                );
              })}
            </Show>
          </Show>
        </Show>
      </Card>

      <TaskProgress taskKey={TASK_KEY} />
      <Show when={task()?.status === 'error'}>
        <div class="banner warn">
          <MdIcon name="error" size={18} />
          <span>{task()?.result?.error || t('error')}</span>
        </div>
      </Show>

      <div class="btn-row">
        <TaskButton
          taskKey={TASK_KEY}
          cmd="speedtest-exitnodes"
          label={task()?.status === 'running' ? t('exit_testing') : t('exit_test')}
          icon={<MdIcon name="speed" size={18} />}
        />
        <Button
          variant="outlined"
          disabled={!currentId() || clearing() || !hasRoot}
          onClick={() => void clearNode()}
        >
          <MdIcon name="close" size={18} /> {t('exit_clear')}
        </Button>
      </div>
    </>
  );
}
