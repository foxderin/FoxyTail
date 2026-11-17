package dev.foxderin.tail;

import android.content.Context;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

final class RootApi {
    static final long MAX_FILE = 2L * 1024 * 1024 * 1024;
    private static final String SCRIPT = "/data/adb/foxytail/scripts/foxytail.webapi.sh";
    private static final ExecutorService IO = Executors.newCachedThreadPool();
    private static final ScheduledExecutorService CLOCK = Executors.newScheduledThreadPool(1);
    private static final String[] SU_PATHS = {"/system/bin/su", "/system/xbin/su", "/sbin/su", "/debug_ramdisk/su"};
    interface ProcessStarter { Process start(ProcessBuilder builder) throws IOException; }
    static Process startRoot(Context context, String command, ProcessStarter starter) throws IOException {
        String executable = SU_PATHS[0];
        for (String path : SU_PATHS) {
            if (new File(path).canExecute()) { executable = path; break; }
        }
        // KernelSU may intercept this absolute exec even when stat cannot see su.
        try { return starter.start(new ProcessBuilder(executable, "-c", command)); }
        catch (IOException e) { throw new IOException(context.getString(R.string.root_unavailable) + "\n" + executable + ": " + launchDetail(e), e); }
    }
    static String launchDetail(IOException error) {
        Throwable cause = error;
        while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
        String value = cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage();
        StringBuilder clean = new StringBuilder();
        for (int i = 0; i < value.length() && clean.length() < 160; i++) {
            char c = value.charAt(i);
            clean.append(Character.isISOControl(c) || Character.getType(c) == Character.FORMAT ? ' ' : c);
        }
        return clean.toString();
    }
    static int failureMessage(String errors) {
        boolean root = false;
        for (String line : errors.split("\n")) {
            if (line.equals("FOXYTAIL_ROOT_DENIED")) return R.string.root_denied;
            if (line.equals("FOXYTAIL_MODULE_MISSING")) return R.string.module_missing;
            if (line.equals("FOXYTAIL_ROOT_READY")) root = true;
        }
        return root ? R.string.backend_failed : R.string.root_failed;
    }
    static final class Failure extends IOException {
        final JSONObject result;
        final int exitCode;
        Failure(JSONObject result, int exitCode, String message) {
            super(message); this.result = result; this.exitCode = exitCode;
        }
    }
    interface Progress { void copied(long bytes); }
    static final class Call {
        volatile Process process;
        volatile InputStream source;
        volatile Context context;
        volatile String request;
        volatile boolean finished, timedOut;
        volatile String cancellationError;
        final AtomicBoolean cancelled = new AtomicBoolean();
        private final AtomicBoolean cancelling = new AtomicBoolean();
        private boolean started, localCancellation;
        private FutureTask<Void> queued;
        synchronized void submit(ExecutorService executor, Runnable action) {
            if (cancelled.get()) return;
            queued = new FutureTask<>(action, null);
            executor.execute(queued);
        }
        synchronized void begin(Context context, String request) throws InterruptedIOException {
            if (cancelled.get()) throw new InterruptedIOException(context.getString(R.string.cancelled));
            this.context = context.getApplicationContext(); this.request = request; started = true;
            queued = null;
        }
        Process launch(Context context, String request, String command, boolean localCancellation, ProcessStarter starter) throws IOException {
            this.localCancellation = localCancellation;
            begin(context, request);
            try {
                Process launched = startRoot(context, command, starter);
                process = launched;
                if (cancelled.get()) launched.destroy();
                return launched;
            } catch (IOException | RuntimeException failure) { finished = true; throw failure; }
        }
        void cancel() {
            synchronized (this) {
                if (finished) return;
                if (!started) {
                    cancelled.set(true); finished = true;
                    if (queued != null) { queued.cancel(false); queued = null; }
                    return;
                }
            }
            if (request == null || context == null) {
                if (localCancellation) IO.execute(this::stop);
                return;
            }
            if (!cancelling.compareAndSet(false, true)) return;
            IO.execute(() -> {
                try {
                    JSONObject result = json(context, null, null, null, 12, new Call(), "cancel", request);
                    if (result.optBoolean("cancelled") && !finished) stop();
                } catch (Exception e) { cancellationError = message(e); }
                finally { cancelling.set(false); }
            });
        }
        private void stop() {
            cancelled.set(true);
            Process p = process;
            if (p != null) p.destroy();
            InputStream input = source;
            if (input != null) closeAsync(input);
        }
    }
    static String quote(String value) { return "'" + value.replace("'", "'\\''") + "'"; }
    static String requestId() { return (System.currentTimeMillis() / 1000) + "_" + java.util.UUID.randomUUID().toString().replace("-", ""); }
    static JSONObject json(Context context, String... args) throws Exception {
        return json(context, null, null, null, 90, new Call(), args);
    }
    static JSONObject json(Context context, String request, InputStream source, Progress progress, int seconds, Call call, String... args) throws Exception {
        context = AppPreferences.localized(context);
        ByteArrayOutputStream response = new ByteArrayOutputStream();
        execute(context, request, source, response, 4 * 1024 * 1024, progress, seconds, call, args);
        return decode(context, response, 0);
    }
    static JSONObject decode(Context context, ByteArrayOutputStream response, int exitCode) throws IOException {
        try {
            JSONObject value = new JSONObject(response.toString(StandardCharsets.UTF_8.name()));
            if (!value.has("ok") || !(value.get("ok") instanceof Boolean)) throw new IOException(context.getString(R.string.invalid_response));
            if (exitCode != 0 || !value.getBoolean("ok")) {
                value.put("ok", false);
                throw new Failure(value, exitCode, value.optString("error", context.getString(R.string.backend_failed)));
            }
            return value;
        } catch (org.json.JSONException e) { throw new IOException(context.getString(R.string.invalid_response), e); }
    }
    static void readArtifact(Context context, String id, OutputStream destination) throws Exception {
        readArtifact(context, id, destination, null, new Call());
    }
    static void readArtifact(Context context, String id, OutputStream destination, Progress progress, Call call) throws Exception {
        readArtifact(context, id, destination, progress, call, false);
    }
    static void readArtifact(Context context, String id, OutputStream destination, Progress progress, Call call, boolean share) throws Exception {
        context = AppPreferences.localized(context);
        if (id == null || !id.matches("art-[a-f0-9]{32}")) throw new IOException(context.getString(R.string.invalid_response));
        execute(context, null, null, destination, MAX_FILE, progress, 1800, call, "artifact-read", id, share ? "share" : "save");
    }
    static void readInbox(Context context, String name, OutputStream destination) throws Exception {
        readInbox(context, name, destination, null, new Call());
    }
    static void readInbox(Context context, String name, OutputStream destination, Progress progress, Call call) throws Exception {
        context = AppPreferences.localized(context);
        Models.requireName(name);
        execute(context, null, null, destination, MAX_FILE, progress, 1800, call, "file-read", name);
    }
    private static void execute(Context context, String request, InputStream input, OutputStream output, long outputLimit, Progress progress, int seconds, Call call, String... args) throws Exception {
        StringBuilder command = new StringBuilder("if [ \"$(/system/bin/id -u)\" != 0 ]; then echo FOXYTAIL_ROOT_DENIED >&2; exit 77; fi; if [ ! -f ").append(quote(SCRIPT)).append(" ] || [ ! -r ").append(quote(SCRIPT)).append(" ]; then echo FOXYTAIL_MODULE_MISSING >&2; exit 72; fi; echo FOXYTAIL_ROOT_READY >&2; exec /system/bin/sh ").append(quote(SCRIPT));
        if (request != null) command.append(" --request-id ").append(quote(request));
        for (String arg : args) {
            if (arg == null || arg.indexOf('\0') >= 0) throw new IOException(context.getString(R.string.invalid_response));
            command.append(' ').append(quote(arg));
        }
        boolean localCancellation = args.length > 0 && localCancellationAllowed(args[0]);
        Process process = call.launch(context, request, command.toString(), localCancellation, ProcessBuilder::start);
        call.source = input;
        ScheduledFuture<?> timer = CLOCK.schedule(() -> { call.timedOut = true; call.cancel(); }, seconds, TimeUnit.SECONDS);
        Future<String> stderr = IO.submit(() -> {
            ByteArrayOutputStream kept = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            try (InputStream err = process.getErrorStream()) {
                int n;
                while ((n = err.read(buf)) != -1) if (kept.size() < 65536) kept.write(buf, 0, Math.min(n, 65536 - kept.size()));
            }
            return kept.toString(StandardCharsets.UTF_8.name());
        });
        Future<?> writer = IO.submit(() -> {
            try (OutputStream stdin = process.getOutputStream()) {
                if (input != null) copy(input, stdin, MAX_FILE, progress, call);
            }
            return null;
        });
        Exception readFailure = null;
        try {
            if (call.cancelled.get()) process.destroy();
            try (InputStream stdout = process.getInputStream()) { copy(stdout, output, outputLimit, input == null ? progress : null, call); }
            catch (Exception e) { readFailure = e; process.destroy(); }
            int exit = process.waitFor();
            String errors = stderr.get(5, TimeUnit.SECONDS).trim();
            if (call.cancelled.get()) throw new InterruptedIOException(context.getString(call.timedOut ? R.string.timeout : R.string.cancelled));
            int failure = failureMessage(errors);
            if (exit != 0 || failure != R.string.backend_failed) {
                if (failure == R.string.backend_failed && output instanceof ByteArrayOutputStream) {
                    decode(context, (ByteArrayOutputStream) output, exit);
                }
                throw new IOException(context.getString(failure) + (errors.isEmpty() ? "" : "\n" + errors));
            }
            if (readFailure != null) throw readFailure;
            writer.get(5, TimeUnit.SECONDS);
        } finally {
            call.finished = true;
            timer.cancel(false);
            call.process = null;
            call.source = null;
            process.destroy();
            writer.cancel(true);
            stderr.cancel(true);
        }
    }
    static boolean localCancellationAllowed(String command) {
        switch (command) {
            // Staging only creates a private, disposable artifact; no restore has begun.
            case "artifact-stage": case "identity-stage": case "identity-preview":
            case "backend-info": case "operation-status": case "artifact-read": case "file-read":
            case "files-browse": case "files-inbox": case "taildrop-targets": case "file-send-history": case "file-send-status": return true;
            default: return false;
        }
    }
    static void closeAsync(InputStream input) {
        IO.execute(() -> { try { input.close(); } catch (IOException ignored) { } });
    }
    static long copyWithTimeout(InputStream input, OutputStream output, long limit, int seconds) throws Exception {
        Call call = new Call();
        call.source = input;
        Future<Long> copy = IO.submit(() -> copy(input, output, limit, null, call));
        try { return copy.get(seconds, TimeUnit.SECONDS); }
        catch (TimeoutException e) {
            call.stop();
            throw new InterruptedIOException("Import timed out");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw new IOException("Import failed", cause);
        } finally {
            if (!copy.isDone()) { call.stop(); copy.cancel(true); }
        }
    }
    static long copy(InputStream input, OutputStream output, long limit, Progress progress, Call call) throws IOException {
        byte[] buffer = new byte[65536];
        long count = 0;
        int n;
        while ((n = input.read(buffer)) != -1) {
            if (call != null && call.cancelled.get()) throw new InterruptedIOException("Cancelled");
            if (count > limit - n) throw new IOException("File exceeds the allowed size");
            output.write(buffer, 0, n);
            count += n;
            if (progress != null) progress.copied(count);
        }
        return count;
    }
    static String message(Throwable error) {
        Throwable cause = error;
        while ((cause instanceof ExecutionException || cause instanceof CompletionException) && cause.getCause() != null) cause = cause.getCause();
        return cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage();
    }
}
