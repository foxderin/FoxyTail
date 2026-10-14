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
    static void observations(ControlActivity activity) throws Exception {
        java.util.Map<String, Object> saved = new java.util.LinkedHashMap<>();
        for (String name : new String[]{"resumed", "destination", "sharedStatus", "statusFresh", "statusLoading", "statusEverLoaded", "statusError", "statusRevision", "sharedExitRouting", "exitRoutingFresh", "exitRoutingLoading", "tunnelSnapshot"}) saved.put(name, field(ControlActivity.class, name).get(activity));
        ControlClient client = activity.client;
        java.util.Map<String, Object> operation = new java.util.LinkedHashMap<>();
        for (String name : new String[]{"id", "command", "unknown", "submitting"}) operation.put(name, field(ControlClient.class, name).get(client));
        java.lang.reflect.Method status = ControlActivity.class.getDeclaredMethod("completeStatus", JSONObject.class, Exception.class, int.class); status.setAccessible(true);
        java.lang.reflect.Method route = ControlActivity.class.getDeclaredMethod("completeExitRouting", JSONObject.class, int.class, String.class); route.setAccessible(true);
        JSONObject light = new JSONObject().put("ok", true).put("daemon", "running").put("backend", "Running").put("mode", "bridge")
                .put("self", new JSONObject().put("id", "self-a")).put("peerList", new org.json.JSONArray());
        JSONObject deep = new JSONObject().put("ok", true).put("selfId", "self-a").put("exitRouting", new JSONObject().put("known", true).put("selected", JSONObject.NULL).put("effective", "none"));
        try {
            field(ControlActivity.class, "resumed").set(activity, false);
            field(ControlActivity.class, "destination").set(activity, "peers");
            field(ControlActivity.class, "statusRevision").set(activity, 20);
            field(ControlClient.class, "id").set(client, "receipt-owned");
            field(ControlClient.class, "submitting").set(client, false);
            for (String command : new String[]{"speedtest-exitnodes", "control"}) {
                field(ControlClient.class, "command").set(client, command);
                for (boolean unknown : new boolean[]{false, true}) {
                    field(ControlClient.class, "unknown").set(client, unknown);
                    status.invoke(activity, light, null, 20);
                    require(activity.statusFresh() && activity.statusSnapshot() == light, "Owned known/unknown operations cannot freeze actual-state reads");
                    require(client.busy() && client.ownsMutation() == "control".equals(command), "Observation never frees receipt ownership or misclassifies probes");
                }
            }
            route.invoke(activity, deep, 20, "self-a|bridge||running|Running");
            require(activity.exitRoutingSnapshot() != null, "Matching validated deep state attaches independently");
            route.invoke(activity, deep, 19, "self-a|bridge||running|Running");
            require(activity.exitRoutingSnapshot() == null && activity.statusFresh(), "Old mutation revision cannot attach or erase light status");
            route.invoke(activity, deep.put("selfId", "self-b"), 20, "self-a|bridge||running|Running");
            require(activity.exitRoutingSnapshot() == null && OverviewPage.connectionLabel(activity.statusSnapshot()) == R.string.network_connected, "Mismatched deep identity cannot turn the connection unknown");
            route.invoke(activity, null, 20, "self-a|bridge||running|Running");
            require(activity.exitRoutingSnapshot() == null && activity.statusFresh(), "Heavy-read failure remains isolated");
            JSONObject old = new JSONObject(light.toString()).put("backend", "NeedsLogin");
            status.invoke(activity, old, null, 19);
            require(activity.statusSnapshot() == light && !activity.statusFresh(), "Pre-mutation light response remains fenced");
            status.invoke(activity, light, null, 20);
            require(activity.statusFresh(), "A current read recovers without releasing the receipt");
            java.lang.reflect.Method show = ControlActivity.class.getDeclaredMethod("showPage", String.class); show.setAccessible(true);
            for (String page : new String[]{"more", "traffic", "logs"}) {
                show.invoke(activity, page);
                require(activity.statusFresh() && activity.statusSnapshot() == light, "Tab navigation preserves the verified service observation");
            }
            show.invoke(activity, saved.get("destination"));
            android.view.View restart = (android.view.View) field(ControlActivity.class, "stripRestart").get(activity);
            android.view.View stop = (android.view.View) field(ControlActivity.class, "stripStop").get(activity);
            require(restart.getParent() == stop.getParent() && ((android.widget.LinearLayout) stop.getParent()).getOrientation() == android.widget.LinearLayout.HORIZONTAL, "Recovery Stop and Restart share one horizontal action row");
            int touch = ControlUi.dp(activity, 44);
            require(restart.getLayoutParams().width >= touch && restart.getLayoutParams().height >= touch && stop.getLayoutParams().width >= touch && stop.getLayoutParams().height >= touch, "Both service actions retain 44dp touch targets");
        } finally {
            for (java.util.Map.Entry<String, Object> entry : operation.entrySet()) field(ControlClient.class, entry.getKey()).set(client, entry.getValue());
            for (java.util.Map.Entry<String, Object> entry : saved.entrySet()) field(ControlActivity.class, entry.getKey()).set(activity, entry.getValue());
            java.lang.reflect.Method publish = ControlActivity.class.getDeclaredMethod("publishStatus"); publish.setAccessible(true); publish.invoke(activity);
        }
    }
    private static java.lang.reflect.Field field(Class<?> type, String name) throws Exception {
        java.lang.reflect.Field field = type.getDeclaredField(name); field.setAccessible(true); return field;
    }
    private static void require(boolean value, String detail) { if (!value) throw new AssertionError(detail); }
}
