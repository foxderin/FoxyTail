package dev.foxderin.tail;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.Map;
import java.util.List;

final class PlatformChecks {
    static void run(Context context) throws Exception {
        preparationCancellation();
        submissionBoundary(context);
        exportDelivery();
        for (String command : new String[]{"control", "login", "login-authkey", "file-read", "artifact-read", "operation-start", "file-send-start", "file-delete"})
            require(!PlatformBridge.allowedRead(command), "Mutation, authentication and binary commands cannot bypass the read gate");
        require(PlatformBridge.allowedRead("status") && PlatformBridge.allowedRead("file-send-history"), "Actual observation commands are available");
        JSONObject object = new JSONObject().put("ok", false).put("count", 42L).put("nil", JSONObject.NULL)
                .put("result", new JSONArray().put(new JSONObject().put("known", false)));
        Map<?, ?> mapped = (Map<?, ?>) PlatformBridge.value(object);
        require(mapped.get("ok").equals(false) && mapped.get("nil") == null && mapped.get("count").equals(42L), "Snapshot scalar types are not stringified");
        require(((Map<?, ?>) ((List<?>) mapped.get("result")).get(0)).get("known").equals(false), "Nested structured failures retain booleans");
        reject(() -> PlatformBridge.arguments(new JSONObject().put("args", new JSONArray().put("status").put(1))));
        reject(() -> PlatformBridge.arguments(new JSONObject().put("args", new JSONArray().put("status").put("bad\0arg"))));
        reject(() -> PlatformBridge.arguments(new JSONObject().put("args", new JSONArray())));
        reject(() -> PlatformBridge.arguments(new JSONObject().put("args", new JSONArray().put("settings-set").put("x").put("a".repeat(65537)))));
        JSONArray names = new JSONArray(); for (int i = 0; i < 32; i++) names.put("file-" + i);
        require(NativeFiles.names(names).size() == 32, "Exactly 32 selected names accepted");
        names.put("overflow"); reject(() -> NativeFiles.names(names));
        reject(() -> NativeFiles.names(new JSONArray().put("same").put("same")));
        reject(() -> NativeFiles.names(new JSONArray().put("../outside")));
        JSONObject receipt = new JSONObject().put("state", "interrupted").put("exitCode", 125).put("result", new JSONObject().put("ok", true));
        JSONObject terminal = ControlClient.terminalResult(receipt);
        require(!terminal.getBoolean("ok") && terminal.getInt("exitCode") == 125 && terminal.getString("operationState").equals("interrupted"), "Terminal state and exit code survive the channel");
    }
    private static void preparationCancellation() {
        NativeFiles.Preparation preparation = new NativeFiles.Preparation();
        long cancelled = preparation.begin();
        require(preparation.cancel() && !preparation.pending(), "Preparation cancel releases local ownership");
        require(!preparation.finish(cancelled), "Cancelled preparation cannot hand off a START");
        long replacement = preparation.begin();
        require(!preparation.finish(cancelled) && preparation.pending(), "Stale completion cannot clear replacement preparation");
        require(preparation.finish(replacement), "Current preparation hands off exactly once");
        require(!preparation.finish(replacement) && !preparation.cancel(), "After handoff cancellation belongs to service, not preparation");
    }
    private static void submissionBoundary(Context context) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences("native-check-submission", Context.MODE_PRIVATE);
        try {
            for (String marker : new String[]{"FOXYTAIL_ROOT_DENIED", "FOXYTAIL_MODULE_MISSING"}) {
                prefs.edit().putBoolean("submissionUnknown", true).putString("attemptPeer", "peer").putString("attemptPaths", "[]").putLong("attemptTime", 1).commit();
                try { RootApi.requireStarted(context, marker, marker.endsWith("DENIED") ? 77 : 72); throw new AssertionError("Pre-exec rejection was not typed"); }
                catch (RootApi.NotStarted failure) {
                    require(TransferService.clearRejectedSubmission(prefs, failure) && !prefs.contains("submissionUnknown") && !prefs.contains("attemptPaths"), "Verified pre-exec rejection unlocks without sending again");
                }
            }
            RootApi.requireStarted(context, "FOXYTAIL_ROOT_READY\nFOXYTAIL_ROOT_DENIED", 77);
            RootApi.requireStarted(context, "FOXYTAIL_ROOT_DENIED", 1);
            RootApi.requireStarted(context, "su: denied", 77);
            RootApi.requireStarted(context, "FOXYTAIL_ROOT_DENIED\nFOXYTAIL_MODULE_MISSING", 77);
            for (Exception uncertain : new Exception[]{new IOException("FOXYTAIL_ROOT_DENIED"), new IOException("transport lost"), new org.json.JSONException("malformed transfer")}) {
                prefs.edit().putBoolean("submissionUnknown", true).putString("attemptPaths", "[\"source\"]").commit();
                require(!TransferService.clearRejectedSubmission(prefs, uncertain) && prefs.getBoolean("submissionUnknown", false) && prefs.contains("attemptPaths"), "Uncertain response retains ownership regardless of message text");
            }
            require(TransferService.clearRejectedSubmission(prefs, new RootApi.Failure(new JSONObject().put("ok", false), 1, "rejected")) && !prefs.contains("submissionUnknown"), "Explicit backend failure releases unknown marker");
            prefs.edit().putBoolean("submissionUnknown", true).commit();
            IOException cause = new IOException("launch unavailable");
            try { RootApi.startRoot(context, "not executed", builder -> { throw cause; }); throw new AssertionError("Launch unexpectedly succeeded"); }
            catch (RootApi.NotStarted failure) {
                require(failure.getCause() == cause && TransferService.clearRejectedSubmission(prefs, failure) && !prefs.contains("submissionUnknown"), "Launch failure preserves cause and releases unknown marker");
            }
        } finally { prefs.edit().clear().commit(); }
    }
    private static void exportDelivery() throws Exception {
        List<String> names = java.util.Arrays.asList("first", "second", "third");
        JSONArray staged = new JSONArray().put(new JSONObject().put("name", "first").put("ok", true))
                .put(new JSONObject().put("name", "second").put("ok", false).put("partial", true).put("error", "write failed"));
        for (boolean cancelled : new boolean[]{false, true}) {
            JSONObject aborted = NativeFiles.exportResult(names, staged, true, false, "not delivered", cancelled);
            require(!aborted.getBoolean("ok") && aborted.getJSONArray("results").length() == 3, "Aborted atomic share reports every selected file");
            for (int i = 0; i < 3; i++) require(!aborted.getJSONArray("results").getJSONObject(i).getBoolean("ok"), "Cached bytes are not delivered success");
        }
        JSONObject handedOff = NativeFiles.exportResult(names, new JSONArray(), true, true, "", false);
        require(handedOff.getBoolean("ok"), "Successful chooser handoff publishes atomic success");
        JSONObject saved = NativeFiles.exportResult(names, staged, false, false, "cancelled", true);
        JSONArray results = saved.getJSONArray("results");
        require(!saved.getBoolean("ok") && results.getJSONObject(0).getBoolean("ok") && results.getJSONObject(1).getBoolean("partial") && !results.getJSONObject(2).getBoolean("ok"), "Tree cancellation preserves completed writes and partial damage");
    }
    private interface Checked { void run() throws Exception; }
    private static void reject(Checked action) throws Exception {
        try { action.run(); } catch (IOException expected) { return; }
        throw new AssertionError("Untrusted input accepted");
    }
    private static void require(boolean condition, String detail) { if (!condition) throw new AssertionError(detail); }
}
