package dev.foxderin.tail;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import io.flutter.embedding.android.FlutterActivity;
import io.flutter.embedding.engine.FlutterEngine;

public final class ControlActivity extends FlutterActivity {
    static final String DESTINATION = "destination";
    private PlatformBridge bridge;
    @Override protected void attachBaseContext(Context base) { super.attachBaseContext(PlatformLocale.localized(base)); }
    @Override public void configureFlutterEngine(FlutterEngine engine) {
        super.configureFlutterEngine(engine);
        bridge = new PlatformBridge(this, engine.getDartExecutor().getBinaryMessenger());
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        NativeFiles files = NativeFiles.get(this);
        files.attach(this, state == null ? null : state.getBundle("platform"));
        if (state == null) files.acceptIntent(getIntent());
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent); NativeFiles.get(this).acceptIntent(intent);
    }
    @Override protected void onResume() {
        super.onResume();
        NativeFiles.get(this).attach(this, null);
        if (bridge != null) bridge.foreground(true);
        ControlClient.get(this).refreshAvailability();
    }
    @Override protected void onPause() {
        if (bridge != null) bridge.foreground(false);
        super.onPause();
    }
    @Override protected void onSaveInstanceState(Bundle state) {
        state.putBundle("platform", NativeFiles.get(this).saveState()); super.onSaveInstanceState(state);
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data); NativeFiles.get(this).activityResult(request, result, data);
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        NativeFiles.get(this).permissionResult(request, results);
    }
    @Override public void cleanUpFlutterEngine(FlutterEngine engine) {
        if (bridge != null) { bridge.close(); bridge = null; }
        super.cleanUpFlutterEngine(engine);
    }
    @Override protected void onDestroy() {
        NativeFiles.get(this).detach(this); super.onDestroy();
    }
}
