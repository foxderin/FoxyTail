package dev.foxderin.tail;

import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;

final class RoutingPage extends ControlPage {
    private final TextView acceptance, capability, result, appsState, savedRoutes, ipv6State, draftState;
    private final Button enableAcceptance, disableAcceptance, save;
    private final LinearLayout advertised, appRows;
    private final EditText subnets, uids, search;
    private final MaterialChoice scope;
    private JSONArray apps;
    private JSONArray savedSubnets;
    private boolean binding, routesKnown, ownerKnown, ownerAvailable, acceptanceKnown, ipv6Enabled, discardRequested;
    private boolean selectedOnly;
    private int limit = 100;
    private String mode = "?", ownerReason = "";
    private String savedSnapshot;
    private final String[] scopes = {"all", "selected", "bypass"};

    RoutingPage(ControlActivity activity) {
        super(activity);
        LinearLayout acceptBox = section(s(R.string.cs_accept));
        acceptance = label(acceptBox, s(R.string.cs_unknown));
        enableAcceptance = button(acceptBox, s(R.string.cs_accept_on), () -> accept(true));
        disableAcceptance = button(acceptBox, s(R.string.cs_accept_off), () -> accept(false));
        enableAcceptance.setEnabled(false); disableAcceptance.setEnabled(false);
        button(acceptBox, s(R.string.cs_refresh), this::load);
        advertised = section(s(R.string.cs_advertised));
        LinearLayout local = section(s(R.string.cs_local_routes));
        capability = label(local, s(R.string.cs_unknown));
        savedRoutes = mono(local, s(R.string.cs_unknown));
        ipv6State = label(local, "");
        draftState = label(local, "");
        button(local, s(R.string.cs_reload_draft), () -> confirm(s(R.string.cs_reload_draft), s(R.string.cs_reload_confirm), () -> { discardRequested = true; load(); }));
        label(local, s(R.string.cs_scope_hint));
        scope = choice(local, new String[]{s(R.string.cs_scope_all), s(R.string.cs_scope_selected), s(R.string.cs_scope_bypass)}, 0, i -> {
            if (!binding) { activity.drafts.putString("routing.scope", scopes[i]); showDraftState(); }
        });
        subnets = input(local, s(R.string.cs_subnets), activity.drafts.getString("routing.subnets", ""), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        subnets.setMinLines(3);
        watch(subnets, () -> { activity.drafts.putString("routing.subnets", subnets.getText().toString()); showDraftState(); });
        button(local, s(R.string.cs_normalize), () -> {
            try { subnets.setText(String.join("\n", SettingsRules.cidrs(subnets.getText().toString()))); }
            catch (IllegalArgumentException e) { error(e); }
        });
        uids = input(local, s(R.string.cs_uids), activity.drafts.getString("routing.uids", ""), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        watch(uids, () -> { activity.drafts.putString("routing.uids", uids.getText().toString()); renderApps(); showDraftState(); });
        LinearLayout appBox = section(s(R.string.cs_apps));
        search = input(appBox, s(R.string.cs_search), activity.drafts.getString("routing.search", ""), InputType.TYPE_CLASS_TEXT);
        watch(search, () -> { activity.drafts.putString("routing.search", search.getText().toString()); limit = 100; renderApps(); });
        selectedOnly = activity.drafts.getBoolean("routing.selectedOnly", false);
        toggle(appBox, s(R.string.cs_selected_only), selectedOnly, value -> { selectedOnly = value; activity.drafts.putBoolean("routing.selectedOnly", value); renderApps(); });
        appsState = label(appBox, s(R.string.cs_unknown));
        button(appBox, s(R.string.cs_refresh), this::loadApps);
        appRows = new LinearLayout(activity); appRows.setOrientation(LinearLayout.VERTICAL); appBox.addView(appRows);
        result = label(content, s(R.string.cs_unknown));
        save = button(content, s(R.string.cs_save), this::save);
        save.setEnabled(false);
        button(content, s(R.string.cs_settings), () -> activity.navigate("settings"));
        repeat(this::load, 10000);
    }
    @Override String title() { return s(R.string.cs_routing); }
    @Override void onPause() { discardRequested = false; }
    private void watch(EditText text, Runnable action) {
        text.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { if (!binding) action.run(); }
            public void afterTextChanged(Editable e) {}
        });
    }
    @Override void load() {
        read(value -> {
            if (value.optJSONArray("uids") == null || value.optJSONArray("subnets") == null || !java.util.Arrays.asList(scopes).contains(value.optString("scope"))) {
                routesFailed(new IllegalStateException(s(R.string.cs_invalid_response))); return;
            }
            routesKnown = true; save.setEnabled(true);
            savedSubnets = value.optJSONArray("subnets");
            savedRoutes.setText(s(R.string.cs_routes_snapshot, SettingsState.state(activity, value.opt("scope")), join(value.optJSONArray("uids")), join(savedSubnets)));
            showIpv6();
            String incomingScope = value.optString("scope"), incomingUids = join(value.optJSONArray("uids")), incomingSubnets = join(savedSubnets);
            savedSnapshot = snapshot(incomingScope, incomingUids, incomingSubnets);
            SettingsRules.Draft merged = SettingsRules.mergeDraft(activity.drafts.getString("routing.baseline"), currentSnapshot(), savedSnapshot, false);
            if (discardRequested || merged.value.equals(savedSnapshot)) {
                discardRequested = false;
                activity.drafts.putString("routing.baseline", savedSnapshot);
                bindDraft(incomingScope, incomingUids, incomingSubnets);
            } else {
                activity.drafts.putString("routing.baseline", merged.baseline);
                bindDraft(activity.drafts.getString("routing.scope", incomingScope), activity.drafts.getString("routing.uids", incomingUids), activity.drafts.getString("routing.subnets", incomingSubnets));
            }
            showDraftState();
        }, this::routesFailed, "routes-get");
        read(value -> {
            if (!(value.opt("available") instanceof Boolean)) { ownerKnown = false; capability.setText(s(R.string.cs_invalid_response)); return; }
            ownerKnown = true; ownerAvailable = value.optBoolean("available"); ownerReason = value.optString("reason"); showCapability();
        }, e -> { ownerKnown = false; capability.setText(s(R.string.cs_unknown) + "\n" + e.getMessage()); error(e); }, "owner-capability");
        read(value -> {
            mode = value.opt("mode") instanceof String ? value.optString("mode") : "?";
            showCapability();
        }, e -> { mode = "?"; showCapability(); error(e); }, "status");
        refreshAdvertised(null);
        if (apps == null) loadApps();
    }
    private static String snapshot(String scope, String uids, String subnets) {
        return new JSONArray().put(scope).put(uids).put(subnets).toString();
    }
    private String currentSnapshot() {
        if (!activity.drafts.containsKey("routing.scope") && !activity.drafts.containsKey("routing.uids") && !activity.drafts.containsKey("routing.subnets")) return null;
        return snapshot(activity.drafts.getString("routing.scope", "all"), activity.drafts.getString("routing.uids", ""), activity.drafts.getString("routing.subnets", ""));
    }
    private void bindDraft(String selectedScope, String selectedUids, String destinations) {
        binding = true;
        activity.drafts.putString("routing.scope", selectedScope);
        activity.drafts.putString("routing.uids", selectedUids);
        activity.drafts.putString("routing.subnets", destinations);
        scope.setSelection(Math.max(0, java.util.Arrays.asList(scopes).indexOf(selectedScope)));
        if (!uids.getText().toString().equals(selectedUids)) uids.setText(selectedUids);
        if (!subnets.getText().toString().equals(destinations)) subnets.setText(destinations);
        binding = false; renderApps();
    }
    private boolean draftConflict() {
        return savedSnapshot != null && SettingsRules.mergeDraft(activity.drafts.getString("routing.baseline"), currentSnapshot(), savedSnapshot, false).conflict;
    }
    private void showDraftState() {
        if (savedSnapshot == null) return;
        draftState.setText(draftConflict() ? s(R.string.cs_draft_conflict) : !savedSnapshot.equals(currentSnapshot()) ? s(R.string.cs_draft_changed) : "");
    }
    private void routesFailed(Exception e) { discardRequested = false; routesKnown = false; save.setEnabled(false); savedRoutes.setText(s(R.string.cs_unknown) + "\n" + e.getMessage()); error(e); }
    private void showCapability() { capability.setText(s(R.string.cs_capability, mode, SettingsState.bool(activity, ownerKnown ? ownerAvailable : null), ownerReason)); }
    private void refreshAdvertised(Boolean expected) {
        read(value -> {
            if (!(value.opt("acceptRoutes") instanceof Boolean) || !(value.opt("ipv6Enabled") instanceof Boolean) || !(value.opt("mode") instanceof String) || value.optJSONArray("peers") == null) { acceptanceFailed(new IllegalStateException(s(R.string.cs_invalid_response))); return; }
            acceptanceKnown = true; enableAcceptance.setEnabled(!value.optBoolean("acceptRoutes")); disableAcceptance.setEnabled(value.optBoolean("acceptRoutes"));
            acceptance.setText(s(R.string.cs_accept_state, SettingsState.bool(activity, value.opt("acceptRoutes"))));
            if (expected != null && value.optBoolean("acceptRoutes") != expected) notice(s(R.string.cs_accept_mismatch));
            mode = value.optString("mode", "?"); ipv6Enabled = Boolean.TRUE.equals(value.opt("ipv6Enabled")); showCapability();
            showIpv6();
            advertised.removeAllViews();
            JSONArray peers = value.optJSONArray("peers");
            int count = 0;
            for (int i = 0; i < peers.length(); i++) {
                JSONObject peer = peers.optJSONObject(i);
                if (peer == null) continue;
                JSONArray routes = peer.optJSONArray("routes");
                if (routes == null) continue;
                Set<String> shown = new java.util.LinkedHashSet<>();
                for (int j = 0; j < routes.length(); j++) {
                    JSONObject route = routes.optJSONObject(j);
                    if (route == null) continue;
                    String cidr;
                    try { cidr = SettingsRules.cidr(route.optString("cidr")); } catch (IllegalArgumentException ignored) { continue; }
                    if (cidr.equals("0.0.0.0/0") || cidr.equals("::/0") || !shown.add(cidr)) continue;
                    count++;
                    label(advertised, s(R.string.cs_peer_route, peer.optString("hostname", peer.optString("id")), cidr, SettingsState.bool(activity, peer.opt("online")), SettingsState.bool(activity, route.opt("primary"))));
                    Button add = button(advertised, s(R.string.cs_import, cidr), () -> importCidr(cidr));
                    add.setEnabled(routesKnown && (ipv6Enabled || !cidr.contains(":")));
                }
            }
            if (count == 0) label(advertised, s(R.string.cs_empty));
            if (!ipv6Enabled) label(advertised, s(R.string.cs_ipv6_import));
        }, this::acceptanceFailed, "subnet-routes-get");
    }
    private void acceptanceFailed(Exception e) { acceptanceKnown = false; showIpv6(); enableAcceptance.setEnabled(false); disableAcceptance.setEnabled(false); acceptance.setText(s(R.string.cs_unknown) + "\n" + e.getMessage()); advertised.removeAllViews(); label(advertised, s(R.string.cs_unknown)); error(e); }
    private void showIpv6() {
        if (!acceptanceKnown) { ipv6State.setText(s(R.string.cs_unknown)); return; }
        List<String> pending = new ArrayList<>();
        if (!ipv6Enabled && savedSubnets != null) for (int i = 0; i < savedSubnets.length(); i++) {
            String cidr = savedSubnets.optString(i);
            if (cidr.contains(":")) pending.add(cidr);
        }
        ipv6State.setText(pending.isEmpty() ? "" : s(R.string.cs_ipv6_pending, String.join(", ", pending)));
    }
    private void importCidr(String cidr) {
        if (!routesKnown || !acceptanceKnown || cidr.contains(":") && !ipv6Enabled) { notice(s(R.string.cs_ipv6_import)); return; }
        try { Set<String> current = SettingsRules.cidrs(subnets.getText().toString()); current.add(cidr); subnets.setText(String.join("\n", current)); }
        catch (IllegalArgumentException e) { error(e); }
    }
    private void accept(boolean next) {
        if (!acceptanceKnown) return;
        confirm(s(R.string.cs_accept), s(R.string.cs_network_warning), () -> mutate(s(R.string.cs_accept), terminal -> {
            if (!terminal.optBoolean("ok")) notice(s(R.string.cs_failed, terminal.optString("error", terminal.toString())));
            refreshAdvertised(terminal.optBoolean("ok") ? next : null);
        }, "subnet-routes-set", next ? "on" : "off"));
    }
    private void loadApps() {
        read(value -> {
            JSONArray array = value.optJSONArray("apps");
            if (array == null) { appsState.setText(s(R.string.cs_invalid_response)); return; }
            apps = array; appsState.setText(""); renderApps();
        }, e -> { appsState.setText(s(R.string.cs_unknown) + "\n" + e.getMessage()); error(e); }, "apps");
    }
    private void renderApps() {
        if (apps == null || appRows == null) return;
        appRows.removeAllViews();
        Set<String> selected;
        try { selected = SettingsRules.uids(uids.getText().toString()); } catch (IllegalArgumentException e) { appsState.setText(e.getMessage()); return; }
        String query = search.getText().toString().toLowerCase(Locale.ROOT);
        List<JSONObject> matches = new ArrayList<>();
        for (int i = 0; i < apps.length(); i++) {
            JSONObject app = apps.optJSONObject(i);
            if (app == null) continue;
            String uid = app.optString("uid");
            if (!uid.matches("[0-9]+")) continue;
            String description = app.optString("label") + " " + app.optString("package") + " " + uid;
            if ((!selectedOnly || selected.contains(uid)) && description.toLowerCase(Locale.ROOT).contains(query)) matches.add(app);
        }
        matches.sort(Comparator.comparing(a -> a.optString("label"), String.CASE_INSENSITIVE_ORDER));
        for (int i = 0; i < Math.min(limit, matches.size()); i++) {
            JSONObject app = matches.get(i); String uid = app.optString("uid");
            android.widget.CompoundButton box = toggle(appRows, app.optString("label") + "\n" + app.optString("package") + " · UID " + uid, selected.contains(uid), on -> {
                try { Set<String> values = SettingsRules.uids(uids.getText().toString()); if (on) values.add(uid); else values.remove(uid); uids.setText(String.join(",", values)); }
                catch (IllegalArgumentException e) { error(e); }
            });
            box.setEnabled(routesKnown);
        }
        if (matches.isEmpty()) label(appRows, s(R.string.cs_empty));
        if (matches.size() > limit) button(appRows, s(R.string.cs_more), () -> { limit += 100; renderApps(); });
    }
    private void save() {
        if (!routesKnown) return;
        String selectedScope = scopes[scope.getSelectedItemPosition()];
        if (!selectedScope.equals("all") && (!ownerKnown || !ownerAvailable || !mode.equals("bridge"))) { notice(s(R.string.cs_owner_required)); return; }
        try {
            Set<String> destinations = SettingsRules.cidrs(subnets.getText().toString());
            Set<String> selected = SettingsRules.uids(uids.getText().toString());
            String csv = String.join(",", destinations), uidCsv = String.join(",", selected);
            String submittedDraft = currentSnapshot();
            String normalizedUids = String.join("\n", selected), normalizedSubnets = String.join("\n", destinations);
            confirm(s(R.string.cs_save), (draftConflict() ? s(R.string.cs_draft_conflict) + "\n\n" : "") + s(R.string.cs_network_warning), () -> mutate(s(R.string.cs_save), terminal -> {
                if (!terminal.optBoolean("ok")) result.setText(s(R.string.cs_failed, terminal.optString("error", terminal.toString())));
                else {
                    String actualSubnets = terminal.optJSONArray("subnets") == null ? normalizedSubnets : join(terminal.optJSONArray("subnets"));
                    savedSnapshot = snapshot(selectedScope, normalizedUids, actualSubnets);
                    activity.drafts.putString("routing.baseline", savedSnapshot);
                    if (java.util.Objects.equals(submittedDraft, currentSnapshot())) bindDraft(selectedScope, normalizedUids, actualSubnets);
                    showDraftState();
                    String message = s(terminal.optBoolean("applied") && !terminal.optBoolean("restartRequired") && !terminal.optBoolean("requiresIpv6") ? R.string.cs_applied : R.string.cs_pending);
                    if (!terminal.isNull("applyError")) message += "\n" + terminal.optString("applyError");
                    JSONArray skipped = terminal.optJSONArray("ipv6Skipped");
                    if (skipped != null && skipped.length() > 0) message += "\n" + s(R.string.cs_ipv6_pending, join(skipped));
                    result.setText(message);
                }
                load();
            }, "routes-set", selectedScope, uidCsv.isEmpty() ? "-" : uidCsv, csv.isEmpty() ? "-" : csv));
        } catch (IllegalArgumentException e) { error(e); }
    }
    private static String join(JSONArray values) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < values.length(); i++) out.add(values.optString(i));
        return String.join("\n", out);
    }
}
