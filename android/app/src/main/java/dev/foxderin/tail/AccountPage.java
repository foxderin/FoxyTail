package dev.foxderin.tail;

import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.view.View;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;

final class AccountPage extends ControlPage {
    private final LinearLayout accounts, loginResult, logout;
    private final TextView state, accountState, urlText;
    private final EditText key, server;
    private String loginUrl;
    private boolean awaitingBrowser, checking, loading, reload;
    private int pendingReads;
    private final android.widget.Button reopen;

    AccountPage(ControlActivity activity) {
        super(activity);
        LinearLayout accountCard = section(s(R.string.web_acc_accounts), R.drawable.ic_person, null);
        ControlUi.cardAction(accountCard, iconButton(accountCard, R.drawable.ic_refresh, s(R.string.web_tools_refresh), this::load));
        accountState = label(accountCard, ""); accountState.setVisibility(View.GONE);
        accounts = new LinearLayout(activity); accounts.setOrientation(LinearLayout.VERTICAL); accountCard.addView(accounts);
        LinearLayout login = section(s(R.string.web_acc_login), R.drawable.ic_login, null);
        state = label(login, ""); state.setVisibility(View.GONE);
        loginResult = new LinearLayout(activity); loginResult.setOrientation(LinearLayout.VERTICAL); login.addView(loginResult); loginResult.setVisibility(View.GONE);
        urlText = mono(loginResult, "");
        LinearLayout urlActions = row(loginResult);
        iconButton(urlActions, R.drawable.ic_content_copy, s(R.string.web_copy), () -> { if (loginUrl != null) copy(s(R.string.web_copy), loginUrl); });
        reopen = primary(urlActions, s(R.string.web_open_browser), () -> {
            if (loginUrl != null) { awaitingBrowser = true; activity.openUrl(loginUrl); }
        });
        primary(login, s(R.string.web_acc_login), R.drawable.ic_login, () -> guarded(() -> browserLogin(null)));
        LinearLayout advancedBody = ControlUi.disclosure(content, s(R.string.web_tools_advanced_login), R.drawable.ic_vpn_key);
        LinearLayout auth = ControlUi.card(advancedBody, s(R.string.web_acc_authkey), R.drawable.ic_vpn_key, null);
        key = input(auth, s(R.string.web_acc_authkey), "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        key.setHint(s(R.string.web_acc_authkey_hint));
        key.setSaveEnabled(false);
        if (android.os.Build.VERSION.SDK_INT >= 26) key.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        tonal(auth, s(R.string.web_acc_login_authkey), () -> {
            if (key.getText().toString().trim().isEmpty()) { key.setError(s(R.string.web_acc_authkey)); return; }
            guarded(() -> {
                String authkey = key.getText().toString().trim(); key.setText("");
                if (!authkey.isEmpty()) accountMutation("login-authkey", authkey);
            });
        });
        LinearLayout headscale = ControlUi.card(advancedBody, s(R.string.web_acc_headscale), R.drawable.ic_dns, null);
        server = input(headscale, s(R.string.web_acc_headscale), activity.drafts.getString("account.server", ""), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        server.setHint(s(R.string.web_acc_headscale_hint));
        server.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence value, int start, int count, int after) { }
            public void onTextChanged(CharSequence value, int start, int before, int count) { activity.drafts.putString("account.server", value.toString()); }
            public void afterTextChanged(Editable value) { }
        });
        tonal(headscale, s(R.string.web_acc_login_server), () -> {
            String url = server.getText().toString().trim();
            if (!validServer(url)) { server.setError(s(R.string.web_tools_server_invalid)); return; }
            guarded(() -> browserLogin(url));
        });
        logout = ControlUi.dangerCard(content, s(R.string.web_acc_logout), R.drawable.ic_logout);
        button(logout, s(R.string.web_acc_logout), () -> confirm(s(R.string.web_acc_logout), s(R.string.web_acc_logout_confirm), () -> guarded(() -> accountMutation("logout"))));
        ControlUi.setCardVisible(logout, false);
    }
    @Override String title() { return s(R.string.web_acc_title); }
    @Override void load() {
        if (awaitingBrowser) { awaitingBrowser = false; activity.invalidateAccountState(); }
        if (loading) { reload = true; return; }
        loading = true; pendingReads = 1;
        read(result -> {
            try {
            JSONArray list = result.optJSONArray("accounts");
            if (list == null) { accountState.setVisibility(View.VISIBLE); accountState.setText(s(R.string.network_stale)); error(new IllegalArgumentException(s(R.string.network_invalid_result))); return; }
            for (int i = 0; i < list.length(); i++) {
                JSONObject account = list.optJSONObject(i);
                if (account == null || !(account.opt("name") instanceof String) || account.optString("name").isEmpty() || !(account.opt("current") instanceof Boolean)) {
                    accountState.setVisibility(View.VISIBLE); accountState.setText(s(R.string.network_stale)); error(new IllegalArgumentException(s(R.string.network_invalid_result))); return;
                }
            }
            accounts.removeAllViews(); accountState.setVisibility(View.GONE); accountState.setText(""); boolean current = false;
            if (list.length() == 0) label(accounts, s(R.string.web_acc_not_logged_in));
            for (int i = 0; i < list.length(); i++) {
                JSONObject account = list.optJSONObject(i);
                String name = account.optString("name"), display = account.optString("label");
                LinearLayout entry = row(accounts); entry.setGravity(android.view.Gravity.CENTER_VERTICAL);
                LinearLayout main = new LinearLayout(activity); main.setOrientation(LinearLayout.VERTICAL); entry.addView(main, new LinearLayout.LayoutParams(0, -2, 1));
                label(main, display.isEmpty() ? name : display);
                if (account.optBoolean("current")) { current = true; badge(main, s(R.string.web_acc_current_badge), ControlUi.TONE_OK); }
                android.widget.Button change = ControlUi.button(activity, s(R.string.web_acc_switch), () -> guarded(() -> accountMutation("switch", name)));
                entry.addView(change); change.setEnabled(!account.optBoolean("current") && activity.client.canWrite() && !activity.client.busy());
            }
            ControlUi.setCardVisible(logout, current);
            } finally { readFinished(); }
        }, failure -> { accountState.setVisibility(View.VISIBLE); accountState.setText(s(R.string.network_stale)); error(failure); readFinished(); }, "accounts");
    }
    private void readFinished() {
        if (--pendingReads == 0) { loading = false; if (reload) { reload = false; load(); } }
    }
    private void guarded(Runnable action) {
        if (!activity.client.canWrite()) { notice(activity.client.message()); return; }
        if (checking || loading || activity.client.busy()) { notice(s(R.string.network_unknown)); return; }
        confirm(title(), s(R.string.network_account_interrupt), () -> {
            if (checking || loading || activity.client.busy()) return;
            checking = true;
            read(history -> {
                checking = false;
                try {
                    if (hasActiveTransfers(history)) {
                        notice(s(R.string.network_transfer_active)); return;
                    }
                    action.run();
                } catch (org.json.JSONException invalid) { error(invalid); }
            }, failure -> { checking = false; error(failure); }, "file-send-history");
        });
    }
    private void browserLogin(String customServer) {
        if (!activity.client.canWrite() || activity.client.busy()) { notice(activity.client.message()); return; }
        checking = true; loginUrl = null; loginResult.setVisibility(View.GONE); state.setText(s(R.string.web_acc_waiting)); state.setVisibility(View.VISIBLE);
        java.util.function.Consumer<JSONObject> completed = result -> {
            checking = false; state.setVisibility(View.GONE); activity.invalidateAccountState();
            Object url = result.opt("url");
            if (url instanceof String && validServer((String) url)) {
                loginUrl = (String) url; urlText.setText(loginUrl); loginResult.setVisibility(View.VISIBLE);
            } else if (Boolean.TRUE.equals(result.opt("already"))) { state.setText(s(R.string.web_acc_already)); state.setVisibility(View.VISIBLE); load(); }
            else error(new IllegalArgumentException(s(R.string.network_invalid_result)));
        };
        java.util.function.Consumer<Exception> failed = failure -> {
            checking = false; state.setVisibility(View.GONE); activity.invalidateAccountState(); error(failure); load();
        };
        if (customServer == null) read(completed, failed, "login");
        else read(completed, failed, "login", "--login-server=" + customServer);
    }
    private void accountMutation(String... command) {
        loginUrl = null; loginResult.setVisibility(View.GONE);
        mutate(title(), result -> {
            activity.invalidateAccountState();
            if (!result.optBoolean("ok")) notice(s(R.string.network_failed, result.optString("error", s(R.string.network_unknown))));
            else notice(s("logout".equals(command[0]) ? R.string.web_acc_logged_out : "switch".equals(command[0]) ? R.string.web_acc_switched : R.string.web_acc_logged_in));
            load();
        }, command);
    }
    @Override void onClose() { key.setText(""); loginUrl = null; }
    @Override void onPause() { checking = false; loading = false; reload = false; pendingReads = 0; }
    static boolean validServer(String value) {
        try {
            URI uri = new URI(value);
            return ("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme())) &&
                    uri.getHost() != null && !uri.getHost().isEmpty() && uri.getUserInfo() == null && uri.getFragment() == null &&
                    (uri.getPort() == -1 || uri.getPort() >= 1 && uri.getPort() <= 65535);
        } catch (java.net.URISyntaxException invalid) { return false; }
    }
    static boolean hasActiveTransfers(JSONObject history) throws org.json.JSONException {
        JSONArray transfers = history.getJSONArray("transfers");
        for (int i = 0; i < transfers.length(); i++) {
            String status = transfers.getJSONObject(i).getString("status");
            switch (status) {
                case "queued": case "sending": return true;
                case "completed": case "failed": case "cancelled": case "interrupted": break;
                default: throw new org.json.JSONException("Unknown transfer state");
            }
        }
        return false;
    }
}
