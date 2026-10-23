package dev.foxderin.tail;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

public class ControlActivity extends Activity {
    static final String DESTINATION = "destination";
    private static final String[] PAGES = {"dashboard", "peers", "files", "traffic", "more", "tunnel", "routing", "serve", "account", "logs", "settings", "diag"};
    private static final String CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    private WebView web;
    private WebBridge bridge;
    private FileActions files;
    private FrameLayout content;
    private JSONObject drafts = new JSONObject();
    private String destination = "dashboard", section;
    private android.window.OnBackInvokedCallback backCallback;

    @Override protected void attachBaseContext(Context base) { super.attachBaseContext(AppPreferences.localized(base)); }

    static boolean supportedWebViewVersion(String version) {
        if (version == null) return false;
        int separator = version.indexOf('.');
        String major = separator < 0 ? version : version.substring(0, separator);
        if (!major.matches("[0-9]{1,6}")) return false;
        return Integer.parseInt(major) >= 109;
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        destination = controlDestination(getIntent().getStringExtra(DESTINATION));
        if (saved != null) {
            destination = controlDestination(saved.getString("page", destination));
            byte[] savedDrafts = saved.getByteArray("webDrafts");
            try { if (savedDrafts != null) drafts = new JSONObject(new String(savedDrafts, StandardCharsets.UTF_8)); }
            catch (org.json.JSONException ignored) { drafts = new JSONObject(); }
        }
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        content = new FrameLayout(this);
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, insets) -> {
            androidx.core.graphics.Insets padding = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        setContentView(content);
        files = new FileActions(this, (event, value) -> { if (bridge != null) bridge.emit(event, value); });
        if (saved != null) files.restore(saved);
        if (saved == null) acceptIntent(getIntent());
        try {
            web = new WebView(this);
            android.content.pm.PackageInfo provider = WebViewCompat.getCurrentWebViewPackage(this);
            if (provider == null || !supportedWebViewVersion(provider.versionName) ||
                    !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                throw new IOException(getString(R.string.webview_too_old));
            }
            bridge = new WebBridge(this, files);
            WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
            WebSettings settings = web.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(false);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setAllowFileAccessFromFileURLs(false);
            settings.setAllowUniversalAccessFromFileURLs(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setBlockNetworkLoads(true);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setSupportMultipleWindows(false);
            settings.setSaveFormData(false);
            settings.setMediaPlaybackRequiresUserGesture(true);
            settings.setTextZoom(Math.round(getResources().getConfiguration().fontScale * 100));
            CookieManager.getInstance().setAcceptCookie(false);
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
            WebViewAssetLoader assets = new WebViewAssetLoader.Builder().addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
            web.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    String path = uri.getPath();
                    if (!WebBridge.trustedOrigin(uri) || !"GET".equals(request.getMethod()) || path == null || !path.startsWith("/assets/") ||
                            path.contains("/../") || path.contains("/./") || path.contains("\\") || (request.isForMainFrame() && !WebBridge.trustedDocument(uri))) return blocked();
                    WebResourceResponse response = assets.shouldInterceptRequest(uri);
                    if (response == null) return blocked();
                    Map<String, String> headers = new HashMap<>();
                    if (response.getResponseHeaders() != null) headers.putAll(response.getResponseHeaders());
                    headers.put("Content-Security-Policy", CSP);
                    headers.put("X-Content-Type-Options", "nosniff");
                    headers.put("Referrer-Policy", "no-referrer");
                    response.setResponseHeaders(headers);
                    return response;
                }
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    return !request.isForMainFrame() || !WebBridge.trustedDocument(request.getUrl());
                }
                @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return !WebBridge.trustedDocument(Uri.parse(url)); }
                @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                    if (bridge != null) bridge.resetDocument();
                    if (!WebBridge.trustedDocument(Uri.parse(url))) { view.stopLoading(); startupFailure(getString(R.string.webview_blocked)); }
                }
                @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    if (request.isForMainFrame()) startupFailure(getString(R.string.webview_unavailable));
                }
                @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                    if (request.isForMainFrame()) startupFailure(getString(R.string.webview_assets));
                }
                @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    startupFailure(getString(R.string.webview_gone)); return true;
                }
            });
            web.setWebChromeClient(new WebChromeClient() {
                @Override public void onPermissionRequest(android.webkit.PermissionRequest request) { request.deny(); }
                @Override public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback, FileChooserParams params) { callback.onReceiveValue(null); return true; }
            });
            web.setDownloadListener((url, userAgent, disposition, mime, length) -> { });
            WebViewCompat.addWebMessageListener(web, "FoxyTailNative", Collections.singleton(WebBridge.ORIGIN),
                    (view, message, sourceOrigin, isMainFrame, reply) -> { if (bridge != null) bridge.receive(message.getData(), sourceOrigin, isMainFrame, reply); });
            content.addView(web, new FrameLayout.LayoutParams(-1, -1));
            applyAppearance();
            web.loadUrl(WebBridge.INDEX);
        } catch (Exception error) { startupFailure(RootApi.message(error)); }
        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::webBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        ViewCompat.requestApplyInsets(content);
    }

    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }
    private void startupFailure(String message) {
        if (bridge != null) { bridge.destroy(); bridge = null; }
        if (web != null) { content.removeView(web); web.destroy(); web = null; }
        TextView error = new TextView(this); error.setText(message); error.setGravity(android.view.Gravity.CENTER); error.setPadding(24, 24, 24, 24);
        content.removeAllViews(); content.addView(error, new FrameLayout.LayoutParams(-1, -1));
    }
    boolean trustedDocument() { return web != null && WebBridge.trustedDocument(Uri.parse(web.getUrl() == null ? "" : web.getUrl())); }
    String page() { return destination; }
    String section() { return section; }
    JSONObject drafts() { return drafts; }
    static String controlDestination(String value) {
        if ("overview".equals(value)) return "dashboard";
        if ("diagnostics".equals(value)) return "diag";
        return Arrays.asList(PAGES).contains(value) ? value : "dashboard";
    }
    void navigate(String page) throws IOException {
        if (!Arrays.asList(PAGES).contains(page)) throw new IOException("Invalid page");
        destination = page;
    }
    private void acceptIntent(Intent intent) {
        if (intent == null) return;
        boolean send = Intent.ACTION_SEND.equals(intent.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction());
        if (send || intent.getBooleanExtra("history", false)) {
            destination = "files"; section = send ? "send" : "history";
            files.acceptIntent(intent);
            if (bridge != null) bridge.emit("navigate", WebBridge.object("ok", true, "page", "files", "section", section));
        } else if (intent.hasExtra(DESTINATION)) {
            destination = controlDestination(intent.getStringExtra(DESTINATION));
            if (bridge != null) bridge.emit("navigate", WebBridge.object("ok", true, "page", destination));
        }
    }
    void deliverNavigation() {
        if (section != null && bridge != null) {
            bridge.emit("navigate", WebBridge.object("ok", true, "page", destination, "section", section));
            section = null;
        }
    }
    JSONObject draft(String key, JSONObject args) throws Exception {
        WebBridge.choice(key, "settings", "routes", "context", "serve", "files", "logs", "coexist", "trial", "exit");
        if (!args.has("value")) return drafts.optJSONObject(key);
        Object value = args.get("value");
        if (value != JSONObject.NULL && !(value instanceof JSONObject)) throw new IOException("Draft must be an object");
        if (value != JSONObject.NULL) {
            if ("exit".equals(key)) {
                JSONObject exit = (JSONObject) value;
                WebBridge.keys(exit, "identity", "id");
                WebBridge.text(exit, "identity", 4096);
                WebBridge.text(exit, "id", 1024);
            }
            checkDraft(value);
            if (value.toString().getBytes(StandardCharsets.UTF_8).length > 256 * 1024) throw new IOException("Draft exceeds 256 KiB");
        }
        JSONObject next = new JSONObject(drafts.toString());
        if (value == JSONObject.NULL) next.remove(key); else next.put(key, value);
        if (next.toString().getBytes(StandardCharsets.UTF_8).length > 512 * 1024) throw new IOException("Drafts exceed 512 KiB");
        drafts = next; return drafts.optJSONObject(key);
    }
    private static void checkDraft(Object value) throws Exception {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            Iterator<String> names = object.keys();
            while (names.hasNext()) {
                String key = names.next();
                if (key.toLowerCase(java.util.Locale.ROOT).matches(".*(authkey|password|credential|secret|sourceuri).*")) throw new IOException("Credentials and source URIs cannot be saved as drafts");
                checkDraft(object.get(key));
            }
        } else if (value instanceof org.json.JSONArray) {
            org.json.JSONArray array = (org.json.JSONArray) value;
            for (int i = 0; i < array.length(); i++) checkDraft(array.get(i));
        } else if (value instanceof String && ((String) value).startsWith("content://")) throw new IOException("Source URIs cannot be saved as drafts");
    }
    void openExternal(URI uri) { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(uri.toString())).addCategory(Intent.CATEGORY_BROWSABLE)); }
    void applyAppearance() {
        String theme = AppPreferences.appearance(this).optString("theme");
        boolean dark = "dark".equals(theme) || ("auto".equals(theme) && (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
        int background = dark ? Color.rgb(21, 24, 30) : Color.rgb(245, 246, 248);
        content.setBackgroundColor(background); if (web != null) web.setBackgroundColor(background);
        getWindow().setStatusBarColor(background); getWindow().setNavigationBarColor(background);
        WindowCompat.getInsetsController(getWindow(), content).setAppearanceLightStatusBars(!dark);
        WindowCompat.getInsetsController(getWindow(), content).setAppearanceLightNavigationBars(!dark);
    }
    private void webBack() { if (bridge != null && bridge.ready() && trustedDocument()) bridge.emit("back", WebBridge.object("ok", true)); else finish(); }
    @Override public void onBackPressed() { webBack(); }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); acceptIntent(intent); }
    @Override protected void onResume() {
        super.onResume();
        if (web != null) web.onResume(); if (files != null) files.resume(); if (bridge != null) bridge.resume();
    }
    @Override protected void onPause() {
        if (bridge != null) bridge.pause(); if (files != null) files.pause(); if (web != null) web.onPause(); super.onPause();
    }
    @Override protected void onSaveInstanceState(Bundle saved) {
        // Binder transactions are ~1 MiB shared; drafts total up to 512 KiB, so skip anything
        // larger than 64 KiB (worst case ~8 keys) instead of crashing recreation.
        try {
            JSONObject bundleable = new JSONObject();
            for (Iterator<String> keys = drafts.keys(); keys.hasNext(); ) {
                String key = keys.next();
                byte[] encoded = drafts.optJSONObject(key).toString().getBytes(StandardCharsets.UTF_8);
                if (encoded.length <= 64 * 1024) bundleable.put(key, drafts.optJSONObject(key));
            }
            saved.putString("page", destination); saved.putByteArray("webDrafts", bundleable.toString().getBytes(StandardCharsets.UTF_8));
        } catch (org.json.JSONException impossible) { throw new AssertionError(impossible); }
        if (files != null) files.save(saved); super.onSaveInstanceState(saved);
    }
    @Override protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        if (bridge != null) bridge.destroy(); if (files != null) files.destroy();
        if (web != null) { content.removeView(web); web.destroy(); web = null; }
        super.onDestroy();
    }
    @Override protected void onActivityResult(int request, int result, Intent data) { super.onActivityResult(request, result, data); if (files != null) files.onActivityResult(request, result, data); }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) { super.onRequestPermissionsResult(request, permissions, results); if (files != null) files.onRequestPermissionsResult(request, permissions, results); }
    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (web != null) web.getSettings().setTextZoom(Math.round(configuration.fontScale * 100));
        applyAppearance();
    }
}
