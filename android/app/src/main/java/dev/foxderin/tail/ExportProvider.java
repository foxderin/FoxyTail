package dev.foxderin.tail;

import android.content.*;
import android.database.*;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.system.*;
import android.webkit.MimeTypeMap;
import java.io.*;
import java.util.*;

public final class ExportProvider extends ContentProvider {
    static final String AUTHORITY = "dev.foxderin.tail.files";
    static final long LIFETIME = 24 * 60 * 60 * 1000L;
    static File directory(Context context) throws IOException {
        File directory = new File(context.getCacheDir(), "exports");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException(context.getString(R.string.export_failed));
        return directory;
    }
    static Uri export(Context context, String name, RootApi.Progress progress, RootApi.Call call) throws Exception {
        return cache(context, name, output -> RootApi.readInbox(context, name, output, progress, call));
    }
    static Uri exportArtifact(Context context, String id, String displayName) throws Exception {
        if (id == null || !id.matches("art-[a-f0-9]{32}")) throw new IOException("Invalid artifact token");
        return cache(context, displayName, output -> RootApi.readArtifact(context, id, output));
    }
    interface Writer { void write(OutputStream output) throws Exception; }
    interface Commit { void begin() throws Exception; }
    static void save(Context context, String name, Uri target, Writer source, Commit commit, RootApi.Progress progress) throws Exception {
        Uri staged = cache(context, name, source);
        try {
            try (InputStream input = context.getContentResolver().openInputStream(staged)) {
                if (input == null) throw new IOException(context.getString(R.string.export_failed));
                // Verified staging and the UI cancellation fence both precede any destination write.
                commit.begin();
                try (OutputStream output = context.getContentResolver().openOutputStream(target, "wt")) {
                    if (output == null) throw new IOException(context.getString(R.string.export_failed));
                    RootApi.copy(input, output, RootApi.MAX_FILE, progress, null);
                }
            }
        } finally { discard(context, staged); }
    }
    static void discard(Context context, Uri staged) throws IOException {
        if (!AUTHORITY.equals(staged.getAuthority()) || staged.getPathSegments().size() != 1 || !staged.getLastPathSegment().matches("[a-f0-9]{32}")) throw new IOException("Invalid export URI");
        File file = new File(directory(context), staged.getLastPathSegment());
        if (file.delete()) context.getSharedPreferences("exports", Context.MODE_PRIVATE).edit().remove(file.getName()).apply();
    }
    static Uri cache(Context context, String name, Writer writer) throws Exception {
        Models.requireName(name);
        File directory = directory(context);
        prune(context);
        String token = UUID.randomUUID().toString().replace("-", "");
        File partial = new File(directory, token + ".partial"), ready = new File(directory, token);
        boolean published = false;
        try {
            try (OutputStream output = new FileOutputStream(partial)) { writer.write(output); }
            if (!partial.renameTo(ready)) throw new IOException(context.getString(R.string.export_failed));
            if (!context.getSharedPreferences("exports", Context.MODE_PRIVATE).edit().putString(token, name).commit()) throw new IOException(context.getString(R.string.export_failed));
            published = true;
            return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(token).build();
        } finally { partial.delete(); if (!published) ready.delete(); }
    }
    static void prune(Context context) throws IOException {
        File[] files = directory(context).listFiles();
        if (files == null) return;
        SharedPreferences.Editor metadata = context.getSharedPreferences("exports", Context.MODE_PRIVATE).edit();
        long cutoff = System.currentTimeMillis() - LIFETIME;
        for (File file : files) if (file.lastModified() < cutoff && file.delete()) metadata.remove(file.getName());
        metadata.apply();
    }
    private File resolve(Uri uri) throws FileNotFoundException {
        if (!"content".equals(uri.getScheme()) || !AUTHORITY.equals(uri.getAuthority()) || uri.getPathSegments().size() != 1 || uri.getQuery() != null || uri.getFragment() != null) throw new FileNotFoundException("Invalid export URI");
        String token = uri.getLastPathSegment();
        if (token == null || !token.matches("[a-f0-9]{32}")) throw new FileNotFoundException("Invalid export token");
        try {
            File file = new File(directory(getContext()), token);
            StructStat stat = Os.lstat(file.getAbsolutePath());
            if (!OsConstants.S_ISREG(stat.st_mode) || file.lastModified() < System.currentTimeMillis() - LIFETIME) throw new FileNotFoundException("Export expired; open the inbox file again");
            return file;
        } catch (IOException | ErrnoException e) { throw new FileNotFoundException(e.getMessage()); }
    }
    @Override public boolean onCreate() { return true; }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Read-only provider");
        File file = resolve(uri);
        try {
            StructStat entry = Os.lstat(file.getAbsolutePath());
            try (FileInputStream input = new FileInputStream(file)) {
                StructStat opened = Os.fstat(input.getFD());
                if (!OsConstants.S_ISREG(entry.st_mode) || !OsConstants.S_ISREG(opened.st_mode) ||
                        entry.st_dev != opened.st_dev || entry.st_ino != opened.st_ino) {
                    throw new FileNotFoundException("Export changed while opening");
                }
                return ParcelFileDescriptor.dup(input.getFD());
            }
        } catch (IOException | ErrnoException e) { throw new FileNotFoundException(e.getMessage()); }
    }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        File file;
        try { file = resolve(uri); } catch (FileNotFoundException e) { throw new IllegalArgumentException(e); }
        String[] columns = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        Object[] row = new Object[columns.length];
        String name = getContext().getSharedPreferences("exports", Context.MODE_PRIVATE).getString(file.getName(), "file");
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) row[i] = name;
            else if (OpenableColumns.SIZE.equals(columns[i])) row[i] = file.length();
        }
        cursor.addRow(row); return cursor;
    }
    @Override public String getType(Uri uri) {
        try {
            File file = resolve(uri);
            return mime(getContext().getSharedPreferences("exports", Context.MODE_PRIVATE).getString(file.getName(), "file"));
        } catch (FileNotFoundException e) { return "application/octet-stream"; }
    }
    static String mime(String name) {
        int dot = name.lastIndexOf('.');
        String type = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
        return type == null ? "application/octet-stream" : type;
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException("Read only"); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException("Read only"); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException("Read only"); }
}
