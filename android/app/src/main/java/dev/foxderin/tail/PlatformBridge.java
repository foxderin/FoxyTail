package dev.foxderin.tail;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import io.flutter.plugin.common.BinaryMessenger;
import io.flutter.plugin.common.EventChannel;
import io.flutter.plugin.common.MethodCall;
import io.flutter.plugin.common.MethodChannel;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

final class PlatformBridge implements MethodChannel.MethodCallHandler, EventChannel.StreamHandler {
    private static final ExecutorService READS = Executors.newFixedThreadPool(4);
    private static final Set<String> READ_COMMANDS = new HashSet<>(Arrays.asList(
            "backend-info", "owner-capability", "hooks-get", "status", "exit-routing", "peers", "exitnodes", "tun", "dns",
            "accounts", "serve-list", "funnel-list", "traffic", "traffic-uids", "apps", "routes-get", "subnet-routes-get",
            "settings-get", "context-get", "context-status", "logs", "compat", "files-inbox", "taildrop-targets",
            "files-browse", "file-send-status", "file-send-history", "backup-list", "restore-preview", "trial-status", "coexist-info"));
    private static final Set<String> OPERATIONS = new HashSet<>(Arrays.asList(
            "control", "mode-set", "exitnode-set", "exitnode-clear", "login-authkey", "logout", "switch", "serve-set", "serve-del",
            "funnel-set", "funnel-del", "routes-set", "subnet-routes-set", "settings-set", "context-set", "backup", "restore",
            "trial-start", "trial-confirm", "trial-revert", "file-delete", "file-delete-many", "file-clear", "file-export", "file-export-many",
            "file-send-cancel", "file-send-delete", "file-send-clear", "peer-ping", "speedtest-exitnodes", "derp-speedtest",
            "coexist-check", "coexist-info", "diag", "diag-check", "dns-probe", "socks-check"));
    private final Context context;
    private final ControlClient client;
    private final NativeFiles files;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final MethodChannel methods;
    private final EventChannel events;
    private final Map<String, RootApi.Call> reads = new HashMap<>();
    private final Runnable changed = this::publish;
    private EventChannel.EventSink sink;
    private MethodChannel.Result pending;
    private Consumer<JSONObject> completion;
    private boolean closed, loginPending, foreground, observing;

