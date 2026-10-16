import 'package:flutter/material.dart';
import 'package:foxytail/app/app_state.dart';
import 'package:foxytail/app/platform_bridge.dart';
import 'package:foxytail/widgets/common.dart';
import 'network_rules.dart';
import 'network_state.dart';

Future<bool> guardAccountChange(BuildContext context, AppState app, String owner) async {
  final account = app.accountRevision;
  if (!app.foreground || !app.canWrite || app.busy || app.unknown) return false;
  if (!await confirm(context, context.l10n.web_acc_title, context.l10n.network_account_interrupt)) return false;
  if (!context.mounted || !app.foreground || account != app.accountRevision || !app.canWrite || app.busy || app.unknown) return false;
  final history = await app.read(['file-send-history'], owner: owner);
  if (!context.mounted || !app.foreground || account != app.accountRevision || !app.canWrite || app.busy || app.unknown) return false;
  if (boolean(app.bridge.transfer['busy']) || hasActiveTransfers(history)) {
    app.message(context.l10n.network_transfer_active);
    return false;
  }
  return true;
}

class AccountPage extends StatefulWidget {
  const AccountPage({super.key, required this.app});
  final AppState app;
  @override
  State<AccountPage> createState() => _AccountPageState();
}
class _AccountPageState extends NetworkPageState<AccountPage> {
  @override
  AppState get app => widget.app;
  List<Json>? accounts;
  bool loading = false, changing = false;
  String? error;
  @override
  void load() { _load(); }
  @override
  void invalidated() {
    accounts = null;
    loading = false;
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted && app.foreground) _load(); });
  }
  Future<void> _load() async {
    if (loading || !app.foreground) return;
    final ticket = generation;
    setState(() { loading = true; error = null; });
    try {
      final result = await readCurrent(['accounts']);
      if (!mounted || result == null) return;
      final raw = result['accounts'];
      if (raw is! List || raw.any((v) => json(v)['name'] is! String || string(json(v)['name']).isEmpty || json(v)['current'] is! bool)) {
        throw FormatException(context.l10n.network_invalid_result);
      }
      setState(() { accounts = objects(raw); });
    } catch (failure) { if (mounted && ticket == generation) setState(() { error = failureMessage(failure); }); }
    finally { if (mounted && ticket == generation) setState(() { loading = false; }); }
  }
  Future<void> _change(List<String> args) async {
    if (changing) return;
    setState(() { changing = true; });
    await run(() async {
      if (!await guardAccountChange(context, app, owner) || !mounted) return;
      try {
        requireOk(await app.submit(context.l10n.web_acc_title, args));
        if (mounted) app.message(args.first == 'logout' ? context.l10n.web_acc_logged_out : context.l10n.web_acc_switched);
      } finally { app.invalidateAccountState(); await app.refreshStatus(); }
    });
    if (mounted) setState(() { changing = false; });
  }
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return PageBody(children: [
      Section(title: l.web_acc_accounts, trailing: IconButton(tooltip: l.web_tools_refresh, onPressed: loading ? null : _load, icon: const Icon(Icons.refresh)), children: [
        if (loading) const LinearProgressIndicator(),
        if (error != null) Notice('${l.network_stale}\n$error', error: true),
        if (accounts == null && !loading && error == null) Notice(l.network_unknown),
        if (accounts?.isEmpty == true) Notice(l.web_acc_not_logged_in),
        for (final account in accounts ?? <Json>[]) ListTile(
          leading: Icon(account['current'] == true ? Icons.account_circle : Icons.person_outline),
          title: Text(string(account['label']).isEmpty ? string(account['name']) : string(account['label'])),
          subtitle: account['current'] == true ? Text(l.web_acc_current_badge) : null,
          trailing: account['current'] == true ? null : IconButton(tooltip: l.web_acc_switch,
            onPressed: writable && !loading && !changing && error == null ? () => _change(['switch', string(account['name'])]) : null,
            icon: const Icon(Icons.switch_account)),
        ),
      ]),
      LoginPanel(app: app),
      if (accounts?.any((a) => a['current'] == true) == true) Section(title: l.web_acc_logout, children: [
        Text(l.web_tools_logout_desc),
        OutlinedButton.icon(onPressed: writable && !changing && !loading && error == null ? () => run(() async {
          if (await confirm(context, l.web_acc_logout, l.web_acc_logout_confirm) && mounted) await _change(['logout']);
        }) : null, icon: const Icon(Icons.logout), label: Text(l.web_acc_logout)),
      ]),
    ]);
  }
}

