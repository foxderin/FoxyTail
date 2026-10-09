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
    interface Progress { void copied(long bytes); }
    static final class Call {
        volatile Process process;
        volatile InputStream source;
        final AtomicBoolean cancelled = new AtomicBoolean();
        void cancel() {
            cancelled.set(true);
            Process p = process;
            if (p != null) p.destroy();
            InputStream input = source;
            if (input != null) IO.execute(() -> { try { input.close(); } catch (IOException ignored) { } });
        }
    }
    static String quote(String value) { return "'" + value.replace("'", "'\\''") + "'"; }
    static String requestId() { return (System.currentTimeMillis() / 1000) + "_" + java.util.UUID.randomUUID().toString().replace("-", ""); }
    static JSONObject json(Context context, String... args) throws Exception {
        return json(context, null, null, null, 90, new Call(), args);
    }
    static JSONObject json(Context context, String request, InputStream source, Progress progress, int seconds, Call call, String... args) throws Exception {
        ByteArrayOutputStream response = new ByteArrayOutputStream();
        execute(context, request, source, response, 4 * 1024 * 1024, progress, seconds, call, args);
        try {
            JSONObject value = new JSONObject(response.toString(StandardCharsets.UTF_8.name()));
            if (!value.has("ok") || !(value.get("ok") instanceof Boolean)) throw new IOException(context.getString(R.string.invalid_response));
            if (!value.getBoolean("ok")) throw new IOException(value.optString("error", context.getString(R.string.invalid_response)));
            return value;
        } catch (org.json.JSONException e) { throw new IOException(context.getString(R.string.invalid_response), e); }
    }
    static void readInbox(Context context, String name, OutputStream destination) throws Exception {
        Models.requireName(name);
        execute(context, null, null, destination, MAX_FILE, null, 1800, new Call(), "file-read", name);
    }
    private static void execute(Context context, String request, InputStream input, OutputStream output, long outputLimit, Progress progress, int seconds, Call call, String... args) throws Exception {
        StringBuilder command = new StringBuilder("if [ ! -f ").append(quote(SCRIPT)).append(" ]; then echo FOXYTAIL_MODULE_MISSING >&2; exit 72; fi; exec /system/bin/sh ").append(quote(SCRIPT));
        if (request != null) command.append(" --request-id ").append(quote(request));
        for (String arg : args) {
            if (arg == null || arg.indexOf('\0') >= 0) throw new IOException(context.getString(R.string.invalid_response));
            command.append(' ').append(quote(arg));
        }
        Process process;
        try { process = new ProcessBuilder("su", "-c", command.toString()).start(); }
        catch (IOException e) { throw new IOException(context.getString(R.string.root_denied), e); }
        call.process = process;
        call.source = input;
        AtomicBoolean timedOut = new AtomicBoolean();
        ScheduledFuture<?> timer = CLOCK.schedule(() -> { timedOut.set(true); call.cancel(); process.destroyForcibly(); }, seconds, TimeUnit.SECONDS);
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
            if (call.cancelled.get()) process.destroyForcibly();
            try (InputStream stdout = process.getInputStream()) { copy(stdout, output, outputLimit, null, call); }
            catch (Exception e) { readFailure = e; process.destroy(); }
            int exit = process.waitFor();
            String errors = stderr.get(5, TimeUnit.SECONDS).trim();
            if (timedOut.get()) throw new IOException(context.getString(R.string.timeout));
            if (call.cancelled.get()) throw new InterruptedIOException(context.getString(R.string.cancelled));
            if (errors.contains("FOXYTAIL_MODULE_MISSING")) throw new IOException(context.getString(R.string.module_missing));
            if (exit != 0) {
                if (output instanceof ByteArrayOutputStream) {
                    try {
                        JSONObject error = new JSONObject(((ByteArrayOutputStream) output).toString(StandardCharsets.UTF_8.name()));
                        if (error.has("error")) throw new IOException(error.getString("error"));
                    } catch (org.json.JSONException ignored) { }
                }
                throw new IOException(context.getString(R.string.root_denied) + (errors.isEmpty() ? "" : "\n" + errors));
            }
            if (readFailure != null) throw readFailure;
            writer.get(5, TimeUnit.SECONDS);
        } finally {
            timer.cancel(false);
            call.process = null;
            call.source = null;
            process.destroy();
            writer.cancel(true);
            stderr.cancel(true);
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
