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
    private final LinearLayout accounts;
    private final TextView state, accountState;
    private final EditText key, server;
    private String loginUrl;
    private boolean awaitingBrowser, checking, loading, reload;
    private int pendingReads;
    private final android.widget.Button reopen;

    AccountPage(ControlActivity activity) {
        super(activity);
        LinearLayout status = section(s(R.string.network_account));
        state = label(status, s(R.string.network_unknown));
        button(status, s(R.string.network_refresh), this::load);
        accountState = label(status, s(R.string.network_unknown));
        accounts = section(s(R.string.network_account));
        LinearLayout login = section(s(R.string.network_login));
        button(login, s(R.string.network_login), () -> guarded(() -> browserLogin(null)));
        reopen = button(login, s(R.string.network_open_login), () -> {
            if (loginUrl != null) { awaitingBrowser = true; activity.openUrl(loginUrl); }
        });
        reopen.setVisibility(View.GONE);
        button(login, s(R.string.network_copy_login), () -> { if (loginUrl != null) copy(s(R.string.network_copy_login), loginUrl); else notice(s(R.string.network_unchecked)); });
        label(login, s(R.string.network_secret_hint));
        key = input(login, s(R.string.network_authkey), "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        key.setSaveEnabled(false);
        if (android.os.Build.VERSION.SDK_INT >= 26) key.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        button(login, s(R.string.network_authkey_login), () -> {
            if (key.getText().toString().trim().isEmpty()) { key.setError(s(R.string.network_authkey)); return; }
            guarded(() -> {
                String authkey = key.getText().toString().trim(); key.setText("");
                if (!authkey.isEmpty()) accountMutation("login-authkey", authkey);
            });
        });
        server = input(login, s(R.string.network_headscale), activity.drafts.getString("account.server", ""), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        server.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence value, int start, int count, int after) { }
            public void onTextChanged(CharSequence value, int start, int before, int count) { activity.drafts.putString("account.server", value.toString()); }
            public void afterTextChanged(Editable value) { }
        });
        button(login, s(R.string.network_server_login), () -> {
            String url = server.getText().toString().trim();
            if (!validServer(url)) { server.setError(s(R.string.network_server_invalid)); return; }
            guarded(() -> browserLogin(url));
        });
        button(login, s(R.string.network_logout), () -> guarded(() -> accountMutation("logout")));
        button(login, s(R.string.network_files), activity::openFiles);
    }
    @Override String title() { return s(R.string.network_account); }
    @Override void load() {
        if (awaitingBrowser) { awaitingBrowser = false; activity.invalidateAccountState(); }
        if (loading) { reload = true; return; }
        loading = true; pendingReads = 2;
        read(result -> {
            state.setText(s(OverviewPage.connectionLabel(result)) + " · " + result.optString("backend", s(R.string.network_unknown)));
            readFinished();
        }, failure -> { state.setText(s(R.string.network_stale)); error(failure); readFinished(); }, "status");
        read(result -> {
            try {
            JSONArray list = result.optJSONArray("accounts");
            if (list == null) { accountState.setText(s(R.string.network_stale)); error(new IllegalArgumentException(s(R.string.network_invalid_result))); return; }
            for (int i = 0; i < list.length(); i++) {
                JSONObject account = list.optJSONObject(i);
                if (account == null || !(account.opt("name") instanceof String) || account.optString("name").isEmpty() || !(account.opt("current") instanceof Boolean)) {
                    accountState.setText(s(R.string.network_stale)); error(new IllegalArgumentException(s(R.string.network_invalid_result))); return;
                }
            }
            accounts.removeAllViews(); accountState.setText("");
            if (list.length() == 0) label(accounts, s(R.string.network_no_accounts));
            for (int i = 0; i < list.length(); i++) {
                JSONObject account = list.optJSONObject(i);
                String name = account.optString("name");
                label(accounts, account.optString("label", name) + (account.optBoolean("current") ? " · " + s(R.string.network_current) : ""));
                android.widget.Button change = button(accounts, s(R.string.network_switch), () -> guarded(() -> accountMutation("switch", name)));
                change.setEnabled(!account.optBoolean("current"));
            }
            } finally { readFinished(); }
        }, failure -> { accountState.setText(s(R.string.network_stale)); error(failure); readFinished(); }, "accounts");
    }
    private void readFinished() {
        if (--pendingReads == 0) { loading = false; if (reload) { reload = false; load(); } }
    }
    private void guarded(Runnable action) {
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
        checking = true; loginUrl = null; reopen.setVisibility(View.GONE);
        java.util.function.Consumer<JSONObject> completed = result -> {
            checking = false; activity.invalidateAccountState();
            Object url = result.opt("url");
            if (url instanceof String && validServer((String) url)) {
                loginUrl = (String) url; reopen.setVisibility(View.VISIBLE);
                awaitingBrowser = true; activity.openUrl(loginUrl);
            } else if (Boolean.TRUE.equals(result.opt("already"))) { notice(s(R.string.network_already)); load(); }
            else error(new IllegalArgumentException(s(R.string.network_invalid_result)));
        };
        java.util.function.Consumer<Exception> failed = failure -> {
            checking = false; activity.invalidateAccountState(); error(failure); load();
        };
        if (customServer == null) read(completed, failed, "login");
        else read(completed, failed, "login", "--login-server=" + customServer);
    }
    private void accountMutation(String... command) {
        loginUrl = null; reopen.setVisibility(View.GONE);
        mutate(title(), result -> {
            activity.invalidateAccountState();
            if (!result.optBoolean("ok")) notice(s(R.string.network_failed, result.optString("error", s(R.string.network_unknown))));
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
