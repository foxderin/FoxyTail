package dev.foxderin.tail;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import org.json.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;

final class Models {
    static final String STAGED = "/data/adb/foxytail/files/.outgoing/";
    static final Set<String> STATES = new HashSet<>(Arrays.asList("queued", "sending", "completed", "failed", "cancelled", "interrupted"));
    static boolean active(String status) { return status.equals("queued") || status.equals("sending"); }
    static String required(JSONObject object, String key) throws JSONException {
        Object value = object.get(key);
        if (!(value instanceof String) || ((String) value).isEmpty() || ((String) value).length() > 4096) throw new JSONException("Invalid " + key);
        return (String) value;
    }
    static long number(JSONObject object, String key) throws JSONException {
        Object value = object.get(key);
        if (!(value instanceof Number) || ((Number) value).doubleValue() < 0 || !Double.isFinite(((Number) value).doubleValue())) throw new JSONException("Invalid " + key);
        return ((Number) value).longValue();
    }
    static String id(JSONObject object, String key) throws JSONException {
        String value = required(object, key);
        if (!value.matches("[a-fA-F0-9]{16,128}")) throw new JSONException("Invalid " + key);
        return value;
    }
    static void requireName(String name) throws IOException {
        if (name == null || name.isEmpty() || name.getBytes(StandardCharsets.UTF_8).length > 255 || name.equals(".") || name.equals("..") || name.equals(".taildrop") || name.equals(".outgoing") || name.contains("/") || name.contains("\\") || name.codePoints().anyMatch(c -> Character.isISOControl(c) || c >= 0xd800 && c <= 0xdfff)) throw new IOException("Invalid file name");
    }
    static boolean sourcePath(String path) {
        if (path == null || !(path.startsWith("/sdcard/") || path.startsWith(STAGED)) || path.length() > 4096 || path.contains("\\") || path.codePoints().anyMatch(Character::isISOControl)) return false;
        for (String part : path.substring(1).split("/", -1)) if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        return !path.startsWith(STAGED) || path.substring(STAGED.length()).matches("[a-zA-Z0-9_-]+/[^/]+");
    }
    static boolean sharedPath(String path) { return sourcePath(path) && path.startsWith("/sdcard/"); }
    static boolean relativePath(String path) { return path != null && (path.isEmpty() || sharedPath("/sdcard/" + path)); }
    static String safeName(String name) {
        String value = name == null ? "file" : name.replaceAll("[\\x00-\\x1f\\x7f-\\x9f/\\\\]", "_").trim();
        while (value.getBytes(StandardCharsets.UTF_8).length > 120) value = value.substring(0, value.offsetByCodePoints(value.length(), -1));
        if (value.isEmpty() || value.equals(".") || value.equals("..") || value.equals(".outgoing") || value.equals(".taildrop") || value.equals(".lease") || value.equals(".data")) value = "file";
        return value;
    }
    static final class Source {
        final Uri uri; final String path, name; final long size;
        Source(Uri uri, String name, long size) { this.uri = uri; this.path = null; this.name = name; this.size = size; }
        private Source(String path, String name, long size) { this.uri = null; this.path = path; this.name = name; this.size = size; }
        static Source shared(String path, long size) throws IOException {
            if (!sharedPath(path) || size < 0 || size > RootApi.MAX_FILE) throw new IOException("Invalid shared file");
            String name = path.substring(path.lastIndexOf('/') + 1); requireName(name);
            return new Source(path, name, size);
        }
        String key() { return path == null ? uri.toString() : path; }
        static Source resolve(Context context, Uri uri) throws Exception {
            if (uri == null || !"content".equals(uri.getScheme())) throw new IOException(context.getString(R.string.invalid_uri));
            String name = "file"; long size = -1;
            try (Cursor cursor = context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int n = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME), s = cursor.getColumnIndex(OpenableColumns.SIZE);
                    if (n >= 0 && !cursor.isNull(n)) name = cursor.getString(n);
                    if (s >= 0 && !cursor.isNull(s)) size = cursor.getLong(s);
                }
            }
            if (size > RootApi.MAX_FILE || size < -1) throw new IOException(context.getString(R.string.file_limit));
            return new Source(uri, safeName(name), size);
        }
    }
    static final class Inbox {
        final JSONArray files = new JSONArray();
        final int ignored;
        Inbox(JSONObject response) throws JSONException {
            JSONArray entries = response.getJSONArray("files");
            if (entries.length() > 10000) throw new JSONException("Invalid inbox count");
            Object count = response.opt("ignored");
            int skipped = 0;
            if (count != null) {
                if (!(count instanceof Number) || ((Number) count).doubleValue() < 0 || ((Number) count).doubleValue() > Integer.MAX_VALUE - entries.length() || ((Number) count).doubleValue() != ((Number) count).intValue()) throw new JSONException("Invalid ignored count");
                skipped = ((Number) count).intValue();
            }
            for (int i = 0; i < entries.length(); i++) {
                try {
                    JSONObject item = entries.getJSONObject(i);
                    requireName(required(item, "name")); number(item, "size"); number(item, "mtime");
                    files.put(item);
                } catch (IOException | JSONException incompatible) { skipped++; }
            }
            ignored = skipped;
        }
    }
    static final class Peer {
        final String id, name, ip; final boolean online;
        Peer(JSONObject object) throws JSONException {
            id = required(object, "id"); name = required(object, "hostname");
            JSONArray ips = object.getJSONArray("ips");
            if (ips.length() == 0) throw new JSONException("Missing peer address");
            ip = ips.getString(0);
            if (!ip.matches("[0-9a-fA-F:.]+")) throw new JSONException("Invalid address");
            if (!(object.get("online") instanceof Boolean)) throw new JSONException("Invalid online state");
            online = object.getBoolean("online");
        }
    }
    static final class FileState {
        final String id, name, path, status, error; final long size, sent, speed; final boolean known;
        FileState(JSONObject object) throws Exception {
            id = Models.id(object, "id"); name = required(object, "name"); requireName(name);
            path = required(object, "path"); if (!sourcePath(path)) throw new JSONException("Invalid source path");
            status = required(object, "status"); if (!STATES.contains(status) || status.equals("interrupted")) throw new JSONException("Invalid file state");
            size = number(object, "size"); sent = number(object, "sentBytes"); speed = number(object, "bytesPerSecond");
            if (sent > size || !(object.get("progressKnown") instanceof Boolean)) throw new JSONException("Invalid progress");
            known = object.getBoolean("progressKnown"); error = object.optString("error", "");
        }
    }
    static final class Transfer {
        final JSONObject json; final String id, peerId, peerName, peerIp, status, error; final long started;
        final List<FileState> files = new ArrayList<>();
        Transfer(JSONObject object) throws Exception {
            json = object; id = Models.id(object, "id"); peerId = required(object, "peerId"); peerName = required(object, "peerName"); peerIp = required(object, "peerIp");
            required(object, "selfId"); status = required(object, "status");
            if (!STATES.contains(status)) throw new JSONException("Invalid transfer state");
            started = number(object, "startedAt"); number(object, "updatedAt"); error = object.optString("error", "");
            JSONArray array = object.getJSONArray("files");
            if (array.length() == 0 || array.length() > 32) throw new JSONException("Invalid file count");
            for (int i = 0; i < array.length(); i++) files.add(new FileState(array.getJSONObject(i)));
        }
        JSONArray retryPaths() {
            JSONArray paths = new JSONArray();
            if (!active(status)) for (FileState file : files) if (file.status.equals("failed") || file.status.equals("cancelled")) paths.put(file.path);
            return paths;
        }
    }
    static String state(Context context, String state) {
        return context.getString(switch (state) {
            case "queued" -> R.string.queued; case "sending" -> R.string.sending;
            case "completed" -> R.string.completed; case "failed" -> R.string.failed;
            case "cancelled" -> R.string.cancelled; default -> R.string.interrupted;
        });
    }
    static String bytes(Context context, long size) { return WebFormat.bytes(size); }
    static String progress(Context context, FileState file) {
        if (!file.known) return context.getString(active(file.status) ? R.string.waiting : R.string.progress_unavailable);
        return context.getString(R.string.known_progress, bytes(context, file.sent), bytes(context, file.size), bytes(context, file.speed));
    }
}
