/** Exit selection is explicit; native owns probes and their cancellation. */
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
import { Button } from '../components/ui';
import type { ExitNodeProbe } from '../types';
import './network.css';
import { createGuardedLoad } from './tools-refresh';
import { bindNativeDraft } from '../settings';
import { confirmDialog } from '../components/ConfirmDialog';

const TASK_KEY = 'speedtest-exitnodes';

export default function ExitNodes(): JSX.Element {
  const scope = createApiScope();
  const peers = () => sharedPeers()?.filter(peer => peer.exitNodeOption) ?? null;
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [switching, setSwitching] = createSignal(false);
  // null follows shared status; the empty string deliberately selects no exit.
  const [draftId, setDraftId] = createSignal<string | null>(null);
  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [draftIdentity, setDraftIdentity] = createSignal('');
  const draftReady = bindNativeDraft('exit', () => ({
    identity: draftId() === null ? '' : draftIdentity(), id: draftId() ?? '',
  }), value => {
    if (typeof value.identity === 'string' && value.identity && typeof value.id === 'string') {
      if (status()?.self?.id && status()?.self?.id !== value.identity) return;
      setDraftIdentity(value.identity); setDraftId(value.id);
    }
  });
  const task = () => getTask(TASK_KEY);
  // A live daemon can be stopped even when its exit preferences are unreadable.
  const statusKnown = () =>
    !statusError() && status()?.exitRouting?.known === true && !['unknown', 'stopped'].includes(connState(status()));
  const currentId = () =>
    statusKnown() ? (status()?.exitRouting?.selected?.auto ? `auto:${status()!.exitRouting!.selected!.auto}` : status()?.exitRouting?.selected?.id || status()?.exitRouting?.selected?.ip || '') : null;
  const selectedId = () => draftId() ?? currentId();
  const changed = () =>
    selectedId() !== null &&
    currentId() !== null &&
    selectedId() !== currentId();
  const selectedPeer = () =>
    (peers() || []).find((peer) => peer.id === selectedId());
  const canApply = () =>
    nativeControl().canWrite && !nativeControl().busy &&
    statusKnown() &&
    pendingId() === null &&
    (changed() || status()?.exitRouting?.effective === 'not-effective') &&
    (selectedId() === '' || selectedPeer()?.online);
  const choose = (id: string) => {
    setPendingId(null);
    setDraftId(id);
  };
  createEffect(() => {
    const next = status()?.self?.id;
    if (next && next !== draftIdentity()) { setDraftId(null); setPendingId(null); setDraftIdentity(next); }
  });
  createEffect(() => {
    const expected = pendingId();
    if (expected !== null && statusKnown() && currentId() === expected && status()?.exitRouting?.effective !== 'not-effective') {
      setPendingId(null);
      setDraftId(null);
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

  async function applySelection() {
    if (switching() || !canApply()) return;
    const selected = selectedId();
    const identity = status()?.self?.id;
    const accountRevision = nativeControl().accountRevision;
    const revision = nativeControl().revision;
    if (selected === null || !identity) return;
    setSwitching(true);
    try {
      if (!await confirmDialog(t('native_exit_confirm'))) return;
      if (!canApply() || selectedId() !== selected || status()?.self?.id !== identity ||
          nativeControl().accountRevision !== accountRevision || nativeControl().revision !== revision ||
          (selected !== '' && (!selectedPeer()?.online || selectedPeer()?.id !== selected))) {
        showToast(t('native_exit_changed'), 'info');
        return;
      }
      const res = selected === ''
        ? await scope.api('exitnode-clear')
        : await scope.api('exitnode-set', selected);
      if (res.cancelled || status()?.self?.id !== identity || nativeControl().accountRevision !== accountRevision) return;
      if (res.ok) {
        setDraftId(selected);
        setPendingId(selected);
      } else toastApiError(t('op_failed'), res);
      await refreshStatus({ afterCurrent: true });
      await refreshExitRouting();
    } finally { setSwitching(false); }
  }

  onMount(() => void draftReady.then(loadList));

  return (
    <div class="page-stack network-page">
      <div class="toolbar">
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
              disabled={statusLoading() || switching()}
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
            classList={{ 'is-selected': selectedId() === '' }}
          >
            <input
              type="radio"
              name="exit-node"
              value=""
              checked={selectedId() === ''}
              disabled={switching() || !hasRoot || !statusKnown()}
              onChange={() => choose('')}
            />
            <div class="network-device-avatar">
              <MdIcon name="language" size={23} />
            </div>
            <div class="network-exit-option-copy">
              <strong>{t('net_exit_local')}</strong>
              <span>{t('net_exit_local_hint')}</span>
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
                      'is-selected': selectedId() === peer.id,
                      'is-offline': !peer.online,
                    }}
                  >
                    <input
                      type="radio"
                      name="exit-node"
                      value={peer.id}
                      checked={selectedId() === peer.id}
                      disabled={
                        !peer.online ||
                        switching() ||
                        !hasRoot ||
                        !statusKnown()
                      }
                      onChange={() => choose(peer.id)}
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
                        <StatusDot state={peer.online ? 'on' : 'off'} />
                        {peer.online
                          ? t('net_filter_online')
                          : t('net_filter_offline')}
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
                !statusKnown() || pendingId() !== null || changed() || status()?.exitRouting?.effective === 'not-effective'
                  ? 'warn'
                  : 'on'
              }
            />
            <span>
              {pendingId() !== null
                ? t('net_exit_confirming')
                : !statusKnown()
                  ? t('net_exit_unknown')
                  : changed()
                    ? t('net_exit_pending') +
                      ' · ' +
                      (selectedPeer()?.hostname || t('net_exit_local'))
                    : t(exitRoutingLabel())}
            </span>
          </div>
          <Show when={pendingId() !== null}>
            <Button
              variant="text"
              disabled={switching()}
              onClick={() => void refreshStatus({ afterCurrent: true })}
            >
              <MdIcon name="refresh" size={18} />
              {t('retry')}
            </Button>
          </Show>
          <Button
            variant="filled"
            busy={switching()}
            disabled={!canApply() || !hasRoot}
            onClick={() => void applySelection()}
          >
            <MdIcon name="check" size={18} />
            {switching() ? t('net_working') : t('net_exit_apply')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
