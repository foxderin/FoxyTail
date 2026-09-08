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
 * immediately with an ApiCancelledError and fires a best-effort backend
 * cleanup (pkill scoped to the exact webapi subcommand) that never blocks
 * the UI. The backend JSON contract is frozen; shell files are untouched.
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

export class ApiCancelledError extends Error {
  readonly cancelled = true;
  constructor() {
    super('cancelled');
    this.name = 'ApiCancelledError';
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof ApiCancelledError || (err as { cancelled?: boolean })?.cancelled === true;
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
        else reject(new Error(String(stderr || 'exit code ' + errno)));
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
          return reject(new Error(String(c || 'exit code ' + a)));
        }
        if (a == null) return resolve('');
        if (typeof a === 'string') return resolve(a);
        if (typeof a === 'object') {
          const r = a as Record<string, unknown>;
          if ('stdout' in r || 'stderr' in r) {
            const code = 'errno' in r ? (r.errno as number) : (r.code as number);
            if (code == null || code === 0) return resolve(String(r.stdout || ''));
            return reject(new Error(String(r.stderr || 'exit code ' + code)));
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
        } else if (ret === undefined) {
          setTimeout(() => once(''), 30000);
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
        throw new Error(res.stderr || 'exit code ' + res.errno);
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
const CLEANUP_TIMEOUT_MS = 5000;

const COMMAND_TIMEOUTS: Record<string, number> = {
  status: 15000,
  peers: 15000,
  exitnodes: 15000,
  'speedtest-exitnodes': 90000,
  'derp-speedtest': 60000,
  control: 30000,
  'mode-set': 30000,
  login: 30000,
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
  'file-send': 320000,
  'file-receive': 70000,
  diag: 130000,
};

/* Best-effort backend kill patterns for cancellable commands. Patterns are
 * built ONLY from these constants — never from user input. Each is scoped
 * to the exact webapi subcommand (plus the underlying tailscale probe for
 * the speed tests) so one cancellation cannot kill a sibling call. */
const KILL_PATTERNS: Record<string, string[]> = {
  'speedtest-exitnodes': ['foxytail.webapi.sh speedtest-exitnodes', 'tailscale.*ping'],
  'derp-speedtest': ['foxytail.webapi.sh derp-speedtest', 'tailscale.*netcheck'],
  diag: ['foxytail.webapi.sh diag', 'foxytail.diag collect'],
  'file-receive': ['foxytail.webapi.sh file-receive', 'tailscale.*file get'],
  'file-send': ['foxytail.webapi.sh file-send', 'tailscale.*file cp'],
  apps: ['foxytail.webapi.sh apps'],
  login: ['foxytail.webapi.sh login ', 'tailscale.*login'],
  'login-authkey': ['foxytail.webapi.sh login-authkey', 'tailscale.*login'],
};

/* Fire-and-forget backend cleanup: never awaited by callers, own short
 * timeout, failures are silent by design. */
function cleanupBackend(cmd: string): void {
  const patterns = KILL_PATTERNS[cmd];
  if (!patterns || !execImpl) return;
  const line = patterns.map((p) => `pkill -f '${p}' 2>/dev/null`).join('; ');
  const timer = setTimeout(() => undefined, CLEANUP_TIMEOUT_MS);
  execImpl(line)
    .catch(() => undefined)
    .finally(() => clearTimeout(timer));
}

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
  readonly cancelled: boolean;
  /* Front-end settle is immediate; the backend pkill is fire-and-forget
   * and never blocks navigation or rendering. */
  cancel(): void;
}

/* Call the WebAPI backend; the result is always one parsed JSON document.
 * Timeouts and exec failures surface as { ok:false, error }; cancellation
 * rejects with ApiCancelledError so pages can tell "user aborted" apart
 * from real failures. */
export function apiCall(cmd: string, ...args: (string | number)[]): ApiCall {
  const timeoutMs = COMMAND_TIMEOUTS[cmd] ?? DEFAULT_TIMEOUT_MS;
  const line = WEBAPI + ' ' + cmd + (args.length ? ' ' + args.map(quote).join(' ') : '');
  let isCancelled = false;
  let cancelFn: () => void = () => undefined;

  const promise = new Promise<ApiResult>((resolve) => {
    let done = false;
    const finish = (result: ApiResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: `${cmd}: timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    cancelFn = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      /* Resolve (not reject) with a marker: pages treat a cancelled call as
       * a neutral outcome — no error toast, just a quiet "cancelled". */
      resolve({ ok: false, error: 'cancelled', cancelled: true });
    };

    if (!execImpl) {
      finish({
        ok: false,
        error: 'no root exec bridge (open this page in KernelSU manager or MMRL)',
      });
      return;
    }
    execImpl(line).then(
      (out) => {
        try {
          finish(JSON.parse(out) as ApiResult);
        } catch {
          finish({ ok: false, error: `invalid JSON from webapi (${cmd}): ${out.slice(0, 200)}` });
        }
      },
      (err) => {
        finish({ ok: false, error: String(err instanceof Error ? err.message : err) });
      },
    );
  });

  return {
    promise,
    get cancelled() {
      return isCancelled;
    },
    cancel() {
      if (isCancelled) return;
      isCancelled = true;
      cancelFn();
      cleanupBackend(cmd);
    },
  };
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
 * is cancelled on cleanup. Cleanup is fire-and-forget — the pkill execs it
 * triggers run in the background and never block the next page's render. */
export function createApiScope(): ApiScope {
  const calls = new Set<ApiCall>();
  const cancelAll = () => {
    const pending = [...calls];
    calls.clear();
    /* Defer so route teardown stays synchronous and non-blocking. */
    queueMicrotask(() => pending.forEach((c) => c.cancel()));
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
