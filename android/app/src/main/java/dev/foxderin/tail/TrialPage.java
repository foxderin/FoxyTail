package dev.foxderin.tail;

import android.os.SystemClock;
import android.view.View;
import android.view.Gravity;
import android.graphics.Typeface;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;

final class TrialPage extends ControlPage {
    private final TextView state, candidateState, previousState, remainingState, reasonState;
    private final LinearLayout result;
    private final Button startTrial, confirmTrial, revertTrial;
    private final MaterialChoice candidate;
    private final MaterialChoice duration;
    private final View retry;
    private final Runnable onUpdate;
    private final java.util.function.Consumer<Boolean> onState;
    private Runnable restartReady;
    private JSONObject trial;
    private boolean known, readingTrial, changingTrial, refreshSettings, observedTrial;
    private long observedAt;
    private int trialRevision;
    private final String[] modes = {"saved", "bridge", "tun", "proxy"};
    private final String[] durations = {"30", "60", "120", "300"};

    TrialPage(ControlActivity activity) { this(activity, null, null); }
    TrialPage(ControlActivity activity, Runnable onUpdate, java.util.function.Consumer<Boolean> onState) {
        super(activity);
        this.onUpdate = onUpdate;
        this.onState = onState;
        LinearLayout box = section(s(R.string.web_trial_title), R.drawable.ic_sync, null);
        retry = iconButton(box, R.drawable.ic_refresh, s(R.string.web_retry), this::load); retry.setVisibility(View.GONE);
        String selected = activity.drafts.getString("trial.mode", "saved");
        candidate = formChoice(box, R.string.web_trial_candidate, new String[]{s(R.string.web_trial_saved), "bridge", "tun", "proxy"},
                Math.max(0, java.util.Arrays.asList(modes).indexOf(selected)), index -> activity.drafts.putString("trial.mode", modes[index]));
        String savedDuration = activity.drafts.getString("trial.duration", "120");
        int durationIndex = java.util.Arrays.asList(durations).indexOf(savedDuration);
        duration = formChoice(box, R.string.web_trial_duration, new String[]{"30 s", "60 s", "120 s", "300 s"},
                durationIndex < 0 ? 2 : durationIndex, index -> activity.drafts.putString("trial.duration", durations[index]));
        result = ControlUi.result(box); result.setVisibility(View.GONE);
        state = label(result, ""); state.setTypeface(null, Typeface.BOLD);
        candidateState = label(result, ""); previousState = label(result, ""); remainingState = label(result, ""); reasonState = hint(result, "");
        LinearLayout actions = row(box);
        startTrial = primary(actions, s(R.string.web_trial_start), this::startTrial);
        confirmTrial = primary(actions, s(R.string.web_trial_confirm), () -> finishTrial(true));
        revertTrial = button(actions, s(R.string.web_trial_revert), () -> finishTrial(false));
        controls();
        repeatAlways(() -> { if (!known || trial != null && SettingsRules.trialActive(trial.optString("status"))) load(); }, 2000);
        repeat(() -> { if (known && (trial == null || !SettingsRules.trialActive(trial.optString("status")))) load(); }, 10000);
        repeatAlways(this::renderTrial, 1000);
    }
    private MaterialChoice formChoice(LinearLayout parent, int title, String[] labels, int selected, java.util.function.IntConsumer changed) {
        LinearLayout row = row(parent); row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(0, title == R.string.web_trial_candidate ? 0 : dp(16), 0, dp(16));
        TextView name = label(row, s(title)); name.setTextSize(14); name.setTypeface(null, Typeface.BOLD);
        LinearLayout.LayoutParams copy = new LinearLayout.LayoutParams(0, -2, 1); copy.setMarginEnd(dp(10)); name.setLayoutParams(copy);
        MaterialChoice control = choice(row, labels, selected, changed); control.setContentDescription(s(title));
        control.setLayoutParams(new LinearLayout.LayoutParams(dp(activity.getResources().getConfiguration().screenWidthDp <= 390 ? 140 : 160), -2));
        ControlUi.divider(parent); return control;
    }
    @Override String title() { return s(R.string.web_trial_title); }
    @Override void onPause() { known = false; readingTrial = false; changingTrial = false; restartReady = null; trialRevision++; controls(); }
    @Override void operationFinished(String command) {
        if (command.startsWith("trial-")) {
            if (!changingTrial) { trialRevision++; refreshSettings = true; load(); }
        } else super.operationFinished(command);
    }
    @Override void load() {
        if (!isCurrent() || readingTrial || changingTrial) return;
        readingTrial = true;
        int revision = trialRevision;
        long requestedAt = SystemClock.elapsedRealtime();
        read(result -> {
            readingTrial = false;
            if (revision != trialRevision) { load(); return; }
            trialLoaded(result, requestedAt);
        }, e -> {
            readingTrial = false;
            if (revision != trialRevision) { load(); return; }
            failure(e);
        }, "trial-status");
    }
    private void trialLoaded(JSONObject result, long requestedAt) {
        JSONObject value = result.optJSONObject("trial");
        if (!result.has("trial") || !result.isNull("trial") && !valid(value)) { failure(new IllegalStateException(s(R.string.cs_invalid_response))); return; }
        boolean changed = observedTrial && (trial == null ? value != null : value == null || !trial.optString("id").equals(value.optString("id")) || !trial.optString("status").equals(value.optString("status")));
        trial = value; known = true; observedTrial = true; observedAt = requestedAt;
        retry.setVisibility(View.GONE);
        if (trial == null) { this.result.setVisibility(View.GONE); controls(); } else renderTrial();
        settingsUpdated(changed);
        Runnable ready = restartReady; restartReady = null;
        if (ready != null) { if (restartAllowed()) ready.run(); else notice(s(R.string.cs_restart_blocked)); }
    }
    boolean restartAllowed() { return known && !changingTrial && (trial == null || !SettingsRules.trialActive(trial.optString("status"))); }
    void checkRestart(Runnable ready) {
        if (restartReady != null) return;
        restartReady = ready; load();
    }
    private void settingsUpdated(boolean changed) {
        boolean notify = refreshSettings || changed; refreshSettings = false;
        if (notify && onUpdate != null) onUpdate.run();
    }
    private void beginChange() { changingTrial = true; known = false; restartReady = null; trialRevision++; controls(); }
    private void finishChange() { changingTrial = false; refreshSettings = true; load(); }
    private long remaining() { return trial == null ? 0 : remaining(trial.optLong("remaining"), observedAt, SystemClock.elapsedRealtime()); }
    static long remaining(long seconds, long observedAt, long now) { return Math.max(0, seconds - Math.max(0, now - observedAt) / 1000); }
    private void renderTrial() {
        if (!known || trial == null) return;
        String status = trial.optString("status");
        result.setVisibility(View.VISIBLE);
        state.setText(trialLabel(status));
        candidateState.setText(s(R.string.web_trial_candidate) + ": " + summary(trial.optJSONObject("candidate"))); candidateState.setVisibility(View.VISIBLE);
        previousState.setText(s(R.string.web_trial_previous) + ": " + summary(trial.optJSONObject("previous"))); previousState.setVisibility(View.VISIBLE);
        remainingState.setText(s(R.string.web_trial_remaining) + ": " + remaining() + " s"); remainingState.setVisibility(status.equals("running") ? View.VISIBLE : View.GONE);
        reasonState.setText(trial.optString("reason")); reasonState.setVisibility(reasonState.length() == 0 ? View.GONE : View.VISIBLE);
        controls();
    }
    private String trialLabel(String status) {
        switch (status) {
            case "preparing": return s(R.string.web_trial_preparing);
            case "running": return s(R.string.web_trial_running);
            case "rolling-back": return s(R.string.web_trial_reverting);
            case "confirmed": return s(R.string.web_trial_confirmed);
            case "rolled-back": return s(R.string.web_trial_reverted);
            case "rollback-failed": return s(R.string.web_trial_failed);
            case "superseded": return s(R.string.web_trial_superseded);
            default: return s(R.string.web_trial_invalid_response);
        }
    }
    private boolean valid(JSONObject value) {
        if (value == null || !value.optString("id").matches("[A-Za-z0-9_-]+") || !SettingsRules.trialState(value.optString("status")) || !(value.opt("remaining") instanceof Number) || !Double.isFinite(value.optDouble("remaining")) || value.optDouble("remaining") < 0 || !(value.opt("reason") instanceof String)) return false;
        for (String key : new String[]{"candidate", "previous"}) {
            JSONObject summary = value.optJSONObject(key);
            if (summary == null) return false;
            for (String name : new String[]{"mode", "dnsMode", "routeScope"}) if (!(summary.opt(name) instanceof String)) return false;
        }
        return true;
    }
    private String summary(JSONObject value) { return value.optString("mode") + " / " + value.optString("dnsMode") + " / " + value.optString("routeScope"); }
    private void failure(Exception e) {
        known = false; restartReady = null; result.setVisibility(View.VISIBLE); state.setText(s(R.string.web_trial_invalid_response) + "\n" + e.getMessage());
        candidateState.setVisibility(View.GONE); previousState.setVisibility(View.GONE); remainingState.setVisibility(View.GONE); reasonState.setVisibility(View.GONE);
        retry.setVisibility(View.VISIBLE); controls(); settingsUpdated(false); error(e);
    }
    private void controls() {
        boolean active = trial != null && SettingsRules.trialActive(trial.optString("status"));
        startTrial.setVisibility(active ? View.GONE : View.VISIBLE);
        confirmTrial.setVisibility(active ? View.VISIBLE : View.GONE);
        revertTrial.setVisibility(active ? View.VISIBLE : View.GONE);
        startTrial.setEnabled(known && !active);
        confirmTrial.setEnabled(known && trial != null && trial.optString("status").equals("running") && remaining() > 0);
        revertTrial.setEnabled(known && active);
        candidate.setEnabled(known && !active); duration.setEnabled(known && !active);
        if (onState != null) onState.accept(restartAllowed());
    }
    private void startTrial() {
        if (!known || trial != null && SettingsRules.trialActive(trial.optString("status"))) return;
        int seconds = SettingsRules.duration(durations[duration.getSelectedItemPosition()]);
        String mode = modes[candidate.getSelectedItemPosition()];
        confirm(s(R.string.web_trial_start), s(R.string.cs_network_warning), () -> {
            if (!known || changingTrial || trial != null && SettingsRules.trialActive(trial.optString("status")) || activity.client.busy() || !activity.client.canWrite()) return;
            beginChange();
            mutate(s(R.string.web_trial_start), result -> {
                if (!result.optBoolean("ok")) notice(s(R.string.cs_failed, result.optString("error", result.toString())));
                finishChange();
            }, "trial-start", Integer.toString(seconds), mode);
        });
    }
    private void finishTrial(boolean keep) {
        if (!known || trial == null || keep && (!trial.optString("status").equals("running") || remaining() == 0)) return;
        String id = trial.optString("id");
        confirm(s(keep ? R.string.web_trial_confirm : R.string.web_trial_revert), s(keep ? R.string.cs_trial_confirm_warning : R.string.cs_trial_revert_warning), () -> {
            if (!known || trial == null || !id.equals(trial.optString("id")) || keep && (!trial.optString("status").equals("running") || remaining() == 0)) { load(); return; }
            if (activity.client.busy() || !activity.client.canWrite()) return;
            beginChange();
            mutate(s(keep ? R.string.web_trial_confirm : R.string.web_trial_revert), result -> {
                if (!result.optBoolean("ok")) notice(s(R.string.cs_failed, result.optString("error", result.toString())));
                finishChange();
            }, keep ? "trial-confirm" : "trial-revert", id);
        });
    }
}
