export interface NativeResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

interface NativeBridge {
  postMessage(message: string): void;
  onmessage: ((event: { data: string }) => void) | null;
}

declare global {
  interface Window {
    FoxyTailNative?: NativeBridge;
  }
}

const pending = new Map<string, (result: NativeResult) => void>();
const listeners = new Map<string, Set<(data: NativeResult) => void>>();
let sequence = 0;
let bound: NativeBridge | undefined;

function bridge(): NativeBridge | undefined {
  const current = window.FoxyTailNative;
  if (!current || typeof current.postMessage !== 'function') return undefined;
  if (bound !== current) {
    bound = current;
    current.onmessage = ({ data }) => {
      let message: unknown;
      try { message = JSON.parse(data); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const value = message as Record<string, unknown>;
      if (typeof value.id === 'string') {
        const complete = pending.get(value.id);
        if (!complete) return;
        pending.delete(value.id);
        const result = value.result;
        complete(result && typeof result === 'object' && !Array.isArray(result)
          && typeof (result as NativeResult).ok === 'boolean'
          ? result as NativeResult : { ok: false, error: 'Invalid native response.' });
      } else if (typeof value.event === 'string' && value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
        for (const listener of listeners.get(value.event) ?? []) listener(value.data as NativeResult);
      }
    };
  }
  return current;
}

export function hasNativeBridge(): boolean {
  return bridge() !== undefined;
}

export function startNative(action: string, args: Record<string, unknown> = {}): { id: string; promise: Promise<NativeResult> } {
  const id = `web-${++sequence}`;
  const promise = new Promise<NativeResult>((resolve) => {
    const channel = bridge();
    if (!channel) { resolve({ ok: false, error: 'Android connection unavailable.' }); return; }
    pending.set(id, resolve);
    try { channel.postMessage(JSON.stringify({ id, action, args })); }
    catch (error) {
      pending.delete(id);
      resolve({ ok: false, error: error instanceof Error ? error.message : 'Android connection failed.' });
    }
  });
  return { id, promise };
}

export function requestNative(action: string, args: Record<string, unknown> = {}): Promise<NativeResult> {
  return startNative(action, args).promise;
}

export function onNativeEvent(event: string, handler: (data: NativeResult) => void): () => void {
  let handlers = listeners.get(event);
  if (!handlers) { handlers = new Set(); listeners.set(event, handlers); }
  handlers.add(handler);
  bridge();
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) listeners.delete(event);
  };
}
