package dev.foxderin.tail;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

final class ControlClient {
    private static ControlClient instance;
    static synchronized ControlClient get(Context context) {
        if (instance == null) instance = new ControlClient(ControlUi.localized(context.getApplicationContext()));
        else instance.context = ControlUi.localized(context.getApplicationContext());
        return instance;
    }
    private volatile Context context;
    private final SharedPreferences preferences;
    private final ExecutorService io = Executors.newFixedThreadPool(3);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ArrayList<Runnable> listeners = new ArrayList<>();
    private final Set<String> commands = new HashSet<>();
    private final Runnable poll = this::reconnect;
    private String id, command, label, message = "";
    private boolean compatible, upgrading, checking, polling, submitting, cancellable, unknown;
    private WeakReference<Consumer<JSONObject>> completion = new WeakReference<>(null);
    private JSONObject lastResult;
    static final class TaskEntry {
        final String id, command, label;
        String state = "running", cancellation = "", detail = "";
        TaskEntry(String id, String command, String label) { this.id = id; this.command = command; this.label = label; }
    }
    private final ArrayList<TaskEntry> tasks = new ArrayList<>();
    private String readyMessage = "";
    ArrayList<TaskEntry> tasks() { return new ArrayList<>(tasks); }
    boolean hasNotice() { return !message.isEmpty() && (busy() || !message.equals(readyMessage)); }
    private TaskEntry currentTask() {
        for (TaskEntry task : tasks) if (task.id.equals(id)) return task;
        return null;
    }
    private void rememberTask() {
        tasks.add(0, new TaskEntry(id, command, label));
        if (tasks.size() > 5) tasks.remove(tasks.size() - 1);
    }

