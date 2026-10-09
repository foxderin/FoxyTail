package dev.foxderin.tail;

import android.widget.*;
import org.json.*;
import java.util.*;

final class DiagnosticsPage extends ControlPage {
    private final LinearLayout results, bundle;
    private final TextView warning;
    private String mode = "share";
    private static final String[] REASONS = {"invalid_config", "pending", "applied", "stopped", "connected", "login", "unreachable", "needs_connection", "proxy", "interface_ready", "interface_missing", "managed_routes", "routes_ready", "routes_incomplete", "dns_disabled", "dns_conflict", "dns_limited", "dns_ready", "dns_unavailable"};
    private static final int[] REASON_TEXT = {R.string.tools_diag_invalid_config, R.string.tools_diag_pending, R.string.tools_diag_applied, R.string.tools_diag_stopped, R.string.tools_diag_connected, R.string.tools_diag_login, R.string.tools_diag_unreachable, R.string.tools_diag_needs_connection, R.string.tools_diag_proxy, R.string.tools_diag_interface_ready, R.string.tools_diag_interface_missing, R.string.tools_diag_managed_routes, R.string.tools_diag_routes_ready, R.string.tools_diag_routes_incomplete, R.string.tools_diag_dns_disabled, R.string.tools_diag_dns_conflict, R.string.tools_diag_dns_limited, R.string.tools_diag_dns_ready, R.string.tools_diag_dns_unavailable};
    DiagnosticsPage(ControlActivity activity) {
        super(activity); LinearLayout checks = section(s(R.string.tools_diagnostics));
        label(checks, s(R.string.tools_diag_explicit)); button(checks, s(R.string.tools_check), () -> probe(s(R.string.tools_diagnostics), result -> {
            if (ToolsUi.success(this, result)) { activity.drafts.putString("diagnostics.checks", result.toString()); renderChecks(result); }
        }, "diag-check"));
        results = section(s(R.string.tools_results));
        LinearLayout collect = section(s(R.string.tools_collect)); label(collect, s(R.string.tools_diag_contents));
        mode = activity.drafts.getString("diagnostics.mode", "share");
        choice(collect, new String[]{s(R.string.tools_share_anonymous), s(R.string.tools_local_sensitive)}, mode.equals("local") ? 1 : 0, index -> { mode = index == 0 ? "share" : "local"; activity.drafts.putString("diagnostics.mode", mode); showWarning(); });
        warning = label(collect, ""); showWarning();
        button(collect, s(R.string.tools_collect), () -> {
            String selected = mode; Runnable action = () -> mutate(s(R.string.tools_collect), result -> {
                if (ToolsUi.success(this, result)) { activity.drafts.putString("diagnostics.bundle", result.toString()); renderBundle(result); }
            }, "diag", selected);
            if (selected.equals("local")) confirm(s(R.string.tools_local_sensitive), s(R.string.tools_local_warning), action); else action.run();
        });
        bundle = section(s(R.string.tools_artifact));
    }
    String title() { return s(R.string.tools_diagnostics); }
    void load() {
        results.removeAllViews();
        JSONObject lastChecks = activity.client.lastResult("diag-check"), lastBundle = activity.client.lastResult("diag");
        if (lastChecks != null && lastChecks.optBoolean("ok")) activity.drafts.putString("diagnostics.checks", lastChecks.toString());
        if (lastBundle != null && lastBundle.optBoolean("ok")) activity.drafts.putString("diagnostics.bundle", lastBundle.toString());
        try { String checks = activity.drafts.getString("diagnostics.checks", ""), artifact = activity.drafts.getString("diagnostics.bundle", ""); if (!checks.isEmpty()) renderChecks(new JSONObject(checks)); else label(results, s(R.string.tools_unchecked)); if (!artifact.isEmpty()) renderBundle(new JSONObject(artifact)); } catch (Exception error) { error(error); }
    }
    private void showWarning() { if (warning != null) warning.setText(s(mode.equals("share") ? R.string.tools_share_warning : R.string.tools_local_warning)); }
    private void renderChecks(JSONObject result) {
        JSONArray checks = result.optJSONArray("checks"); results.removeAllViews();
        if (checks == null || checks.length() == 0) { label(results, s(R.string.tools_invalid_response)); return; }
        for (int i = 0; i < checks.length(); i++) {
            JSONObject row = checks.optJSONObject(i);
            if (row == null || !Arrays.asList("pass", "warn", "fail", "skip").contains(row.optString("level"))) { label(results, s(R.string.tools_invalid_response)); continue; }
            String id = row.optString("id"), level = row.optString("level"), reason = row.optString("reason");
            int name = switch (id) { case "config" -> R.string.tools_configuration; case "service" -> R.string.tools_service; case "tunnel" -> R.string.tools_tunnel; case "routes" -> R.string.tools_routes; case "dns" -> R.string.tools_dns; default -> R.string.tools_diagnostics; };
            int state = switch (level) { case "pass" -> R.string.tools_pass; case "warn" -> R.string.tools_warning; case "fail" -> R.string.tools_fail; default -> R.string.tools_skipped; };
            label(results, s(name) + " · " + s(state)); int reasonId = R.string.tools_invalid_response; for (int j = 0; j < REASONS.length; j++) if (REASONS[j].equals(reason)) reasonId = REASON_TEXT[j]; label(results, s(reasonId));
            String page = row.optString("page").equals("dashboard") ? "overview" : row.optString("page");
            if ((level.equals("fail") || level.equals("warn")) && Arrays.asList("settings", "overview", "account", "logs", "tunnel", "routing").contains(page)) button(results, s(R.string.tools_details), () -> activity.navigate(page));
        }
    }
    private void renderBundle(JSONObject result) {
        bundle.removeAllViews(); String id = result.optString("artifactId"), path = result.optString("path"), selected = result.optString("mode");
        if (!id.matches("art-[a-f0-9]{32}") || !Arrays.asList("share", "local").contains(selected)) { label(bundle, s(R.string.tools_invalid_response)); return; }
        label(bundle, s(selected.equals("share") ? R.string.tools_share_anonymous : R.string.tools_local_sensitive)); mono(bundle, path);
        button(bundle, s(R.string.tools_copy_path), () -> copy(s(R.string.tools_artifact), path));
        button(bundle, s(R.string.tools_save), () -> activity.saveArtifact(id, "foxytail-diagnostics-" + selected + ".tar.gz"));
        button(bundle, s(R.string.tools_share), () -> {
            Runnable share = () -> activity.shareArtifact(id, "foxytail-diagnostics-" + selected + ".tar.gz");
            if (selected.equals("local")) confirm(s(R.string.tools_local_sensitive), s(R.string.tools_local_warning), share); else share.run();
        });
    }
}
