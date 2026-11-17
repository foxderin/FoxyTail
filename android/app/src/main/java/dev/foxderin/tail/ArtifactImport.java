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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class ArtifactImport {
    enum Kind {
        BACKUP("backup-import", "backup.tar.gz", ".tar.gz", "artifact-stage", 1024 * 1024),
        IDENTITY("identity-import", "foxytail-identity.state", ".state", "identity-stage", IdentityRules.MAX_IMPORT_BYTES);
        final String preferences, fallbackName, extension, command;
        final long limit;
        Kind(String preferences, String fallbackName, String extension, String command, long limit) {
            this.preferences = preferences; this.fallbackName = fallbackName; this.extension = extension; this.command = command; this.limit = limit;
        }
        boolean accepts(String name) { return this == IDENTITY ? IdentityRules.filename(name) : name.endsWith(extension); }
    }
    private static ArtifactImport backup, identity;
    static synchronized ArtifactImport backup(Context context) {
        if (backup == null) backup = new ArtifactImport(context.getApplicationContext(), Kind.BACKUP);
        return backup;
    }
    static synchronized ArtifactImport identity(Context context) {
        if (identity == null) identity = new ArtifactImport(context.getApplicationContext(), Kind.IDENTITY);
        return identity;
    }
    private final Kind kind;
    private final Context context;
    private final SharedPreferences preferences;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ArrayList<Runnable> listeners = new ArrayList<>();
    private boolean busy;
    private String error;
    private ArtifactImport(Context context, Kind kind) {
        this.kind = kind;
        this.context = AppPreferences.localized(context); preferences = context.getSharedPreferences(kind.preferences, Context.MODE_PRIVATE);
        if (kind == Kind.IDENTITY) {
            File[] stale = context.getCacheDir().listFiles((directory, name) -> name.startsWith("identity-import-") && name.endsWith(".state"));
            if (stale != null) for (File file : stale) file.delete();
        }
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
    private void releasePermission(Uri uri) {
        try { context.getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); }
        catch (SecurityException ignored) { }
    }
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
        if (!preferences.edit().putBoolean("pending", true).remove("token").commit()) {
            if (release) releasePermission(uri);
            error = context.getString(R.string.control_record_failed); changed(); return;
        }
        busy = true; error = null; changed();
        io.execute(() -> {
            String token = null; String failure = null;
            File privateCopy = null;
            try {
                String name = kind.fallbackName; long size = -1;
                try (Cursor cursor = context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int n = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME), z = cursor.getColumnIndex(OpenableColumns.SIZE);
                        if (n >= 0 && !cursor.isNull(n)) name = Models.safeName(cursor.getString(n));
                        if (z >= 0 && !cursor.isNull(z)) size = cursor.getLong(z);
                    }
                }
                if (!kind.accepts(name)) throw new IOException(context.getString(kind == Kind.IDENTITY ? R.string.identity_import_type : R.string.control_archive_type));
                if (size > kind.limit) throw new IOException(context.getString(kind == Kind.IDENTITY ? R.string.identity_import_limit : R.string.control_archive_limit));
                JSONObject staged;
                InputStream input = context.getContentResolver().openInputStream(uri);
                if (input == null) throw new IOException(context.getString(R.string.invalid_uri));
                try {
                    if (kind == Kind.IDENTITY) {
                        // Providers may omit SIZE. Bound a binary private copy, then stage its actual length.
                        privateCopy = File.createTempFile("identity-import-", ".state", context.getCacheDir());
                        try (FileOutputStream output = new FileOutputStream(privateCopy)) {
                            size = RootApi.copyWithTimeout(input, output, kind.limit, 120);
                        }
                        try (InputStream stagedInput = new FileInputStream(privateCopy)) {
                            staged = RootApi.json(context, null, stagedInput, null, 120, new RootApi.Call(), kind.command, name, Long.toString(size));
                        }
                    } else {
                        staged = RootApi.json(context, null, input, null, 120, new RootApi.Call(), kind.command, name, Long.toString(size));
                    }
                } finally {
                    // A provider can also block in close; never wait on it after a spool deadline.
                    if (kind == Kind.IDENTITY) RootApi.closeAsync(input);
                    else input.close();
                }
                token = staged.getString("id");
                if (!token.matches("art-[a-f0-9]{32}")) throw new IOException(context.getString(R.string.invalid_response));
                if (!preferences.edit().putString("token", token).remove("pending").commit()) throw new IOException(context.getString(R.string.control_record_failed));
            } catch (Exception e) {
                failure = kind == Kind.IDENTITY ? context.getString(R.string.identity_import_failed) : RootApi.message(e); preferences.edit().remove("pending").commit();
            } finally {
                if (privateCopy != null) privateCopy.delete();
                if (release) releasePermission(uri);
            }
            String resultError = failure;
            main.post(() -> { busy = false; error = resultError; changed(); });
        });
    }
}
