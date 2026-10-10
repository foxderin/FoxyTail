package dev.foxderin.tail;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.CompoundButton;
import com.google.android.material.color.MaterialColors;

/** Original 44×26 track inside an accessible 52×48 target. */
final class WebSwitch extends CompoundButton {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF track = new RectF();
    private final int primary, onPrimary, outline, surface;
    private boolean indeterminate;
    WebSwitch(Context context) {
        super(context);
        setButtonDrawable((android.graphics.drawable.Drawable) null); setBackground(null);
        setClickable(true); setFocusable(true);
        setMinHeight(ControlUi.dp(context, 48)); setMinWidth(ControlUi.dp(context, 52));
        setTextSize(13); setGravity(android.view.Gravity.CENTER_VERTICAL);
        primary = MaterialColors.getColor(this, androidx.appcompat.R.attr.colorPrimary);
        onPrimary = MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnPrimary);
        outline = MaterialColors.getColor(this, com.google.android.material.R.attr.colorOutline);
        surface = MaterialColors.getColor(this, com.google.android.material.R.attr.colorSurfaceContainerHighest);
        setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface));
    }
    void setIndeterminate(boolean value) { indeterminate = value; invalidate(); }
    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        boolean labeled = length() > 0;
        int space = labeled ? ControlUi.dp(getContext(), 60) : 0;
        if (getPaddingEnd() != space) setPaddingRelative(0, 0, space, 0);
        super.onMeasure(widthSpec, heightSpec);
    }
    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float density = getResources().getDisplayMetrics().density;
        float left = getLayoutDirection() == LAYOUT_DIRECTION_RTL ? 4 * density : getWidth() - 48 * density;
        float top = (getHeight() - 26 * density) / 2;
        track.set(left, top, left + 44 * density, top + 26 * density);
        boolean on = isChecked() && !indeterminate;
        paint.setStyle(Paint.Style.FILL); paint.setColor(on ? primary : surface); paint.setAlpha(isEnabled() ? 255 : 115);
        canvas.drawRoundRect(track, 13 * density, 13 * density, paint);
        paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(density); paint.setColor(on ? primary : outline); paint.setAlpha(isEnabled() ? 255 : 115);
        canvas.drawRoundRect(track, 13 * density, 13 * density, paint);
        paint.setStyle(Paint.Style.FILL); paint.setColor(on ? onPrimary : outline); paint.setAlpha(isEnabled() ? 255 : 115);
        float shift = indeterminate ? 9 : on ? 18 : 0;
        if (getLayoutDirection() == LAYOUT_DIRECTION_RTL) shift = 18 - shift;
        canvas.drawCircle(left + (12 + shift) * density, top + 13 * density, 9 * density, paint);
    }
    @Override public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(info); info.setClassName("android.widget.Switch"); info.setCheckable(true); info.setChecked(isChecked());
    }
}
