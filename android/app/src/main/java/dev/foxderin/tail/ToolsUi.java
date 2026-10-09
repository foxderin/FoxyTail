package dev.foxderin.tail;

import android.text.Editable;
import android.text.TextWatcher;
import android.widget.EditText;
import org.json.JSONObject;

final class ToolsUi {
    static void watch(EditText input, Runnable action) {
        input.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) { action.run(); }
            public void afterTextChanged(Editable value) { }
        });
    }
    static void draft(ControlPage page, EditText input, String key) { watch(input, () -> page.activity.drafts.putString(key, input.getText().toString())); }
    static boolean success(ControlPage page, JSONObject result) {
        if (result.optBoolean("ok")) return true;
        page.notice(result.optString("error", page.s(R.string.tools_failed))); return false;
    }
    static String text(JSONObject object, String key) { return object.isNull(key) ? "—" : object.optString(key, "—"); }
}
