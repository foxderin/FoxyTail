package dev.foxderin.tail;

import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import org.json.JSONArray;
import org.json.JSONObject;
import java.time.Instant;

/* Dashboard: renders the shared status store; owns no private status reads. */
final class OverviewPage extends ControlPage {
    private final LinearLayout statusBox, compatibility, skeleton, tilesRow, statusContent;
    private final ControlUi.HealthCard health;
    private final Button loginButton, retryButton;
    private ControlUi.MetricTile metricPeers, metricUptime;
    static final String[] MODES = {"tun", "bridge", "proxy"};

    OverviewPage(ControlActivity activity) {
        super(activity);
        health = ControlUi.healthCard(content);
        retryButton = ControlUi.button(activity, s(R.string.network_refresh), R.drawable.ic_refresh, () -> { if (isCurrent()) activity.refreshStatus(); });
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(-2, -2); retryParams.setMarginEnd(dp(8));
        health.actions.addView(retryButton, retryParams);
        loginButton = ControlUi.button(activity, s(R.string.network_login), R.drawable.ic_login, () -> { if (isCurrent()) activity.navigate("account"); });
        health.actions.addView(loginButton, new LinearLayout.LayoutParams(-2, -2));
        LinearLayout tiles = new LinearLayout(activity); tiles.setOrientation(LinearLayout.HORIZONTAL);
        tiles.setPadding(0, 0, 0, dp(2)); content.addView(tiles, new LinearLayout.LayoutParams(-1, -2));
        tilesRow = tiles;
        metricPeers = metric(tiles, R.drawable.ic_group, s(R.string.network_peers));
        metricUptime = metric(tiles, R.drawable.ic_monitoring, s(R.string.network_uptime));
        statusBox = section(s(R.string.network_self));
        statusContent = new LinearLayout(activity); statusContent.setOrientation(LinearLayout.VERTICAL);
        statusBox.addView(statusContent, new LinearLayout.LayoutParams(-1, -2));
        compatibility = new LinearLayout(activity); compatibility.setOrientation(LinearLayout.VERTICAL);
        content.addView(ControlUi.cardTitle(activity, s(R.string.network_compat)), sectionTitleParams());
        content.addView(compatibility, new LinearLayout.LayoutParams(-1, -2));
        content.addView(ControlUi.cardTitle(activity, s(R.string.nav_quick_access)), sectionTitleParams());
        LinearLayout gridA = new LinearLayout(activity); gridA.setOrientation(LinearLayout.HORIZONTAL);
        content.addView(gridA, new LinearLayout.LayoutParams(-1, -2));
        quickCard(gridA, R.drawable.ic_group, s(R.string.control_peers), s(R.string.quick_peers_desc), () -> activity.navigate("peers"));
        quickCard(gridA, R.drawable.ic_alt_route, s(R.string.control_routing), s(R.string.quick_routing_desc), () -> activity.navigate("routing"));
        LinearLayout gridB = new LinearLayout(activity); gridB.setOrientation(LinearLayout.HORIZONTAL);
        content.addView(gridB, new LinearLayout.LayoutParams(-1, -2));
        quickCard(gridB, R.drawable.ic_router, s(R.string.control_tunnel), s(R.string.quick_tunnel_desc), () -> activity.navigate("tunnel"));
        quickCard(gridB, R.drawable.ic_article, s(R.string.control_logs), s(R.string.quick_logs_desc), () -> activity.navigate("logs"));
        skeleton = new LinearLayout(activity); skeleton.setOrientation(LinearLayout.VERTICAL);
        content.addView(skeleton, 0, new LinearLayout.LayoutParams(-1, -2));
        ControlUi.skeleton(skeleton, 1f, 112);
        ControlUi.skeleton(skeleton, 0.45f, 20);
        activity.addStatusListener(snapshot -> { if (isCurrent()) render(snapshot); });
        render(activity.statusEverLoaded() ? activity.statusSnapshot() : null);
    }
    private LinearLayout.LayoutParams sectionTitleParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMarginStart(dp(6)); params.topMargin = dp(10);
        return params;
    }

    @Override String title() { return s(R.string.network_overview); }
    @Override void load() {
        activity.refreshStatus();
        read(result -> {
            compatibility.removeAllViews();
            JSONArray warnings = result.optJSONArray("warnings");
            if (warnings == null) { ControlUi.banner(compatibility, R.drawable.ic_error, s(R.string.network_unknown), ControlUi.TONE_ERROR); return; }
            int count = 0;
            for (int i = 0; i < warnings.length(); i++) {
                if (warnings.opt(i) instanceof String) { ControlUi.banner(compatibility, R.drawable.ic_warning, warnings.optString(i), ControlUi.TONE_WARN); count++; }
            }
            String alert = result.optString("alert", "");
            if (!alert.isEmpty()) { ControlUi.banner(compatibility, R.drawable.ic_warning, alert, ControlUi.TONE_WARN); count++; }
            if (count == 0) ControlUi.banner(compatibility, R.drawable.ic_check_circle, s(R.string.network_compat_ok), ControlUi.TONE_OK);
        }, failure -> { compatibility.removeAllViews(); ControlUi.banner(compatibility, R.drawable.ic_error, s(R.string.network_stale), ControlUi.TONE_ERROR); error(failure); }, "compat");
    }

    private void render(JSONObject snapshot) {
        boolean loading = !activity.statusEverLoaded();
        skeleton.setVisibility(loading ? View.VISIBLE : View.GONE);
        health.setVisible(!loading);
        tilesRow.setVisibility(loading ? View.GONE : View.VISIBLE);
        ((View) statusBox.getParent()).setVisibility(loading ? View.GONE : View.VISIBLE);
        String error = activity.statusError();
        int label = connectionLabel(error == null ? snapshot : null);
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
        health.title.setText(s(label));
        String hint = error != null ? s(R.string.network_hint_unknown)
                : connected ? ""
                : value(snapshot, "daemon") + " · " + value(snapshot, "backend") + " · " + value(snapshot, "mode");
        health.hint.setText(hint); health.hint.setVisibility(hint.isEmpty() ? View.GONE : View.VISIBLE);
        health.actions.setVisibility(connected ? View.GONE : View.VISIBLE);
        loginButton.setVisibility(label == R.string.network_login_needed ? View.VISIBLE : View.GONE);
        JSONObject peersObj = snapshot == null ? null : snapshot.optJSONObject("peers");
        if (connected && peersObj != null && peersObj.opt("online") instanceof Number && peersObj.opt("offline") instanceof Number) {
            int online = peersObj.optInt("online"), offline = peersObj.optInt("offline");
            metricPeers.value.setText(String.valueOf(online));
            metricPeers.unit.setText(" / " + (online + offline));
            metricPeers.sub.setText(s(R.string.network_offline_count, offline)); metricPeers.sub.setVisibility(View.VISIBLE);
        } else {
            metricPeers.value.setText("—"); metricPeers.unit.setText(""); metricPeers.sub.setVisibility(View.GONE);
        }
        metricUptime.value.setText(compactUptime(value(snapshot, "uptime")));
        statusContent.removeAllViews();
        JSONObject self = snapshot == null ? null : snapshot.optJSONObject("self");
        if (self == null) label(statusContent, s(R.string.network_unknown));
        else {
            label(statusContent, value(self, "hostname"));
            for (String ip : PeersPage.addresses(self)) ControlUi.insetRow(statusContent, ip, R.drawable.ic_content_copy, () -> copy(ip, ip));
            ControlUi.infoRow(statusContent, s(R.string.network_region), value(self, "relay"), false);
            boolean dns = Boolean.TRUE.equals(snapshot.opt("magicDns"));
            ControlUi.infoRow(statusContent, "Tailnet MagicDNS", s(dns ? R.string.network_enabled : R.string.network_disabled), connected && dns);
        }
        String expiry = snapshot == null ? "" : snapshot.optString("keyExpiry", "");
        if (!expiry.isEmpty() && !"null".equals(expiry)) {
            label(statusContent, s(R.string.network_key_expiry, expiry));
            if (expiresSoon(expiry, System.currentTimeMillis())) label(statusContent, s(R.string.network_key_soon));
        }
        JSONObject routing = snapshot == null ? null : snapshot.optJSONObject("exitRouting");
        label(statusContent, s(R.string.network_selected) + ": " + ExitNodesPage.selectedLabel(this, routing));
        label(statusContent, s(R.string.network_effective) + ": " + s(ExitNodesPage.effectiveLabel(routing)));
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
