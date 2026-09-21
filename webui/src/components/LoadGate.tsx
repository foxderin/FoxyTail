/* Card body gate: skeleton until a result exists, the retryable error branch,
 * an empty state when the result has no content, and the children otherwise. */
import { Show, type JSX, type ParentProps } from 'solid-js';
import { ErrorState } from './Basics';

export function LoadGate(props: ParentProps<{
  /** A result has been published (the page's data signal is non-null). */
  ready: boolean;
  /** Read failure. Keeps the empty branch hidden and renders ErrorState. */
  error?: string | null;
  /** Retry action for the error branch; omit for an error without a retry. */
  onRetry?: () => void;
  skeleton: JSX.Element;
  /** Content is present; false renders the empty branch. Defaults to true. */
  hasContent?: boolean;
  empty?: JSX.Element;
}>): JSX.Element {
  const failed = () => Boolean(props.error);
  return (
    <Show when={props.ready || failed()} fallback={props.skeleton}>
      <Show when={failed()}>
        <ErrorState text={props.error!} onRetry={props.onRetry} />
      </Show>
      <Show
        when={props.hasContent ?? true}
        fallback={<Show when={!failed()}>{props.empty}</Show>}
      >
        {props.children}
      </Show>
    </Show>
  );
}
