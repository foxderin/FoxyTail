/*
 * FoxyTail WebUI - DOM builders and formatting helpers (FOXY.dom).
 *
 *   h(tag, attrs, kids...)  minimal hyperscript; the "text" attr goes through
 *                           textContent, so API-derived strings never become HTML
 *   kv(k, v)                key/value row
 *   stateBox(text, spin)    loading / empty / error placeholder
 *   dot(on)                 green/grey status dot
 *   fmtBytes / fmtUptime / fmtTime / latClass
 *
 * XSS policy: innerHTML is never used for dynamic data anywhere in the UI.
 */
(function () {
  'use strict';

  var FOXY = (window.FOXY = window.FOXY || {});

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

  FOXY.dom = {
    h: h,
    kv: kv,
    stateBox: stateBox,
    dot: dot,
    fmtBytes: fmtBytes,
    fmtUptime: fmtUptime,
    fmtTime: fmtTime,
    latClass: latClass
  };
})();
