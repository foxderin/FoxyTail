package dev.foxderin.tail;

import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.List;
import java.util.HashMap;
import java.util.Map;

final class ExitNodesPage extends ControlPage {
    private final TextView state, feedback, draftView;
    private final LinearLayout routeBox, options, measurements;
    private final Button apply, test;
    private JSONObject snapshot, routing;
    private List<JSONObject> peers;
    private String draft, identity;
    private boolean freshStatus, freshPeers, reading;
    private java.util.function.Consumer<JSONObject> queuedAfter;
    private int sequence;
    private final Map<String, Double> latencies = new HashMap<>();

    ExitNodesPage(ControlActivity activity) {
        super(activity);
        LinearLayout header = section();
        state = label(header, s(R.string.network_unknown));
        feedback = label(header, "");
        label(header, s(R.string.network_exit_hint));
        button(header, s(R.string.network_refresh), () -> refresh(null));
        routeBox = section(s(R.string.network_effective));
        draftView = label(header, s(R.string.network_exit_draft, s(R.string.network_unknown)));
        apply = button(header, s(R.string.network_apply_exit), this::applySelection);
        test = button(header, s(R.string.network_exit_test), this::measure);
        button(header, s(R.string.network_routing), () -> activity.navigate("routing"));
        options = section(s(R.string.network_choose));
        measurements = section(s(R.string.network_exit_test));
        draft = activity.drafts.getString("network.exitDraft");
        identity = activity.drafts.getString("network.exitIdentity");
        apply.setEnabled(false); test.setEnabled(false);
        repeat(() -> { if (!reading) refresh(null); }, 15000);
    }
    @Override String title() { return s(R.string.network_exits); }
    @Override void load() {
        refresh(null);
    }
    private void refresh(java.util.function.Consumer<JSONObject> after) {
        if (reading) { if (after != null) queuedAfter = after; return; }
        final int request = ++sequence; reading = true;
        read(result -> {
            if (request != sequence) return;
            snapshot = result; routing = result.optJSONObject("exitRouting"); freshStatus = true;
            String nextIdentity = identityOf(result);
            if (identity == null || !identity.equals(nextIdentity)) {
                draft = null; latencies.clear(); measurements.removeAllViews();
                activity.drafts.remove("network.exitDraft");
                peers = null; freshPeers = false; renderOptions();
            }
            identity = nextIdentity; activity.drafts.putString("network.exitIdentity", identity);
            state.setText(s(OverviewPage.connectionLabel(result))); renderRoute();
            read(list -> {
                if (request != sequence) return;
                reading = false;
                try { peers = PeersPage.decodePeers(list); freshPeers = true; }
                catch (org.json.JSONException invalid) { freshPeers = false; state.setText(s(R.string.network_stale)); error(invalid); }
                renderOptions();
                if (after != null) after.accept(result);
                followUp();
            }, failure -> {
                if (request != sequence) return;
                reading = false; freshPeers = false; state.setText(s(R.string.network_stale)); error(failure); renderOptions();
                if (after != null) after.accept(result);
                followUp();
            }, "exitnodes");
        }, failure -> {
            if (request != sequence) return;
            reading = false; freshStatus = false; state.setText(s(R.string.network_stale)); error(failure); renderOptions();
            if (after != null) after.accept(null);
            followUp();
        }, "status");
    }
    private void followUp() {
        java.util.function.Consumer<JSONObject> after = queuedAfter; queuedAfter = null;
        if (after != null) refresh(after);
    }
    @Override void onPause() { reading = false; freshStatus = false; freshPeers = false; queuedAfter = null; sequence++; apply.setEnabled(false); test.setEnabled(false); }
    private void renderRoute() {
        routeBox.removeAllViews();
        label(routeBox, s(R.string.network_selected) + ": " + selectedLabel(this, routing));
        label(routeBox, s(R.string.network_effective) + ": " + s(effectiveLabel(routing)));
        if (routing != null) {
            label(routeBox, "IPv4: " + booleanText(routing, "ipv4") + " · IPv6: " + booleanText(routing, "ipv6"));
            String scope = routing.optString("scope", s(R.string.network_unknown));
            JSONArray uids = routing.optJSONArray("uids");
            java.util.ArrayList<String> labels = new java.util.ArrayList<>();
            if (uids != null) for (int i = 0; i < uids.length(); i++) labels.add(uids.optString(i));
            label(routeBox, s(R.string.network_scope) + ": " + scope + " " + String.join(", ", labels));
            String warning = routing.optString("warning", "");
            if (!warning.isEmpty()) label(routeBox, warning);
        }
        JSONObject current = snapshot == null ? null : snapshot.optJSONObject("exitNode");
        if (current != null && Boolean.FALSE.equals(current.opt("online"))) label(routeBox, s(R.string.network_exit_unavailable));
    }
    private String booleanText(JSONObject object, String key) {
        return s(Boolean.TRUE.equals(object.opt(key)) ? R.string.network_yes : Boolean.FALSE.equals(object.opt(key)) ? R.string.network_no : R.string.network_unknown);
    }
    private void renderOptions() {
        options.removeAllViews();
        String chosen = draft == null ? selectedId(routing) : draft;
        draftView.setText(s(R.string.network_exit_draft, chosen == null ? s(R.string.network_unknown) : chosen.isEmpty() ? s(R.string.network_local) : chosen));
        boolean known = freshStatus && freshPeers && selectedId(routing) != null && snapshot != null && "running".equals(snapshot.optString("daemon")) && !"unreachable".equals(snapshot.optString("backend"));
        Button local = button(options, s(R.string.network_local) + ("".equals(chosen) ? " · " + s(R.string.network_draft_chosen) : ""), () -> choose("")); local.setEnabled(known);
        boolean eligible = "".equals(chosen), online = false;
        if (peers == null) label(options, s(R.string.network_unknown));
        else for (JSONObject peer : peers) {
            String id = peer.optString("id"); boolean up = peer.optBoolean("online"); online |= up;
            if (id.equals(chosen)) eligible = up;
            String latency = latencies.containsKey(id) ? latencies.get(id) + " ms" : s(R.string.network_not_measured);
            String text = peer.optString("hostname") + " · " + s(up ? R.string.network_online : R.string.network_offline) +
                    "\n" + String.join(" · ", PeersPage.addresses(peer)) + "\n" + latency;
            if (id.equals(chosen)) text += " · " + s(R.string.network_draft_chosen);
            Button choose = button(options, text, () -> choose(id)); choose.setEnabled(known && up);
        }
        apply.setEnabled(known && eligible && chosen != null && (!chosen.equals(selectedId(routing)) || "not-effective".equals(routing.optString("effective"))));
        test.setEnabled(known && online);
    }
    private void choose(String id) { draft = id; activity.drafts.putString("network.exitDraft", id); renderOptions(); }
    private void applySelection() {
        if (!apply.isEnabled() || activity.client.busy()) return;
        String expected = draft == null ? selectedId(routing) : draft;
        if (expected == null) return;
        confirm(title(), s(R.string.network_interrupt), () -> {
            if (!apply.isEnabled()) return;
            mutate(title(), result -> {
                JSONObject actual = result.optJSONObject("exitRouting");
                if (actual != null) { routing = actual; renderRoute(); }
                feedback.setText(result.optBoolean("ok") ? s(R.string.network_unverified) : s(R.string.network_failed, result.optString("error", s(R.string.network_unknown))));
                if (!result.optBoolean("ok") && actual != null) {
                    feedback.append("\n" + s(R.string.network_selected) + ": " + selectedLabel(this, actual));
                    feedback.append("\n" + s(R.string.network_effective) + ": " + s(effectiveLabel(actual)));
                    feedback.append("\nIPv4: " + booleanText(actual, "ipv4") + " · IPv6: " + booleanText(actual, "ipv6"));
                    String warning = actual.optString("warning", ""); if (!warning.isEmpty()) feedback.append("\n" + warning);
                }
                refresh(observed -> {
                    if (!result.optBoolean("ok")) return;
                    JSONObject actualRoute = observed == null ? null : observed.optJSONObject("exitRouting");
                    if (expected.equals(selectedId(actualRoute))) {
                        draft = null; activity.drafts.remove("network.exitDraft");
                        feedback.setText(s(R.string.network_exit_verified)); renderOptions();
                    }
                });
            }, expected.isEmpty() ? new String[]{"exitnode-clear"} : new String[]{"exitnode-set", expected});
        });
    }
    private void measure() {
        if (!test.isEnabled()) return;
        final String probeIdentity = identity;
        probe(s(R.string.network_exit_test), result -> {
            if (!java.util.Objects.equals(probeIdentity, identity)) return;
            measurements.removeAllViews(); latencies.clear();
            JSONArray results = result.optJSONArray("results");
            if (!result.optBoolean("ok") || results == null) {
                label(measurements, s(R.string.network_failed, result.optString("error", s(R.string.network_invalid_result)))); renderOptions(); return;
            }
            for (int i = 0; i < results.length(); i++) {
                JSONObject node = results.optJSONObject(i);
                if (node == null) continue;
                Object latency = node.opt("latencyMs");
                boolean good = Boolean.TRUE.equals(node.opt("ok")) && latency instanceof Number && Double.isFinite(((Number) latency).doubleValue()) && ((Number) latency).doubleValue() >= 0;
                if (good) latencies.put(node.optString("id"), ((Number) latency).doubleValue());
                label(measurements, node.optString("hostname", node.optString("id")) + ": " + (good ? latency + " ms" : s(R.string.network_not_measured)));
            }
            renderOptions();
        }, "speedtest-exitnodes");
    }
    static String identityOf(JSONObject status) {
        JSONObject route = status.optJSONObject("exitRouting"), self = status.optJSONObject("self");
        return (route == null ? "" : route.optString("profile")) + "|" + (self == null ? "" : String.join(",", PeersPage.addresses(self)));
    }
    static String selectedId(JSONObject route) {
        if (route == null || !Boolean.TRUE.equals(route.opt("known")) || !route.has("selected")) return null;
        if (route.isNull("selected")) return "";
        JSONObject selected = route.optJSONObject("selected"); if (selected == null) return null;
        String auto = selected.optString("auto", ""); if (!auto.isEmpty()) return "auto:" + auto;
        String id = selected.optString("id", ""); if (!id.isEmpty()) return id;
        String ip = selected.optString("ip", ""); return ip.isEmpty() ? null : ip;
    }
    static String selectedLabel(ControlPage page, JSONObject route) {
        String id = selectedId(route);
        return id == null ? page.s(R.string.network_unknown) : id.isEmpty() ? page.s(R.string.network_local) : id;
    }
    static int effectiveLabel(JSONObject route) {
        if (route == null || !Boolean.TRUE.equals(route.opt("known"))) return R.string.network_unknown;
        switch (route.optString("effective")) {
            case "none": return R.string.network_exit_none;
            case "explicit-proxy": return R.string.network_exit_proxy;
            case "daemon-owned": return R.string.network_exit_daemon;
            case "bridge-policy": return R.string.network_exit_bridge;
            case "not-effective": return R.string.network_exit_failed;
            default: return R.string.network_unknown;
        }
    }
}
