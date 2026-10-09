package dev.foxderin.tail;

import androidx.appcompat.app.AppCompatActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.GravityCompat;
import androidx.drawerlayout.widget.DrawerLayout;
import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.navigation.NavigationView;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.color.MaterialColors;
import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.*;
import android.provider.OpenableColumns;
import android.view.View;
import android.widget.*;
import org.json.JSONObject;
import java.io.*;
import java.lang.ref.WeakReference;
import java.util.ArrayDeque;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

public final class ControlActivity extends AppCompatActivity {
    private static final int PICK_BACKUP = 50, SAVE_ARTIFACT = 51;
    private static final ExecutorService FILES = Executors.newFixedThreadPool(2);
    static final String[] PAGES = {"overview", "peers", "account", "exitnodes", "tunnel", "routing", "settings", "context", "trial", "serve", "coexist", "traffic", "logs", "diagnostics", "backup"};
    private static final int[] TITLES = {R.string.control_overview, R.string.control_peers, R.string.control_account, R.string.control_exitnodes, R.string.control_tunnel, R.string.control_routing, R.string.control_settings, R.string.control_context, R.string.control_trial, R.string.control_serve, R.string.control_coexist, R.string.control_traffic, R.string.control_logs, R.string.control_diagnostics, R.string.control_backup};
    Bundle drafts;
    ControlClient client;
    private ControlPage page;
    private String destination = "overview", saveId, saveName;
    private final ArrayDeque<String> back = new ArrayDeque<>();
    private LinearLayout root;
    private TextView status, feedback;
    private MaterialToolbar toolbar;
    private DrawerLayout drawer;
    private NavigationView navigation;
    private LinearLayout operationActions;
    private Button cancel, acknowledge;
    private ScrollView scroll;
    private boolean resumed, autoRefresh = true, powerSave, operationWasBusy;
    private Consumer<String> importCallback;
    private ControlPage importOwner;
    private int accountRevision;
    private long observedAccountRevision;
    private final Runnable operationChanged = this::showOperation;
    private final Runnable importChanged = this::deliverImport;

