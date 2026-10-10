package dev.foxderin.tail;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.ContextThemeWrapper;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

final class TrafficChecks {
    static void run(Context context) {
        Context themed = new ContextThemeWrapper(context, R.style.AppTheme);
        ToolsTrafficChart chart = new ToolsTrafficChart(themed);
        float density = themed.getResources().getDisplayMetrics().density;
        int width = Math.round(360 * density), height = Math.round(240 * density);
        chart.layout(0, 0, width, height);
        List<ToolsData.Sample> samples = new ArrayList<>();
        for (int i = 0; i < 24; i++) samples.add(new ToolsData.Sample(String.format(Locale.ROOT, "%02d:00", i), i == 3 ? null : i * 1048576d, i == 3 ? null : i * 524288d));
        ToolsData.Sample[] selected = {null};
        chart.setOnSampleSelected(sample -> selected[0] = sample);
        chart.setSamples(samples, "01:00");
        Bitmap image = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        try { chart.draw(new Canvas(image)); } finally { image.recycle(); }
        float left = 57 * density, plotWidth = width - left - 12 * density, y = 100 * density;
        tap(chart, left + plotWidth * 2 / 23, y);
        require(selected[0] == samples.get(2), "02:00 selects exact rendered interval");
        require(ToolsTrafficChart.sampleReadout(themed, selected[0]).equals("02:00: " + themed.getString(R.string.web_traffic_rx) + " " + Models.bytes(themed, 2097152) + ", " + themed.getString(R.string.web_traffic_tx) + " " + Models.bytes(themed, 1048576)), "Localized download/upload readout uses actual sample bytes");
        tap(chart, left + plotWidth * 3 / 23, y);
        require(selected[0] == samples.get(3) && chart.getContentDescription().toString().contains(themed.getString(R.string.web_net_traffic_unrecorded)), "Gap stays selectable, never borrowed neighboring counters");
        tap(chart, left, y); require(selected[0] == samples.get(0), "Recorded zero and first slot");
        tap(chart, left + plotWidth, y); require(selected[0] == samples.get(23), "Last slot");
        touch(chart, MotionEvent.ACTION_DOWN, left + plotWidth * 2 / 23, y);
        touch(chart, MotionEvent.ACTION_MOVE, left + plotWidth * 2 / 23, y + 100 * density);
        touch(chart, MotionEvent.ACTION_UP, left + plotWidth * 2 / 23, y + 100 * density);
        require(selected[0] == samples.get(23), "Vertical page-scroll gesture does not select");
        touch(chart, MotionEvent.ACTION_DOWN, left + plotWidth * 2 / 23, y);
        touch(chart, MotionEvent.ACTION_MOVE, left + plotWidth * 8 / 23, y);
        touch(chart, MotionEvent.ACTION_UP, left + plotWidth * 8 / 23, y);
        require(selected[0] == samples.get(8), "Horizontal chart drag follows the selected interval");
        Bundle arguments = new Bundle(); arguments.putFloat(AccessibilityNodeInfo.ACTION_ARGUMENT_PROGRESS_VALUE, 2);
        require(chart.performAccessibilityAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_PROGRESS.getId(), arguments) && selected[0] == samples.get(2), "Accessibility selects exact interval");
        require(chart.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, null) && selected[0] == samples.get(3), "Accessibility traverses gap");
        require(chart.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD, null) && selected[0] == samples.get(2), "Accessibility previous interval");
        chart.setSamples(samples, "02:00"); require(selected[0] == samples.get(2), "Selection survives refresh");
        chart.setSamples(Collections.singletonList(samples.get(2)), null);
        tap(chart, left + plotWidth / 2, y); require(selected[0] == samples.get(2), "One sample centered and selectable");
        chart.setSamples(Collections.emptyList(), null); selected[0] = null;
        touch(chart, MotionEvent.ACTION_DOWN, left + plotWidth / 2, y);
        touch(chart, MotionEvent.ACTION_UP, left + plotWidth / 2, y);
        require(selected[0] == null && !chart.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, null), "No sample has no fabricated selection");
        ToolsFlowLayout flow = new ToolsFlowLayout(themed, 10, 7);
        android.view.View first = new android.view.View(themed), second = new android.view.View(themed);
        flow.addView(first, new android.view.ViewGroup.MarginLayoutParams(Math.round(70 * density), Math.round(20 * density)));
        flow.addView(second, new android.view.ViewGroup.MarginLayoutParams(Math.round(70 * density), Math.round(30 * density)));
        flow.measure(android.view.View.MeasureSpec.makeMeasureSpec(Math.round(120 * density), android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(0, android.view.View.MeasureSpec.UNSPECIFIED));
        flow.layout(0, 0, flow.getMeasuredWidth(), flow.getMeasuredHeight());
        require(second.getTop() >= first.getBottom() + Math.round(7 * density), "Flow wraps controls with the CSS line gap");
        flow.setLayoutDirection(android.view.View.LAYOUT_DIRECTION_RTL);
        flow.measure(android.view.View.MeasureSpec.makeMeasureSpec(Math.round(180 * density), android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(0, android.view.View.MeasureSpec.UNSPECIFIED));
        flow.layout(0, 0, flow.getMeasuredWidth(), flow.getMeasuredHeight());
        require(first.getLeft() > second.getLeft() && first.getRight() <= flow.getWidth(), "RTL flow preserves reading order without clipping");
    }
    private static void tap(ToolsTrafficChart chart, float x, float y) {
        touch(chart, MotionEvent.ACTION_DOWN, x, y); touch(chart, MotionEvent.ACTION_UP, x, y);
    }
    private static void touch(ToolsTrafficChart chart, int action, float x, float y) {
        long now = SystemClock.uptimeMillis(); MotionEvent event = MotionEvent.obtain(now, now, action, x, y, 0);
        try { chart.onTouchEvent(event); } finally { event.recycle(); }
    }
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
