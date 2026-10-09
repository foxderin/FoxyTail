package dev.foxderin.tail;

import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.time.Instant;

final class OverviewPage extends ControlPage {
    private final LinearLayout statusBox, compatibility, iconHost;
    private View accent;
    private final TextView state, feedback, supporting;
    private ControlUi.MetricTile metricPeers, metricUptime;
    private final Button loginButton, retryButton;
    private JSONObject snapshot;
    private boolean fresh, reading;
    private java.util.function.Consumer<JSONObject> queuedAfter;
    private int sequence;
    static final String[] MODES = {"tun", "bridge", "proxy"};

    OverviewPage(ControlActivity activity) {
        super(activity);
        LinearLayout heroBox = ControlUi.hero(content);
        accent = ControlUi.accentStrip(heroBox);
        LinearLayout head = new LinearLayout(activity); head.setOrientation(LinearLayout.HORIZONTAL); head.setGravity(android.view.Gravity.TOP);
        iconHost = new LinearLayout(activity); head.addView(iconHost, new LinearLayout.LayoutParams(-2, -2));
        LinearLayout col = new LinearLayout(activity); col.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams colParams = new LinearLayout.LayoutParams(0, -2, 1); colParams.setMarginStart(dp(14));
        head.addView(col, colParams);
        state = ControlUi.text(activity, s(R.string.network_unknown), 20);
        state.setTypeface(null, android.graphics.Typeface.BOLD); state.setPadding(0, 0, 0, 0);
        col.addView(state, new LinearLayout.LayoutParams(-1, -2));
        supporting = ControlUi.muted(activity, "", 14); supporting.setPadding(0, dp(2), 0, 0);
        col.addView(supporting, new LinearLayout.LayoutParams(-1, -2));
        heroBox.addView(head, new LinearLayout.LayoutParams(-1, -2));
        feedback = ControlUi.muted(activity, "", 14); feedback.setPadding(0, dp(8), 0, 0);
        heroBox.addView(feedback, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout actions = new LinearLayout(activity); actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(0, dp(12), 0, 0);
        retryButton = ControlUi.button(activity, s(R.string.network_refresh), R.drawable.ic_refresh, () -> { if (isCurrent()) refresh(null); });
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(-2, -2); retryParams.setMarginEnd(dp(8));
        actions.addView(retryButton, retryParams);
        loginButton = ControlUi.button(activity, s(R.string.network_login), R.drawable.ic_login, () -> { if (isCurrent()) activity.navigate("account"); });
        loginButton.setVisibility(View.GONE); actions.addView(loginButton, new LinearLayout.LayoutParams(-2, -2));
        heroBox.addView(actions, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout tiles = new LinearLayout(activity); tiles.setOrientation(LinearLayout.HORIZONTAL);
        tiles.setPadding(0, 0, 0, dp(2)); content.addView(tiles, new LinearLayout.LayoutParams(-1, -2));
        metricPeers = metric(tiles, R.drawable.ic_group, s(R.string.network_peers));
        metricUptime = metric(tiles, R.drawable.ic_monitoring, s(R.string.network_uptime));
        statusBox = section(s(R.string.network_self));
        compatibility = new LinearLayout(activity); compatibility.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams compatTitleParams = new LinearLayout.LayoutParams(-1, -2);
        compatTitleParams.setMarginStart(dp(6)); compatTitleParams.topMargin = dp(10);
        content.addView(ControlUi.cardTitle(activity, s(R.string.network_compat)), compatTitleParams);
        content.addView(compatibility, new LinearLayout.LayoutParams(-1, -2));
        content.addView(ControlUi.cardTitle(activity, s(R.string.nav_quick_access)), compatTitleParamsCopy());
        LinearLayout gridA = new LinearLayout(activity); gridA.setOrientation(LinearLayout.HORIZONTAL);
        content.addView(gridA, new LinearLayout.LayoutParams(-1, -2));
        quickCard(gridA, R.drawable.ic_group, s(R.string.control_peers), s(R.string.quick_peers_desc), () -> activity.navigate("peers"));
        quickCard(gridA, R.drawable.ic_alt_route, s(R.string.control_routing), s(R.string.quick_routing_desc), () -> activity.navigate("routing"));
        LinearLayout gridB = new LinearLayout(activity); gridB.setOrientation(LinearLayout.HORIZONTAL);
        content.addView(gridB, new LinearLayout.LayoutParams(-1, -2));
        quickCard(gridB, R.drawable.ic_router, s(R.string.control_tunnel), s(R.string.quick_tunnel_desc), () -> activity.navigate("tunnel"));
        quickCard(gridB, R.drawable.ic_article, s(R.string.control_logs), s(R.string.quick_logs_desc), () -> activity.navigate("logs"));
        repeat(() -> { if (!reading) refresh(null); }, 15000);
        renderState(R.string.network_unknown, "", ControlUi.BADGE_NEUTRAL, R.drawable.ic_info);
    }
    private LinearLayout.LayoutParams compatTitleParamsCopy() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMarginStart(dp(6)); params.topMargin = dp(10);
        return params;
    }
    private void renderState(int label, String detail, int tone, int icon) {
        ControlUi.toneAccent(accent, activity, tone);
        state.setText(s(label));
        supporting.setText(detail); supporting.setVisibility(detail.isEmpty() ? View.GONE : View.VISIBLE);
        iconHost.removeAllViews();
        iconHost.addView(ControlUi.statusIcon(activity, icon, tone), new LinearLayout.LayoutParams(-2, -2));
        loginButton.setVisibility(label == R.string.network_login_needed ? View.VISIBLE : View.GONE);
    }

    @Override String title() { return s(R.string.network_overview); }
    @Override void load() {
        refresh(null);
        read(result -> {
            compatibility.removeAllViews();
            JSONArray warnings = result.optJSONArray("warnings");
            if (warnings == null) { ControlUi.banner(compatibility, R.drawable.ic_error, s(R.string.network_unknown)); return; }
            int count = 0;
            for (int i = 0; i < warnings.length(); i++) {
                if (warnings.opt(i) instanceof String) { ControlUi.banner(compatibility, R.drawable.ic_warning, warnings.optString(i)); count++; }
            }
            String alert = result.optString("alert", "");
            if (!alert.isEmpty()) { ControlUi.banner(compatibility, R.drawable.ic_warning, alert); count++; }
            if (count == 0) ControlUi.banner(compatibility, R.drawable.ic_check_circle, s(R.string.network_compat_ok));
        }, failure -> { compatibility.removeAllViews(); ControlUi.banner(compatibility, R.drawable.ic_error, s(R.string.network_stale)); error(failure); }, "compat");
    }

    private void refresh(java.util.function.Consumer<JSONObject> after) {
        if (reading) { if (after != null) queuedAfter = after; return; }
        final int request = ++sequence;
        reading = true;
        read(result -> {
            if (request != sequence) return;
            reading = false; fresh = true; snapshot = result;
            render();
            if (after != null) after.accept(result);
            followUp();
        }, failure -> {
            if (request != sequence) return;
            reading = false; fresh = false;
            renderState(R.string.network_stale, "", ControlUi.BADGE_ERROR, R.drawable.ic_error);
            error(failure);
            if (after != null) after.accept(null);
            followUp();
        }, "status");
    }
    private void followUp() {
        java.util.function.Consumer<JSONObject> after = queuedAfter; queuedAfter = null;
        if (after != null) refresh(after);
    }
    @Override void onPause() { reading = false; fresh = false; queuedAfter = null; sequence++; }

    private void render() {
        int label = connectionLabel(snapshot);
        String detail = value(snapshot, "daemon") + " · " + value(snapshot, "backend") + " · " + value(snapshot, "mode");
        int tone = label == R.string.network_connected ? ControlUi.BADGE_OK : label == R.string.network_unknown ? ControlUi.BADGE_ERROR : ControlUi.BADGE_NEUTRAL;
        int icon = label == R.string.network_connected ? R.drawable.ic_check_circle
                : label == R.string.network_unknown ? R.drawable.ic_error
                : label == R.string.network_login_needed ? R.drawable.ic_vpn_key
                : label == R.string.network_stopped ? R.drawable.ic_info : R.drawable.ic_warning;
        renderState(label, detail, tone, icon);
        JSONObject peersObj = snapshot.optJSONObject("peers");
        boolean connected = label == R.string.network_connected;
        if (connected && peersObj != null && peersObj.opt("online") instanceof Number && peersObj.opt("offline") instanceof Number) {
            int online = peersObj.optInt("online"), offline = peersObj.optInt("offline");
            metricPeers.value.setText(online + " / " + (online + offline));
            metricPeers.sub.setText(s(R.string.network_offline_count, offline)); metricPeers.sub.setVisibility(View.VISIBLE);
        } else { metricPeers.value.setText("—"); metricPeers.sub.setVisibility(View.GONE); }
        metricUptime.value.setText(compactUptime(value(snapshot, "uptime")));
        statusBox.removeAllViews();
        JSONObject self = snapshot.optJSONObject("self");
        if (self == null) label(statusBox, s(R.string.network_unknown));
        else {
            label(statusBox, value(self, "hostname"));
            for (String ip : PeersPage.addresses(self)) ControlUi.insetRow(statusBox, ip, R.drawable.ic_content_copy, () -> copy(ip, ip));
            ControlUi.infoRow(statusBox, s(R.string.network_region), value(self, "relay"), false);
            boolean dns = Boolean.TRUE.equals(snapshot.opt("magicDns"));
            ControlUi.infoRow(statusBox, "Tailnet MagicDNS", s(dns ? R.string.network_enabled : R.string.network_disabled), connected && dns);
        }
        String expiry = snapshot.optString("keyExpiry", "");
        if (!expiry.isEmpty() && !"null".equals(expiry)) {
            label(statusBox, s(R.string.network_key_expiry, expiry));
            if (expiresSoon(expiry, System.currentTimeMillis())) label(statusBox, s(R.string.network_key_soon));
        }
        JSONObject routing = snapshot.optJSONObject("exitRouting");
        label(statusBox, s(R.string.network_selected) + ": " + ExitNodesPage.selectedLabel(this, routing));
        label(statusBox, s(R.string.network_effective) + ": " + s(ExitNodesPage.effectiveLabel(routing)));
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
    static String compactUptime(String raw) {
        try {
            long seconds = Long.parseLong(raw.trim());
            if (seconds < 0) return "—";
            if (seconds < 60) return "<1m";
            if (seconds < 3600) return seconds / 60 + "m";
            if (seconds < 172800) { long minutes = seconds % 3600 / 60; return seconds / 3600 + "h" + (minutes > 0 ? " " + minutes + "m" : ""); }
            long hours = seconds % 86400 / 3600; return seconds / 86400 + "d" + (hours > 0 ? " " + hours + "h" : "");
        } catch (NumberFormatException invalid) { return "—"; }
    }
}
