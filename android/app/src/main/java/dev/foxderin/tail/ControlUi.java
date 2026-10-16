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
    static MaterialButton textButton(Context context, String text, Runnable action) {
        MaterialButton button = new MaterialButton(context, null, androidx.appcompat.R.attr.borderlessButtonStyle);
        configure(button, text, 0, action); button.setStrokeWidth(0); button.setPadding(dp(context, 12), dp(context, 10), dp(context, 12), dp(context, 10)); return button;
    }
    static ImageButton iconButton(Context context, int icon, String description, Runnable action) { return iconButton(context, icon, description, action, 44); }
    static ImageButton iconButton(Context context, int icon, String description, Runnable action, int size) {
        ImageButton button = new ImageButton(context) {
            @Override public void setEnabled(boolean enabled) { super.setEnabled(enabled); setAlpha(enabled ? 1f : 0.38f); }
        };
        button.setImageResource(icon); button.setContentDescription(description); button.setTooltipText(description);
        button.setColorFilter(MaterialColors.getColor(button, com.google.android.material.R.attr.colorOnSurfaceVariant));
        android.util.TypedValue ripple = new android.util.TypedValue(); context.getTheme().resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, ripple, true);
        button.setBackgroundResource(ripple.resourceId); button.setPadding(dp(context, 12), dp(context, 12), dp(context, 12), dp(context, 12));
        button.setLayoutParams(new LinearLayout.LayoutParams(dp(context, size), dp(context, size))); button.setOnClickListener(v -> action.run()); return button;
    }
    /** Group icon buttons by meaning: refresh first, then neutral, then destructive. */
    static LinearLayout iconGroup(android.view.ViewGroup parent, View... buttons) {
        LinearLayout group = new LinearLayout(parent.getContext()); group.setOrientation(LinearLayout.HORIZONTAL);
        group.setGravity(android.view.Gravity.CENTER_VERTICAL);
        for (View button : buttons) if (button != null) {
            if (button.getParent() instanceof android.view.ViewGroup) ((android.view.ViewGroup) button.getParent()).removeView(button);
            group.addView(button);
        }
        android.view.ViewGroup.LayoutParams params = parent instanceof LinearLayout ? new LinearLayout.LayoutParams(-2, -2) : new android.view.ViewGroup.MarginLayoutParams(-2, -2);
        if (params instanceof LinearLayout.LayoutParams && ((LinearLayout) parent).getOrientation() == LinearLayout.VERTICAL) ((LinearLayout.LayoutParams) params).topMargin = dp(parent.getContext(), 4);
        parent.addView(group, params); return group;
    }
    static CompoundButton switchView(Context context, boolean checked, java.util.function.Consumer<Boolean> change) {
        WebSwitch control = new WebSwitch(context); control.setChecked(checked);
        control.setOnCheckedChangeListener((button, value) -> change.accept(value)); return control;
    }
    private static void configure(MaterialButton button, String text, int icon, Runnable action) {
        button.setText(text); button.setAllCaps(false); button.setMinHeight(dp(button.getContext(), 44)); button.setMinimumHeight(dp(button.getContext(), 44));
        button.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, dimen(button, R.dimen.ft_button)); button.setTypeface(button.getTypeface(), android.graphics.Typeface.BOLD);
        button.setLetterSpacing(0); button.setIncludeFontPadding(false); button.setLineHeight(Math.round(button.getTextSize() * 1.3f)); button.setMaxLines(3); button.setOnClickListener(v -> action.run());
        button.setMinimumWidth(0); button.setMinWidth(0); button.setInsetTop(0); button.setInsetBottom(0); button.setCornerRadius(dp(button.getContext(), 11));
        button.setPadding(dp(button.getContext(), 16), dp(button.getContext(), 10), dp(button.getContext(), 16), dp(button.getContext(), 10));
        button.setIconSize(dp(button.getContext(), 18)); button.setIconPadding(dp(button.getContext(), 7));
        if (icon != 0) { button.setIconResource(icon); button.setIconGravity(MaterialButton.ICON_GRAVITY_TEXT_START); }
    }

    /* Compact text; system font scaling remains enabled. */
    static TextView text(Context context, String value, int sp) {
        MaterialTextView view = new MaterialTextView(context); view.setText(value); view.setTextSize(sp);
        view.setTextColor(attr(view, com.google.android.material.R.attr.colorOnSurface));
        view.setIncludeFontPadding(false); view.setLineHeight(Math.round(view.getTextSize() * 1.55f));
        return view;
    }
    static TextView textRes(Context context, String value, int sizeRes) {
        MaterialTextView view = new MaterialTextView(context); view.setText(value);
        view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, dimen(context, sizeRes));
        view.setTextColor(attr(view, com.google.android.material.R.attr.colorOnSurface));
        view.setIncludeFontPadding(false); view.setLineHeight(Math.round(view.getTextSize() * 1.55f));
        return view;
    }
    static TextView muted(Context context, String value, int sizeRes) {
        TextView view = textRes(context, value, sizeRes);
        view.setTextColor(attr(view, com.google.android.material.R.attr.colorOnSurfaceVariant));
        return view;
    }
    static TextView hint(LinearLayout parent, String value) {
        TextView text = text(parent.getContext(), value, 13); text.setTextColor(attr(text, com.google.android.material.R.attr.colorOnSurfaceVariant));
        text.setLineHeight(Math.round(text.getTextSize() * 1.65f)); parent.addView(text, new LinearLayout.LayoutParams(-1, -2)); return text;
    }
    static void divider(LinearLayout parent) {
        View line = new View(parent.getContext()); line.setBackgroundColor(attr(line, com.google.android.material.R.attr.colorOutlineVariant));
        parent.addView(line, new LinearLayout.LayoutParams(-1, dp(parent.getContext(), 1)));
    }
    static LinearLayout result(LinearLayout parent) {
        Context context = parent.getContext(); LinearLayout box = new LinearLayout(context); box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(context, 14), dp(context, 14), dp(context, 14), dp(context, 14));
        android.graphics.drawable.GradientDrawable background = new android.graphics.drawable.GradientDrawable();
        background.setCornerRadius(dp(context, 12)); background.setColor(attr(box, com.google.android.material.R.attr.colorSurfaceContainer)); background.setStroke(dp(context, 1), attr(box, com.google.android.material.R.attr.colorOutlineVariant)); box.setBackground(background);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 14); parent.addView(box, params); return box;
    }
    static void emptyState(LinearLayout parent, String value, int icon) {
        Context context = parent.getContext(); LinearLayout row = new LinearLayout(context); row.setGravity(android.view.Gravity.CENTER_VERTICAL); row.setPadding(dp(context, 8), dp(context, 28), dp(context, 8), dp(context, 28));
        ImageView image = new ImageView(context); image.setImageResource(icon); image.setColorFilter(attr(image, com.google.android.material.R.attr.colorOnSurfaceVariant)); image.setPadding(dp(context, 12), dp(context, 12), dp(context, 12), dp(context, 12));
        android.graphics.drawable.GradientDrawable fill = new android.graphics.drawable.GradientDrawable(); fill.setCornerRadius(dp(context, 14)); fill.setColor(attr(image, com.google.android.material.R.attr.colorSurfaceContainer)); image.setBackground(fill); row.addView(image, new LinearLayout.LayoutParams(dp(context, 44), dp(context, 44)));
        TextView text = text(context, value, 13); text.setTextColor(attr(text, com.google.android.material.R.attr.colorOnSurfaceVariant)); text.setLineHeight(Math.round(text.getTextSize() * 1.7f)); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1); params.setMarginStart(dp(context, 12)); row.addView(text, params); parent.addView(row, new LinearLayout.LayoutParams(-1, -2));
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
    static void setBadgeTone(TextView view, int tone) {
        if (view.getBackground() instanceof android.graphics.drawable.GradientDrawable shape) shape.setColor(toneBackground(view, tone));
        view.setTextColor(toneForeground(view, tone));
    }

    /* ---- Cards (.panel: surface, 1px border, 16px radius, 20px padding) ---- */
    static LinearLayout card(LinearLayout parent, String heading) { return card(parent, heading, null); }
    static LinearLayout card(LinearLayout parent, String heading, String description) { return card(parent, heading, 0, description); }
    static LinearLayout card(LinearLayout parent, String heading, int icon, String description) {
        Context context = parent.getContext(); MaterialCardView card = new MaterialCardView(context);
        card.setRadius(dimen(card, R.dimen.ft_radius_card)); card.setCardElevation(0);
        card.setStrokeWidth(dp(context, 1)); card.setStrokeColor(attr(card, com.google.android.material.R.attr.colorOutlineVariant));
        card.setCardBackgroundColor(attr(card, com.google.android.material.R.attr.colorSurface));
        LinearLayout frame = new LinearLayout(context); frame.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(context, context.getResources().getConfiguration().screenWidthDp <= 380 ? 16 : 20);
        frame.setPadding(pad, pad, pad, pad);
        card.addView(frame, new android.widget.FrameLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = "web-disclosure-body".equals(parent.getTag()) ? 0 : dp(context, 20);
        parent.addView(card, params);
        if (heading != null && !heading.isEmpty()) {
            LinearLayout header = new LinearLayout(context); header.setOrientation(LinearLayout.VERTICAL); header.setPadding(0, 0, 0, dp(context, 16));
            LinearLayout titleRow = new LinearLayout(context); titleRow.setGravity(android.view.Gravity.CENTER_VERTICAL);
            if (icon != 0) {
                ImageView leading = new ImageView(context); leading.setImageResource(icon); leading.setColorFilter(attr(leading, androidx.appcompat.R.attr.colorPrimary));
                LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(context, 18), dp(context, 18)); iconParams.setMarginEnd(dp(context, 9)); titleRow.addView(leading, iconParams);
            }
            TextView title = text(context, heading, 15); title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); title.setLineHeight(Math.round(title.getTextSize() * 1.5f));
            title.setAccessibilityHeading(true); titleRow.addView(title, new LinearLayout.LayoutParams(0, -2, 1)); header.addView(titleRow);
            if (description != null && !description.isEmpty()) {
                TextView desc = muted(context, description, R.dimen.ft_section_desc); desc.setLineHeight(Math.round(desc.getTextSize() * 1.65f));
                LinearLayout.LayoutParams descParams = new LinearLayout.LayoutParams(-1, -2); descParams.topMargin = dp(context, 5); header.addView(desc, descParams);
            }
            frame.addView(header, new LinearLayout.LayoutParams(-1, -2));
        }
        LinearLayout box = new LinearLayout(context); box.setOrientation(LinearLayout.VERTICAL);
        frame.addView(box, new LinearLayout.LayoutParams(-1, -2));
        return box;
    }
    static void cardAction(LinearLayout body, View action) {
        LinearLayout frame = (LinearLayout) body.getParent(); View first = frame.getChildAt(0);
        LinearLayout header;
        if ("card-heading-actions".equals(first.getTag())) header = (LinearLayout) first;
        else {
            frame.removeView(first); header = new LinearLayout(body.getContext()); header.setTag("card-heading-actions"); header.setGravity(android.view.Gravity.TOP);
            header.addView(first, new LinearLayout.LayoutParams(0, -2, 1)); frame.addView(header, 0, new LinearLayout.LayoutParams(-1, -2));
        }
        if (action.getParent() instanceof android.view.ViewGroup) ((android.view.ViewGroup) action.getParent()).removeView(action);
        LinearLayout.LayoutParams params = action.getLayoutParams() instanceof LinearLayout.LayoutParams ? (LinearLayout.LayoutParams) action.getLayoutParams() : new LinearLayout.LayoutParams(-2, -2); params.setMarginStart(dp(body.getContext(), 10)); params.setMarginEnd(-dp(body.getContext(), 6)); params.topMargin = -dp(body.getContext(), 8); header.addView(action, params);
    }
    static LinearLayout disclosure(LinearLayout parent, String title, int icon) { return disclosure(parent, title, icon, open -> { }); }
    static LinearLayout disclosure(LinearLayout parent, String title, int icon, java.util.function.Consumer<Boolean> changed) {
        Context context = parent.getContext(); MaterialCardView card = new MaterialCardView(context);
        card.setRadius(dp(context, 16)); card.setCardElevation(0); card.setStrokeWidth(dp(context, 1)); card.setStrokeColor(attr(card, com.google.android.material.R.attr.colorOutlineVariant)); card.setCardBackgroundColor(attr(card, com.google.android.material.R.attr.colorSurfaceContainerLow));
        LinearLayout frame = new LinearLayout(context); frame.setOrientation(LinearLayout.VERTICAL);
        LinearLayout summary = new LinearLayout(context); summary.setGravity(android.view.Gravity.CENTER_VERTICAL); summary.setPadding(dp(context, 18), dp(context, 18), dp(context, 18), dp(context, 18)); summary.setFocusable(true);
        ImageView arrow = new ImageView(context); arrow.setImageResource(R.drawable.ic_chevron_right); arrow.setColorFilter(attr(arrow, com.google.android.material.R.attr.colorOnSurface)); summary.addView(arrow, new LinearLayout.LayoutParams(dp(context, 18), dp(context, 18)));
        if (icon != 0) { ImageView leading = new ImageView(context); leading.setImageResource(icon); leading.setColorFilter(attr(leading, com.google.android.material.R.attr.colorOnSurface)); summary.addView(leading, new LinearLayout.LayoutParams(dp(context, 18), dp(context, 18))); }
        TextView label = text(context, title, 15); label.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(0, -2, 1); labelParams.setMarginStart(dp(context, 8)); summary.addView(label, labelParams);
        LinearLayout body = new LinearLayout(context); body.setOrientation(LinearLayout.VERTICAL); body.setPadding(dp(context, 18), 0, dp(context, 18), dp(context, 18)); body.setVisibility(View.GONE);
        body.setTag("web-disclosure-body"); android.graphics.drawable.GradientDrawable gap = new android.graphics.drawable.GradientDrawable(); gap.setColor(android.graphics.Color.TRANSPARENT); gap.setSize(0, dp(context, 18)); body.setDividerDrawable(gap); body.setShowDividers(LinearLayout.SHOW_DIVIDER_MIDDLE);
        summary.setOnClickListener(v -> { boolean open = body.getVisibility() != View.VISIBLE; body.setVisibility(open ? View.VISIBLE : View.GONE); arrow.setRotation(open ? 90 : 0); summary.setSelected(open); changed.accept(open); });
        frame.addView(summary); frame.addView(body); card.addView(frame); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.bottomMargin = dp(context, 20); parent.addView(card, params); return body;
    }
    static LinearLayout dangerCard(LinearLayout parent, String title, int icon) {
        LinearLayout body = card(parent, title, icon, null); LinearLayout frame = (LinearLayout) body.getParent(); MaterialCardView card = (MaterialCardView) frame.getParent();
        int error = attr(card, androidx.appcompat.R.attr.colorError); card.setStrokeColor(error); frame.setPadding(dp(parent.getContext(), 18), dp(parent.getContext(), 18), dp(parent.getContext(), 18), dp(parent.getContext(), 18));
        card.setCardBackgroundColor(android.graphics.Color.TRANSPARENT);
        LinearLayout header = (LinearLayout) frame.getChildAt(0); header.setPadding(0, 0, 0, dp(parent.getContext(), 12)); LinearLayout titleRow = (LinearLayout) header.getChildAt(0);
        for (int i = 0; i < titleRow.getChildCount(); i++) { View child = titleRow.getChildAt(i); if (child instanceof TextView) ((TextView) child).setTextColor(error); else if (child instanceof ImageView) ((ImageView) child).setColorFilter(error); }
        return body;
    }
    /** Toggles the MaterialCardView shell owning a content box (survives card() layout changes). */
    static void setCardVisible(LinearLayout box, boolean visible) {
        android.view.View node = box;
        while (node != null && !(node instanceof MaterialCardView)) node = (android.view.View) node.getParent();
        if (node != null) node.setVisibility(visible ? android.view.View.VISIBLE : android.view.View.GONE);
    }
    /* ---- Health card (.network-health: 24px radius tonal panel, 32px icon box) ---- */
    static final class HealthCard {
        LinearLayout box, actions; ImageView icon; TextView title, hint;
        private LinearLayout iconBox; private MaterialCardView card; private Context context;
        void setVisible(boolean visible) { card.setVisibility(visible ? View.VISIBLE : View.GONE); }
        void setTone(int tone, int iconRes) {
            icon.setImageResource(iconRes);
            int background = tone == TONE_OK ? com.google.android.material.R.attr.colorSecondaryContainer : tone == TONE_WARN ? com.google.android.material.R.attr.colorTertiaryContainer : com.google.android.material.R.attr.colorSurfaceContainerHighest;
            int foreground = tone == TONE_OK ? com.google.android.material.R.attr.colorOnSecondaryContainer : tone == TONE_WARN ? com.google.android.material.R.attr.colorOnTertiaryContainer : com.google.android.material.R.attr.colorOnSurfaceVariant;
            int color = attr(card, foreground); icon.setColorFilter(color); card.setCardBackgroundColor(attr(card, background));
            title.setTextColor(color); hint.setTextColor(color);
        }
    }
    static HealthCard healthCard(LinearLayout parent) {
        Context context = parent.getContext();
        HealthCard health = new HealthCard(); health.context = context;
        MaterialCardView card = new MaterialCardView(context); health.card = card;
        card.setRadius(dimen(card, R.dimen.ft_radius_hero)); card.setCardElevation(0); card.setStrokeWidth(0);
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        boolean compact = context.getResources().getConfiguration().screenWidthDp <= 700;
        int pad = dp(context, compact ? 22 : 28);
        row.setPadding(pad, dp(context, compact ? 26 : 28), pad, dp(context, compact ? 26 : 28));
        row.setMinimumHeight(dp(context, 112));
        health.iconBox = new LinearLayout(context);
        health.icon = new ImageView(context);
        health.iconBox.setGravity(android.view.Gravity.CENTER);
        health.iconBox.addView(health.icon, new LinearLayout.LayoutParams(dp(context, 32), dp(context, 32)));
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(context, 32), dp(context, 32));
        iconParams.setMarginEnd(dp(context, compact ? 18 : 20));
        row.addView(health.iconBox, iconParams);
        LinearLayout col = new LinearLayout(context); col.setOrientation(LinearLayout.VERTICAL);
        health.title = text(context, "", compact ? 20 : 22); health.title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); health.title.setLineHeight(Math.round(health.title.getTextSize() * 1.4f)); health.title.setPadding(0, 0, 0, 0);
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
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.bottomMargin = dp(context, 20);
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
        message.setTextColor(toneForeground(row, tone));
        LinearLayout.LayoutParams textParams = new LinearLayout.LayoutParams(0, -2, 1); textParams.setMarginStart(dp(context, 10));
        row.addView(message, textParams);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.bottomMargin = dp(context, 16);
        parent.addView(row, params);
        return row;
    }

    /* ---- Metric card (.metric-card: icon+label row, big tabular value, caption) ---- */
    static final class MetricTile { TextView value, unit, sub; private ImageView icon; private Context context;
        void setTone(int tone) { icon.setColorFilter(toneForeground(icon, tone)); }
    }
    static MetricTile metric(LinearLayout row, int icon, String caption) { return metric(row, icon, caption, false); }
    static MetricTile dashboardMetric(LinearLayout row, int icon, String caption) { return metric(row, icon, caption, true); }
    private static MetricTile metric(LinearLayout row, int icon, String caption, boolean dashboard) {
        Context context = row.getContext(); MaterialCardView card = new MaterialCardView(context);
        card.setRadius(dimen(card, R.dimen.ft_radius_card)); card.setCardElevation(0);
        card.setStrokeWidth(dp(context, 1)); card.setStrokeColor(attr(card, com.google.android.material.R.attr.colorOutlineVariant));
        card.setCardBackgroundColor(attr(card, com.google.android.material.R.attr.colorSurface));
        LinearLayout box = new LinearLayout(context); box.setOrientation(LinearLayout.VERTICAL);
        int width = context.getResources().getConfiguration().screenWidthDp; boolean compact = dashboard && width <= 700;
        int padding = dp(context, width <= 380 ? 14 : 18);
        box.setPadding(compact ? dp(context, 12) : padding, compact ? dp(context, 15) : padding, compact ? dp(context, 12) : padding, compact ? dp(context, 15) : padding);
        LinearLayout head = new LinearLayout(context); head.setOrientation(LinearLayout.HORIZONTAL); head.setGravity(android.view.Gravity.CENTER_VERTICAL);
        head.setClipToPadding(false); head.setClipChildren(false);
        MetricTile tile = new MetricTile(); tile.context = context;
        tile.icon = new ImageView(context); tile.icon.setImageResource(icon);
        tile.icon.setColorFilter(attr(tile.icon, com.google.android.material.R.attr.colorOnSurfaceVariant));
        android.graphics.drawable.GradientDrawable iconBg = new android.graphics.drawable.GradientDrawable();
        iconBg.setCornerRadius(dp(context, 10));
        iconBg.setColor(attr(tile.icon, com.google.android.material.R.attr.colorSurfaceContainer));
        tile.icon.setBackground(iconBg);
        int iconPad = dp(context, 7);
        tile.icon.setPadding(iconPad, iconPad, iconPad, iconPad);
        tile.icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
        TextView label = muted(context, caption, R.dimen.ft_section_desc); label.setPadding(0, 0, 0, 0); label.setTextSize(compact ? width <= 480 ? 11 : 10 : 12); label.setLineHeight(Math.round(label.getTextSize() * 1.4f));
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(0, -2, 1);
        head.setMinimumHeight(dp(context, 32));
        if (dashboard) { labelParams.setMarginStart(dp(context, compact ? 5 : 8)); label.setGravity(android.view.Gravity.END); head.addView(tile.icon, new LinearLayout.LayoutParams(dp(context, compact ? 29 : 32), dp(context, compact ? 29 : 32))); head.addView(label, labelParams); }
        else { labelParams.setMarginEnd(dp(context, 8)); head.addView(label, labelParams); head.addView(tile.icon, new LinearLayout.LayoutParams(dp(context, 32), dp(context, 32))); }
        box.addView(head, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout valueRow = new LinearLayout(context); valueRow.setOrientation(LinearLayout.HORIZONTAL);
        valueRow.setGravity(android.view.Gravity.BOTTOM); valueRow.setPadding(0, dp(context, 14), 0, 0);
        tile.value = text(context, "—", dashboard && width <= 480 ? 28 : compact ? 24 : Math.min(28, Math.max(22, Math.round(width * .032f))));
        tile.value.setTypeface(null, android.graphics.Typeface.BOLD); tile.value.setPadding(0, 0, 0, 0); tile.value.setLineHeight(Math.round(tile.value.getTextSize() * 1.2f));
        if (android.os.Build.VERSION.SDK_INT >= 21) tile.value.setLetterSpacing(-0.03f);
        valueRow.addView(tile.value, new LinearLayout.LayoutParams(-2, -2));
        tile.unit = muted(context, "", R.dimen.ft_section_title); tile.unit.setTextSize(compact ? 12 : 15); tile.unit.setPadding(0, 0, 0, dp(context, 2));
        valueRow.addView(tile.unit, new LinearLayout.LayoutParams(-2, -2));
        box.addView(valueRow, new LinearLayout.LayoutParams(-1, -2));
        tile.sub = muted(context, "", R.dimen.ft_caption); tile.sub.setTextSize(compact ? 10 : 11); tile.sub.setLineHeight(Math.round(tile.sub.getTextSize() * (compact ? 1.6f : 1.5f))); tile.sub.setPadding(0, dp(context, 7), 0, 0); tile.sub.setVisibility(View.GONE);
        box.addView(tile.sub, new LinearLayout.LayoutParams(-1, -2));
        card.addView(box, new android.widget.FrameLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -1, 1); params.gravity = android.view.Gravity.TOP;
        if (row.getChildCount() > 0) params.setMarginStart(dp(context, compact ? 9 : width >= 640 ? 16 : 12)); params.bottomMargin = dp(context, 20);
        row.addView(card, params);
        return tile;
    }

    /** Quick-access card: accent icon, bold title, muted description, chevron. */
    static LinearLayout quickCard(LinearLayout row, int icon, String title, String description, Runnable action) {
        Context context = row.getContext(); boolean compact = context.getResources().getConfiguration().screenWidthDp <= 700;
        MaterialCardView card = new MaterialCardView(context); card.setRadius(dp(context, 14)); card.setCardElevation(0);
        card.setStrokeWidth(dp(context, 1)); card.setStrokeColor(attr(card, com.google.android.material.R.attr.colorOutlineVariant)); card.setCardBackgroundColor(attr(card, com.google.android.material.R.attr.colorSurface));
        LinearLayout box = new LinearLayout(context); box.setGravity(android.view.Gravity.CENTER_VERTICAL); box.setPadding(dp(context, compact ? 11 : 16), dp(context, compact ? 14 : 16), dp(context, compact ? 11 : 16), dp(context, compact ? 14 : 16));
        ImageView leading = new ImageView(context); leading.setImageResource(icon); leading.setColorFilter(attr(leading, androidx.appcompat.R.attr.colorPrimary));
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(context, 22), dp(context, 22)); iconParams.setMarginEnd(dp(context, compact ? 9 : 12)); box.addView(leading, iconParams);
        LinearLayout copy = new LinearLayout(context); copy.setOrientation(LinearLayout.VERTICAL); box.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        TextView name = text(context, title, 13); name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); copy.addView(name);
        TextView desc = text(context, description, 11); desc.setTextColor(attr(desc, com.google.android.material.R.attr.colorOnSurfaceVariant)); desc.setLineHeight(Math.round(desc.getTextSize() * 1.4f)); LinearLayout.LayoutParams descParams = new LinearLayout.LayoutParams(-1, -2); descParams.topMargin = dp(context, 5); copy.addView(desc, descParams);
        if (!compact) { ImageView chevron = new ImageView(context); chevron.setImageResource(R.drawable.ic_chevron_right); chevron.setColorFilter(attr(chevron, com.google.android.material.R.attr.colorOnSurfaceVariant)); box.addView(chevron, new LinearLayout.LayoutParams(dp(context, 18), dp(context, 18))); }
        card.addView(box, new android.widget.FrameLayout.LayoutParams(-1, -2)); card.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -1, 1); if (row.getChildCount() > 0) params.setMarginStart(dp(context, 10)); params.bottomMargin = dp(context, 10); row.addView(card, params); return box;
    }
    /** .list-row info line: muted caption left, semibold value right. */
    static LinearLayout infoRow(LinearLayout parent, String label, String value, boolean ok) {
        Context context = parent.getContext();
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(context, 10), 0, dp(context, 10));
        TextView name = text(context, label, 13); name.setTextColor(attr(name, com.google.android.material.R.attr.colorOnSurfaceVariant)); name.setPadding(0, 0, 0, 0);
        row.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
        TextView val = text(context, value, 13); val.setGravity(android.view.Gravity.END); val.setPadding(dp(context, 16), 0, 0, 0); val.setTypeface(Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
        if (ok) val.setTextColor(res(context, R.color.foxy_ok));
        row.addView(val, new LinearLayout.LayoutParams(0, -2, 1));
        parent.addView(row, new LinearLayout.LayoutParams(-1, -2));
        return row;
    }
    /** Inset value row: bordered container box, mono value, trailing icon action. */
    static LinearLayout insetRow(LinearLayout parent, String value, int icon, Runnable action) {
        Context context = parent.getContext();
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setPadding(dp(context, 12), dp(context, 3), dp(context, 5), dp(context, 3));
        android.graphics.drawable.GradientDrawable box = new android.graphics.drawable.GradientDrawable();
        box.setCornerRadius(dp(context, 10));
        box.setColor(attr(row, com.google.android.material.R.attr.colorSurfaceContainerLow));
        box.setStroke(dp(context, 1), attr(row, com.google.android.material.R.attr.colorOutlineVariant));
        row.setBackground(box);
        TextView text = text(context, value, 12); text.setTypeface(android.graphics.Typeface.MONOSPACE); text.setPadding(0, 0, 0, 0);
        text.setTextIsSelectable(true);
        row.addView(text, new LinearLayout.LayoutParams(0, -2, 1));
        ImageButton button = iconButton(context, icon, value, action);
        row.addView(button, new LinearLayout.LayoutParams(dp(context, 44), dp(context, 44)));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 3); params.bottomMargin = dp(context, 4);
        parent.addView(row, params);
        return row;
    }
    /** Network device avatar, shared with peer identity rows. */
    static ImageView iconTile(Context context, int icon, int size) {
        ImageView view = new ImageView(context);
        view.setImageResource(icon);
        view.setColorFilter(attr(view, com.google.android.material.R.attr.colorOnSurfaceVariant));
        android.graphics.drawable.GradientDrawable tile = new android.graphics.drawable.GradientDrawable();
        tile.setCornerRadius(dp(context, 13));
        tile.setColor(attr(view, com.google.android.material.R.attr.colorSurfaceContainer)); tile.setStroke(dp(context, 1), attr(view, com.google.android.material.R.attr.colorOutlineVariant));
        view.setBackground(tile);
        int pad = dp(context, size / 4);
        view.setPadding(pad, pad, pad, pad);
        return view;
    }
    /* ---- Skeleton (.skeleton shimmer while the first read is in flight) ---- */
    static View skeleton(LinearLayout parent, float widthFraction, int heightDp) {
        Context context = parent.getContext();
        View bone = new View(context) {
            private android.animation.ObjectAnimator pulse;
            private void updatePulse() {
                if (isAttachedToWindow() && isShown() && android.animation.ValueAnimator.areAnimatorsEnabled()) {
                    if (pulse == null) { pulse = android.animation.ObjectAnimator.ofFloat(this, View.ALPHA, 1f, .45f); pulse.setDuration(800); pulse.setRepeatMode(android.animation.ValueAnimator.REVERSE); pulse.setRepeatCount(android.animation.ValueAnimator.INFINITE); pulse.start(); }
                } else if (pulse != null) { pulse.cancel(); pulse = null; setAlpha(1f); }
            }
            @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); updatePulse(); }
            @Override protected void onDetachedFromWindow() { if (pulse != null) { pulse.cancel(); pulse = null; } super.onDetachedFromWindow(); }
            @Override protected void onVisibilityChanged(View changed, int visibility) { super.onVisibilityChanged(changed, visibility); updatePulse(); }
        };
        android.graphics.drawable.GradientDrawable shape = new android.graphics.drawable.GradientDrawable();
        shape.setCornerRadius(dimen(context, R.dimen.ft_radius_badge));
        shape.setColor(attr(bone, com.google.android.material.R.attr.colorSurfaceContainerHighest));
        bone.setBackground(shape);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(widthFraction >= 1 ? -1 : (int) (parent.getResources().getDisplayMetrics().widthPixels * 0.6f * widthFraction), dp(context, heightDp));
        params.topMargin = dp(context, 8); params.bottomMargin = dp(context, 8);
        parent.addView(bone, params);
        return bone;
    }
    /** Filter chips (.filter-chip): single-select row, active = accent fill + border. */
    static void chips(LinearLayout parent, String[] labels, int selected, java.util.function.IntConsumer change) {
        Context context = parent.getContext();
        ToolsFlowLayout row = new ToolsFlowLayout(context, 8, 8);
        TextView[] views = new TextView[labels.length];
        for (int i = 0; i < labels.length; i++) {
            final int index = i;
            TextView chip = new MaterialTextView(context);
            chip.setText(labels[i]); chip.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, dimen(context, R.dimen.ft_button));
            chip.setTypeface(Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
            chip.setGravity(android.view.Gravity.CENTER); chip.setMinHeight(dp(context, 48)); chip.setFocusable(true);
            chip.setPadding(dp(context, 12), dp(context, 4), dp(context, 12), dp(context, 4));
            chip.setOnClickListener(v -> { selectChips(views, index); change.accept(index); });
            views[i] = chip; row.addView(chip, new android.view.ViewGroup.MarginLayoutParams(-2, -2));
        }
        selectChips(views, selected);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(context, 8); params.bottomMargin = dp(context, 8);
        parent.addView(row, params);
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
    static LinearLayout tabs(LinearLayout parent, String[] labels, int selected, java.util.function.IntConsumer change) {
        Context context = parent.getContext(); LinearLayout group = new LinearLayout(context); group.setOrientation(LinearLayout.HORIZONTAL);
        group.setPadding(dp(context, 4), dp(context, 4), dp(context, 4), dp(context, 4));
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable(); bg.setCornerRadius(dp(context, 13)); bg.setColor(attr(group, com.google.android.material.R.attr.colorSurfaceContainer)); bg.setStroke(dp(context, 1), attr(group, com.google.android.material.R.attr.colorOutlineVariant)); group.setBackground(bg);
        TextView[] buttons = new TextView[labels.length];
        for (int i = 0; i < labels.length; i++) {
            final int index = i; TextView button = text(context, labels[i], 12); button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); button.setMinHeight(dp(context, 44)); button.setGravity(android.view.Gravity.CENTER); button.setPadding(dp(context, 12), dp(context, 8), dp(context, 12), dp(context, 8)); button.setFocusable(true);
            buttons[i] = button; LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1); if (i > 0) params.setMarginStart(dp(context, 4)); group.addView(button, params);
            button.setOnClickListener(v -> { selectTabs(buttons, index); change.accept(index); });
        }
        selectTabs(buttons, selected); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.bottomMargin = dp(context, 20); parent.addView(group, params); return group;
    }
    private static void selectTabs(TextView[] buttons, int selected) {
        for (int i = 0; i < buttons.length; i++) {
            TextView button = buttons[i]; boolean active = i == selected;
            android.graphics.drawable.GradientDrawable background = new android.graphics.drawable.GradientDrawable(); background.setCornerRadius(dp(button.getContext(), 9)); background.setColor(active ? attr(button, com.google.android.material.R.attr.colorSurface) : android.graphics.Color.TRANSPARENT); button.setBackground(background);
            button.setTextColor(attr(button, active ? androidx.appcompat.R.attr.colorPrimary : com.google.android.material.R.attr.colorOnSurfaceVariant)); button.setSelected(active);
        }
    }
    static EditText compactInput(LinearLayout parent, String placeholder, String initial, int inputType) {
        Context context = parent.getContext(); androidx.appcompat.widget.AppCompatEditText input = new androidx.appcompat.widget.AppCompatEditText(context);
        input.setInputType(inputType); input.setText(initial); input.setHint(placeholder); input.setContentDescription(placeholder); input.setTextSize(13); input.setSingleLine((inputType & android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE) == 0);
        input.setPadding(dp(context, 13), dp(context, 11), dp(context, 13), dp(context, 11)); input.setMinHeight(dp(context, 46));
        android.graphics.drawable.GradientDrawable box = new android.graphics.drawable.GradientDrawable(); box.setColor(attr(input, com.google.android.material.R.attr.colorSurfaceContainerLowest)); box.setCornerRadius(dp(context, 11)); box.setStroke(dp(context, 1), attr(input, com.google.android.material.R.attr.colorOutline)); input.setBackground(box);
        parent.addView(input, new LinearLayout.LayoutParams(-1, -2)); return input;
    }
    static EditText input(LinearLayout parent, String hint, String initial, int inputType) {
        Context context = parent.getContext();
        LinearLayout field = new LinearLayout(context); field.setOrientation(LinearLayout.VERTICAL); field.setTag("web-input");
        android.graphics.drawable.GradientDrawable box = new android.graphics.drawable.GradientDrawable(); box.setColor(attr(field, com.google.android.material.R.attr.colorSurfaceContainerLowest)); box.setCornerRadius(dp(context, 11)); box.setStroke(dp(context, 1), attr(field, com.google.android.material.R.attr.colorOutline)); field.setBackground(box);
        field.setPadding(dp(context, 13), dp(context, 8), dp(context, 13), dp(context, 7)); field.setMinimumHeight(dp(context, 58));
        TextView title = text(context, hint, 10); title.setTextColor(attr(title, com.google.android.material.R.attr.colorOnSurfaceVariant)); field.addView(title, new LinearLayout.LayoutParams(-1, -2));
        androidx.appcompat.widget.AppCompatEditText input = new androidx.appcompat.widget.AppCompatEditText(context); input.setInputType(inputType); input.setText(initial); input.setTextSize(13); input.setBackground(null); input.setPadding(0, 0, 0, 0); input.setMinHeight(0); input.setMinimumHeight(0); input.setContentDescription(hint);
        input.setSingleLine((inputType & android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE) == 0); field.addView(input, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 8); params.bottomMargin = dp(context, 8); parent.addView(field, params); return input;
    }
    static void fieldVisible(EditText input, boolean visible) {
        android.view.ViewParent parent = input.getParent();
        if (parent instanceof View && "web-input".equals(((View) parent).getTag())) ((View) parent).setVisibility(visible ? View.VISIBLE : View.GONE);
        else input.setVisibility(visible ? View.VISIBLE : View.GONE);
    }
}
