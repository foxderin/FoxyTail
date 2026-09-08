/* Solid JSX typings for the @material/web custom elements used in this app.
 * Deliberately loose (attributes pass through); events are attached via
 * Solid's on:<event> or refs. */
import 'solid-js';

declare module 'solid-js' {
  namespace JSX {
    interface IntrinsicElements {
      'md-filled-button': Record<string, unknown>;
      'md-filled-tonal-button': Record<string, unknown>;
      'md-outlined-button': Record<string, unknown>;
      'md-text-button': Record<string, unknown>;
      'md-outlined-text-field': Record<string, unknown>;
      'md-switch': Record<string, unknown>;
      'md-dialog': Record<string, unknown>;
      'md-linear-progress': Record<string, unknown>;
      'md-circular-progress': Record<string, unknown>;
      'md-list': Record<string, unknown>;
      'md-list-item': Record<string, unknown>;
      'md-icon-button': Record<string, unknown>;
      'md-checkbox': Record<string, unknown>;
      'md-outlined-select': Record<string, unknown>;
      'md-select-option': Record<string, unknown>;
      'md-tabs': Record<string, unknown>;
      'md-primary-tab': Record<string, unknown>;
      'md-divider': Record<string, unknown>;
    }
  }
}

export {};
