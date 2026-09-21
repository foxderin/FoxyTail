/** Recorded traffic, with independent errors for the chart, peers, and apps. */
import {
  createMemo,
  createSignal,
  For,
  onMount,
  type JSX,
} from 'solid-js';
import { createApiScope } from '../api';
import { t } from '../i18n';
import { fmtBytes } from '../format';
import {
  Card,
  SkeletonRows,
  EmptyState,
} from '../components/Basics';
import { LineChart, chartColors } from '../components/LineChart';
import { LoadGate } from '../components/LoadGate';
import { RefreshButton } from '../components/RefreshButton';
import { MdIcon } from '../icons';
import type { Peer, AppInfo } from '../types';
import './network.css';

interface HourSample {
  hour: number;
  samples?: number;
  iface?: { rx: number; tx: number };
}
interface DaySample {
  date: string;
  samples?: number;
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
interface ChartData {
  labels: string[];
  rx: (number | null)[];
  tx: (number | null)[];
}
const bytes = (value: number | null | undefined) =>
  Number.isFinite(value) && Number(value) >= 0 ? Number(value) : 0;

export default function Traffic(): JSX.Element {
  const scope = createApiScope();
  let chartSeq = 0,
    topSeq = 0,
    uidSeq = 0;
  const [mode, setMode] = createSignal<'hourly' | 'daily'>('hourly');
  const [chart, setChart] = createSignal<ChartData | null>(null);
  const [chartError, setChartError] = createSignal<string | null>(null);
  const [chartLoading, setChartLoading] = createSignal(true);
  const [topn, setTopn] = createSignal<
    { entry: TopEntry; name: string }[] | null
  >(null);
  const [topError, setTopError] = createSignal<string | null>(null);
  const [topLoading, setTopLoading] = createSignal(false);
  const [uidRows, setUidRows] = createSignal<
    { label: string; uid: string; tx: number }[] | null
  >(null);
  const [uidError, setUidError] = createSignal<string | null>(null);
  const [uidLoading, setUidLoading] = createSignal(false);
  const hasSamples = () =>
    chart()?.rx.some((value) => value !== null) ||
    chart()?.tx.some((value) => value !== null);
  const totals = createMemo(() => ({
    rx: chart()?.rx.reduce<number>((sum, value) => sum + bytes(value), 0) || 0,
    tx: chart()?.tx.reduce<number>((sum, value) => sum + bytes(value), 0) || 0,
  }));
  const refreshing = () => chartLoading() || topLoading() || uidLoading();

  async function loadChart() {
    const selectedMode = mode();
    const my = ++chartSeq;
    setChartLoading(true);
    setChartError(null);
    const res = await scope.api('traffic', selectedMode);
    if (res.cancelled || my !== chartSeq) return;
    setChartLoading(false);
    if (!res.ok) {
      setChartError(res.error || t('error'));
      return;
    }
    const data: ChartData = { labels: [], rx: [], tx: [] };
    if (selectedMode === 'hourly') {
      ((res.hours as HourSample[]) || []).forEach((sample) => {
        const recorded =
          sample.samples === undefined
            ? !!sample.iface &&
              bytes(sample.iface.rx) + bytes(sample.iface.tx) > 0
            : sample.samples > 0;
        data.labels.push(String(sample.hour).padStart(2, '0') + ':00');
        data.rx.push(recorded && sample.iface ? bytes(sample.iface.rx) : null);
        data.tx.push(recorded && sample.iface ? bytes(sample.iface.tx) : null);
      });
    } else {
      ((res.days as DaySample[]) || []).forEach((sample) => {
        const recorded =
          sample.samples === undefined
            ? bytes(sample.rx) + bytes(sample.tx) > 0
            : sample.samples > 0;
        data.labels.push(sample.date.slice(5));
        data.rx.push(recorded ? bytes(sample.rx) : null);
        data.tx.push(recorded ? bytes(sample.tx) : null);
      });
    }
    setChart(data);
  }

  async function loadTopn() {
    if (topLoading()) return;
    const my = ++topSeq;
    setTopLoading(true);
    const res = await scope.api('traffic', 'topn', 10);
    if (res.cancelled || my !== topSeq) return;
    if (!res.ok) {
      setTopLoading(false);
      setTopError(res.error || t('error'));
      return;
    }
    setTopError(null);
    const rows = Array.isArray(res.topn)
      ? (res.topn as TopEntry[])
          .filter((row) => bytes(row.rx) + bytes(row.tx) > 0)
          .sort((a, b) => bytes(b.rx) + bytes(b.tx) - bytes(a.rx) - bytes(a.tx))
      : [];
    setTopn(rows.map((entry) => ({ entry, name: entry.id })));
    // Avoid an extra root call when there are no counters to label.
    if (!rows.length) {
      setTopLoading(false);
      return;
    }
    const peersRes = await scope.api('peers');
    if (peersRes.cancelled || my !== topSeq) return;
    setTopLoading(false);
    const names: Record<string, string> = {};
    if (peersRes.ok)
      ((peersRes.peers as Peer[]) || []).forEach((peer) => {
        names[peer.id] = peer.hostname;
      });
    setTopn(
      rows.map((entry) => ({ entry, name: names[entry.id] || entry.id })),
    );
  }

  async function loadUids() {
    if (uidLoading()) return;
    const my = ++uidSeq;
    setUidLoading(true);
    const res = await scope.api('traffic-uids');
    if (res.cancelled || my !== uidSeq) return;
    if (!res.ok) {
      setUidLoading(false);
      setUidError(res.error || t('error'));
      return;
    }
    setUidError(null);
    const rows = Array.isArray(res.uids)
      ? (res.uids as UidEntry[]).filter((row) => bytes(row.tx) > 0).slice(0, 50)
      : [];
    setUidRows(
      rows.map((row) => ({
        label: t('traffic_uid') + row.uid,
        uid: row.uid,
        tx: row.tx,
      })),
    );
    // Package enumeration can be expensive, so only request names for real data.
    if (!rows.length) {
      setUidLoading(false);
      return;
    }
    const appsRes = await scope.api('apps');
    if (appsRes.cancelled || my !== uidSeq) return;
    setUidLoading(false);
    const labels: Record<string, string> = {};
    if (appsRes.ok)
      ((appsRes.apps as AppInfo[]) || []).forEach((app) => {
        labels[String(app.uid)] = app.label;
      });
    setUidRows(
      rows.map((row) => ({
        label: labels[String(row.uid)] || t('traffic_uid') + row.uid,
        uid: row.uid,
        tx: row.tx,
      })),
    );
  }

  const refresh = () => {
    void loadChart();
    void loadTopn();
    void loadUids();
  };
  onMount(refresh);
  const topMax = () =>
    Math.max(
      1,
      ...(topn() || []).map((row) => bytes(row.entry.rx) + bytes(row.entry.tx)),
    );
  const colors = chartColors();

  return (
    <div class="page-stack network-page">
      <div class="network-period-toolbar">
        <div
          class="filter-chips"
          role="group"
          aria-label={t('net_traffic_period')}
        >
          <For each={['hourly', 'daily'] as const}>
            {(period) => (
              <button
                type="button"
                class="filter-chip"
                classList={{ active: mode() === period }}
                aria-pressed={mode() === period}
                onClick={() => {
                  if (period === mode()) return;
                  setMode(period);
                  setChart(null);
                  void loadChart();
                }}
              >
                {t(period === 'hourly' ? 'traffic_hourly' : 'traffic_daily')}
              </button>
            )}
          </For>
        </div>
        <RefreshButton loading={refreshing()} onClick={refresh} />
      </div>

      <div class="metric-grid network-metrics network-traffic-metrics">
        <div class="metric-card">
          <div class="metric-label">
            <MdIcon name="monitoring" size={18} />
            {t('net_traffic_total')}
          </div>
          <div
            class="metric-value"
            classList={{ 'network-metric-loading': chartLoading() && !chart() }}
          >
            {hasSamples() ? fmtBytes(totals().rx + totals().tx) : '—'}
          </div>
        </div>
        <div class="metric-card">
          <div class="metric-label">
            <span class="network-direction-icon">↓</span>
            {t('traffic_rx')}
          </div>
          <div
            class="metric-value"
            classList={{ 'network-metric-loading': chartLoading() && !chart() }}
          >
            {hasSamples() ? fmtBytes(totals().rx) : '—'}
          </div>
        </div>
        <div class="metric-card">
          <div class="metric-label">
            <span class="network-direction-icon is-upload">↑</span>
            {t('traffic_tx')}
          </div>
          <div
            class="metric-value"
            classList={{ 'network-metric-loading': chartLoading() && !chart() }}
          >
            {hasSamples() ? fmtBytes(totals().tx) : '—'}
          </div>
        </div>
      </div>

      <Card title={t('net_traffic_chart')} icon="monitoring">
        <p class="network-supporting">{t('net_traffic_chart_hint')}</p>
        <LoadGate
          ready={chart() !== null}
          error={chartError()}
          onRetry={() => void loadChart()}
          skeleton={
            <div class="network-chart-skeleton" aria-busy="true">
              <div class="skeleton" />
              <div class="skeleton" />
              <div class="skeleton" />
              <div class="skeleton" />
              <div class="network-chart-skeleton-axis">
                <span class="skeleton" />
                <span class="skeleton" />
                <span class="skeleton" />
              </div>
            </div>
          }
          hasContent={hasSamples()}
          empty={
            <div class="empty-state network-traffic-empty">
              <div class="network-empty-graphic">
                <MdIcon name="monitoring" size={34} />
              </div>
              <strong>{t('net_traffic_no_samples')}</strong>
            </div>
          }
        >
          <LineChart
            labels={chart()!.labels}
            series={[
              {
                name: t('traffic_rx'),
                color: colors.rx,
                values: chart()!.rx,
              },
              {
                name: t('traffic_tx'),
                color: colors.tx,
                values: chart()!.tx,
              },
            ]}
          />
        </LoadGate>
      </Card>

      <div class="content-grid network-detail-grid network-traffic-breakdown">
        <Card title={t('traffic_topn')} icon="group">
          <p class="network-supporting">{t('net_traffic_top_hint')}</p>
          <LoadGate
            ready={topn() !== null}
            error={topError()}
            onRetry={() => void loadTopn()}
            skeleton={<SkeletonRows rows={4} />}
            hasContent={(topn() || []).length > 0}
            empty={<EmptyState text={t('net_traffic_no_peer')} icon="group" />}
          >
            <div class="network-rank-list">
                <For each={topn() || []}>
                  {(row, index) => (
                    <div class="network-rank-row">
                      <span class="network-rank-number">
                        {String(index() + 1).padStart(2, '0')}
                      </span>
                      <div class="network-rank-content">
                        <div class="network-rank-heading">
                          <strong>{row.name}</strong>
                          <span>
                            {fmtBytes(
                              bytes(row.entry.rx) + bytes(row.entry.tx),
                            )}
                          </span>
                        </div>
                        <div class="network-stacked-track">
                          <span
                            class="network-rx-fill"
                            style={{
                              width: `${(bytes(row.entry.rx) / topMax()) * 100}%`,
                            }}
                          />
                          <span
                            class="network-tx-fill"
                            style={{
                              width: `${(bytes(row.entry.tx) / topMax()) * 100}%`,
                            }}
                          />
                        </div>
                        <div class="network-rank-details">
                          <span>↓ {fmtBytes(row.entry.rx)}</span>
                          <span>↑ {fmtBytes(row.entry.tx)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
          </LoadGate>
        </Card>
        <Card title={t('traffic_by_app')} icon="router">
          <p class="network-supporting">{t('traffic_app_tx_hint')}</p>
          <LoadGate
            ready={uidRows() !== null}
            error={uidError()}
            onRetry={() => void loadUids()}
            skeleton={<SkeletonRows rows={4} />}
            hasContent={(uidRows() || []).length > 0}
            empty={<EmptyState text={t('net_traffic_no_app')} icon="router" />}
          >
            <div class="network-app-list">
                <For each={uidRows() || []}>
                  {(row) => (
                    <div class="network-app-row">
                      <div class="network-app-avatar">
                        <MdIcon name="router" size={18} />
                      </div>
                      <div>
                        <strong>{row.label}</strong>
                        <span>{t('traffic_uid') + row.uid}</span>
                      </div>
                      <b>↑ {fmtBytes(row.tx)}</b>
                    </div>
                  )}
                </For>
              </div>
          </LoadGate>
        </Card>
      </div>
    </div>
  );
}
