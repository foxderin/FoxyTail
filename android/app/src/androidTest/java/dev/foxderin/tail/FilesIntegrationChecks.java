package dev.foxderin.tail;

import android.content.*;
import android.net.Uri;
import org.json.*;
import java.io.*;
import java.util.*;

final class FilesIntegrationChecks {
    static void run(Context context) throws Exception {
        for (int character = 0; character <= 0x9f; character++) {
            if (character > 0x1f && character < 0x7f) continue;
            String name = "file" + (char) character + ".txt";
            reject(() -> Models.requireName(name));
            Models.requireName(Models.safeName(name));
        }
        String longestName = String.join("", Collections.nCopies(255, "a"));
        for (String name : Arrays.asList(null, "", ".", "..", ".taildrop", ".outgoing", "a/b", "a\\b", longestName + "a", "bad\ud800")) reject(() -> Models.requireName(name));
        for (String name : Arrays.asList(".env", "..hidden", "meeting ' * [1].txt", "你好.txt", longestName)) Models.requireName(name);
        Models.requireName(String.join("", Collections.nCopies(85, "界")));
        reject(() -> Models.requireName(String.join("", Collections.nCopies(86, "界"))));
        JSONObject validInboxFile = new JSONObject().put("name", "normal.txt").put("size", 0).put("mtime", 1);
        JSONObject invalidInboxFile = new JSONObject(validInboxFile.toString()).put("name", "tab\tname");
        JSONObject inboxResponse = new JSONObject().put("files", new JSONArray().put(invalidInboxFile).put(validInboxFile).put(new JSONObject(validInboxFile.toString()).put("name", "c1\u0085name"))).put("ignored", 3);
        Models.Inbox parsedInbox = new Models.Inbox(inboxResponse);
        check(parsedInbox.files.length() == 1 && parsedInbox.files.getJSONObject(0).getString("name").equals("normal.txt") && parsedInbox.ignored == 5, "Incompatible entries cannot brick valid inbox files; warning includes backend and consumer counts");
        Models.Inbox legacyInbox = new Models.Inbox(new JSONObject().put("files", new JSONArray().put(validInboxFile).put(invalidInboxFile)));
        check(legacyInbox.files.length() == 1 && legacyInbox.ignored == 1, "Legacy listing remains accessible without weakening filename validation");
        check(invalidInboxFile.getString("name").equals("tab\tname"), "Listing isolation never silently renames incompatible entries");
        reject(() -> new Models.Inbox(new JSONObject(inboxResponse.toString()).put("ignored", -1)));
        reject(() -> new Models.Inbox(new JSONObject(inboxResponse.toString()).put("ignored", 1.5)));
        reject(() -> new Models.Inbox(new JSONObject(inboxResponse.toString()).put("ignored", "3")));
        reject(() -> new Models.Inbox(new JSONObject(inboxResponse.toString()).put("files", "invalid")));
        for (String name : Arrays.asList("tab\tname", "c1\u0085name", "a\\b")) {
            reject(() -> Models.Source.shared("/sdcard/Download/" + name, 0));
            reject(() -> ExportProvider.cache(context, name, output -> { throw new AssertionError("Incompatible name reached exporter"); }));
        }
        check(Models.relativePath("") && Models.relativePath("Download/photos"), "Shared directory roots");
        for (String path : Arrays.asList(null, "/sdcard", "/sdcard/", "/sdcard/../private", "/sdcard//file", "/sdcard/a\\b", "/sdcard/a\n", Models.STAGED + "id/file", "/data/local/tmp/file")) {
            check(!Models.sharedPath(path), "Reject non-shared source " + path);
            reject(() -> TransferService.sharedSources(new Intent().putStringArrayListExtra("paths", new ArrayList<>(Collections.singletonList(path)))));
        }
        Models.Source shared = Models.Source.shared("/sdcard/Download/a file.bin", 0);
        check(shared.uri == null && shared.size == 0 && shared.name.equals("a file.bin") && shared.key().equals(shared.path), "Shared source does not fabricate a content URI");
        reject(() -> Models.Source.shared("/sdcard/large", RootApi.MAX_FILE + 1));
        Intent paths = new Intent().putStringArrayListExtra("paths", new ArrayList<>(Arrays.asList("/sdcard/one", "/sdcard/two")));
        check(TransferService.sharedSources(paths).length() == 2, "Restricted service shared sources");
        check(MainActivity.sharedUris(new Intent(paths).setAction(Intent.ACTION_SEND).putExtra("peer", "external")).isEmpty(), "External root path extras never become sources");
        Uri readable = Uri.parse("content://example.documents/document/one");
        check(MainActivity.sharedUris(new Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, readable)).equals(Collections.singletonList(readable)), "System share URI remains supported");
        Intent clipShare = new Intent(Intent.ACTION_SEND_MULTIPLE);
        clipShare.setClipData(ClipData.newRawUri("file", readable));
        check(MainActivity.sharedUris(clipShare).equals(Collections.singletonList(readable)), "ClipData share fallback remains supported");
        check(MainActivity.sharedUris(new Intent("start").putExtra(Intent.EXTRA_STREAM, readable)).isEmpty(), "Unknown external actions cannot submit transfers");
        reject(() -> TransferService.sharedSources(new Intent().putStringArrayListExtra("paths", new ArrayList<>(Arrays.asList("/sdcard/one", "/sdcard/one")))));
        ArrayList<String> tooMany = new ArrayList<>(); for (int i = 0; i < 33; i++) tooMany.add("/sdcard/file" + i);
        reject(() -> TransferService.sharedSources(new Intent().putStringArrayListExtra("paths", tooMany)));
        JSONObject entry = new JSONObject().put("name", "file.bin").put("path", "/sdcard/Download/file.bin").put("directory", false).put("size", 0).put("mtime", 1);
        JSONObject response = new JSONObject().put("ok", true).put("path", "Download").put("entries", new JSONArray().put(entry)).put("truncated", false);
        check(FilesBrowser.parse(response, "Download").size() == 1, "Valid browse result");
        reject(() -> FilesBrowser.parse(response, "Pictures"));
        reject(() -> FilesBrowser.parse(new JSONObject(response.toString()).put("truncated", "false"), "Download"));
        reject(() -> FilesBrowser.parse(new JSONObject(response.toString()).put("entries", new JSONArray().put(entry).put(entry)), "Download"));
        for (String path : Arrays.asList("/data/private", "/sdcard/Other/file.bin", "/sdcard/Download/../file.bin")) {
            JSONObject badEntry = new JSONObject(entry.toString()).put("path", path);
            reject(() -> FilesBrowser.parse(new JSONObject(response.toString()).put("entries", new JSONArray().put(badEntry)), "Download"));
        }
        JSONArray count = new JSONArray(); for (int i = 0; i < 1001; i++) count.put(entry);
        reject(() -> FilesBrowser.parse(new JSONObject(response.toString()).put("entries", count), "Download"));
        for (String id : Arrays.asList(null, "", "/data/private", "0123456789abcdef0123456789abcdef", "art-../private")) reject(() -> ExportProvider.exportArtifact(context, id, "archive.tar.gz"));
        Set<String> before = exportFiles(context);
        reject(() -> ExportProvider.cache(context, "partial.bin", output -> { output.write(new byte[]{1, 2, 3}); throw new IOException("source failed"); }));
        check(exportFiles(context).equals(before), "Failed read leaves no export or partial file");
        reject(() -> ExportProvider.cache(context, "full.bin", output -> { output.write(1); throw new IOException("No space left on device"); }));
        check(exportFiles(context).equals(before), "Space failure leaves no partial file");
        Uri exported = ExportProvider.cache(context, "zero.bin", output -> { });
        try (InputStream input = context.getContentResolver().openInputStream(exported)) { check(input != null && input.read() == -1, "Explicit successful empty export remains valid"); }
        finally {
            new File(ExportProvider.directory(context), exported.getLastPathSegment()).delete();
            context.getSharedPreferences("exports", Context.MODE_PRIVATE).edit().remove(exported.getLastPathSegment()).commit();
        }
        File destination = File.createTempFile("save-boundary-", ".bin", context.getCacheDir());
        byte[] original = new byte[]{9, 8, 7}, replacement = new byte[]{1, 2, 3, 4};
        try {
            try (OutputStream output = new FileOutputStream(destination)) { output.write(original); }
            Uri target = Uri.fromFile(destination);
            reject(() -> ExportProvider.save(context, "failed.bin", target, output -> { output.write(replacement); throw new IOException("source failed"); }, () -> { throw new AssertionError("Failed source reached commit"); }, null));
            check(Arrays.equals(java.nio.file.Files.readAllBytes(destination.toPath()), original), "Failed source never opens existing destination");
            reject(() -> ExportProvider.save(context, "cancelled.bin", target, output -> output.write(replacement), () -> { throw new InterruptedIOException("Cancelled at commit fence"); }, null));
            check(Arrays.equals(java.nio.file.Files.readAllBytes(destination.toPath()), original), "Cancellation after verified staging leaves existing destination untouched");
            final boolean[] staged = {false}, committed = {false}; final long[] copied = {0};
            ExportProvider.save(context, "success.bin", target, output -> { output.write(replacement); staged[0] = true; }, () -> {
                check(staged[0] && Arrays.equals(java.nio.file.Files.readAllBytes(destination.toPath()), original), "Commit begins only after verified source and before destination opening"); committed[0] = true;
            }, bytes -> copied[0] = bytes);
            check(committed[0] && copied[0] == replacement.length && Arrays.equals(java.nio.file.Files.readAllBytes(destination.toPath()), replacement), "Successful commit preserves full bytes and reports actual progress");
            reject(() -> ExportProvider.save(context, "destination-failure.bin", Uri.fromFile(context.getCacheDir()), output -> output.write(replacement), () -> { }, null));
            check(exportFiles(context).equals(before), "Save success, cancellation and destination failure clean verified staging");
        } finally { destination.delete(); }
        ArrayList<Uri> exports = new ArrayList<>();
        try {
            exports.add(ExportProvider.cache(context, "one.txt", output -> output.write(new byte[]{1, 2})));
            exports.add(ExportProvider.cache(context, "two.png", output -> output.write(new byte[]{3, 4, 5})));
            Intent share = MainActivity.shareIntent(Arrays.asList("one.txt", "two.png"), exports);
            check(Intent.ACTION_SEND_MULTIPLE.equals(share.getAction()) && "*/*".equals(share.getType()), "Mixed types use multi-file sharing without falsely advertising one MIME type");
            check((share.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0 && (share.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == 0, "Shared exports grant only read access");
            ArrayList<Uri> streams = share.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            check(exports.equals(streams) && share.getClipData().getItemCount() == 2, "Every shared stream carries its matching URI grant");
            for (int i = 0; i < exports.size(); i++) {
                check(exports.get(i).equals(share.getClipData().getItemAt(i).getUri()), "Shared ClipData keeps file order");
                try (InputStream input = context.getContentResolver().openInputStream(streams.get(i))) { check(Arrays.equals(input.readAllBytes(), i == 0 ? new byte[]{1, 2} : new byte[]{3, 4, 5}), "Shared stream resolves to the exact selected bytes"); }
            }
            Intent single = MainActivity.shareIntent(Collections.singletonList("one.txt"), new ArrayList<>(Collections.singletonList(exports.get(0))));
            check(Intent.ACTION_SEND.equals(single.getAction()) && "text/plain".equals(single.getType()), "One selection retains ordinary file sharing");
        } finally { for (Uri uri : exports) ExportProvider.discard(context, uri); }
    }
    private static Set<String> exportFiles(Context context) throws Exception {
        ExportProvider.prune(context); String[] files = ExportProvider.directory(context).list();
        if (files == null) throw new IOException("Cannot inspect exports");
        return new HashSet<>(Arrays.asList(files));
    }
    private interface Checked { void run() throws Exception; }
    private static void reject(Checked action) throws Exception {
        try { action.run(); } catch (IOException | JSONException expected) { return; }
        throw new AssertionError("Invalid file input accepted");
    }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
