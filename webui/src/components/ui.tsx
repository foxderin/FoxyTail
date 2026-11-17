/* Lightweight, JS-native replacements for the @material/web custom elements.
 * No shadow DOM, no Lit, no runtime webcomponent upgrades — just plain
 * <button>/<input>/<select>/<dialog> styled with the existing MD3 tokens.
 */
import { createEffect, createSignal, createUniqueId, onCleanup, onMount, Show, useContext, type JSX, type ParentProps } from 'solid-js';
import { MdIcon } from '../icons';
import { RouteVisible } from '../schedule';

export function Button(props: ParentProps<{
  variant?: 'filled' | 'tonal' | 'outlined' | 'text';
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  busy?: boolean;
  'aria-label'?: string;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
  'aria-describedby'?: string;
  'data-dialog-action'?: string;
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
      disabled={props.disabled || props.busy || false}
      aria-busy={props.busy || undefined}
      aria-label={props['aria-label']}
      aria-expanded={props['aria-expanded']}
      aria-controls={props['aria-controls']}
      aria-describedby={props['aria-describedby']}
      data-dialog-action={props['data-dialog-action']}
      title={props.title}
      autofocus={props.autofocus || undefined}
      onClick={props.onClick}
    >
      <Show when={props.busy}><CircularProgress size={16} /></Show>{props.children}
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
  return (
    <label class={'text-field input-field' + (props.disabled ? ' is-disabled' : '') + (!props.label ? ' no-label' : '') + (props.class ? ' ' + props.class : '')} style={props.style}>
      <Show when={props.label}><span class="text-field-label">{props.label}</span></Show>
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
          onInput={event => props.onInput?.(event)}
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
          onInput={event => props.onInput?.(event)}
          onChange={props.onChange}
        />
      )}
    </label>
  );
}

