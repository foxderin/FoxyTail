/* Intrinsic JSX typings for our hand-built UI kit only. */
import 'solid-js';

declare module 'solid-js' {
  namespace JSX {
    interface IntrinsicElements {
      'ft-button': Record<string, unknown>;
    }
  }
}

export {};
