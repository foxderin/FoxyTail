/*
 * FoxyTail WebUI — KernelSU / MMRL root bridge + WebAPI client.
 *
 * Prefer KernelSU/MMRL spawn: their callback-based exec still executes the
 * entire shell command synchronously inside the JavaScript interface.
 * Legacy managers without spawn fall back to exec. Without either bridge
 * `hasRoot` stays false and the UI disables root-only controls.
 *
 * Every call is time-boxed (the old UI had no timeout and froze on any
 * hung exec) and cancellable: cancel() settles the front-end promise
 * after the backend acknowledges cancellation of that request identity.
 * Replacements wait for that acknowledgement before launching.
 */
import { exec as ksuExec } from 'kernelsu';
import { getOwner, onCleanup } from 'solid-js';
import { afterPaint } from './schedule';

declare global {
  interface Window {
    ksu?: { exec?: unknown; spawn?: unknown };
    kernelsu?: { exec?: unknown; spawn?: unknown };
    exec?: unknown;
  }
}

export const WEBAPI = '/data/adb/foxytail/scripts/foxytail.webapi.sh';

export interface ApiResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

class ApiExecutionError extends Error {
  constructor(readonly result: ApiResult, message: string) {
    super(message);
  }
}

/* errno != 0: the webapi failure contract carries the reason in stdout as
 * {"ok":false,"error":...} JSON (stderr is usually empty). Prefer that
 * error, fall back to stderr, then the bare exit code. */
function execFailure(errno: unknown, stdout: unknown, stderr: unknown): Error {
  try {
    const parsed = JSON.parse(typeof stdout === 'string' ? stdout : '') as ApiResult;
    if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && parsed.error) {
      // A failed write/read may still report a verified actual preference.
      // Preserve that explicit failure payload across the native exit event.
      if (!Array.isArray(parsed) && parsed.ok === false) {
        return new ApiExecutionError(parsed, parsed.error);
      }
      return new Error(parsed.error);
    }
  } catch {
    /* fall through */
  }
  if (typeof stderr === 'string' && stderr) return new Error(stderr);
  return new Error('exit code ' + String(errno));
}

type RawExec = (cmd: string) => Promise<string>;

/* Single-quote escaping: the only safe way to embed user input into a
 * shell command line. ' -> '\'' */
