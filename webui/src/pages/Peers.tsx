/*
 * Peers — list tab + canvas topology tab. List auto-refreshes every 8s
 * (page-scoped timer, stops on unmount). Peer details in a dialog.
 */
import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { createApiScope } from '../api';
import { t } from '../i18n';
import { status } from '../state';
import { fmtBytes } from '../format';
import { Card, KvRow, StatusDot, SkeletonRows, EmptyState, ErrorState } from '../components/Basics';
import { TopologyChart } from '../components/TopologyChart';
import { MdIcon } from '../icons';
import { Button, Dialog, Tab, Tabs } from '../components/ui';
import type { Peer } from '../types';

export default function Peers(): JSX.Element {
  const scope = createApiScope();
  const [tab, setTab] = createSignal<'list' | 'topo'>('list');
  const [peers, setPeers] = createSignal<Peer[] | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [detail, setDetail] = createSignal<Peer | null>(null);

  async function loadPeers() {
    const res = await scope.api('peers');
    if (res.cancelled) return;
    if (res.ok) {
      setPeers((res.peers as Peer[]) || []);
      setLoadError(null);
    } else {
      setLoadError(res.error || t('error'));
    }
  }

  onMount(() => {
    void loadPeers();
    const id = setInterval(() => {
      if (!document.hidden && tab() === 'list') void loadPeers();
    }, 8000);
    onCleanup(() => clearInterval(id));
  });

  return (
    <>
      <Tabs
        activeTabIndex={tab() === 'list' ? 0 : 1}
        onChange={(e: Event) => {
          const idx = (e.target as unknown as { activeTabIndex: number }).activeTabIndex;
          setTab(idx === 0 ? 'list' : 'topo');
        }}
      >
        <Tab icon="group" label={t('peers_list')} />
        <Tab icon="router" label={t('peers_topology')} />
      </Tabs>

      <Show when={tab() === 'list'}>
        <Card title={t('peers_title')} icon="group">
          <Show when={peers() !== null} fallback={<SkeletonRows rows={4} />}>
            <Show
              when={!loadError()}
              fallback={<ErrorState text={loadError()!} onRetry={() => void loadPeers()} />}
            >
              <Show
                when={(peers() ?? []).length > 0}
                fallback={<EmptyState text={t('peers_empty')} icon="group" />}
              >
                {peers()!.map((p) => (
                  <div class="list-row" style={{ cursor: 'pointer' }} onClick={() => setDetail(p)}>
                    <StatusDot state={p.online ? 'on' : 'off'} />
                    <div class="main">
                      <div class="title">{p.hostname}</div>
                      <div class="sub">{p.ip + ' · ' + p.os + ' · ' + p.relay}</div>
                    </div>
                    <span class="dim">{'↓' + fmtBytes(p.rxBytes) + ' ↑' + fmtBytes(p.txBytes)}</span>
                  </div>
                ))}
              </Show>
            </Show>
          </Show>
        </Card>
      </Show>

      <Show when={tab() === 'topo'}>
        <Card title={t('peers_topology')} icon="router">
          <Show when={peers() !== null} fallback={<SkeletonRows rows={3} />}>
            <Show
              when={(peers() ?? []).length > 0}
              fallback={<EmptyState text={t('peers_empty')} icon="group" />}
            >
              <div class="dim">{t('peers_tap_hint')}</div>
              <TopologyChart
                self={status()?.self ?? null}
                peers={peers() ?? []}
                onPeerClick={(p) => setDetail(p)}
              />
            </Show>
          </Show>
        </Card>
      </Show>

      <Show when={detail()}>
        {(p) => (
          <Dialog
            open
            headline={t('peers_detail')}
            onClose={() => setDetail(null)}
          >
            <KvRow k={t('dash_hostname')} v={p().hostname} />
            <KvRow k="IP" v={p().ip} />
            <KvRow k="OS" v={p().os} />
            <KvRow k={t('dash_relay')} v={p().relay} />
            <KvRow k={t('peers_rx')} v={fmtBytes(p().rxBytes)} />
            <KvRow k={t('peers_tx')} v={fmtBytes(p().txBytes)} />
            <KvRow k={t('exit_title')} v={p().exitNodeOption ? '✓' : '✗'} />
            <div class="md-dialog-actions">
              <Button variant="text" onClick={() => setDetail(null)}>{t('close')}</Button>
            </div>
          </Dialog>
        )}
      </Show>
    </>
  );
}
