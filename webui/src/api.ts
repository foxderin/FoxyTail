import { createSignal, getOwner, onCleanup } from 'solid-js';
import { markSavedConfigChanged } from './config';
import { hasNativeBridge, onNativeEvent, requestNative, startNative, type NativeResult } from './native';

export type ApiResult = NativeResult;
export interface NativeTask {
  id: string; command: string; label: string; status: string;
  startedAt?: number; result?: ApiResult | null;
  cancellation?: string; detail?: string;
}
export interface ControlSnapshot extends ApiResult {
  compatible: boolean; canWrite: boolean; canStop: boolean; busy: boolean;
  ownsMutation: boolean; unknown: boolean; canCancel: boolean;
  id: string | null; command: string; label: string; message: string;
  revision: number; accountRevision: number; result: ApiResult | null;
  sequence: number;
  tasks: NativeTask[]; checking?: boolean; upgrading?: boolean;
}
const [nativeControl, setNativeControl] = createSignal<ControlSnapshot>({
  ok: false, compatible: false, canWrite: false, canStop: false, busy: false,
  ownsMutation: false, unknown: false, canCancel: false, id: null,
  command: '', label: '', message: '', revision: 0, accountRevision: 0,
  result: null, tasks: [], checking: hasNativeBridge(), sequence: -1,
});
export { nativeControl };
export const hasRoot = hasNativeBridge();
export function publishNativeControl(value: NativeResult): void {
  if (typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence <= nativeControl().sequence ||
      typeof value.revision !== 'number' || !Array.isArray(value.tasks)) return;
  setNativeControl(value as ControlSnapshot);
}
export function reportNativeConnectionError(error: string): void {
  if (nativeControl().sequence >= 0) return;
  setNativeControl(previous => ({ ...previous, ok: false, checking: false, error, message: error }));
}
onNativeEvent('control', publishNativeControl);
export async function refreshNativeControl(): Promise<ApiResult> {
  const result = await requestNative('control.refresh');
  if (result.control && typeof result.control === 'object') publishNativeControl(result.control as NativeResult);
  else publishNativeControl(result);
  return result;
}

// Native validates the same command boundary; unknown commands are never raw shell.
const READ_COMMANDS = [
  'backend-info', 'owner-capability', 'hooks-get', 'status', 'exit-routing',
  'peers', 'exitnodes', 'tun', 'dns', 'accounts', 'serve-list', 'funnel-list',
  'traffic', 'traffic-uids', 'apps', 'routes-get', 'subnet-routes-get',
  'settings-get', 'context-get', 'context-status', 'logs', 'compat', 'files-inbox',
  'taildrop-targets', 'file-send-status', 'file-send-history', 'backup-list',
  'restore-preview', 'trial-status',
];
export function isReadCommand(command: string): boolean { return READ_COMMANDS.includes(command); }
export type CancellationState = 'idle' | 'requested' | 'confirmed' | 'failed';
export interface ApiCall {
  readonly promise: Promise<ApiResult>; readonly requestId: string;
  readonly cancelled: boolean; readonly cancellable: boolean;
  readonly cancellation: CancellationState; readonly cancellationError: string | null;
  cancel(): Promise<ApiResult>;
}
export function apiCall(command: string, ...args: (string | number)[]): ApiCall {
  const read = isReadCommand(command);
  let operationId: string | null = null;
  const previousId = nativeControl().id;
  const unbind = read || command === 'login' ? () => undefined : onNativeEvent('control', () => {
    const snapshot = nativeControl();
    if (!operationId && typeof snapshot.id === 'string' && snapshot.id !== previousId && snapshot.command === command) operationId = snapshot.id;
  });
  const request = command === 'login'
    ? startNative('app.login', args.length ? { server: String(args[0]).replace(/^--login-server=/, '') } : {})
    : startNative(read ? 'control.query' : 'control.mutate', { command, arguments: args.map(String) });
  const [cancellation, setCancellation] = createSignal<CancellationState>('idle');
  const [cancellationError, setCancellationError] = createSignal<string | null>(null);
  let done = false;
  let cancelling: Promise<ApiResult> | undefined;
  const promise = request.promise.then(result => {
    done = !result.unknown;
    unbind();
    if (result.cancelled) setCancellation('confirmed');
    if (result.ok && ['settings-set', 'routes-set', 'context-set', 'restore'].includes(command)) markSavedConfigChanged();
    return result;
  });
  return {
    promise, requestId: request.id,
    get cancelled() { return cancellation() === 'confirmed'; },
    get cancellable() { return read || (!!operationId && operationId === nativeControl().id && nativeControl().canCancel); },
    get cancellation() {
      const native = nativeControl().tasks.find(task => task.id === operationId)?.cancellation;
      return native === 'requested' || native === 'failed' ? native : cancellation();
    },
    get cancellationError() {
      const native = nativeControl().tasks.find(task => task.id === operationId);
      return native?.cancellation === 'failed' ? native.detail ?? null : cancellationError();
    },
    cancel() {
      if (done) return Promise.resolve({ ok: true, completed: true });
      if (!read && !operationId) return Promise.resolve({ ok: false, error: 'Operation identity is not available' });
      if (cancelling) return cancelling;
      setCancellation('requested'); setCancellationError(null);
      cancelling = requestNative(read ? 'control.cancelRead' : 'control.cancel', { id: read ? request.id : operationId }).then(result => {
        cancelling = undefined;
        if (!result.ok) { setCancellation('failed'); setCancellationError(result.error || 'Cancellation was not confirmed'); }
        else if (result.cancelled === true || read) setCancellation('confirmed');
        else setCancellation('idle');
        return result;
      });
      return cancelling;
    },
  };
}
export function api(command: string, ...args: (string | number)[]): Promise<ApiResult> {
  return apiCall(command, ...args).promise;
}
export interface ApiScope {
  call(command: string, ...args: (string | number)[]): ApiCall;
  api(command: string, ...args: (string | number)[]): Promise<ApiResult>;
  cancelAll(): void;
}
export function createApiScope(): ApiScope {
  const reads = new Set<ApiCall>();
  let generation = 0;
  const cancelAll = () => {
    generation++;
    reads.forEach(call => { void call.cancel(); });
    reads.clear();
  };
  if (getOwner()) onCleanup(cancelAll);
  const call = (command: string, ...args: (string | number)[]): ApiCall => {
    const request = apiCall(command, ...args);
    // login is a dedicated native operation, never a cancelable read.
    if (!isReadCommand(command) || command === 'login') return request;
    const started = generation;
    reads.add(request);
    return {
      ...request,
      get cancelled() { return request.cancelled; },
      get cancellable() { return request.cancellable; },
      get cancellation() { return request.cancellation; },
      get cancellationError() { return request.cancellationError; },
      promise: request.promise.then(result => {
        reads.delete(request);
        return started === generation ? result : { ok: false, cancelled: true, error: 'cancelled' };
      }),
    };
  };
  return { call, api: (command, ...args) => call(command, ...args).promise, cancelAll };
}