export function quote(value: string | number): string {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

type KsuBridgeFn = (cmd: string, options: string, cbName: string) => void;
type KsuSpawnFn = (cmd: string, args: string, options: string, cbName: string) => void;

/* Native spawn emits one data event per output line, followed by exit and
 * (on some managers) a second error event for a nonzero exit. Install all
 * listeners before entering Java, including the synchronous throw path. */
function wrapKsuSpawn(bridge: { spawn?: unknown }): RawExec {
  return (cmd) => new Promise<string>((resolve, reject) => {
    const cbName = '__foxy_spawn_' + Math.random().toString(36).slice(2);
    const callbacks = window as unknown as Record<string, unknown>;
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    const finish = (errno: unknown, err?: unknown) => {
      if (settled) return;
      settled = true;
      const out = stdout.join('\n');
      const errors = stderr.join('\n');
      stdout.length = 0;
      stderr.length = 0;
      // Keep a no-op receiver briefly: KernelSU posts error after exit in
      // a separate WebView callback. Deleting immediately raises an error.
      setTimeout(() => { delete callbacks[cbName]; }, 1000);
      if (err === undefined && (errno == null || errno === 0)) resolve(out);
      else reject(execFailure(errno ?? -1, out, errors ||
        (err instanceof Error ? err.message : err == null ? '' : String(err))));
    };
    callbacks[cbName] = {
      stdout: { emit: (event: string, data: unknown) => { if (!settled && event === 'data') stdout.push(String(data ?? '')); } },
      stderr: { emit: (event: string, data: unknown) => { if (!settled && event === 'data') stderr.push(String(data ?? '')); } },
      emit: (event: string, value: unknown) => {
        if (event === 'exit') finish(value);
        else if (event === 'error') finish((value as { exitCode?: unknown } | null)?.exitCode, value);
      },
    };
    try {
      // The native implementation concatenates args without shell quoting.
      // Pass our already-quoted full command as one string and no raw args.
      (bridge.spawn as KsuSpawnFn)(cmd, '[]', '{}', cbName);
    } catch (err) {
      finish(undefined, err);
    }
  });
}

/* KernelSU / MMRL @JavascriptInterface bridge. Both extra arguments must be
 * STRINGS — passing a JS object or function straight to Java raises
 * "Java exception was raised during method invocation". */
function wrapKsuExec(fn: KsuBridgeFn): RawExec {
  return (cmd) =>
    new Promise<string>((resolve, reject) => {
      const cbName = '__foxy_cb_' + Math.random().toString(36).slice(2);
      (window as unknown as Record<string, unknown>)[cbName] = (
        errno: number | null,
        stdout: string,
        stderr: string,
      ) => {
        delete (window as unknown as Record<string, unknown>)[cbName];
        if (errno == null || errno === 0) resolve(String(stdout || ''));
        else reject(execFailure(errno, stdout, stderr));
      };
      try {
        fn(cmd, '{}', cbName);
      } catch (e) {
        delete (window as unknown as Record<string, unknown>)[cbName];
        reject(e);
      }
    });
}

/* Wrap MMRL's global exec(cmd, cb?) which may be sync or callback based. */
function wrapGlobalExec(
  fn: (cmd: string, cb?: (...a: unknown[]) => void) => unknown,
): RawExec {
  return (cmd) =>
    new Promise<string>((resolve, reject) => {
      let settled = false;
      const once = (...args: unknown[]) => {
        if (settled) return;
        settled = true;
        const [a, b, c] = args;
        if (args.length > 1) {
          if (a == null || a === 0) return resolve(String(b || ''));
          return reject(execFailure(a, b, c));
        }
        if (a == null) return resolve('');
        if (typeof a === 'string') return resolve(a);
        if (typeof a === 'object') {
          const r = a as Record<string, unknown>;
          if ('stdout' in r || 'stderr' in r) {
            const code = 'errno' in r ? (r.errno as number) : (r.code as number);
            if (code == null || code === 0) return resolve(String(r.stdout || ''));
            return reject(execFailure(code, r.stdout, r.stderr));
          }
          return reject(new Error('unrecognized exec result: ' + Object.prototype.toString.call(a)));
        }
        resolve(String(a));
      };
      try {
        const ret = fn(cmd, once);
        if (typeof ret === 'string') once(ret);
        else if (ret && typeof (ret as Promise<unknown>).then === 'function') {
          (ret as Promise<unknown>).then(once, reject);
        }
      } catch (e) {
        reject(e);
      }
    });
}

function detectExec(): RawExec | null {
  try {
    if (window.ksu && typeof window.ksu.spawn === 'function') return wrapKsuSpawn(window.ksu);
    if (window.kernelsu && typeof window.kernelsu.spawn === 'function') return wrapKsuSpawn(window.kernelsu);
    if (window.ksu && typeof window.ksu.exec === 'function') {
      /* The kernelsu npm package targets the global `ksu` bridge directly. */
      return async (cmd) => {
        const res = await ksuExec(cmd);
        if (res.errno === 0) return res.stdout;
        throw execFailure(res.errno, res.stdout, res.stderr);
      };
    }
    if (window.kernelsu && typeof window.kernelsu.exec === 'function') {
      return wrapKsuExec(window.kernelsu.exec as KsuBridgeFn);
    }
    if (typeof window.exec === 'function') {
      return wrapGlobalExec(window.exec as (cmd: string, cb?: (...a: unknown[]) => void) => unknown);
    }
  } catch {
    /* fall through to no-root */
  }
  return null;
}

const execImpl = detectExec();

export const hasRoot: boolean = execImpl !== null;

/* Per-command timeout budget (ms). Heavy probes get a wider budget. */
const DEFAULT_TIMEOUT_MS = 15000;
const CLEANUP_TIMEOUT_MS = 8000;

const COMMAND_TIMEOUTS: Record<string, number> = {
  status: 15000,
  peers: 15000,
  exitnodes: 15000,
  'speedtest-exitnodes': 90000,
  'derp-speedtest': 60000,
  // Profile DNS restoration precedes teardown; keep the asynchronous request
  // alive through its bounded CLI calls instead of reporting a false timeout.
  control: 120000,
  'mode-set': 120000,
  'exitnode-set': 25000,
  'exitnode-clear': 25000,
  login: 95000,
  'login-authkey': 130000,
  logout: 95000,
  accounts: 20000,
  switch: 95000,
  'serve-list': 20000,
  'serve-set': 30000,
  'serve-del': 30000,
  'funnel-list': 20000,
  'funnel-set': 30000,
  'funnel-del': 30000,
  apps: 90000,
  compat: 35000,
  'routes-set': 45000,
  'subnet-routes-get': 20000,
  'subnet-routes-set': 35000,
  'context-set': 45000,
  'file-send': 320000,
  'file-receive': 70000,
  diag: 130000,
  backup: 60000,
};

/* Cancellation addresses one registered backend request, never a process name. */
async function cleanupBackend(requestId: string): Promise<ApiResult> {
  try {
    const out = await execRaw(WEBAPI + ' cancel ' + quote(requestId), CLEANUP_TIMEOUT_MS);
    return parseResult(out, 'cancel');
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
}

function parseResult(out: string, cmd: string): ApiResult {
  try {
    const result: unknown = JSON.parse(out);
    if (result && typeof result === 'object' && typeof (result as ApiResult).ok === 'boolean') {
      return result as ApiResult;
    }
  } catch { /* report one consistent boundary error */ }
  return { ok: false, error: `invalid JSON from webapi (${cmd}): ${out.slice(0, 200)}` };
}

let requestSequence = 0;
const requestSession = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);

/* An abort signal drops a bounded raw read; process-owning operations must
 * use apiCall instead so cancellation is acknowledged by the backend. */
export function execRaw(cmd: string, timeoutMs: number = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
  if (!execImpl) {
    return Promise.reject(
      new Error('no root exec bridge (open this page in KernelSU manager or MMRL)'),
    );
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let unschedule: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (out?: string, err?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unschedule?.();
      signal?.removeEventListener('abort', abort);
      if (err !== undefined) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(out ?? '');
    };
    const abort = () => finish(undefined, new Error('cancelled'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(undefined,
      new Error(`exec timed out after ${Math.round(timeoutMs / 1000)}s: ${cmd.slice(0, 120)}`)), timeoutMs);
    unschedule = afterPaint(() => execImpl(cmd).then(
      (out) => finish(out),
      (err) => finish(undefined, err),
    ));
  });
}

export interface ApiCall {
  readonly promise: Promise<ApiResult>;
  readonly requestId: string;
  readonly cancelled: boolean;
  /* Resolves only after the backend has acknowledged termination. */
  cancel(): Promise<ApiResult>;
}

export function apiCall(cmd: string, ...args: (string | number)[]): ApiCall {
  return apiCallAfter(Promise.resolve({ ok: true }), cmd, ...args);
}

/* A replacement can be created synchronously for reactive UI state, while
 * execution remains gated on the previous request's cancellation. */
export function apiCallAfter(before: Promise<ApiResult>, cmd: string, ...args: (string | number)[]): ApiCall {
  const timeoutMs = COMMAND_TIMEOUTS[cmd] ?? DEFAULT_TIMEOUT_MS;
  const requestId = Math.floor(Date.now() / 1000) + '_' + requestSession + '_' + (++requestSequence).toString(36);
  const line = WEBAPI + ' --request-id ' + quote(requestId) + ' ' + quote(cmd) +
    (args.length ? ' ' + args.map(quote).join(' ') : '');
  let isCancelled = false;
  let launched = false;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unschedule: (() => void) | undefined;
  let cleanup: Promise<ApiResult> | undefined;
  let resolveResult: (result: ApiResult) => void = () => undefined;
  const promise = new Promise<ApiResult>((resolve) => { resolveResult = resolve; });
  const finish = (result: ApiResult) => {
    if (done) return;
    done = true;
    unschedule?.();
    clearTimeout(timer);
    resolveResult(result);
  };
  const cancel = (): Promise<ApiResult> => {
    if (cleanup) return cleanup;
    if (done) return Promise.resolve({ ok: true });
    isCancelled = true;
    unschedule?.();
    clearTimeout(timer);
    cleanup = (launched ? cleanupBackend(requestId) : before).then((res) => {
      finish(res.ok
        ? { ok: false, error: 'cancelled', cancelled: true }
        : { ok: false, error: 'Cancellation failed: ' + (res.error || 'unknown error'), cleanupFailed: true });
      return res;
    });
    return cleanup;
  };

  void before.then((previous) => {
    if (isCancelled || done) return;
    if (!previous.ok) {
      cleanup = Promise.resolve(previous);
      finish({ ok: false, error: 'Previous operation could not be cancelled: ' + (previous.error || 'unknown error') });
      return;
    }
    if (!execImpl) {
      finish({ ok: false, error: 'no root exec bridge (open this page in KernelSU manager or MMRL)' });
      return;
    }
    unschedule = afterPaint(() => {
      if (isCancelled || done) return;
      launched = true;
      timer = setTimeout(() => {
        isCancelled = true;
        cleanup = cleanupBackend(requestId);
        void cleanup.then((res) => finish({
          ok: false,
          error: `${cmd}: timed out after ${Math.round(timeoutMs / 1000)}s` +
            (res.ok ? '' : '; cancellation failed: ' + (res.error || 'unknown error')),
          cleanupFailed: !res.ok,
        }));
      }, timeoutMs);
      execImpl(line).then(
        (out) => { if (!isCancelled) finish(parseResult(out, cmd)); },
        (err) => {
          if (!isCancelled) finish({
            ...(err instanceof ApiExecutionError ? err.result : {}),
            ok: false,
            error: String(err instanceof Error ? err.message : err),
          });
        },
      );
    });
  }, (err) => finish({ ok: false, error: String(err) }));

  return { promise, requestId, get cancelled() { return isCancelled; }, cancel };
}

/* Convenience form for lightweight read-only calls. */
export function api(cmd: string, ...args: (string | number)[]): Promise<ApiResult> {
  return apiCall(cmd, ...args).promise;
}

export interface ApiScope {
  /* Tracked call: cancelled automatically when the owning page unmounts. */
  call(cmd: string, ...args: (string | number)[]): ApiCall;
  /* Same, returning just the promise (lightweight reads). */
  api(cmd: string, ...args: (string | number)[]): Promise<ApiResult>;
  /* Cancel every in-flight call of this page right now. */
  cancelAll(): void;
}

/* Page-scoped call registry. Mount-time: every call made through the scope
 * is cancelled on cleanup. Request identities keep delayed cancellation
 * from affecting a new page's requests. */
export function createApiScope(): ApiScope {
  const calls = new Set<ApiCall>();
  const cancelAll = () => {
    const pending = [...calls];
    calls.clear();
    /* Mark queued calls cancelled before their launch microtask can run.
     * Native cancellation itself goes through the frame-aware exec path. */
    pending.forEach((c) => { void c.cancel(); });
  };
  if (getOwner()) onCleanup(cancelAll);
  const track = (c: ApiCall): ApiCall => {
    calls.add(c);
    const drop = () => calls.delete(c);
    c.promise.then(drop, drop);
    return c;
  };
  return {
    call: (cmd, ...args) => track(apiCall(cmd, ...args)),
    api: (cmd, ...args) => track(apiCall(cmd, ...args)).promise,
    cancelAll,
  };
}
