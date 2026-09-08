/*
 * FoxyTail WebUI - pages: Peers (list + canvas topology), Traffic (charts).
 */
(function () {
  'use strict';

  var FOXY = window.FOXY;
  var t = function (k) { return FOXY.t(k); };
  var h = FOXY.dom.h;
  var kv = FOXY.dom.kv;
  var stateBox = FOXY.dom.stateBox;
  var fmtBytes = FOXY.dom.fmtBytes;
  var showModal = FOXY.ui.showModal;
  var listRow = FOXY.ui.listRow;
  var registerPage = FOXY.router.registerPage;
  var every = FOXY.router.every;
  var onResize = FOXY.router.onResize;
  var gen = FOXY.router.gen;
  var alive = FOXY.router.alive;
  var drawTopology = FOXY.charts.drawTopology;
  var drawLineChart = FOXY.charts.drawLineChart;
  var cssVar = FOXY.charts.cssVar;

  /* ================= Peers ================= */

  registerPage('peers', 'peers_title', function (root) {
    var page = gen();
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
        if (!alive(page)) return;
        body.textContent = '';
        if (!res.ok) { body.appendChild(stateBox(res.error || t('error'))); return; }
        if (!res.peers.length) { body.appendChild(stateBox(t('peers_empty'))); return; }
        var card = h('div', { class: 'card' });
        res.peers.forEach(function (p) {
          card.appendChild(listRow({
            dot: p.online,
            title: p.hostname,
            sub: p.ip + ' · ' + p.os + ' · ' + p.relay,
            right: h('div', { class: 'dim', text: '↓' + fmtBytes(p.rxBytes) + ' ↑' + fmtBytes(p.txBytes) }),
            onclick: function () { peerDetail(p); }
          }));
        });
        body.appendChild(card);
      });
    }

    function loadTopo() {
      body.textContent = '';
      body.appendChild(stateBox(t('loading'), true));
      Promise.all([FOXY.api('peers'), FOXY.api('status')]).then(function (rs) {
        if (!alive(page)) return;
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
        /* registered with the router: removed automatically on page switch */
        onResize(function () { nodes = drawTopology(canvas, self, peers); });
      });
    }

    loadList();
    every(8000, function () { if (tab === 'list') loadList(); });
  });

  /* ================= Traffic ================= */

  registerPage('traffic', 'traffic_title', function (root) {
    var page = gen();
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

    var cRx = cssVar('--primary', '#c3b8ff');
    var cTx = cssVar('--accent', '#8fd0c3');

    function loadChart() {
      chartCard.textContent = '';
      chartCard.appendChild(stateBox(t('loading'), true));
      FOXY.api('traffic', mode).then(function (res) {
        if (!alive(page)) return;
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
          if (!alive(page)) return;
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
      if (!alive(page)) return;
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
      if (!alive(page)) return;
      uidBody.textContent = '';
      var res = rs[0];
      var labels = {};
      if (rs[1].ok) rs[1].apps.forEach(function (a) { labels[String(a.uid)] = a.label; });
      if (!res.ok || !res.uids || !res.uids.length) { uidBody.appendChild(stateBox(t('traffic_no_data'))); return; }
      res.uids.slice(0, 50).forEach(function (u) {
        uidBody.appendChild(listRow({
          title: labels[String(u.uid)] || (t('traffic_uid') + u.uid),
          sub: t('traffic_uid') + u.uid,
          right: h('span', { class: 'dim', text: fmtBytes(u.rx) })
        }));
      });
    });

    loadChart();
  });
})();
