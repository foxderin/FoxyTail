package dev.foxderin.tail;

import android.app.Instrumentation;
import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import org.json.*;
import java.io.*;
import java.util.Arrays;

public final class BridgeInstrumentation extends Instrumentation {
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            check("'a'\\'';$(id)'".equals(RootApi.quote("a';$(id)")), "Shell argument quoting");
            check(Models.sourcePath("/sdcard/Download/hello world.txt"), "Shared file accepted");
            check(!Models.sourcePath("/sdcard/../data/file"), "Parent traversal rejected");
            check(!Models.sourcePath("/data/user/0/private"), "Private root source rejected");
            check(!Models.sourcePath(Models.STAGED + "token/a/b"), "Nested stage rejected");
            check(Models.sourcePath(Models.STAGED + "0123456789abcdef0123456789abcdef/a.txt"), "Stage source accepted");
            Models.requireName(Models.safeName("../evil\nname/😀"));
            byte[] bytes = new byte[136536]; for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) i;
            ByteArrayOutputStream copy = new ByteArrayOutputStream();
            check(RootApi.copy(new ByteArrayInputStream(bytes), copy, bytes.length, null, null) == bytes.length && Arrays.equals(bytes, copy.toByteArray()), "Binary copy preserves bytes beyond argument limit");
            check(RootApi.copy(new ByteArrayInputStream(new byte[0]), new ByteArrayOutputStream(), 0, null, null) == 0, "Empty file");
            try { RootApi.copy(new ByteArrayInputStream(bytes), new ByteArrayOutputStream(), 1, null, null); throw new AssertionError("Missing size limit"); } catch (IOException expected) { }
            RootApi.Call cancelled = new RootApi.Call(); cancelled.cancel();
            try { RootApi.copy(new ByteArrayInputStream(bytes), new ByteArrayOutputStream(), bytes.length, null, cancelled); throw new AssertionError("Missing cancellation"); } catch (InterruptedIOException expected) { }
            JSONObject job = new JSONObject().put("id", "0123456789abcdef0123456789abcdef").put("peerId", "n123").put("peerName", "test").put("peerIp", "100.64.0.1").put("selfId", "n456").put("status", "failed").put("startedAt", 1).put("updatedAt", 2);
            JSONArray files = new JSONArray();
            files.put(file("completed", "done", true, 4)); files.put(file("failed", "failed", false, 0)); files.put(file("cancelled", "cancelled", false, 0));
            Models.Transfer transfer = new Models.Transfer(job.put("files", files));
            check(transfer.retryPaths().length() == 2 && !transfer.retryPaths().toString().contains("/done"), "Retry omits successful file");
            check(!transfer.files.get(1).known, "Unknown bytes remain unknown");
            Context context = getTargetContext();
            try { new Models.FileState(file("sending", "bad", true, 5)); throw new AssertionError("Missing progress validation"); } catch (JSONException expected) { }
            Uri traversal = Uri.parse("content://dev.foxderin.tail.files/../secret");
            try { context.getContentResolver().openFileDescriptor(traversal, "r"); throw new AssertionError("Provider path accepted"); } catch (FileNotFoundException | IllegalArgumentException | SecurityException expected) { }
            Uri token = Uri.parse("content://dev.foxderin.tail.files/0123456789abcdef0123456789abcdef");
            try { context.getContentResolver().openFileDescriptor(token, "w"); throw new AssertionError("Provider writable"); } catch (FileNotFoundException | SecurityException expected) { }
            result.putString("stream", "PASS: quoting, path validation, binary streaming, limits, cancellation, retry, unknown progress and read-only provider\n");
            finish(-1, result);
        } catch (Throwable error) {
            result.putString("stream", "FAIL: " + error + "\n"); finish(1, result);
        }
    }
    private static JSONObject file(String state, String name, boolean known, long sent) throws JSONException {
        return new JSONObject().put("id", "fedcba9876543210fedcba9876543210").put("name", name).put("path", "/sdcard/" + name).put("status", state).put("size", 4).put("sentBytes", sent).put("bytesPerSecond", 0).put("progressKnown", known);
    }
    private static void check(boolean success, String message) { if (!success) throw new AssertionError(message); }
}
