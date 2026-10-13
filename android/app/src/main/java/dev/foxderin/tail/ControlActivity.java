package dev.foxderin.tail;

import androidx.appcompat.app.AppCompatActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

public class ControlActivity extends AppCompatActivity {
    private static final int PICK_BACKUP = 50, SAVE_ARTIFACT = 51;
    private static final ExecutorService FILES = Executors.newFixedThreadPool(2);
    static final String[] PAGES = {"overview", "peers", "account", "exitnodes", "tunnel", "routing", "settings", "context", "trial", "serve", "coexist", "traffic", "logs", "diagnostics", "backup"};
    static final String DESTINATION = "destination";
    private static final String[] NAV = {"overview", "peers", "exitnodes", "traffic", "tunnel", "routing", "serve", "files", "account", "logs", "settings", "diagnostics", "more"};
    private static final int[] NAV_LABELS = {R.string.web_nav_dashboard, R.string.web_nav_peers, R.string.web_nav_exitnodes, R.string.web_nav_traffic, R.string.web_tun_title, R.string.web_route_title, R.string.web_serve_title, R.string.web_files_title, R.string.web_acc_title, R.string.web_logs_title, R.string.web_set_title, R.string.web_diag_title, R.string.web_nav_more};
    private static final int[] NAV_ICONS = {R.drawable.nav_dashboard, R.drawable.nav_group, R.drawable.nav_logout, R.drawable.nav_monitoring, R.drawable.ic_router, R.drawable.ic_alt_route, R.drawable.ic_dns, R.drawable.ic_folder, R.drawable.ic_person, R.drawable.ic_article, R.drawable.ic_settings, R.drawable.ic_bug_report, R.drawable.nav_more_horiz};
    Bundle drafts;
    ControlClient client;
    private ControlPage page;
    private String destination = "overview", saveId, saveName;
    private String createdLanguage, createdTheme;
    private final ArrayDeque<String> back = new ArrayDeque<>();
    private LinearLayout root;
    private TextView status, feedback, heading, connectionBadge, desktopTitle, taskCount, serviceFeedback;
    private LinearLayout bottomNav, sideNav, taskItems;
    private View backLink;
    private PopupWindow taskPopup;
    private boolean wide;
    private final ArrayList<View> navigationItems = new ArrayList<>();
    private LinearLayout operationActions, pageHost, footerHost, serviceNotice;
    private Button cancel, acknowledge, serviceRetry;
    private androidx.core.widget.NestedScrollView scroll;
    private WebSwitch serviceSwitch;
    private MaterialChoice serviceModes;
    private ImageButton stripRestart, stripStop;
    private boolean stripBound;
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
    void setAppearance(String key, String value) {
        if (!("theme".equals(key) && java.util.Arrays.asList("auto", "light", "dark").contains(value)) &&
                !("language".equals(key) && java.util.Arrays.asList("auto", "en", "zh").contains(value))) throw new IllegalArgumentException("Invalid appearance choice");
        getSharedPreferences("interface", MODE_PRIVATE).edit().putString(key, value).apply(); recreate();
    }

