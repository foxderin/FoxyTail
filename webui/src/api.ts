/*
 * FoxyTail WebUI — KernelSU / MMRL root bridge + WebAPI client.
 *
 * Bridge probing order mirrors the previous hand-written build:
 * window.ksu.exec (KernelSU manager WebUI) -> window.kernelsu.exec
 * (MMRL compat) -> global exec() (MMRL direct injection). When none is
 * found `hasRoot` stays false and the UI disables root-only controls.
 *
 * Every call is time-boxed (the old UI had no timeout and froze on any
 * hung exec) and cancellable: cancel() settles the front-end promise
 * after the backend acknowledges cancellation of that request identity.
 * Replacements wait for that acknowledgement before launching.
 */
import { exec as ksuExec } from 'kernelsu';
import { getOwner, onCleanup } from 'solid-js';

declare global {
  interface Window {
    ksu?: { exec?: unknown };
    kernelsu?: { exec?: unknown };
    exec?: unknown;
  }
}

export const WEBAPI = '/data/adb/foxytail/scripts/foxytail.webapi.sh';

export interface ApiResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/* errno != 0: the webapi failure contract carries the reason in stdout as
 * {"ok":false,"error":...} JSON (stderr is usually empty). Prefer that
 * error, fall back to stderr, then the bare exit code. */
function execFailure(errno: unknown, stdout: unknown, stderr: unknown): Error {
  try {
    const parsed = JSON.parse(typeof stdout === 'string' ? stdout : '') as ApiResult;
    if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && parsed.error) {
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
  control: 30000,
  'mode-set': 30000,
  'exitnode-set': 25000,
  'exitnode-clear': 25000,
  login: 35000,
  'login-authkey': 70000,
  logout: 35000,
  accounts: 20000,
  switch: 35000,
  'serve-list': 20000,
  'serve-set': 30000,
  'serve-del': 30000,
  'funnel-list': 20000,
  'funnel-set': 30000,
  'funnel-del': 30000,
  apps: 90000,
  compat: 35000,
  'routes-set': 45000,
  'context-set': 45000,
  'file-send': 320000,
  'file-receive': 70000,
  diag: 130000,
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

export function execRaw(cmd: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string> {
  if (!execImpl) {
    return Promise.reject(
      new Error('no root exec bridge (open this page in KernelSU manager or MMRL)'),
    );
  }
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`exec timed out after ${Math.round(timeoutMs / 1000)}s: ${cmd.slice(0, 120)}`));
    }, timeoutMs);
    execImpl(cmd).then(
      (out) => {
        clearTimeout(timer);
        resolve(out);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
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
  let cleanup: Promise<ApiResult> | undefined;
  let resolveResult: (result: ApiResult) => void = () => undefined;
  const promise = new Promise<ApiResult>((resolve) => { resolveResult = resolve; });
  const finish = (result: ApiResult) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolveResult(result);
  };
  const cancel = (): Promise<ApiResult> => {
    if (cleanup) return cleanup;
    if (done) return Promise.resolve({ ok: true });
    isCancelled = true;
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
      (err) => { if (!isCancelled) finish({ ok: false, error: String(err instanceof Error ? err.message : err) }); },
    );
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
    /* Defer so route teardown stays synchronous and non-blocking. */
    queueMicrotask(() => pending.forEach((c) => { void c.cancel(); }));
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
