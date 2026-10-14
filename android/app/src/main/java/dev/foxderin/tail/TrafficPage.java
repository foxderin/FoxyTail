package dev.foxderin.tail;

import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.*;
import com.google.android.material.color.MaterialColors;
import org.json.*;
import java.util.*;

final class TrafficPage extends ControlPage {
    private JSONObject summary;
    private boolean daily, tableExpanded;
    private String selectedHour, selectedDay;
    private int revision;
    private final LinearLayout chartRows, peerRows, uidRows;
    private final TextView totalMetric, downloadMetric, uploadMetric;
    private final View refresh;
    private ImageButton tableToggle;
    private final Map<String, String> peerNames = new HashMap<>(), appNames = new HashMap<>();
    TrafficPage(ControlActivity activity) {
        super(activity); daily = activity.drafts.getBoolean("traffic.daily", false);
        LinearLayout controls = row(content); controls.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout periods = new LinearLayout(activity);
        controls.addView(periods, new LinearLayout.LayoutParams(0, -2, 1));
        periods.setContentDescription(s(R.string.web_net_traffic_period));
        ControlUi.chips(periods, new String[]{s(R.string.web_traffic_hourly), s(R.string.web_traffic_daily)}, daily ? 1 : 0, index -> {
            if (!isCurrent()) return;
            daily = index == 1; activity.drafts.putBoolean("traffic.daily", daily); renderChart();
        });
        refresh = ControlUi.iconButton(activity, R.drawable.ic_refresh, s(R.string.web_tools_refresh), () -> { if (isCurrent()) load(); });
        controls.addView(refresh, new LinearLayout.LayoutParams(dp(44), dp(44)));
        boolean narrow = activity.getResources().getConfiguration().screenWidthDp <= 480;
        LinearLayout metrics = row(content);
        totalMetric = trafficMetric(metrics, s(R.string.web_net_traffic_total), null, narrow);
        LinearLayout directions = narrow ? row(content) : metrics;
        downloadMetric = trafficMetric(directions, s(R.string.web_traffic_rx), "↓", false);
        uploadMetric = trafficMetric(directions, s(R.string.web_traffic_tx), "↑", false);
        chartRows = section(s(R.string.web_net_traffic_chart), R.drawable.ic_monitoring, null);
        LinearLayout breakdown = new LinearLayout(activity);
        boolean wide = activity.getResources().getConfiguration().screenWidthDp > 700;
        breakdown.setOrientation(wide ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        content.addView(breakdown, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout peers = new LinearLayout(activity), apps = new LinearLayout(activity);
        peers.setOrientation(LinearLayout.VERTICAL); apps.setOrientation(LinearLayout.VERTICAL);
        breakdown.addView(peers, new LinearLayout.LayoutParams(wide ? 0 : -1, -2, wide ? 1 : 0));
        LinearLayout.LayoutParams appParams = new LinearLayout.LayoutParams(wide ? 0 : -1, -2, wide ? 1 : 0);
        if (wide) appParams.setMarginStart(dp(16)); breakdown.addView(apps, appParams);
        peerRows = ControlUi.card(peers, s(R.string.web_traffic_topn), R.drawable.ic_group, null);
        uidRows = ControlUi.card(apps, s(R.string.web_traffic_by_app), R.drawable.ic_router, null);
        hint(uidRows, s(R.string.web_traffic_app_tx_hint));
    }
    String title() { return s(R.string.web_traffic_title); }
    void load() {
        final int request = ++revision; refresh.setEnabled(false);
        read(result -> {
            if (request != revision) return;
            refresh.setEnabled(true);
            for (String key : new String[]{"hours", "days", "topn", "uids"}) if (result.optJSONArray(key) == null) { showFailure(s(R.string.tools_invalid_response)); return; }
            summary = result; peerNames.clear(); appNames.clear(); renderChart(); renderRanks();
            if (hasCounters("topn", true)) read(peers -> {
                if (request != revision) return;
                JSONArray values = ToolsData.array(peers, "peers");
                for (int i = 0; i < values.length(); i++) { JSONObject row = values.optJSONObject(i); if (row != null) peerNames.put(row.optString("id"), row.optString("hostname")); }
                renderRanks();
            }, ignored -> { }, "peers");
            if (hasCounters("uids", false)) read(apps -> {
                if (request != revision) return;
                JSONArray values = ToolsData.array(apps, "apps");
                for (int i = 0; i < values.length(); i++) { JSONObject row = values.optJSONObject(i); if (row != null) appNames.put(row.optString("uid"), row.optString("label")); }
                renderRanks();
            }, ignored -> { }, "apps");
        }, failure -> { if (request == revision) { refresh.setEnabled(true); showFailure(failure.getMessage()); } }, "traffic", "summary");
    }
    private boolean hasCounters(String key, boolean received) {
        JSONArray rows = ToolsData.array(summary, key);
        for (int i = 0; i < rows.length(); i++) { JSONObject row = rows.optJSONObject(i); if (row != null && total(row, received) > 0) return true; }
        return false;
    }
    private void showFailure(String message) {
        summary = null; totalMetric.setText("—"); downloadMetric.setText("—"); uploadMetric.setText("—");
        for (LinearLayout box : new LinearLayout[]{chartRows, peerRows, uidRows}) {
            box.removeAllViews(); hint(box, message); iconButton(box, R.drawable.ic_refresh, s(R.string.web_tools_refresh), this::load);
        }
    }
    private void renderChart() {
        if (summary == null) return;
        try {
            List<ToolsData.Sample> samples = ToolsData.samples(summary, daily);
            if (daily) for (int i = 0; i < samples.size(); i++) { ToolsData.Sample sample = samples.get(i); samples.set(i, new ToolsData.Sample(sample.label.length() >= 5 ? sample.label.substring(5) : sample.label, sample.rx, sample.tx)); }
            double rx = 0, tx = 0; boolean known = false;
            for (ToolsData.Sample sample : samples) { if (sample.rx != null) { rx += sample.rx; known = true; } if (sample.tx != null) { tx += sample.tx; known = true; } }
            totalMetric.setText(known ? bytes(rx + tx) : "—"); downloadMetric.setText(known ? bytes(rx) : "—"); uploadMetric.setText(known ? bytes(tx) : "—");
            if (!known) { empty(chartRows, s(R.string.web_net_traffic_no_samples), R.drawable.ic_monitoring, 255); return; }
            ToolsFlowLayout legend = new ToolsFlowLayout(activity, 18, 8); legend.setPadding(0, dp(5), 0, dp(15)); chartRows.addView(legend, new LinearLayout.LayoutParams(-1, -2));
            seriesLabel(legend, s(R.string.web_traffic_rx), false, 12); seriesLabel(legend, s(R.string.web_traffic_tx), true, 12);
            TextView touch = text(s(R.string.web_traffic_touch_hint), 11, false); touch.setGravity(Gravity.END);
            legend.addView(touch);
            ToolsTrafficChart chart = new ToolsTrafficChart(activity); chartRows.addView(chart, new LinearLayout.LayoutParams(-1, dp(232)));
            ToolsFlowLayout readout = new ToolsFlowLayout(activity, 16, 10); readout.setPadding(dp(12), dp(12), dp(12), dp(12));
            readout.setMinimumHeight(dp(45)); readout.setBackground(background(com.google.android.material.R.attr.colorSurfaceContainerLow, 10, false));
            LinearLayout.LayoutParams readoutParams = new LinearLayout.LayoutParams(-1, -2); readoutParams.topMargin = dp(8); chartRows.addView(readout, readoutParams);
            TextView time = text("", 11, true); readout.addView(time);
            LinearLayout received = seriesLabel(readout, s(R.string.web_traffic_rx), false, 11), sent = seriesLabel(readout, s(R.string.web_traffic_tx), true, 11);
            TextView receivedValue = text("", 11, true), sentValue = text("", 11, true);
            received.addView(receivedValue); sent.addView(sentValue);
            chart.setOnSampleSelected(sample -> {
                time.setText(sample.label); receivedValue.setText(sample.rx == null ? "—" : bytes(sample.rx)); sentValue.setText(sample.tx == null ? "—" : bytes(sample.tx));
                if (daily) selectedDay = sample.label; else selectedHour = sample.label;
            });
            chart.setSamples(samples, daily ? selectedDay : selectedHour);
            LinearLayout table = new LinearLayout(activity); table.setOrientation(LinearLayout.VERTICAL);
            HorizontalScrollView tableScroll = new HorizontalScrollView(activity); tableScroll.setFillViewport(true); tableScroll.addView(table, new HorizontalScrollView.LayoutParams(-1, -2));
            table.setMinimumWidth((int) (dp(270) * Math.max(1, activity.getResources().getConfiguration().fontScale)));
            tableToggle = ControlUi.iconButton(activity, R.drawable.ic_article, s(R.string.web_net_traffic_table), () -> {
                if (isCurrent()) { tableExpanded = !tableExpanded; tableScroll.setVisibility(tableExpanded ? View.VISIBLE : View.GONE); tableToggle.setSelected(tableExpanded); }
            }); chartRows.addView(tableToggle); tableToggle.setSelected(tableExpanded);
            chartRows.addView(tableScroll, new LinearLayout.LayoutParams(-1, -2)); tableScroll.setVisibility(tableExpanded ? View.VISIBLE : View.GONE);
            tableRow(table, s(R.string.web_net_traffic_time), s(R.string.web_traffic_rx), s(R.string.web_traffic_tx), true);
            for (ToolsData.Sample sample : samples) tableRow(table, sample.label, sample.rx == null ? "—" : bytes(sample.rx), sample.tx == null ? "—" : bytes(sample.tx), false);
        } catch (Exception failure) { hint(chartRows, s(R.string.tools_invalid_response)); error(failure); }
    }
    private TextView trafficMetric(LinearLayout parent, String caption, String direction, boolean compact) {
        LinearLayout box = new LinearLayout(activity); box.setOrientation(compact ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL); box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(dp(12), dp(15), dp(12), dp(15)); box.setBackground(background(com.google.android.material.R.attr.colorSurface, 16, true));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1); params.topMargin = dp(9); params.bottomMargin = dp(9); if (parent.getChildCount() > 0) params.setMarginStart(dp(9)); parent.addView(box, params);
        LinearLayout head = new LinearLayout(activity); head.setGravity(Gravity.CENTER_VERTICAL); head.setMinimumHeight(dp(32));
        if (direction == null) { ImageView icon = new ImageView(activity); icon.setImageResource(R.drawable.ic_monitoring); icon.setColorFilter(color(com.google.android.material.R.attr.colorOnSurfaceVariant)); head.addView(icon, new LinearLayout.LayoutParams(dp(18), dp(18))); }
        else { TextView icon = text(direction, 13, true); icon.setGravity(Gravity.CENTER); icon.setTextColor(color(direction.equals("↑") ? com.google.android.material.R.attr.colorTertiary : androidx.appcompat.R.attr.colorPrimary)); icon.setBackground(background(direction.equals("↑") ? com.google.android.material.R.attr.colorTertiaryContainer : com.google.android.material.R.attr.colorPrimaryContainer, 5, false)); head.addView(icon, new LinearLayout.LayoutParams(dp(19), dp(19))); }
        TextView label = text(caption, 10, false); LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(0, -2, 1); labelParams.setMarginStart(dp(5)); head.addView(label, labelParams);
        box.addView(head, new LinearLayout.LayoutParams(compact ? 0 : -1, -2, compact ? 1 : 0));
        TextView value = text("—", activity.getResources().getConfiguration().screenWidthDp <= 480 ? 24 : 20, true);
        LinearLayout.LayoutParams valueParams = new LinearLayout.LayoutParams(compact ? -2 : -1, -2); if (!compact) valueParams.topMargin = dp(14); box.addView(value, valueParams); return value;
    }
    private void tableRow(LinearLayout table, String time, String rx, String tx, boolean heading) {
        LinearLayout row = row(table);
        String[] values = {time, rx, tx};
        for (int i = 0; i < values.length; i++) { TextView cell = text(values[i], 11, heading); cell.setSingleLine(true); cell.setPadding(dp(10), dp(10), dp(10), dp(10)); cell.setGravity(i == 0 ? Gravity.START : Gravity.END); row.addView(cell, new LinearLayout.LayoutParams(0, -2, 1)); }
        ControlUi.divider(table);
    }
    private void renderRanks() {
        if (summary == null) return;
        peerRows.removeAllViews(); uidRows.removeAllViews();
        hint(uidRows, s(R.string.web_traffic_app_tx_hint));
        List<JSONObject> peers = new ArrayList<>(); JSONArray source = ToolsData.array(summary, "topn");
        for (int i = 0; i < source.length(); i++) { JSONObject entry = source.optJSONObject(i); if (entry != null && total(entry, true) > 0) peers.add(entry); }
        peers.sort((a, b) -> Double.compare(total(b, true), total(a, true)));
        double max = peers.isEmpty() ? 1 : total(peers.get(0), true);
        if (peers.isEmpty()) empty(peerRows, s(R.string.web_net_traffic_no_peer), R.drawable.ic_group, 0);
        for (int i = 0; i < Math.min(10, peers.size()); i++) {
            JSONObject entry = peers.get(i); String id = entry.optString("id");
            LinearLayout rank = row(peerRows); rank.setPadding(0, dp(i == 0 ? 4 : 22), 0, 0);
            TextView number = text(String.format(Locale.ROOT, "%02d", i + 1), 11, true); number.setTextColor(color(com.google.android.material.R.attr.colorOnSurfaceVariant));
            LinearLayout.LayoutParams numberParams = new LinearLayout.LayoutParams(-2, -2); numberParams.setMarginEnd(dp(12)); rank.addView(number, numberParams);
            LinearLayout detail = new LinearLayout(activity); detail.setOrientation(LinearLayout.VERTICAL); rank.addView(detail, new LinearLayout.LayoutParams(0, -2, 1));
            LinearLayout heading = row(detail); TextView name = text(peerNames.getOrDefault(id, id), 12, true); name.setSingleLine(true); name.setEllipsize(android.text.TextUtils.TruncateAt.END); heading.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
            TextView sum = text(bytes(total(entry, true)), 11, false); sum.setPadding(dp(12), 0, 0, 0); heading.addView(sum);
            LinearLayout track = row(detail); track.setBackground(background(com.google.android.material.R.attr.colorSurfaceContainerHigh, 4, false)); track.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            LinearLayout.LayoutParams trackParams = new LinearLayout.LayoutParams(-1, dp(5)); trackParams.topMargin = dp(9); trackParams.bottomMargin = dp(9); track.setLayoutParams(trackParams); track.setWeightSum((float) max);
            addFill(track, ToolsData.bytes(entry, "rx"), androidx.appcompat.R.attr.colorPrimary); addFill(track, ToolsData.bytes(entry, "tx"), com.google.android.material.R.attr.colorTertiary);
            TextView counters = text("↓ " + bytes(ToolsData.bytes(entry, "rx")) + "    ↑ " + bytes(ToolsData.bytes(entry, "tx")), 10, false); detail.addView(counters);
        }
        source = ToolsData.array(summary, "uids"); int shown = 0;
        for (int i = 0; i < source.length() && shown < 50; i++) {
            JSONObject entry = source.optJSONObject(i); if (entry == null || total(entry, false) <= 0) continue;
            if (shown++ > 0) ControlUi.divider(uidRows);
            String uid = entry.optString("uid"), fallback = s(R.string.web_traffic_uid) + uid;
            LinearLayout app = row(uidRows); app.setGravity(Gravity.CENTER_VERTICAL); app.setPadding(0, dp(13), 0, dp(13));
            ImageView icon = new ImageView(activity); icon.setImageResource(R.drawable.ic_router); icon.setColorFilter(color(androidx.appcompat.R.attr.colorPrimary)); icon.setPadding(dp(8), dp(8), dp(8), dp(8)); icon.setBackground(background(com.google.android.material.R.attr.colorSurfaceContainerLow, 10, false)); app.addView(icon, new LinearLayout.LayoutParams(dp(34), dp(34)));
            LinearLayout description = new LinearLayout(activity); description.setOrientation(LinearLayout.VERTICAL); LinearLayout.LayoutParams descriptionParams = new LinearLayout.LayoutParams(0, -2, 1); descriptionParams.setMarginStart(dp(10)); descriptionParams.setMarginEnd(dp(10)); app.addView(description, descriptionParams);
            description.addView(text(appNames.getOrDefault(uid, fallback), 12, true)); TextView uidText = text(fallback, 10, false); uidText.setPadding(0, dp(5), 0, 0); description.addView(uidText);
            app.addView(text("↑ " + bytes(ToolsData.bytes(entry, "tx")), 11, false));
        }
        if (shown == 0) empty(uidRows, s(R.string.web_net_traffic_no_app), R.drawable.ic_router, 0);
    }
    private void addFill(LinearLayout track, double value, int attr) {
        if (value <= 0) return;
        View fill = new View(activity); fill.setBackgroundColor(color(attr)); track.addView(fill, new LinearLayout.LayoutParams(0, -1, (float) value));
    }
    private LinearLayout seriesLabel(ToolsFlowLayout parent, String title, boolean sent, int size) {
        LinearLayout row = new LinearLayout(activity); row.setGravity(Gravity.CENTER_VERTICAL);
        parent.addView(row);
        View dot = new View(activity); dot.setBackground(background(sent ? com.google.android.material.R.attr.colorTertiary : androidx.appcompat.R.attr.colorPrimary, 4, false));
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(dp(7), dp(7)); dotParams.setMarginEnd(dp(7)); row.addView(dot, dotParams);
        TextView label = text(title, size, false); label.setPadding(0, 0, dp(7), 0); row.addView(label); return row;
    }
    private void empty(LinearLayout parent, String message, int iconId, int height) {
        LinearLayout box = new LinearLayout(activity); box.setOrientation(LinearLayout.VERTICAL); box.setGravity(Gravity.CENTER); box.setMinimumHeight(dp(height)); box.setPadding(0, dp(24), 0, dp(24));
        ImageView icon = new ImageView(activity); icon.setImageResource(iconId); icon.setColorFilter(color(androidx.appcompat.R.attr.colorPrimary)); box.addView(icon, new LinearLayout.LayoutParams(dp(34), dp(34)));
        TextView label = text(message, 13, false); label.setGravity(Gravity.CENTER); label.setPadding(0, dp(12), 0, 0); box.addView(label); parent.addView(box, new LinearLayout.LayoutParams(-1, -2));
    }
    private TextView text(String value, int size, boolean bold) { TextView text = ControlUi.text(activity, value, size); if (bold) text.setTypeface(null, Typeface.BOLD); else text.setTextColor(color(com.google.android.material.R.attr.colorOnSurfaceVariant)); return text; }
    private int color(int attr) { return MaterialColors.getColor(content, attr); }
    private GradientDrawable background(int attr, int radius, boolean border) { GradientDrawable drawable = new GradientDrawable(); drawable.setColor(color(attr)); drawable.setCornerRadius(dp(radius)); if (border) drawable.setStroke(dp(1), color(com.google.android.material.R.attr.colorOutlineVariant)); return drawable; }
    private String bytes(double value) { return Models.bytes(activity, (long) value); }
    private static double total(JSONObject row, boolean received) { return ToolsData.bytes(row, "tx") + (received ? ToolsData.bytes(row, "rx") : 0); }
}
