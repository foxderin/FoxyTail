package dev.foxderin.tail;

import android.app.Instrumentation;
import android.view.ContextThemeWrapper;
import android.widget.ListAdapter;
import com.google.android.material.textfield.MaterialAutoCompleteTextView;
import java.util.concurrent.atomic.AtomicReference;
import java.util.ArrayList;
import java.util.function.Consumer;
import org.json.JSONObject;

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
                statusConsumers(instrumentation.getTargetContext());
            } catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError("Shell choice regression", failure.get());
    }
    private static final class ReadActivity extends ControlActivity {
        final ArrayList<Consumer<JSONObject>> pending = new ArrayList<>();
        ReadActivity(android.content.Context context) { attachBaseContext(context); getTheme().applyStyle(R.style.AppTheme, true); }
        @Override void readStatus(ControlPage owner, Consumer<JSONObject> success, Consumer<Exception> failure) { pending.add(success); }
    }
    private static final class ReadPage extends ControlPage {
        int loads;
        ReadPage(ControlActivity activity) { super(activity); }
        @Override String title() { return "Reads"; }
        @Override void load() { loads++; }
    }
    private static void statusConsumers(android.content.Context context) throws Exception {
        ReadActivity activity = new ReadActivity(context);
        ReadPage page = new ReadPage(activity); page.resume(); page.resume();
        require(page.loads == 1, "An already visible page does not load twice during resume");
        int[] first = {0}, second = {0}, failures = {0};
        page.read(value -> first[0]++, error -> failures[0]++, "status");
        page.read(value -> second[0]++, error -> failures[0]++, "status");
        require(activity.pending.size() == 1, "Concurrent page status consumers share one read");
        JSONObject value = new JSONObject().put("ok", true);
        Consumer<JSONObject> old = activity.pending.remove(0);
        old.accept(value);
        require(first[0] == 1 && second[0] == 1 && failures[0] == 0, "One snapshot reaches both genuine consumers");
        page.read(result -> first[0]++, error -> failures[0]++, "status");
        old = activity.pending.remove(0); page.pause(); page.resume();
        page.read(result -> second[0]++, error -> failures[0]++, "status");
        old.accept(value);
        require(first[0] == 1 && second[0] == 1, "Paused generation cannot publish after resume");
        activity.pending.remove(0).accept(value);
        require(second[0] == 2, "Current generation still receives its snapshot");
        page.read(result -> first[0]++, error -> failures[0]++, "status");
        old = activity.pending.remove(0); page.close(); old.accept(value);
        require(first[0] == 1 && failures[0] == 0, "Closed pages receive neither success nor failure callbacks");
        ReadPage busy = new ReadPage(activity); busy.resume();
        java.util.HashSet<Integer> delivered = new java.util.HashSet<>(); int[] rejected = {0};
        for (int i = 0; i < 65; i++) {
            final int consumer = i;
            busy.read(result -> delivered.add(consumer), error -> rejected[0]++, "status");
        }
        require(activity.pending.size() == 1 && rejected[0] == 1, "Excess consumers fail explicitly without queuing unlimited callbacks");
        activity.pending.remove(0).accept(value);
        require(delivered.size() == 64 && rejected[0] == 1, "Every admitted distinct consumer receives its status");
        busy.close();
    }
    private static void require(boolean value, String detail) { if (!value) throw new AssertionError(detail); }
}
