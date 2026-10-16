package dev.foxderin.tail;

import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import org.json.JSONArray;
import org.json.JSONObject;
import java.time.Instant;

/* Dashboard: renders the shared status store; owns no private status reads. */
final class OverviewPage extends ControlPage {
    private final LinearLayout statusBox, exitBox, detailRow, compatibility, expiryBox, skeleton, tilesRow;
    private final ControlUi.HealthCard health;
    private final View retryButton;
    private final LinearLayout loginHero, loginBody, loginResult, authFields;
    private final android.widget.TextView loginState, loginUrlText;
    private final android.widget.EditText authKey;
    private boolean loginBusy, heroDismissed, awaitingBrowser;
    private String loginUrl;
    private ControlUi.MetricTile metricPeers, metricUptime;
    static final String[] MODES = {"tun", "bridge", "proxy"};

    OverviewPage(ControlActivity activity) {
        super(activity);
        expiryBox = row(content); expiryBox.setOrientation(LinearLayout.VERTICAL);
        compatibility = row(content); compatibility.setOrientation(LinearLayout.VERTICAL);
        health = ControlUi.healthCard(content);
        retryButton = ControlUi.iconButton(activity, R.drawable.ic_refresh, s(R.string.web_retry), () -> { if (isCurrent()) activity.refreshStatus(); });
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(-2, -2); retryParams.setMarginEnd(dp(8));
        health.actions.addView(retryButton, retryParams);
        loginHero = section();
        loginBody = row(loginHero); loginBody.setOrientation(LinearLayout.VERTICAL);
        loginState = label(loginHero, ""); loginState.setVisibility(View.GONE);
        loginResult = row(loginHero); loginResult.setOrientation(LinearLayout.VERTICAL); loginResult.setVisibility(View.GONE);
        hint(loginResult, s(R.string.web_acc_login_url_hint)); loginUrlText = mono(loginResult, "");
        LinearLayout urlActions = row(loginResult);
        button(urlActions, s(R.string.web_copy), R.drawable.ic_content_copy, () -> { if (loginUrl != null) copy(s(R.string.web_copy), loginUrl); });
        button(urlActions, s(R.string.web_open_browser), R.drawable.ic_open_in_new, () -> {
            if (loginUrl == null || !AccountPage.validServer(loginUrl)) return;
            try { awaitingBrowser = true; activity.startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(loginUrl))); }
            catch (RuntimeException failure) { awaitingBrowser = false; error(failure); }
        });
        authFields = row(loginHero); authFields.setOrientation(LinearLayout.VERTICAL); authFields.setVisibility(View.GONE);
        authKey = input(authFields, s(R.string.web_acc_authkey), "", android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        authKey.setHint(s(R.string.web_acc_authkey_hint));
        authKey.setSaveEnabled(false); authKey.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        button(authFields, s(R.string.web_acc_login_authkey), () -> {
            if (authKey.getText().toString().trim().isEmpty()) return;
            guardedLogin(() -> {
                String secret = authKey.getText().toString().trim(); authKey.setText("");
                mutate(s(R.string.web_acc_login_authkey), result -> {
                    loginBusy = false; activity.invalidateAccountState(); activity.refreshStatus();
                    if (!result.optBoolean("ok")) error(new IllegalStateException(result.optString("error", s(R.string.web_error))));
                }, "login-authkey", secret);
            });
        });
        LinearLayout tiles = new LinearLayout(activity); tiles.setOrientation(LinearLayout.HORIZONTAL);
        content.addView(tiles, new LinearLayout.LayoutParams(-1, -2));
        tilesRow = tiles;
        metricPeers = ControlUi.dashboardMetric(tiles, R.drawable.ic_group, s(R.string.web_dash_peers_online));
        metricUptime = ControlUi.dashboardMetric(tiles, R.drawable.ic_monitoring, s(R.string.web_net_service_runtime));
        detailRow = new LinearLayout(activity); detailRow.setOrientation(LinearLayout.VERTICAL);
        content.addView(detailRow, new LinearLayout.LayoutParams(-1, -2));
        statusBox = ControlUi.card(detailRow, s(R.string.web_dash_self), R.drawable.ic_person, null);
        exitBox = ControlUi.card(detailRow, s(R.string.web_dash_exitnode), R.drawable.ic_logout, null);
        detailRow.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            int available = right - left;
            boolean columns = activity.getResources().getConfiguration().screenWidthDp > 700 &&
                    available >= dp(Math.round(640 * activity.getResources().getConfiguration().fontScale));
            if ((detailRow.getOrientation() == LinearLayout.HORIZONTAL) == columns) return;
            for (int i = 0; i < detailRow.getChildCount(); i++) {
                View card = detailRow.getChildAt(i);
                LinearLayout.LayoutParams params = (LinearLayout.LayoutParams) card.getLayoutParams();
                params.width = columns ? 0 : -1; params.weight = columns ? 1 : 0;
                params.setMarginEnd(columns && i == 0 ? dp(20) : 0);
                card.setLayoutParams(params);
            }
            detailRow.setOrientation(columns ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        });
        android.widget.TextView shortcutsTitle = ControlUi.text(activity, s(R.string.web_net_quick_access), 15); shortcutsTitle.setTypeface(android.graphics.Typeface.create("sans-serif-medium", 0)); content.addView(shortcutsTitle, sectionTitleParams());
        LinearLayout gridA = new LinearLayout(activity); gridA.setOrientation(LinearLayout.HORIZONTAL);
        content.addView(gridA, new LinearLayout.LayoutParams(-1, -2));
        quickCard(gridA, R.drawable.ic_group, s(R.string.web_peers_title), s(R.string.web_net_quick_peers), () -> activity.navigate("peers"));
        quickCard(gridA, R.drawable.ic_alt_route, s(R.string.web_route_title), s(R.string.web_net_quick_routing), () -> activity.navigate("routing"));
        LinearLayout gridB = new LinearLayout(activity); gridB.setOrientation(LinearLayout.HORIZONTAL);
        content.addView(gridB, new LinearLayout.LayoutParams(-1, -2));
        quickCard(gridB, R.drawable.ic_router, s(R.string.web_tun_title) + " / DNS", s(R.string.web_net_quick_dns), () -> activity.navigate("tunnel"));
        quickCard(gridB, R.drawable.ic_article, s(R.string.web_logs_title), s(R.string.web_net_quick_logs), () -> activity.navigate("logs"));
        skeleton = new LinearLayout(activity); skeleton.setOrientation(LinearLayout.VERTICAL);
        content.addView(skeleton, 0, new LinearLayout.LayoutParams(-1, -2));
        ControlUi.skeleton(skeleton, 1f, 112);
        ControlUi.skeleton(skeleton, 0.45f, 20);
        activity.addStatusListener(snapshot -> { if (isCurrent()) render(snapshot); });
        render(activity.statusEverLoaded() ? activity.statusSnapshot() : null);
    }
    private LinearLayout.LayoutParams sectionTitleParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(16);
        return params;
    }

    @Override String title() { return s(R.string.web_nav_dashboard); }
    @Override void load() {
        if (awaitingBrowser) { awaitingBrowser = false; activity.invalidateAccountState(); }
        render(activity.statusEverLoaded() ? activity.statusSnapshot() : null);
        activity.refreshStatus();
        read(result -> {
            compatibility.removeAllViews();
            JSONArray warnings = result.optJSONArray("warnings");
            if (warnings != null) for (int i = 0; i < warnings.length(); i++) {
                if (warnings.opt(i) instanceof String) ControlUi.banner(compatibility, R.drawable.ic_warning,
                        s(R.string.web_dash_compat_warning) + ": " + warnings.optString(i), ControlUi.TONE_WARN);
            }
            String alert = result.opt("alert") instanceof String ? result.optString("alert") : "";
            if (!alert.isEmpty()) ControlUi.banner(compatibility, R.drawable.ic_warning, s(R.string.web_dash_compat_warning) + ": " + alert, ControlUi.TONE_WARN);
        }, failure -> { compatibility.removeAllViews(); ControlUi.banner(compatibility, R.drawable.ic_error, s(R.string.network_stale), ControlUi.TONE_ERROR); error(failure); }, "compat");
    }

    private void render(JSONObject snapshot) {
        boolean loading = !activity.statusEverLoaded();
        skeleton.setVisibility(loading ? View.VISIBLE : View.GONE);
        health.setVisible(!loading);
        tilesRow.setVisibility(loading ? View.GONE : View.VISIBLE);
        ControlUi.setCardVisible(statusBox, !loading);
        ControlUi.setCardVisible(exitBox, !loading);
        String error = activity.statusError();
        int label = connectionLabel(error == null && activity.statusFresh() ? snapshot : null);
        boolean connected = label == R.string.network_connected;
        int tone = connected ? ControlUi.TONE_OK
                : label == R.string.network_unknown ? ControlUi.TONE_ERROR
                : label == R.string.network_login_needed || label == R.string.network_starting ? ControlUi.TONE_WARN
                : ControlUi.TONE_NEUTRAL;
        int icon = connected ? R.drawable.ic_check_circle
                : label == R.string.network_unknown ? R.drawable.ic_error
                : label == R.string.network_login_needed ? R.drawable.ic_vpn_key
                : label == R.string.network_stopped ? R.drawable.ic_stop : R.drawable.ic_sync;
        health.setTone(tone, icon);
        health.title.setText(s(label == R.string.network_connected ? R.string.web_net_connected : label == R.string.network_stopped ? R.string.web_dash_stopped :
                label == R.string.network_login_needed ? R.string.web_hero_login_title : label == R.string.network_unknown ? R.string.web_net_status_stale : R.string.web_net_connecting));
        String hint = error != null || label == R.string.network_unknown ? s(R.string.web_net_unknown_hint)
                : connected ? "" : label == R.string.network_stopped ? s(R.string.web_net_stopped_hint)
                : label == R.string.network_login_needed ? s(R.string.web_net_login_hint) : s(R.string.web_net_connecting_hint);
        health.hint.setText(hint); health.hint.setVisibility(hint.isEmpty() ? View.GONE : View.VISIBLE);
        health.actions.setVisibility(label == R.string.network_unknown ? View.VISIBLE : View.GONE);
        retryButton.setVisibility(label == R.string.network_unknown ? View.VISIBLE : View.GONE);
        renderLoginHero(!loading && error == null && label == R.string.network_login_needed);
        JSONObject peersObj = snapshot == null ? null : snapshot.optJSONObject("peers");
        if (error == null && peersObj != null && peersObj.opt("online") instanceof Number && peersObj.opt("offline") instanceof Number) {
            int online = peersObj.optInt("online"), offline = peersObj.optInt("offline");
            metricPeers.value.setText(String.valueOf(online));
            metricPeers.unit.setText(" / " + (online + offline));
            metricPeers.sub.setText(offline + " " + s(R.string.web_net_offline_count)); metricPeers.sub.setVisibility(View.VISIBLE);
        } else {
            metricPeers.value.setText("—"); metricPeers.unit.setText(" / —"); metricPeers.sub.setText(s(R.string.web_net_unknown)); metricPeers.sub.setVisibility(View.VISIBLE);
        }
        metricUptime.value.setText(error == null && snapshot != null && snapshot.opt("uptime") instanceof Number ? WebFormat.uptime(snapshot.optLong("uptime")) : "—");
        statusBox.removeAllViews();
        JSONObject self = error == null && snapshot != null ? snapshot.optJSONObject("self") : null;
        if (self == null) hint(statusBox, s(R.string.web_net_address_pending));
        else {
            LinearLayout heading = row(statusBox); heading.setGravity(android.view.Gravity.CENTER_VERTICAL); heading.setPadding(0, 0, 0, dp(18));
            android.widget.ImageView avatar = ControlUi.iconTile(activity, R.drawable.ic_router, 44);
            LinearLayout.LayoutParams avatarParams = new LinearLayout.LayoutParams(dp(44), dp(44)); avatarParams.setMarginEnd(dp(12)); heading.addView(avatar, avatarParams);
            LinearLayout identity = new LinearLayout(activity); identity.setOrientation(LinearLayout.VERTICAL); heading.addView(identity, new LinearLayout.LayoutParams(0, -2, 1));
            android.widget.TextView hostname = ControlUi.text(activity, value(self, "hostname"), 16); hostname.setTypeface(android.graphics.Typeface.create("sans-serif-medium", 0)); identity.addView(hostname);
            android.widget.TextView addressLabel = ControlUi.text(activity, s(R.string.web_net_device_address), 12); addressLabel.setTextColor(com.google.android.material.color.MaterialColors.getColor(addressLabel, com.google.android.material.R.attr.colorOnSurfaceVariant)); addressLabel.setPadding(0, dp(5), 0, 0); identity.addView(addressLabel);
            LinearLayout addresses = new LinearLayout(activity); addresses.setOrientation(LinearLayout.VERTICAL); addresses.setPadding(0, 0, 0, dp(15)); statusBox.addView(addresses);
            for (String ip : PeersPage.addresses(self)) ControlUi.insetRow(addresses, ip, R.drawable.ic_content_copy, () -> copy(s(R.string.web_net_copy_address), ip));
            ControlUi.infoRow(statusBox, s(R.string.web_net_relay_region), textOrDash(self, "relay"), false);
            Object dns = snapshot.opt("magicDns");
            ControlUi.infoRow(statusBox, s(R.string.web_dash_magicdns), dns instanceof Boolean ?
                    s(Boolean.TRUE.equals(dns) ? R.string.web_net_enabled : R.string.web_net_disabled) : s(R.string.web_net_unknown), Boolean.TRUE.equals(dns));
        }
        expiryBox.removeAllViews();
        String expiry = error == null && snapshot != null ? snapshot.optString("keyExpiry", "") : "";
        if (!expiry.isEmpty() && expiresSoon(expiry, System.currentTimeMillis()))
            ControlUi.banner(expiryBox, R.drawable.ic_warning, s(R.string.web_dash_key_expiring) + expiry, ControlUi.TONE_WARN);
        renderExit(snapshot, activity.statusFresh());
    }

    private void renderExit(JSONObject snapshot, boolean fresh) {
        exitBox.removeAllViews();
        JSONObject routing = fresh ? activity.exitRoutingSnapshot() : null;
        JSONObject node = fresh && snapshot != null ? snapshot.optJSONObject("exitNode") : null;
        LinearLayout heading = row(exitBox); heading.setGravity(android.view.Gravity.CENTER_VERTICAL);
        android.widget.ImageView avatar = new android.widget.ImageView(activity); avatar.setImageResource(node == null ? R.drawable.ic_language : R.drawable.ic_logout); avatar.setPadding(dp(10), dp(10), dp(10), dp(10));
        heading.addView(avatar, new LinearLayout.LayoutParams(dp(44), dp(44)));
        LinearLayout identity = new LinearLayout(activity); identity.setOrientation(LinearLayout.VERTICAL); heading.addView(identity, new LinearLayout.LayoutParams(0, -2, 1));
        label(identity, ExitNodesPage.selectedLabel(this, routing)); hint(identity, s(R.string.web_net_exit_selection));
        if (routing != null && "bridge-policy".equals(routing.optString("effective"))) {
            android.widget.TextView dot = ControlUi.textRes(activity, "●", R.dimen.ft_body);
            dot.setTextColor(node != null && Boolean.TRUE.equals(node.opt("online")) ? androidx.core.content.ContextCompat.getColor(activity, R.color.foxy_ok) : com.google.android.material.color.MaterialColors.getColor(dot, com.google.android.material.R.attr.colorOutline));
            dot.setContentDescription(s(node != null && Boolean.TRUE.equals(node.opt("online")) ? R.string.web_net_filter_online : R.string.web_net_filter_offline)); heading.addView(dot);
        }
        int effective = ExitNodesPage.effectiveLabel(routing);
        if (effective != 0) hint(exitBox, s(effective));
        if (routing != null && routing.optJSONObject("selected") != null && "bridge".equals(snapshot.optString("mode")))
            hint(exitBox, s(R.string.web_net_exit_scope) + ": " + routing.optString("scope", "") + " " + ExitNodesPage.scopeUids(routing));
        if (node != null) {
            hint(exitBox, s(R.string.web_net_exit_hint));
            ControlUi.infoRow(exitBox, s(R.string.web_dash_traffic), "↓ " + byteValue(node, "rx") + "   ↑ " + byteValue(node, "tx"), false);
            if (Boolean.FALSE.equals(node.opt("online"))) ControlUi.banner(exitBox, R.drawable.ic_warning, s(R.string.web_net_exit_unavailable), ControlUi.TONE_WARN);
        }
        iconButton(exitBox, R.drawable.ic_chevron_right, s(R.string.web_net_manage_exit), () -> activity.navigate("peers"));
    }
    private String byteValue(JSONObject object, String field) { return object.opt(field) instanceof Number ? WebFormat.bytes(object.optLong(field)) : "—"; }
    static String textOrDash(JSONObject object, String key) {
        Object value = object == null ? null : object.opt(key);
        return value instanceof String && !((String) value).isEmpty() ? (String) value : "—";
    }

    String value(JSONObject object, String key) {
        Object value = object == null ? null : object.opt(key);
        return value == null || value == JSONObject.NULL || value instanceof JSONObject || value instanceof JSONArray
                ? s(R.string.network_unknown) : String.valueOf(value);
    }
    String bool(JSONObject object, String key) {
        Object value = object == null ? null : object.opt(key);
        return s(Boolean.TRUE.equals(value) ? R.string.network_yes : Boolean.FALSE.equals(value) ? R.string.network_no : R.string.network_unknown);
    }
    static boolean stopAvailable(JSONObject value, boolean fresh) {
        return !fresh || value == null || !value.optBoolean("ok") || !"stopped".equals(value.optString("daemon"));
    }
    static boolean serviceKnown(JSONObject value) {
        return value != null && value.optBoolean("ok") && !"unreachable".equals(value.optString("backend")) &&
                ("running".equals(value.optString("daemon")) || "stopped".equals(value.optString("daemon"))) &&
                java.util.Arrays.asList(MODES).contains(value.optString("mode"));
    }
    static int connectionLabel(JSONObject value) {
        if (value == null || !value.optBoolean("ok") || "unreachable".equals(value.optString("backend"))) return R.string.network_unknown;
        if ("stopped".equals(value.optString("daemon"))) return R.string.network_stopped;
        if (!"running".equals(value.optString("daemon"))) return R.string.network_unknown;
        switch (value.optString("backend")) {
            case "Running": return R.string.network_connected;
            case "NeedsLogin": return R.string.network_login_needed;
            case "NeedsMachineAuth": return R.string.network_machine_auth;
            case "Starting": case "NoState": return R.string.network_starting;
            default: return R.string.network_unknown;
        }
    }
    static boolean expiresSoon(String date, long now) {
        try { return Instant.parse(date).toEpochMilli() - now < 7L * 24 * 60 * 60 * 1000; }
        catch (java.time.format.DateTimeParseException | ArithmeticException invalid) { return false; }
    }
    private void renderLoginHero(boolean needed) {
        ControlUi.setCardVisible(loginHero, needed);
        if (!needed) { heroDismissed = false; loginUrl = null; authKey.setText(""); loginResult.setVisibility(View.GONE); authFields.setVisibility(View.GONE); return; }
        loginBody.removeAllViews();
        if (heroDismissed) {
            hint(loginBody, s(R.string.web_hero_banner_login));
            iconButton(loginBody, R.drawable.ic_expand_more, s(R.string.web_hero_expand), () -> { heroDismissed = false; renderLoginHero(true); });
            loginResult.setVisibility(View.GONE); authFields.setVisibility(View.GONE); return;
        }
        iconButton(loginBody, R.drawable.ic_expand_less, s(R.string.web_hero_minimize), () -> { heroDismissed = true; renderLoginHero(true); });
        hint(loginBody, s(R.string.web_net_login_secure)); label(loginBody, s(R.string.web_hero_login_title));
        hint(loginBody, s(R.string.web_hero_login_desc));
        LinearLayout actions = row(loginBody);
        primary(actions, s(R.string.web_hero_get_link), R.drawable.ic_login, () -> guardedLogin(this::getLoginLink));
        iconButton(actions, R.drawable.ic_vpn_key, s(R.string.web_acc_authkey), () -> authFields.setVisibility(authFields.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE));
        if (loginUrl != null) loginResult.setVisibility(View.VISIBLE);
    }
    private void guardedLogin(Runnable action) {
        if (!activity.client.canWrite()) { notice(activity.client.message()); return; }
        if (loginBusy || activity.client.busy() || !activity.statusFresh() || activity.statusError() != null || connectionLabel(activity.statusSnapshot()) != R.string.network_login_needed) return;
        confirm(s(R.string.web_hero_login_title), s(R.string.network_account_interrupt), () -> {
            if (loginBusy || activity.client.busy()) return;
            loginBusy = true;
            read(history -> {
                try {
                    if (AccountPage.hasActiveTransfers(history)) { loginBusy = false; notice(s(R.string.network_transfer_active)); return; }
                    action.run();
                } catch (org.json.JSONException invalid) { loginBusy = false; error(invalid); }
            }, failure -> { loginBusy = false; error(failure); }, "file-send-history");
        });
    }
    private void getLoginLink() {
        if (!activity.client.canWrite() || activity.client.busy()) { loginBusy = false; return; }
        loginUrl = null; loginResult.setVisibility(View.GONE); loginState.setText(s(R.string.web_acc_waiting)); loginState.setVisibility(View.VISIBLE);
        read(result -> {
            loginBusy = false; loginState.setVisibility(View.GONE); activity.invalidateAccountState();
            Object url = result.opt("url");
            if (result.optBoolean("ok") && url instanceof String && AccountPage.validServer((String) url)) {
                loginUrl = (String) url; loginUrlText.setText(loginUrl); loginResult.setVisibility(View.VISIBLE);
            } else if (result.optBoolean("ok") && result.optBoolean("already")) { notice(s(R.string.web_acc_already)); activity.refreshStatus(); }
            else error(new IllegalArgumentException(result.optString("error", s(R.string.web_error))));
        }, failure -> { loginBusy = false; loginState.setVisibility(View.GONE); error(failure); }, "login");
    }
    @Override void onPause() { loginBusy = false; authKey.setText(""); }
    @Override void onClose() { authKey.setText(""); loginUrl = null; }
}
