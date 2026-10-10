package dev.foxderin.tail;

import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

final class TunnelPage extends ControlPage {
    private final LinearLayout tunBox, dnsBox, derpBox, socksBox;
    private final TextView tunState, socksResult;
    private final Button socks, dnsCheck;
    private JSONObject tun;
    private boolean reading, dnsReading, dnsAgain;

    TunnelPage(ControlActivity activity) {
        super(activity);
        LinearLayout actions = row(content); ((LinearLayout.LayoutParams) actions.getLayoutParams()).bottomMargin = dp(20);
        button(actions, s(R.string.web_tun_derp), R.drawable.ic_speed, this::measureDerp);
        socks = button(actions, s(R.string.web_tun_socks_check), R.drawable.ic_network_check, this::checkSocks);
        socks.setEnabled(false); socks.setVisibility(View.GONE);
        LinearLayout overview = section(s(R.string.web_tools_tunnel_overview), R.drawable.ic_router, null);
        ControlUi.cardAction(overview, textButton(overview, s(R.string.web_tools_refresh), this::refresh));
        tunState = label(overview, s(R.string.web_loading));
        tunBox = row(overview); tunBox.setOrientation(LinearLayout.VERTICAL);
        LinearLayout dns = section(s(R.string.web_dns_title), R.drawable.ic_dns, null);
        dnsBox = row(dns); dnsBox.setOrientation(LinearLayout.VERTICAL);
        ControlUi.emptyState(dnsBox, s(R.string.web_tools_dns_unchecked), R.drawable.ic_dns);
        dnsCheck = tonal(dns, s(R.string.web_dns_check), this::checkDns);
        textButton(dns, s(R.string.web_tools_dns_settings) + " ›", () -> activity.navigate("settings"));
        embed(new CoexistPage(activity));
        socksBox = section(s(R.string.web_tun_socks_check), R.drawable.ic_network_check, null);
        socksResult = label(socksBox, ""); ControlUi.setCardVisible(socksBox, false);
        derpBox = section(s(R.string.web_tun_derp), R.drawable.ic_speed, null); ControlUi.setCardVisible(derpBox, false);
        repeat(this::refresh, 15000);
    }
    @Override String title() { return s(R.string.web_tun_title); }
    @Override void load() { refresh(); }
    @Override void onPause() { reading = false; dnsReading = false; dnsAgain = false; socks.setEnabled(false); dnsCheck.setEnabled(true); }
    private void refresh() {
        if (reading) return; reading = true;
        read(status -> read(result -> {
            reading = false; tun = result; tunState.setVisibility(View.GONE); tunBox.removeAllViews();
            String mode = result.optString("mode", "");
            if (!"bridge".equals(mode)) hint(tunBox, s("tun".equals(mode) ? R.string.web_tools_tun_desc : "proxy".equals(mode) ? R.string.web_tools_proxy_desc : R.string.web_net_unknown));
            LinearLayout metrics = row(tunBox);
            ControlUi.MetricTile iface = metric(metrics, R.drawable.ic_router, s(R.string.web_tun_iface));
            Object up = result.opt("ifaceUp"); iface.value.setText(up instanceof Boolean ? s(Boolean.TRUE.equals(up) ? R.string.web_tun_up : R.string.web_tun_down) : "—");
            iface.sub.setText("tailscale0"); iface.sub.setVisibility(View.VISIBLE);
            ControlUi.MetricTile gateway = metric(metrics, R.drawable.ic_alt_route, s(R.string.web_tun_gateway));
            gateway.value.setText(OverviewPage.textOrDash(result, "gateway"));
            if ("bridge".equals(mode)) {
                Object pid = result.opt("hevPid");
                ControlUi.infoRow(tunBox, s(R.string.web_tun_hev), pid instanceof Number && ((Number) pid).longValue() > 0 ? "PID " + pid : pid == JSONObject.NULL ? s(R.string.web_tun_not_running) : "—", pid instanceof Number && ((Number) pid).longValue() > 0);
            }
            textButton(tunBox, s(R.string.web_more_routing) + " ›", () -> activity.navigate("routing"));
            boolean supportsSocks = "bridge".equals(mode) || "proxy".equals(mode);
            socks.setVisibility(supportsSocks ? View.VISIBLE : View.GONE); socks.setEnabled(supportsSocks && socksEndpoint(result) != null);
            if (!supportsSocks) ControlUi.setCardVisible(socksBox, false);
        }, this::tunFailed, "tun"), this::tunFailed, "status");
    }
    private void tunFailed(Exception failure) {
        reading = false; tunState.setVisibility(View.VISIBLE); tunState.setText(s(R.string.web_net_status_stale));
        socks.setEnabled(false); tunBox.removeAllViews(); textButton(tunBox, s(R.string.web_retry), this::refresh); error(failure);
    }
    private void checkDns() {
        if (dnsReading) { dnsAgain = true; return; }
        dnsReading = true; dnsCheck.setEnabled(false); dnsCheck.setText(s(R.string.web_loading));
        read(result -> {
            dnsReading = false; dnsCheck.setEnabled(true); dnsCheck.setText(s(R.string.web_tools_dns_check_again)); dnsBox.removeAllViews();
            if (!result.optBoolean("ok")) {
                ControlUi.banner(dnsBox, R.drawable.ic_error, result.optString("error", s(R.string.web_error)), ControlUi.TONE_ERROR);
            } else {
                LinearLayout resultBox = ControlUi.result(dnsBox);
                badge(resultBox, s(dnsLabel(result)), dnsTone(result));
                if (!modernDns(result)) {
                    String path = ipv6DnsPathLabel(result);
                    if (path != null) {
                        ControlUi.infoRow(resultBox, s(R.string.web_tools_dns_ipv6_path), path, false);
                        if ("fallback".equals(result.optString("ipv6DnsInterception"))) hint(resultBox, s(R.string.web_tools_dns_ipv6_fallback_hint));
                    }
                    Object nativeDns = result.opt("upstreamNative");
                    ControlUi.infoRow(resultBox, s(R.string.web_dns_native), nativeDns instanceof Boolean ? s(Boolean.TRUE.equals(nativeDns) ? R.string.web_tools_dns_native_yes : R.string.web_tools_dns_native_no) : "—", false);
                }
                String endpoint = dnsEndpoint(result);
                if (endpoint != null) {
                    ControlUi.infoRow(resultBox, s(R.string.web_tools_dns_endpoint), endpoint, false);
                    hint(resultBox, s(R.string.web_tools_dns_endpoint_hint));
                    textButton(resultBox, s(R.string.web_tools_dns_endpoint_copy), () -> copy(s(R.string.web_tools_dns_endpoint), endpoint));
                }
                if ("transparent".equals(result.optString("mode")) && Boolean.TRUE.equals(result.opt("listenerReady")))
                    hint(resultBox, s("transparent-unavailable".equals(result.optString("reason")) ? R.string.web_tools_dns_transparent_unavailable : R.string.web_tools_dns_transparent_limit));
                if (result.opt("suffix") instanceof String && !result.optString("suffix").isEmpty()) ControlUi.infoRow(resultBox, s(R.string.web_dns_suffix), result.optString("suffix"), false);
            }
            if (dnsAgain) { dnsAgain = false; checkDns(); }
        }, failure -> {
            dnsReading = false; dnsCheck.setEnabled(true); dnsCheck.setText(s(R.string.web_tools_dns_check_again));
            dnsBox.removeAllViews(); ControlUi.banner(dnsBox, R.drawable.ic_error, s(R.string.web_net_status_stale), ControlUi.TONE_ERROR); error(failure);
            if (dnsAgain) { dnsAgain = false; checkDns(); }
        }, "dns");
    }
    private void checkSocks() {
        if (!socks.isEnabled() || socksEndpoint(tun) == null) return;
        socksBox.removeAllViews(); ControlUi.setCardVisible(socksBox, true);
        ControlUi.infoRow(socksBox, "SOCKS5", socksEndpoint(tun), false);
        socksBox.addView(socksResult); socksResult.setText(s(R.string.web_tun_socks_checking));
        probe(s(R.string.web_tun_socks_check), result -> {
            boolean valid = result.opt("success") instanceof Boolean && result.opt("elapsedMs") instanceof Number && result.opt("httpCode") instanceof String;
            if (!result.optBoolean("ok") || !valid) socksResult.setText(s(R.string.web_tun_socks_fail) + ": " + result.optString("error", s(R.string.web_net_peer_probe_invalid)));
            else socksResult.setText(s(result.optBoolean("success") ? R.string.web_tun_socks_ok : R.string.web_tun_socks_fail) +
                    " · HTTP " + result.optString("httpCode") + " · " + result.optLong("elapsedMs") + "ms" +
                    (result.has("error") && !result.isNull("error") ? "\n" + result.optString("error") : ""));
        }, "socks-check");
    }
    private void measureDerp() {
        derpBox.removeAllViews(); ControlUi.setCardVisible(derpBox, true); hint(derpBox, s(R.string.web_tun_derp_testing));
        probe(s(R.string.web_tun_derp), result -> {
            derpBox.removeAllViews(); JSONArray relays = result.optJSONArray("relays");
            if (!result.optBoolean("ok") || relays == null) {
                ControlUi.banner(derpBox, R.drawable.ic_error, result.optString("error", s(R.string.web_net_peer_probe_invalid)), ControlUi.TONE_ERROR); return;
            }
            if (relays.length() == 0) { ControlUi.setCardVisible(derpBox, false); return; }
            String preferred = result.optString("preferred", "");
            for (int i = 0; i < relays.length(); i++) {
                JSONObject relay = relays.optJSONObject(i);
                if (relay == null) { hint(derpBox, s(R.string.web_net_peer_probe_invalid)); continue; }
                Object ms = relay.opt("latencyMs"); String code = OverviewPage.textOrDash(relay, "code");
                LinearLayout line = row(derpBox); line.setGravity(android.view.Gravity.CENTER_VERTICAL);
                TextView name = ControlUi.textRes(activity, code, R.dimen.ft_body); name.setTypeface(android.graphics.Typeface.MONOSPACE); line.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
                if (code.equals(preferred)) badge(line, s(R.string.web_tun_preferred), ControlUi.TONE_ACCENT);
                boolean valid = ms instanceof Number && Double.isFinite(((Number) ms).doubleValue()) && ((Number) ms).doubleValue() >= 0;
                TextView latency = ControlUi.textRes(activity, valid ? ms + " ms" : "—", R.dimen.ft_body); line.addView(latency);
                if (valid) latency.setTextColor(((Number) ms).doubleValue() < 100 ? androidx.core.content.ContextCompat.getColor(activity, R.color.foxy_ok) : ((Number) ms).doubleValue() <= 300 ? com.google.android.material.color.MaterialColors.getColor(latency, com.google.android.material.R.attr.colorTertiary) : androidx.core.content.ContextCompat.getColor(activity, R.color.foxy_error));
            }
        }, "derp-speedtest");
    }
    private String ipv6DnsPathLabel(JSONObject data) {
        int path;
        switch (data.optString("ipv6DnsInterception")) {
            case "available": path = R.string.web_tools_dns_ipv6_native; break;
            case "module-loaded": path = R.string.web_tools_dns_ipv6_module; break;
            case "fallback": path = R.string.web_tools_dns_ipv6_fallback; break;
            case "disabled": path = R.string.web_tools_dns_ipv6_disabled; break;
            default: return null;
        }
        int detail = 0;
        if ("fallback".equals(data.optString("ipv6DnsInterception"))) switch (data.optString("ipv6ModuleStatus")) {
            case "missing": detail = R.string.web_tools_dns_ipv6_module_missing; break;
            case "load-failed": detail = R.string.web_tools_dns_ipv6_module_failed; break;
            case "loader-unavailable": detail = R.string.web_tools_dns_ipv6_loader_missing; break;
            case "not-checked": detail = R.string.web_tools_dns_ipv6_module_unchecked; break;
        }
        return s(path) + (detail == 0 ? "" : " (" + s(detail) + ")");
    }
    private static int dnsTone(JSONObject data) {
        if (modernDns(data)) {
            if ("stopped".equals(data.optString("state")) && Boolean.FALSE.equals(data.opt("enabled"))) return ControlUi.BADGE_NEUTRAL;
            return dnsReady(data) && ("local".equals(data.optString("mode")) || Boolean.TRUE.equals(data.opt("interception4"))) ? ControlUi.BADGE_OK : ControlUi.TONE_WARN;
        }
        return "degraded".equals(data.optString("state")) || "ipv6-unavailable".equals(data.optString("reason")) && !"fallback".equals(data.optString("ipv6DnsInterception")) ? ControlUi.TONE_WARN : "running".equals(data.optString("state")) ? ControlUi.BADGE_OK : ControlUi.BADGE_NEUTRAL;
    }
    static String socksEndpoint(JSONObject data) {
        if (data == null) return null;
        Object port = data.opt("socksPort");
        if (!(port instanceof Number) || ((Number) port).doubleValue() != ((Number) port).intValue()) return null;
        int value = ((Number) port).intValue(); return value > 0 && value <= 65535 ? "127.0.0.1:" + value : null;
    }
    static String dnsEndpoint(JSONObject data) {
        if (!modernDns(data) || !Boolean.TRUE.equals(data.opt("listenerReady"))) return null;
        Object port = data.opt("port");
        if (!(port instanceof Number) || ((Number) port).doubleValue() != ((Number) port).intValue()) return null;
        int value = ((Number) port).intValue(); return value > 0 && value <= 65535 ? "127.0.0.1:" + value : null;
    }
    static boolean modernDns(JSONObject data) { return "local".equals(data.optString("mode")) || "transparent".equals(data.optString("mode")); }
    static boolean dnsReady(JSONObject data) {
        String reason = data.optString("reason");
        return Boolean.TRUE.equals(data.opt("listenerReady")) && "running".equals(data.optString("state")) &&
                Boolean.FALSE.equals(data.opt("repairNeeded")) && "owned".equals(data.optString("policyState")) &&
                Boolean.TRUE.equals(data.opt("enabled")) && ("local".equals(data.optString("mode")) ? "local".equals(reason) : "running".equals(reason) || "ipv6-unavailable".equals(reason));
    }
    static int dnsLabel(JSONObject data) {
        String reason = data.optString("reason", "");
        if (modernDns(data)) {
            if ("missing-binary".equals(reason)) return R.string.web_tools_dns_helper_missing;
            if (!reason.isEmpty() && !java.util.Arrays.asList("running", "local", "transparent-unavailable", "ipv6-unavailable").contains(reason)) return dnsReason(reason, R.string.web_dns_degraded);
            if (!Boolean.TRUE.equals(data.opt("listenerReady"))) return R.string.web_tools_dns_listener_unready;
            if ("local".equals(data.optString("mode"))) return dnsReady(data) ? R.string.web_tools_dns_local_ready : R.string.web_dns_degraded;
            if (dnsReady(data) && Boolean.TRUE.equals(data.opt("interception4"))) return Boolean.TRUE.equals(data.opt("interception6")) ? R.string.web_tools_dns_transparent_ready : R.string.web_tools_dns_transparent_ipv4;
            return "transparent-unavailable".equals(reason) ? R.string.web_tools_dns_local_only : R.string.web_tools_dns_transparent_inactive;
        }
        if (reason.isEmpty() || "fallback".equals(data.optString("ipv6DnsInterception")) && "ipv6-unavailable".equals(reason)) reason = data.optString("state");
        return dnsReason(reason, R.string.web_net_unknown);
    }
    private static int dnsReason(String reason, int fallback) {
        switch (reason) {
            case "running": return R.string.web_dns_running;
            case "disabled": return R.string.web_dns_disabled;
            case "apply-pending": return R.string.web_dns_apply_pending;
            case "disable-pending": return R.string.web_dns_disable_pending;
            case "tailnet-unavailable": return R.string.web_dns_tailnet_unavailable;
            case "missing-binary": return R.string.web_dns_missing_binary;
            case "conflict": return R.string.web_dns_conflict;
            case "redirect-failed": return R.string.web_dns_redirect_failed;
            case "cleanup-failed": return R.string.web_dns_cleanup_failed;
            case "process-failed": return R.string.web_dns_process_failed;
            case "reconcile-needed": return R.string.web_dns_reconcile_needed;
            case "private-dns": return R.string.web_dns_private_dns;
            case "ipv6-unavailable": return R.string.web_tools_dns_ipv6_unavailable;
            case "local": return R.string.web_tools_dns_local_ready;
            case "transparent-unavailable": return R.string.web_tools_dns_local_only;
            case "native-policy-unavailable": return R.string.web_tools_dns_native_policy_unavailable;
            case "native-policy-changed": return R.string.web_tools_dns_native_policy_changed;
            case "restore-pending": return R.string.web_tools_dns_restore_pending;
            case "invalid-config": return R.string.web_tools_dns_invalid_config;
            case "listener-failed": return R.string.web_tools_dns_listener_failed;
            case "interception-failed": return R.string.web_tools_dns_interception_failed;
            case "context-changed": return R.string.web_tools_dns_context_changed;
            case "interception-lost": case "queue-failed": return R.string.web_tools_dns_interception_lost;
            case "guard-failed": return R.string.web_tools_dns_guard_failed;
            case "capture-mark-conflict": return R.string.web_tools_dns_mark_conflict;
            case "packet-policy-conflict": return R.string.web_tools_dns_packet_policy_conflict;
            case "dns-interception-conflict": return R.string.web_tools_dns_interception_conflict;
            case "stopped": return R.string.web_dns_stopped;
            case "degraded": return R.string.web_dns_degraded;
            default: return fallback;
        }
    }
}
