package dev.foxderin.tail;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.view.View;
import android.widget.*;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.widget.TextViewCompat;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.card.MaterialCardView;
import com.google.android.material.color.MaterialColors;
import com.google.android.material.textfield.TextInputLayout;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textview.MaterialTextView;
import java.util.Locale;

final class ControlUi {
    private ControlUi() { }
    static int dp(Context context, int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
    static Context localized(Context base) {
        String language = base.getSharedPreferences("interface", Context.MODE_PRIVATE).getString("language", "auto");
        if ("auto".equals(language)) return base;
        Configuration config = new Configuration(base.getResources().getConfiguration()); config.setLocale(Locale.forLanguageTag(language));
        return base.createConfigurationContext(config);
    }
    static void appearance(AppCompatActivity activity) {
        String theme = activity.getSharedPreferences("interface", Context.MODE_PRIVATE).getString("theme", "auto");
        activity.getDelegate().setLocalNightMode("dark".equals(theme) ? AppCompatDelegate.MODE_NIGHT_YES : "light".equals(theme) ? AppCompatDelegate.MODE_NIGHT_NO : AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM);
    }
    static MaterialButton button(Context context, String text, Runnable action) {
        return button(context, text, 0, action);
    }
    static MaterialButton button(Context context, String text, int icon, Runnable action) {
        MaterialButton button = new MaterialButton(context, null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
        configure(button, text, icon, action);
        return button;
    }
    static MaterialButton primaryButton(Context context, String text, Runnable action) {
        return primaryButton(context, text, 0, action);
    }
    static MaterialButton primaryButton(Context context, String text, int icon, Runnable action) {
        MaterialButton button = new MaterialButton(context);
        configure(button, text, icon, action);
        return button;
    }
    static MaterialButton tonalButton(Context context, String text, Runnable action) {
        return tonalButton(context, text, 0, action);
    }
    static MaterialButton tonalButton(Context context, String text, int icon, Runnable action) {
        MaterialButton button = new MaterialButton(context, null, com.google.android.material.R.attr.materialButtonTonalStyle);
        configure(button, text, icon, action);
        return button;
    }
    private static void configure(MaterialButton button, String text, int icon, Runnable action) {
        button.setText(text); button.setAllCaps(false); button.setMinHeight(dp(button.getContext(), 48));
        button.setMaxLines(3); button.setOnClickListener(v -> action.run());
        if (icon != 0) { button.setIconResource(icon); button.setIconGravity(MaterialButton.ICON_GRAVITY_TEXT_START); }
    }
    static TextView muted(Context context, String value, int size) {
        TextView view = text(context, value, size);
        view.setTextColor(MaterialColors.getColor(view, com.google.android.material.R.attr.colorOnSurfaceVariant));
        return view;
    }
    /** Status chip from the WebUI: tinted soft background, 7px radius, compact type. */
    static final int BADGE_NEUTRAL = 0, BADGE_OK = 1, BADGE_ERROR = 2;
    static TextView badge(Context context, String value, int tone) {
        TextView view = new MaterialTextView(context);
        view.setText(value); view.setTextSize(12); view.setTypeface(null, android.graphics.Typeface.BOLD);
        android.graphics.drawable.GradientDrawable shape = new android.graphics.drawable.GradientDrawable();
        shape.setCornerRadius(dp(context, 7));
        if (tone == BADGE_OK) {
            shape.setColor(androidx.core.content.ContextCompat.getColor(context, R.color.foxy_ok_soft));
            view.setTextColor(androidx.core.content.ContextCompat.getColor(context, R.color.foxy_ok));
        } else if (tone == BADGE_ERROR) {
            shape.setColor(MaterialColors.getColor(view, com.google.android.material.R.attr.colorErrorContainer));
            view.setTextColor(MaterialColors.getColor(view, com.google.android.material.R.attr.colorOnErrorContainer));
        } else {
            shape.setColor(MaterialColors.getColor(view, com.google.android.material.R.attr.colorSurfaceContainer));
            view.setTextColor(MaterialColors.getColor(view, com.google.android.material.R.attr.colorOnSurfaceVariant));
        }
        view.setBackground(shape);
        view.setPadding(dp(context, 9), dp(context, 4), dp(context, 9), dp(context, 4));
        return view;
    }
    static TextView text(Context context, String value, int size) {
        MaterialTextView view = new MaterialTextView(context); view.setText(value); view.setTextSize(size); view.setTextIsSelectable(true);
        view.setTextColor(MaterialColors.getColor(view, com.google.android.material.R.attr.colorOnSurface));
        view.setPadding(0, dp(context, 4), 0, dp(context, 4));
        TextViewCompat.setLineHeight(view, Math.round(android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP, size + 6, context.getResources().getDisplayMetrics())));
        return view;
    }
    static EditText input(LinearLayout parent, String hint, String initial, int inputType) {
        Context context = parent.getContext();
        TextInputLayout field = new TextInputLayout(context, null, com.google.android.material.R.attr.textInputOutlinedStyle);
        field.setHint(hint); field.setBoxBackgroundMode(TextInputLayout.BOX_BACKGROUND_OUTLINE);
        TextInputEditText input = new TextInputEditText(field.getContext()); input.setInputType(inputType);
        input.setText(initial); input.setMinHeight(dp(context, 56)); input.setContentDescription(hint);
        field.addView(input, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 8); params.bottomMargin = dp(context, 8);
        parent.addView(field, params); return input;
    }
    static void fieldVisible(EditText input, boolean visible) {
        android.view.ViewParent parent = input.getParent();
        while (parent != null && !(parent instanceof TextInputLayout)) parent = parent.getParent();
        (parent instanceof TextInputLayout ? (View) parent : input).setVisibility(visible ? View.VISIBLE : View.GONE);
    }
    static LinearLayout card(LinearLayout parent, String heading) {
        Context context = parent.getContext(); MaterialCardView card = new MaterialCardView(context);
        card.setRadius(dp(context, 16)); card.setCardElevation(0);
        card.setStrokeWidth(dp(context, 1)); card.setStrokeColor(MaterialColors.getColor(card, com.google.android.material.R.attr.colorOutlineVariant));
        card.setCardBackgroundColor(MaterialColors.getColor(card, com.google.android.material.R.attr.colorSurface));
        LinearLayout box = new LinearLayout(context); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(context, 20), dp(context, 16), dp(context, 20), dp(context, 20));
        card.addView(box, new android.widget.FrameLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 6); params.bottomMargin = dp(context, 6);
        parent.addView(card, params);
        if (heading != null && !heading.isEmpty()) box.addView(cardTitle(context, heading));
        return box;
    }
    static TextView cardTitle(Context context, String heading) {
        TextView title = muted(context, heading, 13); title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setPadding(0, 0, 0, dp(context, 12));
        if (android.os.Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
        return title;
    }
    /** Dashboard metric tile: icon + caption row, big value, muted sub-line. */
    static final class MetricTile { TextView value, sub; }
    static MetricTile metric(LinearLayout row, int icon, String caption) {
        Context context = row.getContext(); MaterialCardView card = new MaterialCardView(context);
        card.setRadius(dp(context, 16)); card.setCardElevation(0);
        card.setStrokeWidth(dp(context, 1)); card.setStrokeColor(MaterialColors.getColor(card, com.google.android.material.R.attr.colorOutlineVariant));
        card.setCardBackgroundColor(MaterialColors.getColor(card, com.google.android.material.R.attr.colorSurface));
        LinearLayout box = new LinearLayout(context); box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(context, 16), dp(context, 12), dp(context, 16), dp(context, 14));
        LinearLayout head = new LinearLayout(context); head.setOrientation(LinearLayout.HORIZONTAL); head.setGravity(android.view.Gravity.CENTER_VERTICAL);
        head.addView(iconTile(context, icon, 28), new LinearLayout.LayoutParams(dp(context, 28), dp(context, 28)));
        TextView label = muted(context, caption, 12); label.setPadding(0, 0, 0, 0);
        label.setSingleLine(true); label.setEllipsize(android.text.TextUtils.TruncateAt.END); label.setGravity(android.view.Gravity.END);
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(0, -2, 1); labelParams.setMarginStart(dp(context, 8));
        head.addView(label, labelParams);
        box.addView(head, new LinearLayout.LayoutParams(-1, -2));
        MetricTile tile = new MetricTile();
        tile.value = text(context, "—", 24); tile.value.setTypeface(null, android.graphics.Typeface.BOLD); tile.value.setPadding(0, dp(context, 8), 0, 0);
        box.addView(tile.value, new LinearLayout.LayoutParams(-1, -2));
        tile.sub = muted(context, "", 12); tile.sub.setPadding(0, dp(context, 2), 0, 0); tile.sub.setVisibility(View.GONE);
        box.addView(tile.sub, new LinearLayout.LayoutParams(-1, -2));
        card.addView(box, new android.widget.FrameLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1);
        params.setMarginStart(dp(context, 4)); params.setMarginEnd(dp(context, 4)); params.topMargin = dp(context, 6); params.bottomMargin = dp(context, 6);
        row.addView(card, params);
        return tile;
    }
    /** WebUI more-page entry: full-width card, icon tile, title + description, chevron. */
    static LinearLayout entryRow(LinearLayout parent, int icon, String title, String description, Runnable action) {
        Context context = parent.getContext(); MaterialCardView card = new MaterialCardView(context);
        card.setRadius(dp(context, 16)); card.setCardElevation(0);
        card.setStrokeWidth(dp(context, 1)); card.setStrokeColor(MaterialColors.getColor(card, com.google.android.material.R.attr.colorOutlineVariant));
        card.setCardBackgroundColor(MaterialColors.getColor(card, com.google.android.material.R.attr.colorSurface));
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setPadding(dp(context, 14), dp(context, 14), dp(context, 14), dp(context, 14));
        row.addView(iconTile(context, icon, 40), new LinearLayout.LayoutParams(dp(context, 40), dp(context, 40)));
        LinearLayout col = new LinearLayout(context); col.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams colParams = new LinearLayout.LayoutParams(0, -2, 1); colParams.setMarginStart(dp(context, 14));
        TextView name = text(context, title, 16); name.setTypeface(null, android.graphics.Typeface.BOLD); name.setPadding(0, 0, 0, 0); name.setSingleLine(true);
        col.addView(name, new LinearLayout.LayoutParams(-1, -2));
        if (description != null && !description.isEmpty()) {
            TextView desc = muted(context, description, 13); desc.setPadding(0, dp(context, 2), 0, 0); desc.setMaxLines(2);
            col.addView(desc, new LinearLayout.LayoutParams(-1, -2));
        }
        row.addView(col, colParams);
        ImageView chevron = new ImageView(context); chevron.setImageResource(R.drawable.ic_chevron_right);
        chevron.setColorFilter(MaterialColors.getColor(chevron, com.google.android.material.R.attr.colorOnSurfaceVariant));
        row.addView(chevron, new LinearLayout.LayoutParams(dp(context, 20), dp(context, 20)));
        card.addView(row, new android.widget.FrameLayout.LayoutParams(-1, -2));
        card.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 5); params.bottomMargin = dp(context, 5);
        parent.addView(card, params);
        return row;
    }
    /** Inset value row from the WebUI device card: bordered box, mono value, trailing icon action. */
    static LinearLayout insetRow(LinearLayout parent, String value, int icon, Runnable action) {
        Context context = parent.getContext();
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setPadding(dp(context, 14), dp(context, 4), dp(context, 4), dp(context, 4));
        android.graphics.drawable.GradientDrawable box = new android.graphics.drawable.GradientDrawable();
        box.setCornerRadius(dp(context, 12));
        box.setColor(MaterialColors.getColor(row, com.google.android.material.R.attr.colorSurfaceContainer));
        box.setStroke(dp(context, 1), MaterialColors.getColor(row, com.google.android.material.R.attr.colorOutlineVariant));
        row.setBackground(box);
        TextView text = text(context, value, 14); text.setTypeface(android.graphics.Typeface.MONOSPACE); text.setPadding(0, 0, 0, 0);
        row.addView(text, new LinearLayout.LayoutParams(0, -2, 1));
        ImageButton button = new ImageButton(context); button.setImageResource(icon);
        button.setColorFilter(MaterialColors.getColor(button, com.google.android.material.R.attr.colorOnSurfaceVariant));
        android.util.TypedValue ripple = new android.util.TypedValue();
        context.getTheme().resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, ripple, true);
        button.setBackgroundResource(ripple.resourceId);
        button.setContentDescription(value); button.setOnClickListener(v -> action.run());
        row.addView(button, new LinearLayout.LayoutParams(dp(context, 40), dp(context, 40)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 4); params.bottomMargin = dp(context, 4);
        parent.addView(row, params);
        return row;
    }
    /** Label-value info line: muted caption left, value right. */
    static LinearLayout infoRow(LinearLayout parent, String label, String value, boolean ok) {
        Context context = parent.getContext();
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setPadding(dp(context, 4), dp(context, 8), dp(context, 4), dp(context, 8));
        TextView name = muted(context, label, 14); name.setPadding(0, 0, 0, 0);
        row.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
        TextView val = text(context, value, 14); val.setPadding(0, 0, 0, 0); val.setTypeface(null, android.graphics.Typeface.BOLD);
        if (ok) val.setTextColor(androidx.core.content.ContextCompat.getColor(context, R.color.foxy_ok));
        row.addView(val, new LinearLayout.LayoutParams(-2, -2));
        parent.addView(row, new LinearLayout.LayoutParams(-1, -2));
        return row;
    }
    /** WebUI quick-entry row: leading icon, label, trailing chevron, full-width ripple. */
    static LinearLayout linkRow(LinearLayout parent, int icon, String label, Runnable action) {
        Context context = parent.getContext();
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(android.view.Gravity.CENTER_VERTICAL); row.setMinimumHeight(dp(context, 48));
        row.setPadding(dp(context, 4), dp(context, 6), dp(context, 4), dp(context, 6));
        android.util.TypedValue ripple = new android.util.TypedValue();
        context.getTheme().resolveAttribute(android.R.attr.selectableItemBackground, ripple, true);
        row.setBackgroundResource(ripple.resourceId);
        ImageView leading = new ImageView(context); leading.setImageResource(icon);
        leading.setColorFilter(MaterialColors.getColor(leading, com.google.android.material.R.attr.colorOnSurfaceVariant));
        row.addView(leading, new LinearLayout.LayoutParams(dp(context, 22), dp(context, 22)));
        TextView text = text(context, label, 16);
        LinearLayout.LayoutParams textParams = new LinearLayout.LayoutParams(0, -2, 1); textParams.setMarginStart(dp(context, 14));
        row.addView(text, textParams);
        ImageView chevron = new ImageView(context); chevron.setImageResource(R.drawable.ic_chevron_right);
        chevron.setColorFilter(MaterialColors.getColor(chevron, com.google.android.material.R.attr.colorOnSurfaceVariant));
        row.addView(chevron, new LinearLayout.LayoutParams(dp(context, 20), dp(context, 20)));
        row.setOnClickListener(v -> action.run());
        parent.addView(row, new LinearLayout.LayoutParams(-1, -2));
        return row;
    }
    static LinearLayout hero(LinearLayout parent) {
        Context context = parent.getContext(); MaterialCardView card = new MaterialCardView(context);
        card.setRadius(dp(context, 18)); card.setCardElevation(0); card.setStrokeWidth(0);
        card.setCardBackgroundColor(MaterialColors.getColor(card, com.google.android.material.R.attr.colorSurfaceContainerHigh));
        LinearLayout box = new LinearLayout(context); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(context, 24), dp(context, 20), dp(context, 24), dp(context, 24));
        card.addView(box, new android.widget.FrameLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 6); params.bottomMargin = dp(context, 6);
        parent.addView(card, params);
        return box;
    }
    /** Warm tinted rounded square behind a leading icon, WebUI list/grid style. */
    static ImageView iconTile(Context context, int icon, int size) {
        ImageView view = new ImageView(context);
        view.setImageResource(icon);
        view.setColorFilter(androidx.core.content.ContextCompat.getColor(context, R.color.foxy_accent));
        android.graphics.drawable.GradientDrawable tile = new android.graphics.drawable.GradientDrawable();
        tile.setCornerRadius(dp(context, size / 3));
        tile.setColor(MaterialColors.getColor(view, com.google.android.material.R.attr.colorPrimaryContainer));
        view.setBackground(tile);
        int pad = dp(context, size / 4);
        view.setPadding(pad, pad, pad, pad);
        return view;
    }
    /** Circled/soft-square status icon from the WebUI hero and banners. */
    static ImageView statusIcon(Context context, int icon, int tone) {
        ImageView view = new ImageView(context);
        view.setImageResource(icon);
        android.graphics.drawable.GradientDrawable tile = new android.graphics.drawable.GradientDrawable();
        tile.setCornerRadius(dp(context, 14));
        if (tone == BADGE_OK) {
            tile.setColor(androidx.core.content.ContextCompat.getColor(context, R.color.foxy_ok_soft));
            view.setColorFilter(androidx.core.content.ContextCompat.getColor(context, R.color.foxy_ok));
        } else if (tone == BADGE_ERROR) {
            tile.setColor(MaterialColors.getColor(view, com.google.android.material.R.attr.colorErrorContainer));
            view.setColorFilter(MaterialColors.getColor(view, androidx.appcompat.R.attr.colorError));
        } else {
            tile.setColor(MaterialColors.getColor(view, com.google.android.material.R.attr.colorSurface));
            tile.setStroke(dp(context, 1), MaterialColors.getColor(view, com.google.android.material.R.attr.colorOutlineVariant));
            view.setColorFilter(MaterialColors.getColor(view, com.google.android.material.R.attr.colorOnSurfaceVariant));
        }
        view.setBackground(tile);
        int pad = dp(context, 10);
        view.setPadding(pad, pad, pad, pad);
        return view;
    }
    /** 3dp tone accent across the top of a hero panel. */
    static View accentStrip(LinearLayout heroBox) {
        Context context = heroBox.getContext();
        View strip = new View(context);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(context, 3));
        params.setMargins(-dp(context, 24), -dp(context, 20), -dp(context, 24), dp(context, 14));
        heroBox.addView(strip, 0, params);
        return strip;
    }
    static void toneAccent(View strip, Context context, int tone) {
        android.graphics.drawable.GradientDrawable bar = new android.graphics.drawable.GradientDrawable();
        bar.setCornerRadius(dp(context, 2));
        if (tone == BADGE_OK) bar.setColor(androidx.core.content.ContextCompat.getColor(context, R.color.foxy_ok));
        else if (tone == BADGE_ERROR) bar.setColor(MaterialColors.getColor(strip, androidx.appcompat.R.attr.colorError));
        else bar.setColor(android.graphics.Color.TRANSPARENT);
        strip.setBackground(bar);
    }
    /** Bordered notice banner: leading icon + message, WebUI alert style. */
    static LinearLayout banner(LinearLayout parent, int icon, String text) {
        Context context = parent.getContext();
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setPadding(dp(context, 14), dp(context, 12), dp(context, 14), dp(context, 12));
        android.graphics.drawable.GradientDrawable box = new android.graphics.drawable.GradientDrawable();
        box.setCornerRadius(dp(context, 14));
        box.setColor(MaterialColors.getColor(row, com.google.android.material.R.attr.colorSurface));
        box.setStroke(dp(context, 1), MaterialColors.getColor(row, com.google.android.material.R.attr.colorOutlineVariant));
        row.setBackground(box);
        ImageView leading = new ImageView(context); leading.setImageResource(icon);
        leading.setColorFilter(MaterialColors.getColor(leading, com.google.android.material.R.attr.colorOnSurfaceVariant));
        row.addView(leading, new LinearLayout.LayoutParams(dp(context, 20), dp(context, 20)));
        TextView message = muted(context, text, 14); message.setPadding(0, 0, 0, 0);
        LinearLayout.LayoutParams textParams = new LinearLayout.LayoutParams(0, -2, 1); textParams.setMarginStart(dp(context, 12));
        row.addView(message, textParams);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 6); params.bottomMargin = dp(context, 6);
        parent.addView(row, params);
        return row;
    }
    /** WebUI quick-access card: accent icon, bold title, muted description, chevron. Half of a 2-col grid row. */
    static LinearLayout quickCard(LinearLayout row, int icon, String title, String description, Runnable action) {
        Context context = row.getContext(); MaterialCardView card = new MaterialCardView(context);
        card.setRadius(dp(context, 16)); card.setCardElevation(0);
        card.setStrokeWidth(dp(context, 1)); card.setStrokeColor(MaterialColors.getColor(card, com.google.android.material.R.attr.colorOutlineVariant));
        card.setCardBackgroundColor(MaterialColors.getColor(card, com.google.android.material.R.attr.colorSurface));
        LinearLayout box = new LinearLayout(context); box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(context, 16), dp(context, 14), dp(context, 16), dp(context, 14));
        LinearLayout head = new LinearLayout(context); head.setOrientation(LinearLayout.HORIZONTAL); head.setGravity(android.view.Gravity.CENTER_VERTICAL);
        TextView name = text(context, title, 15); name.setTypeface(null, android.graphics.Typeface.BOLD); name.setPadding(0, 0, 0, 0); name.setSingleLine(true);
        head.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
        ImageView chevron = new ImageView(context); chevron.setImageResource(R.drawable.ic_chevron_right);
        chevron.setColorFilter(MaterialColors.getColor(chevron, com.google.android.material.R.attr.colorOnSurfaceVariant));
        head.addView(chevron, new LinearLayout.LayoutParams(dp(context, 18), dp(context, 18)));
        box.addView(head, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout body = new LinearLayout(context); body.setOrientation(LinearLayout.HORIZONTAL); body.setGravity(android.view.Gravity.TOP);
        body.setPadding(0, dp(context, 8), 0, 0);
        ImageView leading = new ImageView(context); leading.setImageResource(icon);
        leading.setColorFilter(androidx.core.content.ContextCompat.getColor(context, R.color.foxy_accent));
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(context, 20), dp(context, 20)); iconParams.setMarginEnd(dp(context, 10));
        body.addView(leading, iconParams);
        TextView desc = muted(context, description, 13); desc.setPadding(0, 0, 0, 0); desc.setMaxLines(3);
        body.addView(desc, new LinearLayout.LayoutParams(0, -2, 1));
        box.addView(body, new LinearLayout.LayoutParams(-1, -2));
        card.addView(box, new android.widget.FrameLayout.LayoutParams(-1, -2));
        card.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1);
        params.setMarginStart(dp(context, 4)); params.setMarginEnd(dp(context, 4)); params.topMargin = dp(context, 5); params.bottomMargin = dp(context, 5);
        row.addView(card, params);
        return box;
    }
    /** WebUI page heading: 26px bold title above the content cards. */
    static TextView pageTitle(Context context, String title) {
        TextView view = text(context, title, 26); view.setTypeface(null, android.graphics.Typeface.BOLD);
        view.setPadding(0, dp(context, 10), 0, dp(context, 14));
        if (android.os.Build.VERSION.SDK_INT >= 28) view.setAccessibilityHeading(true);
        return view;
    }
}
