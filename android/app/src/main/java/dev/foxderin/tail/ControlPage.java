package dev.foxderin.tail;

import androidx.appcompat.app.AlertDialog;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.materialswitch.MaterialSwitch;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.*;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import java.util.function.IntConsumer;

abstract class ControlPage {
    private static final ExecutorService READS = Executors.newFixedThreadPool(4);
    final ControlActivity activity;
    final LinearLayout content;
    final LinearLayout stickyActions;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ArrayList<RootApi.Call> calls = new ArrayList<>();
    private final ArrayList<Poll> polls = new ArrayList<>();
    private final ArrayList<Consumer<JSONObject>> callbacks = new ArrayList<>();
    private final Set<String> reading = new HashSet<>();
    private final Map<String, PendingRead> queuedReads = new LinkedHashMap<>();
    private final Map<ControlPage, Boolean> embedded = new LinkedHashMap<>();
    private static final class PendingRead {
        final String[] command;
        final ArrayList<Consumer<JSONObject>> success = new ArrayList<>();
        final ArrayList<Consumer<Exception>> failure = new ArrayList<>();
        PendingRead(String[] command) { this.command = command; }
    }
    private boolean closed, visible;
    private boolean refreshAfterRead;
    private int generation;
    private AlertDialog dialog;
    ControlPage(ControlActivity activity) {
        this.activity = activity;
        content = new LinearLayout(activity); content.setOrientation(LinearLayout.VERTICAL);
        int inset = activity.getResources().getConfiguration().screenWidthDp < 380 ? 16 : activity.getResources().getConfiguration().screenWidthDp >= 960 ? 36 : activity.getResources().getConfiguration().screenWidthDp >= 640 ? 28 : 20;
        content.setPadding(dp(inset), 0, dp(inset), dp(30));
        stickyActions = new LinearLayout(activity); stickyActions.setOrientation(LinearLayout.VERTICAL);
        stickyActions.setPadding(dp(16), dp(4), dp(16), dp(8));
    }
    abstract String title();
    abstract void load();
    void onClose() { }
    void onPause() { }
    void operationFinished(String command) {
        refreshAfterRead = true;
        refreshWhenIdle();
        for (Map.Entry<ControlPage, Boolean> entry : embedded.entrySet()) if (entry.getValue()) entry.getKey().operationFinished(command);
    }
    private void refreshWhenIdle() {
        if (refreshAfterRead && reading.isEmpty() && isCurrent()) { refreshAfterRead = false; load(); }
    }
    final void start() { resume(); }
    final void resume() {
        if (closed) return;
        visible = true;
        for (Poll poll : polls) { main.removeCallbacks(poll); main.postDelayed(poll, poll.millis); }
        load();
        for (Map.Entry<ControlPage, Boolean> entry : embedded.entrySet()) if (entry.getValue()) entry.getKey().resume();
    }
    final void pause() {
        visible = false; generation++;
        for (Poll poll : polls) main.removeCallbacks(poll);
        for (RootApi.Call call : new ArrayList<>(calls)) call.cancel();
        calls.clear(); reading.clear(); queuedReads.clear();
        onPause();
        for (ControlPage child : embedded.keySet()) child.pause();
    }
    final void close() {
        if (closed) return;
        closed = true; pause(); callbacks.clear();
        if (dialog != null) dialog.dismiss();
        for (ControlPage child : embedded.keySet()) child.close();
        onClose();
    }
    final void embed(ControlPage child) { embed(child, content); }
    final void embed(ControlPage child, LinearLayout host) {
        embedded.put(child, true); child.content.setPadding(0, 0, 0, 0);
        host.addView(child.content, new LinearLayout.LayoutParams(-1, -2));
        if (child.stickyActions.getChildCount() > 0) host.addView(child.stickyActions, new LinearLayout.LayoutParams(-1, -2));
        if (isCurrent()) child.resume();
    }
    final void setEmbeddedVisible(ControlPage child, boolean shown) {
        if (!embedded.containsKey(child)) throw new IllegalArgumentException("Page is not embedded");
        boolean wasShown = embedded.put(child, shown);
        child.content.setVisibility(shown ? View.VISIBLE : View.GONE);
        child.stickyActions.setVisibility(shown ? View.VISIBLE : View.GONE);
        if (wasShown == shown) return;
        if (shown && isCurrent()) child.resume(); else child.pause();
    }
    boolean isCurrent() { return !closed && visible && !activity.isDestroyed(); }
    String s(int resource, Object... args) { return activity.getString(resource, args); }
    int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    LinearLayout section(String heading) {
        return ControlUi.card(content, heading);
    }
    LinearLayout section() {
        return ControlUi.card(content, null);
    }
    LinearLayout section(String heading, int icon, String description) { return ControlUi.card(content, heading, icon, description); }
    TextView hint(LinearLayout parent, String value) { return ControlUi.hint(parent, value); }
    Button textButton(LinearLayout parent, String value, Runnable action) { return place(parent, ControlUi.textButton(activity, value, () -> { if (isCurrent()) action.run(); })); }
    LinearLayout row(LinearLayout parent) {
        LinearLayout row = new LinearLayout(activity); row.setOrientation(LinearLayout.HORIZONTAL); row.setBaselineAligned(false); row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        parent.addView(row, new LinearLayout.LayoutParams(-1, -2)); return row;
    }
    TextView label(LinearLayout parent, String text) {
        TextView view = ControlUi.textRes(activity, text, R.dimen.ft_body);
        view.setTextIsSelectable(true); view.setPadding(0, dp(4), 0, dp(4));
        parent.addView(view, new LinearLayout.LayoutParams(-1, -2)); return view;
    }
    TextView mono(LinearLayout parent, String text) {
        TextView view = label(parent, text); view.setTypeface(Typeface.MONOSPACE); view.setTextSize(13); return view;
    }
    TextView badge(LinearLayout parent, String text, int tone) {
        TextView view = ControlUi.badge(activity, text, tone);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2);
        if (parent.getOrientation() == LinearLayout.HORIZONTAL) params.setMarginEnd(dp(8)); else params.bottomMargin = dp(4);
        parent.addView(view, params); return view;
    }
    Button button(LinearLayout parent, String text, Runnable action) {
        return place(parent, ControlUi.button(activity, text, () -> { if (isCurrent()) action.run(); }));
    }
    Button button(LinearLayout parent, String text, int icon, Runnable action) {
        return place(parent, ControlUi.button(activity, text, icon, () -> { if (isCurrent()) action.run(); }));
    }
    Button primary(LinearLayout parent, String text, Runnable action) {
        return place(parent, ControlUi.primaryButton(activity, text, () -> { if (isCurrent()) action.run(); }));
    }
    Button primary(LinearLayout parent, String text, int icon, Runnable action) {
        return place(parent, ControlUi.primaryButton(activity, text, icon, () -> { if (isCurrent()) action.run(); }));
    }
    Button tonal(LinearLayout parent, String text, Runnable action) {
        return place(parent, ControlUi.tonalButton(activity, text, () -> { if (isCurrent()) action.run(); }));
    }
    ControlUi.MetricTile metric(LinearLayout row, int icon, String caption) { return ControlUi.metric(row, icon, caption); }
    LinearLayout quickCard(LinearLayout row, int icon, String title, String description, Runnable action) {
        return ControlUi.quickCard(row, icon, title, description, () -> { if (isCurrent()) action.run(); });
    }
    private Button place(LinearLayout parent, Button view) {
        boolean horizontal = parent.getOrientation() == LinearLayout.HORIZONTAL;
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2);
        if (horizontal && parent.getChildCount() > 0) params.setMarginStart(dp(10));
        else if (!horizontal) params.topMargin = dp(16);
        parent.addView(view, params); return view;
    }
    EditText input(LinearLayout parent, String hint, String initial, int inputType) {
        return ControlUi.input(parent, hint, initial, inputType);
    }
    MaterialChoice choice(LinearLayout parent, String[] labels, int selected, IntConsumer change) {
        MaterialChoice view = new MaterialChoice(activity, labels, selected, position -> { if (isCurrent()) change.accept(position); });
        parent.addView(view); return view;
    }
    CompoundButton toggle(LinearLayout parent, String label, boolean checked, Consumer<Boolean> change) {
        CompoundButton view = ControlUi.switchView(activity, checked, value -> { if (isCurrent()) change.accept(value); });
        view.setText(label); view.setContentDescription(label);
        parent.addView(view, new LinearLayout.LayoutParams(-1, -2)); return view;
    }
    void confirm(String title, String message, Runnable confirmed) {
        if (!isCurrent()) return;
        if (dialog != null) dialog.dismiss();
        dialog = new MaterialAlertDialogBuilder(activity).setTitle(title).setMessage(message)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(android.R.string.ok, (d, w) -> { if (isCurrent()) confirmed.run(); }).create();
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_NEGATIVE).requestFocus()); dialog.show();
    }
    void read(Consumer<JSONObject> success, String... command) { read(success, this::error, command); }
    void read(Consumer<JSONObject> success, Consumer<Exception> failure, String... command) {
        if (!isCurrent()) return;
        String key = String.join("\u0001", command);
        if (!reading.add(key)) {
            PendingRead pending = queuedReads.get(key);
            if (pending == null) { pending = new PendingRead(command.clone()); queuedReads.put(key, pending); }
            pending.success.add(success); pending.failure.add(failure); return;
        }
        int token = generation;
        RootApi.Call call = new RootApi.Call(); calls.add(call);
        READS.execute(() -> {
            try {
                if (call.cancelled.get()) return;
                JSONObject result = RootApi.json(activity.getApplicationContext(), RootApi.requestId(), null, null, timeout(command[0]), call, command);
                main.post(() -> {
                    calls.remove(call);
                    if (isCurrent() && token == generation) {
                        reading.remove(key);
                        try { success.accept(result); } catch (RuntimeException e) { failure.accept(e); }
                        continueReads(key);
                    }
                });
            } catch (Exception e) {
                main.post(() -> {
                    calls.remove(call);
                    if (isCurrent() && token == generation) { reading.remove(key); failure.accept(e); continueReads(key); }
                });
            }
        });
    }
    private void continueReads(String key) {
        PendingRead pending = queuedReads.remove(key);
        if (pending != null && isCurrent()) {
            read(result -> { for (Consumer<JSONObject> callback : pending.success) callback.accept(result); },
                    error -> { for (Consumer<Exception> callback : pending.failure) callback.accept(error); }, pending.command);
        }
        refreshWhenIdle();
    }
    static int timeout(String command) {
        switch (command) {
            case "login": case "accounts": return 100;
            case "traffic": case "apps": case "coexist-info": return 100;
            case "restore-preview": return 40;
            default: return 30;
        }
    }
    void mutate(String label, Consumer<JSONObject> terminal, String... command) {
        if (!isCurrent()) return;
        Consumer<JSONObject> callback = result -> {
            callbacks.clear();
            if (isCurrent()) terminal.accept(result);
        };
        callbacks.add(callback); activity.client.submit(label, callback, command);
    }
    void probe(String label, Consumer<JSONObject> terminal, String... command) { mutate(label, terminal, command); }
    void error(Throwable error) { if (isCurrent()) activity.showMessage(RootApi.message(error)); }
    void notice(String text) { if (isCurrent()) activity.showMessage(text); }
    void copy(String label, String value) {
        ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newPlainText(label, value)); notice(s(R.string.control_copied));
    }
    void repeat(Runnable action, long millis) { addPoll(action, millis, false); }
    void repeatAlways(Runnable action, long millis) { addPoll(action, millis, true); }
    private void addPoll(Runnable action, long millis, boolean always) {
        Poll poll = new Poll(action, millis, always); polls.add(poll);
        if (visible) main.postDelayed(poll, millis);
    }
    private final class Poll implements Runnable {
        final Runnable action; final long millis; final boolean always;
        Poll(Runnable action, long millis, boolean always) { this.action = action; this.millis = millis; this.always = always; }
        public void run() {
            if (!isCurrent()) return;
            if (always || activity.autoRefresh()) action.run();
            main.postDelayed(this, activity.powerSave() && !always ? Math.max(millis, 30000) : millis);
        }
    }
}