    private ControlClient(Context context) {
        this.context = context;
        preferences = context.getSharedPreferences("control-operation", Context.MODE_PRIVATE);
        id = preferences.getString("id", null);
        command = preferences.getString("command", "");
        label = preferences.getString("label", "");
        if (id != null) message = context.getString(R.string.control_reconnecting, label);
        if (id != null) rememberTask();
    }
    boolean busy() { return id != null || submitting; }
    boolean canWrite() { return compatible && !upgrading; }
    boolean canStop() { return compatible && commands.contains("control"); }
    boolean canCancel() { return id != null && cancellable && !unknown; }
    boolean isUnknown() { return id != null && unknown; }
    String message() { return message; }
    JSONObject lastResult() { return lastResult; }
    String lastCommand() { return command; }
    long accountRevision() { return preferences.getLong("accountRevision", 0); }
    long lastResultTime(String name) { return preferences.getLong("resultTime." + name, 0); }
    JSONObject lastResult(String name) {
        if (lastResultTime(name) < System.currentTimeMillis() - 24 * 60 * 60 * 1000L) return null;
        String result = preferences.getString("result." + name, null);
        if (result == null) return null;
        try { return new JSONObject(result); } catch (org.json.JSONException e) { return null; }
    }
    void addListener(Runnable listener) {
        if (!listeners.contains(listener)) listeners.add(listener);
        reconnect();
    }
    void removeListener(Runnable listener) {
        listeners.remove(listener);
        if (listeners.isEmpty()) main.removeCallbacks(poll);
    }
    private void changed() {
        TaskEntry task = currentTask();
        if (task != null) { task.detail = message; task.state = unknown ? "unknown" : "running"; }
        for (Runnable listener : new ArrayList<>(listeners)) listener.run();
    }
    void refreshAvailability() {
        if (checking) return;
        checking = true;
        io.execute(() -> {
            try {
                JSONObject info = RootApi.json(context, "backend-info");
                if (info.getInt("protocol") != 1 || !(info.get("upgrading") instanceof Boolean) || !(info.get("disabled") instanceof Boolean)) throw new IOException(context.getString(R.string.control_incompatible));
                JSONArray available = info.getJSONArray("commands");
                Set<String> supported = new HashSet<>();
                for (int i = 0; i < available.length(); i++) supported.add(available.getString(i));
                if (!supported.contains("operation-start") || !supported.contains("operation-status")) throw new IOException(context.getString(R.string.control_incompatible));
                main.post(() -> {
                    compatible = true; upgrading = info.optBoolean("upgrading"); checking = false;
                    commands.clear(); commands.addAll(supported);
                    if (!busy()) message = context.getString(upgrading ? R.string.control_upgrading : info.optBoolean("disabled") ? R.string.control_disabled : R.string.control_ready, info.optString("moduleVersion"));
                    readyMessage = !upgrading && !info.optBoolean("disabled") ? context.getString(R.string.control_ready, info.optString("moduleVersion")) : "";
                    changed(); reconnect();
                });
            } catch (Exception e) {
                main.post(() -> { compatible = false; checking = false; message = RootApi.message(e); changed(); });
            }
        });
    }
    void submit(String operationLabel, Consumer<JSONObject> terminal, String... args) {
        boolean stop = args.length == 2 && "control".equals(args[0]) && "stop".equals(args[1]);
        if (!(stop ? canStop() : canWrite())) { message = context.getString(R.string.control_unavailable); changed(); refreshAvailability(); return; }
        if (busy()) { message = context.getString(R.string.control_busy, label); changed(); return; }
        if (args.length == 0 || !commands.contains(args[0])) { message = context.getString(R.string.control_incompatible); changed(); return; }
        String next = RootApi.requestId();
        if (!preferences.edit().putString("id", next).putString("command", args[0]).putString("label", operationLabel).commit()) {
            message = context.getString(R.string.control_record_failed); changed(); return;
        }
        id = next; command = args[0]; label = operationLabel; submitting = true;
        cancellable = false; unknown = false; lastResult = null; completion = new WeakReference<>(terminal);
        rememberTask();
        message = context.getString(R.string.control_running, label); changed();
        String[] wire = new String[args.length + 2];
        wire[0] = "operation-start"; wire[1] = next;
        System.arraycopy(args, 0, wire, 2, args.length);
        io.execute(() -> {
            try {
                JSONObject response = RootApi.json(context, null, null, null, 30, new RootApi.Call(), wire);
                main.post(() -> { submitting = false; accept(next, response); });
            } catch (Exception e) {
                main.post(() -> { submitting = false; if (next.equals(id)) { message = context.getString(R.string.control_unknown, RootApi.message(e)); changed(); reconnect(); } });
            }
        });
    }
    void reconnect() {
        main.removeCallbacks(poll);
        if (id == null || polling || submitting) return;
        String expected = id;
        polling = true;
        io.execute(() -> {
            try {
                JSONObject response = RootApi.json(context, null, null, null, 20, new RootApi.Call(), "operation-status", expected);
                main.post(() -> { polling = false; accept(expected, response); });
            } catch (Exception e) {
                main.post(() -> {
                    polling = false;
                    if (!expected.equals(id)) return;
                    unknown = true; cancellable = false;
                    message = context.getString(R.string.control_unknown, RootApi.message(e)); changed();
                });
            }
        });
    }
    static JSONObject terminalResult(JSONObject operation) throws Exception {
        String state = operation.getString("state");
        if ("running".equals(state)) return null;
        if (!"completed".equals(state) && !"cancelled".equals(state) && !"interrupted".equals(state)) throw new IOException("Invalid operation state");
        JSONObject result = operation.optJSONObject("result");
        if (result == null || !(result.opt("ok") instanceof Boolean)) {
            result = new JSONObject().put("ok", false).put("error", "Operation ended without a confirmed result");
        }
        if (!"completed".equals(state) || operation.isNull("exitCode") || operation.getInt("exitCode") != 0) {
            result.put("ok", false);
            if (!result.has("error")) result.put("error", "Operation did not complete successfully");
        }
        return result;
    }
    private void accept(String expected, JSONObject response) {
        if (!expected.equals(id)) return;
        try {
            JSONObject operation = response.getJSONObject("operation");
            if (!expected.equals(operation.getString("id")) || !command.equals(operation.getString("command")) || !(operation.get("cancellable") instanceof Boolean)) throw new IOException(context.getString(R.string.invalid_response));
            JSONObject result = terminalResult(operation);
            unknown = false; cancellable = operation.getBoolean("cancellable");
            if (result == null) {
                message = context.getString(R.string.control_running, label);
                changed();
                if (!listeners.isEmpty()) main.postDelayed(poll, 1000);
                return;
            }
            lastResult = result;
            message = result.optBoolean("ok") ? context.getString(R.string.control_finished, label) : label + ": " + result.optString("error", context.getString(R.string.backend_failed));
            SharedPreferences.Editor finished = preferences.edit().remove("id").remove("command").remove("label");
            if ("backup".equals(command) || "diag".equals(command) || "restore".equals(command) || "diag-check".equals(command)) {
                finished.putString("result." + command, result.toString()).putLong("resultTime." + command, System.currentTimeMillis());
            }
            if ("switch".equals(command) || "logout".equals(command) || "login-authkey".equals(command)) finished.putLong("accountRevision", accountRevision() + 1);
            if (!finished.commit()) throw new IOException(context.getString(R.string.control_record_failed));
            TaskEntry task = currentTask();
            if (task != null) {
                task.state = "cancelled".equals(operation.optString("state")) ? "cancelled" : result.optBoolean("ok") ? "done" : "error";
                task.detail = message;
            }
            id = null; cancellable = false;
            Consumer<JSONObject> callback = completion.get(); completion.clear();
            changed();
            if (callback != null) callback.accept(result);
        } catch (Exception e) {
            unknown = true; message = context.getString(R.string.control_unknown, RootApi.message(e)); changed();
        }
    }
    void cancelCurrent() {
        if (id == null || !cancellable || unknown) return;
        String expected = id;
        TaskEntry task = currentTask(); if (task != null) task.cancellation = "requested";
        message = context.getString(R.string.cancel_requested); changed();
        io.execute(() -> {
            try {
                RootApi.json(context, null, null, null, 12, new RootApi.Call(), "cancel", expected);
                main.post(this::reconnect);
            } catch (Exception e) {
                main.post(() -> { if (expected.equals(id)) { TaskEntry current = currentTask(); if (current != null) current.cancellation = "failed"; message = RootApi.message(e); changed(); reconnect(); } });
            }
        });
    }
    void acknowledgeUnknown() {
        if (!isUnknown() || polling || submitting) return;
        preferences.edit().remove("id").remove("command").remove("label").commit();
        TaskEntry task = currentTask(); if (task != null) { task.state = "unknown"; task.detail = context.getString(R.string.control_unknown_acknowledged); }
        id = null; unknown = false; cancellable = false; completion.clear();
        message = context.getString(R.string.control_unknown_acknowledged); changed();
    }
}
