/*
 * Traffic — hourly/daily line chart (canvas), Top-N peers bar list,
 * per-app (UID) totals. All reads are light stats queries.
 */
import { createSignal, onMount, Show, type JSX } from 'solid-js';
import { createApiScope } from '../api';
import { t } from '../i18n';
import { fmtBytes } from '../format';
import { Card, SkeletonCard, SkeletonRows, EmptyState, ErrorState } from '../components/Basics';
import { LineChart, chartColors } from '../components/LineChart';
import { MdIcon } from '../icons';
import { Select, Switch, Tab, Tabs } from '../components/ui';
import type { Peer, AppInfo } from '../types';

interface HourSample {
  hour: number;
  iface?: { rx: number; tx: number };
}

interface DaySample {
  date: string;
  rx: number;
  tx: number;
}

interface TopEntry {
  id: string;
  rx: number;
  tx: number;
}

interface UidEntry {
  uid: string;
  tx: number;
}

let seq = 0;

export default function Traffic(): JSX.Element {
  const scope = createApiScope();
  const [mode, setMode] = createSignal<'hourly' | 'daily'>('hourly');
  const [chart, setChart] = createSignal<{ labels: string[]; rx: number[]; tx: number[] } | null>(null);
  const [chartError, setChartError] = createSignal<string | null>(null);
  const [chartEmpty, setChartEmpty] = createSignal(false);
  const [topn, setTopn] = createSignal<{ entry: TopEntry; name: string }[] | null>(null);
  const [uidRows, setUidRows] = createSignal<{ label: string; uid: string; tx: number }[] | null>(null);

  async function loadChart() {
    const m = mode();
    const my = ++seq;
    setChart(null);
    setChartError(null);
    setChartEmpty(false);
    const res = await scope.api('traffic', m);
    if (res.cancelled || my !== seq) return;
    if (!res.ok) {
      setChartError(res.error || t('error'));
      return;
    }
    const labels: string[] = [];
    const rx: number[] = [];
    const tx: number[] = [];
    if (m === 'hourly') {
      ((res.hours as HourSample[]) || []).forEach((hh) => {
        labels.push(hh.hour + ':00');
        rx.push(hh.iface ? hh.iface.rx : 0);
        tx.push(hh.iface ? hh.iface.tx : 0);
      });
    } else {
      ((res.days as DaySample[]) || []).forEach((d) => {
        labels.push(d.date.slice(5));
        rx.push(d.rx);
        tx.push(d.tx);
      });
    }
    if (!labels.length || (rx.every((v) => !v) && tx.every((v) => !v))) {
      setChartEmpty(true);
      return;
    }
    setChart({ labels, rx, tx });
  }

  async function loadTopn() {
    const res = await scope.api('traffic', 'topn', 10);
    if (res.cancelled) return;
    if (!res.ok || !Array.isArray(res.topn) || !(res.topn as TopEntry[]).length) {
      setTopn([]);
      return;
    }
    // Render counters immediately; name lookup can complete independently.
    setTopn((res.topn as TopEntry[]).map((r) => ({ entry: r, name: r.id })));
    const peersRes = await scope.api('peers');
    if (peersRes.cancelled) return;
    const names: Record<string, string> = {};
    if (peersRes.ok) ((peersRes.peers as Peer[]) || []).forEach((p) => (names[p.id] = p.hostname));
    setTopn((res.topn as TopEntry[]).map((r) => ({ entry: r, name: names[r.id] || r.id })));
  }

  async function loadUids() {
    const res = await scope.api('traffic-uids');
    if (res.cancelled) return;
    if (!res.ok || !Array.isArray(res.uids) || !(res.uids as UidEntry[]).length) {
      setUidRows([]);
      return;
    }
    const rows = (res.uids as UidEntry[]).slice(0, 50);
    setUidRows(rows.map((u) => ({ label: t('traffic_uid') + u.uid, uid: u.uid, tx: u.tx })));
    // Package manager enumeration is expensive on phones with many apps.
    // Skip it entirely when there are no UID counters to label.
    const appsRes = await scope.api('apps');
    if (appsRes.cancelled) return;
    const labels: Record<string, string> = {};
    if (appsRes.ok) ((appsRes.apps as AppInfo[]) || []).forEach((a) => (labels[String(a.uid)] = a.label));
    setUidRows(
      rows.map((u) => ({
        label: labels[String(u.uid)] || t('traffic_uid') + u.uid,
        uid: u.uid,
        tx: u.tx,
      })),
    );
  }

  onMount(() => {
    void loadChart();
    void loadTopn();
    void loadUids();
  });

  const topMax = () => {
    const list = topn() ?? [];
    let max = 1;
    list.forEach((r) => {
      if (r.entry.rx + r.entry.tx > max) max = r.entry.rx + r.entry.tx;
    });
    return max;
  };

  return (
    <>
      <Tabs
        activeTabIndex={mode() === 'hourly' ? 0 : 1}
        onChange={(e: Event) => {
          const idx = (e.target as unknown as { activeTabIndex: number }).activeTabIndex;
          const m = idx === 0 ? 'hourly' : 'daily';
          if (m !== mode()) {
            setMode(m);
            void loadChart();
          }
        }}
      >
        <Tab label={t('traffic_hourly')} />
        <Tab label={t('traffic_daily')} />
      </Tabs>

      <Card title={t('traffic_title')} icon="monitoring">
        <Show when={chart() !== null || chartError() !== null || chartEmpty()} fallback={<SkeletonCard lines={3} />}>
          <Show
            when={!chartError()}
            fallback={<ErrorState text={chartError()!} onRetry={() => void loadChart()} />}
          >
            <Show
              when={!chartEmpty()}
              fallback={<EmptyState text={t('traffic_no_data')} icon="monitoring" />}
            >
              <div class="dim">{t('traffic_touch_hint')}</div>
              <Show when={chart()}>
                {(c) => {
                  const colors = chartColors();
                  return (
                    <LineChart
                      labels={c().labels}
                      series={[
                        { name: t('traffic_rx'), color: colors.rx, values: c().rx },
                        { name: t('traffic_tx'), color: colors.tx, values: c().tx },
                      ]}
                    />
                  );
                }}
              </Show>
            </Show>
          </Show>
        </Show>
      </Card>

      <Card title={t('traffic_topn')} icon="speed">
        <Show when={topn() !== null} fallback={<SkeletonRows rows={3} />}>
          <Show
            when={topn()!.length > 0}
            fallback={<EmptyState text={t('traffic_no_data')} icon="speed" />}
          >
            {topn()!.map((r) => (
              <div class="bar-row">
                <span class="bar-label">{r.name}</span>
                <div class="bar-track">
                  <div
                    class="bar-fill"
                    style={{ width: Math.max(2, ((r.entry.rx + r.entry.tx) / topMax()) * 100) + '%' }}
                  />
                </div>
                <span class="bar-val">{'↓' + fmtBytes(r.entry.rx)}</span>
              </div>
            ))}
          </Show>
        </Show>
      </Card>

      <Card title={t('traffic_by_app')} icon="group">
        <p class="dim">{t('traffic_app_tx_hint')}</p>
        <Show when={uidRows() !== null} fallback={<SkeletonRows rows={3} />}>
          <Show
            when={uidRows()!.length > 0}
            fallback={<EmptyState text={t('traffic_no_data')} icon="group" />}
          >
            {uidRows()!.map((u) => (
              <div class="list-row">
                <MdIcon name="person" size={20} class="dim" />
                <div class="main">
                  <div class="title">{u.label}</div>
                  <div class="sub">{t('traffic_uid') + u.uid}</div>
                </div>
                <span class="dim">{'↑' + fmtBytes(u.tx)}</span>
              </div>
            ))}
          </Show>
        </Show>
      </Card>
    </>
  );
}
