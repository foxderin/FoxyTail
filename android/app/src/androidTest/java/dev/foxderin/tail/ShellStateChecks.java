package dev.foxderin.tail;

import android.app.Instrumentation;
import android.view.ContextThemeWrapper;
import android.widget.ListAdapter;
import com.google.android.material.textfield.MaterialAutoCompleteTextView;
import java.util.concurrent.atomic.AtomicReference;

final class ShellStateChecks {
    static void run(Instrumentation instrumentation) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> {
            try {
                ContextThemeWrapper context = new ContextThemeWrapper(instrumentation.getTargetContext(), R.style.AppTheme);
                int[] changes = {0};
                MaterialChoice widget = new MaterialChoice(context, new String[]{"all", "selected", "bypass"}, 0, index -> changes[0]++);
                MaterialAutoCompleteTextView input = (MaterialAutoCompleteTextView) widget.getEditText();
                ListAdapter adapter = input.getAdapter();
                widget.setItemEnabled(1, false);
                require(!adapter.isEnabled(1) && adapter.isEnabled(0), "Unsupported scope is disabled independently");
                input.getOnItemClickListener().onItemClick(null, null, 1, 1);
                require(changes[0] == 0 && widget.getSelectedItemPosition() == 0 && "all".contentEquals(input.getText()), "Disabled scope cannot enter the draft");
                widget.setItemEnabled(1, true);
                input.getOnItemClickListener().onItemClick(null, null, 1, 1);
                require(changes[0] == 1 && widget.getSelectedItemPosition() == 1, "Supported scope is selectable again");
                widget.setEnabled(false);
                input.getOnItemClickListener().onItemClick(null, null, 2, 2);
                require(changes[0] == 1 && widget.getSelectedItemPosition() == 1, "Disabled widget rejects inaccessible selection");
                widget.setSelection(-1);
                require(widget.getSelectedItemPosition() == -1 && !"all".contentEquals(input.getText()) && !"selected".contentEquals(input.getText()) && !"bypass".contentEquals(input.getText()), "Unknown mode is not fabricated as a supported mode");
                WebSwitch toggle = new WebSwitch(context); toggle.setContentDescription("Service"); toggle.setChecked(false);
                require(toggle.isClickable() && toggle.isFocusable(), "Service switch must accept touch and keyboard focus");
                toggle.performClick(); require(toggle.isChecked(), "Service switch click changes checked state");
                android.view.accessibility.AccessibilityNodeInfo info = android.view.accessibility.AccessibilityNodeInfo.obtain(); toggle.onInitializeAccessibilityNodeInfo(info);
                require(info.isCheckable() && info.isChecked() && "android.widget.Switch".contentEquals(info.getClassName()), "Service switch exposes checked state to accessibility"); info.recycle();
            } catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError("Shell choice regression", failure.get());
    }
    private static void require(boolean value, String detail) { if (!value) throw new AssertionError(detail); }
}
