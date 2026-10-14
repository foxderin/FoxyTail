package dev.foxderin.tail;

import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.android.material.checkbox.MaterialCheckBox;
import com.google.android.material.color.MaterialColors;
import com.google.android.material.radiobutton.MaterialRadioButton;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

final class RoutingPage extends ControlPage {
    private final Button save, addSubnet; private final View discard, selectedFilter, moreApps, retryApps, ipv6Settings, retryRoutes, pendingSettings;
    private final CompoundButton acceptanceSwitch;
    private final TextView acceptance, capability, result, appsState, selectedCount, emptySelection, ipv6State, draftState, subnetError, ipv6Pending;
    private final View refreshAcceptance;
    private final LinearLayout advertised, subnetRows, appRows, appBox;
    private final EditText subnetInput, search;
    private final MaterialRadioButton[] scopeButtons = new MaterialRadioButton[3];
    private final LinearLayout[] scopeRows = new LinearLayout[3];
    private JSONArray apps, savedSubnets, advertisedPeers, skippedIpv6;
    private boolean binding, routesKnown, ownerKnown, ownerAvailable, acceptanceKnown, acceptanceOn, ipv6Enabled, discardRequested;
    private boolean selectedOnly, acceptanceBusy, acceptanceReading, saveBusy, savedPending, appsRequested;
    private int acceptanceRevision;
    private int limit = 100;
    private String mode = "?", selectedScope = "all", savedSnapshot;
    private final Set<String> destinations = new LinkedHashSet<>(), selectedUids = new LinkedHashSet<>();
    private final String[] scopes = {"all", "selected", "bypass"};
    private final LinkedHashMap<String, AppRow> retainedApps = new LinkedHashMap<>();
    private TextView noApps;
    private boolean bindingApps;
    private String advertisedState, subnetsState;
    private JSONArray sortedAppsSource;
    private final List<JSONObject> sortedApps = new ArrayList<>();
    private String appsRenderState;

    private static final class AppRow {
        LinearLayout view;
        MaterialCheckBox checkbox;
        String label;
    }

