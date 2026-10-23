package dev.foxderin.tail;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import org.json.*;
import java.io.*;
import java.lang.ref.WeakReference;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;

/** Native ownership of sources, URI grants and binary exports; the document sees handles only. */
final class FileActions {
    static final int PICK = 10, SAVE = 11, NOTIFY = 12, PICK_BACKUP = 50, SAVE_ARTIFACT = 51;
    private static final ExecutorService EXPORTS = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static ExportJob export;
    private final Activity activity;
    private final BiConsumer<String, JSONObject> emit;
    private final ControlClient client;
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final ExecutorService sources = Executors.newSingleThreadExecutor();
    private final LinkedHashMap<String, Models.Source> selection = new LinkedHashMap<>();
    private final LinkedHashMap<String, Models.Source> handles = new LinkedHashMap<>();
    private final LinkedHashSet<Uri> resolving = new LinkedHashSet<>();
    private final Runnable changed = this::publish;
    private final Runnable imported = this::deliverImport;
    private Consumer<JSONObject> pickerReply, backupReply;
    private String saveName, saveToken, message = "";
    private int picker, generation, browseGeneration, sendGeneration;
    private boolean destroyed, registered, launching, recovering, preflight;
    private RootApi.Call browseCall;
    private final BroadcastReceiver updates = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { if (!preflight) launching = false; publish(); }
    };

    FileActions(Activity activity, BiConsumer<String, JSONObject> emit) {
        this.activity = activity; this.emit = emit; client = ControlClient.get(activity);
        if (export != null) export.owner = new WeakReference<>(this);
    }
    private String s(int id, Object... args) { return AppPreferences.localized(activity).getString(id, args); }
    static JSONObject object(Object... fields) {
        JSONObject result = new JSONObject();
        try { for (int i = 0; i < fields.length; i += 2) result.put((String) fields[i], fields[i + 1] == null ? JSONObject.NULL : fields[i + 1]); }
        catch (JSONException error) { throw new IllegalArgumentException(error); }
        return result;
    }
    private static JSONObject failure(Exception error) { return object("ok", false, "error", RootApi.message(error)); }
    private JSONObject cancelled() { return object("ok", false, "cancelled", true, "error", s(R.string.cancelled)); }
    private void respond(Consumer<JSONObject> reply, JSONObject result) { if (!destroyed && reply != null) reply.accept(result); }
    private void publish() { if (!destroyed) emit.accept("files", snapshot()); }
    private boolean transferBusy() { return launching || TransferService.isRunning(); }
    private void idle() throws IOException {
        if (!client.canWrite()) throw new IOException(s(R.string.backend_failed));
        if (client.busy() || transferBusy()) throw new IOException(s(R.string.busy));
    }
    private void writable() throws IOException {
        idle();
        if (TransferService.state(activity).getBoolean("unknown", false)) throw new IOException(s(R.string.control_unknown_warning));
    }
    void acknowledgeUnknown() throws IOException {
        SharedPreferences state = TransferService.state(activity);
        if (!state.getBoolean("unknown", false)) return;
        if (transferBusy()) throw new IOException(s(R.string.busy));
        if (!state.edit().remove("unknown").remove("unknownOwner").commit()) throw new IOException(s(R.string.control_record_failed));
        publish();
    }
    private void editable() throws IOException { if (transferBusy()) throw new IOException(s(R.string.busy)); }
    private void exportAvailable() throws IOException {
        if (picker != 0 || (export != null && export.busy) || client.busy()) throw new IOException(s(R.string.busy));
    }
    JSONObject snapshot() {
        JSONArray selected = new JSONArray();
        for (Map.Entry<String, Models.Source> entry : selection.entrySet()) {
            Models.Source source = entry.getValue();
            JSONObject item = object("key", entry.getKey(), "name", source.name, "size", source.size, "source", source.uri == null ? "path" : "uri");
            if (source.path != null) try { item.put("path", source.path); } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
            selected.put(item);
        }
        SharedPreferences state = TransferService.state(activity);
        JSONObject transfer = null;
        try { String raw = state.getString("snapshot", null); if (raw != null) transfer = new Models.Transfer(new JSONObject(raw)).json; } catch (Exception ignored) { }
        BackupImport backup = BackupImport.get(activity);
        return object("ok", true, "selection", selected, "busy", transferBusy(), "preparing", !resolving.isEmpty() || state.getBoolean("preparing", false),
                "job", preflight ? null : state.getString("job", null), "unknown", state.getBoolean("unknown", false), "message", message.isEmpty() ? state.getString("message", "") : message, "transfer", transfer,
                "export", export == null ? object("busy", false, "committing", false, "bytes", 0, "message", "") : export.snapshot(),
                "backup", object("busy", backup.busy(), "token", backup.token(), "error", backup.error()));
    }
    static void fields(JSONObject args, String... allowed) throws JSONException {
        Set<String> keys = new HashSet<>(Arrays.asList(allowed));
        for (Iterator<String> it = args.keys(); it.hasNext();) if (!keys.contains(it.next())) throw new JSONException("Unexpected argument");
    }
    private static String text(JSONObject args, String key) throws JSONException { return Models.required(args, key); }
    private static String token(JSONObject args) throws JSONException {
        String token = text(args, "token"); if (!token.matches("art-[a-f0-9]{32}")) throw new JSONException("Invalid artifact token"); return token;
    }
    private ArrayList<String> names(JSONObject args, String key) throws Exception {
        JSONArray items = args.getJSONArray(key);
        if (items.length() < 1 || items.length() > 32) throw new IOException(WebBridge.message(activity, R.string.bridge_selection_limit));
        LinkedHashSet<String> values = new LinkedHashSet<>();
        for (int i = 0; i < items.length(); i++) {
            Object raw = items.get(i); if (!(raw instanceof String) || !values.add((String) raw)) throw new IOException(s(R.string.invalid_response));
        }
        return new ArrayList<>(values);
    }
    boolean dispatch(String action, JSONObject args, Consumer<JSONObject> reply) {
        if (!action.startsWith("files.") && !action.startsWith("artifact.") && !action.equals("backup.import")) return false;
        try {
            switch (action) {
                case "files.snapshot": fields(args); respond(reply, snapshot()); break;
                case "files.acknowledge": fields(args); acknowledgeUnknown(); respond(reply, snapshot()); break;
                case "files.pick": fields(args); editable(); beginPicker(PICK, new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true), reply); break;
                case "files.browse": {
                    fields(args, "path"); Object value = args.get("path");
                    if (!(value instanceof String) || !Models.relativePath((String) value)) throw new IOException("Invalid shared directory");
                    browse((String) value, reply); break;
                }
                case "files.addShared": {
                    fields(args, "handles"); editable(); ArrayList<Models.Source> additions = new ArrayList<>();
                    for (String handle : names(args, "handles")) { Models.Source source = handles.get(handle); if (source == null) throw new IOException(WebBridge.message(activity, R.string.bridge_expired)); additions.add(source); }
                    Set<String> all = new HashSet<>(); for (Models.Source source : selection.values()) all.add(source.key()); for (Models.Source source : additions) all.add(source.key());
                    if (all.size() > 32) throw new IOException(s(R.string.file_limit));
                    for (Models.Source source : additions) add(source); publish(); respond(reply, snapshot()); break;
                }
                case "files.remove": fields(args, "key"); editable(); selection.remove(text(args, "key")); publish(); respond(reply, snapshot()); break;
                case "files.clear": fields(args); editable(); generation++; resolving.clear(); selection.clear(); message = ""; publish(); respond(reply, snapshot()); break;
                case "files.send": fields(args, "peer", "ip"); send(args, false, reply); break;
                case "files.retry": fields(args, "job", "peer", "ip"); send(args, true, reply); break;
                case "files.adopt": fields(args, "job"); idle(); launch(new Intent(activity, TransferService.class).setAction(TransferService.ADOPT).putExtra("job", Models.id(args, "job"))); respond(reply, object("ok", true, "accepted", true)); break;
                case "files.cancel": {
                    fields(args, "job"); String job = args.has("job") ? Models.id(args, "job") : null;
                    if (preflight) {
                        if (job != null) throw new IOException(s(R.string.busy));
                        sendGeneration++; preflight = false; launching = false; message = s(R.string.cancelled_local); publish(); respond(reply, object("ok", true, "accepted", true));
                    } else if (transferBusy()) {
                        if (job != null && !job.equals(TransferService.state(activity).getString("job", null))) throw new IOException(s(R.string.busy));
                        activity.startService(new Intent(activity, TransferService.class).setAction(TransferService.CANCEL)); respond(reply, object("ok", true, "accepted", true));
                    }
                    else if (job != null) { launch(cancelIntent(activity, job)); respond(reply, object("ok", true, "accepted", true)); }
                    else throw new IOException(s(R.string.cancelled_local));
                    break;
                }
                case "files.import": fields(args); writable(); requestNotifications(); launch(new Intent(activity, TransferService.class).setAction(TransferService.IMPORT)); respond(reply, object("ok", true, "accepted", true)); break;
                case "files.open": case "files.save": {
                    fields(args, "name"); String name = text(args, "name"); Models.requireName(name); exportAvailable();
                    if (action.equals("files.save")) chooseSave(name, null, reply); else startExport(Collections.singletonList(name), null, null, false, reply);
                    break;
                }
                case "files.share": {
                    fields(args, "names"); ArrayList<String> selected = names(args, "names"); for (String name : selected) Models.requireName(name);
                    exportAvailable(); startExport(selected, null, null, true, reply); break;
                }
                case "files.cancelExport": fields(args); if (export != null && export.busy) export.cancel(); respond(reply, object("ok", true, "committing", export != null && export.committing)); break;
                case "backup.import": {
                    fields(args); writable(); BackupImport operation = BackupImport.get(activity);
                    if (operation.busy()) throw new IOException(s(R.string.busy));
                    beginPicker(PICK_BACKUP, new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE), reply); break;
                }
                case "artifact.save": case "artifact.share": {
                    fields(args, "token", "name"); String id = token(args), name = text(args, "name"); Models.requireName(name); exportAvailable();
                    if (action.equals("artifact.save")) chooseSave(name, id, reply); else startExport(Collections.singletonList(name), id, null, true, reply); break;
                }
                default: throw new IOException(WebBridge.message(activity, R.string.bridge_unknown_action));
            }
        } catch (Exception error) { respond(reply, failure(error)); }
        return true;
    }
    private void add(Models.Source source) {
        for (Models.Source current : selection.values()) if (current.key().equals(source.key())) return;
        selection.put(UUID.randomUUID().toString(), source);
    }
    private void browse(String path, Consumer<JSONObject> reply) {
        if (browseCall != null) browseCall.cancel();
        RootApi.Call call = new RootApi.Call(); browseCall = call; int request = ++browseGeneration;
        io.execute(() -> {
            try {
                JSONObject result = RootApi.json(activity, null, null, null, 90, call, "files-browse", path.isEmpty() ? "-" : path);
                List<FilesBrowser.Entry> entries = FilesBrowser.parse(result, path);
                activity.runOnUiThread(() -> {
                    if (destroyed) return;
                    if (request != browseGeneration) { respond(reply, cancelled()); return; }
                    handles.clear(); JSONArray listed = new JSONArray();
                    for (FilesBrowser.Entry entry : entries) {
                        JSONObject item = object("name", entry.name, "path", entry.path.substring(8), "directory", entry.directory, "size", entry.size, "mtime", entry.mtime);
                        if (!entry.directory && entry.size <= RootApi.MAX_FILE) try {
                            String handle = UUID.randomUUID().toString(); handles.put(handle, Models.Source.shared(entry.path, entry.size)); item.put("handle", handle);
                        } catch (Exception error) { respond(reply, failure(error)); return; }
                        listed.put(item);
                    }
                    respond(reply, object("ok", true, "path", path, "entries", listed, "truncated", result.optBoolean("truncated"), "ignored", result.optInt("ignored", 0)));
                });
            } catch (Exception error) { activity.runOnUiThread(() -> respond(reply, failure(error))); }
            finally { call.finished = true; }
        });
    }
    static ArrayList<Uri> sharedUris(Intent intent) {
        ArrayList<Uri> uris = new ArrayList<>(); String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return uris;
        if (Intent.ACTION_SEND.equals(action)) { Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM); if (uri != null) uris.add(uri); }
        else { ArrayList<Uri> items = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM); if (items != null) uris.addAll(items); }
        if (uris.isEmpty() && intent.getClipData() != null) for (int i = 0; i < intent.getClipData().getItemCount(); i++) uris.add(intent.getClipData().getItemAt(i).getUri());
        return uris;
    }
    void acceptIntent(Intent intent) {
        if (intent == null) return;
        if (intent.getBooleanExtra("history", false)) emit.accept("navigate", object("page", "files", "section", "history"));
        if (Intent.ACTION_SEND.equals(intent.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            emit.accept("navigate", object("page", "files", "section", "send"));
            try { editable(); resolveUris(sharedUris(intent), null); } catch (Exception error) { message = RootApi.message(error); publish(); }
        }
    }
    private void resolveUris(List<Uri> uris, Consumer<JSONObject> reply) {
        if (uris.isEmpty() || uris.size() > 32) { message = s(uris.isEmpty() ? R.string.invalid_uri : R.string.file_limit); respond(reply, object("ok", false, "error", message)); publish(); return; }
        LinkedHashSet<Uri> combined = new LinkedHashSet<>(resolving); combined.addAll(uris);
        if (combined.size() > 32) { message = s(R.string.file_limit); respond(reply, object("ok", false, "error", message)); publish(); return; }
        ArrayList<Uri> pending = new ArrayList<>(); for (Uri uri : uris) if (resolving.add(uri)) pending.add(uri);
        if (pending.isEmpty()) { respond(reply, snapshot()); return; }
        int revision = generation; publish();
        sources.execute(() -> {
            ArrayList<Models.Source> accepted = new ArrayList<>(); StringBuilder errors = new StringBuilder();
            for (Uri uri : pending) try {
                accepted.add(Models.Source.resolve(activity, uri));
            } catch (Exception error) { if (errors.length() > 0) errors.append('\n'); errors.append(RootApi.message(error)); }
            activity.runOnUiThread(() -> {
                if (destroyed) return;
                if (revision != generation) { respond(reply, cancelled()); return; }
                resolving.removeAll(pending);
                if (transferBusy()) { message = s(R.string.busy); respond(reply, object("ok", false, "error", message)); publish(); return; }
                for (Models.Source source : accepted) {
                    boolean exists = selection.values().stream().anyMatch(current -> current.key().equals(source.key()));
                    if (exists) continue;
                    if (selection.size() < 32) add(source); else { if (errors.length() > 0) errors.append('\n'); errors.append(s(R.string.file_limit)); }
                }
                message = errors.length() == 0 ? "" : s(R.string.selection_errors, errors.toString());
                publish(); respond(reply, errors.length() == 0 ? snapshot() : object("ok", false, "error", message, "partial", !accepted.isEmpty()));
            });
        });
    }
    private void beginPicker(int code, Intent intent, Consumer<JSONObject> reply) throws IOException {
        if (picker != 0 || (export != null && export.busy)) throw new IOException(s(R.string.busy));
        picker = code; pickerReply = reply;
        try { activity.startActivityForResult(intent, code); }
        catch (RuntimeException error) { picker = 0; pickerReply = null; saveName = null; saveToken = null; throw error; }
    }
    private void chooseSave(String name, String token, Consumer<JSONObject> reply) throws IOException {
        saveName = name; saveToken = token;
        beginPicker(token == null ? SAVE : SAVE_ARTIFACT, new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(ExportProvider.mime(name)).putExtra(Intent.EXTRA_TITLE, name), reply);
    }
    void onActivityResult(int request, int result, Intent data) {
        if (request != PICK && request != SAVE && request != PICK_BACKUP && request != SAVE_ARTIFACT) return;
        if (picker != request) return;
        Consumer<JSONObject> reply = pickerReply; pickerReply = null; picker = 0;
        String name = saveName, token = saveToken; saveName = null; saveToken = null;
        if (result != Activity.RESULT_OK || data == null) { respond(reply, cancelled()); publish(); return; }
        try {
            if (request == PICK) {
                ArrayList<Uri> uris = new ArrayList<>();
                if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
                else if (data.getData() != null) uris.add(data.getData());
                if (uris.size() > 32) throw new IOException(s(R.string.file_limit));
                for (Uri uri : uris) if (uri != null && (data.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0) try { activity.getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (SecurityException ignored) { }
                resolveUris(uris, reply);
            } else if (request == PICK_BACKUP) {
                writable(); backupReply = reply; BackupImport.get(activity).start(data.getData(), data.getFlags()); deliverImport();
            } else {
                Uri target = data.getData();
                if (name == null || target == null || !"content".equals(target.getScheme()) || activity.checkUriPermission(target, android.os.Process.myPid(), android.os.Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) throw new IOException(s(R.string.invalid_uri));
                exportAvailable(); startExport(Collections.singletonList(name), token, target, false, reply);
            }
        } catch (Exception error) { message = RootApi.message(error); respond(reply, failure(error)); publish(); }
    }
    private void send(JSONObject args, boolean retry, Consumer<JSONObject> reply) throws Exception {
        writable(); if (!resolving.isEmpty()) throw new IOException(s(R.string.busy));
        String peer = text(args, "peer"), ip = text(args, "ip"), job = retry ? Models.id(args, "job") : null;
        if (!ip.matches("[0-9a-fA-F:.]+")) throw new IOException(WebBridge.message(activity, R.string.bridge_invalid_request));
        ArrayList<Models.Source> selected = new ArrayList<>(selection.values());
        if (!retry && selected.isEmpty()) throw new IOException(s(R.string.choose_first));
        long account = client.accountRevision(); int request = ++sendGeneration; launching = true; preflight = true; publish();
        io.execute(() -> {
            try {
                JSONArray history = RootApi.json(activity, "file-send-history").getJSONArray("transfers");
                if (history.length() > 100) throw new IOException(s(R.string.invalid_response));
                for (int i = 0; i < history.length(); i++) if (Models.active(new Models.Transfer(history.getJSONObject(i)).status)) throw new IOException(s(R.string.busy));
                JSONArray targets = RootApi.json(activity, "taildrop-targets").getJSONArray("peers");
                if (targets.length() > 10000) throw new IOException(s(R.string.invalid_response));
                boolean found = false; for (int i = 0; i < targets.length(); i++) { Models.Peer candidate = new Models.Peer(targets.getJSONObject(i)); if (candidate.id.equals(peer) && candidate.ip.equals(ip)) found = true; }
                if (!found) throw new IOException(s(R.string.web_files_retry_target_missing));
                if (retry) {
                    Models.Transfer prior = new Models.Transfer(RootApi.json(activity, "file-send-status", job).getJSONObject("transfer"));
                    String self = Models.required(RootApi.json(activity, "status").getJSONObject("self"), "id");
                    if (!prior.peerId.equals(peer) || !self.equals(prior.json.getString("selfId")) || prior.retryPaths().length() == 0) throw new IOException(s(R.string.web_files_retry_target_missing));
                }
                activity.runOnUiThread(() -> {
                    if (request != sendGeneration) { respond(reply, cancelled()); return; }
                    launching = false; preflight = false;
                    if (destroyed) return;
                    try {
                        writable(); if (account != client.accountRevision()) throw new IOException(s(R.string.invalid_response));
                        Intent intent = new Intent(activity, TransferService.class).setAction(TransferService.START).putExtra("peer", peer).putExtra("ip", ip).putExtra("accountRevision", account);
                        if (retry) intent.putExtra("retry", job);
                        else {
                            ArrayList<Uri> uris = new ArrayList<>(); ArrayList<String> paths = new ArrayList<>();
                            for (Models.Source source : selected) if (source.uri != null) uris.add(source.uri); else paths.add(source.path);
                            intent.putParcelableArrayListExtra("uris", uris).putStringArrayListExtra("paths", paths);
                            if (!uris.isEmpty()) { ClipData clip = ClipData.newRawUri("Taildrop", uris.get(0)); for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i))); intent.setClipData(clip); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); }
                        }
                        requestNotifications(); launch(intent); respond(reply, object("ok", true, "accepted", true));
                    } catch (Exception error) { respond(reply, failure(error)); publish(); }
                });
            } catch (Exception error) { activity.runOnUiThread(() -> {
                if (request != sendGeneration) { respond(reply, cancelled()); return; }
                launching = false; preflight = false; respond(reply, failure(error)); publish();
            }); }
        });
    }
    private void launch(Intent intent) {
        launching = true; message = "";
        try { activity.startForegroundService(intent); }
        catch (RuntimeException error) { launching = false; throw error; }
        publish();
    }
    private void requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFY);
    }
    void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        if (request == NOTIFY && (results.length == 0 || results[0] != PackageManager.PERMISSION_GRANTED)) { message = s(R.string.notifications_hint); publish(); }
    }
    private void deliverImport() {
        if (destroyed) return;
        BackupImport operation = BackupImport.get(activity);
        if (!operation.busy() && backupReply != null) {
            Consumer<JSONObject> reply = backupReply; backupReply = null;
            if (operation.error() != null) respond(reply, object("ok", false, "error", operation.error()));
            else if (operation.token() != null) respond(reply, object("ok", true, "token", operation.token()));
        }
        publish();
    }
    void resume() {
        if (!registered) {
            activity.registerReceiver(updates, new IntentFilter(TransferService.UPDATE), "dev.foxderin.tail.INTERNAL", null, Build.VERSION.SDK_INT >= 33 ? Context.RECEIVER_NOT_EXPORTED : 0);
            client.addListener(changed); BackupImport.get(activity).observe(imported); registered = true;
        }
        if (export != null) export.owner = new WeakReference<>(this);
        deliverImport(); recover();
    }
    void pause() { if (browseCall != null) browseCall.cancel(); }
    static Intent cancelIntent(Context context, String job) throws IOException {
        if (job == null || !job.matches("[a-fA-F0-9]{16,128}")) throw new IOException(WebBridge.message(context, R.string.bridge_invalid_request));
        return new Intent(context, TransferService.class).setAction(TransferService.ADOPT).putExtra("job", job).putExtra("cancel", true);
    }
    private void recover() {
        if (recovering || transferBusy()) return;
        recovering = true;
        io.execute(() -> {
            String job = null; Exception failure = null;
            try {
                JSONArray records = RootApi.json(activity, "file-send-history").getJSONArray("transfers");
                if (records.length() > 100) throw new IOException(s(R.string.invalid_response));
                for (int i = 0; i < records.length(); i++) { Models.Transfer item = new Models.Transfer(records.getJSONObject(i)); if (Models.active(item.status)) { if (job != null) throw new IOException(s(R.string.invalid_response)); job = item.id; } }
                if (job == null) {
                    String persisted = TransferService.state(activity).getString("job", null);
                    if (persisted != null && persisted.matches("[a-fA-F0-9]{16,128}")) job = persisted;
                }
            } catch (Exception error) { failure = error; }
            String active = job; Exception error = failure;
            activity.runOnUiThread(() -> {
                recovering = false; if (destroyed || transferBusy()) return;
                try {
                    if (active != null) launch(new Intent(activity, TransferService.class).setAction(TransferService.ADOPT).putExtra("job", active));
                    else if (error == null) {
                        SharedPreferences state = TransferService.state(activity);
                        if (state.contains("request") || state.contains("staged") || state.getBoolean("preparing", false)) launch(new Intent(activity, TransferService.class).setAction(TransferService.RECOVER));
                    }
                } catch (RuntimeException problem) { message = RootApi.message(problem); publish(); }
            });
        });
    }
    void save(Bundle out) {
        ArrayList<Bundle> selected = new ArrayList<>();
        for (Map.Entry<String, Models.Source> item : selection.entrySet()) {
            Models.Source source = item.getValue(); Bundle entry = new Bundle(); entry.putString("key", item.getKey()); entry.putString("name", source.name); entry.putLong("size", source.size);
            if (source.uri != null) entry.putString("uri", source.uri.toString()); else entry.putString("path", source.path); selected.add(entry);
        }
        out.putParcelableArrayList("sources", selected);
        ArrayList<String> pending = new ArrayList<>(); for (Uri uri : resolving) if (uri != null) pending.add(uri.toString()); out.putStringArrayList("resolving", pending);
        out.putInt("picker", picker); out.putString("saveName", saveName); out.putString("saveToken", saveToken); out.putString("message", message);
    }
    void restore(Bundle saved) {
        if (saved == null) return;
        picker = saved.getInt("picker"); saveName = saved.getString("saveName"); saveToken = saved.getString("saveToken"); message = saved.getString("message", "");
        ArrayList<Bundle> selected = saved.getParcelableArrayList("sources");
        if (selected != null && selected.size() <= 32) for (Bundle entry : selected) try {
            String uri = entry.getString("uri"), key = entry.getString("key"); if (key == null) continue;
            Models.Source source;
            if (uri != null) {
                Uri value = Uri.parse(uri); if (!"content".equals(value.getScheme())) continue;
                long size = entry.getLong("size", -1); if (size < -1 || size > RootApi.MAX_FILE) continue;
                String name = entry.getString("name"); Models.requireName(name); source = new Models.Source(value, name, size);
            } else source = Models.Source.shared(entry.getString("path"), entry.getLong("size", -1));
            selection.put(key, source);
        } catch (Exception ignored) { }
        ArrayList<String> pending = saved.getStringArrayList("resolving");
        if (pending != null && pending.size() <= 32 && !pending.isEmpty()) { ArrayList<Uri> uris = new ArrayList<>(); for (String uri : pending) uris.add(Uri.parse(uri)); resolveUris(uris, null); }
    }
    void destroy() {
        destroyed = true; pickerReply = null; backupReply = null;
        if (registered) { activity.unregisterReceiver(updates); client.removeListener(changed); BackupImport.get(activity).remove(imported); registered = false; }
        if (browseCall != null) browseCall.cancel();
        if (export != null && export.owner.get() == this) { export.reply = null; if (!export.committing) export.cancel(); export.owner.clear(); }
        io.shutdown(); sources.shutdown();
    }
    static Intent shareIntent(List<String> names, ArrayList<Uri> uris) {
        if (uris.isEmpty() || uris.size() != names.size() || uris.size() > 32) throw new IllegalArgumentException("Invalid shared file selection");
        String type = ExportProvider.mime(names.get(0)); for (String name : names) if (!type.equals(ExportProvider.mime(name))) { type = "*/*"; break; }
        Intent intent = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE).setType(type);
        if (uris.size() == 1) intent.putExtra(Intent.EXTRA_STREAM, uris.get(0)); else intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
        ClipData clip = ClipData.newRawUri("Taildrop", uris.get(0)); for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
        intent.setClipData(clip); return intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }
    private void startExport(List<String> names, String artifact, Uri target, boolean share, Consumer<JSONObject> reply) {
        ExportJob job = new ExportJob(this, new ArrayList<>(names), artifact, target, share, reply); export = job; job.changed(); EXPORTS.execute(job::run);
    }
    private static final class ExportJob {
        final Context context;
        final ArrayList<String> names;
        final String artifact;
        final Uri target;
        final boolean share;
        final RootApi.Call cancellation = new RootApi.Call();
        volatile RootApi.Call read;
        volatile boolean busy = true, committing, cancelled;
        long bytes;
        String message = "", error;
        WeakReference<FileActions> owner;
        Consumer<JSONObject> reply;
        ExportJob(FileActions files, ArrayList<String> names, String artifact, Uri target, boolean share, Consumer<JSONObject> reply) {
            context = AppPreferences.localized(files.activity.getApplicationContext()); this.names = names; this.artifact = artifact; this.target = target; this.share = share; this.reply = reply; owner = new WeakReference<>(files);
        }
        JSONObject snapshot() { return object("busy", busy, "committing", committing, "bytes", bytes, "message", message, "error", error); }
        void changed() { FileActions files = owner.get(); if (files != null && !files.destroyed) { files.emit.accept("export", snapshot()); files.publish(); } }
        void cancel() { if (committing || !busy) return; cancelled = true; cancellation.cancel(); RootApi.Call current = read; if (current != null) current.cancel(); }
        void check() throws InterruptedIOException { if (cancelled || cancellation.cancelled.get()) throw new InterruptedIOException(context.getString(R.string.cancelled)); }
        void discard(List<Uri> uris) { for (Uri uri : uris) try { ExportProvider.discard(context, uri); } catch (IOException ignored) { } }
        void run() {
            ArrayList<Uri> ready = new ArrayList<>();
            try {
                for (int i = 0; i < names.size(); i++) {
                    check(); String name = names.get(i); int index = i + 1; long[] last = {0};
                    RootApi.Progress progress = count -> {
                        long now = SystemClock.elapsedRealtime(); if (now - last[0] < 250) return; last[0] = now;
                        MAIN.post(() -> { bytes = count; message = context.getString(committing ? R.string.repair_files_save_committing : R.string.repair_files_saving, name, WebFormat.bytes(count)); if (names.size() > 1) message = context.getString(R.string.taildrop_share_progress, index, names.size(), name, WebFormat.bytes(count)); changed(); });
                    };
                    RootApi.Call call = new RootApi.Call(); read = call; check();
                    ExportProvider.Writer writer = output -> { check(); if (artifact == null) RootApi.readInbox(context, name, output, progress, call); else RootApi.readArtifact(context, artifact, output, progress, call); };
                    try {
                        if (target == null) ready.add(ExportProvider.cache(context, name, writer));
                        else ExportProvider.save(context, name, target, writer, () -> {
                            FutureTask<Void> fence = new FutureTask<>(() -> { check(); FileActions files = owner.get(); if (files == null || files.destroyed) throw new InterruptedIOException(context.getString(R.string.cancelled)); committing = true; bytes = 0; message = context.getString(R.string.repair_files_save_committing, name, WebFormat.bytes(0)); changed(); return null; });
                            MAIN.post(fence); fence.get();
                        }, progress);
                    } finally { call.finished = true; read = null; }
                }
                if (!committing) check();
                MAIN.post(() -> {
                    try {
                        FileActions files = owner.get();
                        if (target == null) {
                            check(); if (files == null || files.destroyed) throw new InterruptedIOException(context.getString(R.string.cancelled));
                            Intent intent = share ? shareIntent(names, ready) : new Intent(Intent.ACTION_VIEW).setDataAndType(ready.get(0), ExportProvider.mime(names.get(0))).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            if (!share) intent.setClipData(ClipData.newRawUri(names.get(0), ready.get(0)));
                            files.activity.startActivity(Intent.createChooser(intent, context.getString(share ? R.string.share : R.string.open)));
                        }
                        finish(object("ok", true, target == null ? "launched" : "saved", true), null);
                    } catch (Exception problem) { discard(ready); finish(failure(problem), RootApi.message(problem)); }
                });
            } catch (Exception problem) {
                discard(ready); String detail = RootApi.message(problem) + (committing ? "\n" + context.getString(R.string.repair_files_save_partial) : "");
                MAIN.post(() -> finish(object("ok", false, "error", detail, "cancelled", cancelled, "partial", committing), detail));
            } finally { cancellation.finished = true; }
        }
        void finish(JSONObject result, String failure) {
            busy = false; committing = false; error = failure; message = failure == null ? (target == null ? "" : context.getString(R.string.saved)) : failure; changed();
            FileActions files = owner.get(); if (files != null) files.respond(reply, result); reply = null;
        }
    }
}
