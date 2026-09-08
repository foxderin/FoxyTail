/*
 * FoxyTail WebUI - application logic.
 *
 * Vanilla ES6, no framework, no build step. Organization:
 *   [0] DOM/format helpers, toast, modal
 *   [1] theme + router + bottom navigation
 *   [2] page: Dashboard
 *   [3] page: Peers (list + canvas topology)
 *   [4] page: Exit Nodes
 *   [5] page: Account
 *   [6] page: Tunnel
 *   [7] page: Routing
 *   [8] page: Traffic (canvas charts)
 *   [9] page: Serve / Funnel
 *   [10] page: Files (Taildrop)
 *   [11] page: Logs
 *   [12] page: Settings
 *   [13] page: Diagnostics
 *   [14] page: More
 *   [15] boot
 *
 * XSS policy: every API-derived string reaches the DOM via textContent
 * (the h() "text" attr) — innerHTML is never used for dynamic data.
 */
(function () {
  'use strict';

  var FOXY = window.FOXY;
  var t = function (k) { return FOXY.t(k); };

  /* ================= [0] helpers ================= */

  /* Minimal hyperscript: h('div', {class:'x', text:'y', onclick:fn}, kids...) */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (k === 'text') el.textContent = v == null ? '' : String(v);
        else if (k === 'class') el.className = v;
        else if (k === 'onclick') el.addEventListener('click', v);
        else if (k === 'onchange') el.addEventListener('change', v);
        else if (k === 'oninput') el.addEventListener('input', v);
        else if (k === 'checked') el.checked = !!v;
        else if (k === 'disabled') el.disabled = !!v;
        else if (k === 'value') el.value = v;
        else if (k === 'placeholder') el.placeholder = v;
        else if (k === 'type') el.type = v;
        else if (k === 'selected') { if (v) el.selected = true; }
        else el.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(x); });
      else el.appendChild(c);
    }
    return el;
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  function fmtUptime(sec) {
    sec = Number(sec) || 0;
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
    return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
  }

  function fmtTime(epochSec) {
    if (!epochSec) return '-';
    var d = new Date(epochSec * 1000);
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function latClass(ms) {
    if (ms == null) return '';
    if (ms < 100) return 'lat-good';
    if (ms <= 300) return 'lat-mid';
    return 'lat-bad';
  }

  function toast(msg, kind) {
    var root = document.getElementById('toast-root');
    var el = h('div', { class: 'toast' + (kind ? ' ' + kind : ''), text: msg });
    root.appendChild(el);
    setTimeout(function () { el.remove(); }, 3200);
  }

  function toastErr(prefix, res) {
    toast(prefix + ': ' + (res && res.error ? res.error : t('op_failed')), 'err');
  }

  /* Bottom-sheet modal. actions: [{label, cls, onClick(close)}] */
  function showModal(title, bodyNodes, actions) {
    var root = document.getElementById('modal-root');
    root.textContent = '';
    function close() { root.textContent = ''; }
    var box = h('div', { class: 'modal' }, h('h3', { text: title }));
    (bodyNodes || []).forEach(function (n) { if (n) box.appendChild(n); });
    if (actions && actions.length) {
      var row = h('div', { class: 'btn-row' });
      actions.forEach(function (a) {
        row.appendChild(h('button', {
          class: 'btn ' + (a.cls || 'secondary'),
          text: a.label,
          onclick: function () { a.onClick ? a.onClick(close) : close(); }
        }));
      });
      box.appendChild(row);
    }
    var mask = h('div', { class: 'modal-mask', onclick: function (e) { if (e.target === mask) close(); } }, box);
    root.appendChild(mask);
    return close;
  }

  function confirmBox(message, onYes) {
    showModal(t('confirm_title'), [h('p', { text: message })], [
      { label: t('cancel') },
      { label: t('confirm'), cls: 'danger', onClick: function (close) { close(); onYes(); } }
    ]);
  }

  /* kv row */
  function kv(k, v) {
    return h('div', { class: 'kv' },
      h('span', { class: 'k', text: k }),
      h('span', { class: 'v', text: v }));
  }

  function stateBox(text, spin) {
    return h('div', { class: 'state-box' },
      spin ? h('span', { class: 'spinner' }) : null,
      h('span', { text: text }));
  }

  function dot(on) { return h('span', { class: 'dot ' + (on ? 'on' : 'off') }); }

  /* ================= [1] theme + router + nav ================= */

  var view = document.getElementById('view');
  var pageTimers = [];

  function every(ms, fn) {
    var id = setInterval(function () { if (!document.hidden) fn(); }, ms);
    pageTimers.push(id);
    return id;
  }

  function clearPageTimers() {
    pageTimers.forEach(clearInterval);
    pageTimers = [];
  }

  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode || 'dark');
    try { localStorage.setItem('foxy.theme', mode || 'dark'); } catch (e) { /* ignore */ }
  }

  function loadTheme() {
    var m = 'dark';
    try { m = localStorage.getItem('foxy.theme') || 'dark'; } catch (e) { /* ignore */ }
    applyTheme(m);
    return m;
  }

  /* Lock down root-only controls after each render. */
  function lockIfNoRoot() {
    if (FOXY.hasRoot) return;
    Array.prototype.forEach.call(view.querySelectorAll('.needs-root'), function (el) {
      el.disabled = true;
    });
  }

  var ROUTES = {};
  function route(name, titleKey, render) { ROUTES[name] = { titleKey: titleKey, render: render }; }

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
        h('span', { class: 'nav-ico', text: item.icon }),
        h('span', { text: t('nav_' + item.name) }));
      nav.appendChild(a);
    });
  }

  function currentPage() {
    var m = /^#\/([a-z-]+)/.exec(location.hash || '');
    return m && ROUTES[m[1]] ? m[1] : 'dashboard';
  }

  function render() {
    clearPageTimers();
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

  /* ================= [2] Dashboard ================= */

  route('dashboard', 'nav_dashboard', function (root) {
    var bannerZone = h('div');
    var statusCard = h('div', { class: 'card' });
    var selfCard = h('div', { class: 'card' });
    var exitCard = h('div', { class: 'card' });
    var ctlCard = h('div', { class: 'card' });

    statusCard.appendChild(stateBox(t('loading'), true));
    root.appendChild(bannerZone);
    root.appendChild(statusCard);
    root.appendChild(ctlCard);
    root.appendChild(selfCard);
    root.appendChild(exitCard);

    function control(action, btn) {
      btn.disabled = true;
      FOXY.api('control', action).then(function (res) {
        btn.disabled = false;
        if (res.ok) { toast(t('dash_action_done'), 'ok'); setTimeout(load, 1500); }
        else toastErr(t('op_failed'), res);
      });
    }

    function renderCtl(data) {
      ctlCard.textContent = '';
      var running = data && data.daemon === 'running';
      var row = h('div', { class: 'btn-row' });
      var bStart = h('button', { class: 'btn needs-root', text: t('dash_start'), disabled: running, onclick: function () { control('start', bStart); } });
      var bStop = h('button', { class: 'btn danger needs-root', text: t('dash_stop'), disabled: !running, onclick: function () { control('stop', bStop); } });
      var bRestart = h('button', { class: 'btn secondary needs-root', text: t('dash_restart'), disabled: !running, onclick: function () { control('restart', bRestart); } });
      row.appendChild(bStart); row.appendChild(bStop); row.appendChild(bRestart);
      ctlCard.appendChild(row);
    }

    function renderStatus(data) {
      statusCard.textContent = '';
      var running = data.daemon === 'running';
      statusCard.appendChild(h('h2', { text: t('dash_daemon') }));
      var row = h('div', { class: 'kv' },
        h('span', { class: 'k' }, dot(running), h('span', { text: running ? t('dash_running') : t('dash_stopped') })),
        h('span', { class: 'v', text: t('dash_backend') + ': ' + (data.backend || '-') }));
      statusCard.appendChild(row);

      /* mode switcher */
      var sel = h('select', { class: 'needs-root' });
      ['bridge', 'tun', 'proxy'].forEach(function (m) {
        sel.appendChild(h('option', { value: m, text: m, selected: data.mode === m }));
      });
      sel.addEventListener('change', function () {
        sel.disabled = true;
        FOXY.api('mode-set', sel.value).then(function (res) {
          if (res.ok) toast(t('dash_mode_switched'), 'ok');
          else { toastErr(t('op_failed'), res); }
          setTimeout(load, 1200);
        });
      });
      statusCard.appendChild(kv(t('dash_mode'), ''));
      statusCard.lastChild.querySelector('.v').textContent = '';
      statusCard.lastChild.querySelector('.v').appendChild(sel);
      statusCard.appendChild(kv(t('dash_uptime'), fmtUptime(data.uptime)));
      statusCard.appendChild(kv(t('dash_peers_online') + ' / ' + t('dash_peers_offline'),
        data.peers ? data.peers.online + ' / ' + data.peers.offline : '-'));
      statusCard.appendChild(kv(t('dash_magicdns'), data.magicDns ? '✓' : '✗'));
    }

    function renderSelf(data) {
      selfCard.textContent = '';
      selfCard.appendChild(h('h2', { text: t('dash_self') }));
      if (!data.self) { selfCard.appendChild(h('div', { class: 'dim', text: '-' })); return; }
      selfCard.appendChild(kv(t('dash_hostname'), data.self.hostname));
      selfCard.appendChild(kv('IP', (data.self.ips || []).join(', ')));
      selfCard.appendChild(kv(t('dash_relay'), data.self.relay));
    }

    function renderExit(data) {
      exitCard.textContent = '';
      exitCard.appendChild(h('h2', { text: t('dash_exitnode') }));
      if (!data.exitNode) {
        exitCard.appendChild(h('div', { class: 'dim', text: t('dash_no_exitnode') }));
        return;
      }
      var en = data.exitNode;
      var title = h('div', { class: 'kv' },
        h('span', { class: 'k' }, dot(en.online), h('span', { text: en.hostname })),
        h('span', { class: 'v mono', text: en.ip }));
      exitCard.appendChild(title);
      exitCard.appendChild(kv(t('dash_traffic'),
        '↓ ' + fmtBytes(en.rx) + '  ↑ ' + fmtBytes(en.tx)));
    }

    function loadBanners() {
      bannerZone.textContent = '';
      FOXY.api('key-expiry').then(function (res) {
        if (res.ok && res.expiring && res.date) {
          bannerZone.appendChild(h('div', { class: 'banner warn', text: t('dash_key_expiring') + res.date }));
        }
      });
      FOXY.api('compat').then(function (res) {
        if (!res.ok) return;
        var warns = [];
        if (Array.isArray(res.warnings)) warns = warns.concat(res.warnings);
        if (res.alert) warns.push(res.alert);
        warns.forEach(function (w) {
          bannerZone.appendChild(h('div', { class: 'banner warn' },
            h('strong', { text: t('dash_compat_warning') + ': ' }),
            h('span', { text: w })));
        });
      });
    }

    function load() {
      FOXY.api('status').then(function (data) {
        if (!data.ok) { statusCard.textContent = ''; statusCard.appendChild(stateBox(data.error || t('error'))); return; }
        renderStatus(data);
        renderCtl(data);
        renderSelf(data);
        renderExit(data);
        lockIfNoRoot();
      });
    }

    loadBanners();
    load();
    every(5000, load);
  });

  /* ================= [3] Peers ================= */

  /* Canvas star topology: Self centered, peers grouped by relay on rings. */
  function drawTopology(canvas, self, peers) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || canvas.parentNode.clientWidth || 320;
    var hgt = Math.max(280, Math.min(420, w));
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    canvas.style.height = hgt + 'px';
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    var styles = getComputedStyle(document.documentElement);
    var cFg = styles.getPropertyValue('--fg').trim() || '#e8e6f0';
    var cDim = styles.getPropertyValue('--fg-dim').trim() || '#a5a2b3';
    var cOk = styles.getPropertyValue('--ok').trim() || '#7fd88f';
    var cOff = styles.getPropertyValue('--fg-faint').trim() || '#6d6a7c';
    var cPri = styles.getPropertyValue('--primary').trim() || '#c3b8ff';

    var cx = w / 2, cy = hgt / 2;
    var radius = Math.min(w, hgt) / 2 - 46;

    /* group peers by relay */
    var groups = {};
    peers.forEach(function (p) {
      var r = p.relay || '-';
      (groups[r] = groups[r] || []).push(p);
    });
    var relays = Object.keys(groups);

    var maxTraffic = 1;
    peers.forEach(function (p) {
      var s = (p.rxBytes || 0) + (p.txBytes || 0);
      if (s > maxTraffic) maxTraffic = s;
    });

    var nodes = []; /* {x,y,peer} hit list */
    ctx.clearRect(0, 0, w, hgt);

    /* edges first */
    var placed = [];
    relays.forEach(function (relay, gi) {
      var list = groups[relay];
      /* each group gets an arc sector */
      var sector = (Math.PI * 2) / relays.length;
      var start = gi * sector - Math.PI / 2;
      list.forEach(function (p, pi) {
        var frac = list.length === 1 ? 0.5 : (pi + 0.5) / list.length;
        var ang = start + frac * sector;
        var ring = radius * (list.length > 3 ? (pi % 2 ? 0.72 : 1) : 1);
        placed.push({ x: cx + Math.cos(ang) * ring, y: cy + Math.sin(ang) * ring, peer: p });
      });
    });

    placed.forEach(function (n) {
      var share = ((n.peer.rxBytes || 0) + (n.peer.txBytes || 0)) / maxTraffic;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(n.x, n.y);
      ctx.lineWidth = 1 + share * 7;
      ctx.strokeStyle = n.peer.online ? cPri : cOff;
      ctx.globalAlpha = n.peer.online ? 0.7 : 0.35;
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    /* peer nodes */
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    placed.forEach(function (n) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = n.peer.online ? cOk : cOff;
      ctx.fill();
      ctx.fillStyle = cDim;
      ctx.fillText(n.peer.hostname || '-', n.x, n.y + 24);
      nodes.push(n);
    });

    /* self node */
    ctx.beginPath();
    ctx.arc(cx, cy, 16, 0, Math.PI * 2);
    ctx.fillStyle = cPri;
    ctx.fill();
    ctx.fillStyle = cFg;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText((self && self.hostname) || 'self', cx, cy + 32);

    return nodes;
  }

  route('peers', 'peers_title', function (root) {
    var tab = 'list';
    var tabsEl = h('div', { class: 'tabs' });
    var body = h('div');
    root.appendChild(tabsEl);
    root.appendChild(body);

    var bList = h('button', { class: 'tab active', text: t('peers_list'), onclick: function () { tab = 'list'; syncTabs(); loadList(); } });
    var bTopo = h('button', { class: 'tab', text: t('peers_topology'), onclick: function () { tab = 'topo'; syncTabs(); loadTopo(); } });
    function syncTabs() {
      bList.className = 'tab' + (tab === 'list' ? ' active' : '');
      bTopo.className = 'tab' + (tab === 'topo' ? ' active' : '');
    }
    tabsEl.appendChild(bList);
    tabsEl.appendChild(bTopo);

    function peerDetail(p) {
      showModal(t('peers_detail'), [
        kv(t('dash_hostname'), p.hostname),
        kv('IP', p.ip),
        kv('OS', p.os),
        kv(t('dash_relay'), p.relay),
        kv(t('peers_rx'), fmtBytes(p.rxBytes)),
        kv(t('peers_tx'), fmtBytes(p.txBytes)),
        kv(t('exit_title'), p.exitNodeOption ? '✓' : '✗')
      ], [{ label: t('close') }]);
    }

    function loadList() {
      body.textContent = '';
      body.appendChild(stateBox(t('loading'), true));
      FOXY.api('peers').then(function (res) {
        body.textContent = '';
        if (!res.ok) { body.appendChild(stateBox(res.error || t('error'))); return; }
        if (!res.peers.length) { body.appendChild(stateBox(t('peers_empty'))); return; }
        var card = h('div', { class: 'card' });
        res.peers.forEach(function (p) {
          card.appendChild(h('div', { class: 'list-row', onclick: function () { peerDetail(p); } },
            dot(p.online),
            h('div', { class: 'main' },
              h('div', { class: 'title', text: p.hostname }),
              h('div', { class: 'sub', text: p.ip + ' · ' + p.os + ' · ' + p.relay })),
            h('div', { class: 'dim', text: '↓' + fmtBytes(p.rxBytes) + ' ↑' + fmtBytes(p.txBytes) })));
        });
        body.appendChild(card);
      });
    }

    function loadTopo() {
      body.textContent = '';
      body.appendChild(stateBox(t('loading'), true));
      Promise.all([FOXY.api('peers'), FOXY.api('status')]).then(function (rs) {
        body.textContent = '';
        var peers = rs[0].ok ? rs[0].peers : [];
        var self = rs[1].ok ? rs[1].self : null;
        if (!peers.length) { body.appendChild(stateBox(t('peers_empty'))); return; }
        var card = h('div', { class: 'card' });
        card.appendChild(h('div', { class: 'dim', text: t('peers_tap_hint') }));
        var canvas = h('canvas', { class: 'topo' });
        card.appendChild(canvas);
        body.appendChild(card);
        var nodes = drawTopology(canvas, self, peers);
        canvas.addEventListener('click', function (e) {
          var rect = canvas.getBoundingClientRect();
          var x = e.clientX - rect.left, y = e.clientY - rect.top;
          for (var i = 0; i < nodes.length; i++) {
            var dx = nodes[i].x - x, dy = nodes[i].y - y;
            if (dx * dx + dy * dy < 22 * 22) { peerDetail(nodes[i].peer); return; }
          }
        });
        var onResize = function () { nodes = drawTopology(canvas, self, peers); };
        window.addEventListener('resize', onResize);
        /* ensure the resize listener dies once this page is gone */
        var guard = setInterval(function () {
          if (!document.body.contains(canvas)) {
            window.removeEventListener('resize', onResize);
            clearInterval(guard);
          }
        }, 2000);
        pageTimers.push(guard);
      });
    }

    loadList();
    every(8000, function () { if (tab === 'list') loadList(); });
  });

  /* ================= [4] Exit Nodes ================= */

  route('exitnodes', 'exit_title', function (root) {
    var listCard = h('div', { class: 'card' });
    var head = h('div', { class: 'btn-row' });
    var bTest = h('button', { class: 'btn needs-root', text: t('exit_test') });
    var bClear = h('button', { class: 'btn secondary needs-root', text: t('exit_clear') });
    head.appendChild(bTest);
    head.appendChild(bClear);
    root.appendChild(listCard);
    root.appendChild(head);
    listCard.appendChild(stateBox(t('loading'), true));

    var currentId = null;

    function useNode(node, btn) {
      btn.disabled = true;
      FOXY.api('exitnode-set', node.ip).then(function (res) {
        if (res.ok) { toast(t('exit_set_done'), 'ok'); currentId = node.id; loadList(); }
        else { toastErr(t('op_failed'), res); btn.disabled = false; }
      });
    }

    function renderRows(peers, latMap) {
      listCard.textContent = '';
      if (!peers.length) { listCard.appendChild(stateBox(t('exit_empty'))); return; }
      peers.forEach(function (p) {
        var lat = latMap ? latMap[p.id] : undefined;
        var right = h('div', { class: 'btn-row', style: 'margin-top:0' });
        var bUse = h('button', {
          class: 'btn small needs-root' + (p.id === currentId ? '' : ' secondary'),
          text: p.id === currentId ? t('exit_current') : t('exit_use'),
          disabled: p.id === currentId,
          onclick: function () { useNode(p, bUse); }
        });
        right.appendChild(bUse);
        var sub = p.ip + ' · ' + p.relay;
        if (lat !== undefined) sub += ' · ';
        var subEl = h('div', { class: 'sub', text: sub });
        if (lat !== undefined) {
          subEl.appendChild(h('span', {
            class: lat === null ? 'dim' : latClass(lat),
            text: lat === null ? '✗' : lat + 'ms'
          }));
        }
        listCard.appendChild(h('div', { class: 'list-row' },
          dot(p.online),
          h('div', { class: 'main' },
            h('div', { class: 'title', text: p.hostname }),
            subEl),
          right));
      });
      lockIfNoRoot();
    }

    function loadList() {
      FOXY.api('exitnodes').then(function (res) {
        if (!res.ok) { listCard.textContent = ''; listCard.appendChild(stateBox(res.error || t('error'))); return; }
        renderRows(res.peers, null);
      });
      FOXY.api('status').then(function (res) {
        if (res.ok && res.exitNode) currentId = res.exitNode.id;
      });
    }

    bTest.addEventListener('click', function () {
      bTest.disabled = true;
      bTest.textContent = t('exit_testing');
      FOXY.api('speedtest-exitnodes').then(function (res) {
        bTest.disabled = false;
        bTest.textContent = t('exit_test');
        if (!res.ok) { toastErr(t('op_failed'), res); return; }
        var latMap = {};
        res.results.forEach(function (r) { latMap[r.id] = r.latencyMs; });
        /* render sorted results */
        renderRows(res.results.map(function (r) {
          return { id: r.id, hostname: r.hostname, ip: r.ip, relay: '-', online: r.ok };
        }), latMap);
      });
    });

    bClear.addEventListener('click', function () {
      bClear.disabled = true;
      FOXY.api('exitnode-clear').then(function (res) {
        bClear.disabled = false;
        if (res.ok) { toast(t('exit_cleared'), 'ok'); currentId = null; loadList(); }
        else toastErr(t('op_failed'), res);
      });
    });

    loadList();
  });

  /* ================= [5] Account ================= */

  route('account', 'acc_title', function (root) {
    var loginCard = h('div', { class: 'card' });
    var keyCard = h('div', { class: 'card' });
    var hsCard = h('div', { class: 'card' });
    var accCard = h('div', { class: 'card' });
    root.appendChild(loginCard);
    root.appendChild(keyCard);
    root.appendChild(hsCard);
    root.appendChild(accCard);

    /* --- login URL flow --- */
    loginCard.appendChild(h('h2', { text: t('acc_login') }));
    var loginBody = h('div');
    var bLogin = h('button', { class: 'btn block needs-root', text: t('acc_login') });
    loginCard.appendChild(loginBody);
    loginCard.appendChild(h('div', { class: 'mt' }, bLogin));

    function showLoginUrl(url) {
      loginBody.textContent = '';
      loginBody.appendChild(h('p', { class: 'dim', text: t('acc_login_url_hint') }));
      loginBody.appendChild(h('p', { class: 'mono mt', text: url }));
      var row = h('div', { class: 'btn-row' });
      row.appendChild(h('button', {
        class: 'btn secondary', text: t('copy'),
        onclick: function () {
          var ta = h('textarea', { text: url });
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); toast(t('copied'), 'ok'); }
          catch (e) { toast(t('op_failed'), 'err'); }
          ta.remove();
        }
      }));
      row.appendChild(h('button', {
        class: 'btn secondary', text: t('open_browser'),
        onclick: function () { window.open(url, '_blank'); }
      }));
      loginBody.appendChild(row);
    }

    function doLogin(extraArgs) {
      bLogin.disabled = true;
      loginBody.textContent = '';
      loginBody.appendChild(stateBox(t('acc_waiting'), true));
      var args = ['login'].concat(extraArgs || []);
      FOXY.api.apply(null, args).then(function (res) {
        bLogin.disabled = false;
        if (res.ok && res.url) showLoginUrl(res.url);
        else if (res.ok && res.already) {
          loginBody.textContent = '';
          loginBody.appendChild(h('div', { class: 'banner ok', text: t('acc_already') }));
        } else {
          loginBody.textContent = '';
          toastErr(t('op_failed'), res);
        }
        lockIfNoRoot();
      });
    }
    bLogin.addEventListener('click', function () { doLogin(); });

    /* --- authkey --- */
    keyCard.appendChild(h('h2', { text: t('acc_authkey') }));
    var keyInput = h('input', { type: 'password', placeholder: t('acc_authkey_hint') });
    keyCard.appendChild(h('label', { class: 'field' }, keyInput));
    var bKey = h('button', { class: 'btn block needs-root', text: t('acc_login_authkey') });
    bKey.addEventListener('click', function () {
      var k = keyInput.value.trim();
      if (!k) return;
      bKey.disabled = true;
      FOXY.api('login-authkey', k).then(function (res) {
        bKey.disabled = false;
        if (res.ok) { toast(t('acc_logged_in'), 'ok'); keyInput.value = ''; loadAccounts(); }
        else toastErr(t('op_failed'), res);
      });
    });
    keyCard.appendChild(bKey);

    /* --- headscale --- */
    hsCard.appendChild(h('h2', { text: t('acc_headscale') }));
    var hsInput = h('input', { type: 'text', placeholder: t('acc_headscale_hint') });
    hsCard.appendChild(h('label', { class: 'field' }, hsInput));
    var bHs = h('button', { class: 'btn block needs-root', text: t('acc_login_server') });
    bHs.addEventListener('click', function () {
      var u = hsInput.value.trim();
      if (!/^https?:\/\//.test(u)) { toast(t('acc_headscale_hint'), 'err'); return; }
      doLogin(['--login-server=' + u]);
      /* scroll back to login card so the URL is visible */
      loginCard.scrollIntoView({ behavior: 'smooth' });
    });
    hsCard.appendChild(bHs);

    /* --- accounts + logout --- */
    function loadAccounts() {
      accCard.textContent = '';
      accCard.appendChild(h('h2', { text: t('acc_accounts') }));
      accCard.appendChild(stateBox(t('loading'), true));
      FOXY.api('accounts').then(function (res) {
        accCard.textContent = '';
        accCard.appendChild(h('h2', { text: t('acc_accounts') }));
        if (!res.ok) { accCard.appendChild(h('div', { class: 'dim', text: t('acc_not_logged_in') })); return; }
        res.accounts.forEach(function (a) {
          var bSw = h('button', {
            class: 'btn small secondary needs-root', text: t('acc_switch'),
            disabled: a.current,
            onclick: function () {
              bSw.disabled = true;
              FOXY.api('switch', a.name).then(function (r2) {
                if (r2.ok) { toast(t('acc_switched'), 'ok'); loadAccounts(); }
                else { toastErr(t('op_failed'), r2); bSw.disabled = false; }
              });
            }
          });
          accCard.appendChild(h('div', { class: 'list-row' },
            h('div', { class: 'main' },
              h('span', { class: 'title', text: a.name }),
              a.current ? h('span', { class: 'badge', text: t('acc_current_badge') }) : null),
            bSw));
        });
        var bOut = h('button', { class: 'btn danger block mt needs-root', text: t('acc_logout') });
        bOut.addEventListener('click', function () {
          confirmBox(t('acc_logout_confirm'), function () {
            FOXY.api('logout').then(function (r2) {
              if (r2.ok) { toast(t('acc_logged_out'), 'ok'); loadAccounts(); }
              else toastErr(t('op_failed'), r2);
            });
          });
        });
        accCard.appendChild(bOut);
        lockIfNoRoot();
      });
    }
    loadAccounts();
  });

  /* ================= [6] Tunnel ================= */

  route('tunnel', 'tun_title', function (root) {
    var ifaceCard = h('div', { class: 'card' });
    var socksCard = h('div', { class: 'card' });
    var derpCard = h('div', { class: 'card' });
    root.appendChild(ifaceCard);
    root.appendChild(socksCard);
    root.appendChild(derpCard);

    ifaceCard.appendChild(stateBox(t('loading'), true));

    var socksPort = 1099;

    function loadTun() {
      FOXY.api('tun').then(function (res) {
        ifaceCard.textContent = '';
        ifaceCard.appendChild(h('h2', { text: t('tun_iface') }));
        if (!res.ok) { ifaceCard.appendChild(stateBox(res.error || t('error'))); return; }
        socksPort = res.socksPort || 1099;
        ifaceCard.appendChild(h('div', { class: 'kv' },
          h('span', { class: 'k' }, dot(res.ifaceUp), h('span', { text: res.ifaceUp ? t('tun_up') : t('tun_down') })),
          h('span', { class: 'v', text: t('dash_mode') + ': ' + res.mode })));
        ifaceCard.appendChild(kv(t('tun_gateway'), res.gateway || '-'));
        ifaceCard.appendChild(kv(t('tun_hev'),
          res.hevPid ? t('tun_pid') + ': ' + res.hevPid : t('tun_not_running')));
      });
    }

    /* socks5 self check via curl through the local proxy */
    socksCard.appendChild(h('h2', { text: t('tun_socks_check') }));
    var socksResult = h('div', { class: 'dim', text: '-' });
    var bSocks = h('button', { class: 'btn block mt needs-root', text: t('tun_socks_check') });
    bSocks.addEventListener('click', function () {
      bSocks.disabled = true;
      socksResult.textContent = t('tun_socks_checking');
      var started = Date.now();
      FOXY.exec('curl -x 127.0.0.1:' + socksPort + ' -sI --max-time 10 -o /dev/null -w "%{http_code}" https://1.1.1.1')
        .then(function (out) {
          var ms = Date.now() - started;
          var code = String(out).trim();
          var okc = /^[23]/.test(code) || code === '301' || code === '302' || code.length === 3;
          socksResult.textContent = (okc ? t('tun_socks_ok') : t('tun_socks_fail')) +
            ' · HTTP ' + (code || '???') + ' · ' + ms + 'ms';
          socksResult.className = okc ? 'lat-good' : 'lat-bad';
          bSocks.disabled = false;
        }, function (err) {
          socksResult.textContent = t('tun_socks_fail') + ': ' + err;
          socksResult.className = 'lat-bad';
          bSocks.disabled = false;
        });
    });
    socksCard.appendChild(socksResult);
    socksCard.appendChild(bSocks);

    /* DERP relay speed test */
    derpCard.appendChild(h('h2', { text: t('tun_derp') }));
    var derpBody = h('div');
    var bDerp = h('button', { class: 'btn block mt needs-root', text: t('tun_derp') });
    bDerp.addEventListener('click', function () {
      bDerp.disabled = true;
      bDerp.textContent = t('tun_derp_testing');
      FOXY.api('derp-speedtest').then(function (res) {
        bDerp.disabled = false;
        bDerp.textContent = t('tun_derp');
        derpBody.textContent = '';
        if (!res.ok) { toastErr(t('op_failed'), res); return; }
        res.relays.forEach(function (r) {
          derpBody.appendChild(h('div', { class: 'list-row' },
            h('div', { class: 'main' },
              h('span', { class: 'title mono', text: r.code }),
              r.code === res.preferred ? h('span', { class: 'badge', text: t('tun_preferred') }) : null),
            h('span', { class: latClass(r.latencyMs), text: r.latencyMs + 'ms' })));
        });
      });
    });
    derpCard.appendChild(derpBody);
    derpCard.appendChild(bDerp);

    loadTun();
    every(6000, loadTun);
  });

  /* ================= [7] Routing ================= */

  route('routing', 'route_title', function (root) {
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
            h('div', { class: 'sub', text: a.package + ' · uid ' + a.uid }))));
      });
    }
    search.addEventListener('input', function () { renderApps(search.value); });

    FOXY.api('apps').then(function (res) {
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
        subList.appendChild(h('div', { class: 'list-row' },
          h('div', { class: 'main mono', text: cidr }), bDel));
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
    var bApply = h('button', { class: 'btn block needs-root', text: t('apply') });
    bApply.addEventListener('click', function () {
      bApply.disabled = true;
      var uids = state.uids.length ? state.uids.join(',') : '-';
      var subs = state.subnets.length ? state.subnets.join(',') : '-';
      FOXY.api('routes-set', state.scope, uids, subs).then(function (res) {
        bApply.disabled = false;
        if (res.ok) toast(t('route_apply_done') + (res.note ? ' (' + res.note + ')' : ''), 'ok');
        else toastErr(t('op_failed'), res);
      });
    });
    applyRow.appendChild(bApply);

    FOXY.api('routes-get').then(function (res) {
      if (!res.ok) { toastErr(t('op_failed'), res); return; }
      state.scope = res.scope || 'all';
      state.uids = res.uids || [];
      state.subnets = res.subnets || [];
      syncScope();
      renderSubnets();
      renderApps('');
    });
  });

  /* ================= [8] Traffic ================= */

  /* Line chart with axis, grid, gradient fill and touch tooltip. */
  function drawLineChart(canvas, labels, series) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || canvas.parentNode.clientWidth || 320;
    var hgt = 220;
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    canvas.style.height = hgt + 'px';
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    var styles = getComputedStyle(document.documentElement);
    var cFg = styles.getPropertyValue('--fg').trim() || '#e8e6f0';
    var cDim = styles.getPropertyValue('--fg-faint').trim() || '#6d6a7c';
    var cLine = styles.getPropertyValue('--line').trim() || '#33333f';

    var padL = 46, padR = 10, padT = 12, padB = 26;
    var iw = w - padL - padR, ih = hgt - padT - padB;
    var n = labels.length;

    var maxV = 1;
    series.forEach(function (s) { s.values.forEach(function (v) { if (v > maxV) maxV = v; }); });

    function xAt(i) { return padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw); }
    function yAt(v) { return padT + ih - (v / maxV) * ih; }

    function paint(hoverIdx) {
      ctx.clearRect(0, 0, w, hgt);
      ctx.font = '10px system-ui, sans-serif';
      /* grid + y labels */
      ctx.strokeStyle = cLine;
      ctx.fillStyle = cDim;
      ctx.textAlign = 'right';
      for (var g = 0; g <= 4; g++) {
        var v = (maxV / 4) * g;
        var y = yAt(v);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y);
        ctx.globalAlpha = 0.4; ctx.stroke(); ctx.globalAlpha = 1;
        ctx.fillText(fmtBytes(v), padL - 6, y + 3);
      }
      /* x labels (sparse) */
      ctx.textAlign = 'center';
      var step = Math.ceil(n / 6);
      for (var i = 0; i < n; i += step) {
        ctx.fillText(String(labels[i]), xAt(i), hgt - 8);
      }
      /* series */
      series.forEach(function (s) {
        /* gradient fill */
        var grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
        grad.addColorStop(0, s.color + '55');
        grad.addColorStop(1, s.color + '00');
        ctx.beginPath();
        ctx.moveTo(xAt(0), yAt(s.values[0]));
        for (var j = 1; j < n; j++) ctx.lineTo(xAt(j), yAt(s.values[j]));
        ctx.lineTo(xAt(n - 1), padT + ih);
        ctx.lineTo(xAt(0), padT + ih);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        /* line */
        ctx.beginPath();
        ctx.moveTo(xAt(0), yAt(s.values[0]));
        for (var j2 = 1; j2 < n; j2++) ctx.lineTo(xAt(j2), yAt(s.values[j2]));
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.stroke();
      });
      /* tooltip */
      if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < n) {
        var hx = xAt(hoverIdx);
        ctx.strokeStyle = cFg;
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + ih); ctx.stroke();
        ctx.globalAlpha = 1;
        var txt = String(labels[hoverIdx]);
        series.forEach(function (s) { txt += '  ' + s.name + ' ' + fmtBytes(s.values[hoverIdx]); });
        ctx.textAlign = 'center';
        ctx.fillStyle = cFg;
        ctx.fillText(txt, Math.min(Math.max(hx, 90), w - 90), padT + 2);
      }
    }
    paint(null);

    function onTouch(e) {
      var rect = canvas.getBoundingClientRect();
      var px = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      var idx = Math.round(((px - padL) / iw) * (n - 1));
      paint(Math.max(0, Math.min(n - 1, idx)));
    }
    canvas.addEventListener('pointermove', onTouch);
    canvas.addEventListener('touchstart', onTouch, { passive: true });
    canvas.addEventListener('touchmove', onTouch, { passive: true });
  }

  route('traffic', 'traffic_title', function (root) {
    var tabsEl = h('div', { class: 'tabs' });
    var bH = h('button', { class: 'tab active', text: t('traffic_hourly') });
    var bD = h('button', { class: 'tab', text: t('traffic_daily') });
    tabsEl.appendChild(bH); tabsEl.appendChild(bD);
    var chartCard = h('div', { class: 'card' });
    var topCard = h('div', { class: 'card' });
    var uidCard = h('div', { class: 'card' });
    root.appendChild(tabsEl);
    root.appendChild(chartCard);
    root.appendChild(topCard);
    root.appendChild(uidCard);

    var mode = 'hourly';
    function syncTabs() {
      bH.className = 'tab' + (mode === 'hourly' ? ' active' : '');
      bD.className = 'tab' + (mode === 'daily' ? ' active' : '');
    }
    bH.addEventListener('click', function () { mode = 'hourly'; syncTabs(); loadChart(); });
    bD.addEventListener('click', function () { mode = 'daily'; syncTabs(); loadChart(); });

    var styles = getComputedStyle(document.documentElement);
    var cRx = styles.getPropertyValue('--primary').trim() || '#c3b8ff';
    var cTx = styles.getPropertyValue('--accent').trim() || '#8fd0c3';

    function loadChart() {
      chartCard.textContent = '';
      chartCard.appendChild(stateBox(t('loading'), true));
      FOXY.api('traffic', mode).then(function (res) {
        chartCard.textContent = '';
        if (!res.ok) { chartCard.appendChild(stateBox(res.error || t('error'))); return; }
        var labels = [], rx = [], tx = [];
        if (mode === 'hourly') {
          (res.hours || []).forEach(function (hh) {
            labels.push(hh.hour + ':00');
            rx.push(hh.iface ? hh.iface.rx : 0);
            tx.push(hh.iface ? hh.iface.tx : 0);
          });
        } else {
          (res.days || []).forEach(function (d) {
            labels.push(d.date.slice(5));
            rx.push(d.rx); tx.push(d.tx);
          });
        }
        if (!labels.length || (rx.every(function (v) { return !v; }) && tx.every(function (v) { return !v; }))) {
          chartCard.appendChild(stateBox(t('traffic_no_data')));
          return;
        }
        chartCard.appendChild(h('div', { class: 'dim', text: t('traffic_touch_hint') }));
        var canvas = h('canvas', { class: 'chart' });
        chartCard.appendChild(canvas);
        requestAnimationFrame(function () {
          drawLineChart(canvas, labels, [
            { name: t('traffic_rx'), color: cRx, values: rx },
            { name: t('traffic_tx'), color: cTx, values: tx }
          ]);
        });
      });
    }

    /* Top-N peers bar chart (hostnames resolved from peers list) */
    topCard.appendChild(h('h2', { text: t('traffic_topn') }));
    var topBody = h('div');
    topCard.appendChild(topBody);
    topBody.appendChild(stateBox(t('loading'), true));
    Promise.all([FOXY.api('traffic', 'topn', 10), FOXY.api('peers')]).then(function (rs) {
      topBody.textContent = '';
      var res = rs[0];
      var names = {};
      if (rs[1].ok) rs[1].peers.forEach(function (p) { names[p.id] = p.hostname; });
      if (!res.ok || !res.topn || !res.topn.length) { topBody.appendChild(stateBox(t('traffic_no_data'))); return; }
      var max = 1;
      res.topn.forEach(function (r) { if (r.rx + r.tx > max) max = r.rx + r.tx; });
      res.topn.forEach(function (r) {
        var pct = Math.max(2, ((r.rx + r.tx) / max) * 100);
        topBody.appendChild(h('div', { class: 'bar-row' },
          h('span', { class: 'bar-label', text: names[r.id] || r.id }),
          h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: 'width:' + pct + '%' })),
          h('span', { class: 'bar-val', text: '↓' + fmtBytes(r.rx) })));
      });
    });

    /* per-App (UID) totals joined with the app list */
    uidCard.appendChild(h('h2', { text: t('traffic_by_app') }));
    var uidBody = h('div');
    uidCard.appendChild(uidBody);
    uidBody.appendChild(stateBox(t('loading'), true));
    Promise.all([FOXY.api('traffic-uids'), FOXY.api('apps')]).then(function (rs) {
      uidBody.textContent = '';
      var res = rs[0];
      var labels = {};
      if (rs[1].ok) rs[1].apps.forEach(function (a) { labels[String(a.uid)] = a.label; });
      if (!res.ok || !res.uids || !res.uids.length) { uidBody.appendChild(stateBox(t('traffic_no_data'))); return; }
      res.uids.slice(0, 50).forEach(function (u) {
        uidBody.appendChild(h('div', { class: 'list-row' },
          h('div', { class: 'main' },
            h('div', { class: 'title', text: labels[String(u.uid)] || ('uid ' + u.uid) }),
            h('div', { class: 'sub', text: 'uid ' + u.uid })),
          h('span', { class: 'dim', text: fmtBytes(u.rx) })));
      });
    });

    loadChart();
  });

  /* ================= [9] Serve / Funnel ================= */

  route('serve', 'serve_title', function (root) {
    var serveCard = h('div', { class: 'card' });
    var funnelCard = h('div', { class: 'card' });
    var formCard = h('div', { class: 'card' });
    root.appendChild(serveCard);
    root.appendChild(funnelCard);
    root.appendChild(formCard);

    /* Flatten `serve status --json` into [{proto,port,target}] best effort. */
    function flatten(status) {
      var out = [];
      if (!status || typeof status !== 'object') return out;
      if (status.TCP && typeof status.TCP === 'object') {
        Object.keys(status.TCP).forEach(function (port) {
          out.push({ proto: 'tcp', port: port, target: '' });
        });
      }
      if (status.Web && typeof status.Web === 'object') {
        Object.keys(status.Web).forEach(function (hp) {
          var port = (hp.match(/:(\d+)$/) || [])[1] || '443';
          var handlers = status.Web[hp] && status.Web[hp].Handlers;
          var target = '';
          if (handlers) {
            Object.keys(handlers).forEach(function (path) {
              var hd = handlers[path] || {};
              target = hd.Proxy || hd.Path || hd.Text || '';
              if (target) target = path + ' → ' + target;
            });
          }
          out.push({ proto: hp.indexOf(':443') >= 0 ? 'https' : 'http', port: port, target: target });
        });
      }
      return out;
    }

    function renderSection(card, kind, titleKey) {
      card.textContent = '';
      card.appendChild(h('h2', { text: t(titleKey) }));
      FOXY.api(kind + '-list').then(function (res) {
        if (!res.ok) {
          card.appendChild(h('div', { class: 'dim', text: t('serve_unavailable') }));
          return;
        }
        var rows = flatten(res.status);
        if (!rows.length) { card.appendChild(h('div', { class: 'dim', text: t('serve_empty') })); return; }
        rows.forEach(function (r) {
          var bDel = h('button', {
            class: 'btn small danger needs-root', text: t('delete'),
            onclick: function () {
              confirmBox(t('serve_del_confirm'), function () {
                FOXY.api(kind + '-del', r.proto, r.port).then(function (r2) {
                  if (r2.ok) { renderSection(card, kind, titleKey); }
                  else toastErr(t('op_failed'), r2);
                });
              });
            }
          });
          card.appendChild(h('div', { class: 'list-row' },
            h('div', { class: 'main' },
              h('div', { class: 'title mono', text: r.proto + ' :' + r.port }),
              r.target ? h('div', { class: 'sub mono', text: r.target }) : null),
            bDel));
        });
        lockIfNoRoot();
      });
    }

    /* add form */
    formCard.appendChild(h('h2', { text: t('serve_add') }));
    var kindSel = h('select', null,
      h('option', { value: 'serve', text: 'serve', selected: true }),
      h('option', { value: 'funnel', text: 'funnel' }));
    var protoSel = h('select', null,
      h('option', { value: 'https', text: 'https', selected: true }),
      h('option', { value: 'http', text: 'http' }),
      h('option', { value: 'tcp', text: 'tcp' }),
      h('option', { value: 'tls-terminated-tcp', text: 'tls-terminated-tcp' }));
    var portIn = h('input', { type: 'number', placeholder: '443' });
    var targetIn = h('input', { type: 'text', placeholder: t('serve_target') });
    formCard.appendChild(h('label', { class: 'field' }, h('span', { class: 'label', text: 'kind' }), kindSel));
    formCard.appendChild(h('label', { class: 'field' }, h('span', { class: 'label', text: t('serve_proto') }), protoSel));
    formCard.appendChild(h('label', { class: 'field' }, h('span', { class: 'label', text: t('serve_port') }), portIn));
    formCard.appendChild(h('label', { class: 'field' }, h('span', { class: 'label', text: t('serve_target') }), targetIn));
    var bAdd = h('button', { class: 'btn block needs-root', text: t('serve_add') });
    bAdd.addEventListener('click', function () {
      var port = portIn.value.trim();
      var target = targetIn.value.trim();
      if (!port || !target) return;
      bAdd.disabled = true;
      FOXY.api(kindSel.value + '-set', protoSel.value, port, target).then(function (res) {
        bAdd.disabled = false;
        if (res.ok) {
          targetIn.value = '';
          renderSection(serveCard, 'serve', 'serve_serve');
          renderSection(funnelCard, 'funnel', 'serve_funnel');
        } else toastErr(t('op_failed'), res);
      });
    });
    formCard.appendChild(bAdd);

    renderSection(serveCard, 'serve', 'serve_serve');
    renderSection(funnelCard, 'funnel', 'serve_funnel');
  });

  /* ================= [10] Files ================= */

  route('files', 'files_title', function (root) {
    var inboxCard = h('div', { class: 'card' });
    var sendCard = h('div', { class: 'card' });
    root.appendChild(inboxCard);
    root.appendChild(sendCard);

    function loadInbox() {
      inboxCard.textContent = '';
      inboxCard.appendChild(h('h2', { text: t('files_inbox') }));
      var body = h('div');
      inboxCard.appendChild(body);
      body.appendChild(stateBox(t('loading'), true));
      FOXY.api('files-inbox').then(function (res) {
        body.textContent = '';
        if (!res.ok) { body.appendChild(stateBox(res.error || t('error'))); return; }
        if (!res.files.length) { body.appendChild(stateBox(t('files_empty'))); return; }
        res.files.forEach(function (f) {
          body.appendChild(h('div', { class: 'list-row' },
            h('div', { class: 'main' },
              h('div', { class: 'title mono', text: f.name }),
              h('div', { class: 'sub', text: fmtBytes(f.size) + ' · ' + fmtTime(f.mtime) }))));
        });
      });
      var bRecv = h('button', { class: 'btn secondary block mt needs-root', text: t('files_receive') });
      bRecv.addEventListener('click', function () {
        bRecv.disabled = true;
        FOXY.api('file-receive').then(function (res) {
          bRecv.disabled = false;
          if (res.ok) { toast(t('files_received'), 'ok'); loadInbox(); }
          else toastErr(t('op_failed'), res);
        });
      });
      inboxCard.appendChild(bRecv);
      lockIfNoRoot();
    }

    sendCard.appendChild(h('h2', { text: t('files_send') }));
    var pathIn = h('input', { type: 'text', placeholder: t('files_path_hint') });
    sendCard.appendChild(h('label', { class: 'field' },
      h('span', { class: 'label', text: t('files_path') }), pathIn));
    var peerSel = h('select');
    sendCard.appendChild(h('label', { class: 'field' },
      h('span', { class: 'label', text: t('files_peer') }), peerSel));
    var bSend = h('button', { class: 'btn block needs-root', text: t('files_send_btn') });
    bSend.addEventListener('click', function () {
      var p = pathIn.value.trim();
      var peer = peerSel.value;
      if (!p || !peer) return;
      bSend.disabled = true;
      FOXY.api('file-send', p, peer).then(function (res) {
        bSend.disabled = false;
        if (res.ok) toast(t('files_sent'), 'ok');
        else toastErr(t('op_failed'), res);
      });
    });
    sendCard.appendChild(bSend);

    FOXY.api('peers').then(function (res) {
      if (!res.ok) return;
      res.peers.forEach(function (p) {
        peerSel.appendChild(h('option', { value: p.hostname, text: p.hostname + (p.online ? '' : ' (' + t('offline') + ')') }));
      });
    });

    loadInbox();
  });

  /* ================= [11] Logs ================= */

  route('logs', 'logs_title', function (root) {
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

    function load() {
      FOXY.api('logs', src, lines).then(function (res) {
        if (!res.ok) { logView.textContent = res.error || t('error'); return; }
        if (!res.lines.length) { logView.textContent = t('logs_empty'); return; }
        logView.textContent = res.lines.join('\n');
        if (follow) logView.scrollTop = logView.scrollHeight;
      });
    }

    load();
    every(3000, load);
  });

  /* ================= [12] Settings ================= */

  route('settings', 'set_title', function (root) {
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
        input.addEventListener('change', function () {
          if (input.value !== val) saveKey(key, input.value.trim());
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
    var bCtx = h('button', { class: 'btn block mt needs-root', text: t('save') });
    bCtx.addEventListener('click', function () {
      bCtx.disabled = true;
      var b64;
      try { b64 = btoa(unescape(encodeURIComponent(ctxTa.value))); }
      catch (e) { toast(t('op_failed'), 'err'); bCtx.disabled = false; return; }
      FOXY.api('context-set', b64).then(function (res) {
        bCtx.disabled = false;
        if (res.ok) toast(t('set_saved'), 'ok');
        else toastErr(t('op_failed'), res);
      });
    });
    ctxCard.appendChild(bCtx);
    FOXY.api('context-get').then(function (res) {
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
        .then(function (out) { pre.textContent = out || '(empty)'; },
          function () { pre.textContent = '(unavailable)'; });
    });

    /* --- backup / restore --- */
    bakCard.appendChild(h('h2', { text: t('set_backup') + ' / ' + t('set_restore') }));
    var bBk = h('button', { class: 'btn block needs-root', text: t('set_backup') });
    bBk.addEventListener('click', function () {
      bBk.disabled = true;
      FOXY.api('backup').then(function (res) {
        bBk.disabled = false;
        if (res.ok) toast(t('set_backup_done') + res.path, 'ok');
        else toastErr(t('op_failed'), res);
      });
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
    uiCard.appendChild(h('h2', { text: 'UI' }));
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

  /* ================= [13] Diagnostics ================= */

  route('diag', 'diag_title', function (root) {
    var card = h('div', { class: 'card' });
    root.appendChild(card);
    card.appendChild(h('h2', { text: t('diag_title') }));
    card.appendChild(h('p', { class: 'dim', text: t('diag_hint') }));
    var result = h('div', { class: 'mt' });
    var bRun = h('button', { class: 'btn block mt needs-root', text: t('diag_run') });
    bRun.addEventListener('click', function () {
      bRun.disabled = true;
      result.textContent = '';
      result.appendChild(stateBox(t('diag_running'), true));
      FOXY.api('diag').then(function (res) {
        bRun.disabled = false;
        result.textContent = '';
        if (res.ok) {
          result.appendChild(h('div', { class: 'banner ok', text: t('diag_done') }));
          result.appendChild(h('p', { class: 'mono', text: res.path }));
        } else toastErr(t('op_failed'), res);
      });
    });
    card.appendChild(result);
    card.appendChild(bRun);
  });

  /* ================= [14] More ================= */

  route('more', 'more_title', function (root) {
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
        h('span', { class: 'nav-ico', text: item[2] }),
        h('div', { class: 'main' }, h('div', { class: 'title', text: t(item[1]) })),
        h('span', { class: 'dim', text: '›' })));
    });
  });

  /* ================= [15] boot ================= */

  loadTheme();
  FOXY.initBridge();
  if (!location.hash) location.hash = '#/dashboard';
  render();
})();
