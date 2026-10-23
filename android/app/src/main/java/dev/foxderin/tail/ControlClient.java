package dev.foxderin.tail;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

final class ControlClient {
    private static ControlClient instance;
    static synchronized ControlClient get(Context context) {
        if (instance == null) instance = new ControlClient(AppPreferences.localized(context.getApplicationContext()));
        else instance.context = AppPreferences.localized(context.getApplicationContext());
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
    private boolean compatible, available, upgrading, checking, polling, submitting, cancellable, unknown;
    private String availabilityError = "";
    private long observationRevision;
    private long sequence;
    private Consumer<JSONObject> completion;
    private JSONObject lastResult;
    static final class TaskEntry {
        final String id, command, label;
        String state = "running", cancellation = "", detail = "";
        final long startedAt = System.currentTimeMillis();
        JSONObject result;
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
        // Same operation id only appears once; constructor and refresh replay it.
        for (TaskEntry prior : tasks) if (prior.id.equals(id)) return;
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
    long observationRevision() { return observationRevision; }
    boolean ownsMutation() { return busy() && !readOnlyOperation(command); }
    static boolean readOnlyOperation(String command) {
        switch (command) {
            case "peer-ping": case "speedtest-exitnodes": case "derp-speedtest":
            case "coexist-info": case "coexist-check": case "diag-check": case "socks-check": case "dns-probe": return true;
            default: return false;
        }
    }
    boolean canWrite() { return compatible && !upgrading && commands.contains("exit-routing") && commands.contains("context-status"); }
    boolean canStop() { return compatible && commands.contains("control"); }
    boolean canCancel() { return id != null && cancellable && !unknown; }
    boolean isUnknown() { return id != null && unknown; }
    String message() { return message; }
    JSONObject lastResult() { return lastResult; }
    String lastCommand() { return command; }
    long accountRevision() { return preferences.getLong("accountRevision", 0); }
    JSONObject snapshot() {
        JSONArray entries = new JSONArray();
        for (TaskEntry task : tasks) entries.put(WebBridge.object("id", task.id, "command", task.command,
                "label", task.label, "status", task.state, "state", task.state, "cancellation", task.cancellation,
                "detail", task.detail, "startedAt", task.startedAt, "result", task.result));
        JSONObject results = new JSONObject();
        for (String name : new String[]{"backup", "diag", "restore", "diag-check"}) {
            JSONObject result = lastResult(name);
            if (result != null) try { results.put(name, result); } catch (org.json.JSONException impossible) { throw new AssertionError(impossible); }
        }
        return WebBridge.object("ok", true, "compatible", compatible, "available", available, "checking", checking,
                "error", availabilityError, "upgrading", upgrading, "canWrite", canWrite(), "canStop", canStop(),
                "busy", busy(), "ownsMutation", ownsMutation(), "unknown", isUnknown(), "canCancel", canCancel(),
                "id", id, "command", command, "label", label, "message", message, "sequence", sequence, "revision", observationRevision,
                "accountRevision", accountRevision(), "result", lastResult, "results", results,
                "commands", new JSONArray(commands), "tasks", entries);
    }
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
        if (listeners.isEmpty() && !busy()) main.removeCallbacks(poll);
    }
    private void changed() {
        sequence++;
        TaskEntry task = currentTask();
        if (task != null) { task.detail = message; task.state = unknown ? "unknown" : "running"; }
        for (Runnable listener : new ArrayList<>(listeners)) listener.run();
    }
    void refreshAvailability() {
        if (checking) return;
        checking = true;
        changed();
        io.execute(() -> {
            boolean reached = false;
            try {
                JSONObject info = RootApi.json(context, "backend-info");
                reached = true;
                if (info.getInt("protocol") != 2 || !(info.get("upgrading") instanceof Boolean) || !(info.get("disabled") instanceof Boolean)) throw new IOException(context.getString(R.string.control_incompatible));
                JSONArray advertised = info.getJSONArray("commands");
                Set<String> supported = new HashSet<>();
                for (int i = 0; i < advertised.length(); i++) supported.add(advertised.getString(i));
                if (!supported.contains("operation-start") || !supported.contains("operation-status") || !supported.contains("exit-routing") || !supported.contains("context-status")) throw new IOException(context.getString(R.string.control_incompatible));
                main.post(() -> {
                    compatible = true; available = true; availabilityError = ""; upgrading = info.optBoolean("upgrading"); checking = false;
                    commands.clear(); commands.addAll(supported);
                    if (!busy()) message = context.getString(upgrading ? R.string.control_upgrading : info.optBoolean("disabled") ? R.string.control_disabled : R.string.control_ready, info.optString("moduleVersion"));
                    readyMessage = !upgrading && !info.optBoolean("disabled") ? context.getString(R.string.control_ready, info.optString("moduleVersion")) : "";
                    changed(); reconnect();
                });
            } catch (Exception e) {
                boolean backendReached = reached;
                main.post(() -> { compatible = false; available = backendReached; checking = false; availabilityError = RootApi.message(e); message = availabilityError; changed(); });
            }
        });
    }
    static void requireNoTransfers(Context context) throws Exception {
        if (TransferService.isRunning() || TransferService.state(context).getBoolean("unknown", false)) throw new IOException("A file transfer is active or unconfirmed");
        JSONArray transfers = RootApi.json(context, "file-send-history").getJSONArray("transfers");
        for (int i = 0; i < transfers.length(); i++) {
            String state = transfers.getJSONObject(i).getString("status");
            if (!Models.STATES.contains(state)) throw new IOException("Unknown transfer state");
            if (Models.active(state)) throw new IOException("A file transfer is active");
        }
        if (TransferService.isRunning() || TransferService.state(context).getBoolean("unknown", false)) throw new IOException("A file transfer is active or unconfirmed");
    }
    void login(String server, Consumer<JSONObject> callback) {
        if (!canWrite() || busy()) { reject(callback, context.getString(R.string.control_unavailable)); return; }
        submitting = true; command = "login"; label = "Login"; observationRevision++; changed();
        io.execute(() -> {
            JSONObject result;
            boolean attempted = false;
            try {
                requireNoTransfers(context);
                attempted = true;
                result = RootApi.json(context, RootApi.requestId(), null, null, 100, new RootApi.Call(),
                        server == null ? new String[]{"login"} : new String[]{"login", "--login-server=" + server});
            } catch (Exception error) {
                result = error instanceof RootApi.Failure ? ((RootApi.Failure) error).result
                        : WebBridge.object("ok", false, "unknown", attempted, "error", RootApi.message(error));
            }
            JSONObject reply = result;
            main.post(() -> {
                submitting = false; observationRevision++;
                preferences.edit().putLong("accountRevision", accountRevision() + 1).apply();
                message = reply.optBoolean("ok") ? "" : reply.optString("error");
                changed(); callback.accept(reply);
            });
        });
    }
    void submit(String operationLabel, Consumer<JSONObject> terminal, String... args) {
        boolean stop = args.length == 2 && "control".equals(args[0]) && "stop".equals(args[1]);
        if (!(stop ? canStop() : canWrite())) { reject(terminal, context.getString(R.string.control_unavailable)); refreshAvailability(); return; }
        if (busy()) { reject(terminal, context.getString(R.string.control_busy, label)); return; }
        if (args.length == 0 || !commands.contains(args[0])) { reject(terminal, context.getString(R.string.control_incompatible)); return; }
        String next = RootApi.requestId();
        if (!preferences.edit().putString("id", next).putString("command", args[0]).putString("label", operationLabel).commit()) {
            reject(terminal, context.getString(R.string.control_record_failed)); return;
        }
        id = next; command = args[0]; label = operationLabel; submitting = true;
        if (!readOnlyOperation(command)) observationRevision++;
        cancellable = false; unknown = false; lastResult = null; completion = terminal;
        rememberTask();
        message = context.getString(R.string.control_running, label); changed();
        String[] wire = new String[args.length + 2];
        wire[0] = "operation-start"; wire[1] = next;
        System.arraycopy(args, 0, wire, 2, args.length);
        io.execute(() -> {
            if ("login-authkey".equals(args[0]) || "logout".equals(args[0]) || "switch".equals(args[0])) {
                try { requireNoTransfers(context); }
                catch (Exception error) {
                    main.post(() -> {
                        submitting = false;
                        accept(next, WebBridge.object("ok", true, "operation", WebBridge.object("id", next,
                                "command", args[0], "state", "completed", "cancellable", false, "exitCode", 1,
                                "result", WebBridge.failure(RootApi.message(error)))));
                    });
                    return;
                }
            }
            try {
                JSONObject response = RootApi.json(context, null, null, null, 30, new RootApi.Call(), wire);
                main.post(() -> { submitting = false; accept(next, response); });
            } catch (Exception e) {
                main.post(() -> { submitting = false; if (next.equals(id)) markUnknown(e); });
            }
        });
    }
    private void reject(Consumer<JSONObject> callback, String error) {
        message = error; changed();
        if (callback != null) callback.accept(WebBridge.failure(error));
    }
    private void markUnknown(Exception error) {
        unknown = true; cancellable = false;
        message = context.getString(R.string.control_unknown, RootApi.message(error));
        Consumer<JSONObject> callback = completion; completion = null;
        changed();
        if (callback != null) callback.accept(WebBridge.object("ok", false, "unknown", true, "error", message));
        main.removeCallbacks(poll);
        main.postDelayed(poll, 3000);
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
                    markUnknown(e);
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
            result = new JSONObject().put("ok", false).put("unknown", true).put("error", "Operation ended without a confirmed result");
        }
        if ("interrupted".equals(state) || operation.isNull("exitCode")) result.put("unknown", true);
        if ("cancelled".equals(state)) result.put("cancelled", true);
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
                main.postDelayed(poll, 1000);
                return;
            }
            lastResult = result;
            if (result.optBoolean("unknown")) {
                markUnknown(new IOException(result.optString("error", "Operation outcome is unknown")));
                return;
            }
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
                task.result = result;
            }
            if (!readOnlyOperation(command)) observationRevision++;
            id = null; cancellable = false;
            Consumer<JSONObject> callback = completion; completion = null;
            changed();
            if (callback != null) callback.accept(result);
        } catch (Exception e) {
            markUnknown(e);
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
        if (!preferences.edit().remove("id").remove("command").remove("label").commit()) {
            message = context.getString(R.string.control_record_failed); changed(); return;
        }
        TaskEntry task = currentTask(); if (task != null) { task.state = "unknown"; task.detail = context.getString(R.string.control_unknown_acknowledged); }
        if (!readOnlyOperation(command)) observationRevision++;
        id = null; unknown = false; cancellable = false; completion = null;
        message = context.getString(R.string.control_unknown_acknowledged); changed();
    }
}
