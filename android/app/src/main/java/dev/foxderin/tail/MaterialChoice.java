package dev.foxderin.tail;

import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.android.material.color.MaterialColors;
import com.google.android.material.textfield.MaterialAutoCompleteTextView;
import java.util.function.IntConsumer;

/** Native select with the original WebUI's fixed in-box label and caret. */
final class MaterialChoice extends FrameLayout {
    private final MaterialAutoCompleteTextView choice;
    private final TextView label;
    private final String[] labels;
    private final boolean[] itemEnabled;
    private final ArrayAdapter<String> adapter;
    private int selected;
    MaterialChoice(Context context, String[] labels, int selected, IntConsumer change) {
        super(context); this.labels = labels.clone(); itemEnabled = new boolean[labels.length]; java.util.Arrays.fill(itemEnabled, true);
        android.graphics.drawable.GradientDrawable background = new android.graphics.drawable.GradientDrawable();
        background.setCornerRadius(ControlUi.dp(context, 11)); background.setColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorSurfaceContainerLowest));
        background.setStroke(ControlUi.dp(context, 1), MaterialColors.getColor(this, com.google.android.material.R.attr.colorOutline)); setBackground(background);
        choice = new MaterialAutoCompleteTextView(context); choice.setInputType(0); choice.setKeyListener(null); choice.setTextSize(13); choice.setBackground(null);
        choice.setSingleLine(false); choice.setMaxLines(3); choice.setMinHeight(ControlUi.dp(context, 46));
        choice.setPadding(ControlUi.dp(context, 13), ControlUi.dp(context, 11), ControlUi.dp(context, 36), ControlUi.dp(context, 11));
        adapter = new ArrayAdapter<String>(context, R.layout.material_choice_item, this.labels) {
            @Override public boolean areAllItemsEnabled() { return false; }
            @Override public boolean isEnabled(int position) { return position >= 0 && position < itemEnabled.length && itemEnabled[position]; }
            @Override public View getView(int position, View recycled, ViewGroup parent) { View view = super.getView(position, recycled, parent); view.setEnabled(isEnabled(position)); view.setAlpha(isEnabled(position) ? 1f : .45f); return view; }
            @Override public View getDropDownView(int position, View recycled, ViewGroup parent) { return getView(position, recycled, parent); }
        };
        choice.setAdapter(adapter); addView(choice, new FrameLayout.LayoutParams(-1, -2));
        label = ControlUi.text(context, "", 10); label.setTextColor(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant)); label.setVisibility(GONE);
        FrameLayout.LayoutParams labelParams = new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.START); labelParams.setMarginStart(ControlUi.dp(context, 13)); labelParams.topMargin = ControlUi.dp(context, 8); addView(label, labelParams);
        ImageView caret = new ImageView(context); caret.setImageResource(R.drawable.ic_chevron_right); caret.setRotation(90); caret.setColorFilter(MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant));
        FrameLayout.LayoutParams caretParams = new FrameLayout.LayoutParams(ControlUi.dp(context, 18), ControlUi.dp(context, 18), Gravity.END | Gravity.CENTER_VERTICAL); caretParams.setMarginEnd(ControlUi.dp(context, 11)); addView(caret, caretParams);
        choice.setOnClickListener(v -> { if (isEnabled()) choice.showDropDown(); });
        choice.setOnItemClickListener((parent, view, position, id) -> { if (!isEnabled() || !adapter.isEnabled(position)) { setSelection(this.selected); return; } this.selected = position; change.accept(position); });
        setSelection(selected); setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
    }
    MaterialAutoCompleteTextView getEditText() { return choice; }
    void setHint(CharSequence value) {
        boolean labeled = value != null && value.length() > 0; label.setText(value); label.setVisibility(labeled ? VISIBLE : GONE);
        choice.setMinHeight(ControlUi.dp(getContext(), labeled ? 58 : 46));
        choice.setPadding(ControlUi.dp(getContext(), 13), ControlUi.dp(getContext(), labeled ? 23 : 11), ControlUi.dp(getContext(), 36), ControlUi.dp(getContext(), labeled ? 7 : 11));
        setContentDescription(value);
    }
    int getSelectedItemPosition() { return selected; }
    void setSelection(int position) { setSelection(position, false); }
    void setSelection(int position, boolean animate) {
        selected = labels.length == 0 || position < 0 ? -1 : Math.min(position, labels.length - 1);
        choice.setText(selected < 0 ? getContext().getString(R.string.web_net_unknown) : labels[selected], false);
    }
    void setItemEnabled(int position, boolean enabled) { if (position < 0 || position >= itemEnabled.length) throw new IndexOutOfBoundsException("Choice position " + position); itemEnabled[position] = enabled; adapter.notifyDataSetChanged(); }
    @Override public void setEnabled(boolean enabled) { super.setEnabled(enabled); if (choice != null) { choice.setEnabled(enabled); setAlpha(enabled ? 1f : .55f); } }
    @Override public void setContentDescription(CharSequence description) { super.setContentDescription(description); if (choice != null) choice.setContentDescription(description); }
}
