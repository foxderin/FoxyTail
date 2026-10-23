/** Responsive SVG traffic chart with gap-aware samples and a readable data table. */
import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';
import { fmtBytes } from '../format';
import { t } from '../i18n';

interface ChartSeries {
  name: string;
  color: string;
  values: (number | null)[];
}
export function chartColors(): { rx: string; tx: string } {
  return {
    rx: 'var(--md-sys-color-primary)',
    tx: 'var(--md-sys-color-tertiary)',
  };
}

export function LineChart(props: {
  labels: string[];
  series: ChartSeries[];
}): JSX.Element {
  let root!: HTMLDivElement;
  const titleId = createUniqueId();
  const [width, setWidth] = createSignal(640);
  const [selected, setSelected] = createSignal<number | null>(null);
  const height = 232,
    left = 57,
    right = 12,
    top = 12,
    bottom = 28;
  const plotWidth = () => Math.max(1, width() - left - right);
  const plotHeight = height - top - bottom;
  const validNumber = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const max = createMemo(() => {
    const value = Math.max(
      1,
      ...props.series.flatMap((series) => series.values.filter(validNumber)),
    );
    const step = 10 ** Math.floor(Math.log10(value));
    return Math.ceil(value / step) * step;
  });
  const xAt = (index: number) =>
    left +
    (props.labels.length < 2
      ? plotWidth() / 2
      : (index / (props.labels.length - 1)) * plotWidth());
  const yAt = (value: number) => top + plotHeight * (1 - value / max());
  const currentIndex = () =>
    Math.max(
      0,
      Math.min(
        props.labels.length - 1,
        selected() ??
          props.labels.findLastIndex((_, index) =>
            props.series.some((series) => validNumber(series.values[index])),
          ),
      ),
    );
  const segments = (series: ChartSeries) => {
    const output: {
      line: string;
      area: string;
      points: { x: number; y: number }[];
    }[] = [];
    let points: { x: number; y: number }[] = [];
    const finish = () => {
      if (!points.length) return;
      const line = points
        .map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`)
        .join(' ');
      output.push({
        line,
        area: `${line} L${points[points.length - 1].x},${yAt(0)} L${points[0].x},${yAt(0)} Z`,
        points,
      });
      points = [];
    };
    series.values.forEach((value, index) => {
      if (validNumber(value)) points.push({ x: xAt(index), y: yAt(value) });
      else finish();
    });
    finish();
    return output;
  };
  const indices = createMemo(() => {
    const n = props.labels.length;
    const count = Math.max(2, Math.floor(plotWidth() / 68));
    return [
      ...new Set(
        Array.from({ length: Math.min(n, count) }, (_, index) =>
          Math.round((index * (n - 1)) / (Math.min(n, count) - 1 || 1)),
        ),
      ),
    ];
  });
  const describe = () =>
    `${props.labels[currentIndex()] || ''}: ${props.series.map((series) => `${series.name} ${validNumber(series.values[currentIndex()]) ? fmtBytes(series.values[currentIndex()]) : t('net_traffic_unrecorded')}`).join(', ')}`;
  const choosePoint = (event: PointerEvent) => {
    const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    if (!rect.width) return;
    const x = ((event.clientX - rect.left) * width()) / rect.width;
    setSelected(
      Math.max(
        0,
        Math.min(
          props.labels.length - 1,
          Math.round(((x - left) / plotWidth()) * (props.labels.length - 1)),
        ),
      ),
    );
  };

  onMount(() => {
    const resize = () =>
      setWidth(Math.max(240, Math.round(root.clientWidth || 640)));
    resize();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(root);
    window.addEventListener('resize', resize);
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    });
  });

  return (
    <div ref={root} class="network-line-chart">
      <div class="network-chart-legend">
        <For each={props.series}>
          {(series) => (
            <span>
              <i style={{ background: series.color }} />
              {series.name}
            </span>
          )}
        </For>
        <span class="network-chart-hint">{t('traffic_touch_hint')}</span>
      </div>
      <div
        class="network-chart-focus"
        tabIndex={0}
        role="group"
        aria-label={describe()}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
            return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? props.labels.length - 1
                : currentIndex() + (event.key === 'ArrowLeft' ? -1 : 1);
          setSelected(Math.max(0, Math.min(props.labels.length - 1, next)));
        }}
      >
        <svg
          class="network-traffic-svg"
          viewBox={`0 0 ${width()} ${height}`}
          role="img"
          aria-labelledby={titleId}
          onPointerDown={choosePoint}
          onPointerMove={(event) => {
            if (event.pointerType === 'mouse' || event.buttons)
              choosePoint(event);
          }}
        >
          <title id={titleId}>
            {t('net_traffic_chart')} —{' '}
            {props.series.map((series) => series.name).join(', ')}
          </title>
          <For each={[0, 1, 2, 3, 4]}>
            {(tick) => (
              <g class="network-chart-axis">
                <line
                  x1={left}
                  x2={width() - right}
                  y1={yAt((max() * tick) / 4)}
                  y2={yAt((max() * tick) / 4)}
                  stroke="var(--md-sys-color-outline-variant)"
                  stroke-dasharray={tick ? '3 5' : undefined}
                />
                <text
                  x={left - 9}
                  y={yAt((max() * tick) / 4) + 3}
                  text-anchor="end"
                >
                  {fmtBytes(Math.round((max() * tick) / 4))}
                </text>
              </g>
            )}
          </For>
          <For each={indices()}>
            {(index) => (
              <text
                class="network-chart-axis"
                x={xAt(index)}
                y={height - 7}
                text-anchor={
                  index === 0
                    ? 'start'
                    : index === props.labels.length - 1
                      ? 'end'
                      : 'middle'
                }
              >
                {props.labels[index]}
              </text>
            )}
          </For>
          <For each={props.series}>
            {(series) => (
              <For each={segments(series)}>
                {(segment) => (
                  <g>
                    <path d={segment.area} fill={series.color} opacity="0.07" />
                    <path
                      d={segment.line}
                      fill="none"
                      stroke={series.color}
                      stroke-width="2.5"
                      stroke-linejoin="round"
                      stroke-linecap="round"
                    />
                    <For
                      each={segment.points.length === 1 ? segment.points : []}
                    >
                      {(point) => (
                        <circle
                          cx={point.x}
                          cy={point.y}
                          r="3"
                          fill={series.color}
                        />
                      )}
                    </For>
                  </g>
                )}
              </For>
            )}
          </For>
          <line
            x1={xAt(currentIndex())}
            x2={xAt(currentIndex())}
            y1={top}
            y2={height - bottom}
            stroke="var(--md-sys-color-outline)"
            stroke-dasharray="3 4"
          />
          <For each={props.series}>
            {(series) =>
              validNumber(series.values[currentIndex()]) ? (
                <circle
                  cx={xAt(currentIndex())}
                  cy={yAt(series.values[currentIndex()] as number)}
                  r="4"
                  fill={series.color}
                  stroke="var(--md-sys-color-surface)"
                  stroke-width="2"
                />
              ) : null
            }
          </For>
        </svg>
      </div>
      <div class="network-chart-readout">
        <strong>{props.labels[currentIndex()]}</strong>
        <For each={props.series}>
          {(series) => (
            <span>
              <i style={{ background: series.color }} />
              {series.name}
              <b>
                {validNumber(series.values[currentIndex()])
                  ? fmtBytes(series.values[currentIndex()])
                  : '—'}
              </b>
            </span>
          )}
        </For>
      </div>
      <details class="network-chart-data">
        <summary>{t('net_traffic_table')}</summary>
        <div class="network-table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{t('net_traffic_time')}</th>
                <For each={props.series}>
                  {(series) => <th scope="col">{series.name}</th>}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={props.labels}>
                {(label, index) => (
                  <tr>
                    <th scope="row">{label}</th>
                    <For each={props.series}>
                      {(series) => (
                        <td>
                          {validNumber(series.values[index()])
                            ? fmtBytes(series.values[index()])
                            : t('net_traffic_unrecorded')}
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