class LoginPanel extends StatefulWidget {
  const LoginPanel({super.key, required this.app, this.compact = false});
  final AppState app;
  final bool compact;
  @override
  State<LoginPanel> createState() => _LoginPanelState();
}
class _LoginPanelState extends NetworkPageState<LoginPanel> with WidgetsBindingObserver {
  @override
  AppState get app => widget.app;
  final keyInput = TextEditingController();
  late final TextEditingController server;
  bool checking = false, awaitingBrowser = false;
  String? loginUrl, result;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    server = TextEditingController(text: string(app.drafts['account.server']));
    server.addListener(() { app.drafts['account.server'] = server.text; });
  }
  @override
  void invalidated() { loginUrl = null; result = null; }
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) keyInput.clear();
    if (state == AppLifecycleState.resumed && awaitingBrowser) {
      awaitingBrowser = false;
      app.invalidateAccountState();
      app.refreshStatus();
    }
  }
  Future<void> _login({bool authKey = false, String? customServer}) async {
    if (checking) return;
    setState(() { checking = true; result = null; });
    await run(() async {
      if (!await guardAccountChange(context, app, owner) || !mounted) return;
      if (widget.compact && (!app.statusFresh || connectionState(app.status) != 'login')) return;
      setState(() { loginUrl = null; });
      if (authKey) {
        final secret = keyInput.text.trim();
        keyInput.clear();
        if (secret.isEmpty) return;
        try {
          requireOk(await app.submit(context.l10n.web_acc_login_authkey, ['login-authkey', secret]));
        } finally { app.invalidateAccountState(); await app.refreshStatus(); }
        if (mounted) setState(() { result = context.l10n.web_acc_logged_in; });
      } else {
        Json? response;
        try { response = await readCurrent(['login', if (customServer != null) '--login-server=$customServer']); }
        finally { app.invalidateAccountState(); }
        if (!mounted || response == null) return;
        requireOk(response);
        final url = response['url'];
        if (url is String && validServer(url)) setState(() { loginUrl = url; });
        else if (response['already'] == true) { setState(() { result = context.l10n.web_acc_already; }); await app.refreshStatus(); }
        else throw FormatException(context.l10n.network_invalid_result);
      }
    });
    if (mounted) setState(() { checking = false; });
  }
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    loginUrl = null;
    keyInput.clear(); keyInput.dispose(); server.dispose();
    super.dispose();
  }
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return Section(title: l.web_acc_login, children: [
      if (checking) const LinearProgressIndicator(),
      if (result != null) Notice(result!),
      FilledButton.icon(onPressed: writable && !checking ? () => _login() : null, icon: const Icon(Icons.login), label: Text(l.web_hero_get_link)),
      if (loginUrl != null) ...[
        SelectableText(loginUrl!),
        Wrap(spacing: 8, children: [
          IconButton(tooltip: l.web_copy, onPressed: () => copyText(context, loginUrl!), icon: const Icon(Icons.copy)),
          OutlinedButton.icon(onPressed: () => run(() async {
            final url = loginUrl;
            if (url == null || !validServer(url)) return;
            awaitingBrowser = true;
            try { await app.bridge.invoke<void>('openUrl', {'url': url}); }
            catch (_) { awaitingBrowser = false; rethrow; }
          }), icon: const Icon(Icons.open_in_browser), label: Text(l.web_open_browser)),
        ]),
      ],
      ExpansionTile(title: Text(l.web_tools_advanced_login), childrenPadding: const EdgeInsets.all(12), children: [
        TextField(controller: keyInput, obscureText: true, enableSuggestions: false, autocorrect: false,
          autofillHints: const [], decoration: InputDecoration(labelText: l.web_acc_authkey, hintText: l.web_acc_authkey_hint)),
        OutlinedButton(onPressed: writable && !checking ? () => _login(authKey: true) : null, child: Text(l.web_acc_login_authkey)),
        if (!widget.compact) ...[
          TextField(controller: server, keyboardType: TextInputType.url, decoration: InputDecoration(labelText: l.web_acc_headscale, hintText: l.web_acc_headscale_hint)),
          OutlinedButton(onPressed: writable && !checking ? () {
            final url = server.text.trim();
            if (!validServer(url)) { app.message(l.web_tools_server_invalid); return; }
            _login(customServer: url);
          } : null, child: Text(l.web_acc_login_server)),
        ],
      ]),
    ]);
  }
}
