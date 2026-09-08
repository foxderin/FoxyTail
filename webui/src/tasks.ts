/*
 * Session-level task registry for user-initiated heavy operations
 * (speedtest-exitnodes, derp-speedtest, diag, file-receive, file-send).
 *
 * Tasks belong to the SESSION, not the page: navigating away never cancels
 * them; re-entering the originating page adopts the running progress state
 * or the cached result straight from this registry. A task is interrupted
 * only when the user presses its Cancel button, or when a new task with the
 * same key replaces it (pressing "start test" again cancels the old run).
 *
 * UI polling timers and lightweight read-only loads are NOT tasks — they
 * stay page-scoped (createApiScope) and are dropped on unmount.
 */
import { createSignal } from 'solid-js';
import { apiCall, type ApiCall, type ApiResult } from './api';

export type TaskStatus = 'running' | 'done' | 'cancelled' | 'error';

export interface Task {
  key: string;
  status: TaskStatus;
  result: ApiResult | null;
  startedAt: number;
  call: ApiCall;
}

const [taskMap, setTaskMap] = createSignal<ReadonlyMap<string, Task>>(new Map());

export { taskMap };

function patch(key: string, p: Partial<Task>): void {
  setTaskMap((prev) => {
    const cur = prev.get(key);
    if (!cur) return prev;
    const next = new Map(prev);
    next.set(key, { ...cur, ...p });
    return next;
  });
}

export function getTask(key: string): Task | undefined {
  return taskMap().get(key);
}

/* Start (or replace) a heavy task. Replacing cancels the previous run,
 * including its backend process via the ApiCall cancel path. */
export function startTask(key: string, cmd: string, ...args: (string | number)[]): ApiCall {
  const prev = taskMap().get(key);
  if (prev && prev.status === 'running') prev.call.cancel();

  const call = apiCall(cmd, ...args);
  setTaskMap((prevMap) => {
    const next = new Map(prevMap);
    next.set(key, { key, status: 'running', result: null, startedAt: Date.now(), call });
    return next;
  });

  call.promise.then((res) => {
    if (res.cancelled) patch(key, { status: 'cancelled', result: res });
    else if (res.ok) patch(key, { status: 'done', result: res });
    else patch(key, { status: 'error', result: res });
  });
  return call;
}

export function cancelTask(key: string): void {
  const t = taskMap().get(key);
  if (t && t.status === 'running') t.call.cancel();
}

export function clearTask(key: string): void {
  setTaskMap((prev) => {
    if (!prev.has(key)) return prev;
    const next = new Map(prev);
    next.delete(key);
    return next;
  });
}
