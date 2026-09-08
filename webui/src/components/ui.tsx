/* Lightweight, JS-native replacements for the @material/web custom elements.
 * No shadow DOM, no Lit, no runtime webcomponent upgrades — just plain
 * <button>/<input>/<select>/<dialog> styled with the existing MD3 tokens.
 */
import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX, type ParentProps } from 'solid-js';
import { MdIcon, type IconName } from '../icons';

export function Button(props: ParentProps<{
  variant?: 'filled' | 'tonal' | 'outlined' | 'text';
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  class?: string;
  style?: JSX.CSSProperties;
  onClick?: (e: MouseEvent) => void;
}>): JSX.Element {
  const cls = () =>
    'btn btn-' + (props.variant ?? 'filled') + (props.class ? ' ' + props.class : '');
  return (
    <button
      type={props.type ?? 'button'}
      class={cls()}
      style={props.style}
      disabled={props.disabled || false}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function IconButton(props: {
  children: JSX.Element;
  'aria-label'?: string;
  disabled?: boolean;
  class?: string;
  onClick?: (e: MouseEvent) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      class={'icon-btn' + (props.class ? ' ' + props.class : '')}
      aria-label={props['aria-label']}
      disabled={props.disabled || false}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function TextField(props: {
  label?: string;
  placeholder?: string;
  value?: string | number;
  type?: string;
  disabled?: boolean;
  rows?: number;
  class?: string;
  style?: JSX.CSSProperties;
  onInput?: (e: InputEvent) => void;
  onChange?: (e: Event) => void;
  'leading-icon'?: JSX.Element;
  ref?: (el: HTMLInputElement | HTMLTextAreaElement) => void;
}): JSX.Element {
  const isArea = () => props.rows !== undefined && props.rows > 0;
  const [hasValue, setHasValue] = createSignal(String(props.value ?? '').length > 0);
  createEffect(() => setHasValue(String(props.value ?? '').length > 0));
  return (
    <label class={'text-field' + (props.class ? ' ' + props.class : '')} style={props.style}>
      <span class={'text-field-label' + (hasValue() ? ' floating' : '')}>{props.label}</span>
      {props['leading-icon'] ? <span class="text-field-leading">{props['leading-icon']}</span> : null}
      {isArea() ? (
        <textarea
          ref={props.ref as (el: HTMLTextAreaElement) => void}
          class="text-field-input"
          rows={props.rows}
          placeholder={props.placeholder}
          value={props.value ?? ''}
          disabled={props.disabled || false}
          onInput={(e) => {
            setHasValue(String(e.currentTarget.value).length > 0);
            props.onInput?.(e);
          }}
          onChange={props.onChange}
        />
      ) : (
        <input
          ref={props.ref as (el: HTMLInputElement) => void}
          class="text-field-input"
          type={props.type ?? 'text'}
          placeholder={props.placeholder}
          value={props.value ?? ''}
          disabled={props.disabled || false}
          onInput={(e) => {
            setHasValue(String(e.currentTarget.value).length > 0);
            props.onInput?.(e);
          }}
          onChange={props.onChange}
        />
      )}
    </label>
  );
}

export function Select(props: ParentProps<{
  label?: string;
  value?: string | number;
  disabled?: boolean;
  style?: JSX.CSSProperties;
  class?: string;
  onChange?: (e: Event) => void;
}>): JSX.Element {
  return (
    <label class={'text-field select-field' + (props.class ? ' ' + props.class : '')} style={props.style}>
      <span class={'text-field-label' + (String(props.value ?? '').length > 0 ? ' floating' : '')}>
        {props.label}
      </span>
      <MdIcon name="more_horiz" size={20} class="select-caret" />
      <select
        class="text-field-input"
        value={props.value ?? ''}
        disabled={props.disabled || false}
        onChange={props.onChange}
      >
        {props.children}
      </select>
    </label>
  );
}

export function Switch(props: {
  selected?: boolean;
  checked?: boolean;
  disabled?: boolean;
  class?: string;
  onChange?: (e: Event) => void;
}): JSX.Element {
  const onInput = (e: Event) => {
    const cb = e.currentTarget as HTMLInputElement;
    (cb as unknown as Record<string, boolean>).selected = cb.checked;
    props.onChange?.(e);
  };
  return (
    <label class={'switch' + (props.class ? ' ' + props.class : '')}>
      <input
        type="checkbox"
        class="switch-input"
        checked={(props.selected ?? props.checked) || false}
        disabled={props.disabled || false}
        onChange={onInput}
      />
      <span class="switch-track">
        <span class="switch-thumb" />
      </span>
    </label>
  );
}

export function Checkbox(props: {
  checked?: boolean;
  disabled?: boolean;
  class?: string;
  onChange?: (e: Event) => void;
}): JSX.Element {
  return (
    <label class={'checkbox' + (props.class ? ' ' + props.class : '')}>
      <input
        type="checkbox"
        class="checkbox-input"
        checked={props.checked || false}
        disabled={props.disabled || false}
        onChange={props.onChange}
      />
      <span class="checkbox-box">
        <MdIcon name="check" size={16} />
      </span>
    </label>
  );
}

export function Tabs(props: ParentProps<{
  activeTabIndex?: number;
  class?: string;
  onChange?: (e: Event) => void;
}>): JSX.Element {
  const [idx, setIdx] = createSignal(props.activeTabIndex ?? 0);
  createEffect(() => setIdx(props.activeTabIndex ?? 0));
  const slots = () => {
    const out: { icon?: IconName; label: string }[] = [];
    (props.children as unknown as JSX.Element[] | undefined)?.forEach?.((child: unknown) => {
      const el = child as { props?: { children?: unknown; icon?: IconName; label?: string } } | null;
      if (!el || typeof el !== 'object') return;
      const raw = el.props?.children;
      let label = '';
      let icon: IconName | undefined;
      if (Array.isArray(raw)) {
        label = raw.filter((x) => typeof x === 'string').join('').trim();
        const iconEl = raw.find(
          (x: unknown) =>
            x && typeof x === 'object' && 'props' in x && (x as { props?: { name?: string } }).props?.name,
        );
        if (iconEl) icon = (iconEl as { props: { name: IconName } }).props.name;
      } else if (typeof raw === 'string') {
        label = raw.trim();
      }
      if (el.props?.label) label = el.props.label;
      if (el.props?.icon) icon = el.props.icon;
      out.push({ label, icon });
    });
    return out;
  };
  return (
    <div class={'tabs' + (props.class ? ' ' + props.class : '')} role="tablist">
      <For each={slots()}>
        {(slot, i) => (
          <button
            type="button"
            class={'tab' + (i() === idx() ? ' active' : '')}
            role="tab"
            aria-selected={i() === idx()}
            onClick={(e) => {
              setIdx(i());
              const el = e.currentTarget as unknown as { activeTabIndex: number };
              el.activeTabIndex = i();
              props.onChange?.({ target: el } as unknown as Event);
            }}
          >
            {slot.icon ? <MdIcon name={slot.icon} size={18} /> : null}
            <span>{slot.label}</span>
          </button>
        )}
      </For>
    </div>
  );
}

export function Tab(props: { children?: JSX.Element; icon?: IconName; label?: string }): JSX.Element {
  return props as unknown as JSX.Element;
}

export function LinearProgress(props: { indeterminate?: boolean; value?: number; class?: string }): JSX.Element {
  return (
    <div class={'linear-progress' + (props.class ? ' ' + props.class : '')}>
      <div
        class={'linear-progress-bar' + (props.indeterminate ? ' indeterminate' : '')}
        style={props.indeterminate ? undefined : { width: Math.max(0, Math.min(100, (props.value ?? 0) * 100)) + '%' }}
      />
    </div>
  );
}

export function CircularProgress(props: { size?: number; class?: string }): JSX.Element {
  const size = () => props.size ?? 24;
  return (
    <svg
      class={'circular-progress' + (props.class ? ' ' + props.class : '')}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" />
    </svg>
  );
}

export function List(props: ParentProps<{ class?: string }>): JSX.Element {
  return <div class={'md-list' + (props.class ? ' ' + props.class : '')}>{props.children}</div>;
}

export function ListItem(props: ParentProps<{ class?: string }>): JSX.Element {
  return <div class={'md-list-item' + (props.class ? ' ' + props.class : '')}>{props.children}</div>;
}

export function Divider(): JSX.Element {
  return <hr class="md-divider" />;
}

export function Dialog(props: {
  open?: boolean;
  headline?: JSX.Element;
  children?: JSX.Element;
  actions?: JSX.Element;
  onClose?: () => void;
}): JSX.Element {
  let dialog!: HTMLDialogElement;
  onMount(() => {
    if (props.open) dialog.showModal();
  });
  createEffect(() => {
    if (props.open) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  });
  const close = () => props.onClose?.();
  const onClickScrim = (e: MouseEvent) => {
    if (e.target === dialog) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  onCleanup(() => {
    if (dialog?.open) dialog.close();
  });
  return (
    <dialog
      ref={dialog}
      class="md-dialog"
      onClick={onClickScrim}
      onKeyDown={onKey}
    >
      <Show when={props.headline}>
        <div class="md-dialog-headline">{props.headline}</div>
      </Show>
      <div class="md-dialog-content">{props.children}</div>
      <Show when={props.actions}>
        <div class="md-dialog-actions">{props.actions}</div>
      </Show>
    </dialog>
  );
}
