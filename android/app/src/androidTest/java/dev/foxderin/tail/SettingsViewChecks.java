package dev.foxderin.tail;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import java.lang.reflect.Field;

final class SettingsViewChecks {
    static void run(ControlActivity activity) throws Exception {
        Bundle drafts = new Bundle(activity.drafts);
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
        } finally { page.close(); activity.drafts.clear(); activity.drafts.putAll(drafts); }
    }
    private static View action(View view, String label) {
        if (view.getVisibility() != View.VISIBLE) return null;
        if (view instanceof TextView && label.contentEquals(((TextView) view).getText())) {
            for (View node = view; node != null; node = node.getParent() instanceof View ? (View) node.getParent() : null) if (node.isClickable()) return node;
        }
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            View found = action(((ViewGroup) view).getChildAt(i), label); if (found != null) return found;
        }
        return null;
    }
    private static Object field(Object target, String name) throws Exception { Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(target); }
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
