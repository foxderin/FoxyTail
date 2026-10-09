package dev.foxderin.tail;

import android.content.Context;
import org.json.JSONObject;
import java.text.DateFormat;
import java.util.Date;

/** User-facing module facts: a missing value is never rendered as false or healthy. */
final class SettingsState {
    private SettingsState() {}
    static String bool(Context context, Object value) {
        return SettingsRules.booleanState(value, context.getString(R.string.cs_yes), context.getString(R.string.cs_no), context.getString(R.string.cs_value_unknown));
    }
    static String text(Context context, Object value) {
        return SettingsRules.textState(value, context.getString(R.string.cs_value_unknown));
    }
    static String state(Context context, Object value) {
        String text = text(context, value);
        int label;
        switch (text) {
            case "running": case "Running": label = R.string.cs_running; break;
            case "stopped": case "Stopped": label = R.string.cs_stopped; break;
            case "disabled": label = R.string.cs_disabled; break;
            case "degraded": label = R.string.cs_degraded; break;
            case "conflict": label = R.string.cs_conflict; break;
            case "owned": label = R.string.cs_owned; break;
            case "restore-pending": label = R.string.cs_restore_pending; break;
            case "apply-pending": label = R.string.cs_apply_pending; break;
            case "disable-pending": label = R.string.cs_disable_pending; break;
            case "preparing": label = R.string.cs_preparing; break;
            case "rolling-back": label = R.string.cs_rolling_back; break;
            case "confirmed": label = R.string.cs_confirmed; break;
            case "rolled-back": label = R.string.cs_rolled_back; break;
            case "rollback-failed": label = R.string.cs_rollback_failed; break;
            case "superseded": label = R.string.cs_superseded; break;
            case "all": label = R.string.cs_scope_all; break;
            case "selected": label = R.string.cs_scope_selected; break;
            case "bypass": label = R.string.cs_scope_bypass; break;
            default: return text;
        }
        return context.getString(label);
    }
    private static void row(StringBuilder out, Context context, int label, String value) {
        if (out.length() > 0) out.append('\n');
        out.append(context.getString(label)).append(": ").append(value);
    }
    private static void fact(StringBuilder out, Context context, int label, JSONObject value, String key) {
        row(out, context, label, state(context, value.opt(key)));
    }
    private static void flag(StringBuilder out, Context context, int label, JSONObject value, String key) {
        row(out, context, label, bool(context, value.opt(key)));
    }
    static String dns(Context context, JSONObject value) {
        StringBuilder out = new StringBuilder();
        fact(out, context, R.string.cs_actual_mode, value, "mode");
        fact(out, context, R.string.cs_configured_mode, value, "configuredMode");
        flag(out, context, R.string.cs_pending_mode, value, "pendingMode");
        flag(out, context, R.string.cs_dns_enabled, value, "enabled");
        fact(out, context, R.string.cs_state, value, "state");
        fact(out, context, R.string.cs_reason, value, "reason");
        flag(out, context, R.string.cs_listener_ready, value, "listenerReady");
        Object port = value.opt("port");
        row(out, context, R.string.cs_dns_port, port instanceof Number && ((Number) port).intValue() > 0 && ((Number) port).intValue() <= 65535 ? port.toString() : text(context, null));
        fact(out, context, R.string.cs_dns_suffix, value, "suffix");
        flag(out, context, R.string.cs_interception4, value, "interception4");
        flag(out, context, R.string.cs_interception6, value, "interception6");
        flag(out, context, R.string.cs_repair_needed, value, "repairNeeded");
        fact(out, context, R.string.cs_policy_state, value, "policyState");
        fact(out, context, R.string.cs_capability_error, value, "capabilityError");
        flag(out, context, R.string.cs_transparent_available, value, "transparentAvailable");
        fact(out, context, R.string.cs_unavailable_reason, value, "transparentUnavailableReason");
        flag(out, context, R.string.cs_upstream_native, value, "upstreamNative");
        fact(out, context, R.string.cs_ipv6_path, value, "ipv6DnsInterception");
        fact(out, context, R.string.cs_ipv6_module, value, "ipv6ModuleStatus");
        return out.toString();
    }
    static String runtime(Context context, JSONObject value) {
        StringBuilder out = new StringBuilder();
        fact(out, context, R.string.cs_daemon_state, value, "daemon");
        fact(out, context, R.string.cs_backend_state, value, "backend");
        fact(out, context, R.string.cs_actual_mode, value, "mode");
        flag(out, context, R.string.cs_power_save, value, "powerSave");
        flag(out, context, R.string.cs_magic_dns, value, "magicDns");
        JSONObject self = value.optJSONObject("self");
        row(out, context, R.string.cs_host_name, text(context, self == null ? null : self.opt("hostname")));
        return out.toString();
    }
    static String scenario(Context context, JSONObject value) {
        StringBuilder out = new StringBuilder();
        if (value == null) value = new JSONObject();
        flag(out, context, R.string.cs_watcher_running, value, "running");
        fact(out, context, R.string.cs_current_context, value, "context");
        JSONObject last = value.optJSONObject("lastResult");
        if (last == null) last = new JSONObject();
        fact(out, context, R.string.cs_last_context, last, "context");
        flag(out, context, R.string.cs_last_ok, last, "ok");
        Object at = last.opt("at");
        String when = text(context, null);
        if (at instanceof Number && ((Number) at).longValue() > 0 && ((Number) at).longValue() <= Long.MAX_VALUE / 1000) when = DateFormat.getDateTimeInstance().format(new Date(((Number) at).longValue() * 1000));
        row(out, context, R.string.cs_last_time, when);
        fact(out, context, R.string.cs_last_error, last, "error");
        return out.toString();
    }
}
