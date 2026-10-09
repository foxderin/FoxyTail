package dev.foxderin.tail;

import android.text.InputType;
import android.view.View;
import android.widget.*;
import org.json.*;
import java.text.DateFormat;
import java.util.Date;

final class LogsPage extends ControlPage {
    private String source, copied = "";
    private int limit;
    private boolean live, follow, wrap, matchCase, readingLogs, queued;
    private JSONArray lines;
    private final EditText query;
    private final TextView output, metadata;
    private final ScrollView scroll;
    private final HorizontalScrollView horizontal;
    private String updated = "";
    LogsPage(ControlActivity activity) {
        super(activity);
        source = activity.drafts.getString("logs.source", "daemon"); limit = activity.drafts.getInt("logs.limit", 200);
        live = activity.drafts.getBoolean("logs.live", true); follow = activity.drafts.getBoolean("logs.follow", true); wrap = activity.drafts.getBoolean("logs.wrap", true); matchCase = activity.drafts.getBoolean("logs.case", false);
        LinearLayout controls = section(); label(controls, s(R.string.tools_logs_scope));
        choice(controls, new String[]{s(R.string.tools_daemon_logs), s(R.string.tools_service_logs)}, source.equals("service") ? 1 : 0, index -> { source = index == 1 ? "service" : "daemon"; activity.drafts.putString("logs.source", source); lines = null; render(); load(); });
        String[] limits = {"100", "200", "500", "1000"}; int selected = 1; for (int i = 0; i < limits.length; i++) if (limits[i].equals(String.valueOf(limit))) selected = i;
        label(controls, s(R.string.tools_line_count)); choice(controls, limits, selected, index -> { limit = Integer.parseInt(limits[index]); activity.drafts.putInt("logs.limit", limit); load(); });
        query = input(controls, s(R.string.tools_search), activity.drafts.getString("logs.query", ""), InputType.TYPE_CLASS_TEXT);
        ToolsUi.draft(this, query, "logs.query"); ToolsUi.watch(query, this::render);
        toggle(controls, s(R.string.tools_live), live, value -> { live = value; activity.drafts.putBoolean("logs.live", value); if (value) load(); });
        toggle(controls, s(R.string.tools_follow), follow, value -> { follow = value; activity.drafts.putBoolean("logs.follow", value); if (value) followEnd(); });
        toggle(controls, s(R.string.tools_wrap), wrap, value -> { wrap = value; activity.drafts.putBoolean("logs.wrap", value); render(); });
        toggle(controls, s(R.string.tools_match_case), matchCase, value -> { matchCase = value; activity.drafts.putBoolean("logs.case", value); render(); });
        button(controls, s(R.string.tools_refresh), this::load); button(controls, s(R.string.tools_copy_filtered), () -> copy(s(R.string.tools_logs), copied));
        metadata = label(controls, "");
        LinearLayout viewer = section(s(R.string.tools_results)); scroll = new ScrollView(activity); horizontal = new HorizontalScrollView(activity); horizontal.setFillViewport(true); scroll.addView(horizontal);
        output = ControlUi.text(activity, "", 12); output.setTextIsSelectable(true); output.setTypeface(android.graphics.Typeface.MONOSPACE); output.setPadding(dp(8), dp(8), dp(8), dp(8)); output.setLineSpacing(dp(2), 1); horizontal.addView(output);
        viewer.addView(scroll, new LinearLayout.LayoutParams(-1, dp(440)));
        repeat(() -> { if (live && !readingLogs) load(); }, 5000);
    }
    String title() { return s(R.string.tools_logs); }
    void onPause() { readingLogs = false; queued = false; }
    void load() {
        if (readingLogs) { queued = true; return; }
        readingLogs = true;
        String requestedSource = source; int requestedLimit = limit;
        read(result -> {
            if (source.equals(requestedSource) && limit == requestedLimit) {
                JSONArray current = result.optJSONArray("lines");
                if (current == null) metadata.setText(s(R.string.tools_invalid_response));
                else {
                    boolean changed = lines == null || !lines.toString().equals(current.toString());
                    lines = current; updated = DateFormat.getTimeInstance().format(new Date()); render(changed);
                }
            }
            finishRead();
        }, failure -> { if (source.equals(requestedSource) && limit == requestedLimit) metadata.setText(s(R.string.tools_failed) + "\n" + failure.getMessage()); finishRead(); }, "logs", requestedSource, String.valueOf(requestedLimit));
    }
    private void finishRead() {
        readingLogs = false;
        if (queued) { queued = false; content.post(() -> { if (isCurrent()) load(); }); }
    }
    private void render() { render(true); }
    private void render(boolean changed) {
        if (output == null || query == null) return;
        StringBuilder text = new StringBuilder(), copy = new StringBuilder(); int count = 0; String needle = query.getText().toString();
        if (lines != null) for (int i = 0; i < lines.length(); i++) { String line = lines.optString(i); if (ToolsData.matches(line, needle, matchCase)) { if (count++ > 0) { text.append('\n'); copy.append('\n'); } text.append(i + 1).append("  ").append(ToolsData.visibleLog(line)); copy.append(line); } }
        copied = copy.toString(); output.setHorizontallyScrolling(!wrap);
        horizontal.setHorizontalScrollBarEnabled(!wrap);
        output.setMaxWidth(wrap ? Math.max(dp(200), activity.getResources().getDisplayMetrics().widthPixels - dp(64)) : Integer.MAX_VALUE);
        output.setText(text.length() == 0 ? s(lines == null ? R.string.tools_unchecked : R.string.tools_no_matches) : text.toString());
        metadata.setText(s(R.string.tools_log_count, count, lines == null ? "—" : String.valueOf(lines.length())) + "\n" + updated);
        if (follow && changed) followEnd();
    }
    private void followEnd() { if (scroll != null) scroll.post(() -> { if (isCurrent()) scroll.fullScroll(View.FOCUS_DOWN); }); }
}
