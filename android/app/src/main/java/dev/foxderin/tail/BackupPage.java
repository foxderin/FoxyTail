package dev.foxderin.tail;

import android.view.View;
import android.widget.*;
import org.json.*;

final class BackupPage extends ControlPage {
    private final LinearLayout archives, previewRows, latest, restored;
    private final Button previewButton;
    private MaterialChoice archiveChoice;
    private String[] archivePaths = {""};
    private String selected = "";
    private JSONObject preview;
    private int generation;
    private boolean observing;
    private final Runnable operationChanged = () -> { if (activity.client.busy()) invalidatePreview(); };
    BackupPage(ControlActivity activity) {
        super(activity);
        LinearLayout backup = section(s(R.string.web_set_backup), R.drawable.ic_backup, s(R.string.web_tools_backup_desc));
        tonal(backup, s(R.string.web_set_backup), () -> {
            invalidatePreview(); mutate(s(R.string.web_set_backup), result -> {
                if (ToolsUi.success(this, result)) { activity.drafts.putString("backup.latest", result.toString()); renderArtifact(result); refreshList(); }
            }, "backup");
        });
        latest = ControlUi.result(backup); latest.setVisibility(View.GONE);
        LinearLayout restore = section(s(R.string.web_set_restore), R.drawable.ic_refresh, s(R.string.web_backup_picker_hint));
        archives = new LinearLayout(activity); archives.setOrientation(LinearLayout.VERTICAL); restore.addView(archives);
        LinearLayout actions = row(restore);
        textButton(actions, s(R.string.web_backup_refresh), this::refreshList);
        previewButton = primary(actions, s(R.string.web_backup_preview), this::inspect); previewButton.setEnabled(false);
        textButton(restore, s(R.string.tools_import), () -> activity.pickBackup(id -> {
            if (!isCurrent()) return;
            activity.drafts.remove("backup.importedArtifact"); select(id); refreshList(); inspect();
        }));
        previewRows = ControlUi.result(restore); previewRows.setVisibility(View.GONE);
        restored = section(s(R.string.web_tools_restore_result), R.drawable.ic_backup, null); ControlUi.setCardVisible(restored, false);
    }
    String title() { return s(R.string.web_set_backup); }
    void onPause() {
        if (observing) { observing = false; activity.client.removeListener(operationChanged); }
        invalidatePreview();
    }
    void onClose() { onPause(); }
    void load() {
        if (!observing) { observing = true; activity.client.addListener(operationChanged); }
        invalidatePreview();
        selected = activity.drafts.getString("backup.selected", ""); previewButton.setEnabled(!selected.isEmpty());
        JSONObject lastBackup = activity.client.lastResult("backup"), lastRestore = activity.client.lastResult("restore");
        if (lastBackup != null && lastBackup.optBoolean("ok")) activity.drafts.putString("backup.latest", lastBackup.toString());
        if (lastRestore != null && lastRestore.optBoolean("ok")) activity.drafts.putString("backup.restored", lastRestore.toString());
        try {
            String artifact = activity.drafts.getString("backup.latest", ""), result = activity.drafts.getString("backup.restored", "");
            if (!artifact.isEmpty()) renderArtifact(new JSONObject(artifact)); if (!result.isEmpty()) renderRestore(new JSONObject(result));
        } catch (Exception error) { error(error); }
        if (selected.matches("art-[a-f0-9]{32}")) select(selected);
        String imported = activity.drafts.getString("backup.importedArtifact", "");
        if (!imported.isEmpty()) { activity.drafts.remove("backup.importedArtifact"); select(imported); inspect(); }
        refreshList();
    }
    private void invalidatePreview() { generation++; preview = null; if (previewRows != null) { previewRows.removeAllViews(); previewRows.setVisibility(View.GONE); } }
    private void select(String path) {
        invalidatePreview(); selected = path; previewButton.setEnabled(!path.isEmpty()); activity.drafts.putString("backup.selected", path);
        if (path.matches("art-[a-f0-9]{32}")) {
            latest.removeAllViews(); latest.setVisibility(View.VISIBLE); hint(latest, s(R.string.tools_imported_archive));
            LinearLayout actions = row(latest);
            textButton(actions, s(R.string.tools_save), () -> activity.saveArtifact(path, "foxytail-backup-import.tar.gz"));
            textButton(actions, s(R.string.tools_share), () -> confirm(s(R.string.tools_share), s(R.string.tools_backup_sensitive), () -> activity.shareArtifact(path, "foxytail-backup-import.tar.gz")));
        }
    }
    private void refreshList() {
        read(result -> {
            archives.removeAllViews(); JSONArray list = result.optJSONArray("backups");
            if (list == null) { hint(archives, s(R.string.web_backup_invalid_response)); select(""); return; }
            java.util.ArrayList<String> labels = new java.util.ArrayList<>(), paths = new java.util.ArrayList<>();
            labels.add(s(R.string.web_backup_select)); paths.add("");
            if (selected.matches("art-[a-f0-9]{32}")) { labels.add(s(R.string.tools_imported_archive)); paths.add(selected); }
            for (int i = 0; i < list.length(); i++) {
                JSONObject item = list.optJSONObject(i);
                if (item == null || !item.optString("path").matches("/sdcard/Download/foxytail-backup-[A-Za-z0-9._-]+\\.tar\\.gz") || item.optLong("size", -1) < 0 || item.optLong("mtime", -1) < 0) {
                    hint(archives, s(R.string.web_backup_invalid_response)); select(""); return;
                }
                labels.add(item.optString("name") + " (" + item.optLong("size") + " B)"); paths.add(item.optString("path"));
            }
            if (!paths.contains(selected)) select("");
            archivePaths = paths.toArray(new String[0]);
            archiveChoice = choice(archives, labels.toArray(new String[0]), paths.indexOf(selected), i -> select(archivePaths[i]));
            archiveChoice.setContentDescription(s(R.string.web_backup_select));
        }, failure -> { archives.removeAllViews(); hint(archives, s(R.string.tools_failed) + "\n" + failure.getMessage()); invalidatePreview(); }, "backup-list");
    }
    private void inspect() {
        invalidatePreview(); if (selected.isEmpty()) { notice(s(R.string.tools_select_archive)); return; }
        String source = selected; int ticket = generation;
        read(result -> {
            if (ticket != generation || !source.equals(selected)) return;
            if (!ToolsData.validPreview(result, source)) { notice(s(R.string.tools_invalid_response)); return; }
            preview = result; renderPreview(result);
        }, "restore-preview", source);
    }
    private void renderPreview(JSONObject result) {
        previewRows.removeAllViews(); previewRows.setVisibility(View.VISIBLE);
        label(previewRows, s(R.string.web_backup_changes));
        JSONArray changes = ToolsData.array(result, "changes");
        if (changes.length() == 0) label(previewRows, s(R.string.web_backup_unchanged));
        for (int i = 0; i < changes.length(); i++) {
            JSONObject row = changes.optJSONObject(i); if (row == null) continue;
            LinearLayout change = ControlUi.result(previewRows); label(change, row.optString("file") + " · " + row.optString("key")).setTypeface(null, android.graphics.Typeface.BOLD);
            hint(change, s(R.string.web_backup_before)); mono(change, row.isNull("before") ? "—" : row.optString("before"));
            hint(change, s(R.string.web_backup_after)); mono(change, row.isNull("after") ? "—" : row.optString("after"));
        }
        JSONArray hooks = ToolsData.array(result, "hooks");
        if (hooks.length() > 0) {
            java.util.ArrayList<String> names = new java.util.ArrayList<>(); for (int i = 0; i < hooks.length(); i++) names.add(hooks.optString(i));
            hint(previewRows, s(R.string.web_backup_hooks) + ": " + String.join(", ", names));
        }
        button(previewRows, s(R.string.web_set_restore), () -> {
            JSONObject current = preview; if (current == null || current != result || !selected.equals(current.optString("path"))) return;
            confirm(s(R.string.web_set_restore), s(R.string.web_set_restore_confirm) + "\n" + current.optString("path") + "\nSHA-256: " + current.optString("sha256") + "\n" + s(R.string.tools_baseline) + ": " + current.optString("baselineSha256"), () -> {
                if (preview != current || !selected.equals(current.optString("path"))) { notice(s(R.string.tools_preview_expired)); return; }
                invalidatePreview(); mutate(s(R.string.web_set_restore), restoredResult -> {
                    if (ToolsUi.success(this, restoredResult)) { activity.drafts.putString("backup.restored", restoredResult.toString()); renderRestore(restoredResult); refreshList(); }
                }, "restore", current.optString("path"), current.optString("sha256"), current.optString("baselineSha256"));
            });
        });
    }
    private void renderArtifact(JSONObject result) {
        latest.removeAllViews(); latest.setVisibility(View.VISIBLE); String id = result.optString("artifactId"), path = result.optString("path");
        if (!id.matches("art-[a-f0-9]{32}")) { label(latest, s(R.string.web_backup_invalid_response)); return; }
        label(latest, s(R.string.web_tools_backup_latest)).setTypeface(null, android.graphics.Typeface.BOLD); mono(latest, path); hint(latest, s(R.string.web_tools_backup_file_hint));
        textButton(latest, s(R.string.web_tools_copy_path), () -> copy(s(R.string.web_set_backup), path));
        LinearLayout actions = row(latest);
        textButton(actions, s(R.string.tools_save), () -> activity.saveArtifact(id, "foxytail-backup.tar.gz"));
        textButton(actions, s(R.string.tools_share), () -> confirm(s(R.string.tools_share), s(R.string.tools_backup_sensitive), () -> activity.shareArtifact(id, "foxytail-backup.tar.gz")));
        textButton(actions, s(R.string.tools_select), () -> { select(id); refreshList(); });
    }
    private void renderRestore(JSONObject result) {
        restored.removeAllViews(); ControlUi.setCardVisible(restored, true);
        if (!result.optBoolean("saved") || !result.optBoolean("restartRequired") || !result.optString("previous").startsWith("/")) { label(restored, s(R.string.web_backup_invalid_response)); return; }
        hint(restored, s(R.string.web_tools_restore_previous)); mono(restored, result.optString("previous"));
        if (!result.isNull("note")) mono(restored, result.optString("note"));
    }
}
