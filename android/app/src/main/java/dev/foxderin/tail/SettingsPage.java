package dev.foxderin.tail;

import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.graphics.Typeface;
import org.json.JSONArray;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

final class SettingsPage extends ControlPage {
    private final List<Field> fields = new ArrayList<>();
    private final TextView savedState, dnsHint, dnsReason, probePaused;
    private final LinearLayout pending, advancedBody;
    private TextView table, mark, mask, dnsState, runtimeState;
    private LinearLayout hooks, diagnostics;
    private ContextPage context;
    private final Button restart;
    private final TrialPage trial;
    private Field dnsField;
    private boolean advancedOpen, capabilityProbed, diagnosticsOpen;
    private boolean loaded, binding;
    private Boolean transparent;
    private JSONObject saved;

    SettingsPage(ControlActivity activity) {
        super(activity);
        pending = section();
        label(pending, s(R.string.web_tools_saved_pending));
        restart = primary(pending, s(R.string.web_tools_restart), R.drawable.ic_refresh, this::restart);
        ControlUi.setCardVisible(pending, false);
        LinearLayout appearance = section(s(R.string.web_tools_appearance), R.drawable.ic_dark_mode, null);
        android.content.SharedPreferences preferences = activity.getSharedPreferences("interface", android.content.Context.MODE_PRIVATE);
        String theme = preferences.getString("theme", "auto");
        appearanceChoice(appearance, R.string.web_set_theme, new String[]{s(R.string.web_set_theme_auto), s(R.string.web_set_theme_light), s(R.string.web_set_theme_dark)},
                "dark".equals(theme) ? 2 : "light".equals(theme) ? 1 : 0, i -> activity.setAppearance("theme", new String[]{"auto", "light", "dark"}[i]));
        String language = activity.getResources().getConfiguration().getLocales().get(0).getLanguage();
        appearanceChoice(appearance, R.string.web_set_language, new String[]{"中文", "English"}, "zh".equals(language) ? 0 : 1,
                i -> activity.setAppearance("language", i == 0 ? "zh" : "en"));
        LinearLayout network = section(s(R.string.web_tools_network_settings), R.drawable.ic_router, null);
        bool(network, "MAGIC_DNS", R.string.web_tools_magicdns, R.string.web_tools_magicdns_desc);
        dnsField = new Field("DNS_MODE", 0, 0);
        LinearLayout dnsRow = settingRow(network, true);
        settingTitle(dnsRow, s(R.string.web_tools_dns_mode));
        dnsHint = hint(dnsRow, s(R.string.web_tools_dns_mode_legacy_hint));
        dnsReason = hint(dnsRow, ""); dnsReason.setVisibility(View.GONE);
        dnsField.spinner = choice(dnsRow, new String[]{s(R.string.web_tools_dns_mode_legacy), s(R.string.web_tools_dns_mode_local), s(R.string.web_tools_dns_mode_transparent_option)}, 0,
                i -> draft(dnsField, new String[]{"legacy", "local", "transparent"}[i]));
        dnsField.spinner.setContentDescription(s(R.string.web_tools_dns_mode));
        LinearLayout.LayoutParams dnsParams = (LinearLayout.LayoutParams) dnsField.spinner.getLayoutParams(); dnsParams.topMargin = dp(activity.getResources().getConfiguration().screenWidthDp <= 390 ? 10 : 18);
        finish(network, dnsField);
        bool(network, "IPV6", R.string.web_tools_ipv6, R.string.web_set_ipv6_hint);
        number(network, "SOCKS_PORT", R.string.web_tools_socks_port, 0, 1024, 65535);
        number(network, "DNS_PORT", R.string.web_tools_dns_port, 0, 1024, 65535);
        LinearLayout networkStatus = row(network);
        savedState = badge(networkStatus, s(R.string.cs_unknown), ControlUi.TONE_NEUTRAL);
        iconButton(networkStatus, R.drawable.ic_router, s(R.string.web_tools_mode_link), () -> activity.navigate("tunnel"));
        LinearLayout background = section(s(R.string.web_tools_background), R.drawable.ic_sync, null);
        bool(background, "POWER_SAVE", R.string.web_tools_power_save, R.string.web_tools_power_save_desc);
        bool(background, "WATCHDOG", R.string.web_tools_watchdog, R.string.web_tools_watchdog_desc);
        Field watchdogProbe = bool(background, "WATCHDOG_PROBE", R.string.web_tools_watchdog_probe, R.string.web_tools_watchdog_probe_desc);
        probePaused = hint(watchdogProbe.copy, s(R.string.web_tools_probe_paused)); probePaused.setVisibility(View.GONE);
        bool(background, "STATS", R.string.web_tools_stats_enabled, R.string.web_tools_stats_enabled_desc);
        bool(background, "CONTEXT", R.string.web_tools_context_enabled, R.string.web_tools_context_enabled_desc);
        bool(background, "WEBUI_AUTO_REFRESH", R.string.web_tools_auto_refresh, R.string.web_tools_auto_refresh_desc);
        number(background, "WATCHDOG_INTERVAL", R.string.web_tools_watchdog_interval, 0, 5, 300);
        number(background, "STATS_INTERVAL", R.string.web_tools_stats_interval, 0, 10, 3600);
        number(background, "LOG_MAX_KB", R.string.web_tools_log_limit, 0, 64, 10240);
        trial = new TrialPage(activity, this::load, restart::setEnabled);
        embed(trial, content);
        advancedBody = ControlUi.disclosure(content, s(R.string.web_tools_advanced), R.drawable.ic_settings, this::toggleAdvanced);
        advancedBody.setVisibility(View.GONE);
        embed(new BackupPage(activity), content);
        setEnabled(false);
        repeat(this::load, 10000);
    }
    @Override String title() { return s(R.string.web_set_title); }
    @Override void onPause() { for (Field field : fields) field.discardRequested = false; }
    @Override void operationFinished(String command) {
        if (command.startsWith("trial-")) trial.operationFinished(command);
        else super.operationFinished(command);
    }
    private LinearLayout settingRow(LinearLayout parent, boolean stacked) {
        boolean disclosure = "web-disclosure-body".equals(parent.getTag());
        if (parent.getChildCount() > 0 && !disclosure) ControlUi.divider(parent);
        LinearLayout row = new LinearLayout(activity); row.setOrientation(stacked ? LinearLayout.VERTICAL : LinearLayout.HORIZONTAL); row.setGravity(Gravity.CENTER_VERTICAL);
        if (disclosure) {
            android.graphics.drawable.LayerDrawable border = new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[]{new android.graphics.drawable.ColorDrawable(com.google.android.material.color.MaterialColors.getColor(row, com.google.android.material.R.attr.colorOutlineVariant))});
            border.setLayerGravity(0, Gravity.BOTTOM | Gravity.FILL_HORIZONTAL); border.setLayerHeight(0, dp(1)); row.setBackground(border);
        }
        row.setPadding(0, parent.getChildCount() == 0 ? 0 : dp(16), 0, dp(16) + (disclosure ? dp(1) : 0)); parent.addView(row, new LinearLayout.LayoutParams(-1, -2)); return row;
    }
    private TextView settingTitle(LinearLayout parent, String text) {
        TextView title = label(parent, text); title.setTextSize(14); title.setTypeface(null, Typeface.BOLD); title.setPadding(0, 0, 0, dp(4)); return title;
    }
    private LinearLayout copyColumn(LinearLayout row, int title, int description) {
        LinearLayout copy = new LinearLayout(activity); copy.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1); params.setMarginEnd(dp(activity.getResources().getConfiguration().screenWidthDp <= 390 ? 10 : 18)); row.addView(copy, params);
        settingTitle(copy, s(title)); if (description != 0) hint(copy, s(description)); return copy;
    }
    private void appearanceChoice(LinearLayout parent, int title, String[] labels, int selected, java.util.function.IntConsumer change) {
        LinearLayout row = settingRow(parent, false); copyColumn(row, title, 0);
        MaterialChoice control = choice(row, labels, selected, change); control.setContentDescription(s(title));
        control.setLayoutParams(new LinearLayout.LayoutParams(dp(activity.getResources().getConfiguration().screenWidthDp <= 390 ? 140 : 160), -2));
    }
    private TextView readOnly(LinearLayout parent, int title) {
        LinearLayout row = settingRow(parent, false); LinearLayout copy = copyColumn(row, title, 0);
        if (title == R.string.web_tools_route_table) {
            hint(copy, s(R.string.web_tools_range) + " 1000–65535");
            LinearLayout control = new LinearLayout(activity); control.setOrientation(LinearLayout.VERTICAL);
            row.addView(control, new LinearLayout.LayoutParams(dp(activity.getResources().getConfiguration().screenWidthDp <= 390 ? 112 : 136), -2));
            EditText value = ControlUi.compactInput(control, "", "1052", InputType.TYPE_CLASS_NUMBER);
            value.setContentDescription(s(title)); value.setEnabled(false); return value;
        }
        TextView value = mono(row, s(R.string.cs_unknown)); value.setLayoutParams(new LinearLayout.LayoutParams(-2, -2)); return value;
    }
    private void toggleAdvanced(boolean open) {
        advancedOpen = open;
        if (open && context == null) buildAdvanced();
        if (context != null) setEmbeddedVisible(context, open);
        if (open) loadHooks();
    }
    private void buildAdvanced() {
        table = readOnly(advancedBody, R.string.web_tools_route_table);
        mark = readOnly(advancedBody, R.string.web_tools_mark);
        mask = readOnly(advancedBody, R.string.web_tools_mark_mask);
        hint(advancedBody, s(R.string.cs_readonly));
        context = new ContextPage(activity, true); embed(context, advancedBody);
        hooks = ControlUi.card(advancedBody, s(R.string.web_set_hooks), R.drawable.ic_article, null);
        hint(hooks, s(R.string.web_loading));
        iconButton(advancedBody, R.drawable.ic_monitoring, s(R.string.web_diag_title), this::toggleDiagnostics);
        diagnostics = new LinearLayout(activity); diagnostics.setOrientation(LinearLayout.VERTICAL); advancedBody.addView(diagnostics); diagnostics.setVisibility(View.GONE);
        hint(diagnostics, s(R.string.cs_dns_state)); dnsState = mono(diagnostics, s(R.string.cs_unknown));
        iconButton(diagnostics, R.drawable.ic_dns, s(R.string.cs_dns_probe), () -> probe(s(R.string.cs_dns_probe), result -> {
            if (!result.optBoolean("ok")) notice(s(R.string.cs_failed, result.optString("error", result.toString())));
            readDns();
        }, "dns-probe"));
        hint(diagnostics, s(R.string.cs_status)); runtimeState = mono(diagnostics, s(R.string.cs_unknown));
        if (saved != null) bindAdvanced();
    }
    private void bindAdvanced() {
        table.setText(saved.optString("ROUTE_TABLE", "?")); mark.setText(saved.optString("FWMARK", "?")); mask.setText(saved.optString("FWMARK_MASK", "?"));
    }
    private void loadHooks() {
        read(result -> {
            hooks.removeAllViews(); JSONArray entries = result.optJSONArray("hooks");
            if (entries == null) { hint(hooks, s(R.string.cs_invalid_response)); return; }
            for (String name : new String[]{"foxytail.tun.up", "foxytail.tun.down"}) {
                JSONObject found = null;
                for (int i = 0; i < entries.length(); i++) { JSONObject entry = entries.optJSONObject(i); if (entry != null && name.equals(entry.optString("name"))) { found = entry; break; } }
                LinearLayout hook = ControlUi.result(hooks);
                hint(hook, s(name.endsWith(".up") ? R.string.web_set_hook_up : R.string.web_set_hook_down));
                mono(hook, found == null || found.optBoolean("missing") ? s(R.string.web_misc_missing) : found.optString("content").isEmpty() ? s(R.string.web_misc_empty) : found.optString("content"));
            }
        }, error -> { hooks.removeAllViews(); hint(hooks, s(R.string.web_misc_unavailable)); error(error); }, "hooks-get");
    }
    private void toggleDiagnostics() {
        diagnosticsOpen = !diagnosticsOpen; diagnostics.setVisibility(diagnosticsOpen ? View.VISIBLE : View.GONE);
        if (diagnosticsOpen) { readDns(); readRuntime(); }
    }
    private final class Field {
        final String key;
        final int min, max;
        EditText text; CompoundButton toggle; MaterialChoice spinner; TextView state; View save; LinearLayout actions, copy;
        boolean discardRequested;
        Field(String key, int min, int max) { this.key = key; this.min = min; this.max = max; }
        String value() { return activity.drafts.getString("settings." + key, ""); }
    }
    private Field bool(LinearLayout box, String key, int title, int description) {
        Field field = new Field(key, 0, 0);
        LinearLayout row = settingRow(box, false); field.copy = copyColumn(row, title, description);
        field.toggle = ControlUi.switchView(activity, false, value -> { if (isCurrent()) draft(field, value ? "on" : "off"); });
        field.toggle.setContentDescription(s(title)); row.addView(field.toggle, new LinearLayout.LayoutParams(dp(52), dp(48)));
        finish(box, field); return field;
    }
    private void number(LinearLayout box, String key, int title, int description, int min, int max) {
        Field field = new Field(key, min, max);
        LinearLayout row = settingRow(box, false); field.copy = copyColumn(row, title, description);
        hint(field.copy, s(R.string.web_tools_range) + " " + min + "–" + max);
        LinearLayout control = new LinearLayout(activity); control.setOrientation(LinearLayout.VERTICAL);
        row.addView(control, new LinearLayout.LayoutParams(dp(activity.getResources().getConfiguration().screenWidthDp <= 390 ? 112 : 136), -2));
        field.text = ControlUi.compactInput(control, "", "", InputType.TYPE_CLASS_NUMBER); field.text.setContentDescription(s(title));
        field.text.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { draft(field, s.toString()); }
            public void afterTextChanged(Editable e) {}
        });
        finish(box, field);
    }
    private void finish(LinearLayout box, Field field) {
        field.state = hint(box, ""); field.state.setVisibility(View.GONE);
        field.actions = row(box); field.actions.setVisibility(View.GONE);
        field.save = iconButton(field.actions, R.drawable.ic_save, s(R.string.cs_save), () -> save(field));
        iconButton(field.actions, R.drawable.ic_restart_alt, s(R.string.cs_reload_draft), () -> confirm(s(R.string.cs_reload_draft), s(R.string.cs_reload_confirm), () -> { field.discardRequested = true; load(); }));
        fields.add(field);
    }
    private void draft(Field field, String value) {
        if (binding) return;
        activity.drafts.putString("settings." + field.key, value);
        showField(field);
        if (field == dnsField) updateDnsHint();
    }
    private void showField(Field field) {
        boolean changed = saved != null && !saved.optString(field.key).equals(field.value());
        boolean conflict = conflict(field);
        field.state.setText(conflict ? s(R.string.cs_draft_conflict) : s(R.string.cs_draft_changed));
        field.state.setVisibility(changed || conflict ? android.view.View.VISIBLE : android.view.View.GONE);
        field.actions.setVisibility(changed || conflict ? android.view.View.VISIBLE : android.view.View.GONE);
        field.save.setEnabled(loaded && changed);
    }
    private boolean conflict(Field field) {
        return saved != null && SettingsRules.mergeDraft(activity.drafts.getString("settings.baseline." + field.key), field.value(), saved.optString(field.key), false).conflict;
    }
    private void bindField(Field field, String value) {
        binding = true;
        activity.drafts.putString("settings." + field.key, value);
        if (field.text != null && !field.text.getText().toString().equals(value)) field.text.setText(value);
        if (field.toggle != null) field.toggle.setChecked(value.equals("on"));
        if (field.spinner != null) field.spinner.setSelection(value.equals("transparent") ? 2 : value.equals("local") ? 1 : 0);
        binding = false;
    }
    private void setEnabled(boolean enabled) {
        for (Field field : fields) {
            if (field.text != null) field.text.setEnabled(enabled);
            if (field.toggle != null) field.toggle.setEnabled(enabled);
            if (field.spinner != null) field.spinner.setEnabled(enabled);
            field.save.setEnabled(enabled);
        }
    }
    @Override void load() {
        read(result -> {
            JSONObject values = result.optJSONObject("settings");
            if (values == null || !(result.opt("restartRequired") instanceof Boolean)) { settingsFailure(new IllegalStateException(s(R.string.cs_invalid_response))); return; }
            for (Field field : fields) if (!(values.opt(field.key) instanceof String)) { settingsFailure(new IllegalStateException(s(R.string.cs_invalid_response))); return; }
            saved = values; loaded = true; setEnabled(true);
            savedState.setText(s(result.optBoolean("restartRequired") ? R.string.web_tools_saved_pending : R.string.web_tools_all_applied));
            ControlUi.setBadgeTone(savedState, result.optBoolean("restartRequired") ? ControlUi.TONE_WARN : ControlUi.TONE_OK);
            ControlUi.setCardVisible(pending, result.optBoolean("restartRequired"));
            for (Field field : fields) {
                if (field.discardRequested) {
                    field.discardRequested = false;
                    activity.drafts.putString("settings.baseline." + field.key, values.optString(field.key));
                    bindField(field, values.optString(field.key)); showField(field); continue;
                }
                SettingsRules.Draft merged = SettingsRules.mergeDraft(activity.drafts.getString("settings.baseline." + field.key), activity.drafts.getString("settings." + field.key), values.optString(field.key), false);
                activity.drafts.putString("settings.baseline." + field.key, merged.baseline);
                bindField(field, merged.value);
                showField(field);
            }
            activity.setAutoRefresh(values.optString("WEBUI_AUTO_REFRESH").equals("on"));
            if (table != null) bindAdvanced();
            updateDnsHint();
        }, this::settingsFailure, "settings-get");
        readDns();
        readRuntime();
        if (advancedOpen) loadHooks();
    }
    private void settingsFailure(Exception e) {
        loaded = false; setEnabled(false);
        for (Field field : fields) field.discardRequested = false;
        savedState.setText(s(R.string.cs_unknown) + "\n" + e.getMessage()); error(e);
    }
    private void readDns() {
        read(result -> {
            if (diagnosticsOpen) dnsState.setText(SettingsState.dns(activity, result));
            transparent = result.opt("transparentAvailable") instanceof Boolean ? result.optBoolean("transparentAvailable") : null;
            dnsReason.setText(result.optString("transparentUnavailableReason", ""));
            updateDnsHint();
            if (transparent == null && !capabilityProbed && !activity.client.busy()) {
                capabilityProbed = true;
                probe(s(R.string.cs_dns_probe), value -> { if (!value.optBoolean("ok")) notice(s(R.string.cs_failed, value.optString("error"))); readDns(); }, "dns-probe");
            }
        }, error -> { transparent = null; updateDnsHint(); if (diagnosticsOpen) dnsState.setText(s(R.string.cs_unknown) + "\n" + error.getMessage()); error(error); }, "dns");
    }
    private void readRuntime() {
        read(result -> {
            probePaused.setVisibility(result.optBoolean("powerSave") ? View.VISIBLE : View.GONE);
            if (diagnosticsOpen) runtimeState.setText(SettingsState.runtime(activity, result));
        }, error -> { if (diagnosticsOpen) runtimeState.setText(s(R.string.cs_unknown) + "\n" + error.getMessage()); error(error); }, "status");
    }
    private void updateDnsHint() {
        String mode = dnsField.value();
        dnsField.spinner.setItemEnabled(2, !Boolean.FALSE.equals(transparent));
        dnsHint.setText(s(mode.equals("transparent") ? Boolean.FALSE.equals(transparent) ? R.string.web_tools_dns_mode_transparent_unavailable : R.string.web_tools_dns_mode_transparent_hint : mode.equals("local") ? R.string.web_tools_dns_mode_local_hint : R.string.web_tools_dns_mode_legacy_hint));
        dnsReason.setVisibility(Boolean.FALSE.equals(transparent) && dnsReason.length() > 0 ? View.VISIBLE : View.GONE);
    }
    private void save(Field field) {
        if (!loaded) { notice(s(R.string.cs_unknown)); return; }
        String original = field.value();
        String value = original.trim();
        if (field.min > 0) {
            try { if (!value.matches("[0-9]+") || Long.parseLong(value) < field.min || Long.parseLong(value) > field.max) throw new NumberFormatException(); }
            catch (NumberFormatException e) { notice(s(R.string.cs_number_range, field.min, field.max)); return; }
        }
        if (field.key.equals("DNS_MODE") && value.equals("transparent") && Boolean.FALSE.equals(transparent)) { notice(s(R.string.cs_dns_unavailable)); return; }
        Runnable write = () -> mutate(s(R.string.cs_save) + " " + field.key, result -> {
            if (result.optBoolean("ok")) {
                activity.drafts.putString("settings.baseline." + field.key, value);
                if (field.value().equals(original)) bindField(field, value);
            }
            notice(result.optBoolean("ok") ? s(result.optBoolean("applied") ? R.string.cs_applied : R.string.cs_pending) : s(R.string.cs_failed, result.optString("error", result.toString())));
            load();
        }, "settings-set", field.key, value);
        if (conflict(field) || field.key.equals("MAGIC_DNS") || field.key.equals("DNS_MODE") || field.key.equals("IPV6") || field.key.endsWith("_PORT")) confirm(s(R.string.cs_save), (conflict(field) ? s(R.string.cs_draft_conflict) + "\n\n" : "") + s(R.string.cs_network_warning), write);
        else write.run();
    }
    private void restart() {
        trial.checkRestart(() -> confirm(s(R.string.cs_restart), s(R.string.cs_network_warning), () -> {
            if (!trial.restartAllowed()) { notice(s(R.string.cs_restart_blocked)); return; }
            mutate(s(R.string.cs_restart), terminal -> {
                if (!terminal.optBoolean("ok")) { notice(s(R.string.cs_failed, terminal.optString("error", terminal.toString()))); load(); return; }
                read(verified -> {
                    if (Boolean.FALSE.equals(verified.opt("restartRequired"))) notice(s(R.string.cs_restart_verified));
                    else notice(s(R.string.cs_pending));
                    load();
                }, "settings-get");
            }, "control", "restart");
        }));
    }
}