    @Override protected void attachBaseContext(Context base) { super.attachBaseContext(ControlUi.localized(base)); }
    protected String initialDestination() { return "overview"; }
    protected ControlPage createFilesPage() { throw new IllegalStateException("Files require MainActivity"); }
    static String controlDestination(String name) {
        return "more".equals(name) || java.util.Arrays.asList(PAGES).contains(name) ? name : "overview";
    }
    @Override public void onCreate(Bundle saved) {
        ControlUi.appearance(this);
        super.onCreate(saved);
        android.content.SharedPreferences appearance = getSharedPreferences("interface", MODE_PRIVATE);
        createdLanguage = appearance.getString("language", "auto"); createdTheme = appearance.getString("theme", "auto");
        drafts = saved == null || saved.getBundle("drafts") == null ? new Bundle() : saved.getBundle("drafts");
        destination = "files".equals(initialDestination()) ? "files" : controlDestination(getIntent().getStringExtra(DESTINATION));
        if (saved != null) {
            if (!"files".equals(destination)) destination = controlDestination(saved.getString("page", destination));
            saveId = saved.getString("saveId"); saveName = saved.getString("saveName");
            String[] history = saved.getStringArray("back"); if (history != null) for (String item : history) back.addLast(controlDestination(item));
        }
        client = ControlClient.get(this);
        observedAccountRevision = saved == null ? client.accountRevision() : saved.getLong("accountRevision", -1);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        buildShell();
        setContentView(root); ViewCompat.requestApplyInsets(root); showPage(destination); showOperation();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { goBack(); }
        });
    }
    private int dp(int value) { return ControlUi.dp(this, value); }
    private int color(int attribute) { return MaterialColors.getColor(root, attribute); }
    private android.graphics.drawable.GradientDrawable surface(int radius, boolean border) {
        android.graphics.drawable.GradientDrawable drawable = new android.graphics.drawable.GradientDrawable();
        drawable.setColor(color(com.google.android.material.R.attr.colorSurface)); drawable.setCornerRadius(dp(radius));
        if (border) drawable.setStroke(dp(1), color(com.google.android.material.R.attr.colorOutlineVariant));
        return drawable;
    }
    private TextView text(String value, int size, boolean muted) {
        TextView view = ControlUi.text(this, value, size); view.setPadding(0, 0, 0, 0); view.setIncludeFontPadding(false);
        if (muted) view.setTextColor(color(com.google.android.material.R.attr.colorOnSurfaceVariant));
        return view;
    }
    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private LinearLayout row() { LinearLayout view = new LinearLayout(this); view.setGravity(android.view.Gravity.CENTER_VERTICAL); return view; }
    private void line(LinearLayout parent) { View line = new View(this); line.setBackgroundColor(color(com.google.android.material.R.attr.colorOutlineVariant)); parent.addView(line, new LinearLayout.LayoutParams(-1, dp(1))); }
    private LinearLayout brand() {
        LinearLayout brand = row(); brand.setMinimumHeight(dp(44)); brand.setContentDescription("FoxyTail");
        ImageView icon = new ImageView(this); icon.setImageResource(R.drawable.ic_hub); icon.setPadding(dp(4), dp(4), dp(4), dp(4)); icon.setColorFilter(color(androidx.appcompat.R.attr.colorPrimary));
        android.graphics.drawable.GradientDrawable tile = surface(12, false); tile.setColor(color(com.google.android.material.R.attr.colorPrimaryContainer)); icon.setBackground(tile); brand.addView(icon, new LinearLayout.LayoutParams(dp(38), dp(38)));
        LinearLayout names = column(); TextView name = text("FoxyTail", wide ? 20 : 19, false); name.setTypeface(null, android.graphics.Typeface.BOLD); name.setLetterSpacing(-0.026f); name.setSingleLine(true); names.addView(name, new LinearLayout.LayoutParams(-2, -2));
        TextView workspace = text(getString(R.string.web_shell_workspace), 10, true); workspace.setLetterSpacing(0.04f); LinearLayout.LayoutParams subtitle = new LinearLayout.LayoutParams(-2, -2); subtitle.topMargin = dp(1); names.addView(workspace, subtitle);
        LinearLayout.LayoutParams copy = new LinearLayout.LayoutParams(-2, -2); copy.setMarginStart(dp(10)); brand.addView(names, copy); brand.setOnClickListener(v -> navigate("overview")); return brand;
    }
    private void buildShell() {
        int width = getResources().getConfiguration().screenWidthDp;
        wide = width >= 960; int inset = width < 380 ? 16 : wide ? 36 : width >= 640 ? 28 : 20;
        root = row(); root.setGravity(android.view.Gravity.TOP); root.setBackgroundColor(MaterialColors.getColor(root, android.R.attr.colorBackground));
        if (wide) buildSidebar();
        LinearLayout main = column(); root.addView(main, new LinearLayout.LayoutParams(0, -1, 1));
        LinearLayout header = new LinearLayout(this); header.setOrientation(width >= 1200 ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL); header.setGravity(android.view.Gravity.CENTER_VERTICAL); header.setBackground(surface(0, false)); header.setPadding(dp(inset), dp(wide ? 14 : 12), dp(inset), dp(wide ? 14 : 12)); main.addView(header, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout primary = row(); primary.setMinimumHeight(dp(44));
        header.addView(primary, width >= 1200 ? new LinearLayout.LayoutParams(0, -2, 1) : new LinearLayout.LayoutParams(-1, -2));
        if (wide) {
            LinearLayout context = row(); TextView workspace = text(getString(R.string.web_shell_workspace), 12, true); context.addView(workspace);
            ImageView chevron = new ImageView(this); chevron.setImageResource(R.drawable.ic_chevron_right); chevron.setColorFilter(color(com.google.android.material.R.attr.colorOnSurfaceVariant)); LinearLayout.LayoutParams arrow = new LinearLayout.LayoutParams(dp(16), dp(16)); arrow.setMargins(dp(12), 0, dp(12), 0); context.addView(chevron, arrow);
            desktopTitle = text("", 12, false); context.addView(desktopTitle, new LinearLayout.LayoutParams(0, -2, 1)); primary.addView(context, new LinearLayout.LayoutParams(0, -2, 1));
        } else primary.addView(brand(), new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout tasks = row(); tasks.setPadding(dp(11), 0, dp(11), 0); tasks.setMinimumHeight(dp(44)); tasks.setMinimumWidth(dp(44)); tasks.setBackground(surface(12, true)); tasks.setContentDescription(getString(R.string.web_shell_tasks)); tasks.setFocusable(true); tasks.setOnClickListener(v -> openTasks(tasks));
        ImageView taskIcon = new ImageView(this); taskIcon.setImageResource(R.drawable.ic_sync); taskIcon.setColorFilter(color(com.google.android.material.R.attr.colorOnSurfaceVariant)); tasks.addView(taskIcon, new LinearLayout.LayoutParams(dp(20), dp(20)));
        if (width >= 640) { TextView label = text(getString(R.string.web_shell_tasks), 12, true); LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-2, -2); p.setMarginStart(dp(8)); tasks.addView(label, p); }
        taskCount = text("", 10, false); taskCount.setGravity(android.view.Gravity.CENTER); taskCount.setTextColor(color(androidx.appcompat.R.attr.colorPrimary)); android.graphics.drawable.GradientDrawable countBackground = surface(6, false); countBackground.setColor(color(com.google.android.material.R.attr.colorPrimaryContainer)); taskCount.setBackground(countBackground); LinearLayout.LayoutParams countParams = new LinearLayout.LayoutParams(dp(18), dp(18)); countParams.setMarginStart(dp(8)); tasks.addView(taskCount, countParams); primary.addView(tasks);
        connectionBadge = text("", width >= 640 ? 12 : 11, true); connectionBadge.setPadding(dp(9), dp(6), dp(9), dp(6)); connectionBadge.setSingleLine(true); connectionBadge.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); LinearLayout.LayoutParams badgeParams = new LinearLayout.LayoutParams(-2, -2); badgeParams.setMarginStart(dp(width >= 640 ? 16 : 10)); primary.addView(connectionBadge, badgeParams);
        connectionBadge.setContentDescription(getString(R.string.web_net_refresh)); connectionBadge.setOnClickListener(v -> refreshShell());
        LinearLayout service = column(); LinearLayout.LayoutParams serviceParams = new LinearLayout.LayoutParams(width >= 1200 ? dp(336) : -1, -2);
        if (width >= 1200) {
            View border = new View(this); border.setBackgroundColor(color(com.google.android.material.R.attr.colorOutlineVariant)); LinearLayout.LayoutParams borderParams = new LinearLayout.LayoutParams(dp(1), dp(48)); borderParams.setMarginStart(dp(24)); header.addView(border, borderParams); service.setPadding(dp(24), 0, 0, 0);
        } else { serviceParams.topMargin = dp(10); line(service); }
        header.addView(service, serviceParams);
        LinearLayout controls = row(); if (width < 1200) controls.setPadding(0, dp(10), 0, 0); service.addView(controls);
        TextView serviceLabel = text(getString(R.string.web_net_controls_service), 12, false); serviceLabel.setTypeface(null, android.graphics.Typeface.BOLD); controls.addView(serviceLabel);
        serviceSwitch = new WebSwitch(this); serviceSwitch.setContentDescription(getString(R.string.web_net_controls_service)); serviceSwitch.setOnCheckedChangeListener((button, checked) -> { if (!stripBound) { renderStrip(); stripControl(checked ? "start" : "stop", null); } });
        LinearLayout.LayoutParams switchParams = new LinearLayout.LayoutParams(dp(52), dp(48)); switchParams.setMarginStart(dp(8)); controls.addView(serviceSwitch, switchParams);
        serviceModes = new MaterialChoice(this, new String[]{getString(R.string.web_net_mode_tun), getString(R.string.web_net_mode_bridge), getString(R.string.web_net_mode_proxy)}, -1, this::stripMode); serviceModes.setContentDescription(getString(R.string.web_dash_mode)); serviceModes.getEditText().setTextSize(12);
        serviceModes.setMinimumHeight(dp(48)); serviceModes.getEditText().setPadding(dp(13), dp(10), dp(36), dp(10));
        LinearLayout.LayoutParams modeParams = new LinearLayout.LayoutParams(0, -2, 1); modeParams.setMargins(dp(10), 0, dp(10), 0); controls.addView(serviceModes, modeParams);
        stripRestart = ControlUi.iconButton(this, R.drawable.ic_restart_alt, getString(R.string.web_dash_restart), () -> stripControl("restart", null)); stripRestart.setBackground(surface(10, true)); controls.addView(stripRestart, new LinearLayout.LayoutParams(dp(44), dp(44)));
        stripStop = ControlUi.iconButton(this, R.drawable.ic_stop, getString(R.string.repair_shell_stop), () -> stripControl("stop", null)); stripStop.setBackground(surface(10, true)); LinearLayout.LayoutParams stopParams = new LinearLayout.LayoutParams(dp(44), dp(44)); stopParams.topMargin = dp(8); stopParams.gravity = android.view.Gravity.END; service.addView(stripStop, stopParams);
        serviceNotice = row(); LinearLayout.LayoutParams noticeParams = new LinearLayout.LayoutParams(-1, -2); noticeParams.topMargin = dp(8); service.addView(serviceNotice, noticeParams);
        serviceFeedback = text("", 11, true); serviceFeedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); serviceNotice.addView(serviceFeedback, new LinearLayout.LayoutParams(0, -2, 1));
        serviceRetry = ControlUi.textButton(this, getString(R.string.web_retry), this::refreshShell); serviceNotice.addView(serviceRetry); serviceNotice.setVisibility(View.GONE);
        line(main);
        scroll = new androidx.core.widget.NestedScrollView(this); scroll.setFillViewport(true); main.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout scrollBody = column(); scrollBody.setPadding(0, dp(wide ? 36 : width >= 640 ? 32 : 24), 0, 0); scroll.addView(scrollBody, new FrameLayout.LayoutParams(-1, -2));
        Button backlink = ControlUi.textButton(this, getString(R.string.web_shell_back_tools), () -> navigate("more")); backlink.setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.ic_arrow_back, 0, 0, 0); backlink.setTextSize(12); LinearLayout.LayoutParams backParams = new LinearLayout.LayoutParams(-2, -2); backParams.setMarginStart(dp(inset - 5)); backParams.topMargin = -dp(12); backParams.bottomMargin = dp(4); scrollBody.addView(backlink, backParams); backLink = backlink;
        heading = text("", Math.min(32, Math.max(26, Math.round(width * 0.04f))), false); heading.setTypeface(null, android.graphics.Typeface.BOLD); heading.setLetterSpacing(-0.025f); heading.setLineHeight(Math.round(heading.getTextSize() * 1.25f)); heading.setPadding(dp(inset), 0, dp(inset), dp(24)); scrollBody.addView(heading);
        status = text("", 12, true); status.setPadding(dp(inset), 0, dp(inset), dp(8)); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); status.setVisibility(View.GONE); scrollBody.addView(status);
        operationActions = row(); operationActions.setPadding(dp(inset), 0, dp(inset), 0);
        cancel = ControlUi.textButton(this, getString(R.string.web_cancel), client::cancelCurrent); operationActions.addView(cancel, new LinearLayout.LayoutParams(0, -2, 1));
        Button reconnect = ControlUi.textButton(this, getString(R.string.control_reconnect), () -> { client.reconnect(); refreshAvailability(); }); operationActions.addView(reconnect, new LinearLayout.LayoutParams(0, -2, 1));
        acknowledge = ControlUi.textButton(this, getString(R.string.control_acknowledge), () -> new MaterialAlertDialogBuilder(this).setTitle(R.string.control_unknown_title).setMessage(R.string.control_unknown_warning).setNegativeButton(android.R.string.cancel, null).setPositiveButton(android.R.string.ok, (d, w) -> { client.acknowledgeUnknown(); if (page != null) page.load(); }).show()); operationActions.addView(acknowledge, new LinearLayout.LayoutParams(0, -2, 1)); scrollBody.addView(operationActions);
        feedback = text("", 13, true); feedback.setPadding(dp(inset), dp(4), dp(inset), dp(8)); feedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); feedback.setVisibility(View.GONE); scrollBody.addView(feedback);
        pageHost = column(); scrollBody.addView(pageHost, new LinearLayout.LayoutParams(-1, -2));
        footerHost = column(); main.addView(footerHost, new LinearLayout.LayoutParams(-1, -2));
        bottomNav = row(); bottomNav.setBackground(surface(0, false)); bottomNav.setPadding(dp(8), dp(4), dp(8), dp(4));
        if (!wide) { line(main); for (String route : PRIMARY) addNavigation(bottomNav, java.util.Arrays.asList(NAV).indexOf(route), true); main.addView(bottomNav, new LinearLayout.LayoutParams(-1, dp(74))); }
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, wide ? bars.bottom : 0);
            if (!wide) { bottomNav.setPadding(dp(8), dp(4), dp(8), dp(4) + bars.bottom); bottomNav.getLayoutParams().height = dp(74) + bars.bottom; }
            return insets;
        });
    }
    private void refreshShell() { refreshAvailability(); refreshStatus(); if (page != null) page.load(); }
    private void buildSidebar() {
        ScrollView sidebarScroll = new ScrollView(this); sidebarScroll.setFillViewport(true); sidebarScroll.setBackground(surface(0, false)); root.addView(sidebarScroll, new LinearLayout.LayoutParams(dp(231), -1));
        sideNav = column(); sideNav.setPadding(dp(18), dp(28), dp(18), dp(20)); sidebarScroll.addView(sideNav, new ScrollView.LayoutParams(-1, -2));
        LinearLayout brand = brand(); brand.setPadding(dp(8), 0, dp(8), 0); LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2); p.bottomMargin = dp(30); sideNav.addView(brand, p);
        int[] groups = {R.string.web_shell_network, R.string.web_shell_services, R.string.web_shell_manage};
        for (int group = 0; group < groups.length; group++) {
            TextView title = text(getString(groups[group]).toUpperCase(getResources().getConfiguration().getLocales().get(0)), 10, true); title.setTypeface(null, android.graphics.Typeface.BOLD); title.setLetterSpacing(0.07f); title.setPadding(dp(12), group == 0 ? 0 : dp(24), dp(12), dp(8)); sideNav.addView(title);
            for (int index = group * 4; index < (group == 2 ? NAV.length : group * 4 + 4); index++) addNavigation(sideNav, index, false);
        }
        View space = new View(this); sideNav.addView(space, new LinearLayout.LayoutParams(1, 0, 1));
        TextView footer = text("Tailscale / FoxyTail", 11, true); footer.setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.ic_router, 0, 0, 0); footer.setCompoundDrawablePadding(dp(8)); footer.setPadding(dp(8), dp(28), 0, 0); sideNav.addView(footer);
        View border = new View(this); border.setBackgroundColor(color(com.google.android.material.R.attr.colorOutlineVariant)); root.addView(border, new LinearLayout.LayoutParams(dp(1), -1));
    }
    private void addNavigation(LinearLayout parent, int index, boolean bottom) {
        LinearLayout item = bottom ? column() : row(); item.setGravity(android.view.Gravity.CENTER_VERTICAL | (bottom ? android.view.Gravity.CENTER_HORIZONTAL : android.view.Gravity.START)); item.setTag(NAV[index]); item.setFocusable(true); item.setOnClickListener(v -> navigate(NAV[index]));
        ImageView icon = new ImageView(this); icon.setImageResource(NAV_ICONS[index]); icon.setPadding(bottom ? dp(13) : 0, bottom ? dp(4) : 0, bottom ? dp(13) : 0, bottom ? dp(4) : 0); item.addView(icon, new LinearLayout.LayoutParams(dp(bottom ? 48 : 20), dp(bottom ? 30 : 20)));
        TextView label = text(getString(NAV_LABELS[index]), bottom ? getResources().getConfiguration().screenWidthDp >= 640 ? 11 : 10 : 12, true); LinearLayout.LayoutParams copy = new LinearLayout.LayoutParams(-2, -2); if (bottom) copy.topMargin = dp(3); else copy.setMarginStart(dp(11)); item.addView(label, copy);
        if (bottom) parent.addView(item, new LinearLayout.LayoutParams(0, -1, 1)); else { item.setMinimumHeight(dp(44)); item.setPadding(dp(12), dp(10), dp(12), dp(10)); LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2); p.setMargins(0, dp(2), 0, dp(2)); parent.addView(item, p); }
        navigationItems.add(item);
    }
    private void openTasks(View anchor) {
        if (taskPopup != null && taskPopup.isShowing()) { taskPopup.dismiss(); return; }
        taskItems = column(); taskItems.setPadding(dp(8), dp(8), dp(8), dp(8)); taskItems.setBackground(surface(16, true));
        ScrollView body = new ScrollView(this); body.addView(taskItems);
        int width = getResources().getConfiguration().screenWidthDp;
        taskPopup = new PopupWindow(body, dp(width >= 640 ? 340 : width - 32), -2, true); taskPopup.setBackgroundDrawable(surface(16, true)); taskPopup.setElevation(dp(12)); taskPopup.setOutsideTouchable(true);
        taskPopup.setOnDismissListener(() -> taskItems = null); renderTasks();
        if (width >= 640) taskPopup.showAsDropDown(anchor, 0, dp(10), android.view.Gravity.END);
        else { int[] position = new int[2]; scroll.getLocationInWindow(position); taskPopup.showAtLocation(root, android.view.Gravity.TOP | android.view.Gravity.START, dp(16), position[1] + dp(8)); }
    }
    private String taskDestination(String command) {
        switch (command) {
            case "control": case "mode-set": return "overview";
            case "speedtest-exitnodes": case "exitnode": return "exitnodes";
            case "derp-speedtest": return "tunnel";
            case "diag": case "diag-check": return "diagnostics";
            case "file-receive": case "file-delete": return "files";
            case "backup": case "restore": case "settings-save": return "settings";
            case "subnet-routes": case "routing-save": return "routing";
            case "ping": return "peers";
            case "login-authkey": case "login": case "logout": case "switch": return "account";
            default: return "more";
        }
    }
    private int taskLabel(String command) {
        switch (command) {
            case "speedtest-exitnodes": return R.string.web_exit_test;
            case "derp-speedtest": return R.string.web_tun_derp;
            case "diag": return R.string.web_diag_run;
            case "diag-check": return R.string.web_diag_check;
            case "file-receive": return R.string.web_files_receive;
            case "backup": return R.string.web_set_backup;
            case "restore": return R.string.web_set_restore;
            case "settings-save": return R.string.web_set_title;
            case "control": case "mode-set": return R.string.web_shell_services;
            case "subnet-routes": return R.string.web_tools_subnet_accept;
            case "ping": return R.string.web_net_peer_probe;
            default: return 0;
        }
    }
    private void renderTasks() {
        ArrayList<ControlClient.TaskEntry> tasks = client.tasks();
        int running = 0; for (ControlClient.TaskEntry task : tasks) if ("running".equals(task.state)) running++;
        taskCount.setText(Integer.toString(running)); taskCount.setVisibility(running == 0 ? View.GONE : View.VISIBLE);
        if (taskItems == null) return;
        taskItems.removeAllViews(); TextView heading = text(getString(R.string.web_shell_tasks), 13, false); heading.setTypeface(null, android.graphics.Typeface.BOLD); heading.setPadding(dp(10), dp(10), dp(10), dp(8)); taskItems.addView(heading);
        if (tasks.isEmpty()) { TextView empty = text(getString(R.string.web_shell_no_tasks), 13, true); empty.setPadding(dp(10), dp(20), dp(10), dp(20)); taskItems.addView(empty); return; }
        for (ControlClient.TaskEntry task : tasks) {
            String destination = taskDestination(task.command); int index = java.util.Arrays.asList(NAV).indexOf(destination);
            LinearLayout item = row(); item.setPadding(dp(10), dp(12), dp(10), dp(12)); item.setFocusable(true); item.setOnClickListener(v -> { taskPopup.dismiss(); navigate(destination); });
            ImageView icon = new ImageView(this); icon.setImageResource(NAV_ICONS[index]); icon.setColorFilter(color(androidx.appcompat.R.attr.colorPrimary)); icon.setPadding(dp(8), dp(8), dp(8), dp(8)); android.graphics.drawable.GradientDrawable tile = surface(10, false); tile.setColor(color(com.google.android.material.R.attr.colorPrimaryContainer)); icon.setBackground(tile); item.addView(icon, new LinearLayout.LayoutParams(dp(36), dp(36)));
            LinearLayout copy = column(); LinearLayout.LayoutParams copyParams = new LinearLayout.LayoutParams(0, -2, 1); copyParams.setMargins(dp(12), 0, dp(12), 0); item.addView(copy, copyParams);
            int title = taskLabel(task.command); TextView label = text(title == 0 ? task.label : getString(title), 13, false); label.setTypeface(null, android.graphics.Typeface.BOLD); copy.addView(label);
            int state = "running".equals(task.state) ? "requested".equals(task.cancellation) ? R.string.web_task_cancel_pending : "failed".equals(task.cancellation) ? R.string.web_task_cancel_failed : R.string.web_shell_task_running
                    : "done".equals(task.state) ? R.string.web_shell_task_done : "cancelled".equals(task.state) ? R.string.web_shell_task_cancelled : "unknown".equals(task.state) ? R.string.web_shell_unknown : R.string.web_shell_task_error;
            copy.addView(text(getString(state), 11, true));
            if (("error".equals(task.state) || "unknown".equals(task.state)) && !task.detail.isEmpty()) copy.addView(text(task.detail, 11, true));
            TextView dot = text("●", 11, false); dot.setTextColor("done".equals(task.state) ? androidx.core.content.ContextCompat.getColor(this, R.color.foxy_ok) : color("running".equals(task.state) ? com.google.android.material.R.attr.colorTertiary : com.google.android.material.R.attr.colorOutline)); item.addView(dot); taskItems.addView(item);
        }
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        if (!"files".equals(initialDestination()) && intent.hasExtra(DESTINATION)) navigate(controlDestination(intent.getStringExtra(DESTINATION)));
    }
    @Override protected void onResume() {
        super.onResume();
        android.content.SharedPreferences appearance = getSharedPreferences("interface", MODE_PRIVATE);
        if (!createdLanguage.equals(appearance.getString("language", "auto")) || !createdTheme.equals(appearance.getString("theme", "auto"))) { recreate(); return; }
        resumed = true; client.addListener(operationChanged); showOperation(); refreshAvailability();
        if (page != null) page.resume();
        refreshStatus(); stripPoller.removeCallbacks(stripPoll); stripPoller.postDelayed(stripPoll, 15000);
        BackupImport.get(this).observe(importChanged); deliverImport();
    }
    @Override protected void onPause() {
        resumed = false; stripPoller.removeCallbacks(stripPoll);
        if (page != null) page.pause(); cancelShellReads(); client.removeListener(operationChanged); BackupImport.get(this).remove(importChanged); super.onPause();
    }
    private final Runnable stripPoll = new Runnable() {
        @Override public void run() {
            if (!resumed) return;
            if (autoRefresh) refreshStatus();
            stripPoller.postDelayed(this, powerSave ? 30000 : 15000);
        }
    };
    @Override protected void onDestroy() { cancelShellReads(); if (taskPopup != null) taskPopup.dismiss(); if (page != null) page.close(); importCallback = null; super.onDestroy(); }
    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("page", destination); state.putBundle("drafts", drafts); state.putString("saveId", saveId); state.putString("saveName", saveName);
        state.putLong("accountRevision", observedAccountRevision);
        state.putStringArray("back", back.toArray(new String[0])); super.onSaveInstanceState(state);
    }
    private void goBack() {
        if ("files".equals(destination)) finish();
        else if (!back.isEmpty()) showPage(back.removeLast());
        else if (!"overview".equals(destination)) showPage("overview");
        else finish();
    }
    void navigate(String name) {
        if ("files".equals(name)) { openFiles(); return; }
        name = controlDestination(name);
        if (destination.equals(name)) return;
        back.addLast(destination);
        showPage(name);
    }
    private void showPage(String name) {
        if (page != null) page.close();
        statusListeners.clear();
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
            case "files": page = createFilesPage(); break;
            case "more": page = new MorePage(this); break;
            default: destination = "overview"; page = new OverviewPage(this);
        }
        pageHost.removeAllViews(); pageHost.addView(page.content); scroll.scrollTo(0, 0); heading.setText(page.title()); showMessage("");
        footerHost.removeAllViews(); footerHost.addView(page.stickyActions, new LinearLayout.LayoutParams(-1, -2));
        /* WebUI ft-page-in: 160ms fade + 5px rise; honor reduced motion. */
        float animatorScale = android.provider.Settings.Global.getFloat(getContentResolver(), android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f);
        if (animatorScale > 0) {
            page.content.setAlpha(0.5f); page.content.setTranslationY(ControlUi.dp(this, 5));
            page.content.animate().alpha(1f).translationY(0).setDuration(160).start();
        }
        int primary = java.util.Arrays.asList(PRIMARY).indexOf(destination);
        backLink.setVisibility(primary < 0 ? View.VISIBLE : View.GONE);
        if (desktopTitle != null) desktopTitle.setText(page.title());
        for (View view : navigationItems) {
            LinearLayout item = (LinearLayout) view; boolean selected = item.getTag().equals(wide ? destination : primary < 0 ? "more" : destination);
            item.setSelected(selected); ImageView icon = (ImageView) item.getChildAt(0); TextView label = (TextView) item.getChildAt(1);
            int tint = color(selected ? androidx.appcompat.R.attr.colorPrimary : com.google.android.material.R.attr.colorOnSurfaceVariant); icon.setColorFilter(tint); label.setTextColor(tint); label.setTypeface(null, selected ? android.graphics.Typeface.BOLD : android.graphics.Typeface.NORMAL);
            android.graphics.drawable.GradientDrawable background = surface(10, false); background.setColor(selected ? color(com.google.android.material.R.attr.colorPrimaryContainer) : android.graphics.Color.TRANSPARENT);
            if (wide) item.setBackground(background); else icon.setBackground(background);
        }
        if (resumed) page.start();
    }
    void openFiles() { startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP)); }
    protected void scrollToSection(View section) {
        scroll.post(() -> {
            if (isDestroyed() || section.getParent() == null) return;
            android.graphics.Rect bounds = new android.graphics.Rect(); section.getDrawingRect(bounds);
            scroll.offsetDescendantRectToMyCoords(section, bounds); scroll.smoothScrollTo(0, bounds.top);
        });
    }
    /* Shared status store (WebUI state.ts): the only source of visible service
     * state. The strip, the overview and every listener render from the same
     * snapshot; mutations verify against the next shared read. */
    private JSONObject sharedStatus;
    private String statusError;
    private boolean statusFresh, statusLoading, statusEverLoaded;
    private int statusSequence, statusRevision;
    private RootApi.Call statusCall, settingsCall;
    private final ArrayList<RootApi.Call> shellCalls = new ArrayList<>();
    private final Map<ControlPage, StatusRead> statusReads = new LinkedHashMap<>();
    private static final class StatusRead {
        final Consumer<JSONObject> success;
        final Consumer<Exception> failure;
        StatusRead(Consumer<JSONObject> success, Consumer<Exception> failure) { this.success = success; this.failure = failure; }
    }
    private final ArrayList<java.util.function.Consumer<JSONObject>> statusListeners = new ArrayList<>();
    JSONObject statusSnapshot() { return sharedStatus; }
    String statusError() { return statusError; }
    boolean statusFresh() { return statusFresh; }
    boolean statusEverLoaded() { return statusEverLoaded; }
    void addStatusListener(java.util.function.Consumer<JSONObject> listener) {
        statusListeners.add(listener);
        if (statusEverLoaded || statusError != null) listener.accept(sharedStatus);
    }
    void readStatus(ControlPage owner, Consumer<JSONObject> success, Consumer<Exception> failure) {
        statusReads.put(owner, new StatusRead(success, failure));
        refreshStatus();
    }
    void removeStatusRead(ControlPage owner) { statusReads.remove(owner); }
    void refreshStatus() {
        if (!resumed || isDestroyed() || statusLoading || client.busy()) return;
        statusLoading = true; final int token = ++statusSequence, revision = statusRevision;
        RootApi.Call call = new RootApi.Call(); statusCall = call; shellCalls.add(call);
        Context context = getApplicationContext();
        WeakReference<ControlActivity> owner = new WeakReference<>(this);
        call.submit(FILES, () -> {
            JSONObject result = null; Exception error = null;
            try { result = RootApi.json(context, RootApi.requestId(), null, null, 30, call, "status"); }
            catch (Exception e) { error = e; }
            finally { call.finished = true; }
            JSONObject loaded = result; Exception failure = error;
            new Handler(Looper.getMainLooper()).post(() -> {
                ControlActivity current = owner.get();
                if (current == null) return;
                current.shellCalls.remove(call);
                if (current.isDestroyed() || !current.resumed || token != current.statusSequence) return;
                current.statusCall = null;
                current.completeStatus(loaded, failure, revision);
            });
        });
    }
    private void completeStatus(JSONObject result, Exception error, int revision) {
        statusLoading = false;
        if (revision != statusRevision || client.busy()) {
            statusFresh = false;
            refreshStatus();
            return;
        }
        statusEverLoaded = true; statusError = error == null ? null : RootApi.message(error);
        statusFresh = error == null;
        if (result != null) sharedStatus = result;
        ArrayList<Map.Entry<ControlPage, StatusRead>> consumers = new ArrayList<>(statusReads.entrySet());
        statusReads.clear();
        publishStatus();
        for (Map.Entry<ControlPage, StatusRead> consumer : consumers) {
            if (!consumer.getKey().isCurrent()) continue;
            if (revision != statusRevision || client.busy()) { statusReads.putIfAbsent(consumer.getKey(), consumer.getValue()); continue; }
            if (error == null) consumer.getValue().success.accept(result); else consumer.getValue().failure.accept(error);
        }
        if (!statusReads.isEmpty()) refreshStatus();
    }
    private void cancelShellReads() {
        statusSequence++; statusLoading = false; statusFresh = false;
        statusCall = null; settingsCall = null; statusReads.clear();
        for (RootApi.Call call : new ArrayList<>(shellCalls)) call.cancel();
        shellCalls.removeIf(call -> call.finished);
    }
    private void invalidateStatus() {
        statusRevision++; statusFresh = false;
        if (statusCall != null) {
            statusCall.cancel();
            if (statusCall.finished) {
                shellCalls.remove(statusCall); statusCall = null;
                statusSequence++; statusLoading = false;
            }
        }
    }
    private void publishStatus() {
        renderStrip();
        for (java.util.function.Consumer<JSONObject> listener : new ArrayList<>(statusListeners)) listener.accept(sharedStatus);
    }
    private void renderStrip() {
        boolean known = statusFresh && OverviewPage.serviceKnown(sharedStatus);
        boolean observed = OverviewPage.serviceKnown(sharedStatus);
        boolean running = observed && "running".equals(sharedStatus.optString("daemon"));
        boolean busy = client.busy();
        stripBound = true;
        serviceSwitch.setChecked(running);
        serviceSwitch.setIndeterminate(!known);
        serviceSwitch.setEnabled(known && !busy && (running ? client.canStop() : client.canWrite()));
        String mode = observed ? sharedStatus.optString("mode") : "";
        int index = java.util.Arrays.asList(OverviewPage.MODES).indexOf(mode);
        serviceModes.setSelection(index);
        serviceModes.setEnabled(known && !busy && client.canWrite());
        stripBound = false;
        stripRestart.setEnabled(!busy && client.canWrite() && known && running);
        boolean canStop = client.canStop() && OverviewPage.stopAvailable(sharedStatus, statusFresh);
        stripStop.setVisibility(canStop && (!known || !client.canWrite()) ? View.VISIBLE : View.GONE);
        stripStop.setEnabled(canStop && !busy);
        int connection = OverviewPage.connectionLabel(sharedStatus);
        int label = statusError != null ? R.string.web_dash_status_stale : !statusEverLoaded ? R.string.web_shell_starting
                : connection == R.string.network_connected ? R.string.web_shell_connected
                : connection == R.string.network_login_needed ? R.string.web_shell_login
                : connection == R.string.network_stopped ? R.string.web_shell_stopped
                : connection == R.string.network_starting ? R.string.web_shell_starting : R.string.web_shell_unknown;
        boolean connected = label == R.string.web_shell_connected, warning = label == R.string.web_shell_starting || label == R.string.web_shell_login || label == R.string.web_dash_status_stale;
        android.text.SpannableString connectionText = new android.text.SpannableString("● " + getString(label));
        int dot = connected ? androidx.core.content.ContextCompat.getColor(this, R.color.foxy_ok) : color(warning ? com.google.android.material.R.attr.colorTertiary : com.google.android.material.R.attr.colorOutline);
        connectionText.setSpan(new android.text.style.ForegroundColorSpan(dot), 0, 1, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE); connectionBadge.setText(connectionText);
        android.graphics.drawable.GradientDrawable badge = surface(7, false); badge.setColor(connected ? androidx.core.content.ContextCompat.getColor(this, R.color.foxy_ok_soft) : color(warning ? com.google.android.material.R.attr.colorTertiaryContainer : com.google.android.material.R.attr.colorSurfaceContainer)); connectionBadge.setBackground(badge);
        connectionBadge.setTextColor(connected ? androidx.core.content.ContextCompat.getColor(this, R.color.foxy_ok) : color(warning ? com.google.android.material.R.attr.colorOnTertiaryContainer : com.google.android.material.R.attr.colorOnSurfaceVariant));
        boolean serviceBusy = busy && ("control".equals(client.lastCommand()) || "mode-set".equals(client.lastCommand()));
        serviceNotice.setVisibility(serviceBusy || (!known && statusEverLoaded) ? View.VISIBLE : View.GONE);
        serviceFeedback.setText(getString(serviceBusy ? R.string.web_net_working : R.string.web_net_controls_unknown));
        serviceFeedback.setTextColor(color(serviceBusy ? com.google.android.material.R.attr.colorOnSurfaceVariant : com.google.android.material.R.attr.colorOnTertiaryContainer));
        serviceRetry.setVisibility(!busy && !known ? View.VISIBLE : View.GONE);
    }
    private void stripMode(int index) {
        if (stripBound || index < 0 || index >= OverviewPage.MODES.length) return;
        renderStrip();
        stripControl("mode", OverviewPage.MODES[index]);
    }
    private void stripControl(String action, String nextMode) {
        boolean known = statusFresh && OverviewPage.serviceKnown(sharedStatus);
        boolean allowed;
        switch (action) {
            case "start": case "mode": allowed = known && client.canWrite(); break;
            case "restart": allowed = known && "running".equals(sharedStatus.optString("daemon")) && client.canWrite(); break;
            case "stop": allowed = client.canStop() && OverviewPage.stopAvailable(sharedStatus, statusFresh); break;
            default: allowed = false;
        }
        if (client.busy() || !allowed) { renderStrip(); return; }
        String expectedMode = nextMode == null ? sharedStatus == null ? "" : sharedStatus.optString("mode") : nextMode;
        Runnable run = () -> {
            client.submit(getString(R.string.network_service), result -> {
                showMessage(result.optBoolean("ok") ? getString(R.string.network_unverified) : getString(R.string.network_failed, result.optString("error", getString(R.string.network_unknown))));
            }, "mode".equals(action) ? new String[]{"mode-set", expectedMode} : new String[]{"control", action});
            renderStrip();
        };
        if ("start".equals(action)) run.run();
        else new MaterialAlertDialogBuilder(this).setTitle(R.string.network_service).setMessage(R.string.network_interrupt)
                .setNegativeButton(android.R.string.cancel, (d, w) -> renderStrip())
                .setOnCancelListener(d -> renderStrip())
                .setOnDismissListener(d -> renderStrip())
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
        boolean active = client.busy();
        if (active != operationWasBusy) invalidateStatus();
        if (observedAccountRevision != client.accountRevision()) {
            observedAccountRevision = client.accountRevision(); invalidateAccountState();
            if (resumed && page != null && ("peers".equals(destination) || "exitnodes".equals(destination) || "coexist".equals(destination))) showPage(destination);
        }
        status.setText(client.message());
        status.setVisibility(client.hasNotice() ? View.VISIBLE : View.GONE);
        renderTasks();
        if (feedback.getText().toString().contentEquals(status.getText())) { feedback.setText(""); feedback.setVisibility(View.GONE); } cancel.setVisibility(client.canCancel() ? View.VISIBLE : View.GONE);
        acknowledge.setVisibility(client.isUnknown() ? View.VISIBLE : View.GONE);
        operationActions.setVisibility(client.busy() ? View.VISIBLE : View.GONE);
        String completed = client.lastCommand();
        if (operationWasBusy && !active && resumed && page != null) page.operationFinished(completed);
        if (operationWasBusy && !active) refreshStatus();
        operationWasBusy = active;
        renderStrip();
    }
    void refreshAvailability() {
        client.refreshAvailability();
        if (!resumed || isDestroyed() || settingsCall != null) return;
        RootApi.Call call = new RootApi.Call(); settingsCall = call; shellCalls.add(call);
        WeakReference<ControlActivity> owner = new WeakReference<>(this);
        Context context = getApplicationContext();
        call.submit(FILES, () -> {
            JSONObject result = null;
            try { result = RootApi.json(context, RootApi.requestId(), null, null, 25, call, "settings-get").getJSONObject("settings"); }
            catch (Exception ignored) { /* The active page and backend handshake retain their own errors. */ }
            finally { call.finished = true; }
            JSONObject settings = result;
            new Handler(Looper.getMainLooper()).post(() -> {
                ControlActivity current = owner.get();
                if (current == null) return;
                current.shellCalls.remove(call);
                if (current.isDestroyed() || !current.resumed || current.settingsCall != call) return;
                current.settingsCall = null;
                if (settings == null) return;
                if ("on".equals(settings.optString("WEBUI_AUTO_REFRESH")) || "off".equals(settings.optString("WEBUI_AUTO_REFRESH"))) current.autoRefresh = "on".equals(settings.optString("WEBUI_AUTO_REFRESH"));
                if ("on".equals(settings.optString("POWER_SAVE")) || "off".equals(settings.optString("POWER_SAVE"))) current.powerSave = "on".equals(settings.optString("POWER_SAVE"));
            });
        });
    }
    void setAutoRefresh(boolean enabled) { autoRefresh = enabled; }
    boolean autoRefresh() { return autoRefresh; }
    boolean powerSave() { return powerSave; }
    void invalidateAccountState() {
        accountRevision++;
        invalidateStatus(); sharedStatus = null; statusEverLoaded = false; statusError = null;
        publishStatus();
        for (String key : new java.util.HashSet<>(drafts.keySet())) {
            if (key.startsWith("peers.") || key.startsWith("exitnodes.") || key.startsWith("coexist.")) drafts.remove(key);
            if (key.startsWith("network.peer") || key.startsWith("network.exit")) drafts.remove(key);
        }
        refreshStatus();
    }
    int accountRevision() { return accountRevision; }
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
