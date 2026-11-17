package dev.foxderin.tail;

import android.app.Instrumentation;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Real APK assets and WebKit listener, without replacing RootApi or submitting a mutation. */
final class WebViewChecks {
    private final Instrumentation instrumentation;
    private ControlActivity activity;
    private WebView web;
    private int sequence;

    private WebViewChecks(Instrumentation instrumentation) { this.instrumentation = instrumentation; }
    static void run(Instrumentation instrumentation) throws Exception {
        WebViewChecks checks = new WebViewChecks(instrumentation);
        try { checks.run(); }
        finally { if (checks.activity != null) instrumentation.runOnMainSync(checks.activity::finish); }
    }

    private void run() throws Exception {
        activity = (ControlActivity) instrumentation.startActivitySync(new Intent(instrumentation.getTargetContext(), ControlActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(ControlActivity.DESTINATION, "dashboard"));
        loaded();
        JSONObject bootstrap = request("app.bootstrap", new JSONObject());
        require(bootstrap.getBoolean("ok") && !bootstrap.has("drafts"), "Bundled document reaches the listener without obsolete bootstrap draft state");
        reject("exec", new JSONObject().put("command", "id"));
        reject("control.query", new JSONObject().put("command", "sh").put("arguments", new org.json.JSONArray().put("-c").put("id")));
        reject("control.query", new JSONObject().put("command", "status").put("arguments", new org.json.JSONArray().put(";id")));
        reject("control.mutate", new JSONObject().put("command", "mode-set").put("arguments", new org.json.JSONArray().put("bridge;id")));
        reject("identity.import", new JSONObject().put("path", "/data/private/state"));
        reject("control.query", new JSONObject().put("command", "identity-preview").put("arguments", new org.json.JSONArray().put("/data/private/state")));
        reject("control.mutate", new JSONObject().put("command", "identity-export").put("arguments", new org.json.JSONArray().put("raw")));
        reject("control.mutate", new JSONObject().put("command", "identity-restore").put("arguments", new org.json.JSONArray().put("art-" + "a".repeat(32)).put("missing-hash")));
        reject("control.mutate", new JSONObject().put("command", "account-rename").put("arguments", new org.json.JSONArray().put("profile").put("multi\nline")));
        reject("files.addShared", new JSONObject().put("handles", new org.json.JSONArray().put("/data/private")));
        reject("files.addShared", new JSONObject().put("paths", new org.json.JSONArray().put("/sdcard/file")));
        reject("app.openUrl", new JSONObject().put("url", "javascript:alert(1)"));
        reject("app.openUrl", new JSONObject().put("url", "https://user:password@example.invalid/"));
        reject("app.navigate", new JSONObject().put("page", "unknown"));
        reject("app.drafts", new JSONObject().put("key", "logs")); // Removed native state-copy API.
        reject("app.backState", new JSONObject().put("canHandle", "false"));
        reject("app.backState", new JSONObject().put("canHandle", false).put("extra", true));
        require(request("app.backState", new JSONObject().put("canHandle", true)).getBoolean("ok"), "Explicit boolean back state accepted");
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            Field registration = ControlActivity.class.getDeclaredField("backRegistered");
            registration.setAccessible(true);
            require(registration.getBoolean(activity), "In-app Back registers modern callback");
            require(request("app.backState", new JSONObject().put("canHandle", false)).getBoolean("ok"), "Root back state accepted");
            require(!registration.getBoolean(activity), "Root unregisters callback for system predictive Back");
        }
        rejectedOrigins();
        incomingShare();

        click("#bottom-nav a[href='#/files']");
        waitFor("location.hash === '#/files' && !!document.querySelector('.files-page')", "Files page opens without root");
        click("#bottom-nav a[href='#/settings']");
        waitFor("location.hash === '#/settings'", "Settings page opens");
        click("#view a[href='#/logs']");
        waitFor("location.hash === '#/logs' && !!document.querySelector('.tool-log-controls input')", "Logs filters remain editable without backend access");
        evaluate("(()=>{const input=document.querySelector('.tool-log-controls input'); input.value='instrumentation draft'; input.dispatchEvent(new Event('input',{bubbles:true})); return true})()");
        click("#bottom-nav a[href='#/settings']");
        waitFor("location.hash === '#/settings'", "Primary navigation responds");
        instrumentation.runOnMainSync(activity::onBackPressed);
        waitFor("location.hash === '#/logs' && document.querySelector('.tool-log-controls input')?.value === 'instrumentation draft'", "Native Back restores the prior page and current input");
        click(".task-menu summary");
        waitFor("document.querySelector('.task-menu').open", "Task menu opens");
        instrumentation.runOnMainSync(activity::onBackPressed);
        waitFor("!document.querySelector('.task-menu').open && location.hash === '#/logs'", "Back closes the menu before navigating");

        android.os.Bundle savedState = new android.os.Bundle();
        instrumentation.runOnMainSync(() -> activity.onSaveInstanceState(savedState));
        require(!savedState.containsKey("webDrafts"), "Unsaved form edits never enter Activity saved state");

        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(ControlActivity.class.getName(), null, false);
        try {
            instrumentation.runOnMainSync(activity::recreate);
            ControlActivity recreated = (ControlActivity) instrumentation.waitForMonitorWithTimeout(monitor, 15000);
            require(recreated != null && recreated != activity, "Activity recreation completes");
            activity = recreated;
        } finally { instrumentation.removeMonitor(monitor); }
        loaded();
        waitFor("location.hash === '#/logs' && document.querySelector('.tool-log-controls input')?.value === ''", "Recreation restores the route but not unsaved form edits");

        for (String url : new String[]{"https://example.invalid/", "file:///data/local/tmp/private", "content://example.invalid/private", WebBridge.ORIGIN + "/assets/not-index.html"}) {
            evaluate("location.href=" + JSONObject.quote(url));
            waitFor("location.origin === " + JSONObject.quote(WebBridge.ORIGIN) + " && location.pathname === '/assets/index.html' && !!document.querySelector('#bottom-nav')", "Untrusted navigation cannot replace the bundled document");
            require(request("files.snapshot", new JSONObject()).getBoolean("ok"), "The trusted document remains usable after blocked navigation");
        }
    }

