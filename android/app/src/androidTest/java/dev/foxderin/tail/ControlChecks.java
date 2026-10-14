package dev.foxderin.tail;

import android.content.Context;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

final class ControlChecks {
    static void run(Context context) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bytes.write("{\"ok\":false,\"error\":\"route failed\",\"exitRouting\":{\"effective\":\"not-effective\"}}".getBytes(StandardCharsets.UTF_8));
        try { RootApi.decode(context, bytes, 1); throw new AssertionError("Failure accepted"); }
        catch (RootApi.Failure failure) {
            require(failure.exitCode == 1 && "not-effective".equals(failure.result.getJSONObject("exitRouting").getString("effective")), "Failure preserves actual state");
            transferFeedback(context, failure);
        }
        bytes.reset(); bytes.write("{\"ok\":true}".getBytes(StandardCharsets.UTF_8));
        try { RootApi.decode(context, bytes, 7); throw new AssertionError("Exit code ignored"); }
        catch (RootApi.Failure failure) { require(!failure.result.getBoolean("ok") && failure.exitCode == 7, "Nonzero exit never succeeds"); }
        JSONObject operation = new JSONObject().put("state", "running").put("result", JSONObject.NULL).put("exitCode", JSONObject.NULL);
        require(ControlClient.terminalResult(operation) == null, "Running is not terminal");
        operation.put("state", "completed").put("result", new JSONObject().put("ok", true)).put("exitCode", 0);
        require(ControlClient.terminalResult(operation).getBoolean("ok"), "Confirmed completion");
        operation.put("state", "interrupted");
        require(!ControlClient.terminalResult(operation).getBoolean("ok"), "Interrupted cannot inherit successful output");
        operation.put("state", "completed").put("result", JSONObject.NULL).put("exitCode", 0);
        require(!ControlClient.terminalResult(operation).getBoolean("ok"), "Missing result is not success");
        operation.put("state", "future-state");
        try { ControlClient.terminalResult(operation); throw new AssertionError("Unknown state accepted"); } catch (java.io.IOException expected) { }
        RootApi.Call cancelled = new RootApi.Call(); cancelled.cancel();
        require(cancelled.cancelled.get(), "Unlaunched reads cancel locally");
        cancellation(context);
    }
    private static void transferFeedback(Context context, RootApi.Failure failure) {
        String backend = context.getString(R.string.backend_failed) + "\nroute failed";
        IOException lost = new IOException("connection closed before response");
        IOException invalid = new IOException(context.getString(R.string.invalid_response));
        for (boolean cancelled : new boolean[]{false, true}) {
            for (boolean staged : new boolean[]{false, true}) {
                require(backend.equals(TransferService.failureMessage(context, failure, cancelled, true, null, staged)), "Decoded submission failure stays explicit even after staging or cancellation");
                for (IOException transport : new IOException[]{lost, invalid}) {
                    require(context.getString(R.string.submission_unknown, transport.getMessage()).equals(TransferService.failureMessage(context, transport, cancelled, true, null, staged)), "Lost or invalid submission response stays unknown and retains readable detail");
                }
                require(context.getString(R.string.cancelled_local).equals(TransferService.failureMessage(context, failure, true, false, null, staged)), "Pre-submit local cancellation keeps precedence");
            }
        }
        require(context.getString(R.string.staging_failed, "route failed").equals(TransferService.failureMessage(context, failure, false, false, null, true)), "Pre-submit staged failure remains a preparation failure");
        require(lost.getMessage().equals(TransferService.failureMessage(context, lost, false, false, null, false)), "Unstaged low-level failure remains readable");
        require("route failed".equals(TransferService.failureMessage(context, failure, true, true, "0123456789abcdef", false)), "Known job failure is neither local cancellation nor unknown submission");
    }
    private static void cancellation(Context context) throws Exception {
        ExecutorService worker = Executors.newSingleThreadExecutor();
        CountDownLatch release = new CountDownLatch(1), occupied = new CountDownLatch(1);
        AtomicInteger launches = new AtomicInteger();
        try {
            worker.execute(() -> { occupied.countDown(); try { release.await(); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); } });
            require(occupied.await(2, TimeUnit.SECONDS), "Read worker starts");
            RootApi.Call queued = new RootApi.Call();
            queued.submit(worker, launches::incrementAndGet); queued.cancel();
            release.countDown(); worker.submit(() -> { }).get(2, TimeUnit.SECONDS);
            require(launches.get() == 0 && queued.finished, "Cancelled queued read never starts");
            try {
                queued.launch(context, null, "cancelled", true, builder -> { launches.incrementAndGet(); throw new IOException("must not launch"); });
                throw new AssertionError("Cancelled call launched");
            } catch (InterruptedIOException expected) { require(launches.get() == 0, "Cancellation wins the launch boundary"); }

            RootApi.Call failed = new RootApi.Call();
            try {
                failed.launch(context, null, "failure", true, builder -> { throw new IOException("launch failed"); });
                throw new AssertionError("Launch failure missing");
            } catch (IOException expected) { require(failed.finished && failed.process == null, "Failed launch releases call ownership"); }
            failed.cancel(); require(!failed.cancelled.get(), "Finished launch failure cannot start cancellation work");

            RootApi.Call mutation = new RootApi.Call();
            Process accepted = mutation.launch(context, null, "accepted mutation", false,
                    builder -> new ProcessBuilder("/system/bin/sh", "-c", "sleep 0.1; exit 19").start());
            try {
                mutation.cancel();
                require(!mutation.cancelled.get() && mutation.process == accepted && !mutation.finished, "Accepted mutation stays owned until completion");
                require(accepted.waitFor(2, TimeUnit.SECONDS) && accepted.exitValue() == 19, "Local cancellation never kills an accepted mutation");
            } finally { accepted.destroy(); mutation.finished = true; }

            RootApi.Call read = new RootApi.Call();
            Process reading = read.launch(context, null, "read", true,
                    builder -> new ProcessBuilder("/system/bin/sh", "-c", "exec sleep 30").start());
            try {
                read.cancel();
                require(reading.waitFor(2, TimeUnit.SECONDS) && read.cancelled.get(), "Read-only local cancellation releases the process");
                require(read.process == reading && !read.finished, "Launched read retains ownership until its waiter completes");
            } finally { reading.destroy(); read.finished = true; }
            require(!RootApi.localCancellationAllowed("operation-start") && !RootApi.localCancellationAllowed("login") && !RootApi.localCancellationAllowed("file-send-start"), "Unregistered writes cannot use read cancellation");
        } finally { release.countDown(); worker.shutdownNow(); }
    }
    private static void require(boolean value, String detail) { if (!value) throw new AssertionError(detail); }
}
