package dev.foxderin.tail;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.*;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

public final class TransferService extends Service {
    static final String UPDATE = "dev.foxderin.tail.TRANSFER_UPDATE";
    static final String START = "start", ADOPT = "adopt", CANCEL = "cancel", IMPORT = "import", RECOVER = "recover";
    private static final String CHANNEL = "taildrop";
    private static final int NOTIFICATION = 41;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService control = Executors.newSingleThreadExecutor();
    private volatile boolean busy, cancelRequested, stopping;
    private static volatile boolean running;
    static boolean isRunning() { return running; }
    private volatile String jobId, requestId;
    private volatile RootApi.Call currentCall;
    private Handler main;
    private SharedPreferences prefs;
    private long lastProgress;
    @Override public void onCreate() {
        super.onCreate(); main = new Handler(getMainLooper()); prefs = getSharedPreferences("transfer", MODE_PRIVATE);
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, getString(R.string.service_channel), NotificationManager.IMPORTANCE_LOW));
    }
    static SharedPreferences state(Context context) { return context.getSharedPreferences("transfer", MODE_PRIVATE); }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && CANCEL.equals(intent.getAction())) {
            cancelRequested = true;
            final String job = jobId, request = requestId;
            final RootApi.Call call = currentCall;
            control.execute(() -> {
                try {
                    if (job != null) RootApi.json(this, "file-send-cancel", job);
                    else if (request != null) RootApi.json(this, "cancel", request);
                    publish(getString(R.string.cancel_requested), null);
                } catch (Exception e) { publish(RootApi.message(e), null); }
                finally { if (call != null) call.cancel(); }
                if (!busy) main.post(this::finish);
            });
            if (!busy) startForeground(NOTIFICATION, notification(getString(R.string.cancel_requested)));
            return START_NOT_STICKY;
        }
        if (busy) return START_NOT_STICKY;
        busy = true; running = true; stopping = false; cancelRequested = false;
        prefs.edit().remove("snapshot").putString("message", getString(R.string.working)).apply();
        startForeground(NOTIFICATION, notification(getString(R.string.working)));
        sendBroadcast(new Intent(UPDATE).setPackage(getPackageName()));
        final Intent task = intent;
        worker.execute(() -> runTask(task));
        return START_NOT_STICKY;
    }
    private void runTask(Intent intent) {
        List<String> staged = new ArrayList<>();
        boolean submissionAttempted = false;
        try {
            if (intent == null) return;
            String action = intent.getAction();
            cleanupInterrupted();
            if (RECOVER.equals(action)) {
                publish(getString(R.string.interrupted_stage), null);
                return;
            }
            if (IMPORT.equals(action)) {
                requestId = RootApi.requestId(); currentCall = new RootApi.Call();
                prefs.edit().putString("request", requestId).apply();
                JSONObject result = RootApi.json(this, requestId, null, null, 150, currentCall, "file-receive");
                long received = Models.number(result, "received");
                long ignored = result.has("ignored") ? Models.number(result, "ignored") : 0;
                String message = getString(R.string.imported, received);
                if (ignored > 0) message += "\n" + getString(R.string.repair_files_ignored_import, ignored);
                publish(message, null);
                return;
            }
            if (ADOPT.equals(action)) {
                jobId = intent.getStringExtra("job");
                if (jobId == null || !jobId.matches("[a-fA-F0-9]{16,128}")) throw new IOException(getString(R.string.invalid_response));
            } else if (START.equals(action)) {
                String peerId = intent.getStringExtra("peer"), peerIp = intent.getStringExtra("ip");
                JSONArray paths = new JSONArray();
                String retry = intent.getStringExtra("retry");
                if (retry != null) {
                    Models.Transfer prior = new Models.Transfer(RootApi.json(this, "file-send-status", retry).getJSONObject("transfer"));
                    if (!prior.peerId.equals(peerId)) throw new IOException(getString(R.string.invalid_response));
                    paths = prior.retryPaths();
                } else {
                    paths = sharedSources(intent);
                    ArrayList<Uri> uris = intent.getParcelableArrayListExtra("uris");
                    if (uris == null) uris = new ArrayList<>();
                    if (uris.size() + paths.length() == 0 || uris.size() + paths.length() > 32) throw new IOException(getString(R.string.file_limit));
                    for (Uri uri : uris) {
                        if (cancelRequested || stopping) throw new InterruptedIOException(getString(R.string.cancelled_local));
                        Models.Source source = Models.Source.resolve(this, uri);
                        requestId = RootApi.requestId(); currentCall = new RootApi.Call();
                        prefs.edit().putString("request", requestId).putBoolean("preparing", true).commit();
                        publish(getString(R.string.staging, source.name, Models.bytes(this, 0)), null);
                        JSONObject stage;
                        try (InputStream input = getContentResolver().openInputStream(uri)) {
                            if (input == null) throw new IOException(getString(R.string.invalid_uri));
                            stage = RootApi.json(this, requestId, input, bytes -> {
                                long now = SystemClock.elapsedRealtime();
                                if (now - lastProgress > 350) { lastProgress = now; publish(getString(R.string.staging, source.name, Models.bytes(this, bytes)), null); }
                            }, 1800, currentCall, "file-stage", source.name, Long.toString(source.size));
                        }
                        String path = Models.required(stage, "path");
                        if (!path.startsWith(Models.STAGED) || !Models.sourcePath(path) || Models.number(stage, "size") > RootApi.MAX_FILE || (source.size >= 0 && stage.getLong("size") != source.size)) throw new IOException(getString(R.string.invalid_response));
                        staged.add(path); paths.put(path);
                        prefs.edit().putString("staged", new JSONArray(staged).toString()).remove("request").commit();
                        requestId = null; currentCall = null;
                    }
                }
                if (cancelRequested || stopping) throw new InterruptedIOException(getString(R.string.cancelled_local));
                if (paths.length() == 0 || paths.length() > 32 || peerId == null || peerIp == null) throw new IOException(getString(R.string.choose_first));
                submissionAttempted = true;
                // Publish the ownership boundary before root submission; uncertain jobs retain sources for 24h.
                prefs.edit().remove("staged").remove("preparing").commit();
                Models.Transfer transfer = new Models.Transfer(RootApi.json(this, "file-send-start", peerId, peerIp, paths.toString()).getJSONObject("transfer"));
                jobId = transfer.id;
                prefs.edit().remove("staged").remove("preparing").putString("job", jobId).commit();
                publish(Models.state(this, transfer.status), transfer);
            } else return;
            prefs.edit().putString("job", jobId).apply();
            if (cancelRequested) RootApi.json(this, "file-send-cancel", jobId);
            int failures = 0;
            while (!stopping) {
                try {
                    Models.Transfer transfer = new Models.Transfer(RootApi.json(this, "file-send-status", jobId).getJSONObject("transfer"));
                    failures = 0;
                    publish(Models.state(this, transfer.status), transfer);
                    if (!Models.active(transfer.status)) { prefs.edit().remove("job").apply(); break; }
                } catch (Exception e) {
                    publish(getString(R.string.poll_failed, RootApi.message(e)), null);
                    if (++failures >= 3) break;
                }
                Thread.sleep(1000);
            }
        } catch (Exception e) {
            publish(failureMessage(this, e, cancelRequested, submissionAttempted, jobId, !staged.isEmpty()), null);
        } finally {
            if (requestId != null) {
                try { RootApi.json(this, "cancel", requestId); } catch (Exception ignored) { }
            }
            if (!submissionAttempted) {
                List<String> remaining = new ArrayList<>();
                for (String path : staged) {
                    try { RootApi.json(this, "file-stage-delete", path); }
                    catch (Exception ignored) { remaining.add(path); }
                }
                SharedPreferences.Editor edit = prefs.edit().remove("request").remove("preparing");
                if (!staged.isEmpty()) {
                    if (remaining.isEmpty()) edit.remove("staged"); else edit.putString("staged", new JSONArray(remaining).toString());
                }
                edit.commit();
            } else {
                // Even a failed start response can follow a saved job. Retain sources for backend retry/expiry.
                prefs.edit().remove("staged").remove("request").remove("preparing").commit();
            }
            requestId = null; currentCall = null; jobId = null;
            main.post(this::finish);
        }
    }
    static String failureMessage(Context context, Exception error, boolean cancelRequested, boolean submissionAttempted, String jobId, boolean hasStaged) {
        String message = RootApi.message(error);
        if (cancelRequested && jobId == null && !submissionAttempted) return context.getString(R.string.cancelled_local);
        if (submissionAttempted && jobId == null) {
            return error instanceof RootApi.Failure ? context.getString(R.string.backend_failed) + "\n" + message
                    : context.getString(R.string.submission_unknown, message);
        }
        return hasStaged ? context.getString(R.string.staging_failed, message) : message;
    }
    static JSONArray sharedSources(Intent intent) throws IOException {
        // Only the unexported service accepts these extras; FilesPage never forwards external paths.
        ArrayList<String> sources = intent.getStringArrayListExtra("paths");
        JSONArray paths = new JSONArray();
        if (sources == null) return paths;
        if (sources.size() > 32) throw new IOException("Too many shared files");
        Set<String> seen = new HashSet<>();
        for (String path : sources) {
            if (!Models.sharedPath(path) || !seen.add(path)) throw new IOException("Invalid shared source");
            paths.put(path);
        }
        return paths;
    }
    private void cleanupInterrupted() throws Exception {
        String request = prefs.getString("request", null);
        if (request != null) {
            try { RootApi.json(this, "cancel", request); } catch (Exception ignored) { }
            prefs.edit().remove("request").apply();
        }
        JSONArray old = new JSONArray(prefs.getString("staged", "[]"));
        JSONArray retained = new JSONArray();
        for (int i = 0; i < old.length(); i++) {
            String path = old.getString(i);
            if (path.startsWith(Models.STAGED) && Models.sourcePath(path)) {
                try { RootApi.json(this, "file-stage-delete", path); } catch (Exception ignored) { retained.put(path); }
            }
        }
        SharedPreferences.Editor cleanup = prefs.edit().remove("preparing");
        if (retained.length() == 0) cleanup.remove("staged"); else cleanup.putString("staged", retained.toString());
        cleanup.commit();
    }
    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, ControlActivity.class).putExtra(ControlActivity.DESTINATION, "files").putExtra("history", true).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent cancel = PendingIntent.getService(this, 1, new Intent(this, TransferService.class).setAction(CANCEL), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_tail).setContentTitle(getString(R.string.app_name))
                .setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text)).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(null, getString(R.string.cancel), cancel).build()).build();
    }
    private void publish(String message, Models.Transfer transfer) {
        SharedPreferences.Editor edit = prefs.edit().putString("message", message).putBoolean("busy", true);
        if (transfer != null) edit.putString("snapshot", transfer.json.toString());
        edit.apply();
        main.post(() -> { if (!stopping) getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(message)); });
        sendBroadcast(new Intent(UPDATE).setPackage(getPackageName()));
    }
    private void finish() {
        busy = false; running = false; stopping = true; prefs.edit().putBoolean("busy", false).apply();
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
        sendBroadcast(new Intent(UPDATE).setPackage(getPackageName()));
    }
    @Override public void onTimeout(int startId, int fgsType) {
        stopping = true; running = false;
        prefs.edit().putString("message", getString(R.string.service_timeout)).putBoolean("busy", false).apply();
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
    }
    @Override public void onDestroy() {
        stopping = true; running = false;
        RootApi.Call call = currentCall;
        String request = requestId;
        if (!control.isShutdown()) control.execute(() -> {
            try {
                if (request != null) RootApi.json(this, "cancel", request);
            } catch (Exception ignored) { }
            finally { if (call != null) call.cancel(); }
        });
        worker.shutdown(); control.shutdown();
        prefs.edit().putBoolean("busy", false).apply();
        super.onDestroy();
    }
}
