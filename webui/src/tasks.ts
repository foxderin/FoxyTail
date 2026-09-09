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
import { apiCallAfter, type ApiCall, type ApiResult } from './api';

export type TaskStatus = 'running' | 'done' | 'cancelled' | 'error';

export interface Task {
  key: string;
  status: TaskStatus;
  result: ApiResult | null;
  startedAt: number;
  call: ApiCall;
}

const [taskMap, setTaskMap] = createSignal<ReadonlyMap<string, Task>>(new Map());

/* Patch only while the key still belongs to `call`: a replaced run's stale
 * promise callback must not overwrite the new run's state. */
function patch(key: string, call: ApiCall, p: Partial<Task>): void {
  setTaskMap((prev) => {
    const cur = prev.get(key);
    if (!cur || cur.call !== call) return prev;
    const next = new Map(prev);
    next.set(key, { ...cur, ...p });
    return next;
  });
}

export function getTask(key: string): Task | undefined {
  return taskMap().get(key);
}

/** Reactive snapshot for the global activity menu; task ownership stays in this registry. */
export function listTasks(): Task[] {
  return [...taskMap().values()].sort((a, b) => b.startedAt - a.startedAt);
}

/* Start (or replace) a heavy task. Replacing cancels the previous run,
 * including its backend process via the ApiCall cancel path. */
export function startTask(key: string, cmd: string, ...args: (string | number)[]): ApiCall {
  return launchTask(key, cmd, args);
}

/** Validate command-specific success data before publishing a completed task. */
export function startValidatedTask(
  key: string,
  cmd: string,
  validate: (result: ApiResult) => ApiResult,
  ...args: (string | number)[]
): ApiCall {
  return launchTask(key, cmd, args, validate);
}

function launchTask(
  key: string,
  cmd: string,
  args: (string | number)[],
  validate?: (result: ApiResult) => ApiResult,
): ApiCall {
  const prev = taskMap().get(key);
  const settled = prev ? prev.call.cancel() : Promise.resolve({ ok: true });
  const request = apiCallAfter(settled, cmd, ...args);
  const call: ApiCall = validate ? {
    requestId: request.requestId,
    get cancelled() { return request.cancelled; },
    cancel: () => request.cancel(),
    promise: request.promise.then((result) => {
      if (!result.ok || result.cancelled) return result;
      try {
        return validate(result);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Invalid task result' };
      }
    }),
  } : request;
  setTaskMap((prevMap) => {
    const next = new Map(prevMap);
    next.set(key, { key, status: 'running', result: null, startedAt: Date.now(), call });
    return next;
  });

  call.promise.then((res) => {
    if (res.cancelled) patch(key, call, { status: 'cancelled', result: res });
    else if (res.ok) patch(key, call, { status: 'done', result: res });
    else patch(key, call, { status: 'error', result: res });
  });
  return call;
}

export function cancelTask(key: string): Promise<ApiResult> {
  const t = taskMap().get(key);
  return t && t.status === 'running' ? t.call.cancel() : Promise.resolve({ ok: true });
}
