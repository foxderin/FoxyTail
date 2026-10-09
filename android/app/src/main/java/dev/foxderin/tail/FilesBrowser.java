package dev.foxderin.tail;

import android.app.Activity;
import androidx.appcompat.app.AlertDialog;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.checkbox.MaterialCheckBox;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import android.widget.*;
import org.json.*;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.Executor;
import java.util.function.*;

final class FilesBrowser {
    static final class Entry {
        final String name, path; final boolean directory; final long size;
        Entry(JSONObject item, String parent) throws Exception {
            name = Models.required(item, "name"); Models.requireName(name);
            path = Models.required(item, "path");
            if (!Models.sharedPath(path) || !path.equals("/sdcard/" + (parent.isEmpty() ? "" : parent + "/") + name) || !(item.get("directory") instanceof Boolean)) throw new IOException("Invalid browse entry");
            directory = item.getBoolean("directory"); size = Models.number(item, "size"); Models.number(item, "mtime");
        }
    }
    static List<Entry> parse(JSONObject result, String requested) throws Exception {
        if (!Models.relativePath(requested) || !result.getBoolean("ok") || !requested.equals(result.get("path")) || !(result.get("truncated") instanceof Boolean)) throw new IOException("Invalid browse response");
        JSONArray entries = result.getJSONArray("entries");
        if (entries.length() > 1000) throw new IOException("Invalid browse count");
        ArrayList<Entry> parsed = new ArrayList<>(); Set<String> paths = new HashSet<>();
        for (int i = 0; i < entries.length(); i++) {
            Entry entry = new Entry(entries.getJSONObject(i), requested);
            if (!paths.add(entry.path)) throw new IOException("Duplicate browse entry");
            parsed.add(entry);
        }
        return parsed;
    }
    private final Activity activity;
    private final Executor io;
    private final Predicate<Models.Source> select;
    private final Predicate<String> selected;
    private final Consumer<String> remove, remember;
    private final AlertDialog dialog;
    private final LinearLayout rows;
    private String directory;
    private int revision;
    FilesBrowser(Activity activity, Executor io, String directory, Predicate<Models.Source> select, Predicate<String> selected, Consumer<String> remove, Consumer<String> remember) {
        this.activity = activity; this.io = io; this.directory = Models.relativePath(directory) ? directory : "";
        this.select = select; this.selected = selected; this.remove = remove; this.remember = remember;
        rows = new LinearLayout(activity); rows.setOrientation(LinearLayout.VERTICAL);
        int padding = ControlUi.dp(activity, 16); rows.setPadding(padding, padding, padding, padding);
        ScrollView scroll = new ScrollView(activity); scroll.addView(rows);
        dialog = new MaterialAlertDialogBuilder(activity).setTitle(R.string.files_browse).setView(scroll).setNegativeButton(R.string.close, null).create();
        dialog.show(); browse(this.directory);
    }
    private void text(String value) { TextView view = ControlUi.text(activity, value, 16); view.setTextIsSelectable(true); rows.addView(view); }
    private void button(int label, Runnable click) { rows.addView(ControlUi.button(activity, activity.getString(label), click)); }
    private void header() {
        rows.removeAllViews(); text("/sdcard/" + directory);
        if (!directory.isEmpty()) button(R.string.files_parent, () -> { int slash = directory.lastIndexOf('/'); browse(slash < 0 ? "" : directory.substring(0, slash)); });
        button(R.string.refresh, () -> browse(directory));
    }
    private void browse(String path) {
        directory = path; remember.accept(path); final int token = ++revision;
        header(); text(activity.getString(R.string.loading));
        io.execute(() -> {
            try {
                JSONObject result = RootApi.json(activity, "files-browse", path.isEmpty() ? "-" : path);
                List<Entry> entries = parse(result, path); boolean truncated = result.getBoolean("truncated");
                activity.runOnUiThread(() -> {
                    if (activity.isDestroyed() || !dialog.isShowing() || token != revision) return;
                    header(); text(activity.getString(R.string.file_limit));
                    if (truncated) text(activity.getString(R.string.files_truncated));
                    if (entries.isEmpty()) text(activity.getString(R.string.files_empty_directory));
                    for (Entry entry : entries) {
                        if (entry.directory) {
                            MaterialButton folder = ControlUi.button(activity, entry.name + "/", () -> browse(entry.path.substring(8)));
                            folder.setSingleLine(false); folder.setMaxLines(Integer.MAX_VALUE); folder.setEllipsize(null); rows.addView(folder);
                        } else {
                            MaterialCheckBox check = new MaterialCheckBox(activity); check.setText(entry.name + " · " + Models.bytes(activity, entry.size));
                            check.setMinHeight(ControlUi.dp(activity, 48)); check.setSingleLine(false); check.setEllipsize(null);
                            check.setChecked(selected.test(entry.path)); check.setEnabled(entry.size <= RootApi.MAX_FILE);
                            check.setOnCheckedChangeListener((view, checked) -> {
                                if (!checked) { remove.accept(entry.path); return; }
                                try { if (select.test(Models.Source.shared(entry.path, entry.size))) return; }
                                catch (IOException ignored) { }
                                view.setChecked(false); Toast.makeText(activity, R.string.file_limit, Toast.LENGTH_LONG).show();
                            });
                            rows.addView(check);
                        }
                    }
                });
            } catch (Exception error) {
                activity.runOnUiThread(() -> {
                    if (activity.isDestroyed() || !dialog.isShowing() || token != revision) return;
                    header(); text(RootApi.message(error));
                });
            }
        });
    }
}
