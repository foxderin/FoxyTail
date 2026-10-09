package dev.foxderin.tail;

import android.content.Context;
import android.widget.ArrayAdapter;
import android.widget.LinearLayout;
import com.google.android.material.textfield.MaterialAutoCompleteTextView;
import com.google.android.material.textfield.TextInputLayout;
import java.util.function.IntConsumer;

final class MaterialChoice extends TextInputLayout {
    private final MaterialAutoCompleteTextView choice;
    private final String[] labels;
    private int selected;
    MaterialChoice(Context context, String[] labels, int selected, IntConsumer change) {
        super(context, null, com.google.android.material.R.attr.textInputOutlinedExposedDropdownMenuStyle);
        this.labels = labels.clone();
        setBoxBackgroundMode(BOX_BACKGROUND_OUTLINE); setEndIconMode(END_ICON_DROPDOWN_MENU);
        choice = new MaterialAutoCompleteTextView(getContext()); choice.setInputType(0); choice.setKeyListener(null);
        choice.setMinHeight(ControlUi.dp(context, 56)); choice.setSingleLine(false); choice.setMaxLines(3);
        choice.setAdapter(new ArrayAdapter<>(context, R.layout.material_choice_item, this.labels));
        addView(choice, new LinearLayout.LayoutParams(-1, -2));
        setSelection(selected);
        choice.setOnItemClickListener((parent, view, position, id) -> { this.selected = position; change.accept(position); });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = ControlUi.dp(context, 8); params.bottomMargin = ControlUi.dp(context, 8); setLayoutParams(params);
    }
    int getSelectedItemPosition() { return selected; }
    void setSelection(int position) { setSelection(position, false); }
    void setSelection(int position, boolean animate) {
        selected = labels.length == 0 ? -1 : Math.max(0, Math.min(position, labels.length - 1));
        choice.setText(selected < 0 ? "" : labels[selected], false);
    }
    @Override public void setEnabled(boolean enabled) { super.setEnabled(enabled); if (choice != null) choice.setEnabled(enabled); }
    @Override public void setContentDescription(CharSequence description) { super.setContentDescription(description); if (choice != null) choice.setContentDescription(description); }
}
