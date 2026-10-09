package dev.foxderin.tail;

import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;

final class TrialPage extends ControlPage {
    private final TextView state;
    private final Button startTrial, confirmTrial, revertTrial;
    private final MaterialChoice candidate;
    private final EditText duration;
    private JSONObject trial;
    private boolean known;
    private final String[] modes = {"saved", "bridge", "tun", "proxy"};

    TrialPage(ControlActivity activity) {
        super(activity);
        LinearLayout box = section(s(R.string.cs_trial));
        label(box, s(R.string.cs_trial_hint));
        state = mono(box, s(R.string.cs_unknown));
        button(box, s(R.string.cs_refresh), this::load);
        label(box, s(R.string.cs_candidate));
        String selected = activity.drafts.getString("trial.mode", "saved");
        candidate = choice(box, new String[]{s(R.string.cs_trial_saved), "bridge", "tun", "proxy"}, Math.max(0, java.util.Arrays.asList(modes).indexOf(selected)), index -> activity.drafts.putString("trial.mode", modes[index]));
        duration = input(box, s(R.string.cs_duration), activity.drafts.getString("trial.duration", "120"), InputType.TYPE_CLASS_NUMBER);
        duration.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { activity.drafts.putString("trial.duration", s.toString()); }
            public void afterTextChanged(Editable e) {}
        });
        startTrial = button(box, s(R.string.cs_trial_start), this::startTrial);
        confirmTrial = button(box, s(R.string.cs_trial_confirm), () -> finishTrial(true));
        revertTrial = button(box, s(R.string.cs_trial_revert), () -> finishTrial(false));
        button(box, s(R.string.cs_settings), () -> activity.navigate("settings"));
        controls();
        repeatAlways(() -> { if (!known || trial != null && SettingsRules.trialActive(trial.optString("status"))) load(); }, 2000);
    }
    @Override String title() { return s(R.string.cs_trial); }
    @Override void load() {
        read(result -> {
            if (!result.has("trial")) { failure(new IllegalStateException(s(R.string.cs_invalid_response))); return; }
            if (result.isNull("trial")) { trial = null; known = true; state.setText(s(R.string.cs_trial_none)); controls(); return; }
            JSONObject value = result.optJSONObject("trial");
            if (!valid(value)) { failure(new IllegalStateException(s(R.string.cs_invalid_response))); return; }
            trial = value; known = true;
            state.setText(s(R.string.cs_trial_state, value.optString("id"), SettingsState.state(activity, value.opt("status")), value.optLong("remaining"), summary(value.optJSONObject("previous")), summary(value.optJSONObject("candidate")), value.optString("reason")));
            controls();
        }, this::failure, "trial-status");
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
    private void failure(Exception e) { known = false; state.setText(s(R.string.cs_unknown) + "\n" + e.getMessage()); controls(); error(e); }
    private void controls() {
        boolean active = trial != null && SettingsRules.trialActive(trial.optString("status"));
        startTrial.setEnabled(known && !active);
        confirmTrial.setEnabled(known && trial != null && trial.optString("status").equals("running"));
        revertTrial.setEnabled(known && active);
        candidate.setEnabled(known && !active); duration.setEnabled(known && !active);
    }
    private void startTrial() {
        if (!known || trial != null && SettingsRules.trialActive(trial.optString("status"))) return;
        int seconds;
        try { seconds = SettingsRules.duration(duration.getText().toString()); } catch (IllegalArgumentException e) { error(e); return; }
        String mode = modes[candidate.getSelectedItemPosition()];
        confirm(s(R.string.cs_trial_start), s(R.string.cs_network_warning), () -> mutate(s(R.string.cs_trial_start), result -> {
            if (!result.optBoolean("ok")) notice(s(R.string.cs_failed, result.optString("error", result.toString())));
            load();
        }, "trial-start", Integer.toString(seconds), mode));
    }
    private void finishTrial(boolean keep) {
        if (!known || trial == null) return;
        String id = trial.optString("id");
        confirm(s(keep ? R.string.cs_trial_confirm : R.string.cs_trial_revert), s(keep ? R.string.cs_trial_confirm_warning : R.string.cs_trial_revert_warning), () -> mutate(s(keep ? R.string.cs_trial_confirm : R.string.cs_trial_revert), result -> {
            if (!result.optBoolean("ok")) notice(s(R.string.cs_failed, result.optString("error", result.toString())));
            load();
        }, keep ? "trial-confirm" : "trial-revert", id));
    }
}
