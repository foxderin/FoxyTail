/*
 * FoxyTail WebUI - canvas charts (FOXY.charts).
 *
 *   cssVar(name, fallback)                 theme color lookup (single
 *                                          getComputedStyle entry point)
 *   drawTopology(canvas, self, peers)      star topology; returns hit list
 *   drawLineChart(canvas, labels, series)  axis/grid/gradient chart with
 *                                          rAF-throttled touch tooltip
 */
(function () {
  'use strict';

  var FOXY = (window.FOXY = window.FOXY || {});
  var fmtBytes = FOXY.dom.fmtBytes;
  var t = function (k) { return FOXY.t(k); };

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

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

    var cFg = cssVar('--fg', '#e8e6f0');
    var cDim = cssVar('--fg-dim', '#a5a2b3');
    var cOk = cssVar('--ok', '#7fd88f');
    var cOff = cssVar('--fg-faint', '#6d6a7c');
    var cPri = cssVar('--primary', '#c3b8ff');

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
    ctx.fillText((self && self.hostname) || t('dash_self'), cx, cy + 32);

    return nodes;
  }

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

    var cFg = cssVar('--fg', '#e8e6f0');
    var cDim = cssVar('--fg-faint', '#6d6a7c');
    var cLine = cssVar('--line', '#33333f');

    var padL = 46, padR = 10, padT = 12, padB = 26;
    var iw = w - padL - padR, ih = hgt - padT - padB;
    var n = labels.length;

    var maxV = 1;
    series.forEach(function (s) { s.values.forEach(function (v) { if (v > maxV) maxV = v; }); });

    function xAt(i) { return padL + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw); }
    function yAt(v) { return padT + ih - (v / maxV) * ih; }

    /* gradients depend only on (color, geometry); build once per series
     * instead of on every hover repaint */
    var gradCache = {};
    function gradFor(s) {
      var key = s.color + '|' + padT + '|' + ih;
      if (!gradCache[key]) {
        var grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
        grad.addColorStop(0, s.color + '55');
        grad.addColorStop(1, s.color + '00');
        gradCache[key] = grad;
      }
      return gradCache[key];
    }

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
        ctx.beginPath();
        ctx.moveTo(xAt(0), yAt(s.values[0]));
        for (var j = 1; j < n; j++) ctx.lineTo(xAt(j), yAt(s.values[j]));
        ctx.lineTo(xAt(n - 1), padT + ih);
        ctx.lineTo(xAt(0), padT + ih);
        ctx.closePath();
        ctx.fillStyle = gradFor(s);
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

    /* rAF throttle: collapse a burst of pointer/touch moves into one repaint
     * per frame; clientX is captured synchronously because touch point lists
     * are not guaranteed to survive until the frame fires */
    var rafPending = false;
    var pendingX = null;
    function onTouch(e) {
      var src = e.touches ? e.touches[0] : e;
      if (!src) return;
      pendingX = src.clientX;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(function () {
        rafPending = false;
        var rect = canvas.getBoundingClientRect();
        var px = pendingX - rect.left;
        var idx = Math.round(((px - padL) / iw) * (n - 1));
        paint(Math.max(0, Math.min(n - 1, idx)));
      });
    }
    canvas.addEventListener('pointermove', onTouch);
    canvas.addEventListener('touchstart', onTouch, { passive: true });
    canvas.addEventListener('touchmove', onTouch, { passive: true });
  }

  FOXY.charts = {
    cssVar: cssVar,
    drawTopology: drawTopology,
    drawLineChart: drawLineChart
  };
})();
