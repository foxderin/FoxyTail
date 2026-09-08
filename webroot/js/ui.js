/*
 * FoxyTail WebUI - shared UI components (FOXY.ui).
 *
 *   toast(msg, kind) / toastErr(prefix, res)
 *   showModal(title, bodyNodes, actions)   bottom-sheet modal
 *   confirmBox(message, onYes)
 *   actionButton(opts)   button with the recurring "disable → api → re-enable
 *                        → toastErr" lifecycle baked in
 *   listRow(opts)        the recurring .list-row assembly
 */
(function () {
  'use strict';

  var FOXY = (window.FOXY = window.FOXY || {});
  var h = FOXY.dom.h;
  var dot = FOXY.dom.dot;
  var t = function (k) { return FOXY.t(k); };

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

  /* Button with the standard async-action lifecycle:
   *   opts.label      button text (also restored after a busyLabel run)
   *   opts.cls        extra classes, e.g. 'secondary', 'danger', 'block mt'
   *   opts.needsRoot  adds the .needs-root lockdown marker
   *   opts.busyLabel  text shown while the request is in flight
   *   opts.when()     optional guard; click is a no-op when it returns false
   *   opts.api()      must return a Promise of a webapi result ({ok, error, ...})
   *   opts.onOk(res)  called on res.ok
   *   opts.onFail(res)  custom failure handling; defaults to toastErr
   */
  function actionButton(opts) {
    var btn = h('button', {
      class: 'btn' + (opts.cls ? ' ' + opts.cls : '') + (opts.needsRoot === false ? '' : ' needs-root'),
      text: opts.label
    });
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      if (opts.when && !opts.when()) return;
      btn.disabled = true;
      if (opts.busyLabel) btn.textContent = opts.busyLabel;
      opts.api().then(function (res) {
        btn.disabled = false;
        if (opts.busyLabel) btn.textContent = opts.label;
        if (res && res.ok) { if (opts.onOk) opts.onOk(res); }
        else if (opts.onFail) opts.onFail(res);
        else toastErr(t('op_failed'), res);
      });
    });
    return btn;
  }

  /* The recurring .list-row assembly: [dot] .main>.title/.sub [right].
   *   opts.tag       element tag, default 'div' (use 'a' with opts.href)
   *   opts.dot       boolean → status dot, omitted when null
   *   opts.title / opts.sub    text lines (skipped when null)
   *   opts.mono      monospace title; opts.monoSub: monospace sub
   *   opts.titleNode / opts.subNode   custom nodes appended to .main
   *   opts.right     trailing node (buttons, values)
   *   opts.onclick / opts.href / opts.style
   */
  function listRow(opts) {
    var attrs = { class: 'list-row' };
    if (opts.onclick) attrs.onclick = opts.onclick;
    if (opts.href) attrs.href = opts.href;
    if (opts.style) attrs.style = opts.style;
    var row = h(opts.tag || 'div', attrs);
    if (opts.dot != null) row.appendChild(dot(opts.dot));
    var main = h('div', { class: 'main' + (opts.mainMono ? ' mono' : '') });
    if (opts.mainText != null) main.textContent = opts.mainText;
    if (opts.title != null) main.appendChild(h('div', { class: 'title' + (opts.mono ? ' mono' : ''), text: opts.title }));
    if (opts.titleNode) main.appendChild(opts.titleNode);
    if (opts.sub != null) main.appendChild(h('div', { class: 'sub' + (opts.monoSub ? ' mono' : ''), text: opts.sub }));
    if (opts.subNode) main.appendChild(opts.subNode);
    row.appendChild(main);
    if (opts.right) row.appendChild(opts.right);
    return row;
  }

  FOXY.ui = {
    toast: toast,
    toastErr: toastErr,
    showModal: showModal,
    confirmBox: confirmBox,
    actionButton: actionButton,
    listRow: listRow
  };
})();
