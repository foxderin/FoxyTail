package dev.foxderin.tail;

import android.Manifest;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.widget.*;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.checkbox.MaterialCheckBox;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;
import androidx.recyclerview.widget.DiffUtil;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

final class FilesPage extends ControlPage {
    static final int PICK = 10, SAVE = 11, NOTIFY = 12;
    private final ExecutorService io = Executors.newFixedThreadPool(3);
    private final ExecutorService fileIo = Executors.newSingleThreadExecutor();
    private final ExecutorService exportIo = Executors.newSingleThreadExecutor();
    private final ArrayList<Models.Source> selection = new ArrayList<>();
    private final LinkedHashSet<Uri> resolvingUris = new LinkedHashSet<>();
    private final ArrayList<Models.Peer> peers = new ArrayList<>();
    private final ArrayList<Models.Transfer> history = new ArrayList<>();
    private JSONArray inbox = new JSONArray();
    private final LinkedHashSet<String> inboxSelected = new LinkedHashSet<>();
    private int inboxSort, selectionRevision;
    private TextView inboxSelectionCount;
    private ToolsFlowLayout inboxBatchActions;
    private ImageButton selectMatches, deselectInbox, shareSelected, exportSelected, deleteSelected, clearHistory;
    private int inboxIgnored;
    private LinearLayout inboxSection, sendSection, targetRows, historySection, selectedRows, browserHost;
    private FilesBrowser browser;
    private MaterialButton browseControl;
    private TextView message;
    private View cancelControl; private Button sendControl;
    private MaterialChoice target;
    private String selectedPeer, saveName;
    private String inboxSearch = "", browseDirectory = "";
    private LinearLayout inboxRows;
    private RecyclerView inboxList, historyList;
    private InboxAdapter inboxAdapter;
    private HistoryAdapter historyAdapter;
    private TextView historyNotice;
    private ImageButton historyRefresh;
    private boolean inboxLoaded, historyLoaded;
    private final Runnable controlUpdates = this::updateProgress;
    private java.util.function.Consumer<JSONObject> fileCompletion;
    private RootApi.Call exportCall;
    private volatile RootApi.Call exportReadCall;
    private androidx.appcompat.app.AlertDialog exportDialog;
    private TextView exportProgress;
    private volatile boolean exportCommitting, exportCancelled;
    private int inboxGeneration, targetsGeneration, historyGeneration, historyRevision;
    private boolean receiverRegistered, targetsLoaded;
    private boolean inboxLoading, targetsLoading, historyLoading, inboxQueued, targetsQueued, historyQueued;
    private String inboxError = "", targetsError = "", historyError = "", operationMessage = "";
    private String focusSection = "";
    private final BroadcastReceiver updates = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            updateProgress();
            if (!TransferService.isRunning()) { refreshInbox(); refreshHistory(); }
        }
    };
    FilesPage(ControlActivity activity, Bundle saved) {
        super(activity);
        if (saved != null) {
            selectedPeer = saved.getString("peer"); focusSection = saved.getString("focusSection", "");
            saveName = saved.getString("saveName");
            inboxSearch = saved.getString("inboxSearch", ""); browseDirectory = saved.getString("browseDirectory", "");
            inboxSort = Math.max(0, Math.min(3, saved.getInt("inboxSort", 0)));
            ArrayList<String> selected = saved.getStringArrayList("inboxSelected");
            if (selected != null && selected.size() <= 32) for (String name : selected) try { Models.requireName(name); inboxSelected.add(name); } catch (IOException ignored) { }
            ArrayList<String> paths = saved.getStringArrayList("sharedSelection");
            long[] sizes = saved.getLongArray("sharedSizes");
            if (paths != null && sizes != null && paths.size() == sizes.length && paths.size() <= 32) {
                for (int i = 0; i < paths.size(); i++) try { selection.add(Models.Source.shared(paths.get(i), sizes[i])); } catch (IOException ignored) { }
            }
            // Only the chosen name survives the picker; source bytes are read after its result.
            ArrayList<String> uris = saved.getStringArrayList("selection");
            if (uris != null) {
                for (int start = 0; start < uris.size(); start += 32) {
                    ArrayList<Uri> restored = new ArrayList<>();
                    for (int i = start; i < Math.min(start + 32, uris.size()); i++) restored.add(Uri.parse(uris.get(i)));
                    resolveUris(restored, false);
                }
            }
        }
        buildPage(content);
    }
    @Override String title() { return s(R.string.web_files_title); }
    void saveState(Bundle state) {
        state.putString("peer", selectedPeer); state.putString("focusSection", focusSection);
        ArrayList<String> uris = new ArrayList<>(), paths = new ArrayList<>(); ArrayList<Long> sizes = new ArrayList<>();
        for (Models.Source source : selection) {
            if (source.uri != null) uris.add(source.uri.toString());
            else { paths.add(source.path); sizes.add(source.size); }
        }
        // A theme change can recreate the host before shared URI metadata has loaded.
        for (Uri uri : resolvingUris) if (uri != null && !uris.contains(uri.toString())) uris.add(uri.toString());
        long[] sharedSizes = new long[sizes.size()]; for (int i = 0; i < sizes.size(); i++) sharedSizes[i] = sizes.get(i);
        state.putStringArrayList("selection", uris); state.putStringArrayList("sharedSelection", paths); state.putLongArray("sharedSizes", sharedSizes);
        state.putString("inboxSearch", inboxSearch); state.putString("browseDirectory", browseDirectory); state.putString("saveName", saveName);
        state.putInt("inboxSort", inboxSort); state.putStringArrayList("inboxSelected", new ArrayList<>(inboxSelected));
    }
    @Override void load() {
        if (!isCurrent()) return;
        if (!receiverRegistered) {
            activity.client.addListener(controlUpdates);
            IntentFilter filter = new IntentFilter(TransferService.UPDATE);
            activity.registerReceiver(updates, filter, "dev.foxderin.tail.INTERNAL", null,
                    Build.VERSION.SDK_INT >= 33 ? Context.RECEIVER_NOT_EXPORTED : 0);
            receiverRegistered = true;
        }
        updateProgress(); recoverTransfer();
        if (!inboxLoading) refreshInbox();
        if (!targetsLoading) refreshTargets();
        if (!historyLoading) refreshHistory();
        focusRequestedSection();
    }
    @Override void onPause() {
        activity.client.removeListener(controlUpdates);
        if (receiverRegistered) { activity.unregisterReceiver(updates); receiverRegistered = false; }
    }
    @Override void onClose() {
        fileCompletion = null; if (browser != null) browser.close();
        if (exportCall != null && !exportCommitting) { exportCancelled = true; exportCall.cancel(); RootApi.Call read = exportReadCall; if (read != null) read.cancel(); }
        if (exportDialog != null) exportDialog.dismiss();
        io.shutdown(); fileIo.shutdown(); exportIo.shutdown();
    }
    private TextView text(String value, int sp) {
        TextView view = ControlUi.text(activity, value, sp); view.setTextIsSelectable(true); view.setPadding(0, dp(6), 0, dp(6)); return view;
    }
    private MaterialButton button(int label, Runnable action) {
        MaterialButton view = ControlUi.textButton(activity, s(label), action);
        view.setLayoutParams(new LinearLayout.LayoutParams(-2, -2)); return view;
    }
    private LinearLayout column() {
        LinearLayout view = new LinearLayout(activity); view.setOrientation(LinearLayout.VERTICAL); return view;
    }
    private void buildPage(LinearLayout content) {
        message = text("", 13); message.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); content.addView(message);
        cancelControl = ControlUi.iconButton(activity, R.drawable.ic_close, s(R.string.cancel), () -> activity.startService(new Intent(activity, TransferService.class).setAction(TransferService.CANCEL)));
        content.addView(cancelControl);
        inboxSection = column(); content.addView(inboxSection);
        sendSection = column(); content.addView(sendSection);
        historySection = column(); content.addView(historySection);
        renderInbox(); buildSend(); renderHistory(); updateProgress();
    }
    private void focusRequestedSection() {
        if (!isCurrent() || sendSection == null || focusSection.isEmpty() || inboxLoading || targetsLoading || historyLoading) return;
        activity.scrollToSection("history".equals(focusSection) ? historySection : sendSection);
        focusSection = "";
    }
    private void renderInbox() {
        inboxSection.removeAllViews();
        if (inboxLoaded) {
            LinearLayout metrics = new LinearLayout(activity); inboxSection.addView(metrics);
            ControlUi.MetricTile count = ControlUi.metric(metrics, R.drawable.ic_folder, s(R.string.web_files_inbox));
            count.value.setText(Integer.toString(inbox.length())); count.sub.setText(R.string.web_tools_file_count); count.sub.setVisibility(View.VISIBLE);
            long bytes = 0;
            for (int i = 0; i < inbox.length(); i++) bytes += inbox.optJSONObject(i).optLong("size");
            ControlUi.metric(metrics, R.drawable.ic_download, s(R.string.web_tools_total_size)).value.setText(WebFormat.bytes(bytes));
        }
        LinearLayout card = ControlUi.card(inboxSection, s(R.string.web_files_inbox), R.drawable.ic_folder, null);
        ImageButton refresh = ControlUi.iconButton(activity, R.drawable.ic_refresh, s(inboxLoading ? R.string.web_loading : R.string.web_tools_refresh), this::refreshInbox);
        refresh.setEnabled(!inboxLoading); ControlUi.cardAction(card, refresh);
        if (!inboxError.isEmpty()) ControlUi.banner(card, R.drawable.ic_error, inboxError, ControlUi.TONE_ERROR);
        if (inboxLoaded && inboxIgnored > 0) ControlUi.hint(card, s(R.string.repair_files_ignored_inbox, inboxIgnored));
        EditText search = null;
        if (inboxLoaded && inbox.length() > 0) {
            LinearLayout controls = new LinearLayout(activity); controls.setGravity(Gravity.CENTER_VERTICAL); card.addView(controls);
            LinearLayout field = new LinearLayout(activity); field.setOrientation(LinearLayout.VERTICAL); controls.addView(field, new LinearLayout.LayoutParams(0, -2, 1));
            search = ControlUi.input(field, s(R.string.web_tools_file_search), inboxSearch, android.text.InputType.TYPE_CLASS_TEXT);
            search.setSingleLine(true); search.setContentDescription(s(R.string.web_tools_file_search));
            LinearLayout controlActions = new LinearLayout(activity); controlActions.setGravity(Gravity.CENTER_VERTICAL); controls.addView(controlActions);
            ControlUi.iconGroup(controlActions, ControlUi.iconButton(activity, R.drawable.ic_sort, s(R.string.taildrop_sort), this::chooseInboxOrder));
            ControlUi.iconGroup(controlActions, ControlUi.iconButton(activity, R.drawable.ic_delete, s(R.string.web_files_clear), () -> confirmFileAction(R.string.web_files_clear, s(R.string.files_clear_confirm), "file-clear")));
        }
        inboxSelectionCount = ControlUi.muted(activity, "", R.dimen.ft_caption); card.addView(inboxSelectionCount);
        inboxBatchActions = new ToolsFlowLayout(activity, 4, 4); card.addView(inboxBatchActions, new LinearLayout.LayoutParams(-1, -2));
        selectMatches = ControlUi.iconButton(activity, R.drawable.ic_select_all, s(R.string.taildrop_select_matches), this::selectInboxMatches);
        deselectInbox = ControlUi.iconButton(activity, R.drawable.ic_deselect, s(R.string.taildrop_deselect), () -> { inboxSelected.clear(); renderInboxRows(); });
        shareSelected = ControlUi.iconButton(activity, R.drawable.ic_share, s(R.string.taildrop_share_selected), this::shareInboxSelection);
        exportSelected = ControlUi.iconButton(activity, R.drawable.ic_open_in_new, s(R.string.taildrop_export_selected), () -> confirmInboxBatch(false));
        deleteSelected = ControlUi.iconButton(activity, R.drawable.ic_delete, s(R.string.taildrop_delete_selected), () -> confirmInboxBatch(true));
        ControlUi.iconGroup(inboxBatchActions, selectMatches, deselectInbox, shareSelected, exportSelected);
        ControlUi.iconGroup(inboxBatchActions, deleteSelected);
        inboxRows = column(); card.addView(inboxRows);
        inboxList = boundedList(inboxRows); inboxAdapter = new InboxAdapter(); inboxList.setAdapter(inboxAdapter); renderInboxRows();
        ControlUi.hint(card, s(R.string.web_files_receive_hint));
        card.addView(ControlUi.iconButton(activity, R.drawable.ic_download, s(R.string.web_files_receive), this::importFiles));
        if (search != null) search.addTextChangedListener(new android.text.TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) { inboxSearch = s.toString(); renderInboxRows(); }
            public void afterTextChanged(android.text.Editable s) { }
        });
    }
    private LinearLayout fileRow(LinearLayout parent, String name, String detail, int icon) {
        LinearLayout row = new LinearLayout(activity); row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(0, dp(14), 0, dp(14));
        row.setMinimumHeight(dp(56)); parent.addView(row, new LinearLayout.LayoutParams(-1, -2));
        if (icon != 0) {
            ImageView image = new ImageView(activity); image.setImageResource(icon);
            image.setColorFilter(com.google.android.material.color.MaterialColors.getColor(image, com.google.android.material.R.attr.colorOnSurfaceVariant));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(20), dp(20)); params.setMarginEnd(dp(12)); row.addView(image, params);
        }
        LinearLayout main = new LinearLayout(activity); main.setOrientation(LinearLayout.VERTICAL); row.addView(main, new LinearLayout.LayoutParams(0, -2, 1));
        TextView title = ControlUi.text(activity, name, 14); title.setTypeface(null, android.graphics.Typeface.BOLD); title.setTextIsSelectable(true); main.addView(title);
        TextView sub = ControlUi.muted(activity, detail, R.dimen.ft_body_small); sub.setTextSize(12); sub.setPadding(0, dp(3), 0, 0); sub.setTextIsSelectable(true); main.addView(sub);
        return row;
    }
    private RecyclerView boundedList(LinearLayout parent) {
        RecyclerView list = new RecyclerView(activity); list.setLayoutManager(new LinearLayoutManager(activity));
        list.setItemAnimator(null); list.setNestedScrollingEnabled(true);
        parent.addView(list, new LinearLayout.LayoutParams(-1, dp(420))); return list;
    }
    private static final class FileHolder extends RecyclerView.ViewHolder {
        final LinearLayout content;
        FileHolder(LinearLayout content) { super(content); this.content = content; content.setLayoutParams(new RecyclerView.LayoutParams(-1, -2)); }
    }
    private void renderInboxRows() {
        if (inboxAdapter == null) return;
        inboxAdapter.filter();
        updateInboxSelection();
    }
    private boolean inboxSelectionAllowed() {
        return inboxLoaded && !inboxLoading && inboxError.isEmpty() && exportCall == null && saveName == null && !activity.client.busy();
    }
    private void updateInboxSelection() {
        if (inboxBatchActions == null || inboxAdapter == null) return;
        boolean enabled = inboxSelectionAllowed(), selected = !inboxSelected.isEmpty();
        inboxBatchActions.setVisibility(selected ? View.VISIBLE : View.GONE);
        inboxSelectionCount.setVisibility(inboxBatchActions.getVisibility());
        inboxSelectionCount.setText(s(R.string.taildrop_selected_count, inboxSelected.size(), inboxAdapter.visible.size()));
        selectMatches.setEnabled(enabled && !inboxAdapter.visible.isEmpty()); deselectInbox.setEnabled(enabled && selected);
        shareSelected.setEnabled(enabled && selected); exportSelected.setEnabled(enabled && selected && activity.client.canWrite()); deleteSelected.setEnabled(enabled && selected && activity.client.canWrite());
        for (int i = 0; i < inboxList.getChildCount(); i++) {
            View child = inboxList.getChildAt(i);
            updateInboxCheckboxes(child, enabled);
        }
    }
    private void updateInboxCheckboxes(View view, boolean enabled) {
        if (view instanceof MaterialCheckBox) view.setEnabled(enabled && (inboxSelected.contains(view.getTag()) || inboxSelected.size() < 32));
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) updateInboxCheckboxes(((ViewGroup) view).getChildAt(i), enabled);
    }
    private void selectInboxMatches() {
        if (!inboxSelectionAllowed()) return;
        LinkedHashSet<String> selected = new LinkedHashSet<>(inboxSelected);
        for (JSONObject item : inboxAdapter.visible) selected.add(item.optString("name"));
        if (selected.size() > 32) { toast(s(R.string.taildrop_selection_limit)); return; }
        inboxSelected.clear(); inboxSelected.addAll(selected); renderInboxRows();
    }
    private void confirmInboxBatch(boolean delete) {
        if (!inboxSelectionAllowed() || inboxSelected.isEmpty()) return;
        ArrayList<String> names = new ArrayList<>(inboxSelected);
        confirmFileAction(delete ? R.string.taildrop_delete_selected : R.string.taildrop_export_selected,
                s(delete ? R.string.taildrop_delete_confirm : R.string.taildrop_export_confirm, names.size()) + "\n" + String.join("\n", names),
                delete ? "file-delete-many" : "file-export-many", new JSONArray(names).toString());
    }
    private void chooseInboxOrder() {
        new MaterialAlertDialogBuilder(activity).setTitle(R.string.taildrop_sort)
                .setSingleChoiceItems(R.array.taildrop_sort_orders, inboxSort, (dialog, index) -> { inboxSort = index; renderInboxRows(); dialog.dismiss(); })
                .setNegativeButton(R.string.cancel, null).show();
    }
    private final class InboxAdapter extends RecyclerView.Adapter<FileHolder> {
        private final ArrayList<JSONObject> visible = new ArrayList<>();
        private final ArrayList<JSONObject> ordered = new ArrayList<>();
        private JSONArray orderedSource;
        private int orderedBy = -1;
        void filter() {
            if (orderedSource != inbox || orderedBy != inboxSort) {
                ordered.clear(); for (int i = 0; i < inbox.length(); i++) ordered.add(inbox.optJSONObject(i));
                Comparator<JSONObject> names = Comparator.comparing(item -> item.optString("name"), java.text.Collator.getInstance());
                Comparator<JSONObject> order = switch (inboxSort) {
                    case 1 -> Comparator.comparingLong(item -> item.optLong("mtime"));
                    case 2 -> names;
                    case 3 -> Comparator.<JSONObject>comparingLong(item -> item.optLong("size")).reversed();
                    default -> Comparator.<JSONObject>comparingLong(item -> item.optLong("mtime")).reversed();
                };
                ordered.sort(order.thenComparing(names)); orderedSource = inbox; orderedBy = inboxSort;
            }
            visible.clear(); String query = inboxSearch.toLowerCase(Locale.ROOT);
            for (JSONObject item : ordered) if (item.optString("name").toLowerCase(Locale.ROOT).contains(query)) visible.add(item);
            notifyDataSetChanged();
        }
        @Override public int getItemCount() { return Math.max(1, visible.size()); }
        @Override public FileHolder onCreateViewHolder(ViewGroup parent, int type) { return new FileHolder(column()); }
        @Override public void onBindViewHolder(FileHolder holder, int position) {
            LinearLayout container = holder.content; container.removeAllViews();
            if (visible.isEmpty()) {
                container.addView(text(s(!inboxLoaded ? R.string.web_loading : inboxSearch.isEmpty() ? R.string.web_files_empty : R.string.web_empty), 14)); return;
            }
            try {
                JSONObject item = visible.get(position); String name = Models.required(item, "name"); Models.requireName(name);
                long size = Models.number(item, "size"), modified = Models.number(item, "mtime");
                LinearLayout file = fileRow(container, name, WebFormat.bytes(size) + " · " + WebFormat.time(modified), R.drawable.ic_article);
                MaterialCheckBox check = new MaterialCheckBox(activity); check.setMinHeight(dp(48)); check.setMinimumWidth(dp(48));
                check.setContentDescription(s(R.string.web_files_select) + " " + name); check.setTag(name); check.setChecked(inboxSelected.contains(name));
                check.setEnabled(inboxSelectionAllowed() && (check.isChecked() || inboxSelected.size() < 32));
                check.setOnCheckedChangeListener((view, checked) -> {
                    if (checked && !inboxSelected.contains(name) && inboxSelected.size() >= 32) { check.setChecked(false); toast(s(R.string.taildrop_selection_limit)); return; }
                    if (checked) inboxSelected.add(name); else inboxSelected.remove(name);
                    updateInboxSelection();
                });
                file.addView(check);
                LinearLayout actions = new LinearLayout(activity); actions.setGravity(Gravity.END); container.addView(actions);
                ControlUi.iconGroup(actions,
                    ControlUi.iconButton(activity, R.drawable.ic_content_copy, s(R.string.web_tools_copy_path) + " " + name, () -> {
                        activity.getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText(name, "/data/adb/foxytail/files/" + name)); toast(s(R.string.files_copied));
                    }),
                    ControlUi.iconButton(activity, R.drawable.ic_download, s(R.string.web_files_download) + " " + name, () -> export(name, "save")),
                    ControlUi.iconButton(activity, R.drawable.ic_open_in_new, s(R.string.web_files_export) + " " + name, () -> confirmFileAction(R.string.web_files_export, s(R.string.files_export_confirm, name), "file-export", name)),
                    ControlUi.iconButton(activity, R.drawable.ic_file_open, s(R.string.open) + " " + name, () -> export(name, "open")),
                    ControlUi.iconButton(activity, R.drawable.ic_share, s(R.string.share) + " " + name, () -> export(name, "share")));
                ControlUi.divider(container);
            } catch (Exception e) { container.removeAllViews(); container.addView(text(s(R.string.web_files_invalid_response), 14)); }
        }
    }
    private void buildSend() {
        LinearLayout card = ControlUi.card(sendSection, s(R.string.web_files_send), R.drawable.ic_send, null);
        ControlUi.hint(card, s(R.string.web_files_send_hint));
        targetRows = column(); card.addView(targetRows); renderTargets();
        browseControl = ControlUi.tonalButton(activity, s(R.string.web_files_choose), R.drawable.ic_folder, this::browseFiles);
        browseControl.setLayoutParams(new LinearLayout.LayoutParams(-2, -2)); card.addView(browseControl);
        card.addView(ControlUi.iconButton(activity, R.drawable.ic_add, s(R.string.pick_files), this::pickFiles));
        browserHost = column(); browserHost.setVisibility(View.GONE); card.addView(browserHost);
        selectedRows = column(); card.addView(selectedRows);
        sendControl = ControlUi.primaryButton(activity, s(R.string.web_files_send_btn), R.drawable.ic_send, this::confirmSend);
        card.addView(sendControl, new LinearLayout.LayoutParams(-2, -2)); renderSelection();
    }
    private void renderTargets() {
        targetRows.removeAllViews();
        if (!targetsError.isEmpty()) ControlUi.banner(targetRows, R.drawable.ic_error, targetsError, ControlUi.TONE_ERROR);
        ArrayList<String> names = new ArrayList<>(); int selected = 0;
        for (int i = 0; i < peers.size(); i++) {
            Models.Peer peer = peers.get(i);
            names.add(peer.name + " · " + peer.ip + (peer.online ? "" : " (" + s(R.string.web_offline) + ")"));
            if (peer.id.equals(selectedPeer)) selected = i;
        }
        if (names.isEmpty()) names.add(s(targetPlaceholder(targetsLoaded, !targetsError.isEmpty())));
        target = new MaterialChoice(activity, names.toArray(new String[0]), selected, position -> {
            if (position >= 0 && position < peers.size()) selectedPeer = peers.get(position).id;
        });
        target.setHint(s(R.string.web_files_peer)); target.setEnabled(!peers.isEmpty() && !TransferService.isRunning()); target.setContentDescription(s(R.string.web_files_peer));
        if (!peers.isEmpty()) selectedPeer = peers.get(selected).id;
        targetRows.addView(target);
        ImageButton refresh = ControlUi.iconButton(activity, R.drawable.ic_refresh, s(targetsLoading ? R.string.web_loading : R.string.web_files_refresh_targets), this::refreshTargets);
        refresh.setEnabled(!targetsLoading && !TransferService.isRunning()); ControlUi.iconGroup(targetRows, refresh);
        renderSelection();
    }
    static int targetPlaceholder(boolean loaded, boolean failed) {
        return failed ? R.string.targets_failed : loaded ? R.string.web_tools_no_peers : R.string.web_loading;
    }
    private void renderSelection() {
        if (selectedRows == null) return;
        selectedRows.removeAllViews(); long bytes = 0; boolean known = true;
        for (Models.Source source : selection) { if (source.size < 0) known = false; else bytes += source.size; }
        LinearLayout summary = new LinearLayout(activity); summary.setGravity(Gravity.CENTER_VERTICAL); selectedRows.addView(summary);
        TextView count = ControlUi.muted(activity, s(R.string.web_files_selected) + " " + selection.size() + "/32 · " + (known ? WebFormat.bytes(bytes) : "—"), R.dimen.ft_caption);
        summary.addView(count, new LinearLayout.LayoutParams(0, -2, 1));
        if (!selection.isEmpty()) {
            ImageButton clear = ControlUi.iconButton(activity, R.drawable.ic_deselect, s(R.string.taildrop_clear_selection), () -> { if (!TransferService.isRunning()) { selectionRevision++; selection.clear(); resolvingUris.clear(); renderSelection(); } });
            clear.setEnabled(!TransferService.isRunning()); ControlUi.iconGroup(summary, clear);
        }
        if (selection.isEmpty()) ControlUi.hint(selectedRows, s(R.string.web_files_selection_empty));
        for (Models.Source source : selection) {
            String location = source.path == null ? source.uri.toString() : source.path;
            LinearLayout row = fileRow(selectedRows, source.name, location + " · " + (source.size < 0 ? "—" : WebFormat.bytes(source.size)), 0);
            View remove = ControlUi.iconButton(activity, android.R.drawable.ic_menu_close_clear_cancel, s(R.string.web_files_remove_selection) + " " + source.name, () -> { selection.remove(source); renderSelection(); });
            remove.setEnabled(!TransferService.isRunning()); row.addView(remove);
        }
        if (sendControl != null) sendControl.setEnabled(targetsLoaded && targetsError.isEmpty() && historyLoaded && historyError.isEmpty() && !peers.isEmpty() && !selection.isEmpty() && !TransferService.isRunning() && history.stream().noneMatch(item -> Models.active(item.status)));
        if (browser != null) browser.updateSelection();
    }
    private String transferState(String status) {
        if ("completed".equals(status)) return s(R.string.web_files_completed);
        return s(switch (status) {
            case "queued" -> R.string.web_files_queued; case "sending" -> R.string.web_files_sending;
            case "failed" -> R.string.web_files_failed;
            case "cancelled" -> R.string.web_files_cancelled; default -> R.string.web_files_interrupted;
        });
    }
    private void renderHistory() {
        if (historyAdapter == null) {
            LinearLayout card = ControlUi.card(historySection, s(R.string.web_files_history), R.drawable.ic_send, null);
            historyRefresh = ControlUi.iconButton(activity, R.drawable.ic_refresh, s(R.string.web_tools_refresh), this::refreshHistory);
            clearHistory = ControlUi.iconButton(activity, R.drawable.ic_delete, s(R.string.taildrop_clear_history), () -> confirmFileAction(R.string.taildrop_clear_history, s(R.string.taildrop_clear_history_confirm), "file-send-clear"));
            ControlUi.cardAction(card, ControlUi.iconGroup(card, historyRefresh, clearHistory));
            historyNotice = text("", 14); card.addView(historyNotice);
            historyList = boundedList(card); historyAdapter = new HistoryAdapter(); historyList.setAdapter(historyAdapter);
        }
        String historyState = s(historyLoading ? R.string.web_loading : R.string.web_tools_refresh); historyRefresh.setContentDescription(historyState); historyRefresh.setTooltipText(historyState); historyRefresh.setEnabled(!historyLoading);
        clearHistory.setEnabled(historyLoaded && historyError.isEmpty() && history.stream().anyMatch(item -> !Models.active(item.status)) && !activity.client.busy());
        historyNotice.setText(!historyError.isEmpty() ? historyError : history.isEmpty() ? s(historyLoaded ? R.string.web_files_history_empty : R.string.web_loading) : "");
        historyNotice.setVisibility(historyNotice.length() == 0 ? View.GONE : View.VISIBLE);
        historyList.setVisibility(history.isEmpty() ? View.GONE : View.VISIBLE);
        historyAdapter.update();
    }
    private final class HistoryAdapter extends RecyclerView.Adapter<FileHolder> {
        private ArrayList<Models.Transfer> rows = new ArrayList<>();
        void update() {
            ArrayList<Models.Transfer> previous = rows, next = new ArrayList<>(history);
            DiffUtil.DiffResult changes = DiffUtil.calculateDiff(new DiffUtil.Callback() {
                public int getOldListSize() { return previous.size(); }
                public int getNewListSize() { return next.size(); }
                public boolean areItemsTheSame(int oldPosition, int newPosition) { return previous.get(oldPosition).id.equals(next.get(newPosition).id); }
                public boolean areContentsTheSame(int oldPosition, int newPosition) {
                    Models.Transfer old = previous.get(oldPosition), current = next.get(newPosition);
                    return old == current || old.json.toString().equals(current.json.toString());
                }
            });
            rows = next; changes.dispatchUpdatesTo(this);
            for (int i = 0; i < historyList.getChildCount(); i++) {
                View child = historyList.getChildAt(i);
                if (child.getTag() instanceof Models.Transfer) updateRetry((LinearLayout) child, (Models.Transfer) child.getTag());
            }
        }
        @Override public int getItemCount() { return rows.size(); }
        @Override public FileHolder onCreateViewHolder(ViewGroup parent, int type) { return new FileHolder(column()); }
        @Override public void onBindViewHolder(FileHolder holder, int position) {
            holder.content.removeAllViews(); Models.Transfer transfer = rows.get(position); holder.content.setTag(transfer);
            addTransfer(holder.content, transfer); ControlUi.divider(holder.content);
        }
        @Override public void onViewAttachedToWindow(FileHolder holder) {
            super.onViewAttachedToWindow(holder);
            if (holder.content.getTag() instanceof Models.Transfer) updateRetry(holder.content, (Models.Transfer) holder.content.getTag());
        }
    }
    private void updateRetry(LinearLayout row, Models.Transfer transfer) {
        View retry = row.findViewWithTag("retry");
        if (retry != null) retry.setEnabled(historyLoaded && historyError.isEmpty() && targetsError.isEmpty() && !TransferService.isRunning()
                && history.stream().noneMatch(item -> Models.active(item.status)) && peers.stream().anyMatch(peer -> peer.id.equals(transfer.peerId)));
        View missing = row.findViewWithTag("retry-missing");
        if (missing != null) missing.setVisibility(targetsLoaded && peers.stream().noneMatch(peer -> peer.id.equals(transfer.peerId)) ? View.VISIBLE : View.GONE);
        View remove = row.findViewWithTag("delete-history");
        if (remove != null) remove.setEnabled(!activity.client.busy());
    }
    private void addTransfer(LinearLayout container, Models.Transfer transfer) {
        LinearLayout heading = new LinearLayout(activity); heading.setGravity(Gravity.CENTER_VERTICAL); container.addView(heading);
        TextView title = text((transfer.peerName.isEmpty() ? transfer.peerId : transfer.peerName) + " · " + transfer.peerIp, 16); title.setTypeface(null, android.graphics.Typeface.BOLD); heading.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        long completed = transfer.files.stream().filter(file -> "completed".equals(file.status)).count();
        ControlUi.hint(container, WebFormat.time(transfer.started) + " · " + s(R.string.web_files_completed_count) + " " + completed + "/" + transfer.files.size());
        String state = transferState(transfer.status);
        if (state != null) { TextView status = text(state, 14); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); container.addView(status); }
        if (Models.active(transfer.status)) ControlUi.hint(container, s(R.string.web_files_accepted_hint));
        if (!transfer.error.isEmpty()) ControlUi.banner(container, R.drawable.ic_error, transfer.error, ControlUi.TONE_ERROR);
        addFiles(container, transfer);
        if (Models.active(transfer.status)) container.addView(ControlUi.iconButton(activity, R.drawable.ic_close, s(R.string.web_files_cancel_send), () -> cancelJob(transfer.id)));
        else {
            ImageButton remove = ControlUi.iconButton(activity, R.drawable.ic_delete, s(R.string.taildrop_delete_history), () -> confirmFileAction(R.string.taildrop_delete_history, s(R.string.taildrop_delete_history_confirm), "file-send-delete", transfer.id));
            remove.setEnabled(!activity.client.busy());
            remove.setTag("delete-history"); ControlUi.iconGroup(heading, remove);
            long unsuccessful = transfer.files.stream().filter(file -> "failed".equals(file.status) || "cancelled".equals(file.status)).count();
            if (unsuccessful > 0) {
                ImageButton retry = ControlUi.iconButton(activity, R.drawable.ic_refresh, s(R.string.web_files_retry_unsuccessful) + " (" + unsuccessful + ")", () -> confirmRetry(transfer));
                retry.setTag("retry");
                retry.setEnabled(historyLoaded && historyError.isEmpty() && targetsError.isEmpty() && !TransferService.isRunning() && history.stream().noneMatch(item -> Models.active(item.status)) && peers.stream().anyMatch(peer -> peer.id.equals(transfer.peerId)));
                ControlUi.iconGroup(container, retry);
                TextView missing = text(s(R.string.web_files_retry_target_missing), 13); missing.setTag("retry-missing"); container.addView(missing);
                updateRetry(container, transfer);
            }
        }
    }
    private void addFiles(LinearLayout container, Models.Transfer transfer) {
        for (Models.FileState file : transfer.files) {
            String fileState = transferState(file.status);
            LinearLayout row = fileRow(container, file.name, (fileState == null ? "" : fileState + " · ") + WebFormat.bytes(file.size), 0);
            LinearLayout main = (LinearLayout) row.getChildAt(0);
            if ("sending".equals(file.status) && file.known) {
                String progress = WebFormat.bytes(file.sent) + " / " + WebFormat.bytes(file.size) + " · " + WebFormat.bytes(file.speed) + "/s";
                ControlUi.hint(main, progress);
                LinearProgressIndicator bar = new LinearProgressIndicator(activity); bar.setMax(1000); bar.setProgress(file.size == 0 ? 0 : (int) (1000.0 * file.sent / file.size));
                bar.setContentDescription(s(R.string.web_files_sending) + " " + file.name + " " + progress); main.addView(bar);
            }
            if ("sending".equals(file.status) && !file.known) ControlUi.hint(main, s(R.string.web_files_progress_unknown));
            if (!file.error.isEmpty()) {
                TextView error = text(file.error, 13); error.setTextColor(com.google.android.material.color.MaterialColors.getColor(error, androidx.appcompat.R.attr.colorError)); main.addView(error);
            }
        }
    }
    private String observedSnapshot;
    private void updateProgress() {
        if (message == null) return;
        if (!ControlClient.get(activity).busy()) fileCompletion = null;
        String notice = !operationMessage.isEmpty() ? operationMessage : TransferService.state(activity).getString("message", "");
        message.setText(activity.client.hasNotice() && notice.equals(activity.client.message()) ? "" : notice);
        message.setVisibility(message.length() == 0 ? View.GONE : View.VISIBLE);
        if (cancelControl != null) cancelControl.setVisibility(TransferService.isRunning() ? View.VISIBLE : View.GONE);
        if (target != null) target.setEnabled(!peers.isEmpty() && !TransferService.isRunning());
        if (browseControl != null) browseControl.setEnabled(!TransferService.isRunning());
        String snapshot = TransferService.state(activity).getString("snapshot", null);
        if (snapshot != null && !snapshot.equals(observedSnapshot)) try {
            Models.Transfer update = new Models.Transfer(new JSONObject(snapshot));
            observedSnapshot = snapshot;
            Models.Transfer existing = history.stream().filter(item -> item.id.equals(update.id)).findFirst().orElse(null);
            if (existing == null || (existing.json.optLong("updatedAt") <= update.json.optLong("updatedAt") && (Models.active(existing.status) || !Models.active(update.status)))) {
                history.removeIf(item -> item.id.equals(update.id)); history.add(update);
                history.sort(Comparator.comparingLong((Models.Transfer item) -> item.started).reversed());
                if (history.size() > 100) history.remove(history.size() - 1);
                historyRevision++; renderHistory();
            }
        } catch (Exception ignored) { }
        renderSelection();
        updateInboxSelection();
        if (clearHistory != null) clearHistory.setEnabled(historyLoaded && historyError.isEmpty() && history.stream().anyMatch(item -> !Models.active(item.status)) && !activity.client.busy());
        if (historyList != null) for (int i = 0; i < historyList.getChildCount(); i++) {
            View row = historyList.getChildAt(i); if (row.getTag() instanceof Models.Transfer) updateRetry((LinearLayout) row, (Models.Transfer) row.getTag());
        }
    }
    private void refreshInbox() {
        if (inboxLoading) { inboxQueued = true; return; }
        final int token = ++inboxGeneration;
        inboxLoading = true; renderInbox();
        io.execute(() -> {
            try {
                Models.Inbox loaded = new Models.Inbox(RootApi.json(activity, "files-inbox"));
                activity.runOnUiThread(() -> {
                    if (activity.isDestroyed() || token != inboxGeneration) return;
                    inbox = loaded.files; inboxIgnored = loaded.ignored; inboxLoaded = true; inboxError = "";
                    HashSet<String> names = new HashSet<>(); for (int i = 0; i < inbox.length(); i++) names.add(inbox.optJSONObject(i).optString("name"));
                    inboxSelected.retainAll(names); finishInbox();
                });
            } catch (Exception error) { activity.runOnUiThread(() -> {
                if (activity.isDestroyed() || token != inboxGeneration) return;
                inboxError = RootApi.message(error); finishInbox();
            }); }
        });
    }
    private void finishInbox() {
        inboxLoading = false; renderInbox();
        if (inboxQueued) { inboxQueued = false; refreshInbox(); }
        focusRequestedSection();
    }
    private void refreshTargets() {
        if (targetsLoading) { targetsQueued = true; return; }
        final int token = ++targetsGeneration;
        targetsLoading = true; renderTargets();
        io.execute(() -> {
            try {
                JSONArray array = RootApi.json(activity, "taildrop-targets").getJSONArray("peers");
                if (array.length() > 10000) throw new IOException(s(R.string.web_files_invalid_response));
                ArrayList<Models.Peer> loaded = new ArrayList<>(); Set<String> ids = new HashSet<>();
                for (int i = 0; i < array.length(); i++) {
                    Models.Peer peer = new Models.Peer(array.getJSONObject(i));
                    if (!ids.add(peer.id)) throw new IOException(s(R.string.web_files_invalid_response));
                    loaded.add(peer);
                }
                loaded.sort(Comparator.comparing((Models.Peer peer) -> !peer.online).thenComparing(peer -> peer.name, java.text.Collator.getInstance()).thenComparing(peer -> peer.id));
                activity.runOnUiThread(() -> {
                    if (activity.isDestroyed() || token != targetsGeneration) return;
                    peers.clear(); peers.addAll(loaded); targetsLoaded = true; targetsError = ""; finishTargets();
                });
            } catch (Exception error) { activity.runOnUiThread(() -> {
                if (activity.isDestroyed() || token != targetsGeneration) return;
                targetsError = RootApi.message(error); finishTargets();
            }); }
        });
    }
    private void finishTargets() {
        targetsLoading = false; renderTargets(); renderHistory();
        if (targetsQueued) { targetsQueued = false; refreshTargets(); }
        focusRequestedSection();
    }
    private void refreshHistory() {
        if (historyLoading) { historyQueued = true; return; }
        final int token = ++historyGeneration, revision = historyRevision;
        historyLoading = true; renderHistory(); renderSelection();
        io.execute(() -> {
            try {
                JSONArray array = RootApi.json(activity, "file-send-history").getJSONArray("transfers");
                if (array.length() > 100) throw new IOException(s(R.string.web_files_invalid_response));
                ArrayList<Models.Transfer> loaded = new ArrayList<>(); Set<String> ids = new HashSet<>(); int active = 0;
                for (int i = 0; i < array.length(); i++) {
                    Models.Transfer transfer = new Models.Transfer(array.getJSONObject(i));
                    if (!ids.add(transfer.id) || (Models.active(transfer.status) && ++active > 1)) throw new IOException(s(R.string.web_files_invalid_response));
                    loaded.add(transfer);
                }
                activity.runOnUiThread(() -> {
                    if (activity.isDestroyed() || token != historyGeneration) return;
                    if (revision == historyRevision) { history.clear(); history.addAll(loaded); historyLoaded = true; historyError = ""; recoverTransfer(); }
                    else historyQueued = true;
                    finishHistory();
                });
            } catch (Exception error) { activity.runOnUiThread(() -> {
                if (activity.isDestroyed() || token != historyGeneration) return;
                historyError = RootApi.message(error); finishHistory();
            }); }
        });
    }
    private void finishHistory() {
        historyLoading = false; renderHistory(); renderSelection();
        if (historyQueued) { historyQueued = false; refreshHistory(); }
        focusRequestedSection();
    }
    private void recoverTransfer() {
        if (!isCurrent() || TransferService.isRunning()) return;
        for (Models.Transfer transfer : history) if (Models.active(transfer.status)) {
            launch(new Intent(activity, TransferService.class).setAction(TransferService.ADOPT).putExtra("job", transfer.id)); return;
        }
        if (TransferService.state(activity).contains("request") || TransferService.state(activity).contains("staged") || TransferService.state(activity).getBoolean("preparing", false))
            launch(new Intent(activity, TransferService.class).setAction(TransferService.RECOVER));
    }
    void acceptIntent(Intent intent) {
        if (intent == null) return;
        if (intent.getBooleanExtra("history", false)) focusSection = "history";
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            focusSection = "send";
            try { resolveUris(sharedUris(intent), true); }
            catch (RuntimeException e) { error(s(R.string.invalid_uri)); }
        }
        focusRequestedSection();
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
        if (uris.isEmpty()) { if (report) error(s(R.string.invalid_uri)); return; }
        if (uris.size() > 32) { if (report) error(s(R.string.file_limit)); return; }
        ArrayList<Uri> pending = new ArrayList<>();
        for (Uri uri : uris) if (resolvingUris.add(uri)) pending.add(uri);
        if (pending.isEmpty()) return;
        final int revision = selectionRevision;
        fileIo.execute(() -> {
            ArrayList<Models.Source> accepted = new ArrayList<>(); StringBuilder errors = new StringBuilder();
            for (Uri uri : pending) {
                try {
                    if (uri == null || !"content".equals(uri.getScheme()) || activity.checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) throw new IOException(s(R.string.invalid_uri));
                    accepted.add(Models.Source.resolve(activity, uri));
                } catch (Exception e) { if (errors.length() > 0) errors.append('\n'); errors.append(uri == null ? "?" : uri.getLastPathSegment()).append(": ").append(RootApi.message(e)); }
            }
            activity.runOnUiThread(() -> {
                if (activity.isDestroyed() || revision != selectionRevision) return;
                resolvingUris.removeAll(pending);
                if (TransferService.isRunning()) { if (report) error(s(R.string.busy)); return; }
                for (Models.Source source : accepted) {
                    if (selection.stream().noneMatch(existing -> existing.key().equals(source.key())) && selection.size() < 32) selection.add(source);
                    else if (selection.size() >= 32) errors.append('\n').append(s(R.string.file_limit));
                }
                renderSelection(); if (report && errors.length() > 0) error(s(R.string.selection_errors, errors.toString()));
            });
        });
    }
    private void pickFiles() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try { activity.startActivityForResult(intent, PICK); } catch (ActivityNotFoundException e) { error(s(R.string.invalid_uri)); }
    }
    void onActivityResult(int request, int result, Intent data) {
        if (result != android.app.Activity.RESULT_OK || data == null) { if (request == SAVE) { saveName = null; updateInboxSelection(); } return; }
        if (request == PICK) {
            ArrayList<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
            else if (data.getData() != null) uris.add(data.getData());
            if (uris.size() > 32) { error(s(R.string.file_limit)); return; }
            for (Uri uri : uris) try { if ((data.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0) activity.getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (SecurityException ignored) { }
            resolveUris(uris, true);
        } else if (request == SAVE) {
            String name = saveName; saveName = null;
            if (name != null && data.getData() != null) startExport(name, "save", data.getData());
        }
    }
    private void confirmSend() {
        if (TransferService.isRunning()) { error(s(R.string.busy)); return; }
        if (!targetsLoaded || !targetsError.isEmpty() || !historyLoaded || !historyError.isEmpty() || history.stream().anyMatch(item -> Models.active(item.status))) return;
        int index = target == null ? -1 : target.getSelectedItemPosition();
        if (selection.isEmpty() || index < 0 || index >= peers.size()) { error(s(R.string.choose_first)); return; }
        Models.Peer peer = peers.get(index); ArrayList<Uri> uris = new ArrayList<>(); ArrayList<String> paths = new ArrayList<>(); StringBuilder names = new StringBuilder();
        for (Models.Source source : selection) { if (source.uri != null) uris.add(source.uri); else paths.add(source.path); names.append('\n').append(source.name); }
        new MaterialAlertDialogBuilder(activity).setTitle(R.string.send).setMessage(s(R.string.send_confirm, selection.size(), peer.name) + names)
                .setNegativeButton(R.string.cancel, null).setPositiveButton(R.string.send, (dialog, which) -> {
                    if (TransferService.isRunning() || !targetsError.isEmpty() || !historyError.isEmpty() || history.stream().anyMatch(item -> Models.active(item.status))) { error(s(R.string.busy)); return; }
                    Intent intent = new Intent(activity, TransferService.class).setAction(TransferService.START).putExtra("peer", peer.id).putExtra("ip", peer.ip).putParcelableArrayListExtra("uris", uris).putStringArrayListExtra("paths", paths);
                    if (!uris.isEmpty()) {
                        ClipData clip = ClipData.newRawUri("Taildrop", uris.get(0)); for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
                        intent.setClipData(clip); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    }
                    requestNotifications(); launch(intent);
                }).show();
    }
    private void confirmRetry(Models.Transfer transfer) {
        if (TransferService.isRunning()) { error(s(R.string.busy)); return; }
        if (!historyLoaded || !historyError.isEmpty() || !targetsError.isEmpty() || history.stream().anyMatch(item -> Models.active(item.status))) return;
        io.execute(() -> {
            try {
                JSONArray targets = RootApi.json(activity, "taildrop-targets").getJSONArray("peers"); Models.Peer current = null;
                for (int i = 0; i < targets.length(); i++) { Models.Peer peer = new Models.Peer(targets.getJSONObject(i)); if (peer.id.equals(transfer.peerId)) current = peer; }
                if (current == null) throw new IOException(s(R.string.web_files_retry_target_missing));
                Models.Peer peer = current;
                activity.runOnUiThread(() -> {
                    if (activity.isDestroyed()) return;
                    new MaterialAlertDialogBuilder(activity).setTitle(R.string.retry).setMessage(s(R.string.retry_confirm, peer.name)).setNegativeButton(R.string.cancel, null)
                            .setPositiveButton(R.string.send, (dialog, which) -> {
                                if (TransferService.isRunning() || !historyError.isEmpty() || !targetsError.isEmpty() || history.stream().anyMatch(item -> Models.active(item.status))) { error(s(R.string.busy)); return; }
                                requestNotifications(); launch(new Intent(activity, TransferService.class).setAction(TransferService.START).putExtra("peer", peer.id).putExtra("ip", peer.ip).putExtra("retry", transfer.id));
                            }).show();
                });
            } catch (Exception e) { activity.runOnUiThread(() -> error(RootApi.message(e))); }
        });
    }
    private void browseFiles() {
        if (TransferService.isRunning()) return;
        if (browser != null) {
            browser.close(); browser = null; browserHost.removeAllViews(); browserHost.setVisibility(View.GONE);
            browseControl.setText(R.string.web_files_choose); return;
        }
        browserHost.setVisibility(View.VISIBLE); browseControl.setText(R.string.web_files_close_browser);
        browser = new FilesBrowser(activity, io, browserHost, browseDirectory, source -> {
            if (TransferService.isRunning()) return false;
            if (selection.stream().anyMatch(existing -> existing.key().equals(source.key()))) return true;
            if (selection.size() >= 32) return false;
            selection.add(source); renderSelection(); return true;
        }, path -> selection.stream().anyMatch(source -> path.equals(source.path)), path -> {
            if (!TransferService.isRunning()) { selection.removeIf(source -> path.equals(source.path)); renderSelection(); }
        }, directory -> browseDirectory = directory, () -> TransferService.isRunning(), () -> selection.size() < 32);
    }
    private void confirmFileAction(int title, String prompt, String... command) {
        java.lang.ref.WeakReference<FilesPage> owner = new java.lang.ref.WeakReference<>(this);
        new MaterialAlertDialogBuilder(activity).setTitle(title).setMessage(prompt).setNegativeButton(R.string.cancel, null)
                .setPositiveButton(title, (dialog, which) -> {
                    if (activity.client.busy()) { error(s(R.string.files_operation_busy)); return; }
                    fileCompletion = result -> {
                        FilesPage page = owner.get();
                        if (page == null || page.activity.isDestroyed()) return;
                        page.fileCompletion = null; page.completeFileAction(result, command);
                    };
                    activity.client.submit(s(title), fileCompletion, command);
                    if (!activity.client.busy()) fileCompletion = null;
                    dialog.dismiss();
                }).show();
    }
    private void completeFileAction(JSONObject result, String... command) {
        boolean historyAction = command[0].equals("file-send-delete") || command[0].equals("file-send-clear");
        try {
            if (!result.getBoolean("ok")) throw new IOException(result.optString("error", s(R.string.backend_failed)));
            if (historyAction) {
                long removed = Models.number(result, "removed"), retained = Models.number(result, "retained");
                history.removeIf(item -> !Models.active(item.status) && (command[0].equals("file-send-clear") || item.id.equals(command[1])));
                historyRevision++;
                SharedPreferences state = TransferService.state(activity); String snapshot = state.getString("snapshot", null);
                if (snapshot != null) {
                    Models.Transfer saved = new Models.Transfer(new JSONObject(snapshot));
                    if (!Models.active(saved.status) && (command[0].equals("file-send-clear") || saved.id.equals(command[1]))) state.edit().remove("snapshot").apply();
                }
                toast(s(R.string.taildrop_history_removed, removed, retained));
            } else if (command[0].endsWith("-many")) {
                JSONArray results = result.getJSONArray("results"), requested = new JSONArray(command[1]);
                if (results.length() != requested.length()) throw new IOException(s(R.string.invalid_response));
                int succeeded = 0; StringBuilder failures = new StringBuilder(); ArrayList<String> completed = new ArrayList<>();
                for (int i = 0; i < results.length(); i++) {
                    JSONObject item = results.getJSONObject(i); String name = Models.required(item, "name");
                    if (!name.equals(requested.getString(i)) || !(item.get("ok") instanceof Boolean)) throw new IOException(s(R.string.invalid_response));
                    if (item.getBoolean("ok")) { succeeded++; completed.add(name); }
                    else { if (failures.length() > 0) failures.append('\n'); failures.append(name).append(": ").append(Models.required(item, "error")); }
                }
                inboxSelected.removeAll(completed);
                String notice = s(R.string.taildrop_batch_result, succeeded, results.length() - succeeded);
                if (failures.length() == 0) toast(notice); else error(notice + "\n" + failures);
            } else {
                String notice = command[0].equals("file-export") ? s(R.string.web_files_exported_to) + " " + result.optString("path")
                        : command[0].equals("file-clear") ? s(R.string.web_files_cleared) + " (" + result.optInt("removed") + ")" : s(R.string.web_files_deleted);
                if (command[0].equals("file-clear") && result.optInt("ignored") > 0) notice += "\n" + s(R.string.repair_files_ignored_clear, result.optInt("ignored"));
                toast(notice);
            }
        } catch (Exception error) { error(RootApi.message(error)); }
        finally { if (historyAction) refreshHistory(); else refreshInbox(); }
    }
    private void cancelJob(String id) {
        if (TransferService.isRunning()) { activity.startService(new Intent(activity, TransferService.class).setAction(TransferService.CANCEL)); return; }
        io.execute(() -> { try { RootApi.json(activity, "file-send-cancel", id); activity.runOnUiThread(() -> { if (!activity.isDestroyed()) { toast(s(R.string.web_files_cancel_requested)); refreshHistory(); } }); } catch (Exception e) { activity.runOnUiThread(() -> error(RootApi.message(e))); } });
    }
    private void importFiles() {
        if (TransferService.isRunning()) { error(s(R.string.busy)); return; }
        requestNotifications(); launch(new Intent(activity, TransferService.class).setAction(TransferService.IMPORT));
    }
    private void launch(Intent intent) {
        try { activity.startForegroundService(intent); operationMessage = ""; updateProgress(); }
        catch (RuntimeException e) { error(RootApi.message(e)); }
    }
    private void requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFY);
    }
    void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        if (request == NOTIFY && (results.length == 0 || results[0] != PackageManager.PERMISSION_GRANTED)) toast(s(R.string.notifications_hint));
    }
    private void export(String name, String action) {
        if (exportCall != null || saveName != null) { error(s(R.string.busy)); return; }
        if ("save".equals(action)) {
            saveName = name;
            try { activity.startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(ExportProvider.mime(name)).putExtra(Intent.EXTRA_TITLE, name), SAVE); }
            catch (ActivityNotFoundException e) { saveName = null; error(s(R.string.no_viewer)); }
            return;
        }
        startExport(name, action, null);
    }
    private RootApi.Call beginExport(String name, int title) {
        if (exportCall != null || saveName != null) { error(s(R.string.busy)); return null; }
        RootApi.Call call = new RootApi.Call(); exportCall = call; exportCancelled = false; exportCommitting = false; updateInboxSelection();
        LinearLayout content = column(); int gap = dp(20); content.setPadding(gap, gap, gap, gap);
        exportProgress = text(s(R.string.repair_files_saving, name, WebFormat.bytes(0)), 14);
        exportProgress.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); content.addView(exportProgress);
        LinearProgressIndicator progress = new LinearProgressIndicator(activity); progress.setIndeterminate(true); content.addView(progress);
        exportDialog = new MaterialAlertDialogBuilder(activity).setTitle(title)
                .setView(content).setNegativeButton(R.string.cancel, null).setCancelable(false).create();
        exportDialog.show();
        exportDialog.getButton(android.content.DialogInterface.BUTTON_NEGATIVE).setOnClickListener(view -> {
            if (!exportCommitting) { exportCancelled = true; call.cancel(); RootApi.Call read = exportReadCall; if (read != null) read.cancel(); view.setEnabled(false); }
        });
        return call;
    }
    private void shareInboxSelection() {
        if (!inboxSelectionAllowed() || inboxSelected.isEmpty()) return;
        ArrayList<String> names = new ArrayList<>(inboxSelected);
        RootApi.Call call = beginExport(names.get(0), R.string.share); if (call == null) return;
        exportIo.execute(() -> {
            ArrayList<Uri> ready = new ArrayList<>();
            try {
                for (int i = 0; i < names.size(); i++) {
                    if (exportCancelled || call.cancelled.get()) throw new InterruptedIOException(s(R.string.cancelled));
                    String name = names.get(i); int index = i + 1; long[] last = {0};
                    activity.runOnUiThread(() -> { if (!activity.isDestroyed() && exportCall == call) exportProgress.setText(s(R.string.taildrop_share_progress, index, names.size(), name, WebFormat.bytes(0))); });
                    RootApi.Call read = new RootApi.Call(); exportReadCall = read;
                    if (exportCancelled || call.cancelled.get()) { read.cancel(); throw new InterruptedIOException(s(R.string.cancelled)); }
                    ready.add(ExportProvider.export(activity, name, bytes -> {
                        long now = SystemClock.elapsedRealtime(); if (now - last[0] < 250) return; last[0] = now;
                        activity.runOnUiThread(() -> { if (!activity.isDestroyed() && exportCall == call) exportProgress.setText(s(R.string.taildrop_share_progress, index, names.size(), name, WebFormat.bytes(bytes))); });
                    }, read));
                }
                if (exportCancelled || call.cancelled.get()) throw new InterruptedIOException(s(R.string.cancelled));
                activity.runOnUiThread(() -> {
                    boolean cancelled = exportCancelled; finishExport(call);
                    if (!isCurrent() || cancelled) { discardExports(ready); return; }
                    try { activity.startActivity(Intent.createChooser(shareIntent(names, ready), s(R.string.share))); }
                    catch (ActivityNotFoundException error) { discardExports(ready); error(s(R.string.no_viewer)); }
                });
            } catch (Exception error) { discardExports(ready); activity.runOnUiThread(() -> { finishExport(call); error(RootApi.message(error)); }); }
            finally { exportReadCall = null; call.finished = true; }
        });
    }
    static Intent shareIntent(List<String> names, ArrayList<Uri> uris) {
        if (uris.isEmpty() || uris.size() != names.size() || uris.size() > 32) throw new IllegalArgumentException("Invalid shared file selection");
        String type = ExportProvider.mime(names.get(0));
        for (String name : names) if (!type.equals(ExportProvider.mime(name))) { type = "*/*"; break; }
        Intent intent = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE).setType(type);
        if (uris.size() == 1) intent.putExtra(Intent.EXTRA_STREAM, uris.get(0)); else intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
        ClipData clip = ClipData.newRawUri("Taildrop", uris.get(0)); for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
        intent.setClipData(clip); return intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }
    private void discardExports(List<Uri> uris) {
        for (Uri uri : uris) try { ExportProvider.discard(activity, uri); } catch (IOException ignored) { }
    }
    private void startExport(String name, String action, Uri targetUri) {
        RootApi.Call call = beginExport(name, "save".equals(action) ? R.string.web_files_download : "share".equals(action) ? R.string.share : R.string.open);
        if (call == null) return;
        final long[] lastProgress = {0};
        RootApi.Progress copied = bytes -> {
            long now = SystemClock.elapsedRealtime(); if (now - lastProgress[0] < 250) return; lastProgress[0] = now;
            activity.runOnUiThread(() -> {
                if (!activity.isDestroyed() && exportCall == call) exportProgress.setText(s(exportCommitting ? R.string.repair_files_save_committing : R.string.repair_files_saving, name, WebFormat.bytes(bytes)));
            });
        };
        exportIo.execute(() -> {
            try {
                if (targetUri != null) {
                    ExportProvider.save(activity, name, targetUri, output -> {
                        if (exportCancelled) throw new InterruptedIOException(s(R.string.cancelled));
                        RootApi.readInbox(activity, name, output, copied, call);
                    }, () -> {
                        FutureTask<Void> fence = new FutureTask<>(() -> {
                            if (activity.isDestroyed() || exportCancelled || call.cancelled.get()) throw new InterruptedIOException(s(R.string.cancelled));
                            exportCommitting = true;
                            exportDialog.getButton(android.content.DialogInterface.BUTTON_NEGATIVE).setEnabled(false);
                            exportProgress.setText(s(R.string.repair_files_save_committing, name, WebFormat.bytes(0))); return null;
                        });
                        activity.runOnUiThread(fence); fence.get();
                    }, copied);
                    activity.runOnUiThread(() -> { finishExport(call); toast(s(R.string.saved)); });
                } else {
                    Uri uri = ExportProvider.export(activity, name, copied, call);
                    if (exportCancelled || call.cancelled.get()) { ExportProvider.discard(activity, uri); throw new InterruptedIOException(s(R.string.cancelled)); }
                    activity.runOnUiThread(() -> {
                        boolean cancelled = exportCancelled; finishExport(call);
                        if (!isCurrent() || cancelled) { discardExports(Collections.singletonList(uri)); return; }
                        try {
                            Intent intent = "share".equals(action) ? new Intent(Intent.ACTION_SEND).setType(ExportProvider.mime(name)).putExtra(Intent.EXTRA_STREAM, uri)
                                    : new Intent(Intent.ACTION_VIEW).setDataAndType(uri, ExportProvider.mime(name));
                            intent.setClipData(ClipData.newRawUri(name, uri)); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            activity.startActivity(Intent.createChooser(intent, s("share".equals(action) ? R.string.share : R.string.open)));
                        } catch (ActivityNotFoundException e) { error(s(R.string.no_viewer)); }
                    });
                }
            } catch (Exception e) {
                boolean partial = exportCommitting;
                activity.runOnUiThread(() -> { finishExport(call); error(RootApi.message(e) + (partial ? "\n" + s(R.string.repair_files_save_partial) : "")); });
            } finally { call.finished = true; }
        });
    }
    private void finishExport(RootApi.Call call) {
        if (exportCall != call) return;
        exportCall = null; exportCommitting = false;
        if (exportDialog != null) { exportDialog.dismiss(); exportDialog = null; }
        updateInboxSelection();
    }
    private void error(String text) { if (!activity.isDestroyed() && !activity.isFinishing()) new MaterialAlertDialogBuilder(activity).setTitle(R.string.error_title).setMessage(text).setPositiveButton(R.string.close, null).show(); }
    private void toast(String text) { if (!activity.isDestroyed()) Toast.makeText(activity, text, Toast.LENGTH_LONG).show(); }
}
