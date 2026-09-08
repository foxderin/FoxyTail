/*
 * FoxyTail WebUI - KernelSU / MMRL bridge.
 *
 * Provides the global FOXY namespace used by every page:
 *   FOXY.hasRoot           boolean, true when a root exec bridge was found
 *   FOXY.exec(cmd)         Promise<string>  raw stdout of a root shell command
 *   FOXY.api(cmd, ...args) Promise<object>  parsed JSON from foxytail.webapi.sh
 *   FOXY.quote(value)      single-quote shell escaping for user input
 *   FOXY.initBridge()      probe the environment, show the no-root banner
 *
 * Bridge probing order: window.ksu.exec (KernelSU manager WebUI),
 * window.kernelsu.exec (MMRL compat), global exec() (MMRL direct injection).
 * When none is available the UI shows a bilingual banner and disables
 * all buttons marked .needs-root.
 */
(function () {
  'use strict';

  var WEBAPI = '/data/adb/foxytail/scripts/foxytail.webapi.sh';

  var FOXY = (window.FOXY = window.FOXY || {});
  FOXY.hasRoot = false;

  /* Single-quote escaping: the only safe way to embed user input into a
   * shell command line. ' -> '\'' */
  FOXY.quote = function (value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  };

  /* Normalize the many callback payload shapes used by KSU/MMRL:
   * string, {errno,stdout,stderr}, {code,stdout,stderr} or a bare stdout. */
  function settle(resolve, reject, res) {
    if (res == null) return resolve('');
    if (typeof res === 'string') return resolve(res);
    if (typeof res === 'object') {
      if ('stdout' in res || 'stderr' in res) {
        var code = 'errno' in res ? res.errno : res.code;
        if (code == null || code === 0) return resolve(String(res.stdout || ''));
        return reject(new Error(String(res.stderr || 'exit code ' + code)));
      }
      /* unrecognized object: fail loudly instead of resolving
       * "[object Object]" and letting it leak into the UI */
      return reject(new Error('unrecognized exec result: ' + Object.prototype.toString.call(res)));
    }
    resolve(String(res));
  }

  /* KernelSU / MMRL @JavascriptInterface bridge. The real signature is
   * ksu.exec(command, optionsJsonString, callbackNameString): both extra
   * arguments must be STRINGS — passing a JS object or function straight to
   * Java raises "Java exception was raised during method invocation".
   * We register a one-shot global callback and hand Java its name; the Java
   * side then calls window[callbackName](errno, stdout, stderr). */
  var ksuCbCounter = 0;
  function wrapKsuExec(fn, ctx) {
    return function (cmd) {
      return new Promise(function (resolve, reject) {
        var cbName = '__foxy_cb_' + (ksuCbCounter++);
        window[cbName] = function (errno, stdout, stderr) {
          delete window[cbName];
          if (errno == null || errno === 0) return resolve(String(stdout || ''));
          reject(new Error(String(stderr || 'exit code ' + errno)));
        };
        try {
          fn.call(ctx, cmd, '{}', cbName);
        } catch (e) {
          delete window[cbName];
          reject(e);
        }
      });
    };
  }

  /* Wrap MMRL's global exec(cmd, cb?) which may be sync or callback based. */
  function wrapGlobalExec(fn) {
    return function (cmd) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function once(a, b, c) {
          if (settled) return;
          settled = true;
          if (arguments.length > 1) {
            if (a == null || a === 0) return resolve(String(b || ''));
            return reject(new Error(String(c || 'exit code ' + a)));
          }
          settle(resolve, reject, a);
        }
        try {
          var ret = fn(cmd, once);
          if (typeof ret === 'string') once(ret);
          else if (ret && typeof ret.then === 'function') ret.then(once, reject);
          else if (ret === undefined) {
            /* callback style: give it a tick, empty output is legitimate */
            setTimeout(function () { once(''); }, 30000);
          }
        } catch (e) {
          reject(e);
        }
      });
    };
  }

  function detectExec() {
    try {
      if (window.ksu && typeof window.ksu.exec === 'function') {
        return wrapKsuExec(window.ksu.exec, window.ksu);
      }
      if (window.kernelsu && typeof window.kernelsu.exec === 'function') {
        return wrapKsuExec(window.kernelsu.exec, window.kernelsu);
      }
      if (typeof window.exec === 'function') {
        return wrapGlobalExec(window.exec);
      }
    } catch (e) { /* fall through to no-root */ }
    return null;
  }

  var execImpl = detectExec();
  FOXY.hasRoot = !!execImpl;

  FOXY.exec = function (cmd) {
    if (!execImpl) {
      return Promise.reject(new Error('no root exec bridge (open this page in KernelSU manager or MMRL)'));
    }
    return execImpl(cmd);
  };

  /* Call the WebAPI backend and parse its single JSON document. */
  FOXY.api = function (cmd) {
    var args = Array.prototype.slice.call(arguments, 1).map(FOXY.quote);
    var line = WEBAPI + ' ' + cmd + (args.length ? ' ' + args.join(' ') : '');
    return FOXY.exec(line).then(function (out) {
      try {
        return JSON.parse(out);
      } catch (e) {
        return { ok: false, error: 'invalid JSON from webapi (' + cmd + '): ' + String(out).slice(0, 200) };
      }
    }, function (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    });
  };

  /* Probe + banner + button lockdown. Called once from js/boot.js. */
  FOXY.initBridge = function () {
    if (FOXY.hasRoot) return;
    var banner = document.createElement('div');
    banner.className = 'root-banner';
    banner.id = 'root-banner';
    banner.setAttribute('aria-live', 'polite');
    banner.textContent = (FOXY.t ? FOXY.t('no_root_banner')
      : '请在 KernelSU 管理器或 MMRL 中打开本页面 / Open this page in KernelSU manager or MMRL');
    document.body.insertBefore(banner, document.body.firstChild);
    Array.prototype.forEach.call(document.querySelectorAll('.needs-root'), function (el) {
      if ('disabled' in el) el.disabled = true;
      /* non-form containers (e.g. span.switch): disable the controls inside */
      Array.prototype.forEach.call(
        el.querySelectorAll('input, select, button, textarea'),
        function (c) { c.disabled = true; });
    });
  };
})();
