package dev.foxderin.tail;

import android.graphics.Typeface;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.Base64;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.Date;
import java.util.List;

final class ContextPage extends ControlPage {
    private final LinearLayout status, visual, editor;
    private final TextView result, draftState, rawHint;
    private final EditText raw;
    private final View modeButton; private final Button save; private final View discard;
    private boolean loaded, binding, textMode, saving;
    private boolean discardRequested;
    private int rulesRevision;
    private String savedRaw;
    private int editing = -2;
    private String trigger = "ssid", action = "up";
    private EditText ssid, target;
    private TextView editorError;
    private static final String[] ACTIONS = {"up", "down", "exit-node", "no-exit-node"};

    ContextPage(ControlActivity activity) { this(activity, false); }
    ContextPage(ControlActivity activity, boolean embedded) {
        super(activity);
        if (embedded) { content.setPadding(0, 0, 0, 0); content.setTag("web-disclosure-body"); }
        LinearLayout top = section(s(R.string.web_set_context), R.drawable.ic_sync, s(R.string.web_context_description));
        LinearLayout actions = row(top);
        iconButton(actions, R.drawable.ic_refresh, s(R.string.web_context_refresh), this::load);
        textMode = activity.drafts.getBoolean("context.textMode", false);
        modeButton = iconButton(actions, R.drawable.ic_edit, "", () -> {
            if (editing != -2) return;
            textMode = !textMode; activity.drafts.putBoolean("context.textMode", textMode); showMode();
        });
        status = new LinearLayout(activity); status.setOrientation(LinearLayout.VERTICAL); top.addView(status);
        renderStatus(null);
        draftState = hint(top, ""); draftState.setVisibility(View.GONE);
        discard = iconButton(top, R.drawable.ic_restart_alt, s(R.string.cs_reload_draft), () -> confirm(s(R.string.cs_reload_draft), s(R.string.cs_reload_confirm), () -> { discardRequested = true; load(); }));
        discard.setVisibility(View.GONE);
        rawHint = hint(top, s(R.string.web_set_context_hint));
        raw = ControlUi.compactInput(top, "", activity.drafts.getString("context.raw", ""), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        raw.setContentDescription(s(R.string.web_set_context)); raw.setMinLines(8); raw.setGravity(android.view.Gravity.TOP);
        raw.setTypeface(Typeface.MONOSPACE); raw.setTextSize(12); raw.setLineHeight(Math.round(raw.getTextSize() * 1.7f)); raw.setPadding(dp(14), dp(14), dp(14), dp(14));
        raw.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) { if (!binding) { activity.drafts.putString("context.raw", s.toString()); showDraftState(); } }
            public void afterTextChanged(Editable e) { }
        });
        visual = new LinearLayout(activity); visual.setOrientation(LinearLayout.VERTICAL); top.addView(visual);
        editor = new LinearLayout(activity); editor.setOrientation(LinearLayout.VERTICAL); top.addView(editor);
        result = hint(top, ""); result.setVisibility(View.GONE); result.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        LinearLayout saveRow = row(top);
        save = ControlUi.primaryButton(activity, s(R.string.web_save), () -> { if (isCurrent()) save(); }); saveRow.addView(save, new LinearLayout.LayoutParams(-2, -2));
        save.setEnabled(false); raw.setEnabled(false);
        showMode(); repeat(this::load, 10000);
    }
    @Override String title() { return s(R.string.web_set_context); }
    @Override void onPause() { discardRequested = false; saving = false; rulesRevision++; }
    @Override void load() {
        if (saving) return;
        int revision = ++rulesRevision;
        read(value -> { if (revision == rulesRevision) rulesLoaded(value); }, e -> { if (revision == rulesRevision) failed(e); }, "context-get");
        read(value -> renderStatus(value.optJSONObject("status")), this::statusFailed, "context-status");
    }
    private void rulesLoaded(JSONObject value) {
        if (!(value.opt("rules") instanceof String)) { failed(new IllegalStateException(s(R.string.web_tools_context_load_error))); return; }
        savedRaw = value.optString("rules");
        boolean firstLoad = !loaded;
        if (discardRequested) {
            discardRequested = false; editing = -2; activity.drafts.remove("context.editing"); activity.drafts.remove("context.editorError"); editor.removeAllViews(); editorError = null;
            activity.drafts.putString("context.baseline", savedRaw); setRaw(savedRaw);
        } else {
            SettingsRules.Draft merged = SettingsRules.mergeDraft(activity.drafts.getString("context.baseline"), activity.drafts.getString("context.raw"), savedRaw, editing != -2 || activity.drafts.containsKey("context.editing"));
            activity.drafts.putString("context.baseline", merged.baseline);
            if (!raw.getText().toString().equals(merged.value)) setRaw(merged.value); else activity.drafts.putString("context.raw", merged.value);
        }
        loaded = true; raw.setEnabled(true); render();
        if (firstLoad && activity.drafts.containsKey("context.editing")) edit(activity.drafts.getInt("context.editing"), null, true);
        showDraftState(); updateControls();
    }
    private void renderStatus(JSONObject current) {
        status.removeAllViews();
        boolean known = current != null && current.opt("running") instanceof Boolean && current.opt("context") instanceof String;
        label(status, s(R.string.web_context_current) + ": " + (known && !current.optString("context").isEmpty() ? current.optString("context") : s(R.string.web_net_unknown)) + " · " + s(known ? current.optBoolean("running") ? R.string.web_context_running : R.string.web_context_stopped : R.string.web_net_unknown));
        JSONObject last = known ? current.optJSONObject("lastResult") : null;
        if (last == null || !(last.opt("ok") instanceof Boolean) || !(last.opt("context") instanceof String) || !(last.opt("at") instanceof Number) || !Double.isFinite(last.optDouble("at"))) {
            label(status, s(R.string.web_context_unconfirmed)); return;
        }
        LinearLayout lastRow = row(status); lastRow.setGravity(android.view.Gravity.CENTER_VERTICAL);
        TextView caption = label(lastRow, s(R.string.web_context_last) + ": "); caption.setLayoutParams(new LinearLayout.LayoutParams(-2, -2));
        badge(lastRow, s(last.optBoolean("ok") ? R.string.web_context_success : R.string.web_context_failed), last.optBoolean("ok") ? ControlUi.TONE_OK : ControlUi.TONE_WARN);
        String detail = last.optString("context") + " " + DateFormat.getDateTimeInstance().format(new Date(last.optLong("at") * 1000));
        String error = last.optString("error"); if (!error.isEmpty() && !error.equals("context-action-failed")) detail += " · " + error;
        label(status, detail);
    }
    private void failed(Exception e) {
        discardRequested = false; String message = e.getMessage(); result.setText(message == null || message.isEmpty() ? s(R.string.web_tools_context_load_error) : message); result.setVisibility(View.VISIBLE); updateControls(); error(e);
    }
    private void statusFailed(Exception e) { renderStatus(null); hint(status, e.getMessage()); error(e); }
    private void showMode() {
        String modeDescription = s(textMode ? R.string.web_context_visual : R.string.web_context_text); modeButton.setContentDescription(modeDescription); modeButton.setTooltipText(modeDescription);
        raw.setVisibility(textMode ? View.VISIBLE : View.GONE); rawHint.setVisibility(textMode ? View.VISIBLE : View.GONE);
        visual.setVisibility(textMode ? View.GONE : View.VISIBLE);
        if (!textMode) render(); updateControls();
    }
    private void updateControls() {
        modeButton.setEnabled(editing == -2 && !saving); save.setEnabled(loaded && editing == -2 && !saving); raw.setEnabled(loaded && !saving);
    }
    private void setRaw(String value) {
        binding = true; raw.setText(value); binding = false; activity.drafts.putString("context.raw", value); showDraftState();
    }
    private boolean draftConflict() {
        return savedRaw != null && SettingsRules.mergeDraft(activity.drafts.getString("context.baseline"), activity.drafts.getString("context.raw"), savedRaw, editing != -2 || activity.drafts.containsKey("context.editing")).conflict;
    }
    private void showDraftState() {
        if (draftState == null || savedRaw == null) return;
        boolean changed = !savedRaw.equals(activity.drafts.getString("context.raw")) || editing != -2;
        draftState.setText(draftConflict() ? s(R.string.cs_draft_conflict) : changed ? s(R.string.cs_draft_changed) : "");
        draftState.setVisibility(draftState.length() == 0 ? View.GONE : View.VISIBLE); discard.setVisibility(changed ? View.VISIBLE : View.GONE);
    }
    private void render() {
        visual.removeAllViews();
        if (!loaded) { hint(visual, s(R.string.web_loading)); return; }
        String current = raw.getText().toString(); String[] lines = current.split("\n", -1); List<Integer> positions = SettingsRules.visible(current);
        for (int pos = 0; pos < positions.size(); pos++) {
            int index = positions.get(pos), position = pos;
            SettingsRules.Rule rule = SettingsRules.parse(lines[index]);
            LinearLayout box = new LinearLayout(activity); box.setOrientation(LinearLayout.VERTICAL); visual.addView(box);
            if (rule == null) { label(box, s(R.string.web_context_unsupported)); mono(box, lines[index]); }
            else label(box, (rule.trigger.equals("ssid") ? s(R.string.web_context_wifi) + ": " + rule.value : s(R.string.web_context_cellular)) + " → " + actionLabel(rule.action) + (rule.arg.isEmpty() ? "" : ": " + rule.arg));
            LinearLayout actions = row(box);
            View earlier = iconButton(actions, R.drawable.ic_expand_less, s(R.string.web_context_move_up), () -> { if (!canEdit()) return; setRaw(SettingsRules.move(raw.getText().toString(), index, positions.get(position - 1))); render(); });
            earlier.setEnabled(canEdit() && pos > 0);
            View later = iconButton(actions, R.drawable.ic_expand_more, s(R.string.web_context_move_down), () -> { if (!canEdit()) return; setRaw(SettingsRules.move(raw.getText().toString(), index, positions.get(position + 1))); render(); });
            later.setEnabled(canEdit() && pos < positions.size() - 1);
            View edit = iconButton(actions, R.drawable.ic_edit, s(R.string.web_context_edit), () -> {
                if (!canEdit()) return;
                if (rule == null) { textMode = true; activity.drafts.putBoolean("context.textMode", true); showMode(); } else edit(index, rule, false);
            }); edit.setEnabled(canEdit());
            View delete = iconButton(actions, R.drawable.ic_delete, s(R.string.web_delete), () -> { if (!canEdit()) return; setRaw(SettingsRules.remove(raw.getText().toString(), index)); render(); }); delete.setEnabled(canEdit());
            ControlUi.iconGroup(actions, earlier, later, edit); ControlUi.iconGroup(actions, delete);
            ControlUi.divider(visual);
        }
        if (positions.isEmpty()) hint(visual, s(R.string.web_context_empty));
        LinearLayout addRow = row(visual); Button add = ControlUi.tonalButton(activity, s(R.string.web_context_add), () -> { if (isCurrent() && canEdit()) edit(-1, null, false); }); addRow.addView(add, new LinearLayout.LayoutParams(-2, -2)); add.setEnabled(canEdit());
    }
    private boolean canEdit() { return loaded && !saving && editing == -2; }
    private String actionLabel(String value) {
        int at = java.util.Arrays.asList(ACTIONS).indexOf(value);
        return s(new int[]{R.string.web_context_up, R.string.web_context_down, R.string.web_context_exit, R.string.web_context_no_exit}[Math.max(0, at)]);
    }
    private void edit(int index, SettingsRules.Rule rule, boolean restore) {
        editing = index;
        if (!restore) {
            activity.drafts.putInt("context.editing", index); activity.drafts.remove("context.editorError");
            activity.drafts.putString("context.trigger", rule == null ? "ssid" : rule.trigger); activity.drafts.putString("context.value", rule == null ? "" : rule.value);
            activity.drafts.putString("context.action", rule == null ? "up" : rule.action); activity.drafts.putString("context.arg", rule == null ? "" : rule.arg);
        }
        trigger = activity.drafts.getString("context.trigger", "ssid"); action = activity.drafts.getString("context.action", "up");
        editor.removeAllViews();
        MaterialChoice network = choice(editor, new String[]{s(R.string.web_context_wifi), s(R.string.web_context_cellular)}, trigger.equals("cellular") ? 1 : 0, selected -> {
            trigger = selected == 1 ? "cellular" : "ssid"; activity.drafts.putString("context.trigger", trigger); ControlUi.fieldVisible(ssid, selected != 1); clearEditorError();
        }); network.setHint(s(R.string.web_context_network));
        ssid = input(editor, "SSID", activity.drafts.getString("context.value", ""), InputType.TYPE_CLASS_TEXT);
        remember(ssid, "context.value"); ControlUi.fieldVisible(ssid, trigger.equals("ssid"));
        MaterialChoice actionChoice = choice(editor, new String[]{s(R.string.web_context_up), s(R.string.web_context_down), s(R.string.web_context_exit), s(R.string.web_context_no_exit)}, java.util.Arrays.asList(ACTIONS).indexOf(action), selected -> {
            action = ACTIONS[selected]; activity.drafts.putString("context.action", action); ControlUi.fieldVisible(target, action.equals("exit-node")); clearEditorError();
        }); actionChoice.setHint(s(R.string.web_context_action));
        target = input(editor, s(R.string.web_context_target), activity.drafts.getString("context.arg", ""), InputType.TYPE_CLASS_TEXT);
        remember(target, "context.arg"); ControlUi.fieldVisible(target, action.equals("exit-node"));
        editorError = hint(editor, activity.drafts.getString("context.editorError", "")); editorError.setVisibility(editorError.length() == 0 ? View.GONE : View.VISIBLE);
        editorError.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        LinearLayout actions = row(editor);
        primary(actions, s(R.string.web_context_apply_rule), () -> {
            SettingsRules.Rule value = new SettingsRules.Rule(trigger, ssid.getText().toString(), action, target.getText().toString());
            if (SettingsRules.parse(value.line()) == null) {
                String message = s(R.string.web_context_invalid); activity.drafts.putString("context.editorError", message); editorError.setText(message); editorError.setVisibility(View.VISIBLE);
                editorError.post(() -> editorError.requestRectangleOnScreen(new android.graphics.Rect(0, 0, editorError.getWidth(), editorError.getHeight()), false)); return;
            }
            setRaw(SettingsRules.replace(raw.getText().toString(), editing, value.line())); closeEditor();
        });
        iconButton(actions, R.drawable.ic_close, s(R.string.web_cancel), this::closeEditor); render(); showDraftState(); updateControls();
    }
    private void clearEditorError() { activity.drafts.remove("context.editorError"); if (editorError != null) { editorError.setText(""); editorError.setVisibility(View.GONE); } }
    private void remember(EditText view, String key) {
        view.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) { activity.drafts.putString(key, s.toString()); clearEditorError(); }
            public void afterTextChanged(Editable e) { }
        });
    }
    private void closeEditor() { editing = -2; activity.drafts.remove("context.editing"); clearEditorError(); editor.removeAllViews(); editorError = null; render(); showDraftState(); updateControls(); }
    private void save() {
        if (!loaded || saving) return;
        if (editing != -2) { result.setText(s(R.string.cs_rule_draft_open)); result.setVisibility(View.VISIBLE); return; }
        String submitted = raw.getText().toString(); byte[] bytes = submitted.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 48 * 1024) { raw.setError(s(R.string.cs_context_limit)); raw.requestFocus(); return; }
        confirm(s(R.string.web_save), (draftConflict() ? s(R.string.cs_draft_conflict) + "\n\n" : "") + s(R.string.cs_network_warning), () -> {
            saving = true; rulesRevision++; updateControls(); render();
            mutate(s(R.string.web_save), terminal -> {
                saving = false;
                if (terminal.optBoolean("ok")) { activity.drafts.putString("context.baseline", submitted); savedRaw = submitted; showDraftState(); }
                result.setText(terminal.optBoolean("ok") ? s(R.string.web_tools_saved_pending) : terminal.optString("error", s(R.string.web_op_failed))); result.setVisibility(View.VISIBLE);
                updateControls(); load();
            }, "context-set", Base64.encodeToString(bytes, Base64.NO_WRAP));
        });
    }
}
