package dev.foxderin.tail;

import android.view.View;
import android.view.ViewGroup;
import android.widget.*;
import androidx.recyclerview.widget.RecyclerView;
import org.json.*;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;

/** Main-thread checks against the actual themed Files activity and its adapters. */
final class FilesViewChecks {
    static void run(MainActivity activity) throws Exception {
        JSONObject oldInbox = new JSONObject().put("files", get(activity, "inbox"));
        String oldSearch = (String) get(activity, "inboxSearch");
        boolean oldLoaded = (boolean) get(activity, "inboxLoaded");
        boolean oldLoading = (boolean) get(activity, "inboxLoading"); String oldError = (String) get(activity, "inboxError"); int oldSort = (int) get(activity, "inboxSort");
        @SuppressWarnings("unchecked") Set<String> selected = (Set<String>) get(activity, "inboxSelected"); Set<String> oldSelected = new LinkedHashSet<>(selected);
        @SuppressWarnings("unchecked") ArrayList<Models.Transfer> history = (ArrayList<Models.Transfer>) get(activity, "history");
        ArrayList<Models.Transfer> oldHistory = new ArrayList<>(history);
        try {
            set(activity, "inboxLoading", false); set(activity, "inboxError", ""); set(activity, "inboxSort", 0); selected.clear();
            JSONArray files = new JSONArray();
            for (int i = 0; i < 1000; i++) files.put(new JSONObject().put("name", String.format(Locale.ROOT, "File %04d.bin", i)).put("size", i).put("mtime", 1));
            set(activity, "inbox", files); set(activity, "inboxLoaded", true); set(activity, "inboxSearch", ""); invoke(activity, "renderInbox");
            RecyclerView inbox = (RecyclerView) get(activity, "inboxList"); layout(inbox);
            require(inbox.getAdapter().getItemCount() == 1000 && inbox.getChildCount() > 0 && inbox.getChildCount() < 20, "Thousand inbox items create only bounded visible row holders");
            require(description(inbox, activity.getString(R.string.web_tools_copy_path) + " File 0000.bin") != null, "Visible inbox retains accessible copy action");
            EditText search = edit((View) get(activity, "inboxSection")); require(search != null, "Inbox search is reachable"); search.setText("0999"); layout(inbox);
            require(inbox == get(activity, "inboxList") && inbox.getAdapter().getItemCount() == 1 && text(inbox, "File 0999.bin") != null, "Typing filters all thousand files without replacing list/search");
            for (int label : new int[]{R.string.web_tools_copy_path, R.string.web_files_download, R.string.web_files_export, R.string.web_files_delete, R.string.open, R.string.share})
                require(description(inbox, activity.getString(label) + " File 0999.bin") != null, "Filtered row preserves every named accessible action");
            View choose = description(inbox, activity.getString(R.string.web_files_select) + " File 0999.bin"); require(choose != null && choose.isEnabled(), "Inbox file can be selected"); choose.performClick();
            search.setText("0998"); layout(inbox); ((View) get(activity, "selectMatches")).performClick(); layout(inbox);
            require(selected.equals(new LinkedHashSet<>(Arrays.asList("File 0999.bin", "File 0998.bin"))), "Filtered select-all preserves hidden selected files without selecting other matches");
            search.setText(""); layout(inbox); ((View) get(activity, "selectMatches")).performClick();
            require(selected.size() == 2, "Over-limit select-all does not silently select a partial result set");
            ((View) get(activity, "deselectInbox")).performClick(); layout(inbox); require(selected.isEmpty(), "Deselect clears visible and hidden selected files");
            set(activity, "inboxSort", 3); invoke(activity, "renderInboxRows"); layout(inbox);
            require(text(inbox.getChildAt(0), "File 0999.bin") != null, "Largest-first sorts the complete inbox before rendering");
            set(activity, "inboxSort", 0); invoke(activity, "renderInboxRows"); layout(inbox);
            @SuppressWarnings("unchecked") ArrayList<Models.Source> sending = (ArrayList<Models.Source>) get(activity, "selection"); ArrayList<Models.Source> savedSelection = new ArrayList<>(sending);
            try {
                sending.add(Models.Source.shared("/sdcard/selected.txt", 1)); invoke(activity, "renderSelection");
                View clear = description((View) get(activity, "selectedRows"), activity.getString(R.string.taildrop_clear_selection)); require(clear != null && clear.isEnabled(), "Clear pending send selection is reachable"); clear.performClick();
                require(sending.isEmpty(), "Clear send selection removes the whole draft without a transfer");
            } finally { sending.clear(); sending.addAll(savedSelection); invoke(activity, "renderSelection"); }
            search.setText(""); layout(inbox);
            history.clear();
            for (int i = 0; i < 100; i++) history.add(transfer(i, 0));
            invoke(activity, "renderHistory"); RecyclerView transfers = (RecyclerView) get(activity, "historyList"); layout(transfers);
            require(transfers.getAdapter().getItemCount() == 100 && transfers.getChildCount() > 0 && transfers.getChildCount() < 5, "Hundred 32-file histories create bounded transfer rows");
            View first = transfers.getChildAt(0), firstTitle = text(first, "Peer 0 · 100.64.0.1");
            final int[] changed = {0}, fullRefresh = {0};
            RecyclerView.AdapterDataObserver observer = new RecyclerView.AdapterDataObserver() {
                @Override public void onChanged() { fullRefresh[0]++; }
                @Override public void onItemRangeChanged(int start, int count) { changed[0] += count; }
                @Override public void onItemRangeChanged(int start, int count, Object payload) { changed[0] += count; }
            };
            transfers.getAdapter().registerAdapterDataObserver(observer);
            history.set(99, transfer(99, 1)); invoke(activity, "renderHistory"); layout(transfers);
            require(fullRefresh[0] == 0 && changed[0] == 1 && transfers.getChildAt(0) == first && text(first, "Peer 0 · 100.64.0.1") == firstTitle, "One progress change does not rebuild unrelated 100x32 history rows");
            transfers.getAdapter().unregisterAdapterDataObserver(observer);
            retainedReads(activity);
            browser(activity);
        } finally {
            set(activity, "inbox", oldInbox.getJSONArray("files")); set(activity, "inboxSearch", oldSearch); set(activity, "inboxLoaded", oldLoaded);
            set(activity, "inboxLoading", oldLoading); set(activity, "inboxError", oldError); set(activity, "inboxSort", oldSort); selected.clear(); selected.addAll(oldSelected);
            history.clear(); history.addAll(oldHistory); invoke(activity, "renderInbox"); invoke(activity, "renderHistory");
        }
    }
    private static void retainedReads(MainActivity activity) throws Exception {
        String[] flags = {"inboxLoading", "targetsLoading", "historyLoading", "inboxQueued", "targetsQueued", "historyQueued"};
        Object[] before = new Object[flags.length];
        int inbox = (int) get(activity, "inboxGeneration"), targets = (int) get(activity, "targetsGeneration"), history = (int) get(activity, "historyGeneration");
        Field field = ControlActivity.class.getDeclaredField("page"); field.setAccessible(true); Object page = field.get(activity);
        try {
            for (int i = 0; i < flags.length; i++) { before[i] = get(activity, flags[i]); set(activity, flags[i], i < 3); }
            invoke(page, "onPause"); invoke(page, "load");
            require((boolean) get(activity, "inboxLoading") && (boolean) get(activity, "targetsLoading") && (boolean) get(activity, "historyLoading"), "Pause retains in-flight section ownership");
            require(inbox == (int) get(activity, "inboxGeneration") && targets == (int) get(activity, "targetsGeneration") && history == (int) get(activity, "historyGeneration"), "Reentry does not launch replacement slow read waves");
            require(!(boolean) get(activity, "inboxQueued") && !(boolean) get(activity, "targetsQueued") && !(boolean) get(activity, "historyQueued"), "Reentry joins without scheduling duplicate completion refresh");
        } finally { for (int i = 0; i < flags.length; i++) set(activity, flags[i], before[i]); }
    }
    private static void browser(MainActivity activity) throws Exception {
        QueuedExecutor executor = new QueuedExecutor(); LinearLayout rows = new LinearLayout(activity); rows.setOrientation(LinearLayout.VERTICAL);
        ArrayList<String> remembered = new ArrayList<>();
        FilesBrowser browser = new FilesBrowser(activity, executor, rows, "Download/slow", source -> false, path -> false, path -> { }, remembered::add, () -> false, () -> true);
        try {
            RootApi.Call old = (RootApi.Call) get(browser, "pending");
            TextView up = text(rows, activity.getString(R.string.web_files_parent)); require(up != null && up.isEnabled(), "Parent navigation stays reachable during slow read"); up.performClick();
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
