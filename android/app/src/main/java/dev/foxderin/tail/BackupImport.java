package dev.foxderin.tail;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import org.json.JSONObject;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class BackupImport {
    private static BackupImport instance;
    static synchronized BackupImport get(Context context) {
        if (instance == null) instance = new BackupImport(context.getApplicationContext());
        return instance;
    }
    private final Context context;
    private final SharedPreferences preferences;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ArrayList<Runnable> listeners = new ArrayList<>();
    private boolean busy;
    private String error;
    private BackupImport(Context context) {
        this.context = AppPreferences.localized(context); preferences = context.getSharedPreferences("backup-import", Context.MODE_PRIVATE);
        if (preferences.getBoolean("pending", false)) {
            error = context.getString(R.string.control_import_interrupted);
            preferences.edit().remove("pending").apply();
        }
    }
    void observe(Runnable listener) { if (!listeners.contains(listener)) listeners.add(listener); }
    void remove(Runnable listener) { listeners.remove(listener); }
    boolean busy() { return busy; }
    String error() { return error; }
    String token() { return preferences.getString("token", null); }
    void consume(String token) { if (token.equals(token())) preferences.edit().remove("token").apply(); }
    private void changed() { for (Runnable listener : new ArrayList<>(listeners)) listener.run(); }
    void start(Uri uri, int flags) {
        if (busy) return;
        if (!Models.readableUri(context, uri)) {
            error = context.getString(R.string.invalid_uri); changed(); return;
        }
        boolean persisted = false;
        if ((flags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0) {
            try { context.getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); persisted = true; }
            catch (SecurityException ignored) { }
        }
        final boolean release = persisted;
        if (!preferences.edit().putBoolean("pending", true).remove("token").commit()) { error = context.getString(R.string.control_record_failed); changed(); return; }
        busy = true; error = null; changed();
        io.execute(() -> {
            String token = null; String failure = null;
            try {
                String name = "backup.tar.gz"; long size = -1;
                try (Cursor cursor = context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int n = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME), z = cursor.getColumnIndex(OpenableColumns.SIZE);
                        if (n >= 0 && !cursor.isNull(n)) name = Models.safeName(cursor.getString(n));
                        if (z >= 0 && !cursor.isNull(z)) size = cursor.getLong(z);
                    }
                }
                if (!name.endsWith(".tar.gz")) throw new IOException(context.getString(R.string.control_archive_type));
                if (size > 1024 * 1024) throw new IOException(context.getString(R.string.control_archive_limit));
                JSONObject staged;
                try (InputStream input = context.getContentResolver().openInputStream(uri)) {
                    if (input == null) throw new IOException(context.getString(R.string.invalid_uri));
                    staged = RootApi.json(context, null, input, null, 120, new RootApi.Call(), "artifact-stage", name, Long.toString(size));
                }
                token = staged.getString("id");
                if (!token.matches("art-[a-f0-9]{32}")) throw new IOException(context.getString(R.string.invalid_response));
                if (!preferences.edit().putString("token", token).remove("pending").commit()) throw new IOException(context.getString(R.string.control_record_failed));
            } catch (Exception e) {
                failure = RootApi.message(e); preferences.edit().remove("pending").commit();
            } finally {
                if (release) try { context.getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (SecurityException ignored) { }
            }
            String resultError = failure;
            main.post(() -> { busy = false; error = resultError; changed(); });
        });
    }
}
