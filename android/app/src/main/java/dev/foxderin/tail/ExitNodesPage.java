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
    private final TextView feedback, draftView;
    private final LinearLayout routeBox, options, measurements, currentBox;
    private final Button apply, test, retryPending;
    private JSONObject snapshot, routing;
    private List<JSONObject> peers;
    private String draft, identity, pending;
    private boolean freshStatus, freshPeers, reading;
    private java.util.function.Consumer<JSONObject> queuedAfter;
    private int sequence;
    private final Map<String, Double> latencies = new HashMap<>();

    ExitNodesPage(ControlActivity activity) {
        super(activity);
        LinearLayout toolbar = row(content); ((LinearLayout.LayoutParams) toolbar.getLayoutParams()).bottomMargin = dp(20);
        test = button(toolbar, s(R.string.web_exit_test), R.drawable.ic_speed, this::measure);
        button(toolbar, s(R.string.web_net_refresh), R.drawable.ic_refresh, () -> refresh(null));
        measurements = row(content); measurements.setOrientation(LinearLayout.VERTICAL);
        routeBox = row(content); routeBox.setOrientation(LinearLayout.VERTICAL); ((LinearLayout.LayoutParams) routeBox.getLayoutParams()).bottomMargin = dp(20);
        currentBox = section();
        feedback = label(content, ""); feedback.setVisibility(android.view.View.GONE);
        LinearLayout choices = section(s(R.string.web_net_exit_choose), R.drawable.ic_router, null);
        options = row(choices); options.setOrientation(LinearLayout.VERTICAL);
        ControlUi.divider(choices);
        draftView = label(choices, s(R.string.web_net_exit_unknown));
        apply = primary(choices, s(R.string.web_net_exit_apply), R.drawable.ic_check_circle, this::applySelection);
        if (activity.getResources().getConfiguration().screenWidthDp <= 700) apply.setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
        retryPending = textButton(choices, s(R.string.web_retry), () -> refresh(null)); retryPending.setVisibility(android.view.View.GONE);
        draft = activity.drafts.getString("network.exitDraft");
        identity = activity.drafts.getString("network.exitIdentity");
        apply.setEnabled(false); test.setEnabled(false);
        repeat(() -> { if (!reading) refresh(null); }, 15000);
    }
    @Override String title() { return s(R.string.web_exit_title); }
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
                draft = null; pending = null; latencies.clear(); measurements.removeAllViews();
                activity.drafts.remove("network.exitDraft");
                peers = null; freshPeers = false; renderOptions();
            }
            identity = nextIdentity; activity.drafts.putString("network.exitIdentity", identity);
            renderRoute();
            read(list -> {
                if (request != sequence) return;
                reading = false;
                try { peers = PeersPage.decodePeers(list); freshPeers = true; }
                catch (org.json.JSONException invalid) { freshPeers = false; feedback.setVisibility(android.view.View.VISIBLE); feedback.setText(s(R.string.web_net_status_stale)); error(invalid); }
                renderOptions();
                if (after != null) after.accept(result);
                followUp();
            }, failure -> {
                if (request != sequence) return;
                reading = false; freshPeers = false; feedback.setVisibility(android.view.View.VISIBLE); feedback.setText(s(R.string.web_net_status_stale)); error(failure); renderOptions();
                if (after != null) after.accept(result);
                followUp();
            }, "exitnodes");
        }, failure -> {
            if (request != sequence) return;
            reading = false; freshStatus = false; feedback.setVisibility(android.view.View.VISIBLE); feedback.setText(s(R.string.web_net_status_stale)); error(failure); renderRoute(); renderOptions();
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
        ControlUi.banner(routeBox, R.drawable.ic_info, s(effectiveLabel(freshStatus ? routing : null)), routing != null && !routing.optString("warning", "").isEmpty() ? ControlUi.TONE_WARN : ControlUi.TONE_NEUTRAL);
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
        options.removeAllViews();
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
            hint(currentBox, known ? node == null ? s(R.string.web_net_exit_local_hint) : node.optString("ip", s(R.string.web_net_exit_local_hint)) : s(R.string.web_net_exit_unknown_hint));
            if (!known) textButton(currentBox, s(R.string.web_retry), () -> refresh(null));
            else badge(currentBox, s(R.string.web_exit_current), ControlUi.BADGE_NEUTRAL);
            if (known && node != null && Boolean.FALSE.equals(node.opt("online"))) ControlUi.banner(currentBox, R.drawable.ic_warning, s(R.string.web_net_exit_unavailable), ControlUi.TONE_WARN);
        }
        boolean changed = chosen != null && current != null && !chosen.equals(current);
        String chosenName = s(R.string.web_net_exit_local);
        boolean eligible = "".equals(chosen), online = false;
        option("", s(R.string.web_net_exit_local), s(R.string.web_net_exit_local_hint), null, R.drawable.ic_language, chosen, current, known, null);
        if (peers == null) ControlUi.skeleton(options, 1f, 80);
        else {
            java.util.ArrayList<JSONObject> sorted = new java.util.ArrayList<>(peers);
            sorted.sort(java.util.Comparator.<JSONObject>comparingInt(peer -> peer.optBoolean("online") ? 0 : 1)
                    .thenComparingDouble(peer -> latencies.get(peer.optString("id")) == null ? Double.POSITIVE_INFINITY : latencies.get(peer.optString("id")))
                    .thenComparing(peer -> peer.optString("hostname"), String.CASE_INSENSITIVE_ORDER));
            if (sorted.isEmpty()) hint(options, s(R.string.web_exit_empty));
            for (JSONObject peer : sorted) {
                String id = peer.optString("id"); boolean up = peer.optBoolean("online"); online |= up;
                if (id.equals(chosen)) { eligible = up; chosenName = peer.optString("hostname"); }
                String relay = peer.optString("relay", ""), address = OverviewPage.textOrDash(peer, "ip") + (relay.isEmpty() || "-".equals(relay) ? "" : " · " + relay.toUpperCase(java.util.Locale.ROOT));
                String latency = !latencies.containsKey(id) ? s(R.string.web_net_exit_untested) : latencies.get(id) == null ? s(R.string.web_net_exit_unreachable) : number(latencies.get(id)) + " ms";
                option(id, peer.optString("hostname"), address, s(up ? R.string.web_net_filter_online : R.string.web_net_filter_offline), PeersPage.osIcon(peer.optString("os")), chosen, current, known && up, latency);
            }
        }
        draftView.setText(pending != null ? s(R.string.web_net_exit_confirming) : !known ? s(R.string.web_net_exit_unknown) : changed ? s(R.string.web_net_exit_pending) + " · " + chosenName : s(effectiveLabel(routing)));
        retryPending.setVisibility(pending == null ? android.view.View.GONE : android.view.View.VISIBLE);
        apply.setEnabled(known && pending == null && eligible && chosen != null && (changed || "not-effective".equals(routing.optString("effective"))));
        test.setEnabled(known && online);
    }
    private void option(String id, String name, String address, String online, int icon, String chosen, String current, boolean enabled, String latency) {
        LinearLayout frame = row(options); frame.setOrientation(LinearLayout.VERTICAL); frame.setPadding(dp(11), dp(13), dp(11), dp(13));
        android.graphics.drawable.GradientDrawable background = new android.graphics.drawable.GradientDrawable();
        int primary = com.google.android.material.color.MaterialColors.getColor(frame, androidx.appcompat.R.attr.colorPrimary);
        background.setColor(com.google.android.material.color.MaterialColors.getColor(frame, id.equals(chosen) ? com.google.android.material.R.attr.colorSurfaceContainerLow : com.google.android.material.R.attr.colorSurface));
        background.setCornerRadius(dp(13)); background.setStroke(dp(id.equals(chosen) ? 2 : 1), id.equals(chosen) ? primary : com.google.android.material.color.MaterialColors.getColor(frame, com.google.android.material.R.attr.colorOutlineVariant)); frame.setBackground(background);
        ((LinearLayout.LayoutParams) frame.getLayoutParams()).bottomMargin = dp(10);
        LinearLayout main = row(frame); main.setGravity(android.view.Gravity.CENTER_VERTICAL);
        android.widget.RadioButton radio = new com.google.android.material.radiobutton.MaterialRadioButton(activity); radio.setChecked(id.equals(chosen)); radio.setEnabled(enabled); radio.setContentDescription(name); main.addView(radio, new LinearLayout.LayoutParams(dp(40), dp(48)));
        android.widget.ImageView image = ControlUi.iconTile(activity, icon, 37); LinearLayout.LayoutParams imageParams = new LinearLayout.LayoutParams(dp(37), dp(37)); imageParams.setMarginEnd(dp(10)); main.addView(image, imageParams);
        LinearLayout copy = new LinearLayout(activity); copy.setOrientation(LinearLayout.VERTICAL); main.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        ToolsFlowLayout titleRow = new ToolsFlowLayout(activity, 8, 6); copy.addView(titleRow, new LinearLayout.LayoutParams(-1, -2));
        TextView title = ControlUi.text(activity, name, 14); title.setTypeface(null, android.graphics.Typeface.BOLD); titleRow.addView(title);
        if (id.equals(current)) titleRow.addView(ControlUi.badge(activity, s(R.string.web_exit_current), ControlUi.BADGE_NEUTRAL));
        TextView detail = ControlUi.text(activity, address, 11); detail.setTextColor(com.google.android.material.color.MaterialColors.getColor(detail, com.google.android.material.R.attr.colorOnSurfaceVariant)); LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(-1, -2); detailParams.topMargin = dp(6); copy.addView(detail, detailParams);
        if (online != null) { TextView status = label(copy, "● " + online); status.setTextSize(11); }
        if (latency != null) {
            TextView ms = label(frame, latency); ms.setTextSize(10); ms.setPadding(dp(80), 0, 0, 0);
            Double measured = latencies.get(id);
            if (measured != null) ms.setTextColor(measured < 100 ? androidx.core.content.ContextCompat.getColor(activity, R.color.foxy_ok) : measured <= 300 ? com.google.android.material.color.MaterialColors.getColor(ms, com.google.android.material.R.attr.colorTertiary) : androidx.core.content.ContextCompat.getColor(activity, R.color.foxy_error));
        }
        radio.setOnClickListener(view -> { if (isCurrent() && enabled) choose(id); });
        frame.setEnabled(enabled); frame.setOnClickListener(view -> { if (isCurrent() && enabled) choose(id); });
    }
    private static String number(double value) { return value == Math.rint(value) ? Long.toString((long) value) : Double.toString(value); }
    private void choose(String id) { pending = null; draft = id; activity.drafts.putString("network.exitDraft", id); renderOptions(); }
    private void applySelection() {
        if (!apply.isEnabled() || activity.client.busy()) return;
        String expected = draft == null ? selectedId(routing) : draft;
        if (expected == null) return;
        confirm(title(), s(R.string.network_interrupt), () -> {
            if (!apply.isEnabled()) return;
            mutate(title(), result -> {
                JSONObject actual = result.optJSONObject("exitRouting");
                if (actual != null) { routing = actual; renderRoute(); }
                if (result.optBoolean("ok")) pending = expected;
                feedback.setVisibility(android.view.View.VISIBLE);
                feedback.setText(result.optBoolean("ok") ? s(R.string.web_net_exit_confirming) : s(R.string.network_failed, result.optString("error", s(R.string.web_net_unknown))));
                if (!result.optBoolean("ok") && actual != null) {
                    feedback.append("\n" + s(R.string.network_selected) + ": " + selectedLabel(this, actual));
                    feedback.append("\n" + s(R.string.network_effective) + ": " + s(effectiveLabel(actual)));
                    feedback.append("\nIPv4: " + booleanText(actual, "ipv4") + " · IPv6: " + booleanText(actual, "ipv6"));
                    String warning = actual.optString("warning", ""); if (!warning.isEmpty()) feedback.append("\n" + warning);
                }
                refresh(observed -> {
                    if (!result.optBoolean("ok")) return;
                    JSONObject actualRoute = observed == null ? null : observed.optJSONObject("exitRouting");
                    if (expected.equals(selectedId(actualRoute)) && actualRoute != null && !"not-effective".equals(actualRoute.optString("effective"))) {
                        draft = null; pending = null; activity.drafts.remove("network.exitDraft");
                        feedback.setText(s(expected.isEmpty() ? R.string.web_exit_cleared : R.string.web_exit_set_done)); renderOptions();
                    }
                });
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
