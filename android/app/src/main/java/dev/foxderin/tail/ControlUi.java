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
        MaterialButton button = new MaterialButton(context, null, com.google.android.material.R.attr.materialButtonOutlinedStyle);
        button.setText(text); button.setAllCaps(false); button.setMinHeight(dp(context, 48));
        button.setMaxLines(3); button.setOnClickListener(v -> action.run());
        return button;
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
        card.setRadius(dp(context, 20)); card.setCardElevation(0); card.setStrokeWidth(0);
        card.setCardBackgroundColor(MaterialColors.getColor(card, com.google.android.material.R.attr.colorSurfaceContainerLow));
        LinearLayout box = new LinearLayout(context); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(context, 16), dp(context, 12), dp(context, 16), dp(context, 16));
        card.addView(box, new android.widget.FrameLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(context, 6); params.bottomMargin = dp(context, 6);
        parent.addView(card, params);
        if (heading != null && !heading.isEmpty()) {
            TextView title = text(context, heading, 20); title.setTypeface(null, android.graphics.Typeface.BOLD);
            if (android.os.Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
            box.addView(title, new LinearLayout.LayoutParams(-1, -2));
        }
        return box;
    }
}
