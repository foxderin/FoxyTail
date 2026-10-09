package dev.foxderin.tail;

import android.Manifest;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import android.text.format.DateFormat;
import android.view.*;
import android.widget.*;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import com.google.android.material.tabs.TabLayout;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

public final class MainActivity extends AppCompatActivity {
    private static final int PICK = 10, SAVE = 11, NOTIFY = 12;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService fileIo = Executors.newSingleThreadExecutor();
    private final ArrayList<Models.Source> selection = new ArrayList<>();
    private final ArrayList<Models.Peer> peers = new ArrayList<>();
    private final ArrayList<Models.Transfer> history = new ArrayList<>();
    private JSONArray inbox = new JSONArray();
    private LinearLayout body, selectedRows, progressRows;
    private TextView message;
    private Button cancelControl;
    private MaterialChoice target;
    private String selectedPeer, saveName;
    private String inboxSearch = "", browseDirectory = "";
    private LinearLayout inboxRows;
    private boolean inboxLoaded, historyLoaded;
    private final Runnable controlUpdates = this::updateProgress;
    private java.util.function.Consumer<JSONObject> fileCompletion;
    private Uri saveSource;
    private int page, generation;
    private boolean resumed, receiverRegistered, loading, targetsLoaded;
    private String pageError = "";
    private final BroadcastReceiver updates = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            updateProgress();
            if (!TransferService.isRunning() && (page == 0 || page == 2)) refresh();
        }
    };
    @Override protected void attachBaseContext(Context base) { super.attachBaseContext(ControlUi.localized(base)); }
    @Override public void onCreate(Bundle saved) {
        ControlUi.appearance(this);
        super.onCreate(saved);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (saved != null) {
            page = saved.getInt("page", 0); selectedPeer = saved.getString("peer");
            saveName = saved.getString("saveName");
            inboxSearch = saved.getString("inboxSearch", ""); browseDirectory = saved.getString("browseDirectory", "");
            ArrayList<String> paths = saved.getStringArrayList("sharedSelection");
            long[] sizes = saved.getLongArray("sharedSizes");
            if (paths != null && sizes != null && paths.size() == sizes.length && paths.size() <= 32) {
                for (int i = 0; i < paths.size(); i++) try { selection.add(Models.Source.shared(paths.get(i), sizes[i])); } catch (IOException ignored) { }
            }
            String source = saved.getString("saveSource"); if (source != null) saveSource = Uri.parse(source);
            ArrayList<String> uris = saved.getStringArrayList("selection");
            if (uris != null) {
                ArrayList<Uri> restored = new ArrayList<>();
                for (String value : uris) restored.add(Uri.parse(value));
                resolveUris(restored, false);
            }
        } else acceptIntent(getIntent());
        showPage(page);
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); acceptIntent(intent); showPage(page); refresh(); }
    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state); state.putInt("page", page); state.putString("peer", selectedPeer);
        ArrayList<String> uris = new ArrayList<>(), paths = new ArrayList<>(); ArrayList<Long> sizes = new ArrayList<>();
        for (Models.Source source : selection) {
            if (source.uri != null) uris.add(source.uri.toString());
            else { paths.add(source.path); sizes.add(source.size); }
        }
        long[] sharedSizes = new long[sizes.size()]; for (int i = 0; i < sizes.size(); i++) sharedSizes[i] = sizes.get(i);
        state.putStringArrayList("selection", uris); state.putStringArrayList("sharedSelection", paths); state.putLongArray("sharedSizes", sharedSizes);
        state.putString("inboxSearch", inboxSearch); state.putString("browseDirectory", browseDirectory); state.putString("saveName", saveName);
        if (saveSource != null) state.putString("saveSource", saveSource.toString());
    }
    @Override protected void onResume() {
        super.onResume(); resumed = true;
        ControlClient client = ControlClient.get(this); client.addListener(controlUpdates); client.refreshAvailability(); client.reconnect();
        IntentFilter filter = new IntentFilter(TransferService.UPDATE);
        registerReceiver(updates, filter, "dev.foxderin.tail.INTERNAL", null,
                Build.VERSION.SDK_INT >= 33 ? RECEIVER_NOT_EXPORTED : 0);
        receiverRegistered = true; updateProgress(); refresh();
        if (!TransferService.isRunning()) adoptHistory();
    }
    @Override protected void onPause() {
        resumed = false;
        ControlClient.get(this).removeListener(controlUpdates);
        if (receiverRegistered) { unregisterReceiver(updates); receiverRegistered = false; }
        super.onPause();
    }
    @Override protected void onDestroy() { fileCompletion = null; io.shutdown(); fileIo.shutdown(); super.onDestroy(); }
    private int dp(int value) { return ControlUi.dp(this, value); }
    private TextView text(String value, int sp) {
        TextView view = ControlUi.text(this, value, sp); view.setTextIsSelectable(true); view.setPadding(0, dp(6), 0, dp(6)); return view;
    }
    private MaterialButton button(int label, Runnable action) {
        return ControlUi.button(this, getString(label), action);
    }
    private MaterialButton button(int label, int icon, Runnable action) {
        return ControlUi.button(this, getString(label), icon, action);
    }
    private MaterialButton primaryButton(int label, Runnable action) {
        MaterialButton view = new MaterialButton(this); view.setText(label); view.setAllCaps(false); view.setMinHeight(dp(48));
        view.setSingleLine(false); view.setOnClickListener(v -> action.run()); return view;
    }
    private MaterialButton primaryButton(int label, int icon, Runnable action) {
        MaterialButton view = primaryButton(label, action); view.setIconResource(icon); return view;
    }
    private LinearLayout section() {
        LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); view.setPadding(0, dp(8), 0, dp(12)); return view;
    }
    private void showPage(int destination) {
        page = destination; generation++; loading = false; pageError = "";
        if (page == 1) { peers.clear(); targetsLoaded = false; }
        LinearLayout root = section(); root.setPadding(0, 0, 0, 0);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        MaterialToolbar toolbar = new MaterialToolbar(this); toolbar.setTitle(R.string.app_name);
        toolbar.setNavigationIcon(R.drawable.ic_arrow_back); toolbar.setNavigationContentDescription(R.string.files_control_home);
        toolbar.setNavigationOnClickListener(v -> startActivity(new Intent(this, ControlActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)));
        root.addView(toolbar, new LinearLayout.LayoutParams(-1, -2));
        TabLayout tabs = new TabLayout(this); tabs.setTabMode(TabLayout.MODE_FIXED); tabs.setTabGravity(TabLayout.GRAVITY_FILL); tabs.setMinimumHeight(dp(48));
        int[] labels = {R.string.inbox, R.string.send, R.string.history};
        for (int label : labels) tabs.addTab(tabs.newTab().setText(label));
        tabs.selectTab(tabs.getTabAt(page));
        tabs.addOnTabSelectedListener(new TabLayout.OnTabSelectedListener() {
            @Override public void onTabSelected(TabLayout.Tab tab) { showPage(tab.getPosition()); refresh(); }
            @Override public void onTabUnselected(TabLayout.Tab tab) { }
            @Override public void onTabReselected(TabLayout.Tab tab) { }
        });
        root.addView(tabs, new LinearLayout.LayoutParams(-1, -2));
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        LinearLayout content = section(); content.setPadding(dp(16), dp(8), dp(16), dp(16)); scroll.addView(content);
        message = text("", 14); message.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); content.addView(message);
        content.addView(button(R.string.refresh, R.drawable.ic_refresh, this::refresh));
        if (page == 0) content.addView(primaryButton(R.string.import_files, R.drawable.ic_add, this::importFiles));
        if (page == 1) {
            content.addView(primaryButton(R.string.pick_files, R.drawable.ic_add, this::pickFiles));
            content.addView(button(R.string.files_browse, R.drawable.ic_folder, this::browseFiles));
        }
        cancelControl = button(R.string.cancel, () -> startService(new Intent(this, TransferService.class).setAction(TransferService.CANCEL)));
        content.addView(cancelControl);
        body = section(); content.addView(body); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root); root.requestApplyInsets(); render(); updateProgress();
    }
    private void render() {
        body.removeAllViews(); selectedRows = null; progressRows = null; target = null; inboxRows = null;
        if (page == 0) renderInbox(); else if (page == 1) renderSend(); else renderHistory();
    }
    private void renderInbox() {
        body.addView(text(getString(R.string.inbox_hint), 14));
        EditText search = ControlUi.input(body, getString(R.string.files_search), inboxSearch, android.text.InputType.TYPE_CLASS_TEXT);
        search.setSingleLine(true); search.setContentDescription(getString(R.string.files_search));
        Button clear = button(R.string.files_clear, () -> confirmFileAction(R.string.files_clear, getString(R.string.files_clear_confirm), "file-clear"));
        clear.setEnabled(inboxLoaded && inbox.length() > 0); body.addView(clear);
        inboxRows = section(); body.addView(inboxRows); renderInboxRows();
        search.addTextChangedListener(new android.text.TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) { inboxSearch = s.toString(); renderInboxRows(); }
            public void afterTextChanged(android.text.Editable s) { }
        });
    }
    private void renderInboxRows() {
        if (inboxRows == null) return;
        inboxRows.removeAllViews(); int visible = 0;
        if (!inboxLoaded) { inboxRows.addView(text(getString(R.string.files_not_loaded), 17)); return; }
        for (int i = 0; i < inbox.length(); i++) {
            try {
                JSONObject item = inbox.getJSONObject(i); String name = Models.required(item, "name"); Models.requireName(name);
                if (!name.toLowerCase(Locale.ROOT).contains(inboxSearch.toLowerCase(Locale.ROOT))) continue;
                visible++;
                long size = Models.number(item, "size"), modified = Models.number(item, "mtime");
                LinearLayout card = ControlUi.card(inboxRows, name);
                card.addView(text(Models.bytes(this, size) + " · " + timestamp(modified), 14));
                card.addView(button(R.string.open, R.drawable.ic_open_in_new, () -> export(name, "open")));
                card.addView(button(R.string.share, R.drawable.ic_send, () -> export(name, "share")));
                card.addView(button(R.string.save, R.drawable.ic_download, () -> export(name, "save")));
                card.addView(button(R.string.files_export_download, R.drawable.ic_download, () -> confirmFileAction(R.string.files_export_download, getString(R.string.files_export_confirm, name), "file-export", name)));
                card.addView(button(R.string.files_delete, R.drawable.ic_delete, () -> confirmFileAction(R.string.files_delete, getString(R.string.files_delete_confirm, name), "file-delete", name)));
                card.addView(button(R.string.files_copy_path, R.drawable.ic_content_copy, () -> {
                    getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText(name, "/data/adb/foxytail/files/" + name));
                    toast(getString(R.string.files_copied));
                }));
            } catch (Exception e) { inboxRows.addView(text(getString(R.string.invalid_response), 14)); }
        }
        if (visible == 0) inboxRows.addView(text(getString(inbox.length() == 0 ? R.string.empty_inbox : R.string.files_no_matches), 17));
    }
    private void renderSend() {
        body.addView(text(getString(R.string.send_hint), 14));
        LinearLayout destination = ControlUi.card(body, getString(R.string.choose_target));
        ArrayList<String> names = new ArrayList<>(); int selected = 0;
        for (int i = 0; i < peers.size(); i++) {
            Models.Peer peer = peers.get(i);
            names.add(peer.name + " · " + peer.ip + (peer.online ? "" : " · " + getString(R.string.offline)));
            if (peer.id.equals(selectedPeer)) selected = i;
        }
        if (names.isEmpty()) names.add(getString(targetPlaceholder(targetsLoaded, !pageError.isEmpty())));
        target = new MaterialChoice(this, names.toArray(new String[0]), selected, position -> {
            if (position >= 0 && position < peers.size()) selectedPeer = peers.get(position).id;
        });
        target.setEnabled(!peers.isEmpty()); target.setContentDescription(getString(R.string.choose_target));
        if (!peers.isEmpty()) selectedPeer = peers.get(selected).id;
        destination.addView(target); selectedRows = section(); body.addView(selectedRows); renderSelection();
        Button send = primaryButton(R.string.send, this::confirmSend); send.setEnabled(targetsLoaded && !peers.isEmpty()); body.addView(send);
        progressRows = section(); body.addView(progressRows); renderProgress();
    }
    static int targetPlaceholder(boolean loaded, boolean failed) {
        return failed ? R.string.targets_failed : loaded ? R.string.no_targets : R.string.loading;
    }
    private void renderSelection() {
        if (selectedRows == null) return;
        selectedRows.removeAllViews();
        for (Models.Source source : selection) {
            LinearLayout item = ControlUi.card(selectedRows, source.name);
            if (source.size >= 0) item.addView(text(Models.bytes(this, source.size), 16));
            Button remove = button(R.string.remove, () -> { selection.remove(source); renderSelection(); });
            remove.setContentDescription(getString(R.string.remove) + " " + source.name); item.addView(remove);
        }
    }
    private void renderHistory() {
        if (history.isEmpty()) body.addView(text(getString(historyLoaded ? R.string.empty_history : R.string.files_not_loaded), 17));
        for (Models.Transfer transfer : history) {
            LinearLayout card = ControlUi.card(body, transfer.peerName + " · " + Models.state(this, transfer.status));
            card.addView(text(timestamp(transfer.started), 14)); addFiles(card, transfer);
            if (!transfer.error.isEmpty()) card.addView(text(transfer.error, 14));
            if (Models.active(transfer.status)) card.addView(button(R.string.cancel, () -> cancelJob(transfer.id)));
            else if (transfer.retryPaths().length() > 0) card.addView(button(R.string.retry, () -> confirmRetry(transfer)));
        }
    }
    private void addFiles(LinearLayout container, Models.Transfer transfer) {
        for (Models.FileState file : transfer.files) {
            container.addView(text(file.name + " · " + Models.state(this, file.status), 16));
            container.addView(text(Models.progress(this, file), 14));
            if (file.known && file.size > 0) {
                LinearProgressIndicator bar = new LinearProgressIndicator(this); bar.setMax(1000); bar.setProgress((int) (1000.0 * file.sent / file.size)); bar.setContentDescription(file.name + " " + Models.progress(this, file)); container.addView(bar);
            }
            if (!file.error.isEmpty()) container.addView(text(file.error, 14));
        }
    }
    private void renderProgress() {
        if (progressRows == null) return;
        progressRows.removeAllViews();
        String json = TransferService.state(this).getString("snapshot", null);
        if (json != null) try { Models.Transfer transfer = new Models.Transfer(new JSONObject(json)); addFiles(ControlUi.card(progressRows, Models.state(this, transfer.status)), transfer); } catch (Exception ignored) { }
    }
    private void updateProgress() {
        if (message == null) return;
        if (!ControlClient.get(this).busy()) fileCompletion = null;
        String controlMessage = ControlClient.get(this).message();
        message.setText(!pageError.isEmpty() ? pageError : loading ? getString(R.string.loading) : !TransferService.isRunning() && !controlMessage.isEmpty() ? controlMessage : TransferService.state(this).getString("message", ""));
        if (cancelControl != null) cancelControl.setVisibility(TransferService.isRunning() ? View.VISIBLE : View.GONE);
        renderProgress();
        if (page == 2 && TransferService.isRunning()) {
            String json = TransferService.state(this).getString("snapshot", null);
            if (json != null) try {
                Models.Transfer update = new Models.Transfer(new JSONObject(json));
                for (int i = 0; i < history.size(); i++) if (history.get(i).id.equals(update.id)) { history.set(i, update); render(); break; }
            } catch (Exception ignored) { }
        }
    }
    private void refresh() {
        if (loading) return;
        final int requestPage = page, token = generation;
        loading = true; pageError = "";
        if (requestPage == 1) { peers.clear(); targetsLoaded = false; render(); }
        updateProgress();
        io.execute(() -> {
            try {
                JSONObject result = RootApi.json(this, requestPage == 0 ? "files-inbox" : requestPage == 1 ? "taildrop-targets" : "file-send-history");
                JSONArray array = result.getJSONArray(requestPage == 0 ? "files" : requestPage == 1 ? "peers" : "transfers");
                ArrayList<Models.Peer> loadedPeers = new ArrayList<>(); ArrayList<Models.Transfer> loadedHistory = new ArrayList<>();
                if (array.length() > (requestPage == 2 ? 100 : 10000)) throw new IOException(getString(R.string.invalid_response));
                for (int i = 0; i < array.length(); i++) {
                    if (requestPage == 0) {
                        JSONObject item = array.getJSONObject(i); Models.requireName(Models.required(item, "name")); Models.number(item, "size"); Models.number(item, "mtime");
                    }
                    if (requestPage == 1) loadedPeers.add(new Models.Peer(array.getJSONObject(i)));
                    if (requestPage == 2) loadedHistory.add(new Models.Transfer(array.getJSONObject(i)));
                }
                runOnUiThread(() -> {
                    if (isDestroyed() || token != generation) return;
                    loading = false;
                    if (requestPage == 0) { inbox = array; inboxLoaded = true; }
                    else if (requestPage == 1) { peers.clear(); peers.addAll(loadedPeers); targetsLoaded = true; }
                    else { history.clear(); history.addAll(loadedHistory); historyLoaded = true; }
                    render(); updateProgress();
                });
            } catch (Exception e) { runOnUiThread(() -> { if (!isDestroyed() && token == generation) { loading = false; pageError = RootApi.message(e); if (requestPage == 1) { peers.clear(); targetsLoaded = false; render(); } updateProgress(); } }); }
        });
    }
    private void adoptHistory() {
        io.execute(() -> {
            try {
                JSONArray transfers = RootApi.json(this, "file-send-history").getJSONArray("transfers");
                for (int i = 0; i < transfers.length(); i++) {
                    Models.Transfer transfer = new Models.Transfer(transfers.getJSONObject(i));
                    if (Models.active(transfer.status)) {
                        runOnUiThread(() -> { if (resumed && !isDestroyed() && !TransferService.isRunning()) launch(new Intent(this, TransferService.class).setAction(TransferService.ADOPT).putExtra("job", transfer.id)); });
                        return;
                    }
                }
                if (TransferService.state(this).contains("request") || TransferService.state(this).contains("staged") || TransferService.state(this).getBoolean("preparing", false)) {
                    runOnUiThread(() -> { if (resumed && !isDestroyed() && !TransferService.isRunning()) launch(new Intent(this, TransferService.class).setAction(TransferService.RECOVER)); });
                }
            } catch (Exception ignored) { /* The visible page reports root/module failures; history is retried on resume. */ }
        });
    }
    private void acceptIntent(Intent intent) {
        if (intent == null) return;
        if (intent.getBooleanExtra("history", false)) page = 2;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        page = 1;
        try { resolveUris(sharedUris(intent), true); }
        catch (RuntimeException e) { error(getString(R.string.invalid_uri)); }
    }
    static ArrayList<Uri> sharedUris(Intent intent) {
        ArrayList<Uri> uris = new ArrayList<>();
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return uris;
        if (Intent.ACTION_SEND.equals(action)) { Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM); if (uri != null) uris.add(uri); }
        else { ArrayList<Uri> items = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM); if (items != null) uris.addAll(items); }
        if (uris.isEmpty() && intent.getClipData() != null) for (int i = 0; i < intent.getClipData().getItemCount(); i++) uris.add(intent.getClipData().getItemAt(i).getUri());
        return uris;
    }
    private void resolveUris(List<Uri> uris, boolean report) {
        if (uris.isEmpty()) { if (report) error(getString(R.string.invalid_uri)); return; }
        if (uris.size() > 32) { if (report) error(getString(R.string.file_limit)); return; }
        fileIo.execute(() -> {
            ArrayList<Models.Source> accepted = new ArrayList<>(); StringBuilder errors = new StringBuilder();
            for (Uri uri : new LinkedHashSet<>(uris)) {
                try {
                    if (uri == null || !"content".equals(uri.getScheme()) || checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) throw new IOException(getString(R.string.invalid_uri));
                    accepted.add(Models.Source.resolve(this, uri));
                } catch (Exception e) { if (errors.length() > 0) errors.append('\n'); errors.append(uri == null ? "?" : uri.getLastPathSegment()).append(": ").append(RootApi.message(e)); }
            }
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                for (Models.Source source : accepted) {
                    if (selection.stream().noneMatch(existing -> existing.key().equals(source.key())) && selection.size() < 32) selection.add(source);
                    else if (selection.size() >= 32) errors.append('\n').append(getString(R.string.file_limit));
                }
                renderSelection(); if (report && errors.length() > 0) error(getString(R.string.selection_errors, errors.toString()));
            });
        });
    }
    private void pickFiles() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try { startActivityForResult(intent, PICK); } catch (ActivityNotFoundException e) { error(getString(R.string.invalid_uri)); }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (result != RESULT_OK || data == null) return;
        if (request == PICK) {
            ArrayList<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
            else if (data.getData() != null) uris.add(data.getData());
            if (uris.size() > 32) { error(getString(R.string.file_limit)); return; }
            for (Uri uri : uris) try { if ((data.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0) getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (SecurityException ignored) { }
            resolveUris(uris, true);
        } else if (request == SAVE && data.getData() != null && saveSource != null) {
            Uri from = saveSource, to = data.getData(); saveSource = null;
            fileIo.execute(() -> {
                try (InputStream input = getContentResolver().openInputStream(from); OutputStream output = getContentResolver().openOutputStream(to, "wt")) {
                    if (input == null || output == null) throw new IOException(getString(R.string.export_failed));
                    RootApi.copy(input, output, RootApi.MAX_FILE, null, null);
                    runOnUiThread(() -> toast(getString(R.string.saved)));
                } catch (Exception e) { runOnUiThread(() -> error(getString(R.string.export_failed) + "\n" + RootApi.message(e))); }
            });
        }
    }
    private void confirmSend() {
        if (TransferService.isRunning()) { error(getString(R.string.busy)); return; }
        int index = target == null ? -1 : target.getSelectedItemPosition();
        if (selection.isEmpty() || index < 0 || index >= peers.size()) { error(getString(R.string.choose_first)); return; }
        Models.Peer peer = peers.get(index); ArrayList<Uri> uris = new ArrayList<>(); ArrayList<String> paths = new ArrayList<>(); StringBuilder names = new StringBuilder();
        for (Models.Source source : selection) { if (source.uri != null) uris.add(source.uri); else paths.add(source.path); names.append('\n').append(source.name); }
        new MaterialAlertDialogBuilder(this).setTitle(R.string.send).setMessage(getString(R.string.send_confirm, selection.size(), peer.name) + names)
                .setNegativeButton(R.string.cancel, null).setPositiveButton(R.string.send, (dialog, which) -> {
                    Intent intent = new Intent(this, TransferService.class).setAction(TransferService.START).putExtra("peer", peer.id).putExtra("ip", peer.ip).putParcelableArrayListExtra("uris", uris).putStringArrayListExtra("paths", paths);
                    if (!uris.isEmpty()) {
                        ClipData clip = ClipData.newRawUri("Taildrop", uris.get(0)); for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
                        intent.setClipData(clip); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    }
                    requestNotifications(); launch(intent);
                }).show();
    }
    private void confirmRetry(Models.Transfer transfer) {
        if (TransferService.isRunning()) { error(getString(R.string.busy)); return; }
        io.execute(() -> {
            try {
                JSONArray targets = RootApi.json(this, "taildrop-targets").getJSONArray("peers"); Models.Peer current = null;
                for (int i = 0; i < targets.length(); i++) { Models.Peer peer = new Models.Peer(targets.getJSONObject(i)); if (peer.id.equals(transfer.peerId)) current = peer; }
                if (current == null) throw new IOException(getString(R.string.no_targets));
                Models.Peer peer = current;
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    new MaterialAlertDialogBuilder(this).setTitle(R.string.retry).setMessage(getString(R.string.retry_confirm, peer.name)).setNegativeButton(R.string.cancel, null)
                            .setPositiveButton(R.string.send, (dialog, which) -> { requestNotifications(); launch(new Intent(this, TransferService.class).setAction(TransferService.START).putExtra("peer", peer.id).putExtra("ip", peer.ip).putExtra("retry", transfer.id)); }).show();
                });
            } catch (Exception e) { runOnUiThread(() -> error(RootApi.message(e))); }
        });
    }
    private void browseFiles() {
        new FilesBrowser(this, io, browseDirectory, source -> {
            if (selection.stream().anyMatch(existing -> existing.key().equals(source.key()))) return true;
            if (selection.size() >= 32) return false;
            selection.add(source); renderSelection(); return true;
        }, path -> selection.stream().anyMatch(source -> path.equals(source.path)), path -> {
            selection.removeIf(source -> path.equals(source.path)); renderSelection();
        }, directory -> browseDirectory = directory);
    }
    private void confirmFileAction(int title, String prompt, String... command) {
        java.lang.ref.WeakReference<MainActivity> owner = new java.lang.ref.WeakReference<>(this);
        new MaterialAlertDialogBuilder(this).setTitle(title).setMessage(prompt).setNegativeButton(R.string.cancel, null)
                .setPositiveButton(title, (dialog, which) -> {
                    ControlClient client = ControlClient.get(this);
                    if (client.busy()) { error(getString(R.string.files_operation_busy)); return; }
                    fileCompletion = result -> {
                        MainActivity activity = owner.get();
                        if (activity == null || activity.isDestroyed()) return;
                        activity.fileCompletion = null;
                        if (!result.optBoolean("ok")) { activity.error(result.optString("error", activity.getString(R.string.backend_failed))); return; }
                        activity.toast(command[0].equals("file-export") ? activity.getString(R.string.files_exported, result.optString("path")) : activity.getString(R.string.files_action_done));
                        activity.refresh();
                    };
                    client.submit(getString(title), fileCompletion, command);
                    if (!client.busy()) fileCompletion = null;
                }).show();
    }
    private void cancelJob(String id) {
        if (TransferService.isRunning()) { startService(new Intent(this, TransferService.class).setAction(TransferService.CANCEL)); return; }
        io.execute(() -> { try { RootApi.json(this, "file-send-cancel", id); runOnUiThread(() -> { toast(getString(R.string.cancel_requested)); refresh(); }); } catch (Exception e) { runOnUiThread(() -> error(RootApi.message(e))); } });
    }
    private void importFiles() {
        if (TransferService.isRunning()) { error(getString(R.string.busy)); return; }
        requestNotifications(); launch(new Intent(this, TransferService.class).setAction(TransferService.IMPORT));
    }
    private void launch(Intent intent) {
        try { startForegroundService(intent); pageError = ""; updateProgress(); }
        catch (RuntimeException e) { error(RootApi.message(e)); }
    }
    private void requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFY);
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == NOTIFY && (results.length == 0 || results[0] != PackageManager.PERMISSION_GRANTED)) toast(getString(R.string.notifications_hint));
    }
    private void export(String name, String action) {
        pageError = getString(R.string.loading); updateProgress();
        fileIo.execute(() -> {
            try {
                Uri uri = ExportProvider.export(this, name);
                runOnUiThread(() -> {
                    if (isDestroyed() || !resumed) return;
                    pageError = ""; updateProgress();
                    try {
                        if (action.equals("save")) {
                            saveSource = uri; saveName = name;
                            startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(ExportProvider.mime(name)).putExtra(Intent.EXTRA_TITLE, name), SAVE);
                        } else {
                            Intent intent;
                            if (action.equals("share")) intent = new Intent(Intent.ACTION_SEND).setType(ExportProvider.mime(name)).putExtra(Intent.EXTRA_STREAM, uri);
                            else intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, ExportProvider.mime(name));
                            intent.setClipData(ClipData.newRawUri(name, uri));
                            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            startActivity(Intent.createChooser(intent, getString(action.equals("share") ? R.string.share : R.string.open)));
                        }
                    } catch (ActivityNotFoundException e) { error(getString(R.string.no_viewer)); }
                });
            } catch (Exception e) { runOnUiThread(() -> { pageError = ""; updateProgress(); error(RootApi.message(e)); }); }
        });
    }
    private String timestamp(long seconds) { return DateFormat.getDateFormat(this).format(new Date(seconds * 1000)) + " " + DateFormat.getTimeFormat(this).format(new Date(seconds * 1000)); }
    private void error(String text) { if (!isDestroyed() && !isFinishing()) new MaterialAlertDialogBuilder(this).setTitle(R.string.error_title).setMessage(text).setPositiveButton(R.string.close, null).show(); }
    private void toast(String text) { if (!isDestroyed()) Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
}
