package dev.foxderin.tail;

import android.content.Context;
import android.graphics.*;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.function.Consumer;
import com.google.android.material.color.MaterialColors;
import java.util.*;

final class ToolsTrafficChart extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path line = new Path(), area = new Path();
    private final DashPathEffect gridDash, selectionDash;
    private List<ToolsData.Sample> samples = Collections.emptyList();
    private final float density;
    private final int receivedColor, sentColor, outlineColor, labelColor;
    private final int touchSlop;
    private int selectedIndex = -1, touchIndex = -1;
    private float downX, downY;
    private boolean dragging;
    private Consumer<ToolsData.Sample> selectionListener;
    ToolsTrafficChart(Context context) {
        super(context);
        density = getResources().getDisplayMetrics().density;
        gridDash = new DashPathEffect(new float[]{3 * density, 5 * density}, 0);
        selectionDash = new DashPathEffect(new float[]{3 * density, 4 * density}, 0);
        receivedColor = MaterialColors.getColor(this, androidx.appcompat.R.attr.colorPrimary);
        sentColor = MaterialColors.getColor(this, com.google.android.material.R.attr.colorTertiary);
        outlineColor = MaterialColors.getColor(this, com.google.android.material.R.attr.colorOutline);
        labelColor = MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant);
        touchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
        setFocusable(true); setClickable(true);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
    }
    void setOnSampleSelected(Consumer<ToolsData.Sample> listener) { selectionListener = listener; }
    void setSamples(List<ToolsData.Sample> values, String selectedLabel) {
        samples = values; selectedIndex = -1; touchIndex = -1;
        int initial = samples.size() - 1;
        for (int i = samples.size() - 1; i >= 0; i--) if (samples.get(i).rx != null || samples.get(i).tx != null) { initial = i; break; }
        if (selectedLabel != null) for (int i = 0; i < samples.size(); i++) if (selectedLabel.equals(samples.get(i).label)) { initial = i; break; }
        if (initial >= 0) select(initial);
        else { setContentDescription(getContext().getString(R.string.web_net_traffic_no_samples)); invalidate(); }
    }
    static String sampleReadout(Context context, ToolsData.Sample sample) {
        return sample.label + ": " + context.getString(R.string.web_traffic_rx) + " "
                + (sample.rx == null ? context.getString(R.string.web_net_traffic_unrecorded) : Models.bytes(context, sample.rx.longValue()))
                + ", " + context.getString(R.string.web_traffic_tx) + " "
                + (sample.tx == null ? context.getString(R.string.web_net_traffic_unrecorded) : Models.bytes(context, sample.tx.longValue()));
    }
    private float plotLeft() { return 57 * density; }
    private float plotWidth() { return getWidth() - plotLeft() - 12 * density; }
    private float sampleX(int index) { return plotLeft() + plotWidth() * (samples.size() == 1 ? .5f : (float) index / (samples.size() - 1)); }
    private int sampleAt(float x) {
        if (samples.isEmpty() || plotWidth() <= 0) return -1;
        if (samples.size() == 1) return 0;
        return Math.max(0, Math.min(samples.size() - 1, Math.round((x - plotLeft()) / plotWidth() * (samples.size() - 1))));
    }
    private boolean select(int index) {
        if (index < 0 || index >= samples.size()) return false;
        boolean changed = selectedIndex != index; selectedIndex = index;
        ToolsData.Sample sample = samples.get(index);
        setContentDescription(getContext().getString(R.string.web_net_traffic_chart) + " · " + sampleReadout(getContext(), sample));
        if (selectionListener != null) selectionListener.accept(sample);
        invalidate();
        if (changed) sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_SELECTED);
        return true;
    }
    @Override public boolean onTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                if (event.getY() < 0 || event.getY() > getHeight()) return false;
                touchIndex = sampleAt(event.getX()); downX = event.getX(); downY = event.getY(); dragging = false;
                return touchIndex >= 0;
            case MotionEvent.ACTION_MOVE:
                if (touchIndex < 0) return true;
                float horizontal = Math.abs(event.getX() - downX), vertical = Math.abs(event.getY() - downY);
                if (!dragging && vertical > touchSlop && vertical > horizontal) { touchIndex = -1; return true; }
                if (dragging || horizontal > touchSlop) {
                    dragging = true; if (getParent() != null) getParent().requestDisallowInterceptTouchEvent(true);
                    touchIndex = sampleAt(event.getX()); select(touchIndex);
                }
                return true;
            case MotionEvent.ACTION_UP:
                if (touchIndex >= 0 && (dragging || (Math.abs(event.getX() - downX) <= touchSlop && Math.abs(event.getY() - downY) <= touchSlop))) { select(dragging ? sampleAt(event.getX()) : touchIndex); performClick(); }
                touchIndex = -1; dragging = false; if (getParent() != null) getParent().requestDisallowInterceptTouchEvent(false);
                return true;
            case MotionEvent.ACTION_CANCEL: touchIndex = -1; dragging = false; if (getParent() != null) getParent().requestDisallowInterceptTouchEvent(false); return true;
            default: return super.onTouchEvent(event);
        }
    }
    @Override public boolean performClick() { super.performClick(); return selectedIndex >= 0 || select(0); }
    @Override public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT) return select(selectedIndex - 1);
        if (keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) return select(selectedIndex + 1);
        if (keyCode == KeyEvent.KEYCODE_MOVE_HOME) return select(0);
        if (keyCode == KeyEvent.KEYCODE_MOVE_END) return select(samples.size() - 1);
        return super.onKeyDown(keyCode, event);
    }
    @Override public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(info);
        info.setClassName(android.widget.SeekBar.class.getName());
        if (samples.isEmpty()) { info.setClickable(false); return; }
        info.setRangeInfo(AccessibilityNodeInfo.RangeInfo.obtain(AccessibilityNodeInfo.RangeInfo.RANGE_TYPE_INT, 0, samples.size() - 1, selectedIndex));
        info.addAction(new AccessibilityNodeInfo.AccessibilityAction(AccessibilityNodeInfo.ACTION_CLICK, getContext().getString(R.string.repair_traffic_select)));
        info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_PROGRESS);
        if (selectedIndex > 0) info.addAction(new AccessibilityNodeInfo.AccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD, getContext().getString(R.string.repair_traffic_previous)));
        if (selectedIndex < samples.size() - 1) info.addAction(new AccessibilityNodeInfo.AccessibilityAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, getContext().getString(R.string.repair_traffic_next)));
    }
    @Override public boolean performAccessibilityAction(int action, Bundle arguments) {
        if (action == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD) return select(selectedIndex - 1);
        if (action == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD) return select(selectedIndex + 1);
        if (action == AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_PROGRESS.getId()) {
            if (arguments == null || !arguments.containsKey(AccessibilityNodeInfo.ACTION_ARGUMENT_PROGRESS_VALUE)) return false;
            float value = arguments.getFloat(AccessibilityNodeInfo.ACTION_ARGUMENT_PROGRESS_VALUE);
            return Float.isFinite(value) && select(Math.round(value));
        }
        return super.performAccessibilityAction(action, arguments);
    }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float left = plotLeft(), top = 12 * density, bottom = getHeight() - 28 * density, width = plotWidth();
        if (width <= 0) return;
        double max = 1;
        for (ToolsData.Sample sample : samples) { if (sample.rx != null) max = Math.max(max, sample.rx); if (sample.tx != null) max = Math.max(max, sample.tx); }
        double step = Math.pow(10, Math.floor(Math.log10(max))); max = Math.ceil(max / step) * step;
        paint.setTextSize(10 * getResources().getDisplayMetrics().scaledDensity); paint.setStrokeWidth(density);
        for (int i = 0; i <= 4; i++) {
            float y = bottom - (bottom - top) * i / 4;
            paint.setColor(outlineColor); paint.setAlpha(178); paint.setPathEffect(i == 0 ? null : gridDash);
            canvas.drawLine(left, y, left + width, y, paint); paint.setPathEffect(null); paint.setAlpha(255);
            paint.setColor(labelColor); paint.setTextAlign(Paint.Align.RIGHT);
            canvas.drawText(Models.bytes(getContext(), Math.round(max * i / 4)), left - 9 * density, y + 3 * density, paint);
        }
        paint.setStrokeJoin(Paint.Join.ROUND); paint.setStrokeCap(Paint.Cap.ROUND);
        for (int direction = 0; direction < 2; direction++) {
            int color = direction == 0 ? receivedColor : sentColor;
            int start = -1;
            for (int i = 0; i <= samples.size(); i++) {
                Double value = i == samples.size() ? null : direction == 0 ? samples.get(i).rx : samples.get(i).tx;
                if (value != null) {
                    float x = sampleX(i), y = bottom - (float) (value / max) * (bottom - top);
                    if (start < 0) { start = i; line.reset(); line.moveTo(x, y); } else line.lineTo(x, y);
                } else if (start >= 0) {
                    area.set(line); area.lineTo(sampleX(i - 1), bottom); area.lineTo(sampleX(start), bottom); area.close();
                    paint.setColor(color); paint.setStyle(Paint.Style.FILL); paint.setAlpha(18); canvas.drawPath(area, paint);
                    paint.setAlpha(255); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(2.5f * density); canvas.drawPath(line, paint); paint.setStyle(Paint.Style.FILL);
                    if (i - start == 1) {
                        Double single = direction == 0 ? samples.get(start).rx : samples.get(start).tx;
                        canvas.drawCircle(sampleX(start), bottom - (float) (single / max) * (bottom - top), 3 * density, paint);
                    }
                    start = -1;
                }
            }
        }
        if (selectedIndex >= 0) {
            paint.setColor(outlineColor); paint.setStrokeWidth(density); paint.setPathEffect(selectionDash);
            canvas.drawLine(sampleX(selectedIndex), top, sampleX(selectedIndex), bottom, paint); paint.setPathEffect(null);
            for (int direction = 0; direction < 2; direction++) {
                Double value = direction == 0 ? samples.get(selectedIndex).rx : samples.get(selectedIndex).tx; if (value == null) continue;
                float y = bottom - (float) (value / max) * (bottom - top);
                paint.setColor(direction == 0 ? receivedColor : sentColor); canvas.drawCircle(sampleX(selectedIndex), y, 4 * density, paint);
                paint.setColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorSurface)); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(2 * density);
                canvas.drawCircle(sampleX(selectedIndex), y, 4 * density, paint); paint.setStyle(Paint.Style.FILL);
            }
        }
        paint.setColor(labelColor);
        int count = Math.min(samples.size(), Math.max(2, (int) (width / (68 * density))));
        for (int tick = 0; tick < count; tick++) {
            int index = count == 1 ? 0 : Math.round((float) tick * (samples.size() - 1) / (count - 1));
            paint.setTextAlign(index == 0 ? Paint.Align.LEFT : index == samples.size() - 1 ? Paint.Align.RIGHT : Paint.Align.CENTER);
            canvas.drawText(samples.get(index).label, sampleX(index), getHeight() - 7 * density, paint);
        }
        paint.setTextAlign(Paint.Align.LEFT);
    }
}
