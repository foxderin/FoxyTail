/* Small shared building blocks: Card, KvRow, StatusDot, skeletons, states. */
import { Show, type JSX, type ParentProps } from 'solid-js';
import { t } from '../i18n';
import { MdIcon, type IconName } from '../icons';
import { Button } from './ui';

export type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export function PageHeader(props: ParentProps<{
  title: string; description?: string; eyebrow?: string; actions?: JSX.Element; id?: string;
}>): JSX.Element {
  return <div class="page-heading">
    <div class="page-heading-copy">
      <Show when={props.eyebrow}><div class="eyebrow">{props.eyebrow}</div></Show>
      <h1 id={props.id}>{props.title}</h1>
      <Show when={props.description}><p class="page-description">{props.description}</p></Show>
      {props.children}
    </div>
    <Show when={props.actions}><div class="page-heading-actions">{props.actions}</div></Show>
  </div>;
}

export function SectionHeading(props: {
  title: string; description?: string; actions?: JSX.Element; icon?: IconName;
}): JSX.Element {
  return <div class="section-heading">
    <div class="section-heading-copy">
      <h2><Show when={props.icon}><MdIcon name={props.icon!} size={18} /></Show>{props.title}</h2>
      <Show when={props.description}><p>{props.description}</p></Show>
    </div>
    <Show when={props.actions}><div class="section-heading-actions">{props.actions}</div></Show>
  </div>;
}

export function MetricCard(props: ParentProps<{
  label: string; value: JSX.Element; caption?: JSX.Element; icon?: IconName; tone?: StatusTone;
}>): JSX.Element {
  return <div class={'metric-card tone-' + (props.tone ?? 'neutral')}>
    <div class="metric-label"><span>{props.label}</span><Show when={props.icon}><MdIcon name={props.icon!} size={18} /></Show></div>
    <div class="metric-value">{props.value}</div>
    <Show when={props.caption}><div class="metric-caption">{props.caption}</div></Show>
    {props.children}
  </div>;
}

export function StatusBadge(props: ParentProps<{
  tone?: StatusTone; label?: string; state?: 'on' | 'warn' | 'off';
}>): JSX.Element {
  return <span class={'status-badge tone-' + (props.tone ?? (props.state === 'on' ? 'success' : props.state === 'warn' ? 'warning' : 'neutral'))}>
    <Show when={props.state}><StatusDot state={props.state!} /></Show>
    {props.label ?? props.children}
  </span>;
}

export function Card(props: ParentProps<{ title?: string; icon?: IconName; class?: string; description?: string; actions?: JSX.Element }>): JSX.Element {
  return (
    <section class={'card' + (props.class ? ' ' + props.class : '')}>
      <Show when={props.title}>
        <SectionHeading title={props.title!} icon={props.icon} description={props.description} actions={props.actions} />
      </Show>
      {props.children}
    </section>
  );
}

export function KvRow(props: { k: JSX.Element; v: JSX.Element }): JSX.Element {
  return (
    <div class="kv">
      <span class="k">{props.k}</span>
      <span class="v">{props.v}</span>
    </div>
  );
}

/* Green / amber / grey status dot. */
export function StatusDot(props: { state: 'on' | 'warn' | 'off' }): JSX.Element {
  return <span class={'dot ' + props.state} aria-hidden="true" />;
}

/* Skeleton placeholder while a card's data loads — never a bare spinner. */
export function SkeletonCard(props: { lines?: number }): JSX.Element {
  const lines = () => props.lines ?? 3;
  return (
    <div class="skel-card" aria-busy="true" role="status" aria-label={t('loading')}>
      <span class="sr-only">{t('loading')}</span>
      <div class="skeleton skel-title" />
      {Array.from({ length: lines() }, () => 0).map(() => (
        <div class="skeleton skel-line" />
      ))}
    </div>
  );
}

export function SkeletonRows(props: { rows?: number }): JSX.Element {
  return (
    <div aria-busy="true" role="status" aria-label={t('loading')}>
      <span class="sr-only">{t('loading')}</span>
      {Array.from({ length: props.rows ?? 4 }, () => 0).map(() => (
        <div class="skeleton skel-line" style={{ height: '36px' }} />
      ))}
    </div>
  );
}

export function EmptyState(props: { text: string; icon?: IconName }): JSX.Element {
  return (
    <div class="state-box empty-state">
      <MdIcon name={props.icon ?? 'info'} size={20} class="dim" />
      <span class="grow">{props.text}</span>
    </div>
  );
}

/* Retryable error state — a failed/ timed-out call never leaves the page
 * stuck on "loading". */
export function ErrorState(props: { text: string; onRetry?: () => void }): JSX.Element {
  return (
    <div class="state-box error-state" role="alert">
      <MdIcon name="error" size={20} class="lat-bad" />
      <span class="grow">{props.text}</span>
      <Show when={props.onRetry}>
        <Button variant="text" onClick={() => props.onRetry!()}>
          <MdIcon name="refresh" size={18} /> {t('retry')}
        </Button>
      </Show>
    </div>
  );
}
