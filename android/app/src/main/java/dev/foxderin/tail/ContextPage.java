package dev.foxderin.tail;

import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.Base64;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.List;

final class ContextPage extends ControlPage {
    private final TextView status, result, draftState;
    private final EditText raw;
    private final LinearLayout visual, editor, hooks;
    private final Button modeButton, save;
    private boolean loaded, binding, textMode;
    private boolean discardRequested;
    private String savedRaw;
    private int editing = -2;
    private String trigger = "ssid", action = "up";
    private EditText ssid, target;
    private static final String[] ACTIONS = {"up", "down", "exit-node", "no-exit-node"};

    ContextPage(ControlActivity activity) {
        super(activity);
        LinearLayout top = section();
        label(top, s(R.string.cs_context_hint));
        status = mono(top, s(R.string.cs_unknown));
        button(top, s(R.string.cs_refresh), this::load);
        draftState = label(top, "");
        button(top, s(R.string.cs_reload_draft), () -> confirm(s(R.string.cs_reload_draft), s(R.string.cs_reload_confirm), () -> { discardRequested = true; load(); }));
        textMode = activity.drafts.getBoolean("context.textMode", false);
        modeButton = button(top, "", () -> {
            if (editing != -2) { notice(s(R.string.cs_rule_draft_open)); return; }
            textMode = !textMode; activity.drafts.putBoolean("context.textMode", textMode); showMode();
        });
        raw = input(top, s(R.string.cs_rules), activity.drafts.getString("context.raw", ""), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        raw.setMinLines(8);
        raw.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { if (!binding) { activity.drafts.putString("context.raw", s.toString()); showDraftState(); } }
            public void afterTextChanged(Editable e) {}
        });
        visual = new LinearLayout(activity); visual.setOrientation(LinearLayout.VERTICAL); top.addView(visual);
        editor = new LinearLayout(activity); editor.setOrientation(LinearLayout.VERTICAL); top.addView(editor);
        result = label(top, s(R.string.cs_unknown));
        save = button(top, s(R.string.cs_save), this::save);
        save.setEnabled(false); raw.setEnabled(false);
        hooks = section(s(R.string.cs_hooks));
        button(content, s(R.string.cs_settings), () -> activity.navigate("settings"));
        showMode();
        repeat(this::load, 10000);
    }
    @Override String title() { return s(R.string.cs_context); }
    @Override void onPause() { discardRequested = false; }
    @Override void load() {
        read(value -> {
            if (!(value.opt("rules") instanceof String)) { failed(new IllegalStateException(s(R.string.cs_invalid_response))); return; }
            savedRaw = value.optString("rules");
            boolean firstLoad = !loaded;
            if (discardRequested) {
                discardRequested = false;
                editing = -2; activity.drafts.remove("context.editing"); editor.removeAllViews();
                activity.drafts.putString("context.baseline", savedRaw); setRaw(savedRaw);
            } else {
                SettingsRules.Draft merged = SettingsRules.mergeDraft(activity.drafts.getString("context.baseline"), activity.drafts.getString("context.raw"), savedRaw, editing != -2 || activity.drafts.containsKey("context.editing"));
                activity.drafts.putString("context.baseline", merged.baseline);
                if (!raw.getText().toString().equals(merged.value)) setRaw(merged.value);
                else activity.drafts.putString("context.raw", merged.value);
            }
            loaded = true; raw.setEnabled(true); save.setEnabled(true); render();
            if (firstLoad && activity.drafts.containsKey("context.editing")) edit(activity.drafts.getInt("context.editing"), null, true);
            showDraftState();
            JSONObject current = value.optJSONObject("status");
            status.setText(SettingsState.scenario(activity, current));
        }, this::failed, "context-get");
        read(value -> {
            JSONArray entries = value.optJSONArray("hooks");
            hooks.removeAllViews();
            if (entries == null) { label(hooks, s(R.string.cs_invalid_response)); return; }
            for (int i = 0; i < entries.length(); i++) {
                JSONObject hook = entries.optJSONObject(i);
                if (hook == null) continue;
                label(hooks, hook.optString("name"));
                mono(hooks, hook.optBoolean("missing") ? s(R.string.cs_hook_missing) : hook.optString("content"));
            }
        }, e -> { hooks.removeAllViews(); label(hooks, s(R.string.cs_unknown) + "\n" + e.getMessage()); error(e); }, "hooks-get");
    }
    private void failed(Exception e) {
        discardRequested = false;
        status.setText(s(R.string.cs_unknown) + "\n" + e.getMessage()); error(e);
    }
    private void showMode() {
        modeButton.setText(s(textMode ? R.string.cs_visual : R.string.cs_raw));
        ControlUi.fieldVisible(raw, textMode);
        visual.setVisibility(textMode ? View.GONE : View.VISIBLE);
        if (!textMode) render();
    }
    private void setRaw(String value) {
        binding = true; raw.setText(value); binding = false;
        activity.drafts.putString("context.raw", value);
        showDraftState();
    }
    private boolean draftConflict() {
        return savedRaw != null && SettingsRules.mergeDraft(activity.drafts.getString("context.baseline"), activity.drafts.getString("context.raw"), savedRaw, editing != -2 || activity.drafts.containsKey("context.editing")).conflict;
    }
    private void showDraftState() {
        if (draftState == null || savedRaw == null) return;
        draftState.setText(draftConflict() ? s(R.string.cs_draft_conflict) : !savedRaw.equals(activity.drafts.getString("context.raw")) || editing != -2 ? s(R.string.cs_draft_changed) : "");
    }
    private void render() {
        visual.removeAllViews();
        if (!loaded) { label(visual, s(R.string.cs_unknown)); return; }
        String current = raw.getText().toString();
        String[] lines = current.split("\n", -1);
        List<Integer> positions = SettingsRules.visible(current);
        for (int pos = 0; pos < positions.size(); pos++) {
            int index = positions.get(pos), position = pos;
            SettingsRules.Rule rule = SettingsRules.parse(lines[index]);
            LinearLayout box = new LinearLayout(activity); box.setOrientation(LinearLayout.VERTICAL); visual.addView(box);
            if (rule == null) { label(box, s(R.string.cs_unsupported)); mono(box, lines[index]); }
            else label(box, (rule.trigger.equals("ssid") ? s(R.string.cs_wifi) + ": " + rule.value : s(R.string.cs_cellular)) + " → " + actionLabel(rule.action) + (rule.arg.isEmpty() ? "" : ": " + rule.arg));
            Button earlier = button(box, s(R.string.cs_up), () -> { setRaw(SettingsRules.move(raw.getText().toString(), index, positions.get(position - 1))); render(); });
            earlier.setEnabled(editing == -2 && pos > 0);
            Button later = button(box, s(R.string.cs_down), () -> { setRaw(SettingsRules.move(raw.getText().toString(), index, positions.get(position + 1))); render(); });
            later.setEnabled(editing == -2 && pos < positions.size() - 1);
            Button edit = button(box, s(R.string.cs_edit), () -> {
                if (rule == null) { textMode = true; activity.drafts.putBoolean("context.textMode", true); showMode(); }
                else edit(index, rule, false);
            });
            edit.setEnabled(editing == -2);
            Button remove = button(box, s(R.string.cs_delete), () -> { setRaw(SettingsRules.remove(raw.getText().toString(), index)); render(); });
            remove.setEnabled(editing == -2);
        }
        if (positions.isEmpty()) label(visual, s(R.string.cs_empty));
        button(visual, s(R.string.cs_add_rule), () -> edit(-1, null, false)).setEnabled(editing == -2);
    }
    private String actionLabel(String value) {
        int at = java.util.Arrays.asList(ACTIONS).indexOf(value);
        return s(new int[]{R.string.cs_action_up, R.string.cs_action_down, R.string.cs_action_exit, R.string.cs_action_no_exit}[Math.max(0, at)]);
    }
    private void edit(int index, SettingsRules.Rule rule, boolean restore) {
        editing = index;
        if (!restore) {
            activity.drafts.putInt("context.editing", index);
            activity.drafts.putString("context.trigger", rule == null ? "ssid" : rule.trigger);
            activity.drafts.putString("context.value", rule == null ? "" : rule.value);
            activity.drafts.putString("context.action", rule == null ? "up" : rule.action);
            activity.drafts.putString("context.arg", rule == null ? "" : rule.arg);
        }
        trigger = activity.drafts.getString("context.trigger", "ssid"); action = activity.drafts.getString("context.action", "up");
        editor.removeAllViews();
        label(editor, s(R.string.cs_trigger));
        choice(editor, new String[]{s(R.string.cs_wifi), s(R.string.cs_cellular)}, trigger.equals("cellular") ? 1 : 0, selected -> {
            trigger = selected == 1 ? "cellular" : "ssid"; activity.drafts.putString("context.trigger", trigger); ControlUi.fieldVisible(ssid, selected != 1);
        });
        ssid = input(editor, "SSID", activity.drafts.getString("context.value", ""), InputType.TYPE_CLASS_TEXT);
        remember(ssid, "context.value"); ControlUi.fieldVisible(ssid, trigger.equals("ssid"));
        label(editor, s(R.string.cs_action));
        choice(editor, new String[]{s(R.string.cs_action_up), s(R.string.cs_action_down), s(R.string.cs_action_exit), s(R.string.cs_action_no_exit)}, java.util.Arrays.asList(ACTIONS).indexOf(action), selected -> {
            action = ACTIONS[selected]; activity.drafts.putString("context.action", action); ControlUi.fieldVisible(target, action.equals("exit-node"));
        });
        target = input(editor, s(R.string.cs_exit_target), activity.drafts.getString("context.arg", ""), InputType.TYPE_CLASS_TEXT);
        remember(target, "context.arg"); ControlUi.fieldVisible(target, action.equals("exit-node"));
        button(editor, s(R.string.cs_apply_rule), () -> {
            SettingsRules.Rule value = new SettingsRules.Rule(trigger, ssid.getText().toString(), action, target.getText().toString());
            if (SettingsRules.parse(value.line()) == null) { notice(s(R.string.cs_invalid_rule)); return; }
            setRaw(SettingsRules.replace(raw.getText().toString(), editing, value.line())); closeEditor();
        });
        button(editor, s(R.string.cs_cancel), this::closeEditor);
        render();
        showDraftState();
    }
    private void remember(EditText view, String key) {
        view.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { activity.drafts.putString(key, s.toString()); }
            public void afterTextChanged(Editable e) {}
        });
    }
    private void closeEditor() { editing = -2; activity.drafts.remove("context.editing"); editor.removeAllViews(); render(); showDraftState(); }
    private void save() {
        if (!loaded) return;
        if (editing != -2) { notice(s(R.string.cs_rule_draft_open)); return; }
        String submitted = raw.getText().toString();
        byte[] bytes = submitted.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 48 * 1024) { notice(s(R.string.cs_context_limit)); return; }
        confirm(s(R.string.cs_save), (draftConflict() ? s(R.string.cs_draft_conflict) + "\n\n" : "") + s(R.string.cs_network_warning), () -> mutate(s(R.string.cs_save), terminal -> {
            if (terminal.optBoolean("ok")) { activity.drafts.putString("context.baseline", submitted); savedRaw = submitted; showDraftState(); }
            result.setText(terminal.optBoolean("ok") ? s(R.string.cs_pending) : s(R.string.cs_failed, terminal.optString("error", terminal.toString())));
            load();
        }, "context-set", Base64.encodeToString(bytes, Base64.NO_WRAP)));
    }
}
