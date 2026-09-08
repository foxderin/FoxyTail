/* Small shared building blocks: Card, KvRow, StatusDot, skeletons, states. */
import { Show, type JSX, type ParentProps } from 'solid-js';
import { t } from '../i18n';
import { MdIcon, type IconName } from '../icons';
import { Button } from './ui';

export function Card(props: ParentProps<{ title?: string; icon?: IconName }>): JSX.Element {
  return (
    <div class="card">
      <Show when={props.title}>
        <h2>
          <Show when={props.icon}>
            <MdIcon name={props.icon!} size={18} class="dim" />{' '}
          </Show>
          {props.title}
        </h2>
      </Show>
      {props.children}
    </div>
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
    <div class="skel-card" aria-busy="true">
      <div class="skeleton skel-title" />
      {Array.from({ length: lines() }, () => 0).map(() => (
        <div class="skeleton skel-line" />
      ))}
    </div>
  );
}

export function SkeletonRows(props: { rows?: number }): JSX.Element {
  return (
    <div>
      {Array.from({ length: props.rows ?? 4 }, () => 0).map(() => (
        <div class="skeleton skel-line" style={{ height: '36px' }} />
      ))}
    </div>
  );
}

export function EmptyState(props: { text: string; icon?: IconName }): JSX.Element {
  return (
    <div class="state-box">
      <MdIcon name={props.icon ?? 'info'} size={20} class="dim" />
      <span class="grow">{props.text}</span>
    </div>
  );
}

/* Retryable error state — a failed/ timed-out call never leaves the page
 * stuck on "loading". */
export function ErrorState(props: { text: string; onRetry?: () => void }): JSX.Element {
  return (
    <div class="state-box">
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
