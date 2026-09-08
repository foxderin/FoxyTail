/*
 * FoxyTail WebUI - pages: Account, Tunnel, Serve/Funnel, Files (Taildrop).
 */
(function () {
  'use strict';

  var FOXY = window.FOXY;
  var t = function (k) { return FOXY.t(k); };
  var h = FOXY.dom.h;
  var kv = FOXY.dom.kv;
  var stateBox = FOXY.dom.stateBox;
  var dot = FOXY.dom.dot;
  var latClass = FOXY.dom.latClass;
  var fmtBytes = FOXY.dom.fmtBytes;
  var fmtTime = FOXY.dom.fmtTime;
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

  /* ================= Account ================= */

  registerPage('account', 'acc_title', function (root) {
    var page = gen();
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
          /* execCommand('copy') is intentional: navigator.clipboard requires a
           * secure context and is unavailable on file:// WebUI pages, so the
           * legacy path is the only one that works in KSU/MMRL WebViews */
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
        if (!alive(page)) return;
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
    var bKey = actionButton({
      label: t('acc_login_authkey'),
      cls: 'block',
      when: function () { return !!keyInput.value.trim(); },
      api: function () { return FOXY.api('login-authkey', keyInput.value.trim()); },
      onOk: function () { toast(t('acc_logged_in'), 'ok'); keyInput.value = ''; loadAccounts(); }
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
        if (!alive(page)) return;
        accCard.textContent = '';
        accCard.appendChild(h('h2', { text: t('acc_accounts') }));
        if (!res.ok) { accCard.appendChild(h('div', { class: 'dim', text: t('acc_not_logged_in') })); return; }
        res.accounts.forEach(function (a) {
          var bSw = actionButton({
            label: t('acc_switch'),
            cls: 'small secondary',
            api: function () { return FOXY.api('switch', a.name); },
            onOk: function () { toast(t('acc_switched'), 'ok'); loadAccounts(); }
          });
          bSw.disabled = a.current;
          accCard.appendChild(listRow({
            titleNode: h('span', null,
              h('span', { class: 'title', text: a.name }),
              a.current ? h('span', { class: 'badge', text: t('acc_current_badge') }) : null),
            right: bSw
          }));
        });
        var bOut = h('button', { class: 'btn danger block mt needs-root', text: t('acc_logout') });
        bOut.addEventListener('click', function () {
          confirmBox(t('acc_logout_confirm'), function () {
            FOXY.api('logout').then(function (r2) {
              if (!alive(page)) return;
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

  /* ================= Tunnel ================= */

  registerPage('tunnel', 'tun_title', function (root) {
    var page = gen();
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
        if (!alive(page)) return;
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
          if (!alive(page)) return;
          var ms = Date.now() - started;
          var code = String(out).trim();
          var okc = /^[23]/.test(code) || code === '301' || code === '302' || code.length === 3;
          socksResult.textContent = (okc ? t('tun_socks_ok') : t('tun_socks_fail')) +
            ' · HTTP ' + (code || '???') + ' · ' + ms + 'ms';
          socksResult.className = okc ? 'lat-good' : 'lat-bad';
          bSocks.disabled = false;
        }, function (err) {
          if (!alive(page)) return;
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
    var bDerp = actionButton({
      label: t('tun_derp'),
      cls: 'block mt',
      busyLabel: t('tun_derp_testing'),
      api: function () { return FOXY.api('derp-speedtest'); },
      onOk: function (res) {
        derpBody.textContent = '';
        res.relays.forEach(function (r) {
          derpBody.appendChild(listRow({
            titleNode: h('span', null,
              h('span', { class: 'title mono', text: r.code }),
              r.code === res.preferred ? h('span', { class: 'badge', text: t('tun_preferred') }) : null),
            right: h('span', { class: latClass(r.latencyMs), text: r.latencyMs + 'ms' })
          }));
        });
      }
    });
    derpCard.appendChild(derpBody);
    derpCard.appendChild(bDerp);

    loadTun();
    every(6000, loadTun);
  });

  /* ================= Serve / Funnel ================= */

  registerPage('serve', 'serve_title', function (root) {
    var page = gen();
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
        if (!alive(page)) return;
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
                  if (!alive(page)) return;
                  if (r2.ok) { renderSection(card, kind, titleKey); }
                  else toastErr(t('op_failed'), r2);
                });
              });
            }
          });
          card.appendChild(listRow({
            title: r.proto + ' :' + r.port,
            mono: true,
            sub: r.target || null,
            monoSub: true,
            right: bDel
          }));
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
    formCard.appendChild(h('label', { class: 'field' }, h('span', { class: 'label', text: t('serve_kind') }), kindSel));
    formCard.appendChild(h('label', { class: 'field' }, h('span', { class: 'label', text: t('serve_proto') }), protoSel));
    formCard.appendChild(h('label', { class: 'field' }, h('span', { class: 'label', text: t('serve_port') }), portIn));
    formCard.appendChild(h('label', { class: 'field' }, h('span', { class: 'label', text: t('serve_target') }), targetIn));
    var bAdd = actionButton({
      label: t('serve_add'),
      cls: 'block',
      when: function () { return !!(portIn.value.trim() && targetIn.value.trim()); },
      api: function () {
        return FOXY.api(kindSel.value + '-set', protoSel.value, portIn.value.trim(), targetIn.value.trim());
      },
      onOk: function () {
        targetIn.value = '';
        renderSection(serveCard, 'serve', 'serve_serve');
        renderSection(funnelCard, 'funnel', 'serve_funnel');
      }
    });
    formCard.appendChild(bAdd);

    renderSection(serveCard, 'serve', 'serve_serve');
    renderSection(funnelCard, 'funnel', 'serve_funnel');
  });

  /* ================= Files ================= */

  registerPage('files', 'files_title', function (root) {
    var page = gen();
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
        if (!alive(page)) return;
        body.textContent = '';
        if (!res.ok) { body.appendChild(stateBox(res.error || t('error'))); return; }
        if (!res.files.length) { body.appendChild(stateBox(t('files_empty'))); return; }
        res.files.forEach(function (f) {
          body.appendChild(listRow({
            title: f.name,
            mono: true,
            sub: fmtBytes(f.size) + ' · ' + fmtTime(f.mtime)
          }));
        });
      });
      var bRecv = actionButton({
        label: t('files_receive'),
        cls: 'secondary block mt',
        api: function () { return FOXY.api('file-receive'); },
        onOk: function () { toast(t('files_received'), 'ok'); loadInbox(); }
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
    var bSend = actionButton({
      label: t('files_send_btn'),
      cls: 'block',
      when: function () { return !!(pathIn.value.trim() && peerSel.value); },
      api: function () { return FOXY.api('file-send', pathIn.value.trim(), peerSel.value); },
      onOk: function () { toast(t('files_sent'), 'ok'); }
    });
    sendCard.appendChild(bSend);

    FOXY.api('peers').then(function (res) {
      if (!alive(page)) return;
      if (!res.ok) return;
      res.peers.forEach(function (p) {
        peerSel.appendChild(h('option', { value: p.hostname, text: p.hostname + (p.online ? '' : ' (' + t('offline') + ')') }));
      });
    });

    loadInbox();
  });
})();
