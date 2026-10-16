package dev.foxderin.tail;

import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.List;
import java.util.HashMap;
import java.util.Map;

final class ExitNodesPage extends ControlPage {
    private final TextView feedback, selectionState;
    private final LinearLayout routeBox, options, measurements, currentBox;
    private final Button apply, test; private final View retryPending;
    private JSONObject snapshot, routing;
    private List<JSONObject> peers;
    private String draft, identity, pending;
    private boolean freshStatus, freshPeers, reading, loadFailed;
    private final Map<String, Double> latencies = new HashMap<>();
    private final Map<String, ExitRow> retainedRows = new java.util.LinkedHashMap<>();
    private final TextView optionsMessage;
    private JSONObject peerSource;
    private static final class ExitRow {
        LinearLayout frame;
        android.widget.RadioButton radio;
        TextView current;
        android.graphics.drawable.GradientDrawable background;
        String appearance;
        boolean chosen, enabled;
    }

    ExitNodesPage(ControlActivity activity) {
        super(activity);
        LinearLayout toolbar = row(content); ((LinearLayout.LayoutParams) toolbar.getLayoutParams()).bottomMargin = dp(20);
        test = button(toolbar, s(R.string.web_exit_test), R.drawable.ic_speed, this::measure);
        button(toolbar, s(R.string.web_net_refresh), R.drawable.ic_refresh, this::refresh);
        measurements = row(content); measurements.setOrientation(LinearLayout.VERTICAL);
        routeBox = row(content); routeBox.setOrientation(LinearLayout.VERTICAL); ((LinearLayout.LayoutParams) routeBox.getLayoutParams()).bottomMargin = dp(20);
        currentBox = section();
        feedback = label(content, ""); feedback.setVisibility(android.view.View.GONE);
        LinearLayout choices = section(s(R.string.web_net_exit_choose), R.drawable.ic_router, null);
        options = row(choices); options.setOrientation(LinearLayout.VERTICAL);
        optionsMessage = hint(options, s(R.string.web_loading));
        ControlUi.divider(choices);
        selectionState = hint(choices, "");
        apply = primary(choices, s(R.string.web_net_exit_apply), R.drawable.ic_check_circle, this::applySelection);
        if (activity.getResources().getConfiguration().screenWidthDp <= 700) apply.setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
        retryPending = iconButton(choices, R.drawable.ic_refresh, s(R.string.web_retry), this::refresh); retryPending.setVisibility(android.view.View.GONE);
        draft = activity.drafts.getString("network.exitDraft");
        identity = activity.drafts.getString("network.exitIdentity");
        apply.setEnabled(false); test.setEnabled(false);
        activity.addStatusListener(value -> { if (isCurrent()) acceptStatus(value); });
        if (activity.statusSnapshot() != null) acceptStatus(activity.statusSnapshot());
        renderRoute(); renderOptions();
        repeat(this::refresh, 15000);
    }
    @Override String title() { return s(R.string.web_exit_title); }
    @Override void load() {
        if (activity.statusSnapshot() != null) acceptStatus(activity.statusSnapshot());
        refresh();
    }
    private void refresh() {
        if (!isCurrent() || reading) return;
        reading = true; loadFailed = false;
        if (snapshot == null || peers == null) renderOptions();
        read(result -> { reading = false; acceptStatus(result); }, failure -> {
            reading = false; freshStatus = false; freshPeers = false; loadFailed = true;
            feedback.setVisibility(android.view.View.VISIBLE); feedback.setText(s(R.string.web_net_status_stale));
            error(failure); renderRoute(); renderOptions();
        }, "status");
    }
    private void acceptStatus(JSONObject result) {
        String nextIdentity = identityOf(result);
        if (snapshot == result && freshPeers == (activity.statusFresh() && peers != null) && routing == activity.exitRoutingSnapshot() && freshStatus == (activity.statusFresh() && routing != null)) return;
        if (!java.util.Objects.equals(identity, nextIdentity)) {
            draft = null; pending = null; latencies.clear(); measurements.removeAllViews();
            activity.drafts.remove("network.exitDraft");
            peers = null; peerSource = null;
        }
        identity = nextIdentity; activity.drafts.putString("network.exitIdentity", identity);
        snapshot = result; routing = activity.exitRoutingSnapshot();
        freshStatus = activity.statusFresh() && routing != null;
        if (peerSource != result) {
            try {
                peers = new java.util.ArrayList<>();
                for (JSONObject peer : PeersPage.decodePeerList(result)) if (peer.optBoolean("exitNodeOption")) peers.add(peer);
                peerSource = result;
            } catch (org.json.JSONException invalid) { peers = null; }
        }
        freshPeers = activity.statusFresh() && peers != null;
        loadFailed = activity.statusError() != null || activity.statusFresh() && peers == null;
        if (!activity.statusFresh() && result != null) {
            feedback.setVisibility(android.view.View.VISIBLE); feedback.setText(s(R.string.web_net_status_stale));
        } else if (s(R.string.web_net_status_stale).contentEquals(feedback.getText())) feedback.setVisibility(android.view.View.GONE);
        renderRoute(); renderOptions();
    }
    @Override void onPause() { reading = false; freshStatus = false; freshPeers = false; apply.setEnabled(false); test.setEnabled(false); }
    private void renderRoute() {
        routeBox.removeAllViews();
        int effective = effectiveLabel(freshStatus ? routing : null);
        if (effective != 0) ControlUi.banner(routeBox, R.drawable.ic_info, s(effective), routing != null && !routing.optString("warning", "").isEmpty() ? ControlUi.TONE_WARN : ControlUi.TONE_NEUTRAL);
        if (routing != null && routing.optJSONObject("selected") != null && snapshot != null && "bridge".equals(snapshot.optString("mode")))
            hint(routeBox, s(R.string.web_net_exit_scope) + ": " + routing.optString("scope", "") + " " + scopeUids(routing));
    }
    static String scopeUids(JSONObject route) {
        JSONArray uids = route.optJSONArray("uids"); java.util.ArrayList<String> labels = new java.util.ArrayList<>();
        if (uids != null) for (int i = 0; i < uids.length(); i++) if (uids.opt(i) instanceof String || uids.opt(i) instanceof Number) labels.add(String.valueOf(uids.opt(i)));
        return String.join(", ", labels);
    }
    private String booleanText(JSONObject object, String key) {
        return s(Boolean.TRUE.equals(object.opt(key)) ? R.string.network_yes : Boolean.FALSE.equals(object.opt(key)) ? R.string.network_no : R.string.network_unknown);
    }
    private void renderOptions() {
        java.util.HashSet<String> present = new java.util.HashSet<>(); present.add("");
        String current = selectedId(routing), chosen = draft == null ? current : draft;
        boolean known = freshStatus && freshPeers && current != null && snapshot != null && "running".equals(snapshot.optString("daemon")) && !"unreachable".equals(snapshot.optString("backend"));
        if (pending != null && known && pending.equals(current) && !"not-effective".equals(routing.optString("effective"))) {
            pending = null; draft = null; activity.drafts.remove("network.exitDraft"); chosen = current;
            feedback.setText(s(current.isEmpty() ? R.string.web_exit_cleared : R.string.web_exit_set_done)); feedback.setVisibility(android.view.View.VISIBLE);
        }
        boolean foundCurrent = false;
        if (peers != null) for (JSONObject peer : peers) if (peer.optString("id").equals(current)) foundCurrent = true;
        JSONObject node = snapshot == null ? null : snapshot.optJSONObject("exitNode");
        boolean showCurrent = !known || node != null && peers != null && !foundCurrent;
        ControlUi.setCardVisible(currentBox, showCurrent);
        if (showCurrent) {
            currentBox.removeAllViews(); hint(currentBox, s(R.string.web_net_exit_selection));
            label(currentBox, known ? node == null ? selectedLabel(this, routing) : node.optString("hostname", selectedLabel(this, routing)) : s(R.string.web_net_exit_unknown));
            hint(currentBox, known ? node == null ? s(R.string.web_net_exit_local_hint) : node.optString("ip", s(R.string.web_net_exit_local_hint)) : s(!loadFailed && (reading || snapshot == null) ? R.string.web_loading : R.string.web_net_exit_unknown_hint));
            if (!known && !reading && (loadFailed || snapshot != null)) iconButton(currentBox, R.drawable.ic_refresh, s(R.string.web_retry), this::refresh);
            else if (known) badge(currentBox, s(R.string.web_exit_current), ControlUi.BADGE_NEUTRAL);
            if (known && node != null && Boolean.FALSE.equals(node.opt("online"))) ControlUi.banner(currentBox, R.drawable.ic_warning, s(R.string.web_net_exit_unavailable), ControlUi.TONE_WARN);
        }
        boolean selectable = freshPeers && !activity.client.ownsMutation();
        option("", s(R.string.web_net_exit_local), s(R.string.web_net_exit_local_hint), null, R.drawable.ic_language, chosen, current, selectable, null, 0);
        optionsMessage.setVisibility(peers == null || peers.isEmpty() ? android.view.View.VISIBLE : android.view.View.GONE);
        optionsMessage.setText(s(peers == null ? loadFailed ? R.string.web_net_unknown_hint : R.string.web_loading : R.string.web_exit_empty));
        if (peers != null) {
            java.util.ArrayList<JSONObject> sorted = new java.util.ArrayList<>(peers);
            sorted.sort(java.util.Comparator.<JSONObject>comparingInt(peer -> peer.optBoolean("online") ? 0 : 1)
                    .thenComparingDouble(peer -> latencies.get(peer.optString("id")) == null ? Double.POSITIVE_INFINITY : latencies.get(peer.optString("id")))
                    .thenComparing(peer -> peer.optString("hostname"), String.CASE_INSENSITIVE_ORDER));
            int position = 1;
            for (JSONObject peer : sorted) {
                String id = peer.optString("id"); boolean up = peer.optBoolean("online"); present.add(id);
                String relay = peer.optString("relay", ""), address = OverviewPage.textOrDash(peer, "ip") + (relay.isEmpty() || "-".equals(relay) ? "" : " · " + relay.toUpperCase(java.util.Locale.ROOT));
                String latency = !latencies.containsKey(id) ? s(R.string.web_net_exit_untested) : latencies.get(id) == null ? s(R.string.web_net_exit_unreachable) : number(latencies.get(id)) + " ms";
                option(id, peer.optString("hostname"), address, s(up ? R.string.web_net_filter_online : R.string.web_net_filter_offline), PeersPage.osIcon(peer.optString("os")), chosen, current, selectable && up, latency, position++);
            }
        }
        for (String id : new java.util.ArrayList<>(retainedRows.keySet())) if (!present.contains(id)) options.removeView(retainedRows.remove(id).frame);
        renderSelection();
    }
    private void renderSelection() {
        String current = selectedId(routing), chosen = draft == null ? current : draft;
        boolean known = freshStatus && freshPeers && current != null;
        boolean changed = chosen != null && current != null && !chosen.equals(current);
        boolean eligible = "".equals(chosen), online = false;
        String selectedName = s(R.string.web_net_exit_local);
        if (peers != null) for (JSONObject peer : peers) {
            boolean up = peer.optBoolean("online"); online |= up;
            if (peer.optString("id").equals(chosen)) { eligible = up; selectedName = peer.optString("hostname", s(R.string.web_net_exit_local)); }
        }
        selectionState.setText(pending != null ? s(R.string.web_net_exit_confirming) : !known ? s(R.string.web_net_exit_unknown)
                : changed ? s(R.string.web_net_exit_pending) + " · " + selectedName : s(effectiveLabel(routing)));
        retryPending.setVisibility(pending == null ? android.view.View.GONE : android.view.View.VISIBLE);
        apply.setEnabled(known && !activity.client.ownsMutation() && pending == null && eligible && chosen != null && (changed || "not-effective".equals(routing.optString("effective"))));
        test.setEnabled(freshPeers && online);
    }
    private void option(String id, String name, String address, String online, int icon, String chosen, String current, boolean enabled, String latency, int position) {
        String appearance = new JSONArray().put(name).put(address).put(online).put(icon).put(latency).toString();
        ExitRow entry = retainedRows.get(id);
        if (entry == null || !appearance.equals(entry.appearance)) {
            if (entry != null) options.removeView(entry.frame);
            entry = new ExitRow(); entry.appearance = appearance; retainedRows.put(id, entry);
            LinearLayout frame = row(options); entry.frame = frame; frame.setOrientation(LinearLayout.VERTICAL); frame.setPadding(dp(11), dp(13), dp(11), dp(13));
            entry.background = new android.graphics.drawable.GradientDrawable(); entry.background.setCornerRadius(dp(13)); frame.setBackground(entry.background);
            ((LinearLayout.LayoutParams) frame.getLayoutParams()).bottomMargin = dp(10);
            LinearLayout main = row(frame);
            entry.radio = new com.google.android.material.radiobutton.MaterialRadioButton(activity); entry.radio.setContentDescription(name); main.addView(entry.radio, new LinearLayout.LayoutParams(dp(40), dp(48)));
            android.widget.ImageView image = ControlUi.iconTile(activity, icon, 37); LinearLayout.LayoutParams imageParams = new LinearLayout.LayoutParams(dp(37), dp(37)); imageParams.setMarginEnd(dp(10)); main.addView(image, imageParams);
            LinearLayout copy = new LinearLayout(activity); copy.setOrientation(LinearLayout.VERTICAL); main.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
            ToolsFlowLayout titleRow = new ToolsFlowLayout(activity, 8, 6); copy.addView(titleRow, new LinearLayout.LayoutParams(-1, -2));
            TextView title = ControlUi.text(activity, name, 14); title.setTypeface(null, android.graphics.Typeface.BOLD); titleRow.addView(title);
            entry.current = ControlUi.badge(activity, s(R.string.web_exit_current), ControlUi.BADGE_NEUTRAL); titleRow.addView(entry.current);
            TextView detail = ControlUi.text(activity, address, 11); detail.setTextColor(com.google.android.material.color.MaterialColors.getColor(detail, com.google.android.material.R.attr.colorOnSurfaceVariant)); LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(-1, -2); detailParams.topMargin = dp(6); copy.addView(detail, detailParams);
            LinearLayout statusRow = row(copy);
            if (online != null) { TextView status = label(statusRow, "● " + online); status.setTextSize(11); status.setLayoutParams(new LinearLayout.LayoutParams(-2, -2)); }
            if (latency != null && !latency.isEmpty()) {
                TextView ms = label(statusRow, latency); ms.setTextSize(11);
                LinearLayout.LayoutParams msParams = new LinearLayout.LayoutParams(-2, -2); msParams.setMarginStart(dp(8)); ms.setLayoutParams(msParams);
                Double measured = latencies.get(id);
                if (measured != null) ms.setTextColor(measured < 100 ? androidx.core.content.ContextCompat.getColor(activity, R.color.foxy_ok) : measured <= 300 ? com.google.android.material.color.MaterialColors.getColor(ms, com.google.android.material.R.attr.colorTertiary) : androidx.core.content.ContextCompat.getColor(activity, R.color.foxy_error));
            }
            ExitRow target = entry;
            entry.radio.setOnClickListener(view -> { if (isCurrent() && target.enabled) choose(id); });
            frame.setOnClickListener(view -> { if (isCurrent() && target.enabled) choose(id); });
            styleOption(entry, id.equals(chosen));
        }
        if (options.indexOfChild(entry.frame) != position) { options.removeView(entry.frame); options.addView(entry.frame, position); }
        entry.enabled = enabled; entry.frame.setEnabled(enabled); entry.radio.setEnabled(enabled);
        entry.current.setVisibility(id.equals(current) ? android.view.View.VISIBLE : android.view.View.GONE);
        if (entry.chosen != id.equals(chosen)) styleOption(entry, id.equals(chosen));
    }
    private void styleOption(ExitRow entry, boolean chosen) {
        entry.chosen = chosen; entry.radio.setChecked(chosen);
        entry.background.setColor(com.google.android.material.color.MaterialColors.getColor(entry.frame, chosen ? com.google.android.material.R.attr.colorSurfaceContainerLow : com.google.android.material.R.attr.colorSurface));
        entry.background.setStroke(dp(chosen ? 2 : 1), com.google.android.material.color.MaterialColors.getColor(entry.frame, chosen ? androidx.appcompat.R.attr.colorPrimary : com.google.android.material.R.attr.colorOutlineVariant));
    }
    private static String number(double value) { return value == Math.rint(value) ? Long.toString((long) value) : Double.toString(value); }
    private void choose(String id) {
        String previous = draft == null ? selectedId(routing) : draft;
        pending = null; draft = id; activity.drafts.putString("network.exitDraft", id);
        ExitRow old = retainedRows.get(previous), next = retainedRows.get(id);
        if (old != null && old != next) styleOption(old, false);
        if (next != null) styleOption(next, true);
        renderSelection();
    }
    private void applySelection() {
        if (!apply.isEnabled() || activity.client.busy()) return;
        String expected = draft == null ? selectedId(routing) : draft;
        if (expected == null) return;
        final String expectedIdentity = identity;
        confirm(title(), s(R.string.network_interrupt), () -> {
            if (!apply.isEnabled() || !java.util.Objects.equals(expectedIdentity, identity)) return;
            mutate(title(), result -> {
                if (!java.util.Objects.equals(expectedIdentity, identity)) return;
                JSONObject actual = result.optJSONObject("exitRouting");
                if (actual != null) { routing = actual; freshStatus = false; renderRoute(); }
                if (result.optBoolean("ok")) pending = expected;
                feedback.setVisibility(android.view.View.VISIBLE);
                feedback.setText(result.optBoolean("ok") ? s(R.string.web_net_exit_confirming) : s(R.string.network_failed, result.optString("error", s(R.string.web_net_unknown))));
                if (!result.optBoolean("ok") && actual != null) {
                    feedback.append("\n" + s(R.string.network_selected) + ": " + selectedLabel(this, actual));
                    int effective = effectiveLabel(actual);
                    if (effective != 0) feedback.append("\n" + s(R.string.network_effective) + ": " + s(effective));
                    feedback.append("\nIPv4: " + booleanText(actual, "ipv4") + " · IPv6: " + booleanText(actual, "ipv6"));
                    String warning = actual.optString("warning", ""); if (!warning.isEmpty()) feedback.append("\n" + warning);
                }
                refresh();
            }, expected.isEmpty() ? new String[]{"exitnode-clear"} : new String[]{"exitnode-set", expected});
        });
    }
    private void measure() {
        if (!test.isEnabled()) return;
        final String probeIdentity = identity;
        probe(s(R.string.web_exit_test), result -> {
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
                latencies.put(node.optString("id"), good ? ((Number) latency).doubleValue() : null);
            }
            renderOptions();
        }, "speedtest-exitnodes");
    }
    static String identityOf(JSONObject status) {
        JSONObject self = status == null ? null : status.optJSONObject("self");
        return self != null && self.opt("id") instanceof String ? self.optString("id") : "";
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
        return id == null ? page.s(R.string.web_net_exit_unknown) : id.isEmpty() ? page.s(R.string.web_net_exit_local) : id;
    }
    static int effectiveLabel(JSONObject route) {
        if (route == null || !Boolean.TRUE.equals(route.opt("known"))) return R.string.web_net_exit_unknown_hint;
        if ("not-effective".equals(route.optString("effective"))) return R.string.web_net_exit_failed;
        if (route.isNull("selected")) return R.string.web_net_no_exit_hint;
        switch (route.optString("effective")) {
            case "explicit-proxy": return R.string.web_net_exit_proxy;
            case "daemon-owned": return R.string.web_net_exit_daemon;
            case "bridge-policy": return Boolean.TRUE.equals(route.opt("ipv6")) ? R.string.web_net_exit_bridge_dual : R.string.web_net_exit_bridge_v4;
            default: return R.string.web_net_exit_failed;
        }
    }
}
