package dev.foxderin.tail;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.*;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import org.json.*;
import java.io.*;
import java.lang.ref.WeakReference;
import java.util.*;
import java.util.concurrent.*;

final class NativeFiles {
    static final int PICK = 10, SAVE = 11, NOTIFY = 12, TREE = 13, BACKUP = 50;
    private static NativeFiles instance;
    static synchronized NativeFiles get(Context context) {
        if (instance == null) instance = new NativeFiles(context.getApplicationContext());
        return instance;
    }
    private final Context base;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService exports = Executors.newSingleThreadExecutor();
    private final List<Runnable> listeners = new ArrayList<>();
    private final ArrayList<Models.Source> selection = new ArrayList<>();
    private final LinkedHashSet<Uri> resolving = new LinkedHashSet<>();
    private WeakReference<Activity> host = new WeakReference<>(null);
    private JSONObject entry = new JSONObject(), progress = new JSONObject(), result, exportResult;
    private String message = "", exportMessage = "", exportKind = "", pickerAction, artifact;
    private ArrayList<String> pickerNames;
    private int revision, selectionGeneration;
    private boolean restoring, transferStarting, loginPending;
    private final Preparation preparation = new Preparation();
    static final class Preparation {
        private long generation;
        private boolean pending;
        long begin() { pending = true; return ++generation; }
        boolean pending() { return pending; }
        boolean finish(long token) {
            if (!pending || token != generation) return false;
            pending = false; return true;
        }
        boolean cancel() { if (!pending) return false; pending = false; generation++; return true; }
    }
    private volatile RootApi.Call exportCall, exportRead;
    private volatile boolean committing, cancelled;
    private FutureTask<Void> deferredHandoff;
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { transferStarting = false; changed(); }
    };
    private NativeFiles(Context context) {
        base = context;
        IntentFilter filter = new IntentFilter(TransferService.UPDATE);
        base.registerReceiver(receiver, filter, "dev.foxderin.tail.INTERNAL", null, Build.VERSION.SDK_INT >= 33 ? Context.RECEIVER_NOT_EXPORTED : 0);
    }
    private Context context() { return PlatformLocale.localized(base); }
    private String text(int resource) { return context().getString(resource); }
    void localeChanged() { changed(); }
    void observe(Runnable listener) { if (!listeners.contains(listener)) listeners.add(listener); }
    void remove(Runnable listener) { listeners.remove(listener); }
    private void changed() { for (Runnable listener : new ArrayList<>(listeners)) listener.run(); }
    private void failure(Exception error) {
        message = RootApi.message(error);
        try {
            result = new JSONObject().put("ok", false).put("error", message);
            if (error instanceof RootApi.Failure) { RootApi.Failure root = (RootApi.Failure) error; result.put("result", root.result).put("exitCode", root.exitCode); }
        } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
        changed();
    }
    void attach(Activity activity, Bundle saved) {
        host = new WeakReference<>(activity);
        if (saved != null && !restoring) {
            restoring = true;
            if (selection.isEmpty() && resolving.isEmpty()) {
                ArrayList<String> paths = saved.getStringArrayList("paths"); long[] sizes = saved.getLongArray("sizes");
                if (paths != null && sizes != null && paths.size() == sizes.length && paths.size() <= 32)
                    for (int i = 0; i < paths.size(); i++) try { selection.add(Models.Source.shared(paths.get(i), sizes[i])); } catch (IOException error) { message = RootApi.message(error); }
                ArrayList<String> uris = saved.getStringArrayList("uris");
                if (uris != null && uris.size() <= 32) { ArrayList<Uri> values = new ArrayList<>(); for (String uri : uris) values.add(Uri.parse(uri)); resolve(values, 0); }
            }
            if (pickerAction == null) { pickerAction = saved.getString("pickerAction"); pickerNames = saved.getStringArrayList("pickerNames"); artifact = saved.getString("artifact"); }
            if (entry.length() == 0) try { entry = new JSONObject(saved.getString("entry", "{}")); } catch (JSONException ignored) { }
            exportKind = saved.getString("exportKind", "");
            if (!exportKind.isEmpty()) {
                message = exportMessage = saved.getString("exportMessage", "");
                try {
                    progress = new JSONObject(saved.getString("exportProgress", "{}"));
                    String terminal = saved.getString("exportResult");
                    if (terminal != null) result = exportResult = new JSONObject(terminal);
                    if (saved.getBoolean("exportPending") && exportCall == null) {
                        message = exportMessage = text(R.string.control_import_interrupted);
                        result = exportResult = new JSONObject().put("ok", false).put("error", message);
                    }
                } catch (JSONException ignored) { }
            }
        }
        restoring = true;
        if (deferredHandoff != null) {
            FutureTask<Void> handoff = deferredHandoff; deferredHandoff = null; handoff.run();
        }
        changed();
    }
    void detach(Activity activity) { if (host.get() == activity) host.clear(); }
    Bundle saveState() {
        Bundle state = new Bundle(); ArrayList<String> uris = new ArrayList<>(), paths = new ArrayList<>(); ArrayList<Long> sizes = new ArrayList<>();
        for (Models.Source source : selection) if (source.uri != null) uris.add(source.uri.toString()); else { paths.add(source.path); sizes.add(source.size); }
        for (Uri uri : resolving) if (uri != null && !uris.contains(uri.toString())) uris.add(uri.toString());
        long[] lengths = new long[sizes.size()]; for (int i = 0; i < sizes.size(); i++) lengths[i] = sizes.get(i);
        state.putStringArrayList("uris", uris); state.putStringArrayList("paths", paths); state.putLongArray("sizes", lengths);
        state.putString("pickerAction", pickerAction); state.putStringArrayList("pickerNames", pickerNames); state.putString("artifact", artifact);
        state.putString("exportKind", exportKind); state.putString("exportMessage", exportMessage);
        state.putString("exportProgress", progress.toString()); if (exportResult != null) state.putString("exportResult", exportResult.toString());
        state.putString("entry", entry.toString()); state.putBoolean("exportPending", exportCall != null); return state;
    }
    JSONObject entry() { return entry; }
    JSONObject snapshot() throws JSONException {
        JSONArray selected = new JSONArray();
        for (Models.Source source : selection) {
            JSONObject item = new JSONObject().put("key", source.key()).put("name", source.name).put("size", source.size);
            if (source.uri != null) item.put("uri", source.uri.toString()); else item.put("path", source.path);
            selected.put(item);
        }
        return new JSONObject().put("selection", selected).put("pending", !resolving.isEmpty() || pickerAction != null || exportCall != null || preparation.pending() || transferStarting)
                .put("resolving", !resolving.isEmpty()).put("pickerPending", pickerAction != null).put("exporting", exportCall != null)
                .put("canCancel", exportCall != null && !committing && !cancelled).put("exportKind", exportKind).put("progress", progress).put("message", message)
                .put("exportMessage", exportMessage).put("exportResult", exportResult == null ? JSONObject.NULL : exportResult).put("exportProgress", progress)
                .put("exportPickerPending", "save".equals(pickerAction) || "tree".equals(pickerAction))
                .put("result", result == null ? JSONObject.NULL : result).put("revision", revision);
    }
    JSONObject transferSnapshot() throws JSONException {
        SharedPreferences prefs = TransferService.state(base); JSONObject value = new JSONObject();
        for (Map.Entry<String, ?> item : prefs.getAll().entrySet()) {
            Object data = item.getValue();
            if (("snapshot".equals(item.getKey()) || "staged".equals(item.getKey())) && data instanceof String) {
                try { data = "snapshot".equals(item.getKey()) ? new JSONObject((String) data) : new JSONArray((String) data); }
                catch (JSONException error) { data = JSONObject.NULL; }
            }
            value.put(item.getKey(), data);
        }
        return value.put("busy", TransferService.isRunning() || preparation.pending() || transferStarting).put("recoveryRequired", recoveryRequired())
                .put("accountRevision", prefs.getLong("accountRevision", -1));
    }
    private boolean recoveryRequired() {
        SharedPreferences state = TransferService.state(base);
        return state.contains("request") || state.contains("staged") || state.contains("job") || state.getBoolean("preparing", false) || state.getBoolean("submissionUnknown", false);
    }
    boolean transferBlocked() { return TransferService.isRunning() || preparation.pending() || transferStarting || recoveryRequired(); }
    void setLoginPending(boolean pending) { loginPending = pending; }
    boolean loginPending() { return loginPending; }
    private Activity activity() throws IOException {
        Activity activity = host.get();
        if (activity == null || activity.isDestroyed() || activity.isFinishing()) throw new IOException("Activity is unavailable");
        return activity;
    }
    private void requireIdleSelection() throws IOException { if (transferBlocked() || !resolving.isEmpty()) throw new IOException(text(R.string.busy)); }
    private void requireWrite() throws IOException {
        ControlClient client = ControlClient.get(base);
        if (!client.canWrite() || client.busy() || loginPending) throw new IOException(text(R.string.control_unavailable));
    }
    boolean invoke(String method, JSONObject args) throws Exception {
        switch (method) {
            case "ackEntry": if (args.getString("id").equals(entry.optString("id"))) { entry = new JSONObject(); changed(); } break;
            case "openUrl": {
                Uri uri = Uri.parse(args.getString("url"));
                if ((!"https".equalsIgnoreCase(uri.getScheme()) && !"http".equalsIgnoreCase(uri.getScheme())) || uri.getHost() == null || uri.getUserInfo() != null) throw new IOException(text(R.string.control_invalid_url));
                activity().startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); break;
            }
            case "pickFiles": requireIdleSelection(); picker("files", null, null, new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true), PICK); break;
            case "addSharedFiles": addShared(args.getJSONArray("files")); break;
            case "removeSource": requireIdleSelection(); selection.removeIf(source -> source.key().equals(args.optString("key"))); revision++; changed(); break;
            case "clearSources": if (transferBlocked()) throw new IOException(text(R.string.busy)); selectionGeneration++; revision++; selection.clear(); resolving.clear(); changed(); break;
            case "sendFiles": requireWrite(); requireIdleSelection(); if (!resolving.isEmpty() || selection.isEmpty()) throw new IOException(text(R.string.choose_first)); prepareTransfer(args.getString("peerId"), null); break;
            case "retryTransfer": requireWrite(); requireIdleSelection(); prepareTransfer(null, job(args.getString("jobId"))); break;
            case "adoptTransfer": if (!TransferService.isRunning() && !preparation.pending() && !transferStarting) launch(new Intent(base, TransferService.class).setAction(TransferService.ADOPT).putExtra("job", job(args.getString("jobId")))); break;
            case "cancelTransfer": {
                if (preparation.cancel()) { message = text(R.string.cancelled_local); changed(); break; }
                Intent cancel = new Intent(base, TransferService.class).setAction(TransferService.CANCEL);
                if (args.has("jobId")) cancel.putExtra("job", job(args.getString("jobId")));
                base.startForegroundService(cancel); break;
            }
            case "recoverTransfer": recover(); break;
            case "importInbox": requireWrite(); requireIdleSelection(); launch(new Intent(base, TransferService.class).setAction(TransferService.IMPORT)); break;
            case "pickBackup": requireWrite(); if (BackupImport.get(base).busy()) throw new IOException(text(R.string.busy)); picker("backup", null, null, new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE), BACKUP); break;
            case "saveArtifact": case "shareArtifact": {
                String id = args.getString("id"), name = args.getString("name"); artifact(id); Models.requireName(name);
                if ("saveArtifact".equals(method)) savePicker(name, id); else export(Collections.singletonList(name), "share", null, id); break;
            }
            case "openInbox": { String name = name(args.getString("name")); export(Collections.singletonList(name), "open", null, null); break; }
            case "shareInbox": export(names(args.getJSONArray("names")), "share", null, null); break;
            case "saveInbox": savePicker(name(args.getString("name")), null); break;
            case "exportInbox": {
                ArrayList<String> selected = names(args.getJSONArray("names"));
                picker("tree", selected, null, new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION), TREE); break;
            }
            case "cancelExport": if (exportCall != null && !committing) {
                cancelled = true; exportCall.cancel(); RootApi.Call read = exportRead; if (read != null) read.cancel();
                if (deferredHandoff != null) { deferredHandoff.cancel(false); deferredHandoff = null; }
                changed();
            } break;
            case "requestNotifications": requestNotifications(); break;
            default: return false;
        }
        return true;
    }
    private static String name(String name) throws IOException { Models.requireName(name); return name; }
    private static void artifact(String id) throws IOException { if (id == null || !id.matches("art-[a-f0-9]{32}")) throw new IOException("Invalid artifact token"); }
    private static String job(String id) throws IOException { if (id == null || !id.matches("[a-fA-F0-9]{16,128}")) throw new IOException("Invalid transfer ID"); return id; }
    static ArrayList<String> names(JSONArray values) throws Exception {
        if (values.length() < 1 || values.length() > 32) throw new IOException("Select 1–32 files");
        ArrayList<String> names = new ArrayList<>();
        for (int i = 0; i < values.length(); i++) { String name = name(values.getString(i)); if (names.contains(name)) throw new IOException("Duplicate file"); names.add(name); }
        return names;
    }
    private void addShared(JSONArray values) throws Exception {
        requireIdleSelection(); ArrayList<Models.Source> accepted = new ArrayList<>(selection); Set<String> keys = new HashSet<>();
        for (Models.Source item : accepted) keys.add(item.key());
        if (values.length() > 32) throw new IOException(text(R.string.file_limit));
        for (int i = 0; i < values.length(); i++) {
            JSONObject item = values.getJSONObject(i); long size = Models.number(item, "size");
            if (((Number) item.get("size")).doubleValue() != size) throw new IOException("Invalid file size");
            Models.Source source = Models.Source.shared(item.getString("path"), size);
            if (keys.add(source.key())) accepted.add(source);
        }
        if (accepted.size() + resolving.size() > 32) throw new IOException(text(R.string.file_limit));
        selection.clear(); selection.addAll(accepted); revision++; message = ""; changed();
    }
    void acceptIntent(Intent intent) {
        if (intent == null) return;
        try {
            boolean share = Intent.ACTION_SEND.equals(intent.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction());
            String destination = share || intent.getBooleanExtra("history", false) ? "files" : intent.getStringExtra(ControlActivity.DESTINATION);
            if (destination == null) return;
            if (!Arrays.asList("overview", "peers", "files", "account", "tunnel", "routing", "settings", "context", "trial", "serve", "coexist", "traffic", "logs", "diagnostics", "backup", "more").contains(destination)) destination = "overview";
            entry = new JSONObject().put("id", UUID.randomUUID().toString()).put("destination", destination)
                    .put("section", share ? "send" : intent.getBooleanExtra("history", false) ? "history" : "");
            if (share) { requireIdleSelection(); resolve(sharedUris(intent), intent.getFlags()); }
            changed();
        } catch (Exception error) { failure(error); }
    }
    static ArrayList<Uri> sharedUris(Intent intent) {
        ArrayList<Uri> uris = new ArrayList<>(); String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return uris;
        if (Intent.ACTION_SEND.equals(action)) { Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM); if (uri != null) uris.add(uri); }
        else { ArrayList<Uri> values = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM); if (values != null) uris.addAll(values); }
        if (uris.isEmpty() && intent.getClipData() != null) for (int i = 0; i < intent.getClipData().getItemCount(); i++) uris.add(intent.getClipData().getItemAt(i).getUri());
        return uris;
    }
    private void resolve(List<Uri> uris, int flags) {
        if (uris.isEmpty() || uris.size() > 32) { failure(new IOException(text(uris.isEmpty() ? R.string.invalid_uri : R.string.file_limit))); return; }
        Set<String> keys = new HashSet<>(); for (Models.Source source : selection) keys.add(source.key()); for (Uri uri : resolving) keys.add(String.valueOf(uri));
        ArrayList<Uri> pending = new ArrayList<>(); for (Uri uri : uris) if (keys.add(String.valueOf(uri))) pending.add(uri);
        if (keys.size() > 32) { failure(new IOException(text(R.string.file_limit))); return; }
        resolving.addAll(pending); int version = selectionGeneration; changed();
        io.execute(() -> {
            ArrayList<Models.Source> accepted = new ArrayList<>(); ArrayList<String> errors = new ArrayList<>();
            for (Uri uri : pending) try {
                requireGrant(uri);
                if ((flags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0) try { base.getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (SecurityException ignored) { }
                accepted.add(Models.Source.resolve(context(), uri));
            } catch (Exception error) { errors.add(RootApi.message(error)); }
            main.post(() -> {
                if (version != selectionGeneration) { changed(); return; }
                resolving.removeAll(pending);
                if (TransferService.isRunning()) errors.add(text(R.string.busy));
                else for (Models.Source source : accepted) if (selection.stream().noneMatch(item -> item.key().equals(source.key()))) selection.add(source);
                revision++; message = String.join("\n", errors); changed();
            });
        });
    }
    private void requireGrant(Uri uri) throws IOException {
        if (uri == null || !"content".equals(uri.getScheme()) || base.checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) throw new IOException(text(R.string.invalid_uri));
    }
    private void picker(String action, ArrayList<String> names, String id, Intent intent, int request) throws IOException {
        if (pickerAction != null || exportCall != null) throw new IOException(text(R.string.busy));
        Activity activity = activity(); pickerAction = action; pickerNames = names; artifact = id;
        if ("save".equals(action) || "tree".equals(action)) beginExport(id);
        try { activity.startActivityForResult(intent, request); changed(); }
        catch (RuntimeException error) {
            pickerAction = null; pickerNames = null; artifact = null;
            if ("save".equals(action) || "tree".equals(action)) publishExport(exportResult(names, new JSONArray(), true, false, RootApi.message(error), false));
            throw error;
        }
    }
    private void savePicker(String name, String id) throws IOException {
        picker("save", new ArrayList<>(Collections.singletonList(name)), id,
                new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(id == null ? ExportProvider.mime(name) : "application/gzip").putExtra(Intent.EXTRA_TITLE, name), SAVE);
    }
    void activityResult(int request, int status, Intent data) {
        if (request != PICK && request != SAVE && request != TREE && request != BACKUP) return;
        ArrayList<String> names = pickerNames; String id = artifact;
        pickerAction = null; pickerNames = null; artifact = null; changed();
        if (status != Activity.RESULT_OK || data == null || ((request == SAVE || request == TREE) && data.getData() == null)) {
            if (names != null && (request == SAVE || request == TREE)) publishExport(exportResult(names, new JSONArray(), true, false, text(R.string.cancelled), true));
            return;
        }
        try {
            if (request == PICK) {
                ArrayList<Uri> uris = new ArrayList<>();
                if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
                else if (data.getData() != null) uris.add(data.getData());
                requireIdleSelection(); resolve(uris, data.getFlags());
            } else if (data.getData() != null) {
                if (request == BACKUP) BackupImport.get(base).start(data.getData(), data.getFlags());
                else if (names != null) export(names, request == TREE ? "tree" : "save", data.getData(), id);
            }
        } catch (Exception error) {
            if (names != null && (request == SAVE || request == TREE)) publishExport(exportResult(names, new JSONArray(), true, false, RootApi.message(error), false));
            else failure(error);
        }
    }
    private void requestNotifications() throws IOException {
        if (Build.VERSION.SDK_INT >= 33 && base.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            activity().requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFY);
    }
    void permissionResult(int request, int[] results) {
        if (request == NOTIFY && (results.length == 0 || results[0] != PackageManager.PERMISSION_GRANTED)) { message = text(R.string.notifications_hint); changed(); }
    }
    private void launch(Intent intent) {
        transferStarting = true;
        try { base.startForegroundService(intent); message = ""; changed(); }
        catch (RuntimeException error) { transferStarting = false; throw error; }
    }
    private List<Models.Transfer> history() throws Exception {
        JSONArray values = RootApi.json(base, "file-send-history").getJSONArray("transfers");
        if (values.length() > 100) throw new IOException(text(R.string.invalid_response));
        ArrayList<Models.Transfer> result = new ArrayList<>(); HashSet<String> ids = new HashSet<>(); int active = 0;
        for (int i = 0; i < values.length(); i++) {
            Models.Transfer transfer = new Models.Transfer(values.getJSONObject(i));
            if (!ids.add(transfer.id) || (Models.active(transfer.status) && ++active > 1)) throw new IOException(text(R.string.invalid_response));
            result.add(transfer);
        }
        return result;
    }
    void requireNoActiveTransfer() throws Exception {
        for (Models.Transfer item : history()) if (Models.active(item.status)) throw new IOException(text(R.string.busy));
        if (recoveryRequired() || TransferService.isRunning()) throw new IOException(text(R.string.busy));
    }
    private void prepareTransfer(String peerId, String retry) {
        long token = preparation.begin(); ArrayList<Models.Source> sources = new ArrayList<>(selection); long account = ControlClient.get(base).accountRevision(); changed();
        io.execute(() -> {
            try {
                for (Models.Transfer item : history()) if (Models.active(item.status)) throw new IOException(text(R.string.busy));
                String target = peerId;
                if (retry != null) {
                    Models.Transfer prior = new Models.Transfer(RootApi.json(base, "file-send-status", retry).getJSONObject("transfer"));
                    if (Models.active(prior.status) || prior.retryPaths().length() == 0) throw new IOException("Only failed or cancelled files can be retried");
                    target = prior.peerId;
                }
                JSONArray values = RootApi.json(base, "taildrop-targets").getJSONArray("peers");
                if (values.length() > 10000) throw new IOException(text(R.string.invalid_response));
                Models.Peer peer = null; Set<String> seen = new HashSet<>();
                for (int i = 0; i < values.length(); i++) { Models.Peer item = new Models.Peer(values.getJSONObject(i)); if (!seen.add(item.id)) throw new IOException(text(R.string.invalid_response)); if (item.id.equals(target)) peer = item; }
                if (peer == null) throw new IOException(text(R.string.web_files_retry_target_missing));
                Intent intent = new Intent(base, TransferService.class).setAction(TransferService.START).putExtra("peer", peer.id).putExtra("ip", peer.ip);
                if (retry != null) intent.putExtra("retry", retry);
                else {
                    ArrayList<Uri> uris = new ArrayList<>(); ArrayList<String> paths = new ArrayList<>();
                    for (Models.Source source : sources) if (source.uri != null) { requireGrant(source.uri); Models.Source.resolve(context(), source.uri); uris.add(source.uri); } else paths.add(source.path);
                    intent.putParcelableArrayListExtra("uris", uris).putStringArrayListExtra("paths", paths);
                    if (!uris.isEmpty()) { ClipData clip = ClipData.newRawUri("Taildrop", uris.get(0)); for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i))); intent.setClipData(clip); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); }
                }
                main.post(() -> {
                    if (!preparation.finish(token)) return;
                    try { requireWrite(); requireIdleSelection(); if (account != ControlClient.get(base).accountRevision()) throw new IOException("Account changed"); launch(intent); }
                    catch (Exception error) { failure(error); } finally { changed(); }
                });
            } catch (Exception error) { main.post(() -> { if (preparation.finish(token)) failure(error); }); }
        });
    }
    private void recover() {
        if (TransferService.isRunning() || preparation.pending() || transferStarting) return;
        long token = preparation.begin(); changed();
        io.execute(() -> {
            try {
                List<Models.Transfer> history = history(); String active = null;
                SharedPreferences state = TransferService.state(base);
                boolean unknown = state.getBoolean("submissionUnknown", false), matched = false;
                JSONArray attempt = new JSONArray(state.getString("attemptPaths", "[]"));
                for (Models.Transfer item : history) {
                    if (Models.active(item.status)) active = item.id;
                    if (unknown && item.peerId.equals(state.getString("attemptPeer", "")) && item.started >= state.getLong("attemptTime", Long.MAX_VALUE) && item.files.size() == attempt.length()) {
                        boolean same = true;
                        for (int i = 0; i < item.files.size(); i++) same &= item.files.get(i).path.equals(attempt.getString(i));
                        if (same) matched = true;
                    }
                }
                if (unknown && !matched) throw new IOException("Transfer submission remains unconfirmed; do not send again");
                if (matched) state.edit().remove("submissionUnknown").remove("attemptPeer").remove("attemptPaths").remove("attemptTime").commit();
                String job = active;
                main.post(() -> {
                    if (!preparation.finish(token)) return;
                    try {
                        if (job != null) launch(new Intent(base, TransferService.class).setAction(TransferService.ADOPT).putExtra("job", job));
                        else {
                            state.edit().remove("job").apply();
                            if (recoveryRequired()) launch(new Intent(base, TransferService.class).setAction(TransferService.RECOVER));
                            else changed();
                        }
                    } catch (Exception error) { failure(error); }
                });
            } catch (Exception error) { main.post(() -> { if (preparation.finish(token)) failure(error); }); }
        });
    }
    void operationFinished() {
        revision++; changed();
    }
    static JSONArray validateBrowse(JSONObject result, String requested) throws Exception {
        if (!Models.relativePath(requested) || !result.getBoolean("ok") || !requested.equals(result.get("path")) || !(result.get("truncated") instanceof Boolean)) throw new IOException("Invalid browse response");
        JSONArray entries = result.getJSONArray("entries"); if (entries.length() > 1000) throw new IOException("Invalid browse count");
        Set<String> paths = new HashSet<>();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject item = entries.getJSONObject(i); String name = Models.required(item, "name"); Models.requireName(name);
            String path = Models.required(item, "path");
            if (!Models.sharedPath(path) || !path.equals("/sdcard/" + (requested.isEmpty() ? "" : requested + "/") + name) || !(item.get("directory") instanceof Boolean) || !paths.add(path)) throw new IOException("Invalid browse entry");
            Models.number(item, "size"); Models.number(item, "mtime");
        }
        return entries;
    }
    static Intent shareIntent(List<String> names, ArrayList<Uri> uris) {
        if (uris.isEmpty() || uris.size() != names.size() || uris.size() > 32) throw new IllegalArgumentException("Invalid shared file selection");
        String type = ExportProvider.mime(names.get(0)); for (String name : names) if (!type.equals(ExportProvider.mime(name))) { type = "*/*"; break; }
        Intent intent = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE).setType(type);
        if (uris.size() == 1) intent.putExtra(Intent.EXTRA_STREAM, uris.get(0)); else intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
        ClipData clip = ClipData.newRawUri("Taildrop", uris.get(0)); for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
        intent.setClipData(clip); return intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }
    private void beginExport(String artifactId) {
        exportKind = artifactId == null ? "inbox" : "artifact";
        message = exportMessage = ""; result = exportResult = null; progress = new JSONObject();
    }
    private void publishExport(JSONObject completed) {
        result = exportResult = completed;
        message = exportMessage = completed.optBoolean("ok") ? (completed.optBoolean("handedOff") ? "" : text(R.string.saved)) : failureSummary(completed); changed();
    }
    static JSONObject exportResult(List<String> names, JSONArray outcomes, boolean atomic, boolean handedOff, String error, boolean cancelled) {
        try {
            JSONArray results = new JSONArray(); boolean success = true;
            for (int i = 0; i < names.size(); i++) {
                JSONObject item = i < outcomes.length() ? outcomes.getJSONObject(i) : new JSONObject().put("name", names.get(i)).put("ok", false);
                if (atomic) item = new JSONObject().put("name", names.get(i)).put("ok", handedOff);
                if (!item.optBoolean("ok")) { success = false; if (!item.has("error")) item.put("error", error); }
                results.put(item);
            }
            return new JSONObject().put("ok", success).put("results", results).put("cancelled", cancelled).put("handedOff", atomic && handedOff);
        } catch (JSONException impossible) { throw new IllegalStateException(impossible); }
    }
    private void handoff(Intent chooser, RootApi.Call call) throws Exception {
        FutureTask<Void> task = new FutureTask<>(() -> {
            checkCancelled(call); Activity activity = activity(); committing = true;
            activity.startActivity(chooser); changed(); return null;
        });
        fence(() -> {
            checkCancelled(call); Activity activity = host.get();
            if (activity == null || activity.isDestroyed() || activity.isFinishing()) deferredHandoff = task; else task.run();
            return null;
        });
        try { task.get(); } catch (ExecutionException error) { Throwable cause = error.getCause(); if (cause instanceof Exception) throw (Exception) cause; throw error; }
    }
    private void export(List<String> names, String action, Uri target, String artifactId) throws Exception {
        if (exportCall != null || pickerAction != null) throw new IOException(text(R.string.busy));
        if (target != null && !"content".equals(target.getScheme())) throw new IOException(text(R.string.invalid_uri));
        RootApi.Call call = new RootApi.Call(); exportCall = call; committing = false; cancelled = false; beginExport(artifactId); changed();
        exports.execute(() -> {
            JSONArray outcomes = new JSONArray(); ArrayList<Uri> ready = new ArrayList<>();
            boolean handedOff = false; String exportError = "Not exported";
            try {
                for (int i = 0; i < names.size(); i++) {
                    String name = names.get(i); final int index = i + 1; Uri staged = null; boolean partial = false;
                    try {
                        checkCancelled(call); updateProgress(name, index, names.size(), 0, "preparing");
                        RootApi.Call read = new RootApi.Call(); exportRead = read;
                        staged = ExportProvider.cache(context(), name, output -> {
                            checkCancelled(call);
                            if (artifactId == null) RootApi.readInbox(base, name, output, bytes -> updateProgress(name, index, names.size(), bytes, "preparing"), read);
                            else RootApi.readArtifact(base, artifactId, output, read);
                        });
                        checkCancelled(call);
                        if (target == null) { ready.add(staged); staged = null; }
                        else {
                            Uri verified = staged;
                            fence(() -> { checkCancelled(call); committing = true; changed(); return null; });
                            Uri destination = target;
                            if ("tree".equals(action)) destination = createDocument(target, name);
                            else requireEmptyDocument(destination);
                            partial = true;
                            updateProgress(name, index, names.size(), 0, "committing");
                            try (InputStream input = base.getContentResolver().openInputStream(verified); OutputStream output = base.getContentResolver().openOutputStream(destination, "wt")) {
                                if (input == null || output == null) throw new IOException(text(R.string.export_failed));
                                RootApi.copy(input, output, RootApi.MAX_FILE, bytes -> updateProgress(name, index, names.size(), bytes, "committing"), null);
                            }
                            partial = false;
                        }
                        outcomes.put(new JSONObject().put("name", name).put("ok", target != null));
                    } catch (Exception error) {
                        exportError = RootApi.message(error);
                        outcomes.put(new JSONObject().put("name", name).put("ok", false).put("error", RootApi.message(error)).put("partial", partial));
                        if (!"tree".equals(action) || cancelled) break;
                    } finally {
                        if (staged != null) try { ExportProvider.discard(base, staged); } catch (IOException ignored) { }
                        exportRead = null; fence(() -> { committing = false; changed(); return null; });
                    }
                }
                if (target == null && ready.size() == names.size()) {
                    checkCancelled(call);
                    Intent intent;
                    if ("open".equals(action)) {
                        intent = new Intent(Intent.ACTION_VIEW).setDataAndType(ready.get(0), ExportProvider.mime(names.get(0))).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        intent.setClipData(ClipData.newRawUri(names.get(0), ready.get(0)));
                    } else intent = shareIntent(names, ready);
                    Intent chooser = Intent.createChooser(intent, text("open".equals(action) ? R.string.open : R.string.share));
                    handoff(chooser, call);
                    handedOff = true; ready.clear();
                }
            } catch (Exception error) { exportError = RootApi.message(error); }
            finally {
                JSONObject completed = exportResult(names, outcomes, target == null, handedOff, cancelled ? text(R.string.cancelled) : exportError, cancelled);
                main.post(() -> publishExport(completed));
                for (Uri uri : ready) try { ExportProvider.discard(base, uri); } catch (IOException ignored) { }
                call.finished = true; main.post(() -> { exportCall = null; committing = false; revision++; changed(); });
            }
        });
    }
    private String failureSummary(JSONObject result) {
        ArrayList<String> errors = new ArrayList<>(); JSONArray values = result.optJSONArray("results");
        if (values != null) for (int i = 0; i < values.length(); i++) { JSONObject item = values.optJSONObject(i); if (item != null && !item.optBoolean("ok")) errors.add(item.optString("name") + ": " + item.optString("error") + (item.optBoolean("partial") ? "\n" + text(R.string.repair_files_save_partial) : "")); }
        return String.join("\n", errors);
    }
    private long lastProgress;
    private void updateProgress(String name, int index, int total, long bytes, String phase) {
        long now = SystemClock.elapsedRealtime(); if (bytes > 0 && now - lastProgress < 200) return; lastProgress = now;
        main.post(() -> { try { progress = new JSONObject().put("name", name).put("index", index).put("total", total).put("bytes", bytes).put("phase", phase); changed(); } catch (JSONException impossible) { throw new IllegalStateException(impossible); } });
    }
    private void checkCancelled(RootApi.Call call) throws IOException { if (cancelled || call.cancelled.get()) throw new InterruptedIOException(text(R.string.cancelled)); }
    private <T> T fence(Callable<T> task) throws Exception {
        FutureTask<T> future = new FutureTask<>(task); main.post(future);
        try { return future.get(); } catch (ExecutionException error) { Throwable cause = error.getCause(); if (cause instanceof Exception) throw (Exception) cause; throw error; }
    }
    private void requireEmptyDocument(Uri uri) throws Exception {
        try (Cursor cursor = base.getContentResolver().query(uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst() || cursor.isNull(0) || cursor.getLong(0) != 0) throw new IOException("Destination is not empty; existing files are never overwritten");
        }
    }
    private Uri createDocument(Uri tree, String name) throws Exception {
        if (!DocumentsContract.isTreeUri(tree)) throw new IOException(text(R.string.invalid_uri));
        String parent = DocumentsContract.getTreeDocumentId(tree);
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent);
        try (Cursor cursor = base.getContentResolver().query(children, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (cursor == null) throw new IOException("Cannot inspect destination folder");
            while (cursor.moveToNext()) if (name.equals(cursor.getString(0))) throw new IOException("A file with this name already exists");
        }
        Uri created = DocumentsContract.createDocument(base.getContentResolver(), DocumentsContract.buildDocumentUriUsingTree(tree, parent), ExportProvider.mime(name), name);
        if (created == null) throw new IOException(text(R.string.export_failed));
        return created;
    }
}
