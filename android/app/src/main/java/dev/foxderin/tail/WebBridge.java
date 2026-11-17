package dev.foxderin.tail;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.webkit.JavaScriptReplyProxy;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.lang.ref.WeakReference;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

final class WebBridge {
    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final String INDEX = ORIGIN + "/assets/index.html";
    private final ControlActivity activity;
    private final ControlClient control;
    private final FileActions files;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newFixedThreadPool(3);
    private final Map<String, Read> reads = new HashMap<>();
    private final Set<String> pending = new HashSet<>();
    private final Set<String> backups = new HashSet<>();
    private final Runnable changed = () -> emit("control", controlSnapshot());
    private JavaScriptReplyProxy channel;
    private int generation;
    private boolean destroyed, active;

    private static final class Read {
        final RootApi.Call call = new RootApi.Call();
        final Map<String, Consumer<JSONObject>> replies = new HashMap<>();
    }

    WebBridge(ControlActivity activity, FileActions files) {
        this.activity = activity; this.files = files;
        control = ControlClient.get(activity);
        control.addListener(changed);
    }

    JSONObject controlSnapshot() { return control.snapshot(); }
    boolean ready() { return !destroyed && channel != null; }

    static JSONObject object(Object... pairs) {
        JSONObject value = new JSONObject();
        try {
            for (int i = 0; i < pairs.length; i += 2) value.put((String) pairs[i], pairs[i + 1] == null ? JSONObject.NULL : pairs[i + 1]);
        } catch (org.json.JSONException impossible) { throw new AssertionError(impossible); }
        return value;
    }
    static JSONObject failure(String error) { return object("ok", false, "error", error); }
    static JSONObject failure(Exception error) { return error instanceof RootApi.Failure ? ((RootApi.Failure) error).result : failure(RootApi.message(error)); }
    // Localized user-visible messages; validation details stay as developer-facing literals.
    static String message(Context context, int resource, Object... args) { return AppPreferences.localized(context).getString(resource, args); }
    static String text(JSONObject object, String key, int limit) throws Exception {
        Object value = object.get(key);
        if (!(value instanceof String) || ((String) value).length() > limit || ((String) value).indexOf('\0') >= 0) throw new IOException("Invalid " + key);
        return (String) value;
    }
    static void keys(JSONObject value, String... allowed) throws IOException {
        Iterator<String> names = value.keys();
        while (names.hasNext()) if (!Arrays.asList(allowed).contains(names.next())) throw new IOException("Unexpected argument");
    }
    static String choice(String value, String... allowed) throws IOException {
        if (!Arrays.asList(allowed).contains(value)) throw new IOException("Invalid choice");
        return value;
    }
    static URI safeUrl(String value, boolean server) throws Exception {
        if (value.isEmpty() || value.length() > 2048 || value.codePoints().anyMatch(Character::isISOControl)) throw new IOException("Invalid URL");
        URI uri = new URI(value);
        if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme())) || uri.getHost() == null || uri.getUserInfo() != null ||
                (server && uri.getFragment() != null) || (uri.getPort() != -1 && (uri.getPort() < 1 || uri.getPort() > 65535))) throw new IOException("Invalid URL");
        return uri;
    }
    static boolean trustedDocument(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost()) &&
                uri.getPort() == -1 && uri.getUserInfo() == null && "/assets/index.html".equals(uri.getPath()) && uri.getQuery() == null;
    }
    static boolean trustedOrigin(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost()) && uri.getPort() == -1 && uri.getUserInfo() == null;
    }

    void receive(String message, Uri origin, boolean mainFrame, JavaScriptReplyProxy replyProxy) {
        if (destroyed || !mainFrame || !trustedOrigin(origin) || !activity.trustedDocument()) return;
        String id = "";
        try {
            if (message == null || message.length() > 600 * 1024) throw new IOException("Message too large");
            JSONObject envelope = new JSONObject(message);
            keys(envelope, "id", "action", "args");
            id = text(envelope, "id", 128);
            if (!id.matches("[A-Za-z0-9_-]{1,128}")) throw new IOException("Invalid request ID");
            if (pending.contains(id)) return;
            if (pending.size() >= 64) { replyProxy.postMessage(object("id", id, "result", failure("Too many pending requests")).toString()); return; }
            String action = text(envelope, "action", 80);
            JSONObject args = envelope.getJSONObject("args");
            if (channel == null && !"app.bootstrap".equals(action)) throw new IOException("Bootstrap required");
            channel = replyProxy;
            pending.add(id);
            Consumer<JSONObject> reply = callback(id);
            try { dispatch(id, action, args, reply); }
            catch (Exception error) { reply.accept(failure(error)); }
        } catch (Exception error) {
            replyProxy.postMessage(object("id", id, "result", failure(error)).toString());
        }
    }

    private Consumer<JSONObject> callback(String id) {
        WeakReference<WebBridge> owner = new WeakReference<>(this);
        int document = generation;
        return result -> {
            WebBridge bridge = owner.get();
            if (bridge == null) return;
            bridge.main.post(() -> {
                if (bridge.destroyed || bridge.generation != document || !bridge.pending.remove(id) || bridge.channel == null) return;
                bridge.channel.postMessage(object("id", id, "result", result).toString());
            });
        };
    }

    void emit(String event, JSONObject value) {
        if (Looper.myLooper() != Looper.getMainLooper()) { main.post(() -> emit(event, value)); return; }
        if (!destroyed && channel != null && activity.trustedDocument()) channel.postMessage(object("event", event, "data", value).toString());
    }

    void resetDocument() {
        activity.setWebHandlesBack(true); // A new document must hydrate before surrendering Back.
        generation++; channel = null; pending.clear();
        cancelReads();
    }
    private void cancelReads() {
        String cancelled = message(activity, R.string.bridge_read_cancelled);
        for (Read read : reads.values()) {
            read.call.cancel();
            for (Consumer<JSONObject> reply : read.replies.values()) reply.accept(object("ok", false, "cancelled", true, "error", cancelled));
        }
        reads.clear();
    }
    void resume() { active = true; emit("lifecycle", object("ok", true, "active", true)); control.refreshAvailability(); }
    void pause() { active = false; emit("lifecycle", object("ok", true, "active", false)); cancelReads(); }
    void destroy() {
        destroyed = true; resetDocument(); control.removeListener(changed); io.shutdownNow();
    }

    private void dispatch(String id, String action, JSONObject args, Consumer<JSONObject> reply) throws Exception {
        switch (action) {
            case "app.bootstrap":
                keys(args);
                reply.accept(object("ok", true, "appearance", AppPreferences.appearance(activity), "page", activity.page(),
                        "section", activity.section(), "active", active, "control", control.snapshot(), "files", files.snapshot()));
                control.refreshAvailability();
                main.post(activity::deliverNavigation);
                return;
            case "app.appearance":
                JSONObject appearance = AppPreferences.update(activity, args);
                ControlClient.get(activity);
                activity.applyAppearance();
                reply.accept(object("ok", true, "appearance", appearance));
                emit("appearance", object("ok", true, "appearance", appearance));
                return;
            case "app.navigate":
                keys(args, "page"); activity.navigate(text(args, "page", 32)); reply.accept(object("ok", true)); return;
            case "app.backState":
                keys(args, "canHandle");
                if (!(args.opt("canHandle") instanceof Boolean)) throw new IOException("Invalid back state");
                activity.setWebHandlesBack(args.getBoolean("canHandle"));
                reply.accept(object("ok", true)); return;
            case "app.close":
                keys(args); reply.accept(object("ok", true)); main.post(activity::finish); return;
            case "app.openUrl":
                keys(args, "url"); activity.openExternal(safeUrl(text(args, "url", 2048), false)); reply.accept(object("ok", true)); return;
            case "app.copy":
                keys(args, "text");
                ((ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("FoxyTail", text(args, "text", 512 * 1024)));
                reply.accept(object("ok", true)); return;
            case "app.login":
                keys(args, "server");
                String server = args.has("server") ? text(args, "server", 2048) : null;
                if (server != null) safeUrl(server, true);
                accountReady();
                control.login(server, reply); return;
            case "control.query":
                keys(args, "command", "arguments");
                String[] query = command(args, false);
                if (!active) { reply.accept(failure(message(activity, R.string.bridge_inactive))); return; }
                query(id, query, reply); return;
            case "control.mutate":
                keys(args, "command", "arguments", "label");
                String[] mutation = command(args, true);
                if ("login-authkey".equals(mutation[0]) || "logout".equals(mutation[0]) || "switch".equals(mutation[0]) || "identity-restore".equals(mutation[0])) accountReady();
                String label = args.has("label") ? text(args, "label", 128) : mutation[0];
                control.submit(label, reply, mutation); return;
            case "control.cancelRead":
                keys(args, "id"); cancelRead(text(args, "id", 128)); reply.accept(object("ok", true)); return;
            case "control.cancel":
                keys(args, "id");
                if (args.has("id") && !text(args, "id", 128).equals(control.snapshot().optString("id"))) {
                    reply.accept(object("ok", true, "stale", true, "cancelled", false)); return;
                }
                if (!control.canCancel()) { reply.accept(failure(message(activity, R.string.bridge_cancel_unavailable))); return; }
                control.cancelCurrent(); reply.accept(object("ok", true, "requested", true)); return;
            case "control.acknowledge":
                keys(args); control.acknowledgeUnknown();
                reply.accept(control.isUnknown() ? failure(message(activity, R.string.bridge_invalid_request)) : control.snapshot()); return;
            case "control.refresh":
                keys(args); control.refreshAvailability(); control.reconnect(); reply.accept(control.snapshot()); return;
            default:
                if (!files.dispatch(action, args, reply)) reply.accept(failure(message(activity, R.string.bridge_unknown_action)));
        }
    }
    private void accountReady() throws IOException {
        JSONObject state = files.snapshot();
        if (state.optBoolean("busy") || state.optBoolean("unknown") || ArtifactImport.backup(activity).busy() || ArtifactImport.identity(activity).busy()) throw new IOException(message(activity, R.string.bridge_transfer_active));
    }

    private void query(String id, String[] wire, Consumer<JSONObject> reply) throws Exception {
        String key = control.observationRevision() + ":" + control.accountRevision() + ":" + new JSONArray(Arrays.asList(wire));
        Read read = reads.get(key);
        if (read != null) { read.replies.put(id, reply); return; }
        if (reads.size() >= 24) throw new IOException(message(activity.getApplicationContext(), R.string.bridge_busy));
        Read current = new Read(); current.replies.put(id, reply); reads.put(key, current);
        Context context = AppPreferences.localized(activity.getApplicationContext());
        String request = queryRequestId(wire[0]);
        current.call.submit(io, () -> {
            JSONObject response;
            try { response = RootApi.json(context, request, null, null, 100, current.call, wire); }
            catch (Exception error) { response = failure(error); }
            JSONObject result = response;
            main.post(() -> {
                if (reads.get(key) != current) return;
                reads.remove(key);
                if ("backup-list".equals(wire[0]) && result.optBoolean("ok")) {
                    backups.clear();
                    JSONArray rows = result.optJSONArray("backups");
                    if (rows != null) for (int i = 0; i < rows.length(); i++) {
                        JSONObject row = rows.optJSONObject(i);
                        if (row != null && backupPath(row.optString("path"))) backups.add(row.optString("path"));
                    }
                }
                for (Consumer<JSONObject> complete : current.replies.values()) complete.accept(result);
            });
        });
    }
    static String queryRequestId(String command) {
        // backend-info rejects --request-id and RootApi cancels its process locally.
        return "backend-info".equals(command) ? null : RootApi.requestId();
    }
    private void cancelRead(String id) {
        Iterator<Map.Entry<String, Read>> entries = reads.entrySet().iterator();
        while (entries.hasNext()) {
            Read read = entries.next().getValue();
            Consumer<JSONObject> callback = read.replies.remove(id);
            if (callback == null) continue;
            callback.accept(object("ok", false, "cancelled", true, "error", message(activity, R.string.bridge_read_cancelled)));
            if (read.replies.isEmpty()) { entries.remove(); read.call.cancel(); }
            return;
        }
    }

    private String[] command(JSONObject args, boolean mutation) throws Exception {
        String name = text(args, "command", 48);
        JSONArray array = args.getJSONArray("arguments");
        if (array.length() > 5) throw new IOException("Too many command arguments");
        String[] values = new String[array.length()];
        int bytes = 0;
        for (int i = 0; i < values.length; i++) {
            Object value = array.get(i);
            if (!(value instanceof String) || ((String) value).indexOf('\0') >= 0) throw new IOException("Command arguments must be strings");
            values[i] = (String) value;
            int length = values[i].getBytes(StandardCharsets.UTF_8).length;
            if (length > 65536) throw new IOException("Command argument is too large");
            bytes += length;
        }
        if (bytes > 98304) throw new IOException("Command arguments are too large");
        if (mutation) validateMutation(name, values); else validateQuery(name, values);
        String[] wire = new String[values.length + 1]; wire[0] = name;
        System.arraycopy(values, 0, wire, 1, values.length);
        return wire;
    }
    private void validateQuery(String name, String[] a) throws Exception {
        switch (name) {
            case "backend-info": case "owner-capability": case "hooks-get": case "status": case "exit-routing":
            case "peers": case "exitnodes": case "tun": case "dns": case "accounts": case "serve-list": case "funnel-list":
            case "traffic-uids": case "apps": case "routes-get": case "subnet-routes-get": case "settings-get":
            case "context-get": case "context-status": case "compat": case "files-inbox": case "taildrop-targets":
            case "file-send-history": case "backup-list": case "trial-status": count(a, 0); return;
            case "file-send-status": count(a, 1); pattern(a[0], "[a-fA-F0-9]{16,128}"); return;
            case "restore-preview": count(a, 1); backup(a[0]); return;
            case "identity-preview": count(a, 1); pattern(a[0], "art-[a-f0-9]{32}"); return;
            case "logs": count(a, 1, 2); choice(a[0], "service", "daemon"); if (a.length == 2) number(a[1], 1, 100000); return;
            case "traffic":
                count(a, 1, 2); choice(a[0], "summary", "hourly", "daily", "topn");
                if (a.length == 2) { if ("topn".equals(a[0])) number(a[1], 1, 100000); else pattern(a[1], "[0-9]{4}-[0-9]{2}-[0-9]{2}"); }
                return;
            default: throw new IOException("Command is not an allowed query");
        }
    }
    private void validateMutation(String name, String[] a) throws Exception {
        switch (name) {
            case "identity-export": count(a, 0); return;
            case "identity-restore": count(a, 3); pattern(a[0], "art-[a-f0-9]{32}"); pattern(a[1], "[a-f0-9]{64}"); pattern(a[2], "[a-f0-9]{64}"); return;
            case "account-rename":
                count(a, 2); identifier(a[0]);
                IdentityRules.nickname(a[1]);
                return;
            case "exitnode-clear": case "logout": case "backup": case "file-clear": case "file-send-clear":
            case "speedtest-exitnodes": case "derp-speedtest": case "coexist-info": case "diag-check": case "dns-probe": case "socks-check": count(a, 0); return;
            case "control": count(a, 1); choice(a[0], "start", "stop", "restart"); return;
            case "mode-set": count(a, 1); choice(a[0], "bridge", "tun", "proxy"); return;
            case "subnet-routes-set": count(a, 1); choice(a[0], "on", "off"); return;
            case "exitnode-set": case "switch": count(a, 1); identifier(a[0]); return;
            case "login-authkey": count(a, 1); pattern(a[0], "[A-Za-z0-9._-]{1,512}"); return;
            case "peer-ping": count(a, 2); identifier(a[0]); ip(a[1]); return;
            case "coexist-check":
                count(a, 5); pattern(a[0], "[0-9a-f]{64}"); identifier(a[1]); ip(a[2]); number(a[3], 1, 65535);
                if (!"-".equals(a[4])) number(a[4], 1, 65535); return;
            case "diag": count(a, 0, 1); if (a.length == 1) choice(a[0], "share", "local"); return;
            case "trial-start": count(a, 0, 1, 2); if (a.length > 0) SettingsRules.duration(a[0]); if (a.length > 1) choice(a[1], "saved", "bridge", "tun", "proxy"); return;
            case "trial-confirm": case "trial-revert": count(a, 1); pattern(a[0], "[0-9]+_[A-Za-z0-9_-]{1,128}"); return;
            case "file-receive": count(a, 2); Models.requireName(a[0]); identifier(a[1]); return;
            case "file-delete": count(a, 1); Models.requireName(a[0]); return;
            case "file-delete-many":
                count(a, 1); if (a[0].getBytes(StandardCharsets.UTF_8).length > 16384) throw new IOException("File selection too large");
                JSONArray names = new JSONArray(a[0]); if (names.length() == 0 || names.length() > 10000) throw new IOException("Invalid file selection");
                for (int i = 0; i < names.length(); i++) { if (!(names.get(i) instanceof String)) throw new IOException("Invalid file name"); Models.requireName(names.getString(i)); }
                return;
            case "file-send-delete": count(a, 1); pattern(a[0], "[a-fA-F0-9]{16,128}"); return;
            case "restore": count(a, 3); backup(a[0]); pattern(a[1], "[a-f0-9]{64}"); pattern(a[2], "[a-f0-9]{64}"); return;
            case "routes-set":
                count(a, 3); choice(a[0], "all", "selected", "bypass");
                if (!"-".equals(a[1])) SettingsRules.uids(a[1]); if (!"-".equals(a[2])) SettingsRules.cidrs(a[2]); return;
            case "settings-set": count(a, 2); setting(a[0], a[1]); return;
            case "context-set":
                count(a, 1); pattern(a[0], "[A-Za-z0-9+/]*={0,2}");
                byte[] decoded = android.util.Base64.decode(a[0], android.util.Base64.NO_WRAP);
                if (decoded.length > 48 * 1024) throw new IOException("Context exceeds 48 KiB");
                StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(decoded)); return;
            case "serve-set": case "serve-del": case "funnel-set": case "funnel-del":
                if (name.endsWith("-set")) count(a, 3); else count(a, 2, 3);
                if (name.startsWith("funnel")) choice(a[0], "https", "tcp", "tls-terminated-tcp"); else choice(a[0], "http", "https", "tcp", "tls-terminated-tcp");
                number(a[1], 1, 65535);
                if (name.startsWith("funnel")) choice(Integer.toString(Integer.parseInt(a[1])), "443", "8443", "10000");
                if (a.length == 3) {
                    if (a[2].isEmpty() || a[2].length() > 4096 || a[2].codePoints().anyMatch(Character::isISOControl)) throw new IOException("Invalid service target");
                    if (name.endsWith("-set")) { if (a[2].startsWith("-") || "off".equals(a[2])) throw new IOException("Invalid service target"); }
                    else if (!a[2].startsWith("/") || !("http".equals(a[0]) || "https".equals(a[0]))) throw new IOException("Invalid handler path");
                }
                return;
            default: throw new IOException("Command is not an allowed mutation");
        }
    }
    private static void count(String[] args, Integer... counts) throws IOException { if (!Arrays.asList(counts).contains(args.length)) throw new IOException("Invalid argument count"); }
    private static void pattern(String value, String regex) throws IOException { if (!value.matches(regex)) throw new IOException("Invalid argument format"); }
    private static void identifier(String value) throws IOException {
        if (value.isEmpty() || value.length() > 1024 || value.startsWith("-") || value.codePoints().anyMatch(Character::isISOControl)) throw new IOException("Invalid identifier");
    }
    private static void ip(String value) throws IOException {
        pattern(value, "[0-9a-fA-F:.]{1,45}");
        try { SettingsRules.cidr(value + (value.contains(":") ? "/128" : "/32")); }
        catch (IllegalArgumentException invalid) { throw new IOException("Invalid IP address"); }
    }
    private static void number(String value, int min, int max) throws IOException {
        pattern(value, "[0-9]{1,10}");
        long parsed = Long.parseLong(value); if (parsed < min || parsed > max) throw new IOException("Number is out of range");
    }
    private static boolean backupPath(String value) { return value.matches("/sdcard/Download/foxytail-backup-[A-Za-z0-9._-]+\\.tar\\.gz"); }
    private void backup(String value) throws IOException {
        if (!value.matches("art-[a-f0-9]{32}") && !(backupPath(value) && backups.contains(value))) throw new IOException("Select a listed backup or imported artifact");
    }
    private static void setting(String key, String value) throws Exception {
        switch (key) {
            case "MAGIC_DNS": case "IPV6": case "POWER_SAVE": case "WATCHDOG": case "WATCHDOG_PROBE": case "STATS": case "CONTEXT": case "WEBUI_AUTO_REFRESH": choice(value, "on", "off"); return;
            case "TAILDROP_AUTO_RECEIVE": choice(value, "0", "1"); return;
            case "DNS_MODE": choice(value, "legacy", "local", "hijack", "transparent"); return;
            case "SOCKS_PORT": case "DNS_PORT": number(value, 1024, 65535); return;
            case "WATCHDOG_INTERVAL": number(value, 5, 300); return;
            case "STATS_INTERVAL": number(value, 10, 3600); return;
            case "LOG_MAX_KB": number(value, 64, 10240); return;
            default: throw new IOException("Setting is not writable");
        }
    }
}
