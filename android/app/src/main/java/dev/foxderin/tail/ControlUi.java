package dev.foxderin.tail;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Typeface;
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

/* Shared components, ported from webui/src/style.css + components/ui.tsx (v1.4.1).
 * All geometry and type sizes live in res/values/dimens.xml; colors in colors.xml. */
final class ControlUi {
    private ControlUi() { }
    static int dp(Context context, int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
    private static int dimen(View view, int res) { return view.getResources().getDimensionPixelSize(res); }
    private static int dimen(Context context, int res) { return context.getResources().getDimensionPixelSize(res); }
    private static int attr(View view, int attrRes) { return MaterialColors.getColor(view, attrRes); }
    private static int res(Context context, int colorRes) { return androidx.core.content.ContextCompat.getColor(context, colorRes); }
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

    /* ---- Buttons (.btn: 12px semibold, 44px min height, 11px radius) ---- */
    static MaterialButton button(Context context, String text, Runnable action) { return button(context, text, 0, action); }
    static MaterialButton button(Context context, String text, int icon, Runnable action) {
        MaterialButton button = new MaterialButton(context, null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
        configure(button, text, icon, action); return button;
    }
    static MaterialButton primaryButton(Context context, String text, Runnable action) { return primaryButton(context, text, 0, action); }
    static MaterialButton primaryButton(Context context, String text, int icon, Runnable action) {
        MaterialButton button = new MaterialButton(context); configure(button, text, icon, action); return button;
    }
    static MaterialButton tonalButton(Context context, String text, Runnable action) { return tonalButton(context, text, 0, action); }
    static MaterialButton tonalButton(Context context, String text, int icon, Runnable action) {
        MaterialButton button = new MaterialButton(context, null, com.google.android.material.R.attr.materialButtonTonalStyle);
        configure(button, text, icon, action); return button;
    }
    private static void configure(MaterialButton button, String text, int icon, Runnable action) {
        button.setText(text); button.setAllCaps(false); button.setMinHeight(dp(button.getContext(), 44));
        button.setTextSize(12); button.setTypeface(button.getTypeface(), android.graphics.Typeface.BOLD);
        button.setMaxLines(3); button.setOnClickListener(v -> action.run());
        if (icon != 0) { button.setIconResource(icon); button.setIconGravity(MaterialButton.ICON_GRAVITY_TEXT_START); }
    }

    /* ---- Text (body 14px/1.55; not selectable inside clickable rows) ---- */
    static TextView text(Context context, String value, int sp) {
        MaterialTextView view = new MaterialTextView(context); view.setText(value); view.setTextSize(sp);
        view.setTextColor(attr(view, com.google.android.material.R.attr.colorOnSurface));
        view.setLineSpacing(0, 1.55f);
        return view;
    }
    static TextView textRes(Context context, String value, int sizeRes) {
        MaterialTextView view = new MaterialTextView(context); view.setText(value);
        view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, dimen(context, sizeRes));
        view.setTextColor(attr(view, com.google.android.material.R.attr.colorOnSurface));
        view.setLineSpacing(0, 1.55f);
        return view;
    }
    static TextView muted(Context context, String value, int sizeRes) {
        TextView view = textRes(context, value, sizeRes);
        view.setTextColor(attr(view, com.google.android.material.R.attr.colorOnSurfaceVariant));
        return view;
    }

    /* ---- Tones (badge/banner/health share the same tone language) ---- */
    static final int TONE_NEUTRAL = 0, TONE_OK = 1, TONE_ERROR = 2, TONE_WARN = 3, TONE_ACCENT = 4;
    static final int BADGE_NEUTRAL = TONE_NEUTRAL, BADGE_OK = TONE_OK, BADGE_ERROR = TONE_ERROR;
    private static int toneBackground(View view, int tone) {
        switch (tone) {
            case TONE_OK: return res(view.getContext(), R.color.foxy_ok_soft);
            case TONE_ERROR: return attr(view, com.google.android.material.R.attr.colorErrorContainer);
            case TONE_WARN: return attr(view, com.google.android.material.R.attr.colorTertiaryContainer);
            case TONE_ACCENT: return attr(view, com.google.android.material.R.attr.colorPrimaryContainer);
            default: return attr(view, com.google.android.material.R.attr.colorSurfaceContainer);
        }
    }
    private static int toneForeground(View view, int tone) {
        switch (tone) {
            case TONE_OK: return res(view.getContext(), R.color.foxy_ok);
            case TONE_ERROR: return attr(view, com.google.android.material.R.attr.colorOnErrorContainer);
            case TONE_WARN: return attr(view, com.google.android.material.R.attr.colorOnTertiaryContainer);
            case TONE_ACCENT: return attr(view, androidx.appcompat.R.attr.colorPrimary);
            default: return attr(view, com.google.android.material.R.attr.colorOnSurfaceVariant);
        }
    }
    /** .status-badge: 11px semibold pill on a tonal fill. */
    static TextView badge(Context context, String value, int tone) {
        TextView view = new MaterialTextView(context);
        view.setText(value); view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, dimen(context, R.dimen.ft_caption));
        view.setTypeface(null, android.graphics.Typeface.BOLD);
        android.graphics.drawable.GradientDrawable shape = new android.graphics.drawable.GradientDrawable();
        shape.setCornerRadius(dimen(context, R.dimen.ft_radius_badge));
        shape.setColor(toneBackground(view, tone)); view.setTextColor(toneForeground(view, tone));
        view.setBackground(shape);
        int padX = dp(context, 9), padY = dp(context, 4);
        view.setPadding(padX, padY, padX, padY);
        return view;
    }

