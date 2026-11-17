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
        for (String version : new String[]{null, "", "108.0.5359.128", "invalid", "-1.0"})
            require(!ControlActivity.supportedWebViewVersion(version), "Unsupported WebView fails before mounting the bundle");
        for (String version : new String[]{"109.0.5414.0", "130.0.6723.1"})
            require(ControlActivity.supportedWebViewVersion(version), "Supported WebView can mount the ES2022 bundle");
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
        operation.put("state", "cancelled").put("result", new JSONObject().put("ok", false).put("error", "cancelled at backend")).put("exitCode", 130);
        JSONObject cancelledResult = ControlClient.terminalResult(operation);
        require(!cancelledResult.getBoolean("ok") && cancelledResult.getBoolean("cancelled") && "cancelled at backend".equals(cancelledResult.getString("error")), "Cancelled receipts preserve cancellation and backend detail for frontend task state");
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
            // Use the same timeout callback as execute, with a provider blocked
            // before its next byte and a real subprocess waiting on stdin.
            RootApi.Call importing = new RootApi.Call();
            CountDownLatch providerRead = new CountDownLatch(1), providerClosed = new CountDownLatch(1);
            java.io.PipedInputStream provider = new java.io.PipedInputStream() {
                @Override public synchronized int read(byte[] bytes, int offset, int length) throws IOException {
                    providerRead.countDown(); return super.read(bytes, offset, length);
                }
                @Override public void close() throws IOException { try { super.close(); } finally { providerClosed.countDown(); } }
            };
            java.io.PipedOutputStream providerWriter = new java.io.PipedOutputStream(provider);
            java.util.concurrent.ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
            Process staging = importing.launch(context, null, "artifact-stage",
                    RootApi.localCancellationAllowed("artifact-stage"),
                    builder -> new ProcessBuilder("/system/bin/sh", "-c", "exec cat >/dev/null").start());
            importing.source = provider;
            java.util.concurrent.Future<?> copy = worker.submit(() -> {
                try (java.io.OutputStream stdin = staging.getOutputStream()) {
                    RootApi.copy(provider, stdin, RootApi.MAX_FILE, null, importing);
                } catch (IOException expected) { }
            });
            try {
                require(providerRead.await(2, TimeUnit.SECONDS), "Provider copy reached its blocking read");
                timer.schedule(() -> { importing.timedOut = true; importing.cancel(); }, 50, TimeUnit.MILLISECONDS);
                require(staging.waitFor(2, TimeUnit.SECONDS) && importing.cancelled.get() && importing.timedOut,
                        "Backup import timeout terminates the stdin consumer without a request ID");
                require(providerClosed.await(2, TimeUnit.SECONDS), "Timeout closes the provider source");
                // End the synthetic provider too: Android providers may not unblock
                // an outstanding read when another thread closes their stream.
                providerWriter.close();
                copy.get(2, TimeUnit.SECONDS);
            } finally {
                timer.shutdownNow(); providerWriter.close(); provider.close(); staging.destroy(); importing.finished = true;
            }
            CountDownLatch spoolClosed = new CountDownLatch(1);
            java.io.InputStream stalled = new java.io.InputStream() {
                @Override public int read() throws IOException {
                    try { spoolClosed.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    throw new IOException("Synthetic provider closed");
                }
                @Override public void close() { spoolClosed.countDown(); }
            };
            long spoolStart = System.nanoTime();
            try {
                RootApi.copyWithTimeout(stalled, new java.io.ByteArrayOutputStream(), IdentityRules.MAX_IMPORT_BYTES, 1);
                throw new AssertionError("Stalled identity source must time out before staging");
            } catch (java.io.InterruptedIOException expected) {
                require(TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - spoolStart) < 5, "Identity spool wait is bounded");
                require(spoolClosed.await(2, TimeUnit.SECONDS), "Identity spool timeout closes the source");
            } finally { stalled.close(); }
            CountDownLatch closeStarted = new CountDownLatch(1), closeRelease = new CountDownLatch(1);
            java.io.InputStream blockingClose = new java.io.InputStream() {
                @Override public int read() throws IOException {
                    try { closeRelease.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    throw new IOException("Synthetic provider stopped");
                }
                @Override public void close() {
                    closeStarted.countDown();
                    try { closeRelease.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                }
            };
            try {
                RootApi.copyWithTimeout(blockingClose, new java.io.ByteArrayOutputStream(), IdentityRules.MAX_IMPORT_BYTES, 1);
                throw new AssertionError("Blocking provider close must not hold the spool caller");
            } catch (java.io.InterruptedIOException expected) {
                require(closeStarted.await(2, TimeUnit.SECONDS), "Provider close executes outside spool caller");
            } finally { closeRelease.countDown(); }
            require(RootApi.localCancellationAllowed("identity-stage"), "Private identity staging supports local cancellation before restore");
            require(!RootApi.localCancellationAllowed("operation-start") && !RootApi.localCancellationAllowed("login") && !RootApi.localCancellationAllowed("file-send-start"), "Unregistered writes cannot use read cancellation");
        } finally { release.countDown(); worker.shutdownNow(); }
    }
    private static void require(boolean value, String detail) { if (!value) throw new AssertionError(detail); }
}