    private void incomingShare() throws Exception {
        Uri uri = ExportProvider.cache(activity, "native-share.bin", output -> output.write(new byte[]{3, 1, 4}));
        try {
            Intent share = new Intent(Intent.ACTION_SEND).setType("application/octet-stream").putExtra(Intent.EXTRA_STREAM, uri);
            instrumentation.runOnMainSync(() -> activity.onNewIntent(share));
            waitFor("location.hash === '#/files' && document.querySelector('.files-page')?.textContent.includes('native-share.bin')", "Incoming share accepts our owned export without a temporary URI grant");
            org.json.JSONArray selected = request("files.snapshot", new JSONObject()).getJSONArray("selection");
            boolean found = false;
            for (int i = 0; i < selected.length(); i++) {
                JSONObject item = selected.getJSONObject(i);
                if ("native-share.bin".equals(item.optString("name")) && item.optLong("size") == 3) found = true;
            }
            require(found, "Shared native file keeps its exact name and byte count");
            require(request("files.clear", new JSONObject()).getBoolean("ok"), "Native source selection clears without deleting its export");
        } finally { ExportProvider.discard(activity, uri); }
    }

    private void rejectedOrigins() throws Exception {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> {
            try {
                Field field = ControlActivity.class.getDeclaredField("bridge"); field.setAccessible(true);
                WebBridge bridge = (WebBridge) field.get(activity);
                String page = activity.page();
                String message = new JSONObject().put("id", "rejected-origin").put("action", "app.navigate").put("args", new JSONObject().put("page", "peers")).toString();
                // A rejected source must return before touching even its reply channel.
                for (String origin : new String[]{"http://appassets.androidplatform.net", "https://example.invalid", "https://appassets.androidplatform.net.evil.invalid", "https://user@appassets.androidplatform.net", "https://appassets.androidplatform.net:444"})
                    bridge.receive(message, Uri.parse(origin), true, null);
                bridge.receive(message, Uri.parse(WebBridge.ORIGIN), false, null);
                require(page.equals(activity.page()), "Untrusted origins and subframes cannot navigate the host");
            } catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError("Origin/frame isolation", failure.get());
    }

    private void loaded() throws Exception {
        instrumentation.runOnMainSync(() -> web = findWebView(activity.getWindow().getDecorView()));
        require(web != null, "Host creates a WebView");
        waitFor("!!document.querySelector('#bottom-nav') && typeof FoxyTailNative?.postMessage === 'function'", "Actual APK frontend mounts and binds WebKit");
        evaluate("(()=>{const previous=FoxyTailNative.onmessage; window.__instrumentationReplies={}; FoxyTailNative.onmessage=event=>{if(previous)previous(event); const value=JSON.parse(event.data); if(value.id?.startsWith('instrumentation-'))window.__instrumentationReplies[value.id]=value.result;}; return true})()");
    }

    private JSONObject request(String action, JSONObject args) throws Exception {
        String id = "instrumentation-" + (++sequence);
        String envelope = new JSONObject().put("id", id).put("action", action).put("args", args).toString();
        evaluate("FoxyTailNative.postMessage(" + JSONObject.quote(envelope) + ")");
        waitFor("Object.prototype.hasOwnProperty.call(window.__instrumentationReplies," + JSONObject.quote(id) + ")", "Native reply for " + action);
        Object result = evaluate("(()=>{const value=window.__instrumentationReplies[" + JSONObject.quote(id) + "]; delete window.__instrumentationReplies[" + JSONObject.quote(id) + "]; return value})()");
        require(result instanceof JSONObject, "Reply is a result object");
        return (JSONObject) result;
    }
    private void reject(String action, JSONObject args) throws Exception {
        JSONObject result = request(action, args);
        require(!result.getBoolean("ok") && !result.optString("error").isEmpty(), "Unsafe request is explicitly rejected: " + action);
    }
    private void click(String selector) throws Exception {
        require(Boolean.TRUE.equals(evaluate("(()=>{const element=document.querySelector(" + JSONObject.quote(selector) + "); if(!element)return false; element.click(); return true})()")), "Clickable bundled control: " + selector);
    }
    private void waitFor(String expression, String detail) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 15000;
        while (SystemClock.uptimeMillis() < deadline) {
            if (Boolean.TRUE.equals(evaluate("Boolean(" + expression + ")"))) return;
            SystemClock.sleep(50);
        }
        throw new AssertionError(detail);
    }
    private Object evaluate(String expression) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> web.evaluateJavascript(expression, value -> { result.set(value); done.countDown(); }));
        require(done.await(10, TimeUnit.SECONDS), "WebView JavaScript callback");
        return new JSONTokener(result.get()).nextValue();
    }
    private static WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) { WebView found = findWebView(group.getChildAt(i)); if (found != null) return found; }
        }
        return null;
    }
    private static void require(boolean value, String detail) { if (!value) throw new AssertionError(detail); }
}