    @Override protected void attachBaseContext(Context base) { super.attachBaseContext(ControlUi.localized(base)); }
    @Override public void onCreate(Bundle saved) {
        ControlUi.appearance(this);
        super.onCreate(saved);
        drafts = saved == null || saved.getBundle("drafts") == null ? new Bundle() : saved.getBundle("drafts");
        if (saved != null) {
            destination = saved.getString("page", "overview"); saveId = saved.getString("saveId"); saveName = saved.getString("saveName");
            String[] history = saved.getStringArray("back"); if (history != null) for (String item : history) back.addLast(item);
        }
        client = ControlClient.get(this);
        observedAccountRevision = saved == null ? client.accountRevision() : saved.getLong("accountRevision", -1);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        drawer = new DrawerLayout(this);
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(MaterialColors.getColor(root, com.google.android.material.R.attr.colorSurface));
        drawer.addView(root, new DrawerLayout.LayoutParams(-1, -1));
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        toolbar = new MaterialToolbar(this); toolbar.setNavigationIcon(R.drawable.ic_menu);
        toolbar.setNavigationContentDescription(R.string.control_menu); toolbar.setNavigationOnClickListener(v -> menu());
        toolbar.getMenu().add(0, 1, 0, R.string.refresh).setIcon(R.drawable.ic_refresh).setShowAsAction(android.view.MenuItem.SHOW_AS_ACTION_ALWAYS);
        toolbar.setOnMenuItemClickListener(item -> { refreshAvailability(); if (page != null) page.load(); return true; });
        root.addView(toolbar, new LinearLayout.LayoutParams(-1, ControlUi.dp(this, 64)));
        status = ControlUi.text(this, "", 12); status.setPadding(ControlUi.dp(this, 20), 0, ControlUi.dp(this, 20), ControlUi.dp(this, 8));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); root.addView(status);
        operationActions = new LinearLayout(this); operationActions.setPadding(ControlUi.dp(this, 16), 0, ControlUi.dp(this, 16), 0);
        cancel = ControlUi.button(this, getString(R.string.cancel), client::cancelCurrent); operationActions.addView(cancel, new LinearLayout.LayoutParams(0, -2, 1));
        Button reconnect = ControlUi.button(this, getString(R.string.control_reconnect), () -> { client.reconnect(); refreshAvailability(); }); operationActions.addView(reconnect, new LinearLayout.LayoutParams(0, -2, 1));
        acknowledge = ControlUi.button(this, getString(R.string.control_acknowledge), () -> new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.control_unknown_title).setMessage(R.string.control_unknown_warning)
                .setNegativeButton(android.R.string.cancel, null).setPositiveButton(android.R.string.ok, (d, w) -> { client.acknowledgeUnknown(); if (page != null) page.load(); }).show()); operationActions.addView(acknowledge, new LinearLayout.LayoutParams(0, -2, 1));
        root.addView(operationActions);
        feedback = ControlUi.text(this, "", 14); feedback.setPadding(ControlUi.dp(this, 20), ControlUi.dp(this, 4), ControlUi.dp(this, 20), ControlUi.dp(this, 4));
        feedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); feedback.setVisibility(View.GONE); root.addView(feedback);
        scroll = new ScrollView(this); scroll.setFillViewport(true); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        navigation = new NavigationView(this); navigation.setFitsSystemWindows(true);
        TextView branding = ControlUi.text(this, getString(R.string.app_name), 28); branding.setPadding(ControlUi.dp(this, 24), ControlUi.dp(this, 48), ControlUi.dp(this, 24), ControlUi.dp(this, 24)); navigation.addHeaderView(branding);
        ViewCompat.setOnApplyWindowInsetsListener(navigation, (view, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            branding.setPadding(ControlUi.dp(this, 24), bars.top + ControlUi.dp(this, 24), ControlUi.dp(this, 24), ControlUi.dp(this, 24));
            view.setPadding(0, 0, 0, bars.bottom); return insets;
        });
        for (int i = 0; i < PAGES.length; i++) navigation.getMenu().add(0, 100 + i, i, TITLES[i]).setCheckable(true);
        navigation.getMenu().setGroupCheckable(0, true, true);
        navigation.getMenu().add(1, 200, 20, R.string.control_files);
        navigation.getMenu().add(1, 201, 21, R.string.control_appearance);
        navigation.setNavigationItemSelectedListener(item -> {
            drawer.closeDrawer(GravityCompat.START);
            if (item.getItemId() == 200) openFiles();
            else if (item.getItemId() == 201) appearance();
            else navigate(PAGES[item.getItemId() - 100]);
            return true;
        });
        DrawerLayout.LayoutParams navParams = new DrawerLayout.LayoutParams(ControlUi.dp(this, 304), -1); navParams.gravity = GravityCompat.START; drawer.addView(navigation, navParams);
        setContentView(drawer); ViewCompat.requestApplyInsets(root); showPage(destination); showOperation();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { goBack(); }
        });
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); navigate("overview"); }
    @Override protected void onResume() {
        super.onResume(); resumed = true; client.addListener(operationChanged); refreshAvailability();
        if (page != null) page.resume();
        BackupImport.get(this).observe(importChanged); deliverImport();
    }
    @Override protected void onPause() {
        resumed = false; if (page != null) page.pause(); client.removeListener(operationChanged); BackupImport.get(this).remove(importChanged); super.onPause();
    }
    @Override protected void onDestroy() { if (page != null) page.close(); importCallback = null; super.onDestroy(); }
    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("page", destination); state.putBundle("drafts", drafts); state.putString("saveId", saveId); state.putString("saveName", saveName);
        state.putLong("accountRevision", observedAccountRevision);
        state.putStringArray("back", back.toArray(new String[0])); super.onSaveInstanceState(state);
    }
    private void goBack() {
        if (drawer.isDrawerOpen(GravityCompat.START)) { drawer.closeDrawer(GravityCompat.START); return; }
        if (!back.isEmpty()) showPage(back.removeLast());
        else if (!"overview".equals(destination)) showPage("overview");
        else finish();
    }
    private void menu() { drawer.openDrawer(GravityCompat.START); }
    void navigate(String name) {
        if ("files".equals(name)) { openFiles(); return; }
        if (!destination.equals(name)) back.addLast(destination);
        showPage(name);
    }
    private void showPage(String name) {
        if (page != null) page.close();
        destination = name;
        switch (name) {
            case "peers": page = new PeersPage(this); break;
            case "account": page = new AccountPage(this); break;
            case "exitnodes": page = new ExitNodesPage(this); break;
            case "tunnel": page = new TunnelPage(this); break;
            case "routing": page = new RoutingPage(this); break;
            case "settings": page = new SettingsPage(this); break;
            case "context": page = new ContextPage(this); break;
            case "trial": page = new TrialPage(this); break;
            case "serve": page = new ServePage(this); break;
            case "coexist": page = new CoexistPage(this); break;
            case "traffic": page = new TrafficPage(this); break;
            case "logs": page = new LogsPage(this); break;
            case "diagnostics": page = new DiagnosticsPage(this); break;
            case "backup": page = new BackupPage(this); break;
            default: destination = "overview"; page = new OverviewPage(this);
        }
        scroll.removeAllViews(); scroll.addView(page.content); scroll.scrollTo(0, 0); toolbar.setTitle(page.title()); showMessage("");
        int selected = java.util.Arrays.asList(PAGES).indexOf(destination); if (selected >= 0) navigation.setCheckedItem(100 + selected);
        if (resumed) page.start();
    }
    void openFiles() { startActivity(new Intent(this, MainActivity.class)); }
    void openUrl(String value) {
        try {
            Uri uri = Uri.parse(value);
            if ((!"https".equalsIgnoreCase(uri.getScheme()) && !"http".equalsIgnoreCase(uri.getScheme())) || uri.getHost() == null || uri.getUserInfo() != null) throw new IOException(getString(R.string.control_invalid_url));
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (Exception e) { showMessage(RootApi.message(e)); }
    }
    void showMessage(String text) {
        if (!isDestroyed()) { feedback.setText(text); feedback.setVisibility(text == null || text.isEmpty() ? View.GONE : View.VISIBLE); }
    }
    private void showOperation() {
        if (isDestroyed()) return;
        if (observedAccountRevision != client.accountRevision()) {
            observedAccountRevision = client.accountRevision(); invalidateAccountState();
            if (resumed && page != null && ("peers".equals(destination) || "exitnodes".equals(destination) || "coexist".equals(destination))) showPage(destination);
        }
        status.setText(client.message()); cancel.setVisibility(client.canCancel() ? View.VISIBLE : View.GONE);
        acknowledge.setVisibility(client.isUnknown() ? View.VISIBLE : View.GONE);
        operationActions.setVisibility(client.busy() ? View.VISIBLE : View.GONE);
        boolean active = client.busy();
        String completed = client.lastCommand();
        if (operationWasBusy && !active && resumed && page != null) page.operationFinished(completed);
        operationWasBusy = active;
    }
    void refreshAvailability() {
        client.refreshAvailability();
        WeakReference<ControlActivity> owner = new WeakReference<>(this);
        Context context = getApplicationContext();
        FILES.execute(() -> {
            try {
                JSONObject settings = RootApi.json(context, null, null, null, 25, new RootApi.Call(), "settings-get").getJSONObject("settings");
                new Handler(Looper.getMainLooper()).post(() -> {
                    ControlActivity current = owner.get(); if (current == null || current.isDestroyed()) return;
                    if ("on".equals(settings.optString("WEBUI_AUTO_REFRESH")) || "off".equals(settings.optString("WEBUI_AUTO_REFRESH"))) current.autoRefresh = "on".equals(settings.optString("WEBUI_AUTO_REFRESH"));
                    if ("on".equals(settings.optString("POWER_SAVE")) || "off".equals(settings.optString("POWER_SAVE"))) current.powerSave = "on".equals(settings.optString("POWER_SAVE"));
                });
            } catch (Exception ignored) { /* The active page and backend handshake retain their own errors. */ }
        });
    }
    void setAutoRefresh(boolean enabled) { autoRefresh = enabled; }
    boolean autoRefresh() { return autoRefresh; }
    boolean powerSave() { return powerSave; }
    void invalidateAccountState() {
        accountRevision++;
        for (String key : new java.util.HashSet<>(drafts.keySet())) {
            if (key.startsWith("peers.") || key.startsWith("exitnodes.") || key.startsWith("coexist.")) drafts.remove(key);
            if (key.startsWith("network.peer") || key.startsWith("network.exit")) drafts.remove(key);
        }
    }
    int accountRevision() { return accountRevision; }
    private void appearance() {
        String[] options = {getString(R.string.control_language), getString(R.string.control_theme)};
        new MaterialAlertDialogBuilder(this).setTitle(R.string.control_appearance).setItems(options, (d, which) -> {
            String key = which == 0 ? "language" : "theme";
            String[] values = which == 0 ? new String[]{"auto", "en", "zh"} : new String[]{"auto", "light", "dark"};
            String[] labels = which == 0 ? new String[]{getString(R.string.control_system), "English", "中文"} : new String[]{getString(R.string.control_system), getString(R.string.control_light), getString(R.string.control_dark)};
            new MaterialAlertDialogBuilder(this).setTitle(options[which]).setItems(labels, (dialog, selected) -> {
                getSharedPreferences("interface", MODE_PRIVATE).edit().putString(key, values[selected]).apply(); recreate();
            }).show();
        }).show();
    }
    void pickBackup(Consumer<String> completed) {
        if (BackupImport.get(this).busy()) { showMessage(getString(R.string.control_importing)); return; }
        importCallback = completed; importOwner = page;
        try { startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE), PICK_BACKUP); }
        catch (ActivityNotFoundException e) { showMessage(getString(R.string.invalid_uri)); }
    }
    private void deliverImport() {
        if (!resumed || isDestroyed()) return;
        BackupImport operation = BackupImport.get(this);
        if (operation.busy()) { showMessage(getString(R.string.control_importing)); return; }
        if (operation.error() != null) { showMessage(operation.error()); return; }
        String token = operation.token();
        if (token == null) return;
        showMessage("");
        drafts.putString("backup.importedArtifact", token);
        Consumer<String> callback = importCallback; importCallback = null;
        if (callback != null && page == importOwner) callback.accept(token); else navigate("backup");
        operation.consume(token);
    }
    void saveArtifact(String id, String name) {
        if (id == null || !id.matches("art-[a-f0-9]{32}")) { showMessage(getString(R.string.invalid_response)); return; }
        saveId = id; saveName = Models.safeName(name);
        try { startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/gzip").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, saveName), SAVE_ARTIFACT); }
        catch (ActivityNotFoundException e) { showMessage(getString(R.string.invalid_uri)); }
    }
    void shareArtifact(String id, String name) {
        Context context = getApplicationContext(); WeakReference<ControlActivity> owner = new WeakReference<>(this);
        FILES.execute(() -> {
            try {
                Uri uri = ExportProvider.exportArtifact(context, id, name);
                new Handler(Looper.getMainLooper()).post(() -> {
                    ControlActivity current = owner.get(); if (current == null || current.isDestroyed() || !current.resumed) return;
                    try {
                        Intent share = new Intent(Intent.ACTION_SEND).setType("application/gzip").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        share.setClipData(ClipData.newRawUri(name, uri));
                        current.startActivity(Intent.createChooser(share, current.getString(R.string.share)));
                    } catch (ActivityNotFoundException e) { current.showMessage(current.getString(R.string.no_viewer)); }
                });
            } catch (Exception e) { postFailure(owner, e); }
        });
    }
    private static void postFailure(WeakReference<ControlActivity> owner, Exception error) {
        new Handler(Looper.getMainLooper()).post(() -> { ControlActivity current = owner.get(); if (current != null && !current.isDestroyed()) current.showMessage(RootApi.message(error)); });
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData(); Context context = getApplicationContext(); WeakReference<ControlActivity> owner = new WeakReference<>(this);
        if (request == PICK_BACKUP) {
            BackupImport.get(this).start(uri, data.getFlags());
        } else if (request == SAVE_ARTIFACT && saveId != null) {
            String artifact = saveId; saveId = null;
            FILES.execute(() -> {
                try (OutputStream output = context.getContentResolver().openOutputStream(uri, "wt")) {
                    if (output == null) throw new IOException(context.getString(R.string.invalid_uri));
                    RootApi.readArtifact(context, artifact, output);
                    new Handler(Looper.getMainLooper()).post(() -> { ControlActivity current = owner.get(); if (current != null && !current.isDestroyed()) current.showMessage(context.getString(R.string.saved)); });
                } catch (Exception e) { postFailure(owner, e); }
            });
        }
    }
}
