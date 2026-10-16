package dev.foxderin.tail;

import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.*;
import com.google.android.material.color.MaterialColors;
import org.json.*;
import java.util.*;

final class DiagnosticsPage extends ControlPage {
    private final LinearLayout results, bundle, collectionState;
    private final TextView warning;
    private final MaterialChoice bundleMode;
    private final Button checkButton, collectButton;
    private String mode = "share";
    private static final String[] REASONS = {"invalid_config", "pending", "applied", "stopped", "connected", "login", "unreachable", "needs_connection", "proxy", "interface_ready", "interface_missing", "managed_routes", "routes_ready", "routes_incomplete", "dns_disabled", "dns_conflict", "dns_limited", "dns_ready", "dns_unavailable"};
    private static final int[] REASON_TEXT = {R.string.web_diag_invalid_config, R.string.web_diag_pending, R.string.web_diag_applied, R.string.web_diag_stopped, R.string.web_diag_connected, R.string.web_diag_login, R.string.web_diag_unreachable, R.string.web_diag_needs_connection, R.string.web_diag_proxy, R.string.web_diag_interface_ready, R.string.web_diag_interface_missing, R.string.web_diag_managed_routes, R.string.web_diag_routes_ready, R.string.web_diag_routes_incomplete, R.string.web_diag_dns_disabled, R.string.web_diag_dns_conflict, R.string.web_diag_dns_limited, R.string.web_diag_dns_ready, R.string.web_diag_dns_unavailable};
    DiagnosticsPage(ControlActivity activity) {
        super(activity);
        LinearLayout checks = section(s(R.string.web_diag_check), R.drawable.ic_network_check, s(R.string.web_diag_check_hint));
        checkButton = primary(checks, s(R.string.web_diag_check), this::runChecks); checkButton.setLayoutParams(new LinearLayout.LayoutParams(-2, -2));
        results = new LinearLayout(activity); results.setOrientation(LinearLayout.VERTICAL); results.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); checks.addView(results, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout collect = section(s(R.string.web_tools_diag_collect), R.drawable.ic_bug_report, s(R.string.web_tools_diag_contents));
        collectionState = new LinearLayout(activity); collectionState.setOrientation(LinearLayout.VERTICAL); collectionState.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); collect.addView(collectionState, new LinearLayout.LayoutParams(-1, -2));
        mode = activity.drafts.getString("diagnostics.mode", "share");
        bundleMode = choice(collect, new String[]{s(R.string.web_diag_share), s(R.string.web_diag_local)}, mode.equals("local") ? 1 : 0, index -> { mode = index == 0 ? "share" : "local"; activity.drafts.putString("diagnostics.mode", mode); showWarning(); }); bundleMode.setHint(s(R.string.web_diag_bundle_mode));
        warning = ControlUi.text(activity, "", 13); warning.setTextColor(color(com.google.android.material.R.attr.colorOnSurfaceVariant)); warning.setLineHeight(Math.round(warning.getTextSize() * 1.65f)); collect.addView(warning, new LinearLayout.LayoutParams(-1, -2)); showWarning();
        collectButton = primary(collect, s(R.string.web_diag_run), R.drawable.ic_bug_report, this::collect);
        LinearLayout.LayoutParams collectParams = new LinearLayout.LayoutParams(-2, -2); collectParams.topMargin = dp(16); collectButton.setLayoutParams(collectParams);
        bundle = section(s(R.string.web_tools_diag_ready), R.drawable.ic_folder, null);
        waitingBundle();
    }
    String title() { return s(R.string.web_diag_title); }
    void load() {
        results.removeAllViews(); collectionState.removeAllViews();
        boolean runningChecks = activity.client.busy() && "diag-check".equals(activity.client.lastCommand());
        boolean runningBundle = activity.client.busy() && "diag".equals(activity.client.lastCommand());
        setRunning(runningChecks, runningBundle);
        try {
            JSONObject checks = latest("diag-check", "diagnostics.checks", "diagnostics.startedAt", runningChecks);
            if (checks != null) renderChecks(checks);
            else if (runningChecks || activity.drafts.getLong("diagnostics.startedAt", 0) != 0) hint(results, s(R.string.repair_tools_diag_unconfirmed));
            JSONObject artifact = latest("diag", "diagnostics.bundle", "diagnostics.bundleStartedAt", runningBundle);
            if (runningBundle) badge(collectionState, s(R.string.web_diag_running), ControlUi.TONE_ACCENT);
            if (artifact != null && artifact.optBoolean("ok")) renderBundle(artifact);
            else {
                waitingBundle();
                if (artifact != null) hint(collectionState, artifact.optString("error", s(R.string.web_diag_unknown)));
                else if (!runningBundle && activity.drafts.getLong("diagnostics.bundleStartedAt", 0) != 0) hint(collectionState, s(R.string.repair_tools_diag_unconfirmed));
            }
        } catch (Exception error) { hint(results, s(R.string.web_diag_unknown)); error(error); }
    }
    private JSONObject latest(String command, String storedKey, String startedKey, boolean running) throws JSONException {
        long started = activity.drafts.getLong(startedKey, 0);
        if (running && started == 0) {
            started = Math.max(System.currentTimeMillis(), activity.client.lastResultTime(command) + 1);
            activity.drafts.putLong(startedKey, started); activity.drafts.remove(storedKey);
        }
        String stored = activity.drafts.getString(storedKey, "");
        JSONObject result = currentChecks(running, started, activity.client.lastResultTime(command), activity.client.lastResult(command), stored.isEmpty() ? null : new JSONObject(stored));
        if (result != null) { activity.drafts.putString(storedKey, result.toString()); activity.drafts.remove(startedKey); }
        return result;
    }
    private void setRunning(boolean checks, boolean collecting) {
        checkButton.setEnabled(!checks && !collecting); collectButton.setEnabled(!checks && !collecting); bundleMode.setEnabled(!collecting);
    }
    private void showWarning() { if (warning != null) warning.setText(s(mode.equals("share") ? R.string.web_diag_share_hint : R.string.web_diag_local_hint)); }
    private void runChecks() {
        if (!activity.client.canWrite() || activity.client.busy()) { notice(activity.client.message()); return; }
        activity.drafts.remove("diagnostics.checks");
        activity.drafts.putLong("diagnostics.startedAt", Math.max(System.currentTimeMillis(), activity.client.lastResultTime("diag-check") + 1));
        results.removeAllViews(); hint(results, s(R.string.repair_tools_diag_unconfirmed)); setRunning(true, false);
        probe(s(R.string.web_diag_check), result -> {
            activity.drafts.remove("diagnostics.startedAt"); activity.drafts.putString("diagnostics.checks", result.toString()); setRunning(false, false);
            renderChecks(result); ToolsUi.success(this, result);
        }, "diag-check");
    }
    private void collect() {
        if (!activity.client.canWrite() || activity.client.busy()) { notice(activity.client.message()); return; }
        String selected = mode;
        Runnable action = () -> {
            if (!activity.client.canWrite() || activity.client.busy()) { notice(activity.client.message()); return; }
            activity.drafts.remove("diagnostics.bundle"); activity.drafts.putLong("diagnostics.bundleStartedAt", Math.max(System.currentTimeMillis(), activity.client.lastResultTime("diag") + 1));
            waitingBundle(); collectionState.removeAllViews(); badge(collectionState, s(R.string.web_diag_running), ControlUi.TONE_ACCENT); setRunning(false, true);
            mutate(s(R.string.web_diag_run), result -> {
                activity.drafts.remove("diagnostics.bundleStartedAt"); activity.drafts.putString("diagnostics.bundle", result.toString()); collectionState.removeAllViews(); setRunning(false, false);
                if (result.optBoolean("ok")) renderBundle(result); else { waitingBundle(); hint(collectionState, result.optString("error", s(R.string.web_diag_unknown))); }
                ToolsUi.success(this, result);
            }, "diag", selected);
        };
        if (selected.equals("local")) confirm(s(R.string.web_diag_local), s(R.string.web_diag_local_hint), action); else action.run();
    }
    static JSONObject currentChecks(boolean running, long started, long resultTime, JSONObject latest, JSONObject stored) {
        if (running) return null;
        if (latest != null && (started == 0 || resultTime >= started)) return latest;
        return started == 0 ? stored : null;
    }
    private void renderChecks(JSONObject result) {
        JSONArray checks = result.optJSONArray("checks"); results.removeAllViews();
        if (!result.optBoolean("ok")) { hint(results, result.optString("error", s(R.string.web_diag_unknown))); return; }
        if (checks == null || checks.length() == 0) { hint(results, s(R.string.web_diag_unknown)); return; }
        for (int i = 0; i < checks.length(); i++) {
            JSONObject row = checks.optJSONObject(i);
            if (row == null || !(row.opt("id") instanceof String) || !(row.opt("reason") instanceof String) || !Arrays.asList("pass", "warn", "fail", "skip").contains(row.optString("level")) || !Arrays.asList("settings", "dashboard", "account", "logs", "tunnel", "routing").contains(row.optString("page"))) { hint(results, s(R.string.web_diag_unknown)); return; }
        }
        for (int i = 0; i < checks.length(); i++) {
            JSONObject row = checks.optJSONObject(i); String id = row.optString("id"), level = row.optString("level"), reason = row.optString("reason");
            int name = switch (id) { case "config" -> R.string.web_diag_item_config; case "service" -> R.string.web_diag_item_service; case "tunnel" -> R.string.web_diag_item_tunnel; case "routes" -> R.string.web_diag_item_routes; case "dns" -> R.string.web_dns_title; default -> R.string.web_diag_title; };
            int state = switch (level) { case "pass" -> R.string.web_diag_level_pass; case "warn" -> R.string.web_diag_level_warn; case "fail" -> R.string.web_diag_level_fail; default -> R.string.web_diag_level_skip; };
            int tone = switch (level) { case "pass" -> ControlUi.TONE_OK; case "warn" -> ControlUi.TONE_WARN; case "fail" -> ControlUi.TONE_ERROR; default -> ControlUi.TONE_NEUTRAL; };
            LinearLayout card = resultBox(results); badge(card, s(name) + " · " + s(state), tone);
            int reasonId = R.string.web_diag_unknown; for (int j = 0; j < REASONS.length; j++) if (REASONS[j].equals(reason)) reasonId = REASON_TEXT[j]; hint(card, s(reasonId));
            String page = row.optString("page").equals("dashboard") ? "overview" : row.optString("page");
            if (level.equals("fail") || level.equals("warn")) iconButton(card, R.drawable.ic_chevron_right, s(R.string.web_diag_view_details), () -> activity.navigate(page));
        }
    }
    private void waitingBundle() {
        bundle.removeAllViews();
        ControlUi.emptyState(bundle, s(R.string.web_tools_diag_waiting), R.drawable.ic_folder);
    }
    static boolean validBundle(JSONObject result) {
        String path = result.optString("path");
        return result.optBoolean("ok") && result.optString("artifactId").matches("art-[a-f0-9]{32}") && Arrays.asList("share", "local").contains(result.optString("mode"))
                && path.startsWith("/") && path.endsWith(".tar.gz") && !path.matches("(?s).*[\\x00-\\x1f\\x7f].*");
    }
    private void renderBundle(JSONObject result) {
        bundle.removeAllViews();
        if (!validBundle(result)) { hint(bundle, s(R.string.web_diag_unknown)); return; }
        String id = result.optString("artifactId"), path = result.optString("path"), selected = result.optString("mode");
        badge(bundle, s(R.string.web_diag_done), ControlUi.TONE_OK); hint(bundle, s(selected.equals("share") ? R.string.web_diag_share : R.string.web_diag_local));
        LinearLayout file = resultBox(bundle); TextView pathView = mono(file, path); pathView.setTextSize(12); pathView.setLineHeight(Math.round(pathView.getTextSize() * 1.7f));
        Button copy = tonal(file, s(R.string.web_tools_copy_path), () -> copy(s(R.string.web_tools_diag_ready), path)); copy.setLayoutParams(new LinearLayout.LayoutParams(-2, -2)); ((com.google.android.material.button.MaterialButton) copy).setIconResource(R.drawable.ic_content_copy);
        LinearLayout exports = row(file);
        button(exports, s(R.string.tools_save), () -> activity.saveArtifact(id, "foxytail-diagnostics-" + selected + ".tar.gz"));
        button(exports, s(R.string.tools_share), () -> {
            Runnable share = () -> activity.shareArtifact(id, "foxytail-diagnostics-" + selected + ".tar.gz");
            if (selected.equals("local")) confirm(s(R.string.web_diag_local), s(R.string.web_diag_local_hint), share); else share.run();
        });
    }
    private LinearLayout resultBox(LinearLayout parent) {
        LinearLayout box = new LinearLayout(activity); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(14), dp(14), dp(14), dp(14));
        GradientDrawable background = new GradientDrawable(); background.setCornerRadius(dp(12)); background.setColor(color(com.google.android.material.R.attr.colorSurfaceContainer)); background.setStroke(dp(1), color(com.google.android.material.R.attr.colorOutlineVariant)); box.setBackground(background);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(14); parent.addView(box, params); return box;
    }
    private int color(int attr) { return MaterialColors.getColor(content, attr); }
}
