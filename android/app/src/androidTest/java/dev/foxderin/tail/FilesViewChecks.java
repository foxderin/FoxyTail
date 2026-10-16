package dev.foxderin.tail;

import android.view.View;
import android.view.ViewGroup;
import android.widget.*;
import androidx.recyclerview.widget.RecyclerView;
import org.json.*;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;

/** Main-thread checks against the actual themed Files page and its adapters. */
final class FilesViewChecks {
    static void run(FilesPage page) throws Exception {
        JSONObject oldInbox = new JSONObject().put("files", get(page, "inbox"));
        String oldSearch = (String) get(page, "inboxSearch");
        boolean oldLoaded = (boolean) get(page, "inboxLoaded");
        boolean oldLoading = (boolean) get(page, "inboxLoading"); String oldError = (String) get(page, "inboxError"); int oldSort = (int) get(page, "inboxSort");
        @SuppressWarnings("unchecked") Set<String> selected = (Set<String>) get(page, "inboxSelected"); Set<String> oldSelected = new LinkedHashSet<>(selected);
        @SuppressWarnings("unchecked") ArrayList<Models.Transfer> history = (ArrayList<Models.Transfer>) get(page, "history");
        ArrayList<Models.Transfer> oldHistory = new ArrayList<>(history);
        try {
            set(page, "inboxLoading", false); set(page, "inboxError", ""); set(page, "inboxSort", 0); selected.clear();
            JSONArray files = new JSONArray();
            for (int i = 0; i < 1000; i++) files.put(new JSONObject().put("name", String.format(Locale.ROOT, "File %04d.bin", i)).put("size", i).put("mtime", 1));
            set(page, "inbox", files); set(page, "inboxLoaded", true); set(page, "inboxSearch", ""); invoke(page, "renderInbox");
            RecyclerView inbox = (RecyclerView) get(page, "inboxList"); layout(inbox);
            require(inbox.getAdapter().getItemCount() == 1000 && inbox.getChildCount() > 0 && inbox.getChildCount() < 20, "Thousand inbox items create only bounded visible row holders");
            require(description(inbox, page.activity.getString(R.string.web_tools_copy_path) + " File 0000.bin") != null, "Visible inbox retains accessible copy action");
            EditText search = edit((View) get(page, "inboxSection")); require(search != null, "Inbox search is reachable"); search.setText("0999"); layout(inbox);
            require(inbox == get(page, "inboxList") && inbox.getAdapter().getItemCount() == 1 && text(inbox, "File 0999.bin") != null, "Typing filters all thousand files without replacing list/search");
            for (int label : new int[]{R.string.web_tools_copy_path, R.string.web_files_download, R.string.web_files_export, R.string.open, R.string.share})
                require(description(inbox, page.activity.getString(label) + " File 0999.bin") != null, "Filtered row preserves every named accessible action");
            View choose = description(inbox, page.activity.getString(R.string.web_files_select) + " File 0999.bin"); require(choose != null && choose.isEnabled(), "Inbox file can be selected"); choose.performClick();
            View delete = description((View) get(page, "inboxBatchActions"), page.activity.getString(R.string.taildrop_delete_selected));
            require(delete != null && ((View) get(page, "inboxBatchActions")).getVisibility() == View.VISIBLE, "Selected file retains the accessible delete action");
            search.setText("0998"); layout(inbox); ((View) get(page, "selectMatches")).performClick(); layout(inbox);
            require(selected.equals(new LinkedHashSet<>(Arrays.asList("File 0999.bin", "File 0998.bin"))), "Filtered select-all preserves hidden selected files without selecting other matches");
            search.setText(""); layout(inbox); ((View) get(page, "selectMatches")).performClick();
            require(selected.size() == 2, "Over-limit select-all does not silently select a partial result set");
            ((View) get(page, "deselectInbox")).performClick(); layout(inbox); require(selected.isEmpty(), "Deselect clears visible and hidden selected files");
            set(page, "inboxSort", 3); invoke(page, "renderInboxRows"); layout(inbox);
            require(text(inbox.getChildAt(0), "File 0999.bin") != null, "Largest-first sorts the complete inbox before rendering");
            set(page, "inboxSort", 0); invoke(page, "renderInboxRows"); layout(inbox);
            @SuppressWarnings("unchecked") ArrayList<Models.Source> sending = (ArrayList<Models.Source>) get(page, "selection"); ArrayList<Models.Source> savedSelection = new ArrayList<>(sending);
            try {
                sending.add(Models.Source.shared("/sdcard/selected.txt", 1)); invoke(page, "renderSelection");
                View clear = description((View) get(page, "selectedRows"), page.activity.getString(R.string.taildrop_clear_selection)); require(clear != null && clear.isEnabled(), "Clear pending send selection is reachable"); clear.performClick();
                require(sending.isEmpty(), "Clear send selection removes the whole draft without a transfer");
            } finally { sending.clear(); sending.addAll(savedSelection); invoke(page, "renderSelection"); }
            search.setText(""); layout(inbox);
            history.clear();
            for (int i = 0; i < 100; i++) history.add(transfer(i, 0));
            invoke(page, "renderHistory"); RecyclerView transfers = (RecyclerView) get(page, "historyList"); layout(transfers);
            require(transfers.getAdapter().getItemCount() == 100 && transfers.getChildCount() > 0 && transfers.getChildCount() < 5, "Hundred 32-file histories create bounded transfer rows");
            View first = transfers.getChildAt(0), firstTitle = text(first, "Peer 0 · 100.64.0.1");
            final int[] changed = {0}, fullRefresh = {0};
            RecyclerView.AdapterDataObserver observer = new RecyclerView.AdapterDataObserver() {
                @Override public void onChanged() { fullRefresh[0]++; }
                @Override public void onItemRangeChanged(int start, int count) { changed[0] += count; }
                @Override public void onItemRangeChanged(int start, int count, Object payload) { changed[0] += count; }
            };
            transfers.getAdapter().registerAdapterDataObserver(observer);
            history.set(99, transfer(99, 1)); invoke(page, "renderHistory"); layout(transfers);
            require(fullRefresh[0] == 0 && changed[0] == 1 && transfers.getChildAt(0) == first && text(first, "Peer 0 · 100.64.0.1") == firstTitle, "One progress change does not rebuild unrelated 100x32 history rows");
            transfers.getAdapter().unregisterAdapterDataObserver(observer);
            retainedReads(page);
            pendingShareState(page);
            browser(page);
        } finally {
            set(page, "inbox", oldInbox.getJSONArray("files")); set(page, "inboxSearch", oldSearch); set(page, "inboxLoaded", oldLoaded);
            set(page, "inboxLoading", oldLoading); set(page, "inboxError", oldError); set(page, "inboxSort", oldSort); selected.clear(); selected.addAll(oldSelected);
            history.clear(); history.addAll(oldHistory); invoke(page, "renderInbox"); invoke(page, "renderHistory");
        }
    }
    private static void pendingShareState(FilesPage page) throws Exception {
        @SuppressWarnings("unchecked") Set<android.net.Uri> pending = (Set<android.net.Uri>) get(page, "resolvingUris");
        Set<android.net.Uri> before = new LinkedHashSet<>(pending);
        @SuppressWarnings("unchecked") ArrayList<Models.Source> selection = (ArrayList<Models.Source>) get(page, "selection");
        ArrayList<Models.Source> selected = new ArrayList<>(selection);
        android.net.Uri uri = android.net.Uri.parse("content://example.documents/document/pending");
        try {
            pending.clear(); selection.clear(); pending.add(uri);
            android.os.Bundle saved = new android.os.Bundle(); page.saveState(saved);
            require(saved.getStringArrayList("selection").equals(Collections.singletonList(uri.toString())), "A shared URI still resolving survives host recreation");
            selection.add(new Models.Source(uri, "pending.txt", 1)); page.saveState(saved);
            require(saved.getStringArrayList("selection").equals(Collections.singletonList(uri.toString())), "Resolved and pending references restore only one selection");
            invoke(page, "renderSelection");
            description((View) get(page, "selectedRows"), page.activity.getString(R.string.taildrop_clear_selection)).performClick();
            page.saveState(saved);
            require(pending.isEmpty() && saved.getStringArrayList("selection").isEmpty(), "Cleared selections cannot reappear from pending URI metadata");
        } finally { pending.clear(); pending.addAll(before); selection.clear(); selection.addAll(selected); invoke(page, "renderSelection"); }
    }
    private static void retainedReads(FilesPage page) throws Exception {
        ControlActivity activity = page.activity;
        String[] flags = {"inboxLoading", "targetsLoading", "historyLoading", "inboxQueued", "targetsQueued", "historyQueued"};
        Object[] before = new Object[flags.length];
        for (int i = 0; i < flags.length; i++) before[i] = get(page, flags[i]);
        int inbox = (int) get(page, "inboxGeneration"), targets = (int) get(page, "targetsGeneration"), history = (int) get(page, "historyGeneration");
        @SuppressWarnings("unchecked") ArrayList<Models.Source> sending = (ArrayList<Models.Source>) get(page, "selection");
        ArrayList<Models.Source> savedSending = new ArrayList<>(sending);
        @SuppressWarnings("unchecked") Set<String> selected = (Set<String>) get(page, "inboxSelected");
        Set<String> savedSelected = new LinkedHashSet<>(selected);
        @SuppressWarnings("unchecked") ArrayList<Models.Transfer> transfers = (ArrayList<Models.Transfer>) get(page, "history");
        ArrayList<Models.Transfer> savedTransfers = new ArrayList<>(transfers);
        @SuppressWarnings("unchecked") ArrayDeque<String> back = (ArrayDeque<String>) get(activity, "back");
        ArrayDeque<String> savedBack = new ArrayDeque<>(back);
        String search = (String) get(page, "inboxSearch"), peer = (String) get(page, "selectedPeer"), snapshot = (String) get(page, "observedSnapshot");
        View root = (View) get(activity, "root"), decor = activity.getWindow().getDecorView();
        ViewGroup host = (ViewGroup) get(activity, "pageHost");
        View more = root.findViewWithTag("more"), files = root.findViewWithTag("files");
        Models.Source draft = Models.Source.shared("/sdcard/navigation-draft.txt", 1);
        try {
            // Freeze section reads and exclude synthetic transfer recovery while exercising real navigation.
            for (int i = 0; i < flags.length; i++) set(page, flags[i], i < 3);
            transfers.clear(); set(page, "observedSnapshot", TransferService.state(activity).getString("snapshot", null));
            sending.clear(); sending.add(draft); selected.clear(); selected.add("File 0999.bin");
            set(page, "selectedPeer", "navigation-peer");
            EditText filter = edit((View) get(page, "inboxSection")); require(filter != null, "Retained Files filter is reachable"); filter.setText("0999");
            invoke(page, "renderSelection");
            page.onPause(); page.load();
            require((boolean) get(page, "inboxLoading") && (boolean) get(page, "targetsLoading") && (boolean) get(page, "historyLoading"), "Pause retains in-flight section ownership");
            require(inbox == (int) get(page, "inboxGeneration") && targets == (int) get(page, "targetsGeneration") && history == (int) get(page, "historyGeneration"), "Reentry does not launch replacement slow read waves");
            require(!(boolean) get(page, "inboxQueued") && !(boolean) get(page, "targetsQueued") && !(boolean) get(page, "historyQueued"), "Reentry joins without scheduling duplicate completion refresh");
            require(more != null && files != null && page.isCurrent() && host.getChildAt(0) == page.content && page.content.isAttachedToWindow(), "Files starts inside the visible shared shell");
            more.performClick();
            require("more".equals(get(activity, "destination")) && get(activity, "page") != page && page.content.getParent() == null && !page.isCurrent(), "Leaving Files switches the current page inside this Activity");
            require(get(activity, "root") == root && activity.getWindow().getDecorView() == decor && root.isAttachedToWindow() && root.isShown(), "Leaving Files retains the visible shell and window");
            files.performClick();
            require(get(activity, "filesPage") == page && get(activity, "page") == page && page.isCurrent() && host.getChildCount() == 1 && host.getChildAt(0) == page.content, "Returning to Files reuses the retained page in the same content host");
            require(sending.size() == 1 && sending.get(0) == draft && selected.equals(Collections.singleton("File 0999.bin")) && "navigation-peer".equals(get(page, "selectedPeer")) && "0999".equals(filter.getText().toString()) && filter == edit((View) get(page, "inboxSection")), "Files round trip preserves send draft, recipient, inbox selection and search widget");
            require((boolean) get(page, "inboxLoading") && (boolean) get(page, "targetsLoading") && (boolean) get(page, "historyLoading") && inbox == (int) get(page, "inboxGeneration") && targets == (int) get(page, "targetsGeneration") && history == (int) get(page, "historyGeneration"), "Route round trip retains all in-flight section owners without replacement reads");
            require(!(boolean) get(page, "inboxQueued") && !(boolean) get(page, "targetsQueued") && !(boolean) get(page, "historyQueued"), "Route round trip does not queue duplicate refreshes");
            activity.getOnBackPressedDispatcher().onBackPressed();
            require("more".equals(get(activity, "destination")) && !activity.isFinishing(), "Back from Files returns to the preceding page instead of finishing an Activity");
            activity.getOnBackPressedDispatcher().onBackPressed();
            require(get(activity, "page") == page && page.isCurrent() && !activity.isFinishing() && get(activity, "root") == root && activity.getWindow().getDecorView() == decor && root.isShown(), "Back through ordinary navigation returns to the same Files page and visible shell");
            require(sending.size() == 1 && sending.get(0) == draft && selected.contains("File 0999.bin"), "Back navigation also retains both draft selections");
        } finally {
            if (!activity.isFinishing()) activity.navigate("files");
            back.clear(); back.addAll(savedBack);
            sending.clear(); sending.addAll(savedSending); selected.clear(); selected.addAll(savedSelected);
            transfers.clear(); transfers.addAll(savedTransfers);
            set(page, "inboxSearch", search); set(page, "selectedPeer", peer); set(page, "observedSnapshot", snapshot);
            for (int i = 0; i < flags.length; i++) set(page, flags[i], before[i]);
            invoke(page, "renderSelection"); invoke(page, "renderInbox"); invoke(page, "renderHistory");
        }
    }
    private static void browser(FilesPage page) throws Exception {
        QueuedExecutor executor = new QueuedExecutor(); LinearLayout rows = new LinearLayout(page.activity); rows.setOrientation(LinearLayout.VERTICAL);
        ArrayList<String> remembered = new ArrayList<>();
        FilesBrowser browser = new FilesBrowser(page.activity, executor, rows, "Download/slow", source -> false, path -> false, path -> { }, remembered::add, () -> false, () -> true);
        try {
            RootApi.Call old = (RootApi.Call) get(browser, "pending");
            View up = description(rows, page.activity.getString(R.string.web_files_parent)); require(up != null && up.isEnabled(), "Parent navigation stays reachable during slow read"); up.performClick();
            require(old.cancelled.get() && ((Future<?>) executor.tasks.get(0)).isCancelled() && remembered.get(1).equals("Download"), "New navigation cancels queued stale request before it consumes a worker");
            RootApi.Call second = (RootApi.Call) get(browser, "pending");
            TextView root = text(rows, "/sdcard"); require(root != null && root.isEnabled(), "Root navigation stays reachable during slow read"); root.performClick();
            require(second.cancelled.get() && remembered.get(2).isEmpty() && (int) get(browser, "revision") == 3, "Root supersedes parent with its own callback generation");
            browser.close(); require(((RootApi.Call) get(browser, "pending")).cancelled.get(), "Closed browser cancels last queued read");
            for (Runnable task : executor.tasks) task.run();
            require(remembered.size() == 3 && text(rows, "/sdcard") != null, "Cancelled queued jobs never render a ghost navigation");
        } finally { browser.close(); executor.shutdown(); }
    }
    private static Models.Transfer transfer(int index, long progress) throws Exception {
        JSONArray files = new JSONArray();
        for (int i = 0; i < 32; i++) files.put(new JSONObject().put("id", String.format(Locale.ROOT, "%032x", i + 1)).put("name", "part-" + i).put("path", "/sdcard/part-" + i).put("status", index == 99 ? "sending" : "completed").put("size", 100).put("sentBytes", index == 99 ? progress : 100).put("bytesPerSecond", 0).put("progressKnown", true));
        return new Models.Transfer(new JSONObject().put("id", String.format(Locale.ROOT, "%032x", index + 1)).put("peerId", "peer-" + index).put("peerName", "Peer " + index).put("peerIp", "100.64.0.1").put("selfId", "self").put("status", index == 99 ? "sending" : "completed").put("startedAt", 100 - index).put("updatedAt", progress + 1).put("files", files));
    }
    private static final class QueuedExecutor extends AbstractExecutorService {
        final ArrayList<Runnable> tasks = new ArrayList<>(); private boolean stopped;
        public void execute(Runnable task) { tasks.add(task); }
        public void shutdown() { stopped = true; }
        public List<Runnable> shutdownNow() { stopped = true; return new ArrayList<>(tasks); }
        public boolean isShutdown() { return stopped; }
        public boolean isTerminated() { return stopped; }
        public boolean awaitTermination(long timeout, TimeUnit unit) { return stopped; }
    }
    private static void layout(View view) { view.measure(View.MeasureSpec.makeMeasureSpec(960, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY)); view.layout(0, 0, 960, 600); }
    private static TextView text(View root, String expected) {
        if (root instanceof TextView && expected.contentEquals(((TextView) root).getText())) return (TextView) root;
        if (root instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) root).getChildCount(); i++) { TextView result = text(((ViewGroup) root).getChildAt(i), expected); if (result != null) return result; }
        return null;
    }
    private static View description(View root, String expected) {
        if (expected.contentEquals(root.getContentDescription() == null ? "" : root.getContentDescription())) return root;
        if (root instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) root).getChildCount(); i++) { View result = description(((ViewGroup) root).getChildAt(i), expected); if (result != null) return result; }
        return null;
    }
    private static EditText edit(View root) {
        if (root instanceof EditText) return (EditText) root;
        if (root instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) root).getChildCount(); i++) { EditText result = edit(((ViewGroup) root).getChildAt(i)); if (result != null) return result; }
        return null;
    }
    private static Object get(Object object, String name) throws Exception { Field field = object.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(object); }
    private static void set(Object object, String name, Object value) throws Exception { Field field = object.getClass().getDeclaredField(name); field.setAccessible(true); field.set(object, value); }
    private static void invoke(Object object, String name) throws Exception { Method method = object.getClass().getDeclaredMethod(name); method.setAccessible(true); method.invoke(object); }
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
