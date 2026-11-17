import { createSignal } from 'solid-js';
import { apiCall, nativeControl, type ApiCall, type ApiResult, type NativeTask } from './api';
import { onNativeEvent, requestNative } from './native';

export type TaskStatus = 'running' | 'unknown' | 'done' | 'cancelled' | 'error';
export interface Task {
  key: string; cmd: string; args: readonly (string | number)[];
  status: TaskStatus; result: ApiResult | null; startedAt: number; call: ApiCall;
}
// Only page associations and result validation live here; native owns operation state.
const [observers, setObservers] = createSignal<ReadonlyMap<string, Task>>(new Map());
const recoveredCalls = new Map<string, ApiCall>();
const nativeIds = new Map<string, string>();
function taskKey(command: string): string {
  if (command === 'control' || command === 'mode-set') return 'service-control';
  if (command === 'settings-set') return 'settings-save';
  if (command === 'subnet-routes-set') return 'subnet-routes';
  return command;
}
function state(entry: NativeTask): TaskStatus {
  if (entry.id === nativeControl().id && nativeControl().unknown) return 'unknown';
  if (entry.id === nativeControl().id && nativeControl().ownsMutation) return 'running';
  if (['running', 'pending', 'queued', 'cancelling'].includes(entry.status)) return 'running';
  if (entry.status === 'unknown' || entry.result?.unknown) return 'unknown';
  if (entry.result?.cancelled || entry.status === 'cancelled') return 'cancelled';
  return entry.result?.ok || entry.status === 'done' || entry.status === 'completed' ? 'done' : 'error';
}
function recoveredCall(entry: NativeTask): ApiCall {
  const existing = recoveredCalls.get(entry.id);
  if (existing) return existing;
  const terminal = () => nativeControl().tasks.find(task => task.id === entry.id) ?? (entry.id.startsWith('saved:') ? entry : undefined);
  const promise = new Promise<ApiResult>(resolve => {
    const settle = () => {
      const current = terminal();
      if (current && !['running', 'unknown'].includes(state(current))) { resolve(current.result ?? { ok: state(current) === 'done' }); return true; }
      if (current?.status === 'unknown' && nativeControl().id !== entry.id) { resolve({ ok: false, unknown: true, error: current.detail }); return true; }
      return false;
    };
    if (settle()) return;
    const off = onNativeEvent('control', () => { if (settle()) off(); });
  });
  const call: ApiCall = {
    requestId: entry.id, promise,
    get cancellable() { return nativeControl().id === entry.id && nativeControl().canCancel; },
    get cancelled() { return terminal()?.result?.cancelled === true; },
    get cancellation() { return terminal()?.cancellation === 'requested' ? 'requested' : terminal()?.cancellation === 'failed' ? 'failed' : 'idle'; },
    get cancellationError() { return terminal()?.cancellation === 'failed' ? terminal()?.detail ?? null : null; },
    cancel: () => nativeControl().id === entry.id ? requestNative('control.cancel', { id: entry.id }) : Promise.resolve({ ok: true, completed: true }),
  };
  recoveredCalls.set(entry.id, call);
  return call;
}
export function listTasks(): Task[] {
  const local = [...observers().values()];
  const entries = [...nativeControl().tasks];
  const snapshot = nativeControl();
  const saved = snapshot.results as Record<string, ApiResult> | undefined;
  for (const [command, result] of Object.entries(saved ?? {})) {
    if (!entries.some(entry => entry.command === command)) entries.push({
      id: 'saved:' + command, command, label: command, status: result.ok ? 'done' : 'error', result,
    });
  }
  if (snapshot.id && !entries.some(entry => entry.id === snapshot.id)) entries.unshift({
    id: snapshot.id, command: snapshot.command, label: snapshot.label,
    status: snapshot.unknown ? 'unknown' : 'running', result: null,
  });
  const tasks = entries.map(entry => {
    const association = local.find(task => nativeIds.get(task.key) === entry.id) ?? local.find(task =>
      !nativeIds.has(task.key) && task.cmd === entry.command && task.startedAt <= (entry.startedAt ?? 0));
    if (association) nativeIds.set(association.key, entry.id);
    const recoveredKey = entry.command === 'peer-ping' && typeof entry.result?.peerId === 'string' && typeof entry.result.ip === 'string'
      ? 'peer-ping:' + entry.result.peerId + ':' + entry.result.ip : taskKey(entry.command);
    const nativeStatus = state(entry);
    const validated = association?.result && !['running', 'unknown'].includes(association.status) &&
      !['running', 'unknown'].includes(nativeStatus) ? association : undefined;
    return {
      key: association?.key ?? recoveredKey, cmd: entry.command,
      args: association?.args ?? [], status: validated?.status ?? nativeStatus,
      result: validated?.result ?? entry.result ?? null,
      startedAt: entry.startedAt ?? association?.startedAt ?? 0,
      call: association?.call ?? recoveredCall(entry),
    } satisfies Task;
  });
  for (const task of local) if (!nativeIds.has(task.key)) tasks.push(task);
  return tasks.sort((a, b) => b.startedAt - a.startedAt);
}
export function getTask(key: string): Task | undefined { return listTasks().find(task => task.key === key); }
export function startTask(key: string, command: string, ...args: (string | number)[]): ApiCall {
  return launch(key, command, args);
}
export function startValidatedTask(key: string, command: string, validate: (result: ApiResult) => ApiResult, ...args: (string | number)[]): ApiCall {
  return launch(key, command, args, validate);
}
function launch(key: string, command: string, args: (string | number)[], validate?: (result: ApiResult) => ApiResult): ApiCall {
  const current = getTask(key);
  if (current && (current.status === 'running' || (current.status === 'unknown' && nativeControl().unknown && current.cmd === nativeControl().command))) return current.call;
  nativeIds.delete(key);
  const request = apiCall(command, ...args);
  const call: ApiCall = {
    ...request,
    get cancelled() { return request.cancelled; }, get cancellable() { return request.cancellable; },
    get cancellation() { return request.cancellation; }, get cancellationError() { return request.cancellationError; },
    promise: request.promise.then(result => {
      if (!validate || !result.ok) return result;
      try { return validate(result); }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Invalid task result' }; }
    }),
  };
  setObservers(previous => new Map(previous).set(key, { key, cmd: command, args: command === 'login-authkey' ? [] : args, status: 'running', result: null, startedAt: Date.now(), call }));
  void call.promise.then(result => setObservers(previous => {
    const task = previous.get(key);
    if (task?.call !== call) return previous;
    return new Map(previous).set(key, { ...task, result, status: result.unknown ? 'unknown' : result.cancelled ? 'cancelled' : result.ok ? 'done' : 'error' });
  }));
  return call;
}
export function cancelTask(key: string): Promise<ApiResult> { return getTask(key)?.call.cancel() ?? Promise.resolve({ ok: true }); }