/* The native <select> stays as the data and event carrier (hidden, so option
 * <For>/<Show> children still resolve normally); the visible control is a
 * menu-pop whose items are rebuilt from select.options on each open and which
 * dispatches a real change event so every caller keeps working unchanged. */
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
  const valueId = createUniqueId();
  let selectEl!: HTMLSelectElement;
  let menuEl!: HTMLDivElement;
  let popup!: HTMLDetailsElement;
  const closeMenu = (restoreFocus = false) => {
    popup.open = false;
    if (restoreFocus) popup.querySelector('summary')?.focus();
  };
  createEffect(() => {
    if (props.disabled && popup?.open) closeMenu(popup.contains(document.activeElement));
  });
  const [rev, bump] = createSignal(0);
  onMount(() => {
    const mo = new MutationObserver(() => {
      bump(v => v + 1);
      // An open menu is a snapshot of the options; dismiss it when they change.
      if (popup.open) closeMenu(popup.contains(document.activeElement));
    });
    mo.observe(selectEl, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'value', 'label'] });
    const dismiss = (event: PointerEvent) => {
      if (popup.open && event.target instanceof Node && !popup.contains(event.target)) closeMenu();
    };
    document.addEventListener('pointerdown', dismiss);
    onCleanup(() => { mo.disconnect(); document.removeEventListener('pointerdown', dismiss); });
    bump(v => v + 1); // options render before onMount, so re-read once for the initial label
  });
  const options = () => (rev(), Array.from(selectEl?.options ?? []));
  const currentText = () => {
    const value = String(props.value ?? '');
    return options().find(o => o.value === value)?.text ?? value;
  };
  const focusOption = (item: HTMLButtonElement | undefined) => {
    if (!item) return;
    for (const option of menuEl.querySelectorAll<HTMLButtonElement>('button')) option.tabIndex = option === item ? 0 : -1;
    item.focus({ preventScroll: true });
    item.scrollIntoView({ block: 'nearest' });
  };
  const enabledOptions = () => Array.from(menuEl.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const optionDisabled = (option: HTMLOptionElement) => option.disabled ||
    (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled);
  let openingEdge: 'first' | 'last' | undefined;
  const syncMenu = () => {
    menuEl.replaceChildren(...options().map(opt => {
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(opt.value === String(props.value ?? '')));
      item.disabled = optionDisabled(opt);
      item.tabIndex = -1;
      item.textContent = opt.text;
      item.onclick = () => {
        if (!popup.open || props.disabled || selectEl.disabled || optionDisabled(opt) || !selectEl.contains(opt)) return;
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        closeMenu(true);
      };
      return item;
    }));
    const enabled = enabledOptions();
    focusOption(openingEdge === 'first' ? enabled[0] : openingEdge === 'last' ? enabled.at(-1) :
      enabled.find(item => item.getAttribute('aria-selected') === 'true') ?? enabled[0]);
    openingEdge = undefined;
  };
  return (
    <div class={'text-field select-field' + (props.disabled ? ' is-disabled' : '') + (!props.label ? ' no-label' : '') + (props.class ? ' ' + props.class : '')} style={props.style}>
      <details ref={popup} class="menu-pop select-pop"
        onToggle={() => { if (popup.open) { if (props.disabled) closeMenu(); else syncMenu(); } }}
        onKeyDown={event => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !props.disabled) {
            event.preventDefault(); event.stopPropagation();
            if (!popup.open) {
              openingEdge = event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined;
              popup.open = true; return;
            }
            const enabled = enabledOptions();
            const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 :
              event.key === 'ArrowDown' ? Math.min(current + 1, enabled.length - 1) : Math.max(current - 1, 0);
            focusOption(enabled[next]);
          } else if (event.key === 'Escape' && popup.open) {
            event.preventDefault(); event.stopPropagation(); closeMenu(true);
          }
        }}
        onFocusOut={() => queueMicrotask(() => {
          if (popup.open && !popup.contains(document.activeElement)) closeMenu();
        })}>
        <summary
          tabIndex={props.disabled ? -1 : 0}
          aria-label={props['aria-label'] || props.label}
          aria-describedby={props.label || props['aria-label'] ? valueId : undefined}
          aria-haspopup="listbox"
          aria-disabled={props.disabled || undefined}
          onClick={(e) => { if (props.disabled) e.preventDefault(); }}
        >
          <Show when={props.label}><span class="text-field-label">{props.label}</span></Show>
          <span id={valueId} class="select-value">{currentText()}</span>
          <MdIcon name="unfold_more" size={18} class="select-caret" />
        </summary>
        <div ref={menuEl} role="listbox" aria-label={props['aria-label'] || props.label} />
      </details>
      <select
        ref={selectEl}
        hidden
        id={props.id}
        name={props.name}
        value={props.value ?? ''}
        disabled={props.disabled || false}
        onChange={props.onChange}
      >
        {props.children}
      </select>
    </div>
  );
}

export function Switch(props: {
  checked?: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  class?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  onChange?: (e: Event) => void;
}): JSX.Element {
  return (
    <label class={'switch' + (props.class ? ' ' + props.class : '')}>
      <input
        ref={(input) => createEffect(() => { input.indeterminate = props.indeterminate || false; })}
        type="checkbox"
        role="switch"
        aria-label={props['aria-label']}
        aria-describedby={props['aria-describedby']}
        class="switch-input"
        checked={props.checked || false}
        disabled={props.disabled || false}
        onChange={props.onChange}
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
  const routeVisible = useContext(RouteVisible);
  let previousFocus: HTMLElement | null = null;
  const restoreFocus = () => {
    const target = previousFocus;
    previousFocus = null;
    queueMicrotask(() => { if (target?.isConnected && !target.closest('[hidden]')) target.focus({ preventScroll: true }); });
  };
  const open = () => {
    if (dialog.open) return;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
  };
  onMount(() => { if (props.open && routeVisible()) open(); });
  createEffect(() => {
    if (!routeVisible()) {
      // Retained pages keep their data, not a modal in the browser top layer.
      previousFocus = null;
      if (dialog.open) dialog.close();
      if (props.open) props.onClose?.();
      return;
    }
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
