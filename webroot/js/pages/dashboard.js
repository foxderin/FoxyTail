/*
 * FoxyTail WebUI - pages: Dashboard, Exit Nodes.
 */
(function () {
  'use strict';

  var FOXY = window.FOXY;
  var t = function (k) { return FOXY.t(k); };
  var h = FOXY.dom.h;
  var kv = FOXY.dom.kv;
  var stateBox = FOXY.dom.stateBox;
  var dot = FOXY.dom.dot;
  var fmtBytes = FOXY.dom.fmtBytes;
  var fmtUptime = FOXY.dom.fmtUptime;
  var latClass = FOXY.dom.latClass;
  var toast = FOXY.ui.toast;
  var toastErr = FOXY.ui.toastErr;
  var actionButton = FOXY.ui.actionButton;
  var registerPage = FOXY.router.registerPage;
  var every = FOXY.router.every;
  var later = FOXY.router.later;
  var gen = FOXY.router.gen;
  var alive = FOXY.router.alive;
  var lockIfNoRoot = FOXY.router.lockIfNoRoot;

  /* ================= Dashboard ================= */

  registerPage('dashboard', 'nav_dashboard', function (root) {
    var page = gen();
    var bannerZone = h('div', { 'aria-live': 'polite' });
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

    /* The 5s poll rebuilds these cards; if the user is interacting with a
     * control inside one (a focused/open select or button), replacing the
     * DOM would silently drop that interaction — skip this cycle instead. */
    function busy(card) {
      var ae = document.activeElement;
      return !!(ae && ae !== document.body && card.contains(ae));
    }

    function renderCtl(data) {
      ctlCard.textContent = '';
      var running = data && data.daemon === 'running';
      function mkCtl(action, label, cls) {
        return actionButton({
          label: label,
          cls: cls,
          api: function () { return FOXY.api('control', action); },
          onOk: function () { toast(t('dash_action_done'), 'ok'); later(1500, load); }
        });
      }
      var bStart = mkCtl('start', t('dash_start'));
      var bStop = mkCtl('stop', t('dash_stop'), 'danger');
      var bRestart = mkCtl('restart', t('dash_restart'), 'secondary');
      bStart.disabled = running;
      bStop.disabled = !running;
      bRestart.disabled = !running;
      var row = h('div', { class: 'btn-row' });
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
          later(1200, load);
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
        if (!alive(page)) return;
        if (res.ok && res.expiring && res.date) {
          bannerZone.appendChild(h('div', { class: 'banner warn', text: t('dash_key_expiring') + res.date }));
        }
      });
      FOXY.api('compat').then(function (res) {
        if (!alive(page)) return;
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
        if (!alive(page)) return;
        if (!data.ok) { statusCard.textContent = ''; statusCard.appendChild(stateBox(data.error || t('error'))); return; }
        if (!busy(statusCard)) renderStatus(data);
        if (!busy(ctlCard)) renderCtl(data);
        if (!busy(selfCard)) renderSelf(data);
        if (!busy(exitCard)) renderExit(data);
        lockIfNoRoot();
      });
    }

    loadBanners();
    load();
    every(5000, load);
  });

  /* ================= Exit Nodes ================= */

  registerPage('exitnodes', 'exit_title', function (root) {
    var page = gen();
    var listCard = h('div', { class: 'card' });
    var head = h('div', { class: 'btn-row' });
    root.appendChild(listCard);
    root.appendChild(head);
    listCard.appendChild(stateBox(t('loading'), true));

    var currentId = null;
    var lastPeers = null;
    var lastLat = null;

    function useNode(node) {
      return FOXY.api('exitnode-set', node.ip);
    }

    function renderRows(peers, latMap) {
      lastPeers = peers;
      lastLat = latMap;
      listCard.textContent = '';
      if (!peers.length) { listCard.appendChild(stateBox(t('exit_empty'))); return; }
      peers.forEach(function (p) {
        var lat = latMap ? latMap[p.id] : undefined;
        var bUse = actionButton({
          label: p.id === currentId ? t('exit_current') : t('exit_use'),
          cls: 'small' + (p.id === currentId ? '' : ' secondary'),
          api: function () { return useNode(p); },
          onOk: function () { toast(t('exit_set_done'), 'ok'); currentId = p.id; loadList(); }
        });
        bUse.disabled = p.id === currentId;
        var right = h('div', { class: 'btn-row', style: 'margin-top:0' }, bUse);
        var sub = p.ip + ' · ' + p.relay;
        if (lat !== undefined) sub += ' · ';
        var subEl = h('div', { class: 'sub', text: sub });
        if (lat !== undefined) {
          subEl.appendChild(h('span', {
            class: lat === null ? 'dim' : latClass(lat),
            text: lat === null ? '✗' : lat + 'ms'
          }));
        }
        listCard.appendChild(FOXY.ui.listRow({
          dot: p.online,
          title: p.hostname,
          subNode: subEl,
          right: right
        }));
      });
      lockIfNoRoot();
    }

    function loadList() {
      FOXY.api('exitnodes').then(function (res) {
        if (!alive(page)) return;
        if (!res.ok) { listCard.textContent = ''; listCard.appendChild(stateBox(res.error || t('error'))); return; }
        renderRows(res.peers, null);
      });
      FOXY.api('status').then(function (res) {
        if (!alive(page)) return;
        if (res.ok && res.exitNode) {
          currentId = res.exitNode.id;
          /* the list usually lands before status: re-render so the current
           * node is highlighted on the first frame, not only after an action */
          if (lastPeers) renderRows(lastPeers, lastLat);
        }
      });
    }

    var bTest = actionButton({
      label: t('exit_test'),
      busyLabel: t('exit_testing'),
      api: function () { return FOXY.api('speedtest-exitnodes'); },
      onOk: function (res) {
        var latMap = {};
        res.results.forEach(function (r) { latMap[r.id] = r.latencyMs; });
        /* render sorted results */
        renderRows(res.results.map(function (r) {
          return { id: r.id, hostname: r.hostname, ip: r.ip, relay: '-', online: r.ok };
        }), latMap);
      }
    });
    var bClear = actionButton({
      label: t('exit_clear'),
      cls: 'secondary',
      api: function () { return FOXY.api('exitnode-clear'); },
      onOk: function () { toast(t('exit_cleared'), 'ok'); currentId = null; loadList(); }
    });
    head.appendChild(bTest);
    head.appendChild(bClear);

    loadList();
  });
})();
