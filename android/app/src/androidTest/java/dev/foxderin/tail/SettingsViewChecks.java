package dev.foxderin.tail;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import android.widget.CompoundButton;
import android.widget.EditText;
import org.json.JSONArray;
import org.json.JSONObject;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

final class SettingsViewChecks {
    static void run(ControlActivity activity) throws Exception {
        Bundle drafts = new Bundle(activity.drafts);
        activity.drafts.clear();
        SettingsPage page = new SettingsPage(activity);
        try {
            ViewGroup body = (ViewGroup) field(page, "advancedBody");
            require(body.getVisibility() == View.GONE, "Advanced settings start collapsed");
            View toggle = action(page.content, activity.getString(R.string.web_tools_advanced));
            require(toggle != null && toggle.performClick(), "Advanced settings remain keyboard/click accessible");
            require(body.getVisibility() == View.VISIBLE && action(body, activity.getString(R.string.web_diag_title)) != null, "First expansion exposes advanced diagnostics");
            ContextPage context = (ContextPage) field(page, "context");
            require(context != null, "First expansion exposes context editor");
            Object editor = field(context, "raw");
            toggle.performClick(); toggle.performClick();
            require(body.getVisibility() == View.VISIBLE && context == field(page, "context") && editor == field(context, "raw"), "Collapse and reopen preserve the same rule editor and draft owner");
            TrialPage trial = (TrialPage) field(page, "trial");
            View restart = (View) field(page, "restart");
            require(!restart.isEnabled(), "Restart is disabled until the shared trial read is known");
            invoke(trial, "trialLoaded", new Class<?>[]{JSONObject.class, long.class}, new JSONObject().put("trial", JSONObject.NULL), 0L);
            require(restart.isEnabled(), "Embedded trial result drives Settings restart gating");
            invoke(trial, "failure", new Class<?>[]{Exception.class}, new IllegalStateException("trial unavailable"));
            require(!restart.isEnabled(), "Shared trial failure blocks restart");
            contextReads(activity, context);
            trialUpdates(activity);
            routingAcceptance(activity);
        } finally { page.close(); activity.drafts.clear(); activity.drafts.putAll(drafts); }
    }
    private static void contextReads(ControlActivity activity, ContextPage context) throws Exception {
        String rules = "# baseline\ncellular:-:up\n";
        activity.drafts.remove("context.baseline"); activity.drafts.remove("context.raw");
        invoke(context, "rulesLoaded", new Class<?>[]{JSONObject.class}, new JSONObject().put("rules", rules));
        EditText raw = (EditText) field(context, "raw");
        View save = (View) field(context, "save");
        require(raw.isEnabled() && save.isEnabled() && rules.contentEquals(raw.getText()), "Static rules enable editing before any live context response");
        String draft = rules + "ssid:Office:down\n"; raw.setText(draft);
        invoke(context, "statusFailed", new Class<?>[]{Exception.class}, new IllegalStateException("network delayed"));
        require(raw.isEnabled() && save.isEnabled() && draft.contentEquals(raw.getText()), "Live status failure cannot disable or overwrite the rule draft");
        require(rules.equals(activity.drafts.getString("context.baseline")), "Live failure preserves the static baseline");
        JSONObject live = new JSONObject().put("running", true).put("context", "ssid:Office");
        invoke(context, "renderStatus", new Class<?>[]{JSONObject.class}, live);
        ViewGroup status = (ViewGroup) field(context, "status"); View firstStatus = status.getChildAt(0);
        invoke(context, "failed", new Class<?>[]{Exception.class}, new IllegalStateException("rules unavailable"));
        require(status.getChildAt(0) == firstStatus && draft.contentEquals(raw.getText()), "Static refresh failure leaves independent live status and draft untouched");
        invoke(context, "rulesLoaded", new Class<?>[]{JSONObject.class}, new JSONObject().put("rules", "cellular:-:down\n"));
        require(draft.contentEquals(raw.getText()) && rules.equals(activity.drafts.getString("context.baseline")), "New saved rules preserve a diverged draft and its conflict baseline");
    }
    private static void trialUpdates(ControlActivity activity) throws Exception {
        int[] updates = {0}, ready = {0}; boolean[] allowed = {false};
        TrialPage trial = new TrialPage(activity, () -> updates[0]++, value -> allowed[0] = value);
        TrialPage standalone = new TrialPage(activity);
        try {
            JSONObject none = new JSONObject().put("trial", JSONObject.NULL);
            invoke(trial, "trialLoaded", new Class<?>[]{JSONObject.class, long.class}, none, 0L);
            require(allowed[0] && updates[0] == 0, "Initial shared trial state does not trigger a duplicate settings refresh");
            trial.checkRestart(() -> ready[0]++);
            invoke(trial, "trialLoaded", new Class<?>[]{JSONObject.class, long.class}, none, 0L);
            require(ready[0] == 1 && updates[0] == 0, "Fresh restart precheck uses the trial owner without a settings feedback loop");
            invoke(trial, "beginChange", new Class<?>[0]);
            require(!allowed[0], "Trial writes immediately invalidate restart eligibility");
            invoke(trial, "finishChange", new Class<?>[0]);
            JSONObject summary = new JSONObject().put("mode", "bridge").put("dnsMode", "legacy").put("routeScope", "all");
            JSONObject running = new JSONObject().put("id", "trial-1").put("status", "running").put("remaining", 120).put("reason", "").put("candidate", summary).put("previous", summary);
            invoke(trial, "trialLoaded", new Class<?>[]{JSONObject.class, long.class}, new JSONObject().put("trial", running), android.os.SystemClock.elapsedRealtime());
            require(!allowed[0] && updates[0] == 1, "Activation refreshes settings exactly once and keeps restart blocked");
            invoke(trial, "trialLoaded", new Class<?>[]{JSONObject.class, long.class}, new JSONObject().put("trial", new JSONObject(running.toString())), android.os.SystemClock.elapsedRealtime());
            require(updates[0] == 1, "Unchanged trial poll does not refresh settings again");
            JSONObject reverted = new JSONObject(running.toString()).put("status", "rolled-back");
            invoke(trial, "trialLoaded", new Class<?>[]{JSONObject.class, long.class}, new JSONObject().put("trial", reverted), android.os.SystemClock.elapsedRealtime());
            require(allowed[0] && updates[0] == 2, "Automatic reversion refreshes settings and restores restart eligibility");
            invoke(trial, "trialLoaded", new Class<?>[]{JSONObject.class, long.class}, new JSONObject().put("trial", new JSONObject().put("status", "running")), 0L);
            require(!allowed[0], "Malformed shared trial data cannot enable restart");
            invoke(standalone, "trialLoaded", new Class<?>[]{JSONObject.class, long.class}, none, 0L);
            require(standalone.restartAllowed(), "Standalone trial remains a valid reader without callbacks");
        } finally { trial.close(); standalone.close(); }
    }
    private static void routingAcceptance(ControlActivity activity) throws Exception {
        RoutingPage routing = new RoutingPage(activity);
        try {
            CompoundButton toggle = (CompoundButton) field(routing, "acceptanceSwitch");
            JSONObject off = new JSONObject().put("acceptRoutes", false).put("ipv6Enabled", true).put("mode", "bridge").put("peers", new JSONArray());
            Class<?>[] loaded = {int.class, Boolean.class, JSONObject.class};
            Class<?>[] failed = {int.class, Exception.class};
            invoke(routing, "acceptanceLoaded", loaded, 0, null, off);
            invoke(routing, "refreshAdvertised", new Class<?>[]{Boolean.class}, (Object) null);
            require(toggle.isEnabled() && !toggle.isChecked(), "Confirmed acceptance remains usable while a background subnet read is pending");
            invoke(routing, "beginAcceptance", new Class<?>[0]);
            require(!toggle.isEnabled(), "Acceptance mutation disables the switch until fresh verification");
            invoke(routing, "acceptanceLoaded", loaded, 1, null, off);
            require(!toggle.isEnabled() && (Boolean) field(routing, "acceptanceBusy"), "Old poll cannot finish or enable an in-flight acceptance mutation");
            invoke(routing, "refreshAdvertised", new Class<?>[]{Boolean.class}, Boolean.TRUE);
            JSONObject on = new JSONObject(off.toString()).put("acceptRoutes", true);
            invoke(routing, "acceptanceLoaded", loaded, 3, Boolean.TRUE, on);
            require(toggle.isEnabled() && toggle.isChecked(), "Post-write read verifies the accepted new value");
            invoke(routing, "acceptanceLoaded", loaded, 1, null, off);
            invoke(routing, "acceptanceFailed", failed, 1, new IllegalStateException("old read failed"));
            require(toggle.isEnabled() && toggle.isChecked(), "Late old success and error cannot overwrite a verified new value");
            invoke(routing, "acceptanceFailed", failed, 3, new IllegalStateException("current read failed"));
            invoke(routing, "refreshAdvertised", new Class<?>[]{Boolean.class}, (Object) null);
            require(!toggle.isEnabled(), "Unknown acceptance remains disabled during a retry");
            invoke(routing, "acceptanceLoaded", loaded, 4, null, new JSONObject().put("acceptRoutes", true));
            require(!toggle.isEnabled(), "Malformed response cannot enable unknown acceptance");
        } finally { routing.close(); }
    }
    private static View action(View view, String label) {
        if (view.getVisibility() != View.VISIBLE) return null;
        if (view.isClickable() && label.contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) return view;
        if (view instanceof TextView && label.contentEquals(((TextView) view).getText())) {
            for (View node = view; node != null; node = node.getParent() instanceof View ? (View) node.getParent() : null) if (node.isClickable()) return node;
        }
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            View found = action(((ViewGroup) view).getChildAt(i), label); if (found != null) return found;
        }
        return null;
    }
    private static Object field(Object target, String name) throws Exception { Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(target); }
    private static void invoke(Object target, String name, Class<?>[] types, Object... args) throws Exception { Method method = target.getClass().getDeclaredMethod(name, types); method.setAccessible(true); method.invoke(target, args); }
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