    /* ---- Cards (.panel: surface, 1px border, 16px radius, 20px padding) ---- */
    static LinearLayout card(LinearLayout parent, String heading) { return card(parent, heading, null); }
    static LinearLayout card(LinearLayout parent, String heading, String description) {
        Context context = parent.getContext(); MaterialCardView card = new MaterialCardView(context);
        card.setRadius(dimen(card, R.dimen.ft_radius_card)); card.setCardElevation(0);
        card.setStrokeWidth(dp(context, 1)); card.setStrokeColor(attr(card, com.google.android.material.R.attr.colorOutlineVariant));
        card.setCardBackgroundColor(attr(card, com.google.android.material.R.attr.colorSurface));
        LinearLayout box = new LinearLayout(context); box.setOrientation(LinearLayout.VERTICAL);
        int pad = dimen(context, R.dimen.ft_space_xl);
        box.setPadding(pad, dimen(context, R.dimen.ft_space_l), pad, pad);
        card.addView(box, new android.widget.FrameLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(context, 6); params.bottomMargin = dp(context, 6);
        parent.addView(card, params);
        if (heading != null && !heading.isEmpty()) {
            TextView title = new MaterialTextView(context);
            title.setText(heading); title.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, dimen(context, R.dimen.ft_section_title));
            title.setTypeface(Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
            title.setTextColor(attr(title, com.google.android.material.R.attr.colorOnSurface));
            title.setPadding(0, 0, 0, dimen(context, R.dimen.ft_space_l));
            if (android.os.Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
            box.addView(title, new LinearLayout.LayoutParams(-1, -2));
            if (description != null && !description.isEmpty()) {
                TextView desc = muted(context, description, R.dimen.ft_section_desc);
                desc.setPadding(0, -dimen(context, R.dimen.ft_space_m), 0, dimen(context, R.dimen.ft_space_l));
                box.addView(desc, new LinearLayout.LayoutParams(-1, -2));
            }
        }
        return box;
    }
    static TextView cardTitle(Context context, String heading) {
        TextView title = muted(context, heading, R.dimen.ft_caption); title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setPadding(0, 0, 0, dimen(context, R.dimen.ft_space_m));
        if (android.os.Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
        return title;
    }

    /* ---- Health card (.network-health: 24px radius tonal panel, 32px icon box) ---- */
    static final class HealthCard {
        LinearLayout box, actions; ImageView icon; TextView title, hint;
        private LinearLayout iconBox; private MaterialCardView card; private Context context;
        void setVisible(boolean visible) { card.setVisibility(visible ? View.VISIBLE : View.GONE); }
        void setTone(int tone, int iconRes) {
            icon.setImageResource(iconRes);
            icon.setColorFilter(toneForeground(icon, tone));
            android.graphics.drawable.GradientDrawable tile = new android.graphics.drawable.GradientDrawable();
            tile.setCornerRadius(dimen(context, R.dimen.ft_radius_banner));
            tile.setColor(toneBackground(icon, tone));
            if (tone == TONE_NEUTRAL) tile.setStroke(dp(context, 1), attr(icon, com.google.android.material.R.attr.colorOutlineVariant));
            iconBox.setBackground(tile);
            card.setCardBackgroundColor(tone == TONE_NEUTRAL || tone == TONE_ERROR
                    ? attr(card, com.google.android.material.R.attr.colorSurfaceContainerHigh) : toneBackground(card, tone));
            int bodyColor = tone == TONE_NEUTRAL || tone == TONE_ERROR
                    ? attr(title, com.google.android.material.R.attr.colorOnSurface) : toneForeground(title, tone);
            title.setTextColor(bodyColor); hint.setTextColor(bodyColor);
        }
    }
    static HealthCard healthCard(LinearLayout parent) {
        Context context = parent.getContext();
        HealthCard health = new HealthCard(); health.context = context;
        MaterialCardView card = new MaterialCardView(context); health.card = card;
        card.setRadius(dimen(card, R.dimen.ft_radius_hero)); card.setCardElevation(0); card.setStrokeWidth(0);
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        int pad = dp(context, 22);
        row.setPadding(pad, dp(context, 26) - dp(context, 14), pad, dp(context, 26));
        row.setMinimumHeight(dp(context, 112));
        health.iconBox = new LinearLayout(context);
        health.icon = new ImageView(context);
        health.iconBox.setGravity(android.view.Gravity.CENTER);
        health.iconBox.addView(health.icon, new LinearLayout.LayoutParams(dp(context, 32), dp(context, 32)));
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(context, 56), dp(context, 56));
        iconParams.setMarginEnd(dimen(context, R.dimen.ft_space_l));
        row.addView(health.iconBox, iconParams);
        LinearLayout col = new LinearLayout(context); col.setOrientation(LinearLayout.VERTICAL);
        health.title = textRes(context, "", R.dimen.ft_hero_title); health.title.setTypeface(null, android.graphics.Typeface.BOLD); health.title.setPadding(0, 0, 0, 0);
        col.addView(health.title, new LinearLayout.LayoutParams(-1, -2));
        health.hint = textRes(context, "", R.dimen.ft_body); health.hint.setAlpha(0.8f); health.hint.setPadding(0, dp(context, 6), 0, 0);
        col.addView(health.hint, new LinearLayout.LayoutParams(-1, -2));
        row.addView(col, new LinearLayout.LayoutParams(0, -2, 1));
        health.box = new LinearLayout(context); health.box.setOrientation(LinearLayout.VERTICAL);
        health.box.addView(row, new LinearLayout.LayoutParams(-1, -2));
        health.actions = new LinearLayout(context); health.actions.setOrientation(LinearLayout.HORIZONTAL);
        health.actions.setPadding(pad, 0, pad, dp(context, 18));
        health.box.addView(health.actions, new LinearLayout.LayoutParams(-1, -2));
        card.addView(health.box, new android.widget.FrameLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 6); params.bottomMargin = dp(context, 6);
        parent.addView(card, params);
        return health;
    }

    /* ---- Banner (.banner: tonal filled strip with icon) ---- */
    static LinearLayout banner(LinearLayout parent, int icon, String text) { return banner(parent, icon, text, TONE_NEUTRAL); }
    static LinearLayout banner(LinearLayout parent, int icon, String text, int tone) {
        Context context = parent.getContext();
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setPadding(dp(context, 14), dp(context, 12), dp(context, 14), dp(context, 12));
        android.graphics.drawable.GradientDrawable box = new android.graphics.drawable.GradientDrawable();
        box.setCornerRadius(dimen(context, R.dimen.ft_radius_banner));
        box.setColor(toneBackground(row, tone));
        row.setBackground(box);
        ImageView leading = new ImageView(context); leading.setImageResource(icon);
        leading.setColorFilter(toneForeground(row, tone));
        row.addView(leading, new LinearLayout.LayoutParams(dp(context, 18), dp(context, 18)));
        TextView message = muted(context, text, R.dimen.ft_body_small);
        message.setTextColor(toneForeground(row, tone)); message.setLineSpacing(0, 1.65f);
        LinearLayout.LayoutParams textParams = new LinearLayout.LayoutParams(0, -2, 1); textParams.setMarginStart(dp(context, 10));
        row.addView(message, textParams);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 6); params.bottomMargin = dp(context, 6);
        parent.addView(row, params);
        return row;
    }

    /* ---- Metric card (.metric-card: icon+label row, big tabular value, caption) ---- */
    static final class MetricTile { TextView value, unit, sub; private ImageView icon; private Context context;
        void setTone(int tone) { icon.setColorFilter(toneForeground(icon, tone)); }
    }
    static MetricTile metric(LinearLayout row, int icon, String caption) {
        Context context = row.getContext(); MaterialCardView card = new MaterialCardView(context);
        card.setRadius(dimen(card, R.dimen.ft_radius_card)); card.setCardElevation(0);
        card.setStrokeWidth(dp(context, 1)); card.setStrokeColor(attr(card, com.google.android.material.R.attr.colorOutlineVariant));
        card.setCardBackgroundColor(attr(card, com.google.android.material.R.attr.colorSurface));
        LinearLayout box = new LinearLayout(context); box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(context, 15), dp(context, 15), dp(context, 12), dp(context, 15));
        LinearLayout head = new LinearLayout(context); head.setOrientation(LinearLayout.HORIZONTAL); head.setGravity(android.view.Gravity.CENTER_VERTICAL);
        MetricTile tile = new MetricTile(); tile.context = context;
        tile.icon = new ImageView(context); tile.icon.setImageResource(icon);
        tile.icon.setColorFilter(attr(tile.icon, com.google.android.material.R.attr.colorOnSurfaceVariant));
        android.graphics.drawable.GradientDrawable iconBg = new android.graphics.drawable.GradientDrawable();
        iconBg.setCornerRadius(dp(context, 10));
        iconBg.setColor(attr(tile.icon, com.google.android.material.R.attr.colorSurfaceContainer));
        tile.icon.setBackground(iconBg);
        int iconPad = dp(context, 6);
        tile.icon.setPadding(iconPad, iconPad, iconPad, iconPad);
        head.addView(tile.icon, new LinearLayout.LayoutParams(dp(context, 27), dp(context, 27)));
        TextView label = muted(context, caption, R.dimen.ft_caption); label.setPadding(0, 0, 0, 0);
        label.setSingleLine(true); label.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(0, -2, 1); labelParams.setMarginStart(dp(context, 6));
        head.addView(label, labelParams);
        box.addView(head, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout valueRow = new LinearLayout(context); valueRow.setOrientation(LinearLayout.HORIZONTAL);
        valueRow.setGravity(android.view.Gravity.BOTTOM); valueRow.setPadding(0, dp(context, 14), 0, 0);
        tile.value = textRes(context, "—", R.dimen.ft_metric_value);
        tile.value.setTypeface(null, android.graphics.Typeface.BOLD); tile.value.setPadding(0, 0, 0, 0);
        if (android.os.Build.VERSION.SDK_INT >= 21) tile.value.setLetterSpacing(-0.03f);
        valueRow.addView(tile.value, new LinearLayout.LayoutParams(-2, -2));
        tile.unit = muted(context, "", R.dimen.ft_section_desc); tile.unit.setPadding(0, 0, 0, dp(context, 2));
        valueRow.addView(tile.unit, new LinearLayout.LayoutParams(-2, -2));
        box.addView(valueRow, new LinearLayout.LayoutParams(-1, -2));
        tile.sub = muted(context, "", R.dimen.ft_caption); tile.sub.setPadding(0, dp(context, 6), 0, 0); tile.sub.setVisibility(View.GONE);
        box.addView(tile.sub, new LinearLayout.LayoutParams(-1, -2));
        card.addView(box, new android.widget.FrameLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1);
        params.setMarginStart(dp(context, 4)); params.setMarginEnd(dp(context, 4)); params.topMargin = dp(context, 5); params.bottomMargin = dp(context, 5);
        row.addView(card, params);
        return tile;
    }

    /* ---- Entry/link rows ---- */
    static LinearLayout entryRow(LinearLayout parent, int icon, String title, String description, Runnable action) {
        Context context = parent.getContext(); MaterialCardView card = new MaterialCardView(context);
        card.setRadius(dimen(card, R.dimen.ft_radius_card)); card.setCardElevation(0);
        card.setStrokeWidth(dp(context, 1)); card.setStrokeColor(attr(card, com.google.android.material.R.attr.colorOutlineVariant));
        card.setCardBackgroundColor(attr(card, com.google.android.material.R.attr.colorSurface));
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setPadding(dp(context, 14), dp(context, 14), dp(context, 14), dp(context, 14));
        row.addView(iconTile(context, icon, 40), new LinearLayout.LayoutParams(dp(context, 40), dp(context, 40)));
        LinearLayout col = new LinearLayout(context); col.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams colParams = new LinearLayout.LayoutParams(0, -2, 1); colParams.setMarginStart(dp(context, 14));
        TextView name = textRes(context, title, R.dimen.ft_body); name.setTypeface(null, android.graphics.Typeface.BOLD); name.setPadding(0, 0, 0, 0); name.setSingleLine(true);
        col.addView(name, new LinearLayout.LayoutParams(-1, -2));
        if (description != null && !description.isEmpty()) {
            TextView desc = muted(context, description, R.dimen.ft_section_desc); desc.setPadding(0, dp(context, 3), 0, 0); desc.setMaxLines(2);
            col.addView(desc, new LinearLayout.LayoutParams(-1, -2));
        }
        row.addView(col, colParams);
        ImageView chevron = new ImageView(context); chevron.setImageResource(R.drawable.ic_chevron_right);
        chevron.setColorFilter(attr(chevron, com.google.android.material.R.attr.colorOnSurfaceVariant));
        row.addView(chevron, new LinearLayout.LayoutParams(dp(context, 20), dp(context, 20)));
        card.addView(row, new android.widget.FrameLayout.LayoutParams(-1, -2));
        card.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 5); params.bottomMargin = dp(context, 5);
        parent.addView(card, params);
        return row;
    }
    static LinearLayout linkRow(LinearLayout parent, int icon, String label, Runnable action) {
        Context context = parent.getContext();
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(android.view.Gravity.CENTER_VERTICAL); row.setMinimumHeight(dp(context, 48));
        row.setPadding(dp(context, 4), dp(context, 6), dp(context, 4), dp(context, 6));
        android.util.TypedValue ripple = new android.util.TypedValue();
        context.getTheme().resolveAttribute(android.R.attr.selectableItemBackground, ripple, true);
        row.setBackgroundResource(ripple.resourceId);
        ImageView leading = new ImageView(context); leading.setImageResource(icon);
        leading.setColorFilter(attr(leading, com.google.android.material.R.attr.colorOnSurfaceVariant));
        row.addView(leading, new LinearLayout.LayoutParams(dp(context, 22), dp(context, 22)));
        TextView text = textRes(context, label, R.dimen.ft_body_large);
        LinearLayout.LayoutParams textParams = new LinearLayout.LayoutParams(0, -2, 1); textParams.setMarginStart(dp(context, 14));
        row.addView(text, textParams);
        ImageView chevron = new ImageView(context); chevron.setImageResource(R.drawable.ic_chevron_right);
        chevron.setColorFilter(attr(chevron, com.google.android.material.R.attr.colorOnSurfaceVariant));
        row.addView(chevron, new LinearLayout.LayoutParams(dp(context, 20), dp(context, 20)));
        row.setOnClickListener(v -> action.run());
        parent.addView(row, new LinearLayout.LayoutParams(-1, -2));
        return row;
    }
    /** Quick-access card: accent icon, bold title, muted description, chevron. */
    static LinearLayout quickCard(LinearLayout row, int icon, String title, String description, Runnable action) {
        Context context = row.getContext(); MaterialCardView card = new MaterialCardView(context);
        card.setRadius(dimen(card, R.dimen.ft_radius_card)); card.setCardElevation(0);
        card.setStrokeWidth(dp(context, 1)); card.setStrokeColor(attr(card, com.google.android.material.R.attr.colorOutlineVariant));
        card.setCardBackgroundColor(attr(card, com.google.android.material.R.attr.colorSurface));
        LinearLayout box = new LinearLayout(context); box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dimen(context, R.dimen.ft_space_l), dp(context, 14), dimen(context, R.dimen.ft_space_l), dp(context, 14));
        LinearLayout head = new LinearLayout(context); head.setOrientation(LinearLayout.HORIZONTAL); head.setGravity(android.view.Gravity.CENTER_VERTICAL);
        TextView name = textRes(context, title, R.dimen.ft_section_title); name.setTypeface(null, android.graphics.Typeface.BOLD); name.setPadding(0, 0, 0, 0); name.setSingleLine(true);
        head.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
        ImageView chevron = new ImageView(context); chevron.setImageResource(R.drawable.ic_chevron_right);
        chevron.setColorFilter(attr(chevron, com.google.android.material.R.attr.colorOnSurfaceVariant));
        head.addView(chevron, new LinearLayout.LayoutParams(dp(context, 18), dp(context, 18)));
        box.addView(head, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout body = new LinearLayout(context); body.setOrientation(LinearLayout.HORIZONTAL); body.setGravity(android.view.Gravity.TOP);
        body.setPadding(0, dimen(context, R.dimen.ft_space_s), 0, 0);
        ImageView leading = new ImageView(context); leading.setImageResource(icon);
        leading.setColorFilter(res(context, R.color.foxy_accent));
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(context, 20), dp(context, 20)); iconParams.setMarginEnd(dp(context, 10));
        body.addView(leading, iconParams);
        TextView desc = muted(context, description, R.dimen.ft_section_desc); desc.setPadding(0, 0, 0, 0); desc.setMaxLines(3);
        body.addView(desc, new LinearLayout.LayoutParams(0, -2, 1));
        box.addView(body, new LinearLayout.LayoutParams(-1, -2));
        card.addView(box, new android.widget.FrameLayout.LayoutParams(-1, -2));
        card.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1);
        params.setMarginStart(dp(context, 4)); params.setMarginEnd(dp(context, 4)); params.topMargin = dp(context, 5); params.bottomMargin = dp(context, 5);
        row.addView(card, params);
        return box;
    }
    /** .list-row info line: muted caption left, semibold value right. */
    static LinearLayout infoRow(LinearLayout parent, String label, String value, boolean ok) {
        Context context = parent.getContext();
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setPadding(dp(context, 4), dp(context, 10), dp(context, 4), dp(context, 10));
        TextView name = muted(context, label, R.dimen.ft_body); name.setPadding(0, 0, 0, 0);
        row.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
        TextView val = textRes(context, value, R.dimen.ft_body); val.setPadding(0, 0, 0, 0); val.setTypeface(Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
        if (ok) val.setTextColor(res(context, R.color.foxy_ok));
        row.addView(val, new LinearLayout.LayoutParams(-2, -2));
        parent.addView(row, new LinearLayout.LayoutParams(-1, -2));
        return row;
    }
    /** Inset value row: bordered container box, mono value, trailing icon action. */
    static LinearLayout insetRow(LinearLayout parent, String value, int icon, Runnable action) {
        Context context = parent.getContext();
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setPadding(dp(context, 14), dp(context, 4), dp(context, 4), dp(context, 4));
        android.graphics.drawable.GradientDrawable box = new android.graphics.drawable.GradientDrawable();
        box.setCornerRadius(dimen(context, R.dimen.ft_radius_banner));
        box.setColor(attr(row, com.google.android.material.R.attr.colorSurfaceContainer));
        box.setStroke(dp(context, 1), attr(row, com.google.android.material.R.attr.colorOutlineVariant));
        row.setBackground(box);
        TextView text = textRes(context, value, R.dimen.ft_body); text.setTypeface(android.graphics.Typeface.MONOSPACE); text.setPadding(0, 0, 0, 0);
        text.setTextIsSelectable(true);
        row.addView(text, new LinearLayout.LayoutParams(0, -2, 1));
        ImageButton button = new ImageButton(context); button.setImageResource(icon);
        button.setColorFilter(attr(button, com.google.android.material.R.attr.colorOnSurfaceVariant));
        android.util.TypedValue ripple = new android.util.TypedValue();
        context.getTheme().resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, ripple, true);
        button.setBackgroundResource(ripple.resourceId);
        button.setContentDescription(value); button.setOnClickListener(v -> action.run());
        row.addView(button, new LinearLayout.LayoutParams(dp(context, 40), dp(context, 40)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 4); params.bottomMargin = dp(context, 4);
        parent.addView(row, params);
        return row;
    }
    /** Warm tinted rounded square behind a leading icon. */
    static ImageView iconTile(Context context, int icon, int size) {
        ImageView view = new ImageView(context);
        view.setImageResource(icon);
        view.setColorFilter(res(context, R.color.foxy_accent));
        android.graphics.drawable.GradientDrawable tile = new android.graphics.drawable.GradientDrawable();
        tile.setCornerRadius(dp(context, size / 3));
        tile.setColor(attr(view, com.google.android.material.R.attr.colorPrimaryContainer));
        view.setBackground(tile);
        int pad = dp(context, size / 4);
        view.setPadding(pad, pad, pad, pad);
        return view;
    }
    /** WebUI page heading: 26px bold title above the content cards. */
    static TextView pageTitle(Context context, String title) {
        TextView view = text(context, title, 26); view.setTypeface(null, android.graphics.Typeface.BOLD);
        if (android.os.Build.VERSION.SDK_INT >= 21) view.setLetterSpacing(-0.03f);
        view.setPadding(0, dp(context, 10), 0, dp(context, 14));
        if (android.os.Build.VERSION.SDK_INT >= 28) view.setAccessibilityHeading(true);
        return view;
    }
    /* ---- Skeleton (.skeleton shimmer while the first read is in flight) ---- */
    static View skeleton(LinearLayout parent, float widthFraction, int heightDp) {
        Context context = parent.getContext();
        View bone = new View(context);
        android.graphics.drawable.GradientDrawable shape = new android.graphics.drawable.GradientDrawable();
        shape.setCornerRadius(dimen(context, R.dimen.ft_radius_badge));
        shape.setColor(attr(bone, com.google.android.material.R.attr.colorSurfaceContainerHighest));
        bone.setBackground(shape);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(widthFraction >= 1 ? -1 : (int) (parent.getResources().getDisplayMetrics().widthPixels * 0.6f * widthFraction), dp(context, heightDp));
        params.topMargin = dp(context, 8); params.bottomMargin = dp(context, 8);
        parent.addView(bone, params);
        android.view.animation.AlphaAnimation pulse = new android.view.animation.AlphaAnimation(1f, 0.45f);
        pulse.setDuration(800); pulse.setRepeatMode(android.view.animation.Animation.REVERSE); pulse.setRepeatCount(android.view.animation.Animation.INFINITE);
        bone.startAnimation(pulse);
        return bone;
    }
    /** Filter chips (.filter-chip): single-select row, active = accent fill + border. */
    static void chips(LinearLayout parent, String[] labels, int selected, java.util.function.IntConsumer change) {
        Context context = parent.getContext();
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL);
        TextView[] views = new TextView[labels.length];
        for (int i = 0; i < labels.length; i++) {
            final int index = i;
            TextView chip = new MaterialTextView(context);
            chip.setText(labels[i]); chip.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, dimen(context, R.dimen.ft_button));
            chip.setTypeface(Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
            chip.setGravity(android.view.Gravity.CENTER); chip.setMinHeight(dp(context, 44));
            chip.setPadding(dp(context, 14), 0, dp(context, 14), 0);
            chip.setOnClickListener(v -> { selectChips(views, index); change.accept(index); });
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2); params.setMarginEnd(dp(context, 8));
            views[i] = chip; row.addView(chip, params);
        }
        selectChips(views, selected);
        parent.addView(row, new LinearLayout.LayoutParams(-1, -2));
    }
    private static void selectChips(TextView[] chips, int selected) {
        for (int i = 0; i < chips.length; i++) {
            boolean active = i == selected;
            android.graphics.drawable.GradientDrawable shape = new android.graphics.drawable.GradientDrawable();
            shape.setCornerRadius(dimen(chips[i], R.dimen.ft_radius_chip));
            shape.setColor(active ? attr(chips[i], com.google.android.material.R.attr.colorPrimaryContainer) : attr(chips[i], com.google.android.material.R.attr.colorSurface));
            shape.setStroke(dp(chips[i].getContext(), 1), active ? attr(chips[i], androidx.appcompat.R.attr.colorPrimary) : attr(chips[i], com.google.android.material.R.attr.colorOutlineVariant));
            chips[i].setBackground(shape);
            chips[i].setTextColor(active ? attr(chips[i], androidx.appcompat.R.attr.colorPrimary) : attr(chips[i], com.google.android.material.R.attr.colorOnSurfaceVariant));
            chips[i].setSelected(active);
        }
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
}
