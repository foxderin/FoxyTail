package dev.foxderin.tail;

import androidx.appcompat.app.AppCompatActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.bottomnavigation.BottomNavigationView;
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
    private TextView status, feedback, heading;
    private MaterialToolbar toolbar;
    private BottomNavigationView bottomNav;
    private LinearLayout operationActions, pageHost;
    private Button cancel, acknowledge;
    private ScrollView scroll;
    private com.google.android.material.materialswitch.MaterialSwitch serviceSwitch;
    private MaterialChoice serviceModes;
    private ImageButton stripRestart;
    private JSONObject stripSnapshot;
    private boolean stripFresh, stripReading, syncing, stripBound;
    private int stripSequence;
    private final Handler stripPoller = new Handler(Looper.getMainLooper());
    /* Bottom navigation destinations, WebUI PRIMARY_NAV order. */
    static final String[] PRIMARY = {"overview", "peers", "exitnodes", "traffic", "more"};
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
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(MaterialColors.getColor(root, android.R.attr.colorBackground));
        toolbar = new MaterialToolbar(this);
        LinearLayout brand = new LinearLayout(this); brand.setOrientation(LinearLayout.HORIZONTAL); brand.setGravity(android.view.Gravity.CENTER_VERTICAL);
        ImageView mark = new ImageView(this); mark.setImageResource(R.drawable.ic_hub);
        mark.setColorFilter(androidx.core.content.ContextCompat.getColor(this, R.color.foxy_accent));
        android.graphics.drawable.GradientDrawable tile = new android.graphics.drawable.GradientDrawable();
        tile.setCornerRadius(ControlUi.dp(this, 10));
        tile.setColor(MaterialColors.getColor(mark, com.google.android.material.R.attr.colorPrimaryContainer));
        mark.setBackground(tile);
        int tilePad = ControlUi.dp(this, 6); mark.setPadding(tilePad, tilePad, tilePad, tilePad);
        brand.addView(mark, new LinearLayout.LayoutParams(ControlUi.dp(this, 32), ControlUi.dp(this, 32)));
        LinearLayout names = new LinearLayout(this); names.setOrientation(LinearLayout.VERTICAL);
        TextView appName = ControlUi.text(this, getString(R.string.app_name), 17); appName.setTypeface(null, android.graphics.Typeface.BOLD); appName.setPadding(0, 0, 0, 0); appName.setSingleLine(true);
        TextView tagline = ControlUi.muted(this, getString(R.string.app_tagline), 11); tagline.setPadding(0, 0, 0, 0); tagline.setSingleLine(true);
        names.addView(appName); names.addView(tagline);
        LinearLayout.LayoutParams namesParams = new LinearLayout.LayoutParams(-2, -2); namesParams.setMarginStart(ControlUi.dp(this, 12));
        brand.addView(names, namesParams);
        toolbar.addView(brand, new MaterialToolbar.LayoutParams(-2, -2));
        toolbar.getMenu().add(0, 1, 0, R.string.refresh).setIcon(R.drawable.ic_refresh).setShowAsAction(android.view.MenuItem.SHOW_AS_ACTION_ALWAYS);
        android.graphics.drawable.Drawable refreshIcon = toolbar.getMenu().getItem(0).getIcon();
        if (refreshIcon != null) refreshIcon.mutate().setTint(MaterialColors.getColor(toolbar, com.google.android.material.R.attr.colorOnSurfaceVariant));
        toolbar.setOnMenuItemClickListener(item -> { refreshAvailability(); stripRefresh(); if (page != null) page.load(); return true; });
        root.addView(toolbar, new LinearLayout.LayoutParams(-1, ControlUi.dp(this, 64)));
        /* WebUI fixed top strip: service switch, mode, restart — operable on every page. */
        LinearLayout strip = new LinearLayout(this); strip.setOrientation(LinearLayout.HORIZONTAL); strip.setGravity(android.view.Gravity.CENTER_VERTICAL);
        strip.setPadding(ControlUi.dp(this, 20), 0, ControlUi.dp(this, 8), 0);
        TextView serviceLabel = ControlUi.muted(this, getString(R.string.network_service), 14); serviceLabel.setPadding(0, 0, 0, 0);
        strip.addView(serviceLabel, new LinearLayout.LayoutParams(-2, -2));
        serviceSwitch = new com.google.android.material.materialswitch.MaterialSwitch(this);
        serviceSwitch.setOnCheckedChangeListener((button, checked) -> { if (!stripBound) stripControl(checked ? "start" : "stop", null); });
        LinearLayout.LayoutParams switchParams = new LinearLayout.LayoutParams(-2, -2); switchParams.setMarginStart(ControlUi.dp(this, 8));
        strip.addView(serviceSwitch, switchParams);
        serviceModes = new MaterialChoice(this, OverviewPage.MODES, 0, this::stripMode);
        LinearLayout.LayoutParams modesParams = new LinearLayout.LayoutParams(0, -2, 1);
        modesParams.setMarginStart(ControlUi.dp(this, 8)); modesParams.setMarginEnd(ControlUi.dp(this, 4));
        strip.addView(serviceModes, modesParams);
        stripRestart = new ImageButton(this); stripRestart.setImageResource(R.drawable.ic_restart_alt);
        stripRestart.setColorFilter(MaterialColors.getColor(stripRestart, com.google.android.material.R.attr.colorOnSurfaceVariant));
        android.util.TypedValue touch = new android.util.TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, touch, true);
        stripRestart.setBackgroundResource(touch.resourceId);
        stripRestart.setContentDescription(getString(R.string.network_restart));
        stripRestart.setOnClickListener(v -> stripControl("restart", null));
        strip.addView(stripRestart, new LinearLayout.LayoutParams(ControlUi.dp(this, 44), ControlUi.dp(this, 44)));
        root.addView(strip, new LinearLayout.LayoutParams(-1, -2));
        scroll = new ScrollView(this); scroll.setFillViewport(true);
        LinearLayout scrollBody = new LinearLayout(this); scrollBody.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(scrollBody, new ScrollView.LayoutParams(-1, -2));
        heading = ControlUi.pageTitle(this, ""); heading.setPadding(ControlUi.dp(this, 20), ControlUi.dp(this, 10), ControlUi.dp(this, 20), ControlUi.dp(this, 8));
        scrollBody.addView(heading);
        status = ControlUi.text(this, "", 12); status.setPadding(ControlUi.dp(this, 20), 0, ControlUi.dp(this, 20), ControlUi.dp(this, 8));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        /* Long guidance must not fill the viewport; tap expands. */
        status.setMaxLines(3); status.setEllipsize(android.text.TextUtils.TruncateAt.END);
        status.setOnClickListener(v -> {
            status.setMaxLines(status.getMaxLines() == 3 ? Integer.MAX_VALUE : 3);
            status.setEllipsize(status.getMaxLines() == 3 ? android.text.TextUtils.TruncateAt.END : null);
        });
        scrollBody.addView(status);
        operationActions = new LinearLayout(this); operationActions.setPadding(ControlUi.dp(this, 16), 0, ControlUi.dp(this, 16), 0);
        cancel = ControlUi.button(this, getString(R.string.cancel), client::cancelCurrent); operationActions.addView(cancel, new LinearLayout.LayoutParams(0, -2, 1));
        Button reconnect = ControlUi.button(this, getString(R.string.control_reconnect), () -> { client.reconnect(); refreshAvailability(); }); operationActions.addView(reconnect, new LinearLayout.LayoutParams(0, -2, 1));
        acknowledge = ControlUi.button(this, getString(R.string.control_acknowledge), () -> new MaterialAlertDialogBuilder(this)
                .setTitle(R.string.control_unknown_title).setMessage(R.string.control_unknown_warning)
                .setNegativeButton(android.R.string.cancel, null).setPositiveButton(android.R.string.ok, (d, w) -> { client.acknowledgeUnknown(); if (page != null) page.load(); }).show()); operationActions.addView(acknowledge, new LinearLayout.LayoutParams(0, -2, 1));
        scrollBody.addView(operationActions);
        feedback = ControlUi.text(this, "", 14); feedback.setPadding(ControlUi.dp(this, 20), ControlUi.dp(this, 4), ControlUi.dp(this, 20), ControlUi.dp(this, 4));
        feedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); feedback.setVisibility(View.GONE); scrollBody.addView(feedback);
        pageHost = new LinearLayout(this); pageHost.setOrientation(LinearLayout.VERTICAL); scrollBody.addView(pageHost, new LinearLayout.LayoutParams(-1, -2));
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        bottomNav = new BottomNavigationView(this);
        bottomNav.setItemActiveIndicatorColor(android.content.res.ColorStateList.valueOf(androidx.core.content.ContextCompat.getColor(this, R.color.foxy_primary_container)));
        bottomNav.setItemIconTintList(androidx.core.content.ContextCompat.getColorStateList(this, R.color.nav_item_text));
        bottomNav.setItemTextColor(androidx.core.content.ContextCompat.getColorStateList(this, R.color.nav_item_text));
        int[] navIcons = {R.drawable.nav_dashboard, R.drawable.nav_group, R.drawable.nav_logout, R.drawable.nav_monitoring, R.drawable.nav_more_horiz};
        int[] navLabels = {R.string.control_overview, R.string.control_peers, R.string.control_exitnodes, R.string.control_traffic, R.string.control_more};
        for (int i = 0; i < PRIMARY.length; i++) bottomNav.getMenu().add(0, i, i, navLabels[i]).setIcon(navIcons[i]);
        bottomNav.setOnItemSelectedListener(item -> {
            if (syncing) return true;
            navigate(PRIMARY[item.getItemId()]); return true;
        });
        root.addView(bottomNav, new LinearLayout.LayoutParams(-1, -2));
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, 0);
            bottomNav.setPadding(0, 0, 0, bars.bottom); return insets;
        });
        setContentView(root); ViewCompat.requestApplyInsets(root); showPage(destination); showOperation();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { goBack(); }
        });
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); navigate("overview"); }
    @Override protected void onResume() {
        super.onResume(); resumed = true; client.addListener(operationChanged); refreshAvailability();
        stripRefresh(); stripPoller.removeCallbacks(stripPoll); stripPoller.postDelayed(stripPoll, 15000);
        if (page != null) page.resume();
        BackupImport.get(this).observe(importChanged); deliverImport();
    }
    @Override protected void onPause() {
        resumed = false; stripPoller.removeCallbacks(stripPoll);
        if (page != null) page.pause(); client.removeListener(operationChanged); BackupImport.get(this).remove(importChanged); super.onPause();
    }
    private final Runnable stripPoll = new Runnable() {
        @Override public void run() {
            if (!resumed) return;
            if (autoRefresh) stripRefresh();
            stripPoller.postDelayed(this, powerSave ? 30000 : 15000);
        }
    };
    @Override protected void onDestroy() { if (page != null) page.close(); importCallback = null; super.onDestroy(); }
    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("page", destination); state.putBundle("drafts", drafts); state.putString("saveId", saveId); state.putString("saveName", saveName);
        state.putLong("accountRevision", observedAccountRevision);
        state.putStringArray("back", back.toArray(new String[0])); super.onSaveInstanceState(state);
    }
    private void goBack() {
        if (!back.isEmpty()) showPage(back.removeLast());
        else if (!"overview".equals(destination)) showPage("overview");
        else finish();
    }
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
            case "more": page = new MorePage(this); break;
            default: destination = "overview"; page = new OverviewPage(this);
        }
        pageHost.removeAllViews(); pageHost.addView(page.content); scroll.scrollTo(0, 0); heading.setText(page.title()); showMessage("");
        syncing = true;
        int primary = java.util.Arrays.asList(PRIMARY).indexOf(destination);
        bottomNav.getMenu().getItem(primary >= 0 ? primary : PRIMARY.length - 1).setChecked(true);
        syncing = false;
        if (resumed) page.start();
    }
    void openFiles() { startActivity(new Intent(this, MainActivity.class)); }
    /* Fixed service strip: status reads independent of the active page. */
    private void stripRefresh() {
        if (stripReading || isDestroyed()) return;
        stripReading = true; final int token = ++stripSequence;
        Context context = getApplicationContext();
        WeakReference<ControlActivity> owner = new WeakReference<>(this);
        FILES.execute(() -> {
            try {
                JSONObject result = RootApi.json(context, null, null, null, 30, new RootApi.Call(), "status");
                new Handler(Looper.getMainLooper()).post(() -> {
                    ControlActivity current = owner.get();
                    if (current == null || current.isDestroyed() || token != current.stripSequence) return;
                    current.stripReading = false; current.stripFresh = true; current.stripSnapshot = result; current.renderStrip();
                });
            } catch (Exception e) {
                new Handler(Looper.getMainLooper()).post(() -> {
                    ControlActivity current = owner.get();
                    if (current == null || current.isDestroyed() || token != current.stripSequence) return;
                    current.stripReading = false; current.stripFresh = false; current.renderStrip();
                });
            }
        });
    }
    private void renderStrip() {
        boolean known = stripFresh && OverviewPage.serviceKnown(stripSnapshot);
        boolean running = known && "running".equals(stripSnapshot.optString("daemon"));
        boolean busy = client.busy();
        stripBound = true;
        serviceSwitch.setChecked(running);
        /* Unknown state: switch stays disabled (no misleading on/off), but the
         * recovery restart stays reachable while the daemon may still be alive. */
        serviceSwitch.setEnabled(known && !busy);
        String mode = known ? stripSnapshot.optString("mode") : "tun";
        int index = java.util.Arrays.asList(OverviewPage.MODES).indexOf(mode);
        serviceModes.setSelection(Math.max(0, index));
        serviceModes.setEnabled(known && !busy);
        stripBound = false;
        stripRestart.setEnabled(!busy && (known ? running : OverviewPage.stopAvailable(stripSnapshot, stripFresh)));
    }
    private void stripMode(int index) {
        if (stripBound) return;
        stripControl("mode", OverviewPage.MODES[index]);
    }
    private void stripControl(String action, String nextMode) {
        boolean known = stripFresh && OverviewPage.serviceKnown(stripSnapshot);
        boolean allowed;
        switch (action) {
            case "start": case "mode": allowed = known; break;
            default: allowed = OverviewPage.stopAvailable(stripSnapshot, stripFresh);
        }
        if (client.busy() || !allowed) { renderStrip(); return; }
        String expectedMode = nextMode == null ? stripSnapshot == null ? "" : stripSnapshot.optString("mode") : nextMode;
        Runnable run = () -> client.submit(getString(R.string.network_service), result -> {
            showMessage(result.optBoolean("ok") ? getString(R.string.network_unverified) : getString(R.string.network_failed, result.optString("error", getString(R.string.network_unknown))));
            stripRefresh();
        }, "mode".equals(action) ? new String[]{"mode-set", expectedMode} : new String[]{"control", action});
        if ("start".equals(action)) run.run();
        else new MaterialAlertDialogBuilder(this).setTitle(R.string.network_service).setMessage(R.string.network_interrupt)
                .setNegativeButton(android.R.string.cancel, (d, w) -> renderStrip())
                .setPositiveButton(android.R.string.ok, (d, w) -> run.run()).show();
    }
    void openUrl(String value) {
        try {
            Uri uri = Uri.parse(value);
            if ((!"https".equalsIgnoreCase(uri.getScheme()) && !"http".equalsIgnoreCase(uri.getScheme())) || uri.getHost() == null || uri.getUserInfo() != null) throw new IOException(getString(R.string.control_invalid_url));
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (Exception e) { showMessage(RootApi.message(e)); }
    }
    void showMessage(String text) {
        if (text != null && text.contentEquals(status.getText())) text = "";
        if (!isDestroyed()) { feedback.setText(text); feedback.setVisibility(text == null || text.isEmpty() ? View.GONE : View.VISIBLE); }
    }
    private void showOperation() {
        if (isDestroyed()) return;
        if (observedAccountRevision != client.accountRevision()) {
            observedAccountRevision = client.accountRevision(); invalidateAccountState();
            if (resumed && page != null && ("peers".equals(destination) || "exitnodes".equals(destination) || "coexist".equals(destination))) showPage(destination);
        }
        status.setText(client.message());
        if (feedback.getText().toString().contentEquals(status.getText())) { feedback.setText(""); feedback.setVisibility(View.GONE); } cancel.setVisibility(client.canCancel() ? View.VISIBLE : View.GONE);
        acknowledge.setVisibility(client.isUnknown() ? View.VISIBLE : View.GONE);
        operationActions.setVisibility(client.busy() ? View.VISIBLE : View.GONE);
        boolean active = client.busy();
        String completed = client.lastCommand();
        if (operationWasBusy && !active && resumed && page != null) page.operationFinished(completed);
        if (operationWasBusy && !active) stripRefresh();
        operationWasBusy = active;
        renderStrip();
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
    void appearance() {
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
