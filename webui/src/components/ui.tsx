/* Lightweight, JS-native replacements for the @material/web custom elements.
 * No shadow DOM, no Lit, no runtime webcomponent upgrades — just plain
 * <button>/<input>/<select>/<dialog> styled with the existing MD3 tokens.
 */
import { createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show, type JSX, type ParentProps } from 'solid-js';
import { MdIcon, type IconName } from '../icons';

export function Button(props: ParentProps<{
  variant?: 'filled' | 'tonal' | 'outlined' | 'text';
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  busy?: boolean;
  loading?: boolean;
  'aria-label'?: string;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
  title?: string;
  autofocus?: boolean;
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
      disabled={props.disabled || props.busy || props.loading || false}
      aria-busy={props.busy || props.loading || undefined}
      aria-label={props['aria-label']}
      aria-expanded={props['aria-expanded']}
      aria-controls={props['aria-controls']}
      title={props.title}
      autofocus={props.autofocus || undefined}
      onClick={props.onClick}
    >
      <Show when={props.busy || props.loading}><CircularProgress size={16} /></Show>{props.children}
    </button>
  );
}

export function IconButton(props: {
  children: JSX.Element;
  'aria-label'?: string;
  'aria-expanded'?: boolean;
  'aria-pressed'?: boolean;
  title?: string;
  disabled?: boolean;
  class?: string;
  onClick?: (e: MouseEvent) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      class={'icon-btn' + (props.class ? ' ' + props.class : '')}
      aria-label={props['aria-label']}
      aria-expanded={props['aria-expanded']}
      aria-pressed={props['aria-pressed']}
      title={props.title ?? props['aria-label']}
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
  id?: string;
  name?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  required?: boolean;
  readonly?: boolean;
  autocomplete?: string;
  inputmode?: JSX.InputHTMLAttributes<HTMLInputElement>['inputmode'];
  min?: number | string;
  max?: number | string;
  step?: number | string;
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
    <label class={'text-field' + (props.disabled ? ' is-disabled' : '') + (!props.label ? ' no-label' : '') + (props.class ? ' ' + props.class : '')} style={props.style}>
      <Show when={props.label}><span class={'text-field-label' + (hasValue() ? ' floating' : '')}>{props.label}</span></Show>
      {props['leading-icon'] ? <span class="text-field-leading">{props['leading-icon']}</span> : null}
      {isArea() ? (
        <textarea
          ref={props.ref as (el: HTMLTextAreaElement) => void}
          class="text-field-input"
          rows={props.rows}
          id={props.id}
          name={props.name}
          aria-label={props['aria-label']}
          aria-describedby={props['aria-describedby']}
          aria-invalid={props['aria-invalid']}
          required={props.required}
          readOnly={props.readonly}
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
          id={props.id}
          name={props.name}
          aria-label={props['aria-label']}
          aria-describedby={props['aria-describedby']}
          aria-invalid={props['aria-invalid']}
          required={props.required}
          readOnly={props.readonly}
          autocomplete={props.autocomplete}
          inputmode={props.inputmode}
          min={props.min}
          max={props.max}
          step={props.step}
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
  id?: string;
  name?: string;
  'aria-label'?: string;
  style?: JSX.CSSProperties;
  class?: string;
  onChange?: (e: Event) => void;
}>): JSX.Element {
  return (
    <label class={'text-field select-field' + (props.disabled ? ' is-disabled' : '') + (!props.label ? ' no-label' : '') + (props.class ? ' ' + props.class : '')} style={props.style}>
      <span class={'text-field-label' + (String(props.value ?? '').length > 0 ? ' floating' : '')}>
        {props.label}
      </span>
      <MdIcon name="chevron_right" size={18} class="select-caret" />
      <select
        class="text-field-input"
        id={props.id}
        name={props.name}
        aria-label={props['aria-label']}
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
  indeterminate?: boolean;
  disabled?: boolean;
  class?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
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
        ref={(input) => createEffect(() => { input.indeterminate = props.indeterminate || false; })}
        type="checkbox"
        role="switch"
        aria-label={props['aria-label']}
        aria-describedby={props['aria-describedby']}
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
  id?: string;
  name?: string;
  checked?: boolean;
  disabled?: boolean;
  class?: string;
  'aria-label'?: string;
  onChange?: (e: Event) => void;
}): JSX.Element {
  return (
    <label class={'checkbox' + (props.class ? ' ' + props.class : '')}>
      <input
        type="checkbox"
        id={props.id}
        name={props.name}
        aria-label={props['aria-label']}
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
  'aria-label'?: string;
  onChange?: (e: Event) => void;
}>): JSX.Element {
  const [idx, setIdx] = createSignal(props.activeTabIndex ?? 0);
  createEffect(() => setIdx(props.activeTabIndex ?? 0));
  const slots = () => {
    const out: { icon?: IconName; label: string }[] = [];
    (props.children as unknown as JSX.Element[] | undefined)?.forEach?.((child: unknown) => {
      if (!child || typeof child !== 'object') return;
      const el = child as {
        props?: { children?: unknown; icon?: IconName; label?: string; name?: IconName };
        children?: unknown;
        icon?: IconName;
        label?: string;
      };
      const p = 'props' in el && el.props ? el.props : el;
      const raw = p.children;
      let label = '';
      let icon: IconName | undefined;
      if (Array.isArray(raw)) {
        label = raw.filter((x) => typeof x === 'string').join('').trim();
        const iconEl = raw.find(
          (x: unknown) =>
            x && typeof x === 'object' &&
            ((x as { name?: IconName }).name || (x as { props?: { name?: IconName } }).props?.name),
        );
        if (iconEl) {
          icon =
            (iconEl as { name?: IconName }).name ||
            (iconEl as { props?: { name?: IconName } }).props?.name;
        }
      } else if (typeof raw === 'string') {
        label = raw.trim();
      }
      if (p.label) label = p.label;
      if (p.icon) icon = p.icon;
      out.push({ label, icon });
    });
    return out;
  };
  return (
    <div class={'tabs' + (props.class ? ' ' + props.class : '')} role="tablist" aria-label={props['aria-label']}>
      <For each={slots()}>
        {(slot, i) => (
          <button
            type="button"
            class={'tab' + (i() === idx() ? ' active' : '')}
            role="tab"
            aria-selected={i() === idx()}
            tabIndex={i() === idx() ? 0 : -1}
            onKeyDown={(event) => {
              const buttons = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
              let next = i();
              if (event.key === 'ArrowRight') next = (i() + 1) % buttons.length;
              else if (event.key === 'ArrowLeft') next = (i() + buttons.length - 1) % buttons.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = buttons.length - 1;
              else return;
              event.preventDefault();
              buttons[next]?.focus();
              buttons[next]?.click();
            }}
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

export function LinearProgress(props: { indeterminate?: boolean; value?: number; class?: string; 'aria-label'?: string }): JSX.Element {
  const percent = () => Number.isFinite(props.value) ? Math.max(0, Math.min(100, props.value! * 100)) : 0;
  return (
    <div class={'linear-progress' + (props.class ? ' ' + props.class : '')} role="progressbar" aria-label={props['aria-label']} aria-valuemin={0} aria-valuemax={100} aria-valuenow={props.indeterminate ? undefined : Math.round(percent())}>
      <div
        class={'linear-progress-bar' + (props.indeterminate ? ' indeterminate' : '')}
        style={props.indeterminate ? undefined : { width: percent() + '%' }}
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
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" />
    </svg>
  );
}

export function Dialog(props: {
  open?: boolean;
  headline?: JSX.Element;
  children?: JSX.Element;
  actions?: JSX.Element;
  onClose?: () => void;
  'aria-label'?: string;
}): JSX.Element {
  let dialog!: HTMLDialogElement;
  const headlineId = createUniqueId();
  let previousFocus: HTMLElement | null = null;
  const restoreFocus = () => {
    const target = previousFocus;
    previousFocus = null;
    queueMicrotask(() => { if (target?.isConnected) target.focus({ preventScroll: true }); });
  };
  const open = () => {
    if (dialog.open) return;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
  };
  onMount(() => { if (props.open) open(); });
  createEffect(() => {
    if (props.open) {
      open();
    } else if (dialog.open) {
      dialog.close();
      restoreFocus();
    }
  });
  const close = () => props.onClose?.();
  const onClickScrim = (e: MouseEvent) => {
    if (e.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  onCleanup(() => {
    if (dialog?.open) dialog.close();
    restoreFocus();
  });
  return (
    <dialog
      ref={dialog}
      class="md-dialog"
      aria-labelledby={props.headline ? headlineId : undefined}
      aria-label={props['aria-label']}
      onClick={onClickScrim}
      onKeyDown={onKey}
      onCancel={(event) => { event.preventDefault(); close(); }}
    >
      <Show when={props.headline}>
        <div class="md-dialog-headline" id={headlineId}>{props.headline}</div>
      </Show>
      <div class="md-dialog-content">{props.children}</div>
      <Show when={props.actions}>
        <div class="md-dialog-actions">{props.actions}</div>
      </Show>
    </dialog>
  );
}