    PlatformBridge(Context context, BinaryMessenger messenger) {
        this.context = context.getApplicationContext(); client = ControlClient.get(context); files = NativeFiles.get(context);
        methods = new MethodChannel(messenger, "dev.foxderin.tail/control");
        events = new EventChannel(messenger, "dev.foxderin.tail/events");
        methods.setMethodCallHandler(this); events.setStreamHandler(this);
        files.observe(changed); BackupImport.get(context).observe(changed);
    }
    static Object value(Object input) {
        if (input == null || input == JSONObject.NULL) return null;
        if (input instanceof JSONObject) {
            Map<String, Object> result = new LinkedHashMap<>(); JSONObject object = (JSONObject) input;
            Iterator<String> keys = object.keys(); while (keys.hasNext()) { String key = keys.next(); result.put(key, value(object.opt(key))); }
            return result;
        }
        if (input instanceof JSONArray) {
            List<Object> result = new ArrayList<>(); JSONArray array = (JSONArray) input;
            for (int i = 0; i < array.length(); i++) result.add(value(array.opt(i))); return result;
        }
        return input;
    }
    JSONObject snapshot() throws Exception {
        BackupImport backup = BackupImport.get(context);
        android.content.SharedPreferences appearance = context.getSharedPreferences("interface", Context.MODE_PRIVATE);
        return new JSONObject().put("control", client.snapshot()).put("transfer", files.transferSnapshot())
                // A paused Activity's engine must not acknowledge a new share meant for its replacement.
                .put("files", files.snapshot()).put("entry", foreground ? files.entry() : new JSONObject())
                .put("backup", new JSONObject().put("busy", backup.busy()).put("error", nullable(backup.error())).put("token", nullable(backup.token())))
                .put("appearance", new JSONObject().put("theme", appearance.getString("theme", "auto")).put("language", appearance.getString("language", "auto")));
    }
    private static Object nullable(Object value) { return value == null ? JSONObject.NULL : value; }
    private String text(int resource) { return PlatformLocale.localized(context).getString(resource); }
    @Override public void onListen(Object arguments, EventChannel.EventSink events) { sink = events; observeControl(); publish(); }
    @Override public void onCancel(Object arguments) { sink = null; observeControl(); }
    void foreground(boolean active) {
        foreground = active; observeControl();
        if (active) publish();
    }
    private void observeControl() {
        boolean wanted = !closed && foreground && sink != null;
        if (wanted == observing) return;
        observing = wanted;
        if (wanted) client.addListener(changed); else client.removeListener(changed);
    }
    private void publish() {
        if (closed) return;
        if (pending != null && client.isUnknown()) {
            MethodChannel.Result result = pending; pending = null; completion = null;
            result.error("unknown", client.message(), value(client.snapshot()));
        }
        if (sink != null) try { sink.success(value(snapshot())); } catch (Exception error) { sink.error("snapshot", RootApi.message(error), null); }
    }
    static boolean allowedRead(String command) { return READ_COMMANDS.contains(command); }
    static String[] arguments(JSONObject input) throws Exception {
        JSONArray list = input.getJSONArray("args");
        if (list.length() < 1 || list.length() > 16) throw new IOException("Invalid command arguments");
        String[] args = new String[list.length()]; int total = 0;
        for (int i = 0; i < args.length; i++) {
            Object item = list.get(i); if (!(item instanceof String)) throw new IOException("Invalid command argument");
            args[i] = (String) item; int bytes = args[i].getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
            if (bytes > 65536 || args[i].indexOf('\0') >= 0 || (total += bytes) > 98304) throw new IOException("Command arguments exceed limit");
        }
        return args;
    }
    @Override public void onMethodCall(MethodCall call, MethodChannel.Result result) {
        try {
            JSONObject input = call.arguments == null ? new JSONObject() : new JSONObject((Map<?, ?>) call.arguments);
            switch (call.method) {
                case "initialize": case "snapshot": result.success(value(snapshot())); return;
                case "read": read(input, result); return;
                case "cancelRead": { RootApi.Call read = reads.get(input.getString("id")); if (read != null) read.cancel(); result.success(null); return; }
                case "submit": submit(input, result); return;
                case "refreshAvailability": client.refreshAvailability(); break;
                case "reconnect": client.reconnect(); break;
                case "cancel": client.cancelCurrent(); break;
                case "acknowledgeUnknown": client.acknowledgeUnknown(); break;
                case "appearance": appearance(input); break;
                case "consumeBackup": BackupImport.get(context).consume(input.getString("token")); publish(); break;
                default: if (!files.invoke(call.method, input)) { result.notImplemented(); return; }
            }
            result.success(null);
        } catch (Exception error) { failure(result, error); }
    }
    private void appearance(JSONObject input) throws Exception {
        String key = input.getString("key"), choice = input.getString("value");
        if (!("theme".equals(key) && Arrays.asList("auto", "light", "dark").contains(choice)) &&
                !("language".equals(key) && Arrays.asList("auto", "en", "zh").contains(choice))) throw new IOException("Invalid appearance choice");
        if (!context.getSharedPreferences("interface", Context.MODE_PRIVATE).edit().putString(key, choice).commit()) throw new IOException(text(R.string.appearance_save_failed));
        ControlClient.get(context); files.localeChanged(); publish();
    }
    private void read(JSONObject input, MethodChannel.Result result) throws Exception {
        String[] args = arguments(input); boolean login = "login".equals(args[0]);
        if (!allowedRead(args[0]) && !login) throw new IOException("Command is not allowed as a read");
        if (login) {
            if (files.loginPending() || client.busy()) throw new IOException(text(R.string.control_operation_busy));
            if (!client.canWrite()) throw new IOException(text(R.string.control_unavailable));
            if (files.transferBlocked()) throw new IOException(text(R.string.control_transfer_pending));
        }
        String id = input.getString("id");
        if (id.isEmpty() || id.length() > 128 || reads.containsKey(id)) throw new IOException("Invalid read ID");
        RootApi.Call request = new RootApi.Call(); reads.put(id, request); if (login) { loginPending = true; files.setLoginPending(true); }
        READS.execute(() -> {
            JSONObject response = null; Exception failure = null;
            try {
                if (login) files.requireNoActiveTransfer();
                response = RootApi.json(context, "backend-info".equals(args[0]) ? null : RootApi.requestId(), null, null,
                        Arrays.asList("login", "accounts", "traffic", "apps", "coexist-info").contains(args[0]) ? 100 : 40, request, args);
                if ("files-inbox".equals(args[0])) {
                    Models.Inbox inbox = new Models.Inbox(response); response.put("files", inbox.files).put("ignored", inbox.ignored);
                }
                if ("files-browse".equals(args[0])) NativeFiles.validateBrowse(response, args.length == 2 && !"-".equals(args[1]) ? args[1] : "");
            } catch (Exception error) { failure = error; }
            finally { request.finished = true; }
            JSONObject loaded = response; Exception error = failure;
            main.post(() -> {
                reads.remove(id); if (login) { loginPending = false; files.setLoginPending(false); }
                if (closed) return;
                if (error != null && login) result.error("login_failed", text(R.string.login_failed), null);
                else if (error != null) failure(result, error); else result.success(value(loaded));
            });
        });
    }
    private void submit(JSONObject input, MethodChannel.Result result) throws Exception {
        String[] args = arguments(input);
        if (!OPERATIONS.contains(args[0]) || !client.supports(args[0])) throw new IOException(text(R.string.control_incompatible));
        boolean stop = args.length == 2 && "control".equals(args[0]) && "stop".equals(args[1]);
        if (!(stop ? client.canStop() : client.canWrite())) throw new IOException(text(R.string.control_unavailable));
        if (pending != null || client.busy() || files.loginPending()) throw new IOException(text(R.string.control_operation_busy));
        if (files.transferBlocked() && Arrays.asList("logout", "switch", "login-authkey", "restore").contains(args[0])) throw new IOException(text(R.string.control_transfer_pending));
        pending = result;
        completion = terminal -> {
            MethodChannel.Result reply = pending; pending = null; completion = null;
            files.operationFinished();
            if (reply == null || closed) return;
            if (terminal.optBoolean("ok")) reply.success(value(terminal));
            else reply.error("operation_failed", terminal.optString("error", text(R.string.failed)), value(terminal));
        };
        client.submit(input.optString("label", args[0]), completion, args);
        if (!client.busy() && pending != null) { pending = null; completion = null; result.error("rejected", client.message(), value(client.snapshot())); }
    }
    static void failure(MethodChannel.Result result, Exception error) {
        if (error instanceof RootApi.Failure) {
            RootApi.Failure root = (RootApi.Failure) error;
            Map<String, Object> detail = new LinkedHashMap<>(); detail.put("result", value(root.result)); detail.put("exitCode", root.exitCode);
            result.error("backend_failed", RootApi.message(error), detail);
        } else result.error(error instanceof java.io.InterruptedIOException ? "cancelled" : "platform_error", RootApi.message(error), null);
    }
    void close() {
        closed = true; sink = null; pending = null; completion = null;
        for (RootApi.Call read : reads.values()) read.cancel(); reads.clear();
        client.removeListener(changed); files.remove(changed); BackupImport.get(context).remove(changed);
        methods.setMethodCallHandler(null); events.setStreamHandler(null);
    }
}
