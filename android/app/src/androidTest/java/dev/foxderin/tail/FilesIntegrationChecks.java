package dev.foxderin.tail;

import android.content.*;
import android.net.Uri;
import org.json.*;
import java.io.*;
import java.util.*;

final class FilesIntegrationChecks {
    static void run(Context context) throws Exception {
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
