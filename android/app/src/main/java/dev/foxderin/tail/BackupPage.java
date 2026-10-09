package dev.foxderin.tail;

import android.widget.*;
import org.json.*;

final class BackupPage extends ControlPage {
    private final LinearLayout archives, previewRows, latest, restored;
    private final TextView selectedLabel;
    private String selected = "";
    private JSONObject preview;
    private int generation;
    private boolean observing;
    private final Runnable operationChanged = () -> { if (activity.client.busy()) invalidatePreview(); };
    BackupPage(ControlActivity activity) {
        super(activity);
        LinearLayout actions = section(s(R.string.tools_backup)); label(actions, s(R.string.tools_backup_scope));
        button(actions, s(R.string.tools_create_backup), () -> {
            invalidatePreview(); mutate(s(R.string.tools_create_backup), result -> {
                if (ToolsUi.success(this, result)) { activity.drafts.putString("backup.latest", result.toString()); renderArtifact(result); refreshList(); }
            }, "backup");
        });
        button(actions, s(R.string.tools_import), () -> activity.pickBackup(id -> {
            if (!isCurrent()) return;
            activity.drafts.remove("backup.importedArtifact"); select(id); inspect();
        }));
        button(actions, s(R.string.tools_refresh), this::load);
        latest = section(s(R.string.tools_artifact)); archives = section(s(R.string.tools_archives));
        LinearLayout restore = section(s(R.string.tools_restore)); label(restore, s(R.string.tools_restore_saved));
        selectedLabel = mono(restore, ""); button(restore, s(R.string.tools_preview), this::inspect);
        previewRows = section(s(R.string.tools_changes)); restored = section(s(R.string.tools_restore_result));
    }
    String title() { return s(R.string.tools_backup); }
    void onPause() {
        if (observing) { observing = false; activity.client.removeListener(operationChanged); }
        invalidatePreview();
    }
    void onClose() { onPause(); }
    void load() {
        if (!observing) { observing = true; activity.client.addListener(operationChanged); }
        invalidatePreview();
        selected = activity.drafts.getString("backup.selected", ""); selectedLabel.setText(selected);
        JSONObject lastBackup = activity.client.lastResult("backup"), lastRestore = activity.client.lastResult("restore");
        if (lastBackup != null && lastBackup.optBoolean("ok")) activity.drafts.putString("backup.latest", lastBackup.toString());
        if (lastRestore != null && lastRestore.optBoolean("ok")) activity.drafts.putString("backup.restored", lastRestore.toString());
        try {
            String artifact = activity.drafts.getString("backup.latest", ""), result = activity.drafts.getString("backup.restored", "");
            if (!artifact.isEmpty()) renderArtifact(new JSONObject(artifact)); if (!result.isEmpty()) renderRestore(new JSONObject(result));
        } catch (Exception error) { error(error); }
        if (selected.matches("art-[a-f0-9]{32}")) select(selected);
        refreshList();
        String imported = activity.drafts.getString("backup.importedArtifact", "");
        if (!imported.isEmpty()) { activity.drafts.remove("backup.importedArtifact"); select(imported); inspect(); }
    }
    private void invalidatePreview() { generation++; preview = null; if (previewRows != null) previewRows.removeAllViews(); }
    private void select(String path) {
        invalidatePreview(); selected = path; selectedLabel.setText(path); activity.drafts.putString("backup.selected", path);
        if (path.matches("art-[a-f0-9]{32}")) {
            latest.removeAllViews(); label(latest, s(R.string.tools_imported_archive));
            button(latest, s(R.string.tools_save), () -> activity.saveArtifact(path, "foxytail-backup-import.tar.gz"));
            button(latest, s(R.string.tools_share), () -> confirm(s(R.string.tools_share), s(R.string.tools_backup_sensitive), () -> activity.shareArtifact(path, "foxytail-backup-import.tar.gz")));
        }
    }
    private void refreshList() {
        read(result -> {
            archives.removeAllViews(); JSONArray list = result.optJSONArray("backups");
            if (list == null) { label(archives, s(R.string.tools_invalid_response)); return; }
            if (list.length() == 0) label(archives, s(R.string.tools_no_archives));
            boolean selectedExists = selected.isEmpty() || selected.matches("art-[a-f0-9]{32}");
            for (int i = 0; i < list.length(); i++) {
                JSONObject item = list.optJSONObject(i);
                if (item == null || !item.optString("path").matches("/sdcard/Download/foxytail-backup-[A-Za-z0-9._-]+\\.tar\\.gz") || item.optLong("size", -1) < 0 || item.optLong("mtime", -1) < 0) { label(archives, s(R.string.tools_invalid_response)); continue; }
                String path = item.optString("path"); if (path.equals(selected)) selectedExists = true;
                label(archives, item.optString("name") + " · " + Models.bytes(activity, item.optLong("size")) + "\n" + java.text.DateFormat.getDateTimeInstance().format(new java.util.Date(item.optLong("mtime") * 1000)));
                button(archives, s(R.string.tools_select), () -> select(path));
            }
            if (!selectedExists) select("");
        }, failure -> { archives.removeAllViews(); label(archives, s(R.string.tools_failed) + "\n" + failure.getMessage()); invalidatePreview(); }, "backup-list");
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
        previewRows.removeAllViews();
        mono(previewRows, "SHA-256\n" + result.optString("sha256") + "\n" + s(R.string.tools_baseline) + "\n" + result.optString("baselineSha256"));
        JSONArray changes = ToolsData.array(result, "changes");
        if (changes.length() == 0) label(previewRows, s(R.string.tools_no_changes));
        for (int i = 0; i < changes.length(); i++) {
            JSONObject row = changes.optJSONObject(i); if (row == null) continue;
            label(previewRows, row.optString("file") + " · " + row.optString("key"));
            label(previewRows, s(R.string.tools_before)); mono(previewRows, ToolsUi.text(row, "before"));
            label(previewRows, s(R.string.tools_after)); mono(previewRows, ToolsUi.text(row, "after"));
        }
        JSONArray hooks = ToolsData.array(result, "hooks");
        if (hooks.length() > 0) { label(previewRows, s(R.string.tools_hooks_warning)); for (int i = 0; i < hooks.length(); i++) mono(previewRows, hooks.optString(i)); }
        button(previewRows, s(R.string.tools_restore), () -> {
            JSONObject current = preview; if (current == null || current != result || !selected.equals(current.optString("path"))) return;
            confirm(s(R.string.tools_restore), s(R.string.tools_restore_confirm) + "\n" + current.optString("path") + "\nSHA-256: " + current.optString("sha256") + "\n" + s(R.string.tools_baseline) + ": " + current.optString("baselineSha256"), () -> {
                if (preview != current || !selected.equals(current.optString("path"))) { notice(s(R.string.tools_preview_expired)); return; }
                invalidatePreview(); mutate(s(R.string.tools_restore), restoredResult -> {
                    if (ToolsUi.success(this, restoredResult)) { activity.drafts.putString("backup.restored", restoredResult.toString()); renderRestore(restoredResult); refreshList(); }
                }, "restore", current.optString("path"), current.optString("sha256"), current.optString("baselineSha256"));
            });
        });
    }
    private void renderArtifact(JSONObject result) {
        latest.removeAllViews(); String id = result.optString("artifactId"), path = result.optString("path");
        if (!id.matches("art-[a-f0-9]{32}")) { label(latest, s(R.string.tools_invalid_response)); return; }
        mono(latest, path); label(latest, s(R.string.tools_backup_sensitive));
        button(latest, s(R.string.tools_copy_path), () -> copy(s(R.string.tools_backup), path));
        button(latest, s(R.string.tools_save), () -> activity.saveArtifact(id, "foxytail-backup.tar.gz"));
        button(latest, s(R.string.tools_share), () -> confirm(s(R.string.tools_share), s(R.string.tools_backup_sensitive), () -> activity.shareArtifact(id, "foxytail-backup.tar.gz")));
        button(latest, s(R.string.tools_select), () -> select(id));
    }
    private void renderRestore(JSONObject result) {
        restored.removeAllViews();
        if (!result.optBoolean("saved") || !result.optBoolean("restartRequired") || !result.optString("previous").startsWith("/")) { label(restored, s(R.string.tools_invalid_response)); return; }
        label(restored, s(R.string.tools_restore_saved)); label(restored, s(R.string.tools_previous)); mono(restored, result.optString("previous"));
        if (!result.isNull("note")) mono(restored, result.optString("note"));
        button(restored, s(R.string.tools_settings), () -> activity.navigate("settings"));
    }
}
