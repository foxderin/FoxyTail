package dev.foxderin.tail;

import android.widget.*;
import com.google.android.material.color.MaterialColors;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import org.json.*;
import java.util.*;

final class TrafficPage extends ControlPage {
    private JSONObject summary;
    private boolean daily;
    private final LinearLayout chartRows, peerRows, uidRows;
    private final Map<String, String> peerNames = new HashMap<>(), appNames = new HashMap<>();
    TrafficPage(ControlActivity activity) {
        super(activity); daily = activity.drafts.getBoolean("traffic.daily", false);
        LinearLayout controls = section(s(R.string.tools_traffic));
        choice(controls, new String[]{s(R.string.tools_hourly), s(R.string.tools_daily)}, daily ? 1 : 0, index -> { daily = index == 1; activity.drafts.putBoolean("traffic.daily", daily); renderChart(); });
        button(controls, s(R.string.tools_refresh), this::load);
        chartRows = section(s(R.string.tools_traffic_chart)); peerRows = section(s(R.string.tools_peer_ranking)); uidRows = section(s(R.string.tools_uid_ranking));
        label(controls, s(R.string.tools_traffic_scope));
    }
    String title() { return s(R.string.tools_traffic); }
    void load() {
        read(result -> {
            for (String key : new String[]{"hours", "days", "topn", "uids"}) if (result.optJSONArray(key) == null) { notice(s(R.string.tools_invalid_response)); return; }
            summary = result; peerNames.clear(); appNames.clear(); renderChart(); renderRanks();
            if (ToolsData.array(result, "topn").length() > 0) read(peers -> { JSONArray values = ToolsData.array(peers, "peers"); for (int i = 0; i < values.length(); i++) { JSONObject row = values.optJSONObject(i); if (row != null) peerNames.put(row.optString("id"), row.optString("hostname")); } renderRanks(); }, "peers");
            if (ToolsData.array(result, "uids").length() > 0) read(apps -> { JSONArray values = ToolsData.array(apps, "apps"); for (int i = 0; i < values.length(); i++) { JSONObject row = values.optJSONObject(i); if (row != null) { String uid = row.optString("uid"), label = row.optString("label"); appNames.merge(uid, label, (a, b) -> a.equals(b) ? a : a + ", " + b); } } renderRanks(); }, "apps");
        }, failure -> { summary = null; chartRows.removeAllViews(); peerRows.removeAllViews(); uidRows.removeAllViews(); label(chartRows, s(R.string.tools_failed) + "\n" + failure.getMessage()); }, "traffic", "summary");
    }
    private void renderChart() {
        if (chartRows == null || summary == null) return;
        chartRows.removeAllViews(); label(chartRows, s(daily ? R.string.tools_daily : R.string.tools_hourly));
        try {
            List<ToolsData.Sample> samples = ToolsData.samples(summary, daily); double rx = 0, tx = 0; boolean known = false;
            for (ToolsData.Sample sample : samples) { if (sample.rx != null) { rx += sample.rx; known = true; } if (sample.tx != null) { tx += sample.tx; known = true; } }
            label(chartRows, s(R.string.tools_total) + ": " + (known ? Models.bytes(activity, (long) (rx + tx)) : "—") + "\n" + s(R.string.tools_rx) + ": " + (known ? Models.bytes(activity, (long) rx) : "—") + " · " + s(R.string.tools_tx) + ": " + (known ? Models.bytes(activity, (long) tx) : "—"));
            label(chartRows, s(R.string.tools_rx)).setTextColor(MaterialColors.getColor(chartRows, androidx.appcompat.R.attr.colorPrimary));
            label(chartRows, s(R.string.tools_tx)).setTextColor(MaterialColors.getColor(chartRows, com.google.android.material.R.attr.colorTertiary));
            label(chartRows, s(R.string.tools_chart_legend)); ToolsTrafficChart chart = new ToolsTrafficChart(activity); chart.setSamples(samples); chartRows.addView(chart, new LinearLayout.LayoutParams(-1, dp(240)));
            label(chartRows, s(R.string.tools_chart_missing));
            for (ToolsData.Sample sample : samples) label(chartRows, sample.label + " · " + s(R.string.tools_rx) + " " + (sample.rx == null ? s(R.string.tools_no_sample) : Models.bytes(activity, sample.rx.longValue())) + " · " + s(R.string.tools_tx) + " " + (sample.tx == null ? s(R.string.tools_no_sample) : Models.bytes(activity, sample.tx.longValue())));
        } catch (Exception error) { error(error); }
    }
    private void renderRanks() {
        if (summary == null) return;
        peerRows.removeAllViews(); uidRows.removeAllViews(); label(peerRows, s(R.string.tools_peer_ranking)); label(uidRows, s(R.string.tools_uid_ranking));
        rank(peerRows, "topn", "id", peerNames, 10, true); rank(uidRows, "uids", "uid", appNames, 50, false);
    }
    private void rank(LinearLayout parent, String key, String idKey, Map<String, String> names, int maxRows, boolean received) {
        List<JSONObject> rows = new ArrayList<>(); JSONArray source = ToolsData.array(summary, key);
        for (int i = 0; i < source.length(); i++) { JSONObject row = source.optJSONObject(i); if (row != null && total(row, received) > 0) rows.add(row); }
        rows.sort((a, b) -> Double.compare(total(b, received), total(a, received)));
        double max = rows.isEmpty() ? 1 : total(rows.get(0), received);
        if (rows.isEmpty()) label(parent, s(R.string.tools_no_counters));
        for (int i = 0; i < Math.min(maxRows, rows.size()); i++) {
            JSONObject row = rows.get(i); String id = row.optString(idKey); label(parent, (i + 1) + ". " + names.getOrDefault(id, idKey.equals("uid") ? "UID " + id : id) + " · " + id);
            label(parent, (received ? s(R.string.tools_rx) + " " + Models.bytes(activity, (long) ToolsData.bytes(row, "rx")) + " · " : "") + s(R.string.tools_tx) + " " + Models.bytes(activity, (long) ToolsData.bytes(row, "tx")));
            LinearProgressIndicator bar = new LinearProgressIndicator(activity); bar.setMax(1000); bar.setProgress((int) (total(row, received) / max * 1000)); bar.setImportantForAccessibility(android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO); parent.addView(bar);
        }
    }
    private static double total(JSONObject row, boolean received) { return ToolsData.bytes(row, "tx") + (received ? ToolsData.bytes(row, "rx") : 0); }
}
