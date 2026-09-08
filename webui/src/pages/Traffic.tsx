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
  uid: number;
  rx: number;
}

export default function Traffic(): JSX.Element {
  const scope = createApiScope();
  const [mode, setMode] = createSignal<'hourly' | 'daily'>('hourly');
  const [chart, setChart] = createSignal<{ labels: string[]; rx: number[]; tx: number[] } | null>(null);
  const [chartError, setChartError] = createSignal<string | null>(null);
  const [chartEmpty, setChartEmpty] = createSignal(false);
  const [topn, setTopn] = createSignal<{ entry: TopEntry; name: string }[] | null>(null);
  const [uidRows, setUidRows] = createSignal<{ label: string; uid: number; rx: number }[] | null>(null);

  async function loadChart() {
    setChart(null);
    setChartError(null);
    setChartEmpty(false);
    const res = await scope.api('traffic', mode());
    if (res.cancelled) return;
    if (!res.ok) {
      setChartError(res.error || t('error'));
      return;
    }
    const labels: string[] = [];
    const rx: number[] = [];
    const tx: number[] = [];
    if (mode() === 'hourly') {
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
    const [res, peersRes] = await Promise.all([scope.api('traffic', 'topn', 10), scope.api('peers')]);
    if (res.cancelled || peersRes.cancelled) return;
    const names: Record<string, string> = {};
    if (peersRes.ok) ((peersRes.peers as Peer[]) || []).forEach((p) => (names[p.id] = p.hostname));
    if (!res.ok || !Array.isArray(res.topn) || !(res.topn as TopEntry[]).length) {
      setTopn([]);
      return;
    }
    setTopn((res.topn as TopEntry[]).map((r) => ({ entry: r, name: names[r.id] || r.id })));
  }

  async function loadUids() {
    const [res, appsRes] = await Promise.all([scope.api('traffic-uids'), scope.api('apps')]);
    if (res.cancelled || appsRes.cancelled) return;
    const labels: Record<string, string> = {};
    if (appsRes.ok) ((appsRes.apps as AppInfo[]) || []).forEach((a) => (labels[String(a.uid)] = a.label));
    if (!res.ok || !Array.isArray(res.uids) || !(res.uids as UidEntry[]).length) {
      setUidRows([]);
      return;
    }
    setUidRows(
      (res.uids as UidEntry[]).slice(0, 50).map((u) => ({
        label: labels[String(u.uid)] || t('traffic_uid') + u.uid,
        uid: u.uid,
        rx: u.rx,
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
      <md-tabs
        active-tab-index={mode() === 'hourly' ? 0 : 1}
        on:change={(e: Event) => {
          const idx = (e.target as unknown as { activeTabIndex: number }).activeTabIndex;
          const m = idx === 0 ? 'hourly' : 'daily';
          if (m !== mode()) {
            setMode(m);
            void loadChart();
          }
        }}
      >
        <md-primary-tab>{t('traffic_hourly')}</md-primary-tab>
        <md-primary-tab>{t('traffic_daily')}</md-primary-tab>
      </md-tabs>

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
                <span class="dim">{fmtBytes(u.rx)}</span>
              </div>
            ))}
          </Show>
        </Show>
      </Card>
    </>
  );
}
