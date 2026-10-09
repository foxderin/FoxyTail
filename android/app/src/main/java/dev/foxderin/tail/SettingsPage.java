package dev.foxderin.tail;

import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
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
    private final TextView savedState, runtimeState, dnsState, reserved;
    private final Button restart;
    private boolean loaded, binding;
    private Boolean transparent;
    private JSONObject saved;

    SettingsPage(ControlActivity activity) {
        super(activity);
        LinearLayout top = section(s(R.string.cs_settings));
        savedState = label(top, s(R.string.cs_unknown));
        button(top, s(R.string.cs_refresh), this::load);
        button(top, s(R.string.cs_trial), () -> activity.navigate("trial"));
        restart = button(top, s(R.string.cs_restart), this::restart);
        LinearLayout network = section(s(R.string.cs_network));
        bool(network, "MAGIC_DNS", R.string.cs_magic_dns);
        Field dns = new Field("DNS_MODE", 0, 0);
        label(network, s(R.string.cs_dns_mode));
        dns.spinner = choice(network, new String[]{s(R.string.cs_dns_legacy), s(R.string.cs_dns_local), s(R.string.cs_dns_transparent)}, 0, i -> draft(dns, new String[]{"legacy", "local", "transparent"}[i]));
        finish(network, dns);
        bool(network, "IPV6", R.string.cs_ipv6);
        number(network, "SOCKS_PORT", R.string.cs_socks_port, 1024, 65535);
        number(network, "DNS_PORT", R.string.cs_dns_port, 1024, 65535);
        LinearLayout background = section(s(R.string.cs_background));
        bool(background, "POWER_SAVE", R.string.cs_power_save);
        bool(background, "WATCHDOG", R.string.cs_watchdog);
        bool(background, "WATCHDOG_PROBE", R.string.cs_watchdog_probe);
        bool(background, "STATS", R.string.cs_stats);
        bool(background, "CONTEXT", R.string.cs_context_enabled);
        bool(background, "WEBUI_AUTO_REFRESH", R.string.cs_auto_refresh);
        label(background, s(R.string.cs_auto_refresh_hint));
        number(background, "WATCHDOG_INTERVAL", R.string.cs_watchdog_interval, 5, 300);
        number(background, "STATS_INTERVAL", R.string.cs_stats_interval, 10, 3600);
        number(background, "LOG_MAX_KB", R.string.cs_log_limit, 64, 10240);
        reserved = mono(section(s(R.string.cs_readonly)), s(R.string.cs_unknown));
        LinearLayout dnsBox = section(s(R.string.cs_dns_state));
        dnsState = mono(dnsBox, s(R.string.cs_unknown));
        button(dnsBox, s(R.string.cs_dns_probe), () -> probe(s(R.string.cs_dns_probe), result -> {
            if (!result.optBoolean("ok")) notice(s(R.string.cs_failed, result.optString("error", result.toString())));
            readDns();
        }, "dns-probe"));
        runtimeState = mono(section(s(R.string.cs_status)), s(R.string.cs_unknown));
        button(content, s(R.string.cs_context), () -> activity.navigate("context"));
        setEnabled(false);
        repeat(this::load, 10000);
    }
    @Override String title() { return s(R.string.cs_settings); }
    @Override void onPause() { for (Field field : fields) field.discardRequested = false; }
    private final class Field {
        final String key;
        final int min, max;
        EditText text; CompoundButton toggle; MaterialChoice spinner; TextView state; Button save;
        boolean discardRequested;
        Field(String key, int min, int max) { this.key = key; this.min = min; this.max = max; }
        String value() { return activity.drafts.getString("settings." + key, ""); }
    }
    private void bool(LinearLayout box, String key, int title) {
        Field field = new Field(key, 0, 0);
        field.toggle = toggle(box, s(title), false, value -> draft(field, value ? "on" : "off"));
        finish(box, field);
    }
    private void number(LinearLayout box, String key, int title, int min, int max) {
        Field field = new Field(key, min, max);
        field.text = input(box, s(title), "", InputType.TYPE_CLASS_NUMBER);
        field.text.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { draft(field, s.toString()); }
            public void afterTextChanged(Editable e) {}
        });
        finish(box, field);
    }
    private void finish(LinearLayout box, Field field) {
        field.state = label(box, s(R.string.cs_unknown));
        field.save = button(box, s(R.string.cs_save) + " · " + field.key, () -> save(field));
        button(box, s(R.string.cs_reload_draft) + " · " + field.key, () -> confirm(s(R.string.cs_reload_draft), s(R.string.cs_reload_confirm), () -> { field.discardRequested = true; load(); }));
        fields.add(field);
    }
    private void draft(Field field, String value) {
        if (binding) return;
        activity.drafts.putString("settings." + field.key, value);
        showField(field);
    }
    private void showField(Field field) {
        if (field.state == null) return;
        String message = saved == null ? s(R.string.cs_unknown) : s(R.string.cs_value_state, saved.optString(field.key, "?"), field.value());
        if (saved != null && conflict(field)) message += "\n" + s(R.string.cs_draft_conflict);
        field.state.setText(message);
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
            savedState.setText(s(result.optBoolean("restartRequired") ? R.string.cs_pending : R.string.cs_applied));
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
            reserved.setText(s(R.string.cs_fixed_routes, values.optString("ROUTE_TABLE", "?"), values.optString("FWMARK", "?"), values.optString("FWMARK_MASK", "?")));
        }, this::settingsFailure, "settings-get");
        readDns();
        read(result -> runtimeState.setText(SettingsState.runtime(activity, result)), e -> { runtimeState.setText(s(R.string.cs_unknown) + "\n" + e.getMessage()); error(e); }, "status");
        read(result -> {
            Object value = result.opt("trial");
            JSONObject trial = result.optJSONObject("trial");
            boolean known = value == JSONObject.NULL || trial != null && SettingsRules.trialState(trial.optString("status"));
            restart.setEnabled(known && (trial == null || !SettingsRules.trialActive(trial.optString("status"))));
        }, e -> { restart.setEnabled(false); error(e); }, "trial-status");
    }
    private void settingsFailure(Exception e) {
        loaded = false; setEnabled(false);
        for (Field field : fields) field.discardRequested = false;
        savedState.setText(s(R.string.cs_unknown) + "\n" + e.getMessage()); error(e);
    }
    private void readDns() {
        read(result -> {
            transparent = result.opt("transparentAvailable") instanceof Boolean ? result.optBoolean("transparentAvailable") : null;
            dnsState.setText(SettingsState.dns(activity, result));
        }, e -> { transparent = null; dnsState.setText(s(R.string.cs_unknown) + "\n" + e.getMessage()); error(e); }, "dns");
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
        read(result -> {
            Object value = result.opt("trial");
            JSONObject trial = result.optJSONObject("trial");
            if (value != JSONObject.NULL && (trial == null || !SettingsRules.trialState(trial.optString("status")) || SettingsRules.trialActive(trial.optString("status")))) { notice(s(R.string.cs_restart_blocked)); return; }
            confirm(s(R.string.cs_restart), s(R.string.cs_network_warning), () -> mutate(s(R.string.cs_restart), terminal -> {
                if (!terminal.optBoolean("ok")) { notice(s(R.string.cs_failed, terminal.optString("error", terminal.toString()))); load(); return; }
                read(verified -> {
                    if (Boolean.FALSE.equals(verified.opt("restartRequired"))) notice(s(R.string.cs_restart_verified));
                    else notice(s(R.string.cs_pending));
                    load();
                }, "settings-get");
            }, "control", "restart"));
        }, "trial-status");
    }
}
