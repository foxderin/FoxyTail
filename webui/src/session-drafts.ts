import { createEffect, untrack } from 'solid-js';

// WebView-session memory only. Navigation may remount a form; recreating the
// Activity creates a new document and clears these edits. Never persist secrets.
const drafts = new Map<string, Record<string, unknown>>();
export function bindSessionDraft(
  key: 'routes' | 'context' | 'serve' | 'logs' | 'coexist' | 'trial',
  snapshot: () => Record<string, unknown>,
  restore: (value: Record<string, unknown>) => void,
): void {
  const saved = drafts.get(key);
  if (saved) untrack(() => restore(saved));
  createEffect(() => { drafts.set(key, snapshot()); });
}
