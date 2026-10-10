package dev.foxderin.tail;

import android.app.Activity;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.checkbox.MaterialCheckBox;
import android.view.Gravity;
import android.widget.*;
import org.json.*;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.Executor;
import java.util.function.*;

final class FilesBrowser {
    static final class Entry {
        final String name, path; final boolean directory; final long size, mtime;
        Entry(JSONObject item, String parent) throws Exception {
            name = Models.required(item, "name"); Models.requireName(name);
            path = Models.required(item, "path");
            if (!Models.sharedPath(path) || !path.equals("/sdcard/" + (parent.isEmpty() ? "" : parent + "/") + name) || !(item.get("directory") instanceof Boolean)) throw new IOException("Invalid browse entry");
            directory = item.getBoolean("directory"); size = Models.number(item, "size"); mtime = Models.number(item, "mtime");
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
    private final BooleanSupplier locked, capacity;
    private final Map<MaterialCheckBox, Entry> choices = new LinkedHashMap<>();
    private final LinearLayout rows;
    private String directory;
    private int revision;
    private boolean closed, browsing, updatingSelection;
    FilesBrowser(Activity activity, Executor io, LinearLayout rows, String directory, Predicate<Models.Source> select, Predicate<String> selected, Consumer<String> remove, Consumer<String> remember, BooleanSupplier locked, BooleanSupplier capacity) {
        this.activity = activity; this.io = io; this.directory = Models.relativePath(directory) ? directory : "";
        this.select = select; this.selected = selected; this.remove = remove; this.remember = remember;
        this.rows = rows; this.locked = locked; this.capacity = capacity;
        browse(this.directory);
    }
    void close() { closed = true; revision++; }
    void updateSelection() {
        updatingSelection = true;
        for (Map.Entry<MaterialCheckBox, Entry> choice : choices.entrySet()) {
            Entry entry = choice.getValue(); boolean checked = selected.test(entry.path);
            choice.getKey().setChecked(checked);
            choice.getKey().setEnabled(!locked.getAsBoolean() && entry.size <= RootApi.MAX_FILE && (checked || capacity.getAsBoolean()));
        }
        updatingSelection = false;
    }
    private void text(String value) { ControlUi.hint(rows, value); }
    private void header() {
        rows.removeAllViews(); choices.clear();
        HorizontalScrollView scroll = new HorizontalScrollView(activity); scroll.setHorizontalScrollBarEnabled(false); rows.addView(scroll);
        LinearLayout crumbs = new LinearLayout(activity); scroll.addView(crumbs);
        crumbs.setContentDescription(activity.getString(R.string.web_files_location));
        MaterialButton root = ControlUi.textButton(activity, "/sdcard", () -> browse("")); root.setEnabled(!browsing); crumbs.addView(root);
        String path = "";
        for (String part : directory.split("/")) {
            if (part.isEmpty()) continue;
            path += (path.isEmpty() ? "" : "/") + part; String destination = path;
            MaterialButton crumb = ControlUi.textButton(activity, part, () -> browse(destination)); crumb.setEnabled(!browsing); crumbs.addView(crumb);
        }
        LinearLayout actions = new LinearLayout(activity); rows.addView(actions);
        MaterialButton parent = ControlUi.textButton(activity, activity.getString(R.string.web_files_parent), () -> { int slash = directory.lastIndexOf('/'); browse(slash < 0 ? "" : directory.substring(0, slash)); });
        parent.setEnabled(!browsing && !directory.isEmpty()); actions.addView(parent);
        MaterialButton refresh = ControlUi.textButton(activity, activity.getString(browsing ? R.string.web_loading : R.string.web_tools_refresh), () -> browse(directory));
        refresh.setEnabled(!browsing); actions.addView(refresh);
    }
    private void browse(String path) {
        if (closed || browsing) return;
        browsing = true; directory = path; remember.accept(path); final int token = ++revision;
        header(); text(activity.getString(R.string.web_loading));
        io.execute(() -> {
            try {
                JSONObject result = RootApi.json(activity, "files-browse", path.isEmpty() ? "-" : path);
                List<Entry> entries = parse(result, path); boolean truncated = result.getBoolean("truncated");
                activity.runOnUiThread(() -> {
                    if (activity.isDestroyed() || closed || token != revision) return;
                    browsing = false; header();
                    if (entries.isEmpty()) text(activity.getString(R.string.web_files_directory_empty));
                    for (int i = 0; i < entries.size(); i++) {
                        Entry entry = entries.get(i);
                        if (i > 0) ControlUi.divider(rows);
                        LinearLayout row = new LinearLayout(activity); row.setGravity(Gravity.CENTER_VERTICAL);
                        int gap = ControlUi.dp(activity, 12); row.setPadding(0, ControlUi.dp(activity, 14), 0, ControlUi.dp(activity, 14)); row.setMinimumHeight(ControlUi.dp(activity, 56));
                        rows.addView(row, new LinearLayout.LayoutParams(-1, -2));
                        ImageView icon = new ImageView(activity); icon.setImageResource(entry.directory ? R.drawable.ic_folder : R.drawable.ic_article);
                        icon.setColorFilter(com.google.android.material.color.MaterialColors.getColor(icon, com.google.android.material.R.attr.colorOnSurfaceVariant));
                        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(ControlUi.dp(activity, 20), ControlUi.dp(activity, 20)); iconParams.setMarginEnd(gap); row.addView(icon, iconParams);
                        LinearLayout main = new LinearLayout(activity); main.setOrientation(LinearLayout.VERTICAL); row.addView(main, new LinearLayout.LayoutParams(0, -2, 1));
                        TextView title = ControlUi.text(activity, entry.name, 14); title.setTypeface(null, android.graphics.Typeface.BOLD); main.addView(title);
                        TextView detail = ControlUi.muted(activity, (entry.directory ? activity.getString(R.string.web_files_directory) : WebFormat.bytes(entry.size)) + " · " + WebFormat.time(entry.mtime), R.dimen.ft_body_small);
                        detail.setTextSize(12); detail.setPadding(0, ControlUi.dp(activity, 3), 0, 0); main.addView(detail);
                        if (entry.directory) {
                            MaterialButton folder = ControlUi.textButton(activity, activity.getString(R.string.web_files_open_directory), () -> browse(entry.path.substring(8)));
                            folder.setContentDescription(activity.getString(R.string.web_files_open_directory) + " " + entry.name);
                            row.addView(folder, new LinearLayout.LayoutParams(ControlUi.dp(activity, 100), -2));
                        } else {
                            MaterialCheckBox check = new MaterialCheckBox(activity);
                            check.setContentDescription(activity.getString(R.string.web_files_select) + " " + entry.name);
                            check.setMinHeight(ControlUi.dp(activity, 48)); check.setMinimumWidth(ControlUi.dp(activity, 48));
                            check.setChecked(selected.test(entry.path)); choices.put(check, entry);
                            check.setOnCheckedChangeListener((view, checked) -> {
                                if (updatingSelection) return;
                                if (locked.getAsBoolean()) { updateSelection(); return; }
                                if (!checked) { remove.accept(entry.path); updateSelection(); return; }
                                try { if (select.test(Models.Source.shared(entry.path, entry.size))) { updateSelection(); return; } }
                                catch (IOException ignored) { }
                                updateSelection(); Toast.makeText(activity, R.string.file_limit, Toast.LENGTH_LONG).show();
                            });
                            row.addView(check);
                        }
                    }
                    updateSelection();
                    if (truncated) text(activity.getString(R.string.web_files_truncated));
                });
            } catch (Exception error) {
                activity.runOnUiThread(() -> {
                    if (activity.isDestroyed() || closed || token != revision) return;
                    browsing = false; header();
                    ControlUi.banner(rows, R.drawable.ic_error, RootApi.message(error), ControlUi.TONE_ERROR);
                    text(activity.getString(R.string.web_files_storage_hint));
                });
            }
        });
    }
}
