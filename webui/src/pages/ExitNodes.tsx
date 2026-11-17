/** Exit switching is one tap per row; native owns probes and their cancellation. */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onMount,
  Show,
  type JSX,
} from 'solid-js';
import { createApiScope, hasRoot, nativeControl } from '../api';
import { t } from '../i18n';
import { status, statusError, statusLoading, refreshStatus, refreshPeers, refreshExitRouting, peers as sharedPeers, connState, exitRoutingLabel } from '../state';
import { getTask } from '../tasks';
import { latClass } from '../format';
import {
  Card,
  StatusDot,
  SkeletonRows,
  EmptyState,
  ErrorState,
} from '../components/Basics';
import { RefreshButton } from '../components/RefreshButton';
import { OsIcon } from '../components/OsIcon';
import { TaskButton, TaskProgress } from '../components/TaskProgress';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, CircularProgress } from '../components/ui';
import type { ExitNodeProbe } from '../types';
import './network.css';
import { createGuardedLoad } from './tools-refresh';
import { confirmDialog } from '../components/ConfirmDialog';

const TASK_KEY = 'speedtest-exitnodes';

export default function ExitNodes(): JSX.Element {
  const scope = createApiScope();
  const peers = () => sharedPeers()?.filter(peer => peer.exitNodeOption) ?? null;
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  // id of the row currently applying, or null; '' means "clear to local".
  const [applying, setApplying] = createSignal<string | null>(null);
  // last accepted target awaiting confirmation from a fresh status snapshot.
  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const task = () => getTask(TASK_KEY);
  // A live daemon can be stopped even when its exit preferences are unreadable.
  const statusKnown = () =>
    !statusError() && status()?.exitRouting?.known === true && !['unknown', 'stopped'].includes(connState(status()));
  const currentId = () =>
    statusKnown() ? (status()?.exitRouting?.selected?.auto ? `auto:${status()!.exitRouting!.selected!.auto}` : status()?.exitRouting?.selected?.id || status()?.exitRouting?.selected?.ip || '') : null;
  const peerById = (id: string) =>
    (peers() || []).find((peer) => peer.id === id);
  createEffect(() => {
    const expected = pendingId();
    if (expected !== null && statusKnown() && currentId() === expected && status()?.exitRouting?.effective !== 'not-effective') {
      setPendingId(null);
      showToast(t(expected === '' ? 'exit_cleared' : 'exit_set_done'), 'ok');
    }
  });
  const latMap = createMemo(() => {
    const result = task()?.result;
    const out: Record<string, number | null> = {};
    if (result?.ok)
      ((result.results as ExitNodeProbe[]) || []).forEach((probe) => {
        out[probe.id] = probe.latencyMs;
      });
    return out;
  });
  const rows = createMemo(() => {
    const list = [...(peers() || [])];
    const latencies = latMap();
    return list.sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        (latencies[a.id] ?? Infinity) - (latencies[b.id] ?? Infinity) ||
        a.hostname.localeCompare(b.hostname),
    );
  });

  const loadList = createGuardedLoad(
    async () => { const result = await refreshPeers(); await refreshExitRouting(); return result; },
    (res) => {
      if (res.ok) {
        setLoadError(null);
      } else setLoadError(res.error || t('error'));
    },
    setLoading,
  );

  const switchable = () =>
    applying() === null &&
    nativeControl().canWrite && !nativeControl().busy &&
    statusKnown() && hasRoot;

  async function applyTo(target: string) {
    if (!switchable()) return;
    // Re-tapping the current exit retries only when the previous apply did not take.
    if (target === currentId() && status()?.exitRouting?.effective !== 'not-effective') return;
    if (target !== '' && !peerById(target)?.online) return;
    const identity = status()?.self?.id;
    const accountRevision = nativeControl().accountRevision;
    const revision = nativeControl().revision;
    if (!identity) return;
    setApplying(target);
    try {
      if (!await confirmDialog({
        title: t('exit_switch_title'),
        body: t('native_exit_confirm'),
        confirmLabel: t(target === '' ? 'exit_clear' : 'exit_switch'),
      })) return;
      if (status()?.self?.id !== identity || !statusKnown() ||
          nativeControl().accountRevision !== accountRevision || nativeControl().revision !== revision ||
          (target !== '' && (!peerById(target)?.online || target === currentId() && status()?.exitRouting?.effective !== 'not-effective'))) {
        showToast(t('native_exit_changed'), 'info');
        return;
      }
      const res = target === ''
        ? await scope.api('exitnode-clear')
        : await scope.api('exitnode-set', target);
      if (res.cancelled || status()?.self?.id !== identity || nativeControl().accountRevision !== accountRevision) return;
      if (res.ok) {
        setPendingId(target);
      } else toastApiError(t('op_failed'), res);
      await refreshStatus({ afterCurrent: true });
      await refreshExitRouting();
    } finally { setApplying(null); }
  }

  onMount(() => void loadList());

  const optionBusy = (id: string) => applying() === id || pendingId() === id;

  return (
    <div class="page-stack network-page">
      <div class="tool-actions">
        <TaskButton
          taskKey={TASK_KEY}
          cmd="speedtest-exitnodes"
          label={
            task()?.status === 'running' ? t('exit_testing') : t('exit_test')
          }
          icon={<MdIcon name="speed" size={18} />}
          disabled={!rows().some((peer) => peer.online)}
        />
        <RefreshButton loading={loading()} onClick={() => void loadList()} />
      </div>
      <TaskProgress taskKey={TASK_KEY} />
      <div class="banner" classList={{ warn: !!status()?.exitRouting?.warning }}>
        <MdIcon name="info" size={18} />
        <span>{t(exitRoutingLabel())}</span>
      </div>
      <Show when={status()?.exitRouting?.selected && status()?.mode === 'bridge'}>
        <p class="network-supporting">{t('net_exit_scope')}: {status()?.exitRouting?.scope} {status()?.exitRouting?.uids?.join(', ')}</p>
      </Show>
      <Show when={statusKnown() && status()?.exitRouting?.selected && ['tun', 'bridge'].includes(status()?.mode || '') && status()?.exitRouting?.strictReversePath === true}>
        <p class="network-supporting" data-testid="exit-reverse-path">{t('net_exit_reverse_path')}</p>
      </Show>
      <Show when={task()?.status === 'error'}>
        <div class="banner warn">
          <MdIcon name="error" size={18} />
          <span>{task()?.result?.error || t('error')}</span>
        </div>
      </Show>

      <Show when={!statusKnown() || (status()?.exitNode && peers() !== null && !rows().some(peer => peer.id === currentId()))}>
      <section
        class="panel network-current-exit"
        aria-label={t('net_exit_selection')}
      >
        <div class="network-device-avatar">
          <MdIcon name={currentId() ? 'logout' : 'language'} size={26} />
        </div>
        <div class="network-current-exit-copy">
          <span class="eyebrow">{t('net_exit_selection')}</span>
          <h2>
            {statusKnown()
              ? status()?.exitNode?.hostname || currentId() || t('net_exit_local')
              : t('net_exit_unknown')}
          </h2>
          <p>
            {statusKnown()
              ? status()?.exitNode?.ip || t('net_exit_local_hint')
              : statusLoading()
                ? t('loading')
                : t('net_exit_unknown_hint')}
          </p>
        </div>
        <Show
          when={statusKnown()}
          fallback={
            <Button
              variant="outlined"
              disabled={statusLoading() || applying() !== null}
              onClick={() => void refreshStatus({ afterCurrent: true })}
            >
              <MdIcon name="refresh" size={18} />
              {t('retry')}
            </Button>
          }
        >
          <span class="network-small-badge">{t('exit_current')}</span>
        </Show>
        <Show
          when={
            statusKnown() && status()?.exitNode && !status()?.exitNode?.online
          }
        >
          <div class="banner warn">
            <MdIcon name="warning" size={18} />
            <span>{t('net_exit_unavailable')}</span>
          </div>
        </Show>
      </section>
      </Show>

      <Card title={t('net_exit_choose')} icon="router">
        <Show when={loadError()}>
          <ErrorState text={loadError()!} onRetry={() => void loadList()} />
        </Show>
        <div
          class="network-exit-options"
          role="radiogroup"
          aria-label={t('net_exit_choose')}
        >
          <label
            class="network-exit-option"
            classList={{ 'is-selected': currentId() === '', 'is-busy': optionBusy('') }}
          >
            <input
              type="radio"
              name="exit-node"
              value=""
              checked={currentId() === ''}
              disabled={!switchable()}
              onClick={() => void applyTo('')}
            />
            <div class="network-device-avatar">
              <MdIcon name="language" size={23} />
            </div>
            <div class="network-exit-option-copy">
              <strong>{t('net_exit_local')}</strong>
              <span>{t('net_exit_local_hint')}</span>
              <Show when={optionBusy('')}>
                <span class="network-exit-option-state">
                  <CircularProgress size={14} />
                  {t('net_working')}
                </span>
              </Show>
            </div>
            <Show when={currentId() === ''}>
              <span class="network-small-badge">{t('exit_current')}</span>
            </Show>
          </label>
          <Show
            when={peers() !== null || loadError() !== null}
            fallback={<SkeletonRows rows={3} />}
          >
            <Show
              when={rows().length > 0}
              fallback={
                <Show when={!loadError()}>
                  <EmptyState text={t('exit_empty')} icon="logout" />
                </Show>
              }
            >
              <For each={rows()}>
                {(peer) => (
                  <label
                    class="network-exit-option"
                    classList={{
                      'is-selected': currentId() === peer.id,
                      'is-offline': !peer.online,
                      'is-busy': optionBusy(peer.id),
                    }}
                  >
                    <input
                      type="radio"
                      name="exit-node"
                      value={peer.id}
                      checked={currentId() === peer.id}
                      disabled={
                        !peer.online || !switchable()
                      }
                      onClick={() => void applyTo(peer.id)}
                    />
                    <OsIcon os={peer.os} />
                    <div class="network-exit-option-copy">
                      <strong>
                        {peer.hostname}
                        <Show when={peer.id === currentId()}>
                          <span class="network-small-badge">
                            {t('exit_current')}
                          </span>
                        </Show>
                      </strong>
                      <span>
                        <code>{peer.ip}</code>
                        <Show when={peer.relay && peer.relay !== '-'}>
                          {' '}
                          · {peer.relay.toUpperCase()}
                        </Show>
                      </span>
                      <span class="network-exit-option-state">
                        <Show
                          when={optionBusy(peer.id)}
                          fallback={
                            <>
                              <StatusDot state={peer.online ? 'on' : 'off'} />
                              {peer.online
                                ? t('net_filter_online')
                                : t('exit_offline_hint')}
                            </>
                          }
                        >
                          <CircularProgress size={14} />
                          {t('net_working')}
                        </Show>
                      </span>
                    </div>
                    <div
                      class={'network-latency ' + latClass(latMap()[peer.id])}
                    >
                      <MdIcon name="speed" size={16} />
                      <span>
                        {latMap()[peer.id] === undefined
                          ? t('net_exit_untested')
                          : latMap()[peer.id] === null
                            ? t('net_exit_unreachable')
                            : `${latMap()[peer.id]} ms`}
                      </span>
                    </div>
                  </label>
                )}
              </For>
            </Show>
          </Show>
        </div>
        <div class="network-apply-bar">
          <div>
            <StatusDot
              state={
                !statusKnown() || pendingId() !== null || status()?.exitRouting?.effective === 'not-effective'
                  ? 'warn'
                  : 'on'
              }
            />
            <span>
              {pendingId() !== null
                ? t('net_exit_confirming')
                : !statusKnown()
                  ? t('net_exit_unknown')
                  : status()?.exitRouting?.effective === 'not-effective'
                    ? t('net_exit_failed')
                    : t('net_exit_applied')}
            </span>
          </div>
          <Show when={pendingId() !== null}>
            <Button
              variant="text"
              disabled={applying() !== null}
              onClick={() => void refreshStatus({ afterCurrent: true })}
            >
              <MdIcon name="refresh" size={18} />
              {t('retry')}
            </Button>
          </Show>
        </div>
      </Card>
    </div>
  );
}
