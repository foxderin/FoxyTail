package dev.foxderin.tail;

import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

final class TunnelPage extends ControlPage {
    private final LinearLayout tunBox, dnsBox, derpBox;
    private final TextView tunState, dnsState, socksResult;
    private final Button socks;
    private JSONObject tun;
    private boolean reading, dnsReading, dnsAgain;

    TunnelPage(ControlActivity activity) {
        super(activity);
        LinearLayout actions = section();
        button(actions, s(R.string.network_refresh), R.drawable.ic_refresh, this::refresh);
        button(actions, s(R.string.network_derp_test), R.drawable.ic_speed, this::measureDerp);
        tunState = label(actions, s(R.string.network_unknown));
        tunBox = section();
        socks = button(actions, s(R.string.network_socks_check), R.drawable.ic_network_check, this::checkSocks);
        socks.setEnabled(false);
        socksResult = label(actions, s(R.string.network_unchecked));
        LinearLayout dnsActions = section(s(R.string.network_dns));
        dnsState = label(dnsActions, s(R.string.network_unchecked));
        button(dnsActions, s(R.string.network_dns_check), R.drawable.ic_check_circle, this::checkDns);
        button(dnsActions, s(R.string.network_dns_probe), () -> probe(s(R.string.network_dns_probe), result -> {
            if (!result.optBoolean("ok")) notice(s(R.string.network_failed, result.optString("error", s(R.string.network_unknown))));
            else if (Boolean.FALSE.equals(result.opt("transparentAvailable"))) notice(result.optString("transparentUnavailableReason", s(R.string.network_dns_inactive)));
            checkDns();
        }, "dns-probe"));
        dnsBox = section(s(R.string.network_dns));
        derpBox = section(s(R.string.network_derp_test));
        LinearLayout related = section(s(R.string.nav_quick_access));
        linkRow(related, R.drawable.ic_network_check, s(R.string.network_coexist), () -> activity.navigate("coexist"));
        linkRow(related, R.drawable.ic_alt_route, s(R.string.network_routing), () -> activity.navigate("routing"));
        linkRow(related, R.drawable.ic_settings, s(R.string.network_settings), () -> activity.navigate("settings"));
        repeat(this::refresh, 15000);
    }
    @Override String title() { return s(R.string.network_tunnel); }
    @Override void load() {
        refresh();
    }
    @Override void onPause() { reading = false; dnsReading = false; dnsAgain = false; socks.setEnabled(false); }
    private void refresh() {
        if (reading) return; reading = true;
        read(status -> {
            read(result -> {
                reading = false; tun = result; tunState.setText("");
                tunBox.removeAllViews();
                field(tunBox, R.string.network_mode, result, "mode");
                flag(tunBox, R.string.network_interface, result, "ifaceUp");
                field(tunBox, R.string.network_gateway, result, "gateway");
                if ("bridge".equals(result.optString("mode"))) field(tunBox, R.string.network_hev, result, "hevPid");
                String endpoint = socksEndpoint(result);
                label(tunBox, "SOCKS5: " + (endpoint == null ? s(R.string.network_unknown) : endpoint));
                socks.setEnabled(endpoint != null && ("bridge".equals(result.optString("mode")) || "proxy".equals(result.optString("mode"))));
            }, failure -> { reading = false; tunState.setText(s(R.string.network_stale)); socks.setEnabled(false); error(failure); }, "tun");
        }, failure -> { reading = false; tunState.setText(s(R.string.network_stale)); socks.setEnabled(false); error(failure); }, "status");
    }
    private void checkDns() {
        if (dnsReading) { dnsAgain = true; return; } dnsReading = true;
        read(result -> {
            dnsReading = false; dnsState.setText(s(dnsLabel(result))); dnsBox.removeAllViews();
            field(dnsBox, R.string.network_mode, result, "mode");
            field(dnsBox, R.string.network_dns_state, result, "state");
            field(dnsBox, R.string.network_dns_reason, result, "reason");
            field(dnsBox, R.string.network_dns_configured, result, "configuredMode");
            field(dnsBox, R.string.network_dns_pending, result, "pendingMode");
            field(dnsBox, R.string.network_dns_policy, result, "policyState");
            flag(dnsBox, R.string.network_dns_repair, result, "repairNeeded");
            flag(dnsBox, R.string.network_dns_listener, result, "listenerReady");
            label(dnsBox, "IPv4: " + booleanText(result, "interception4") + " · IPv6: " + booleanText(result, "interception6"));
            flag(dnsBox, R.string.network_dns_native, result, "upstreamNative");
            field(dnsBox, R.string.network_dns_path, result, "ipv6DnsInterception");
            field(dnsBox, R.string.network_dns_module, result, "ipv6ModuleStatus");
            flag(dnsBox, R.string.network_dns_transparent, result, "transparentAvailable");
            for (String key : new String[]{"capabilityError", "transparentUnavailableReason"}) {
                Object problem = result.opt(key); if (problem instanceof String && !((String) problem).isEmpty()) label(dnsBox, (String) problem);
            }
            field(dnsBox, R.string.network_dns_suffix, result, "suffix");
            String endpoint = dnsEndpoint(result);
            if (endpoint != null) {
                label(dnsBox, s(R.string.network_dns_endpoint));
                button(dnsBox, s(R.string.network_copy, endpoint), () -> copy(s(R.string.network_dns_endpoint), endpoint));
            }
            if ("transparent".equals(result.optString("mode"))) label(dnsBox, s(R.string.network_dns_limit));
            if (dnsAgain) { dnsAgain = false; checkDns(); }
        }, failure -> {
            dnsReading = false; dnsState.setText(s(R.string.network_stale)); error(failure);
            if (dnsAgain) { dnsAgain = false; checkDns(); }
        }, "dns");
    }
    private void checkSocks() {
        if (!socks.isEnabled() || socksEndpoint(tun) == null) return;
        probe(s(R.string.network_socks_check), result -> {
            boolean valid = result.opt("success") instanceof Boolean && result.opt("elapsedMs") instanceof Number && result.opt("httpCode") instanceof String;
            if (!result.optBoolean("ok") || !valid) socksResult.setText(s(R.string.network_failed, result.optString("error", s(R.string.network_invalid_result))));
            else socksResult.setText(s(result.optBoolean("success") ? R.string.network_success : R.string.network_probe_failed) +
                    " · HTTP " + result.optString("httpCode") + " · " + result.optLong("elapsedMs") + " ms" +
                    (result.has("error") && !result.isNull("error") ? "\n" + result.optString("error") : ""));
        }, "socks-check");
    }
    private void measureDerp() {
        probe(s(R.string.network_derp_test), result -> {
            derpBox.removeAllViews(); JSONArray relays = result.optJSONArray("relays");
            if (!result.optBoolean("ok") || relays == null) {
                label(derpBox, s(R.string.network_failed, result.optString("error", s(R.string.network_invalid_result)))); return;
            }
            field(derpBox, R.string.network_preferred, result, "preferred");
            if (relays.length() == 0) label(derpBox, s(R.string.network_not_measured));
            for (int i = 0; i < relays.length(); i++) {
                JSONObject relay = relays.optJSONObject(i);
                if (relay == null) { label(derpBox, s(R.string.network_invalid_result)); continue; }
                Object ms = relay.opt("latencyMs");
                label(derpBox, relay.optString("code", s(R.string.network_unknown)) + ": " +
                        (ms instanceof Number && Double.isFinite(((Number) ms).doubleValue()) && ((Number) ms).doubleValue() >= 0 ? ms + " ms" : s(R.string.network_not_measured)));
            }
        }, "derp-speedtest");
    }
    private void field(LinearLayout parent, int title, JSONObject data, String key) {
        Object value = data.opt(key);
        label(parent, s(title) + ": " + (value == null || value == JSONObject.NULL ? s(R.string.network_unknown) : String.valueOf(value)));
    }
    private void flag(LinearLayout parent, int title, JSONObject data, String key) { label(parent, s(title) + ": " + booleanText(data, key)); }
    private String booleanText(JSONObject data, String key) {
        return s(Boolean.TRUE.equals(data.opt(key)) ? R.string.network_yes : Boolean.FALSE.equals(data.opt(key)) ? R.string.network_no : R.string.network_unknown);
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
        if (modernDns(data)) {
            String reason = data.optString("reason");
            if ("stopped".equals(data.optString("state")) && Boolean.FALSE.equals(data.opt("enabled"))) return R.string.network_dns_disabled;
            if (!reason.isEmpty() && !java.util.Arrays.asList("running", "local", "transparent-unavailable", "ipv6-unavailable").contains(reason)) return R.string.network_dns_degraded;
            if (!Boolean.TRUE.equals(data.opt("listenerReady"))) return R.string.network_dns_listener_unready;
            if ("local".equals(data.optString("mode"))) return dnsReady(data) ? R.string.network_dns_local : R.string.network_dns_degraded;
            if (dnsReady(data) && Boolean.TRUE.equals(data.opt("interception4"))) return Boolean.TRUE.equals(data.opt("interception6")) ? R.string.network_dns_dual : R.string.network_dns_v4;
            return "transparent-unavailable".equals(reason) ? R.string.network_dns_local_only : R.string.network_dns_inactive;
        }
        if ("running".equals(data.optString("state")) && "running".equals(data.optString("reason"))) return R.string.network_dns_running;
        if ("disabled".equals(data.optString("reason")) && Boolean.FALSE.equals(data.opt("enabled"))) return R.string.network_dns_disabled;
        if ("degraded".equals(data.optString("state"))) return R.string.network_dns_degraded;
        return R.string.network_unknown;
    }
}
