package dev.foxderin.tail;

import android.content.Context;
import android.graphics.*;
import android.view.View;
import com.google.android.material.color.MaterialColors;
import java.util.*;

final class ToolsTrafficChart extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private List<ToolsData.Sample> samples = Collections.emptyList();
    private final float density;
    private final int receivedColor, sentColor, outlineColor, labelColor;
    ToolsTrafficChart(Context context) {
        super(context);
        density = getResources().getDisplayMetrics().density;
        receivedColor = MaterialColors.getColor(this, androidx.appcompat.R.attr.colorPrimary);
        sentColor = MaterialColors.getColor(this, com.google.android.material.R.attr.colorTertiary);
        outlineColor = MaterialColors.getColor(this, com.google.android.material.R.attr.colorOutline);
        labelColor = MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant);
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
    }
    void setSamples(List<ToolsData.Sample> values) { samples = values; invalidate(); }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas); float left = 76 * density, top = 20 * density, bottom = getHeight() - 36 * density, width = getWidth() - left - 12 * density; if (width <= 0) return;
        double max = 1; for (ToolsData.Sample sample : samples) { if (sample.rx != null) max = Math.max(max, sample.rx); if (sample.tx != null) max = Math.max(max, sample.tx); }
        paint.setTextSize(10 * density); paint.setStrokeWidth(density);
        for (int i = 0; i <= 3; i++) {
            float y = top + (bottom - top) * i / 3;
            paint.setColor(outlineColor); canvas.drawLine(left, y, left + width, y, paint);
            paint.setColor(labelColor); canvas.drawText(Models.bytes(getContext(), (long) (max * (3 - i) / 3)), 0, y + 4 * density, paint);
        }
        for (int direction = 0; direction < 2; direction++) {
            paint.setColor(direction == 0 ? receivedColor : sentColor); paint.setStrokeWidth(2 * density); Float previousX = null, previousY = null;
            for (int i = 0; i < samples.size(); i++) {
                ToolsData.Sample sample = samples.get(i); Double value = direction == 0 ? sample.rx : sample.tx;
                if (value == null) { previousX = null; previousY = null; continue; }
                float x = left + width * i / Math.max(1, samples.size() - 1), y = bottom - (float) (value / max) * (bottom - top);
                if (previousX != null) canvas.drawLine(previousX, previousY, x, y, paint);
                canvas.drawCircle(x, y, 2.5f * density, paint); previousX = x; previousY = y;
            }
        }
        paint.setColor(labelColor); paint.setTextSize(10 * density);
        int step = Math.max(1, (samples.size() + 3) / 4);
        for (int i = 0; i < samples.size(); i += step) { String label = samples.get(i).label; float x = left + width * i / Math.max(1, samples.size() - 1); canvas.drawText(label, Math.min(x, getWidth() - paint.measureText(label)), bottom + 20 * density, paint); }
    }
}
