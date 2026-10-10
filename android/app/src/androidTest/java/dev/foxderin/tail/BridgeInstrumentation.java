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
            Context context = getTargetContext();
            int[] starts = {0};
            String command = "literal command containing ' quotes and $()";
            Process denied = RootApi.startRoot(context, command, builder -> {
                starts[0]++;
                check(Arrays.asList("/system/bin/su", "/system/xbin/su", "/sbin/su", "/debug_ramdisk/su").contains(builder.command().get(0)), "Trusted absolute su path");
                check(builder.command().size() == 3 && "-c".equals(builder.command().get(1)) && command.equals(builder.command().get(2)), "Root command stays one argument");
                return new ProcessBuilder("/system/bin/sh", "-c", "exit 7").start();
            });
            try { check(denied.waitFor() == 7 && starts[0] == 1, "No retry after a spawned command fails"); }
            finally { denied.destroy(); }
            starts[0] = 0;
            IOException missing = new IOException("error=2, No such file\n\u202e");
            try {
                RootApi.startRoot(context, command, builder -> { starts[0]++; throw new IOException("command must not be disclosed", missing); });
                throw new AssertionError("Missing launch error");
            } catch (IOException expected) {
                check(starts[0] == 1 && expected.getMessage().contains(context.getString(R.string.root_unavailable)) && expected.getMessage().contains("error=2") && !expected.getMessage().contains("command must not be disclosed"), "Spawn failure retains reason without retry or command leak");
            }
            check("error=2, No such file  ".equals(RootApi.launchDetail(missing)), "Launch diagnostic strips control and bidi characters");
            check(RootApi.failureMessage("FOXYTAIL_ROOT_DENIED") == R.string.root_denied, "Non-root UID classified");
            check(RootApi.failureMessage("FOXYTAIL_MODULE_MISSING") == R.string.module_missing, "Missing module classified");
            check(RootApi.failureMessage("FOXYTAIL_ROOT_READY\nhelper failed") == R.string.backend_failed, "Backend failure is not root denial");
            check(RootApi.failureMessage("su: denied") == R.string.root_failed, "Missing handshake is not backend success");
            check(RootApi.failureMessage("prefix FOXYTAIL_ROOT_READY") == R.string.root_failed, "Handshake requires exact line");
            check(MainActivity.targetPlaceholder(false, false) != MainActivity.targetPlaceholder(true, false), "Unknown targets are not empty targets");
            check(MainActivity.targetPlaceholder(false, true) == R.string.targets_failed && MainActivity.targetPlaceholder(true, true) == R.string.targets_failed, "Target failure takes precedence over stale state");
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
            try { new Models.FileState(file("sending", "bad", true, 5)); throw new AssertionError("Missing progress validation"); } catch (JSONException expected) { }
            Uri traversal = Uri.parse("content://dev.foxderin.tail.files/../secret");
            try { context.getContentResolver().openFileDescriptor(traversal, "r"); throw new AssertionError("Provider path accepted"); } catch (FileNotFoundException | IllegalArgumentException | SecurityException expected) { }
            Uri token = Uri.parse("content://dev.foxderin.tail.files/0123456789abcdef0123456789abcdef");
            try { context.getContentResolver().openFileDescriptor(token, "w"); throw new AssertionError("Provider writable"); } catch (FileNotFoundException | SecurityException expected) { }
            ControlChecks.run(context);
            FilesIntegrationChecks.run(context);
            NetworkChecks.run();
            ToolsLogicTests.run();
            ToolsPagesChecks.run();
            AccountServeChecks.run();
            ConfigPageChecks.run();
            ShellStateChecks.run(this);
            java.util.concurrent.atomic.AtomicReference<Throwable> uiFailure = new java.util.concurrent.atomic.AtomicReference<>();
            runOnMainSync(() -> {
                try { TrafficChecks.run(context); } catch (Throwable error) { uiFailure.set(error); }
            });
            if (uiFailure.get() != null) throw new AssertionError("Traffic interaction regression", uiFailure.get());
            result.putString("stream", "PASS: root control receipts and failures, network and tool contracts, Taildrop boundaries, binary streaming, cancellation and read-only exports\n");
            finish(-1, result);
        } catch (Throwable error) {
            java.io.StringWriter trace = new java.io.StringWriter(); error.printStackTrace(new java.io.PrintWriter(trace));
            result.putString("stream", "FAIL: " + trace + "\n"); finish(1, result);
        }
    }
    private static JSONObject file(String state, String name, boolean known, long sent) throws JSONException {
        return new JSONObject().put("id", "fedcba9876543210fedcba9876543210").put("name", name).put("path", "/sdcard/" + name).put("status", state).put("size", 4).put("sentBytes", sent).put("bytesPerSecond", 0).put("progressKnown", known);
    }
    private static void check(boolean success, String message) { if (!success) throw new AssertionError(message); }
}