    RoutingPage(ControlActivity activity) {
        super(activity);
        LinearLayout acceptBox = section();
        LinearLayout acceptRow = row(acceptBox); acceptRow.setGravity(Gravity.CENTER_VERTICAL);
        icon(acceptRow, R.drawable.ic_alt_route);
        TextView acceptTitle = label(acceptRow, s(R.string.web_tools_subnet_accept));
        acceptTitle.setTypeface(null, Typeface.BOLD); acceptTitle.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
        acceptanceSwitch = ControlUi.switchView(activity, false, next -> {
            if (binding || !isCurrent()) return;
            binding = true; acceptanceSwitchState(); binding = false;
            accept(next);
        });
        acceptanceSwitch.setContentDescription(s(R.string.web_tools_subnet_accept));
        acceptanceSwitch.setEnabled(false);
        acceptRow.addView(acceptanceSwitch);
        refreshAcceptance = ControlUi.iconButton(activity, R.drawable.ic_refresh, s(R.string.web_tools_subnet_refresh), () -> { if (isCurrent()) refreshAdvertised(null); });
        acceptRow.addView(refreshAcceptance);
        acceptance = hint(acceptBox, s(R.string.web_tools_subnet_unknown));
        advertised = section(s(R.string.web_tools_subnet_title), R.drawable.ic_router, null);
        hint(advertised, s(R.string.web_loading));
        LinearLayout local = section(s(R.string.web_tools_route_targets), R.drawable.ic_router, null);
        LinearLayout addRow = row(local); addRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout inputHost = new LinearLayout(activity); inputHost.setOrientation(LinearLayout.VERTICAL);
        addRow.addView(inputHost, new LinearLayout.LayoutParams(0, -2, 1));
        subnetInput = input(inputHost, s(R.string.web_route_subnets), activity.drafts.getString("routing.newSubnet", ""), InputType.TYPE_CLASS_TEXT);
        subnetInput.setHint(s(R.string.web_route_subnets_add_hint));
        addSubnet = ControlUi.tonalButton(activity, s(R.string.web_add), R.drawable.ic_add, () -> { if (isCurrent()) addSubnet(); });
        LinearLayout.LayoutParams addParams = new LinearLayout.LayoutParams(-2, -2); addParams.setMarginStart(dp(8)); addRow.addView(addSubnet, addParams);
        subnetError = hint(inputHost, ""); subnetError.setVisibility(View.GONE); subnetError.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        watch(subnetInput, () -> { activity.drafts.putString("routing.newSubnet", subnetInput.getText().toString()); subnetError.setVisibility(View.GONE); updateControls(); });
        subnetRows = new LinearLayout(activity); subnetRows.setOrientation(LinearLayout.VERTICAL); local.addView(subnetRows);
        ipv6State = hint(local, ""); ipv6State.setVisibility(View.GONE);
        ControlUi.iconGroup(local, ipv6Settings = iconButton(local, R.drawable.ic_settings, s(R.string.web_set_title), () -> activity.navigate("settings"))); ipv6Settings.setVisibility(View.GONE);
        LinearLayout policy = section(s(R.string.web_tools_route_policy), R.drawable.ic_alt_route, null);
        capability = hint(policy, s(R.string.web_tools_route_probe));
        int[] titles = {R.string.web_route_scope_all, R.string.web_route_scope_selected, R.string.web_route_scope_bypass};
        int[] hints = {R.string.web_route_scope_all_hint, R.string.web_route_scope_selected_hint, R.string.web_route_scope_bypass_hint};
        for (int i = 0; i < scopes.length; i++) {
            final int position = i;
            LinearLayout policyRow = row(policy); scopeRows[i] = policyRow;
            policyRow.setPadding(dp(15), dp(15), dp(15), dp(15)); policyRow.setGravity(Gravity.TOP);
            policyRow.setClipToPadding(false); policyRow.setClipChildren(false);
            LinearLayout.LayoutParams params = (LinearLayout.LayoutParams) policyRow.getLayoutParams(); params.bottomMargin = dp(10);
            MaterialRadioButton radio = new MaterialRadioButton(activity); scopeButtons[i] = radio;
            radio.setContentDescription(s(titles[i])); radio.setMinimumWidth(0); radio.setMinimumHeight(0); radio.setPadding(0, 0, 0, 0);
            policyRow.addView(radio, new LinearLayout.LayoutParams(dp(24), dp(24)));
            LinearLayout copy = new LinearLayout(activity); copy.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams copyParams = new LinearLayout.LayoutParams(0, -2, 1); copyParams.setMarginStart(dp(12)); policyRow.addView(copy, copyParams);
            TextView title = label(copy, s(titles[i])); title.setTextSize(14); title.setTypeface(null, Typeface.BOLD); title.setPadding(0, 0, 0, dp(5));
            hint(copy, s(hints[i]));
            policyRow.setOnClickListener(v -> selectScope(position)); radio.setOnClickListener(v -> selectScope(position));
        }
        appBox = section(s(R.string.web_route_apps), R.drawable.ic_group, null);
        search = input(appBox, s(R.string.web_tools_search_apps), activity.drafts.getString("routing.search", ""), InputType.TYPE_CLASS_TEXT);
        watch(search, () -> { if (!isCurrent()) return; activity.drafts.putString("routing.search", search.getText().toString()); limit = 100; renderApps(); });
        selectedOnly = activity.drafts.getBoolean("routing.selectedOnly", false);
        LinearLayout toolbar = row(appBox); toolbar.setGravity(Gravity.CENTER_VERTICAL);
        selectedCount = hint(toolbar, ""); selectedCount.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
        selectedFilter = ControlUi.tonalButton(activity, s(R.string.web_tools_selected), () -> {
            if (!isCurrent()) return;
            selectedOnly = !selectedOnly; activity.drafts.putBoolean("routing.selectedOnly", selectedOnly); renderApps();
        }); toolbar.addView(selectedFilter, new LinearLayout.LayoutParams(-2, -2));
        emptySelection = hint(appBox, s(R.string.web_tools_route_empty_selection));
        appsState = hint(appBox, s(R.string.web_loading));
        ControlUi.iconGroup(appBox, retryApps = iconButton(appBox, R.drawable.ic_refresh, s(R.string.web_retry), this::loadApps)); retryApps.setVisibility(View.GONE);
        androidx.core.widget.NestedScrollView appScroll = new androidx.core.widget.NestedScrollView(activity) {
            @Override protected void onMeasure(int width, int height) { super.onMeasure(width, View.MeasureSpec.makeMeasureSpec(dp(440), View.MeasureSpec.AT_MOST)); }
        };
        appScroll.setNestedScrollingEnabled(true);
        appRows = new LinearLayout(activity); appRows.setOrientation(LinearLayout.VERTICAL); appScroll.addView(appRows);
        appBox.addView(appScroll, new LinearLayout.LayoutParams(-1, -2));
        moreApps = iconButton(appBox, R.drawable.ic_expand_more, "", () -> { limit += 100; renderApps(); }); moreApps.setVisibility(View.GONE);
        result = hint(content, ""); result.setVisibility(View.GONE); result.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        retryRoutes = iconButton(content, R.drawable.ic_refresh, s(R.string.web_retry), () -> { if (routesKnown) save(); else load(); }); retryRoutes.setVisibility(View.GONE);
        ipv6Pending = hint(content, ""); ipv6Pending.setVisibility(View.GONE);
        pendingSettings = iconButton(content, R.drawable.ic_settings, s(R.string.web_set_title), () -> activity.navigate("settings")); pendingSettings.setVisibility(View.GONE);
        LinearLayout actions = row(stickyActions); actions.setGravity(Gravity.CENTER_VERTICAL);
        draftState = hint(actions, s(R.string.web_loading)); draftState.setTextSize(12); draftState.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
        save = ControlUi.primaryButton(activity, s(R.string.web_tools_apply_rules), R.drawable.ic_check_circle, () -> { if (isCurrent()) save(); });
        actions.addView(save, new LinearLayout.LayoutParams(-2, -2));
        ControlUi.iconGroup(stickyActions, discard = iconButton(stickyActions, R.drawable.ic_restart_alt, s(R.string.cs_reload_draft), () -> confirm(s(R.string.cs_reload_draft), s(R.string.cs_reload_confirm), () -> { discardRequested = true; load(); })));
        discard.setVisibility(View.GONE);
        bindDraft(activity.drafts.getString("routing.scope", "all"), activity.drafts.getString("routing.uids", ""), activity.drafts.getString("routing.subnets", ""));
        showCapability(); repeat(this::load, 10000);
    }
    @Override String title() { return s(R.string.web_route_title); }
    @Override void onPause() {
        discardRequested = false; saveBusy = false; acceptanceBusy = false; acceptanceReading = false; acceptanceKnown = false; acceptanceRevision++;
        acceptanceControls(); if (apps == null) appsRequested = false;
    }
    private void icon(LinearLayout row, int resource) {
        ImageView icon = new ImageView(activity); icon.setImageResource(resource);
        icon.setColorFilter(MaterialColors.getColor(row, androidx.appcompat.R.attr.colorPrimary));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(20), dp(20)); params.setMarginEnd(dp(10)); row.addView(icon, params);
    }
    private void watch(EditText text, Runnable action) {
        text.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) { if (!binding) action.run(); }
            public void afterTextChanged(Editable e) { }
        });
    }
    @Override void load() {
        if (!isCurrent() || saveBusy) return;
        read(value -> {
            if (value.optJSONArray("uids") == null || value.optJSONArray("subnets") == null || !java.util.Arrays.asList(scopes).contains(value.optString("scope"))) {
                routesFailed(new IllegalStateException(s(R.string.cs_invalid_response))); return;
            }
            routesKnown = true; savedSubnets = value.optJSONArray("subnets");
            String incomingScope = value.optString("scope"), incomingUids = join(value.optJSONArray("uids")), incomingSubnets = String.join("\n", SettingsRules.cidrs(join(savedSubnets)));
            savedSnapshot = snapshot(incomingScope, incomingUids, incomingSubnets);
            SettingsRules.Draft merged = SettingsRules.mergeDraft(activity.drafts.getString("routing.baseline"), currentSnapshot(), savedSnapshot, false);
            if (discardRequested || merged.value.equals(savedSnapshot)) {
                discardRequested = false; activity.drafts.putString("routing.baseline", savedSnapshot); bindDraft(incomingScope, incomingUids, incomingSubnets);
            } else {
                activity.drafts.putString("routing.baseline", merged.baseline);
                bindDraft(activity.drafts.getString("routing.scope", incomingScope), activity.drafts.getString("routing.uids", incomingUids), activity.drafts.getString("routing.subnets", incomingSubnets));
            }
            showIpv6(); updateControls();
        }, this::routesFailed, "routes-get");
        read(value -> {
            if (!(value.opt("available") instanceof Boolean)) { ownerKnown = false; showCapability(); capability.setText(s(R.string.cs_invalid_response)); return; }
            ownerKnown = true; ownerAvailable = value.optBoolean("available"); showCapability();
        }, e -> { ownerKnown = false; showCapability(); capability.setText(s(R.string.web_tools_route_probe) + "\n" + e.getMessage()); error(e); }, "owner-capability");
        read(value -> { mode = value.opt("mode") instanceof String ? value.optString("mode") : "?"; showCapability(); }, e -> { mode = "?"; showCapability(); error(e); }, "status");
        if (!acceptanceBusy) refreshAdvertised(null);
    }
    private static String snapshot(String scope, String uids, String subnets) { return new JSONArray().put(scope).put(uids).put(subnets).toString(); }
    private String currentSnapshot() {
        if (!activity.drafts.containsKey("routing.baseline")) return null;
        return snapshot(selectedScope, String.join("\n", selectedUids), String.join("\n", destinations));
    }
    private void bindDraft(String scope, String uids, String subnets) {
        selectedScope = scope; selectedUids.clear(); selectedUids.addAll(SettingsRules.uids(uids)); destinations.clear(); destinations.addAll(SettingsRules.cidrs(subnets));
        rememberDraft(); renderSubnets(); showCapability();
    }
    private void rememberDraft() {
        activity.drafts.putString("routing.scope", selectedScope); activity.drafts.putString("routing.uids", String.join("\n", selectedUids)); activity.drafts.putString("routing.subnets", String.join("\n", destinations));
    }
    private boolean draftConflict() { return savedSnapshot != null && SettingsRules.mergeDraft(activity.drafts.getString("routing.baseline"), currentSnapshot(), savedSnapshot, false).conflict; }
    private boolean dirty() { return savedSnapshot != null && !savedSnapshot.equals(currentSnapshot()); }
    private boolean editable() { return routesKnown && !saveBusy; }
    private boolean perApp() { return "bridge".equals(mode) && ownerKnown && ownerAvailable; }
    private void updateControls() {
        if (save == null) return;
        Set<String> pending = pendingIpv6();
        draftState.setText(!routesKnown ? s(R.string.web_tools_route_load_error) : draftConflict() ? s(R.string.cs_draft_conflict) : s(dirty() ? R.string.web_tools_route_pending : savedPending || !pending.isEmpty() ? R.string.web_tools_saved_pending : R.string.web_tools_route_saved));
        ipv6Pending.setText(s(R.string.web_tools_subnet_ipv6_saved) + "\n" + String.join("\n", pending));
        ipv6Pending.setVisibility(!dirty() && !pending.isEmpty() ? View.VISIBLE : View.GONE); pendingSettings.setVisibility(ipv6Pending.getVisibility());
        discard.setVisibility(dirty() ? View.VISIBLE : View.GONE);
        save.setEnabled(editable() && dirty() && (selectedScope.equals("all") || perApp()));
        save.setText(s(saveBusy ? R.string.web_loading : R.string.web_tools_apply_rules));
        subnetInput.setEnabled(editable()); addSubnet.setEnabled(editable() && !subnetInput.getText().toString().trim().isEmpty());
        for (int i = 0; i < scopes.length; i++) {
            boolean enabled = editable() && (i == 0 || perApp()), checked = scopes[i].equals(selectedScope);
            scopeButtons[i].setEnabled(enabled); scopeButtons[i].setChecked(checked); scopeRows[i].setEnabled(enabled); scopeRows[i].setAlpha(enabled ? 1f : .5f);
            GradientDrawable border = new GradientDrawable(); border.setCornerRadius(dp(12));
            border.setColor(MaterialColors.getColor(scopeRows[i], checked ? com.google.android.material.R.attr.colorPrimaryContainer : com.google.android.material.R.attr.colorSurface));
            border.setStroke(dp(1), MaterialColors.getColor(scopeRows[i], checked ? androidx.appcompat.R.attr.colorPrimary : com.google.android.material.R.attr.colorOutlineVariant)); scopeRows[i].setBackground(border);
        }
    }
    private void selectScope(int position) {
        if (!isCurrent() || !editable() || position > 0 && !perApp()) { updateControls(); return; }
        selectedScope = scopes[position]; rememberDraft(); showCapability();
    }
    private void routesFailed(Exception e) { discardRequested = false; routesKnown = false; result.setText(e.getMessage()); result.setVisibility(View.VISIBLE); retryRoutes.setVisibility(View.VISIBLE); showCapability(); renderSubnets(); error(e); }
    private void showCapability() {
        if (capability == null) return;
        List<String> messages = new ArrayList<>();
        if ("tun".equals(mode)) messages.add(s(R.string.web_route_native_scope));
        if (!ownerKnown) messages.add(s(R.string.web_tools_route_probe)); else if (!ownerAvailable) messages.add(s(R.string.web_route_no_owner));
        capability.setText(String.join("\n", messages)); capability.setVisibility(messages.isEmpty() ? View.GONE : View.VISIBLE);
        if (appBox != null) {
            boolean visible = perApp() && !selectedScope.equals("all"); ControlUi.setCardVisible(appBox, visible);
            if (visible && apps == null && !appsRequested && isCurrent()) loadApps();
        }
        updateControls(); renderApps();
    }
    private void refreshAdvertised(Boolean expected) {
        if (acceptanceReading && !acceptanceBusy) return;
        int revision = ++acceptanceRevision;
        acceptanceReading = true; acceptanceControls();
        if (advertisedPeers == null) { advertisedState = null; advertised.removeAllViews(); hint(advertised, s(R.string.web_loading)); }
        read(value -> acceptanceLoaded(revision, expected, value), e -> acceptanceFailed(revision, e), "subnet-routes-get");
    }
    private void acceptanceControls() {
        acceptanceSwitch.setEnabled(acceptanceKnown && !acceptanceBusy);
        refreshAcceptance.setEnabled(!acceptanceReading && !acceptanceBusy);
    }
    private void acceptanceLoaded(int revision, Boolean expected, JSONObject value) {
        if (revision != acceptanceRevision) return;
        if (!(value.opt("acceptRoutes") instanceof Boolean) || !(value.opt("ipv6Enabled") instanceof Boolean) || !(value.opt("mode") instanceof String) || value.optJSONArray("peers") == null) { acceptanceFailed(revision, new IllegalStateException(s(R.string.cs_invalid_response))); return; }
        acceptanceReading = false; acceptanceBusy = false; acceptanceKnown = true; acceptanceOn = value.optBoolean("acceptRoutes");
        binding = true; acceptanceSwitchState(); binding = false;
        acceptanceControls();
        acceptance.setText(expected != null && acceptanceOn != expected ? s(R.string.web_tools_subnet_mismatch) : ""); acceptance.setVisibility(acceptance.length() == 0 ? View.GONE : View.VISIBLE);
        mode = value.optString("mode", "?"); ipv6Enabled = value.optBoolean("ipv6Enabled"); advertisedPeers = value.optJSONArray("peers");
        showCapability(); showIpv6(); renderAdvertised();
    }
    private void acceptanceSwitchState() { acceptanceSwitch.setChecked(acceptanceOn); }
    private void renderAdvertised() {
        if (advertisedPeers == null) return;
        String next = new JSONArray().put(advertisedPeers).put(new JSONArray(new ArrayList<>(destinations))).put(editable()).put(acceptanceKnown).put(ipv6Enabled).toString();
        if (next.equals(advertisedState)) return;
        advertisedState = next; advertised.removeAllViews();
        int count = 0; boolean ipv6 = false;
        for (int i = 0; i < advertisedPeers.length(); i++) {
            JSONObject peer = advertisedPeers.optJSONObject(i); if (peer == null || !(peer.opt("id") instanceof String)) continue;
            JSONArray routes = peer.optJSONArray("routes"); if (routes == null) continue;
            LinkedHashMap<String, Boolean> grouped = new LinkedHashMap<>();
            for (int j = 0; j < routes.length(); j++) {
                JSONObject route = routes.optJSONObject(j); if (route == null) continue;
                String cidr; try { cidr = SettingsRules.cidr(route.optString("cidr")); } catch (IllegalArgumentException ignored) { continue; }
                if (cidr.equals("0.0.0.0/0") || cidr.equals("::/0")) continue;
                grouped.put(cidr, route.optBoolean("primary") || Boolean.TRUE.equals(grouped.get(cidr)));
            }
            if (grouped.isEmpty()) continue;
            if (count++ > 0) ControlUi.divider(advertised);
            LinearLayout heading = row(advertised); heading.setGravity(Gravity.CENTER_VERTICAL); icon(heading, R.drawable.ic_router);
            String hostname = peer.optString("hostname");
            TextView title = label(heading, hostname.isEmpty() ? peer.optString("id") : hostname); title.setTextSize(14); title.setTypeface(null, Typeface.BOLD); title.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
            View dot = new View(activity); GradientDrawable circle = new GradientDrawable(); circle.setShape(GradientDrawable.OVAL);
            circle.setColor(peer.optBoolean("online") ? androidx.core.content.ContextCompat.getColor(activity, R.color.foxy_ok) : MaterialColors.getColor(heading, com.google.android.material.R.attr.colorOutline)); dot.setBackground(circle);
            dot.setContentDescription(s(peer.optBoolean("online") ? R.string.web_tools_subnet_online : R.string.web_offline)); heading.addView(dot, new LinearLayout.LayoutParams(dp(8), dp(8)));
            for (java.util.Map.Entry<String, Boolean> route : grouped.entrySet()) {
                String cidr = route.getKey(); ipv6 |= cidr.contains(":");
                LinearLayout line = row(advertised); line.setGravity(Gravity.CENTER_VERTICAL);
                LinearLayout copy = new LinearLayout(activity); copy.setOrientation(LinearLayout.VERTICAL); line.addView(copy, new LinearLayout.LayoutParams(0, -2, 1)); mono(copy, cidr);
                if (route.getValue()) { TextView primary = hint(copy, s(R.string.web_tools_subnet_primary)); primary.setTextSize(10); }
                boolean added = destinations.contains(cidr);
                View add = ControlUi.iconButton(activity, added ? R.drawable.ic_check_circle : R.drawable.ic_add, s(R.string.web_tools_subnet_add_network) + " " + cidr, () -> { if (isCurrent()) importCidr(cidr); });
                add.setEnabled(editable() && acceptanceKnown && !added && (ipv6Enabled || !cidr.contains(":"))); line.addView(add, new LinearLayout.LayoutParams(-2, -2));
            }
        }
        if (count == 0) hint(advertised, s(R.string.web_tools_subnet_empty));
        if (ipv6 && !ipv6Enabled) { hint(advertised, s(R.string.web_tools_subnet_ipv6_disabled)); iconButton(advertised, R.drawable.ic_settings, s(R.string.web_set_title), () -> activity.navigate("settings")); }
    }
    private void acceptanceFailed(int revision, Exception e) {
        if (revision != acceptanceRevision) return;
        acceptanceReading = false; acceptanceBusy = false; acceptanceKnown = false; acceptanceControls();
        acceptance.setText(s(R.string.web_tools_subnet_unknown) + "\n" + e.getMessage()); acceptance.setVisibility(View.VISIBLE);
        if (advertisedPeers == null) {
            advertisedState = null; advertised.removeAllViews(); hint(advertised, s(R.string.web_tools_subnet_unknown));
            iconButton(advertised, R.drawable.ic_refresh, s(R.string.web_retry), () -> refreshAdvertised(null));
        } else renderAdvertised();
        showIpv6(); error(e);
    }
    private void showIpv6() {
        boolean hasIpv6 = false; for (String cidr : destinations) hasIpv6 |= cidr.contains(":");
        boolean unavailable = hasIpv6 && (!acceptanceKnown || !ipv6Enabled);
        ipv6State.setText(s(acceptanceKnown ? R.string.web_tools_subnet_ipv6_disabled : R.string.web_tools_subnet_ipv6_unknown));
        ipv6State.setVisibility(unavailable ? View.VISIBLE : View.GONE); ipv6Settings.setVisibility(unavailable ? View.VISIBLE : View.GONE);
        updateControls();
    }
    private Set<String> pendingIpv6() {
        Set<String> pending = new LinkedHashSet<>();
        if (ipv6Enabled || savedSubnets == null) return pending;
        for (int i = 0; i < savedSubnets.length(); i++) {
            String cidr = savedSubnets.optString(i);
            if (acceptanceKnown && cidr.contains(":")) pending.add(cidr);
            if (skippedIpv6 != null) for (int j = 0; j < skippedIpv6.length(); j++) if (cidr.equals(skippedIpv6.optString(j))) pending.add(cidr);
        }
        return pending;
    }
    private void renderSubnets() {
        String next = new JSONArray().put(new JSONArray(new ArrayList<>(destinations))).put(editable()).toString();
        if (next.equals(subnetsState)) return;
        subnetsState = next;
        subnetRows.removeAllViews();
        for (String cidr : destinations) {
            LinearLayout line = row(subnetRows); line.setGravity(Gravity.CENTER_VERTICAL);
            TextView text = mono(line, cidr); text.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
            View remove = ControlUi.iconButton(activity, R.drawable.ic_delete, s(R.string.web_delete) + " " + cidr, () -> {
                if (!isCurrent() || !editable()) return; destinations.remove(cidr); changedDestinations();
            }); remove.setEnabled(editable()); line.addView(remove);
        }
        if (destinations.isEmpty()) hint(subnetRows, s(R.string.web_tools_route_empty_subnets));
    }
    private void changedDestinations() { rememberDraft(); renderSubnets(); renderAdvertised(); showIpv6(); updateControls(); }
    private void addSubnet() {
        if (!editable()) return;
        String value; try { value = SettingsRules.cidr(subnetInput.getText().toString().trim()); }
        catch (IllegalArgumentException e) { subnetError.setText(s(R.string.web_route_subnets_invalid)); subnetError.setVisibility(View.VISIBLE); return; }
        if (!destinations.add(value)) { subnetError.setText(s(R.string.web_tools_route_duplicate)); subnetError.setVisibility(View.VISIBLE); return; }
        subnetInput.setText(""); subnetError.setVisibility(View.GONE); changedDestinations();
    }
    private void importCidr(String cidr) {
        if (!editable() || !acceptanceKnown || cidr.contains(":") && !ipv6Enabled) return;
        destinations.add(cidr); changedDestinations();
    }
    private int beginAcceptance() {
        acceptanceRevision++; acceptanceBusy = true; acceptanceControls();
        acceptance.setText(s(R.string.web_net_working)); acceptance.setVisibility(View.VISIBLE);
        return acceptanceRevision;
    }
    private void accept(boolean next) {
        if (!acceptanceKnown || acceptanceBusy || next == acceptanceOn) return;
        confirm(s(R.string.web_tools_subnet_accept), s(next ? R.string.web_tools_subnet_enable_confirm : R.string.web_tools_subnet_disable_confirm), () -> {
            if (!acceptanceKnown || acceptanceBusy || activity.client.busy() || !activity.client.canWrite()) return;
            int revision = beginAcceptance();
            mutate(s(R.string.web_tools_subnet_accept), terminal -> {
                if (revision != acceptanceRevision) return;
                if (!terminal.optBoolean("ok")) notice(terminal.optString("error", s(R.string.web_tools_subnet_unconfirmed)));
                acceptance.setText(s(R.string.web_net_controls_verifying)); refreshAdvertised(terminal.optBoolean("ok") ? next : null);
            }, "subnet-routes-set", next ? "on" : "off");
        });
    }
    private void loadApps() {
        if (!isCurrent()) return;
        appsRequested = true;
        appsState.setText(s(R.string.web_loading)); appsState.setVisibility(View.VISIBLE); retryApps.setVisibility(View.GONE);
        read(value -> {
            JSONArray array = value.optJSONArray("apps"); if (array == null) { appsState.setText(s(R.string.cs_invalid_response)); retryApps.setVisibility(View.VISIBLE); return; }
            apps = array; appsState.setText(""); appsState.setVisibility(View.GONE); renderApps();
        }, e -> { appsState.setText(e.getMessage()); appsState.setVisibility(View.VISIBLE); retryApps.setVisibility(View.VISIBLE); error(e); }, "apps");
    }
    private void renderApps() {
        if (appRows == null) return;
        String next = new JSONArray().put(search.getText().toString()).put(selectedScope).put(new JSONArray(new ArrayList<>(selectedUids)))
                .put(selectedOnly).put(limit).put(editable()).put(perApp()).toString();
        if (apps == sortedAppsSource && next.equals(appsRenderState)) return;
        appsRenderState = next;
        selectedCount.setText(s(R.string.web_tools_selected) + " " + selectedUids.size() + " " + s(R.string.web_tools_items));
        selectedFilter.setSelected(selectedOnly); selectedFilter.setActivated(selectedOnly); selectedFilter.setAlpha(selectedOnly ? 1f : .65f);
        androidx.core.view.ViewCompat.setStateDescription(selectedFilter, s(selectedOnly ? R.string.web_tools_selected : R.string.web_route_scope_all));
        emptySelection.setVisibility(selectedScope.equals("selected") && selectedUids.isEmpty() ? View.VISIBLE : View.GONE);
        if (apps == null) return;
        String query = search.getText().toString().toLowerCase(Locale.ROOT);
        if (apps != sortedAppsSource) {
            sortedAppsSource = apps; sortedApps.clear();
            for (int i = 0; i < apps.length(); i++) {
                JSONObject app = apps.optJSONObject(i); if (app == null || !app.optString("uid").matches("[0-9]+")) continue;
                sortedApps.add(app);
            }
            sortedApps.sort(Comparator.comparing(a -> a.optString("label"), java.text.Collator.getInstance()));
        }
        LinkedHashMap<String, AppRow> nextRows = new LinkedHashMap<>();
        LinkedHashMap<String, Integer> occurrences = new LinkedHashMap<>();
        int matches = 0, position = 0;
        bindingApps = true;
        for (JSONObject app : sortedApps) {
            String uid = app.optString("uid"), base = uid + "\u0000" + app.optString("package");
            int occurrence = occurrences.getOrDefault(base, 0); occurrences.put(base, occurrence + 1);
            String key = base + "\u0000" + occurrence;
            String description = app.optString("label") + " " + app.optString("package") + " " + uid;
            boolean shown = (!selectedOnly || selectedUids.contains(uid)) && description.toLowerCase(Locale.ROOT).contains(query);
            if (shown) shown = ++matches <= limit;
            AppRow entry = retainedApps.get(key);
            if (entry != null && !entry.label.equals(app.optString("label"))) { appRows.removeView(entry.view); entry = null; }
            if (entry == null && shown) entry = createAppRow(app, uid);
            if (entry == null) continue;
            nextRows.put(key, entry);
            if (appRows.indexOfChild(entry.view) != position) { appRows.removeView(entry.view); appRows.addView(entry.view, position); }
            position++;
            entry.view.setVisibility(shown ? View.VISIBLE : View.GONE);
            entry.checkbox.setChecked(selectedUids.contains(uid));
            entry.checkbox.setEnabled(editable() && perApp() && !selectedScope.equals("all"));
        }
        bindingApps = false;
        for (java.util.Map.Entry<String, AppRow> old : retainedApps.entrySet()) if (!nextRows.containsKey(old.getKey())) appRows.removeView(old.getValue().view);
        retainedApps.clear(); retainedApps.putAll(nextRows);
        if (noApps == null) noApps = hint(appRows, s(R.string.web_empty));
        noApps.setVisibility(matches == 0 ? View.VISIBLE : View.GONE);
        String moreLabel = s(R.string.web_tools_route_show_all) + " (" + Math.max(0, matches - limit) + ")"; moreApps.setContentDescription(moreLabel); moreApps.setTooltipText(moreLabel); moreApps.setVisibility(matches > limit ? View.VISIBLE : View.GONE);
    }
    private AppRow createAppRow(JSONObject app, String uid) {
        AppRow entry = new AppRow(); entry.label = app.optString("label");
        LinearLayout frame = new LinearLayout(activity); frame.setOrientation(LinearLayout.VERTICAL);
        frame.setLayoutParams(new LinearLayout.LayoutParams(-1, -2)); entry.view = frame;
        LinearLayout line = row(frame); line.setGravity(Gravity.CENTER_VERTICAL); line.setMinimumHeight(dp(56));
        MaterialCheckBox checkbox = new MaterialCheckBox(activity); entry.checkbox = checkbox;
        checkbox.setChecked(selectedUids.contains(uid)); checkbox.setContentDescription(entry.label);
        line.addView(checkbox, new LinearLayout.LayoutParams(dp(48), dp(48)));
        LinearLayout copy = new LinearLayout(activity); copy.setOrientation(LinearLayout.VERTICAL); line.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        label(copy, entry.label); TextView detail = hint(copy, app.optString("package") + " · UID " + uid); detail.setTextSize(12);
        line.setOnClickListener(v -> { if (isCurrent() && checkbox.isEnabled()) checkbox.performClick(); });
        checkbox.setOnCheckedChangeListener((button, checked) -> {
            if (bindingApps || !isCurrent() || !editable() || !perApp() || selectedScope.equals("all")) return;
            if (checked) selectedUids.add(uid); else selectedUids.remove(uid); rememberDraft(); renderApps(); updateControls();
        });
        ControlUi.divider(frame);
        return entry;
    }
    private void save() {
        if (!editable()) return;
        if (!selectedScope.equals("all") && !perApp()) { notice(s(R.string.cs_owner_required)); return; }
        String scope = selectedScope, csv = String.join(",", destinations), uidCsv = String.join(",", selectedUids), submittedDraft = currentSnapshot();
        String normalizedUids = String.join("\n", selectedUids), normalizedSubnets = String.join("\n", destinations);
        confirm(s(R.string.web_tools_apply_rules), (draftConflict() ? s(R.string.cs_draft_conflict) + "\n\n" : "") + s(R.string.cs_network_warning), () -> {
            saveBusy = true; updateControls(); renderApps(); renderSubnets(); renderAdvertised();
            mutate(s(R.string.web_tools_apply_rules), terminal -> {
                saveBusy = false;
                if (!terminal.optBoolean("ok")) { result.setText(terminal.optString("applyError", terminal.optString("error", s(R.string.web_op_failed)))); result.setVisibility(View.VISIBLE); retryRoutes.setVisibility(View.VISIBLE); }
                else {
                    retryRoutes.setVisibility(View.GONE);
                    String actualSubnets = terminal.optJSONArray("subnets") == null ? normalizedSubnets : String.join("\n", SettingsRules.cidrs(join(terminal.optJSONArray("subnets"))));
                    savedSnapshot = snapshot(scope, normalizedUids, actualSubnets); activity.drafts.putString("routing.baseline", savedSnapshot);
                    if (java.util.Objects.equals(submittedDraft, currentSnapshot())) bindDraft(scope, normalizedUids, actualSubnets);
                    String applyError = terminal.optString("applyError", "");
                    savedPending = !terminal.optBoolean("applied") || terminal.optBoolean("restartRequired") || !applyError.isEmpty();
                    List<String> messages = new ArrayList<>(); if (!applyError.isEmpty()) messages.add(applyError);
                    skippedIpv6 = terminal.optJSONArray("ipv6Skipped");
                    savedSubnets = new JSONArray(new ArrayList<>(SettingsRules.cidrs(actualSubnets)));
                    result.setText(String.join("\n", messages)); result.setVisibility(messages.isEmpty() ? View.GONE : View.VISIBLE);
                    retryRoutes.setVisibility(applyError.isEmpty() ? View.GONE : View.VISIBLE);
                    notice(s(terminal.optBoolean("requiresIpv6") ? R.string.web_tools_subnet_ipv6_saved : savedPending ? R.string.web_tools_saved_pending : R.string.web_route_apply_done));
                }
                load();
            }, "routes-set", scope, uidCsv.isEmpty() ? "-" : uidCsv, csv.isEmpty() ? "-" : csv);
        });
    }
    private static String join(JSONArray values) { List<String> out = new ArrayList<>(); for (int i = 0; i < values.length(); i++) out.add(values.optString(i)); return String.join("\n", out); }
}
