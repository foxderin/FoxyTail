package dev.foxderin.tail;

import android.content.Context;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

final class ControlChecks {
    static void run(Context context) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bytes.write("{\"ok\":false,\"error\":\"route failed\",\"exitRouting\":{\"effective\":\"not-effective\"}}".getBytes(StandardCharsets.UTF_8));
        try { RootApi.decode(context, bytes, 1); throw new AssertionError("Failure accepted"); }
        catch (RootApi.Failure failure) {
            require(failure.exitCode == 1 && "not-effective".equals(failure.result.getJSONObject("exitRouting").getString("effective")), "Failure preserves actual state");
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
    }
    private static void require(boolean value, String detail) { if (!value) throw new AssertionError(detail); }
}
