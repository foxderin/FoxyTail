/*
 * FoxyTail WebUI - theme, hash router, bottom navigation (FOXY.router).
 *
 *   registerPage(name, titleKey, render)   add a route
 *   render()                               re-render the current page
 *   every(ms, fn) / later(ms, fn)          page-scoped timers, auto-cleared
 *                                          on page switch
 *   onResize(fn)                           page-scoped resize listener,
 *                                          removed by the router on switch
 *   gen() / alive(token)                   page generation token: capture
 *                                          gen() in a page renderer, check
 *                                          alive() in async callbacks so a
 *                                          stale page's response is dropped
 *   applyTheme(mode) / loadTheme()
 *   lockIfNoRoot([scope])                  disable .needs-root controls
 */
(function () {
  'use strict';

  var FOXY = (window.FOXY = window.FOXY || {});
  var h = FOXY.dom.h;
  var t = function (k) { return FOXY.t(k); };

  var view = document.getElementById('view');
  var pageTimers = [];
  var resizeFns = [];
  var generation = 0;

  function every(ms, fn) {
    var id = setInterval(function () { if (!document.hidden) fn(); }, ms);
    pageTimers.push(id);
    return id;
  }

  function later(ms, fn) {
    var id = setTimeout(fn, ms);
    pageTimers.push(id);
    return id;
  }

  function clearPageTimers() {
    /* timeout and interval ids share one pool; clear both to be explicit */
    pageTimers.forEach(function (id) { clearInterval(id); clearTimeout(id); });
    pageTimers = [];
  }

  /* Pages register resize listeners here instead of window.addEventListener;
   * the router removes them all on the next render, so listeners never leak
   * across page switches. */
  function onResize(fn) {
    resizeFns.push(fn);
    window.addEventListener('resize', fn);
  }

  function clearResizeFns() {
    resizeFns.forEach(function (fn) { window.removeEventListener('resize', fn); });
    resizeFns = [];
  }

  /* --- theme ------------------------------------------------------------ */

  /* data-theme-effective mirrors the resolved theme while data-theme="auto",
   * so style.css can keep a single source for the light palette. */
  var autoMql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function syncAutoTheme(mode) {
    if (mode === 'auto' && autoMql) {
      document.documentElement.setAttribute('data-theme-effective', autoMql.matches ? 'light' : 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme-effective');
    }
  }

  function applyTheme(mode) {
    mode = mode || 'dark';
    document.documentElement.setAttribute('data-theme', mode);
    syncAutoTheme(mode);
    try { localStorage.setItem('foxy.theme', mode); } catch (e) { /* ignore */ }
  }

  function loadTheme() {
    var m = 'dark';
    try { m = localStorage.getItem('foxy.theme') || 'dark'; } catch (e) { /* ignore */ }
    applyTheme(m);
    return m;
  }

  if (autoMql) {
    var onSystemTheme = function () {
      var m = 'dark';
      try { m = localStorage.getItem('foxy.theme') || 'dark'; } catch (e) { /* ignore */ }
      if (m === 'auto') syncAutoTheme('auto');
    };
    if (typeof autoMql.addEventListener === 'function') autoMql.addEventListener('change', onSystemTheme);
    else if (typeof autoMql.addListener === 'function') autoMql.addListener(onSystemTheme);
  }

  /* --- root lockdown ------------------------------------------------------ */

  /* Disable every .needs-root element; for non-form containers (span.switch)
   * setting disabled is a no-op, so also disable the controls inside. */
  function lockIfNoRoot(scope) {
    if (FOXY.hasRoot) return;
    Array.prototype.forEach.call((scope || view).querySelectorAll('.needs-root'), function (el) {
      if ('disabled' in el) el.disabled = true;
      Array.prototype.forEach.call(
        el.querySelectorAll('input, select, button, textarea'),
        function (c) { c.disabled = true; });
    });
  }

  /* --- router ------------------------------------------------------------- */

  var ROUTES = {};
  function registerPage(name, titleKey, renderFn) { ROUTES[name] = { titleKey: titleKey, render: renderFn }; }

  var NAV = [
    { name: 'dashboard', icon: '⌂' },
    { name: 'peers', icon: '◉' },
    { name: 'exitnodes', icon: '⇄' },
    { name: 'traffic', icon: '▤' },
    { name: 'more', icon: '⋯' }
  ];

  function renderNav(active) {
    var nav = document.getElementById('bottom-nav');
    nav.textContent = '';
    NAV.forEach(function (item) {
      var a = h('a', {
        class: 'nav-item' + (item.name === active ? ' active' : ''),
        href: '#/' + item.name
      },
        h('span', { class: 'nav-ico', text: item.icon, 'aria-hidden': 'true' }),
        h('span', { text: t('nav_' + item.name) }));
      nav.appendChild(a);
    });
  }

  function currentPage() {
    var m = /^#\/([a-z-]+)/.exec(location.hash || '');
    return m && ROUTES[m[1]] ? m[1] : 'dashboard';
  }

  function render() {
    generation++;
    clearPageTimers();
    clearResizeFns();
    document.getElementById('modal-root').textContent = '';
    var name = currentPage();
    view.textContent = '';
    renderNav(name);
    document.getElementById('app-title').textContent =
      'FoxyTail · ' + t(ROUTES[name].titleKey);
    ROUTES[name].render(view);
    lockIfNoRoot();
  }

  window.addEventListener('hashchange', render);
  FOXY.onLangChange = render;

  FOXY.router = {
    registerPage: registerPage,
    render: render,
    every: every,
    later: later,
    onResize: onResize,
    gen: function () { return generation; },
    alive: function (token) { return token === generation; },
    applyTheme: applyTheme,
    loadTheme: loadTheme,
    lockIfNoRoot: lockIfNoRoot
  };
})();
