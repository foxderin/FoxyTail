/*
 * FoxyTail WebUI - pages: Routing, Logs, Settings, Diagnostics, More.
 */
(function () {
  'use strict';

  var FOXY = window.FOXY;
  var t = function (k) { return FOXY.t(k); };
  var h = FOXY.dom.h;
  var kv = FOXY.dom.kv;
  var stateBox = FOXY.dom.stateBox;
  var toast = FOXY.ui.toast;
  var toastErr = FOXY.ui.toastErr;
  var confirmBox = FOXY.ui.confirmBox;
  var actionButton = FOXY.ui.actionButton;
  var listRow = FOXY.ui.listRow;
  var registerPage = FOXY.router.registerPage;
  var every = FOXY.router.every;
  var gen = FOXY.router.gen;
  var alive = FOXY.router.alive;
  var lockIfNoRoot = FOXY.router.lockIfNoRoot;
  var applyTheme = FOXY.router.applyTheme;
  var loadTheme = FOXY.router.loadTheme;

  /* ================= Routing ================= */

  registerPage('routing', 'route_title', function (root) {
    var page = gen();
    var scopeCard = h('div', { class: 'card' });
    var appsCard = h('div', { class: 'card' });
    var subCard = h('div', { class: 'card' });
    var applyRow = h('div');
    root.appendChild(scopeCard);
    root.appendChild(appsCard);
    root.appendChild(subCard);
    root.appendChild(applyRow);

    var state = { scope: 'all', uids: [], subnets: [] };
    var appsLoaded = null; /* null = not loaded yet */

    /* --- scope --- */
    scopeCard.appendChild(h('h2', { text: t('route_scope') }));
    var radioWrap = h('div', { class: 'radio-cards' });
    var scopeHint = h('div', { class: 'dim', text: '' });
    var radioEls = {};
    ['all', 'selected', 'bypass'].forEach(function (s) {
      var el = h('div', {
        class: 'radio-card', text: t('route_scope_' + s),
        onclick: function () { state.scope = s; syncScope(); }
      });
      radioEls[s] = el;
      radioWrap.appendChild(el);
    });
    function syncScope() {
      ['all', 'selected', 'bypass'].forEach(function (s) {
        radioEls[s].className = 'radio-card' + (state.scope === s ? ' selected' : '');
      });
      scopeHint.textContent = t('route_scope_' + state.scope + '_hint');
    }
    scopeCard.appendChild(radioWrap);
    scopeCard.appendChild(scopeHint);

    /* xt_owner probe: hide per-app scope when unsupported */
    FOXY.exec('iptables -m owner --help >/dev/null 2>&1 && echo yes || echo no')
      .then(function (out) {
        if (!alive(page)) return;
        if (String(out).indexOf('yes') === -1) {
          scopeCard.textContent = '';
          scopeCard.appendChild(h('h2', { text: t('route_scope') }));
          scopeCard.appendChild(h('div', { class: 'banner warn', text: t('route_no_owner') }));
          scopeCard.appendChild(kv(t('route_scope'), state.scope));
        }
      }, function () { /* keep visible on probe failure */ });

    /* --- apps --- */
    appsCard.appendChild(h('h2', { text: t('route_apps') }));
    var search = h('input', { type: 'text', placeholder: t('route_apps_search') });
    var appsList = h('div');
    appsCard.appendChild(h('label', { class: 'field' }, search));
    appsCard.appendChild(appsList);
    appsList.appendChild(stateBox(t('route_apps_loading'), true));

    function renderApps(filter) {
      appsList.textContent = '';
      if (!appsLoaded) { appsList.appendChild(stateBox(t('route_apps_loading'), true)); return; }
      var f = (filter || '').toLowerCase();
      var sel = state.uids.map(String);
      var rows = appsLoaded.filter(function (a) {
        return !f || a.label.toLowerCase().indexOf(f) >= 0 || a.package.toLowerCase().indexOf(f) >= 0;
      });
      rows.sort(function (a, b) {
        var as = sel.indexOf(String(a.uid)) >= 0 ? 0 : 1;
        var bs = sel.indexOf(String(b.uid)) >= 0 ? 0 : 1;
        return as - bs || a.label.localeCompare(b.label);
      });
      if (!rows.length) { appsList.appendChild(stateBox(t('empty'))); return; }
      rows.slice(0, 300).forEach(function (a) {
        var cb = h('input', { type: 'checkbox', checked: sel.indexOf(String(a.uid)) >= 0 });
        cb.addEventListener('change', function () {
          var uid = String(a.uid);
          var i = state.uids.map(String).indexOf(uid);
          if (cb.checked && i < 0) state.uids.push(a.uid);
          if (!cb.checked && i >= 0) state.uids.splice(i, 1);
        });
        appsList.appendChild(h('label', { class: 'list-row' },
          cb,
          h('div', { class: 'main' },
            h('div', { class: 'title', text: a.label }),
            h('div', { class: 'sub', text: a.package + ' · ' + t('traffic_uid') + a.uid }))));
      });
    }
    /* debounce: re-rendering up to 300 rows per keystroke janks the WebView */
    var searchTimer = null;
    search.addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        if (alive(page)) renderApps(search.value);
      }, 300);
    });

    FOXY.api('apps').then(function (res) {
      if (!alive(page)) return;
      appsLoaded = res.ok ? res.apps : [];
      if (!res.ok) toastErr(t('op_failed'), res);
      renderApps('');
    });

    /* --- subnets --- */
    subCard.appendChild(h('h2', { text: t('route_subnets') }));
    var subList = h('div');
    subCard.appendChild(subList);

    function validCidr(s) {
      return /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(s) || /^[0-9a-fA-F:]+\/\d{1,3}$/.test(s);
    }

    function renderSubnets() {
      subList.textContent = '';
      state.subnets.forEach(function (cidr, i) {
        var bDel = h('button', {
          class: 'btn small danger', text: t('delete'),
          onclick: function () { state.subnets.splice(i, 1); renderSubnets(); }
        });
        subList.appendChild(listRow({ mainText: cidr, mainMono: true, right: bDel }));
      });
      var input = h('input', { type: 'text', placeholder: t('route_subnets_add_hint') });
      var bAdd = h('button', {
        class: 'btn small secondary', text: t('add'),
        onclick: function () {
          var v = input.value.trim();
          if (!validCidr(v)) { toast(t('route_subnets_invalid'), 'err'); return; }
          state.subnets.push(v);
          input.value = '';
          renderSubnets();
        }
      });
      subList.appendChild(h('div', { class: 'list-row' },
        h('div', { class: 'main' }, input), bAdd));
    }

    /* --- apply --- */
    var bApply = actionButton({
      label: t('apply'),
      cls: 'block',
      api: function () {
        var uids = state.uids.length ? state.uids.join(',') : '-';
        var subs = state.subnets.length ? state.subnets.join(',') : '-';
        return FOXY.api('routes-set', state.scope, uids, subs);
      },
      onOk: function (res) { toast(t('route_apply_done') + (res.note ? ' (' + res.note + ')' : ''), 'ok'); }
    });
    applyRow.appendChild(bApply);

    FOXY.api('routes-get').then(function (res) {
      if (!alive(page)) return;
      if (!res.ok) { toastErr(t('op_failed'), res); return; }
      state.scope = res.scope || 'all';
      state.uids = res.uids || [];
      state.subnets = res.subnets || [];
      syncScope();
      renderSubnets();
      renderApps('');
    });
  });

  /* ================= Logs ================= */

  registerPage('logs', 'logs_title', function (root) {
    var page = gen();
    var src = 'daemon', lines = 200, follow = true;
    var tabsEl = h('div', { class: 'tabs' });
    var bD = h('button', { class: 'tab active', text: t('logs_daemon') });
    var bS = h('button', { class: 'tab', text: t('logs_service') });
    tabsEl.appendChild(bD); tabsEl.appendChild(bS);

    var ctrl = h('div', { class: 'btn-row' });
    var lineSel = h('select', null,
      h('option', { value: '100', text: '100' }),
      h('option', { value: '200', text: '200', selected: true }),
      h('option', { value: '500', text: '500' }));
    lineSel.addEventListener('change', function () { lines = Number(lineSel.value); load(); });
    var followCb = h('input', { type: 'checkbox', checked: true });
    followCb.addEventListener('change', function () { follow = followCb.checked; });
    ctrl.appendChild(lineSel);
    ctrl.appendChild(h('label', { class: 'setting-row', style: 'border:0;padding:0' },
      h('span', { text: t('logs_follow') }),
      h('span', { class: 'switch' }, followCb, h('span', { class: 'track' }))));

    var logView = h('div', { class: 'log-view' });
    root.appendChild(tabsEl);
    root.appendChild(ctrl);
    root.appendChild(h('div', { class: 'mt' }, logView));

    function syncTabs() {
      bD.className = 'tab' + (src === 'daemon' ? ' active' : '');
      bS.className = 'tab' + (src === 'service' ? ' active' : '');
    }
    bD.addEventListener('click', function () { src = 'daemon'; syncTabs(); load(); });
    bS.addEventListener('click', function () { src = 'service'; syncTabs(); load(); });

    var lastText = null;

    function load() {
      FOXY.api('logs', src, lines).then(function (res) {
        if (!alive(page)) return;
        var text;
        if (!res.ok) text = res.error || t('error');
        else if (!res.lines.length) text = t('logs_empty');
        else text = res.lines.join('\n');
        /* skip the rewrite when nothing changed: clobbering textContent every
         * 3s resets the scroll position while the user is reading */
        if (text === lastText) return;
        lastText = text;
        logView.textContent = text;
        if (follow) logView.scrollTop = logView.scrollHeight;
      });
    }

    load();
    every(3000, load);
  });

  /* ================= Settings ================= */

  registerPage('settings', 'set_title', function (root) {
    var page = gen();
    var genCard = h('div', { class: 'card' });
    var ctxCard = h('div', { class: 'card' });
    var hookCard = h('div', { class: 'card' });
    var bakCard = h('div', { class: 'card' });
    var uiCard = h('div', { class: 'card' });
    root.appendChild(genCard);
    root.appendChild(ctxCard);
    root.appendChild(hookCard);
    root.appendChild(bakCard);
    root.appendChild(uiCard);

    /* --- foxytail.conf form --- */
    genCard.appendChild(h('h2', { text: t('set_general') }));
    var genBody = h('div');
    genCard.appendChild(genBody);
    genBody.appendChild(stateBox(t('loading'), true));

    var BOOL_KEYS = ['MAGIC_DNS', 'IPV6', 'WATCHDOG'];
    var NUM_KEYS = ['SOCKS_PORT', 'DNS_PORT', 'ROUTE_TABLE', 'WATCHDOG_INTERVAL', 'STATS_INTERVAL', 'LOG_MAX_KB'];

    function saveKey(key, value) {
      return FOXY.api('settings-set', key, value).then(function (res) {
        if (res.ok) toast(t('set_saved') + ': ' + key, 'ok');
        else toastErr(t('op_failed'), res);
        return res;
      });
    }

    FOXY.api('settings-get').then(function (res) {
      if (!alive(page)) return;
      genBody.textContent = '';
      if (!res.ok) { genBody.appendChild(stateBox(res.error || t('error'))); return; }
      var keys = Object.keys(res.settings);
      if (!keys.length) { genBody.appendChild(stateBox(t('empty'))); return; }
      keys.forEach(function (key) {
        var val = res.settings[key];
        if (key === 'TS_MODE') {
          genBody.appendChild(h('div', { class: 'setting-row' },
            h('div', null, h('div', { text: key }), h('div', { class: 'desc', text: t('dash_mode') })),
            h('span', { class: 'dim', text: val })));
          return;
        }
        if (BOOL_KEYS.indexOf(key) >= 0) {
          var cb = h('input', { type: 'checkbox', checked: val === 'on' });
          cb.addEventListener('change', function () { saveKey(key, cb.checked ? 'on' : 'off'); });
          genBody.appendChild(h('div', { class: 'setting-row' },
            h('div', { text: key }),
            h('span', { class: 'switch needs-root' }, cb, h('span', { class: 'track' }))));
          return;
        }
        var input = h('input', {
          type: NUM_KEYS.indexOf(key) >= 0 ? 'number' : 'text',
          value: val
        });
        /* dirty-check against a snapshot that advances on each successful
         * save, not the render-time value (which goes stale after a save) */
        var initial = val;
        input.addEventListener('change', function () {
          var v = input.value.trim();
          if (v === initial) return;
          saveKey(key, v).then(function (r2) { if (r2.ok) initial = v; });
        });
        genBody.appendChild(h('div', { class: 'setting-row' },
          h('div', { text: key }), input));
      });
      lockIfNoRoot();
    });

    /* --- context rules editor --- */
    ctxCard.appendChild(h('h2', { text: t('set_context') }));
    ctxCard.appendChild(h('p', { class: 'dim', text: t('set_context_hint') }));
    var ctxTa = h('textarea', { rows: '7' });
    ctxCard.appendChild(h('div', { class: 'mt' }, ctxTa));
    var bCtx = actionButton({
      label: t('save'),
      cls: 'block mt',
      api: function () {
        var b64;
        try { b64 = btoa(unescape(encodeURIComponent(ctxTa.value))); }
        catch (e) { return Promise.resolve({ ok: false, error: t('op_failed') }); }
        return FOXY.api('context-set', b64);
      },
      onOk: function () { toast(t('set_saved'), 'ok'); },
      /* single message for the btoa failure path, not "op_failed: op_failed" */
      onFail: function (res) { toast(res && res.error ? res.error : t('op_failed'), 'err'); }
    });
    ctxCard.appendChild(bCtx);
    FOXY.api('context-get').then(function (res) {
      if (!alive(page)) return;
      if (res.ok) ctxTa.value = res.rules || '';
    });

    /* --- tun hooks (read-only) --- */
    hookCard.appendChild(h('h2', { text: t('set_hooks') }));
    hookCard.appendChild(h('p', { class: 'dim', text: t('set_hooks_hint') }));
    [['foxytail.tun.up', 'set_hook_up'], ['foxytail.tun.down', 'set_hook_down']].forEach(function (pair) {
      var pre = h('pre', { class: 'log-view', text: t('loading') });
      hookCard.appendChild(h('div', { class: 'mt' },
        h('div', { class: 'dim', text: t(pair[1]) }), pre));
      FOXY.exec('cat /data/adb/foxytail/scripts/' + pair[0] + ' 2>/dev/null || echo "(missing)"')
        .then(function (out) {
          if (!alive(page)) return;
          /* the shell side marks a missing hook with "(missing)"; the
           * displayed string goes through the dictionary */
          pre.textContent = out === '(missing)' ? t('misc_missing') : (out || t('misc_empty'));
        },
          function () {
            if (!alive(page)) return;
            pre.textContent = t('misc_unavailable');
          });
    });

    /* --- backup / restore --- */
    bakCard.appendChild(h('h2', { text: t('set_backup') + ' / ' + t('set_restore') }));
    var bBk = actionButton({
      label: t('set_backup'),
      cls: 'block',
      api: function () { return FOXY.api('backup'); },
      onOk: function (res) { toast(t('set_backup_done') + res.path, 'ok'); }
    });
    bakCard.appendChild(bBk);
    var rsIn = h('input', { type: 'text', placeholder: t('set_restore_hint') });
    bakCard.appendChild(h('label', { class: 'field mt' }, rsIn));
    var bRs = h('button', { class: 'btn secondary block needs-root', text: t('set_restore') });
    bRs.addEventListener('click', function () {
      var p = rsIn.value.trim();
      if (!p) return;
      confirmBox(t('set_restore_confirm'), function () {
        FOXY.api('restore', p).then(function (res) {
          if (res.ok) toast(t('set_restore_done') + (res.previous || '') + ')', 'ok');
          else toastErr(t('op_failed'), res);
        });
      });
    });
    bakCard.appendChild(bRs);

    /* --- theme + language --- */
    uiCard.appendChild(h('h2', { text: t('set_ui') }));
    var themeSel = h('select', null,
      h('option', { value: 'dark', text: t('set_theme_dark') }),
      h('option', { value: 'light', text: t('set_theme_light') }),
      h('option', { value: 'auto', text: t('set_theme_auto') }));
    themeSel.value = loadTheme();
    themeSel.addEventListener('change', function () { applyTheme(themeSel.value); });
    uiCard.appendChild(h('div', { class: 'setting-row' },
      h('div', { text: t('set_theme') }), themeSel));
    var langSel = h('select', null,
      h('option', { value: 'zh', text: '中文' }),
      h('option', { value: 'en', text: 'English' }));
    langSel.value = FOXY.lang;
    langSel.addEventListener('change', function () { FOXY.setLang(langSel.value); });
    uiCard.appendChild(h('div', { class: 'setting-row' },
      h('div', { text: t('set_language') }), langSel));
  });

  /* ================= Diagnostics ================= */

  registerPage('diag', 'diag_title', function (root) {
    var page = gen();
    var card = h('div', { class: 'card' });
    root.appendChild(card);
    card.appendChild(h('h2', { text: t('diag_title') }));
    card.appendChild(h('p', { class: 'dim', text: t('diag_hint') }));
    var result = h('div', { class: 'mt' });
    var bRun = actionButton({
      label: t('diag_run'),
      cls: 'block mt',
      api: function () {
        result.textContent = '';
        result.appendChild(stateBox(t('diag_running'), true));
        return FOXY.api('diag');
      },
      onOk: function (res) {
        result.textContent = '';
        result.appendChild(h('div', { class: 'banner ok', text: t('diag_done') }));
        result.appendChild(h('p', { class: 'mono', text: res.path }));
      },
      onFail: function (res) {
        result.textContent = '';
        toastErr(t('op_failed'), res);
      }
    });
    card.appendChild(result);
    card.appendChild(bRun);
  });

  /* ================= More ================= */

  registerPage('more', 'more_title', function (root) {
    var card = h('div', { class: 'card' });
    root.appendChild(card);
    [
      ['tunnel', 'more_tunnel', '⛓'],
      ['routing', 'more_routing', '⑂'],
      ['account', 'more_account', '☻'],
      ['serve', 'more_serve', '⇶'],
      ['files', 'more_files', '▣'],
      ['logs', 'more_logs', '☰'],
      ['settings', 'more_settings', '⚙'],
      ['diag', 'more_diag', '✚']
    ].forEach(function (item) {
      card.appendChild(h('a', {
        class: 'list-row', href: '#/' + item[0],
        style: 'text-decoration:none;color:inherit'
      },
        h('span', { class: 'nav-ico', text: item[2], 'aria-hidden': 'true' }),
        h('div', { class: 'main' }, h('div', { class: 'title', text: t(item[1]) })),
        h('span', { class: 'dim', text: '›' })));
    });
  });
})();
