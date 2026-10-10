package dev.foxderin.tail;

import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.*;
import android.view.ViewGroup;
import com.google.android.material.color.MaterialColors;
import org.json.*;
import java.text.DateFormat;
import java.util.Date;

final class LogsPage extends ControlPage {
    private String source, copied = "", updated = "", failure = "";
    private int limit;
    private boolean live, follow, wrap, matchCase, readingLogs, queued, bindingStatus;
    private JSONArray lines;
    private final EditText query;
    private final LinearLayout output, status;
    private final TextView metadata, updatedText, errorText, empty, refreshDisabled;
    private final ScrollView scroll;
    private final HorizontalScrollView horizontal;
    private final Button refresh, copyButton;
    private final CompoundButton liveToggle;
    LogsPage(ControlActivity activity) {
        super(activity);
        source = activity.drafts.getString("logs.source", "daemon"); limit = activity.drafts.getInt("logs.limit", 200);
        live = activity.drafts.getBoolean("logs.live", true); follow = activity.drafts.getBoolean("logs.follow", true); wrap = activity.drafts.getBoolean("logs.wrap", true); matchCase = activity.drafts.getBoolean("logs.case", false);
        LinearLayout controls = section(); hint(controls, s(R.string.web_tools_logs_scope));
        LinearLayout sourceTabs = new LinearLayout(activity); controls.addView(sourceTabs, new LinearLayout.LayoutParams(-1, -2));
        sourceTabs.setPadding(0, 0, 0, dp(16));
        ControlUi.tabs(sourceTabs, new String[]{s(R.string.web_logs_daemon), s(R.string.web_logs_service)}, source.equals("daemon") ? 0 : 1, index -> {
            if (!isCurrent()) return;
            source = index == 1 ? "service" : "daemon"; activity.drafts.putString("logs.source", source); lines = null; updated = ""; failure = ""; render(); load();
        });
        LinearLayout searchLimit = row(controls), searchBox = new LinearLayout(activity), limitBox = new LinearLayout(activity);
        searchBox.setOrientation(LinearLayout.VERTICAL); limitBox.setOrientation(LinearLayout.VERTICAL);
        searchLimit.addView(searchBox, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout.LayoutParams limitParams = new LinearLayout.LayoutParams(dp(125), -2); limitParams.setMarginStart(dp(12)); searchLimit.addView(limitBox, limitParams);
        query = input(searchBox, s(R.string.web_tools_logs_find), activity.drafts.getString("logs.query", ""), InputType.TYPE_CLASS_TEXT); query.setSingleLine(true);
        ((View) query.getParent()).setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
        android.graphics.drawable.Drawable searchIcon = androidx.appcompat.content.res.AppCompatResources.getDrawable(activity, R.drawable.ic_search);
        if (searchIcon != null) { searchIcon.setTint(color(com.google.android.material.R.attr.colorOnSurfaceVariant)); searchIcon.setBounds(0, 0, dp(20), dp(20)); query.setCompoundDrawablesRelative(searchIcon, null, null, null); query.setCompoundDrawablePadding(dp(12)); }
        ToolsUi.draft(this, query, "logs.query"); ToolsUi.watch(query, this::render);
        String[] limits = {"100", "200", "500", "1000"}; int selected = 1; for (int i = 0; i < limits.length; i++) if (limits[i].equals(String.valueOf(limit))) selected = i;
        MaterialChoice lineLimit = choice(limitBox, limits, selected, index -> { limit = Integer.parseInt(limits[index]); activity.drafts.putInt("logs.limit", limit); load(); }); lineLimit.setHint(s(R.string.web_tools_logs_rows));
        ToolsFlowLayout options = new ToolsFlowLayout(activity, 20, 14); options.setPadding(0, dp(16), 0, 0); controls.addView(options, new LinearLayout.LayoutParams(-1, -2));
        liveToggle = compactToggle(options, s(R.string.web_tools_logs_live), live, value -> { live = value; activity.drafts.putBoolean("logs.live", value); renderStatus(); if (value) load(); });
        compactToggle(options, s(R.string.web_logs_follow), follow, value -> { follow = value; activity.drafts.putBoolean("logs.follow", value); if (value) followEnd(); });
        compactToggle(options, s(R.string.web_tools_logs_wrap), wrap, value -> { wrap = value; activity.drafts.putBoolean("logs.wrap", value); render(); });
        compactToggle(options, s(R.string.web_tools_logs_match_case), matchCase, value -> { matchCase = value; activity.drafts.putBoolean("logs.case", value); render(); });
        ToolsFlowLayout actions = new ToolsFlowLayout(activity, 10, 10); actions.setPadding(0, dp(16), 0, 0); controls.addView(actions, new LinearLayout.LayoutParams(-1, -2));
        status = new LinearLayout(activity); actions.addView(status);
        ToolsFlowLayout buttons = new ToolsFlowLayout(activity, 10, 10); actions.addView(buttons);
        refresh = ControlUi.textButton(activity, s(R.string.web_tools_refresh), () -> { if (isCurrent()) load(); });
        ((com.google.android.material.button.MaterialButton) refresh).setIconResource(R.drawable.ic_refresh); buttons.addView(refresh);
        copyButton = ControlUi.tonalButton(activity, s(R.string.web_tools_logs_copy), R.drawable.ic_content_copy, () -> { if (isCurrent()) copy(s(R.string.web_logs_title), copied); }); buttons.addView(copyButton);
        refreshDisabled = ControlUi.text(activity, s(R.string.web_tools_refresh_disabled), 13); refreshDisabled.setLineHeight(Math.round(refreshDisabled.getTextSize() * 1.65f)); controls.addView(refreshDisabled, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout viewer = section();
        ToolsFlowLayout meta = new ToolsFlowLayout(activity, 8, 8); viewer.addView(meta, new LinearLayout.LayoutParams(-1, -2));
        metadata = ControlUi.text(activity, "", 11); metadata.setTextColor(color(com.google.android.material.R.attr.colorOnSurfaceVariant)); meta.addView(metadata);
        updatedText = ControlUi.text(activity, "", 11); updatedText.setTextColor(color(com.google.android.material.R.attr.colorOnSurfaceVariant)); meta.addView(updatedText);
        errorText = ControlUi.text(activity, "", 13); errorText.setTextColor(color(androidx.appcompat.R.attr.colorError)); errorText.setPadding(0, dp(16), 0, dp(16)); errorText.setVisibility(View.GONE); viewer.addView(errorText);
        empty = ControlUi.text(activity, "", 13); empty.setGravity(Gravity.CENTER); empty.setPadding(dp(14), dp(24), dp(14), dp(24)); viewer.addView(empty, new LinearLayout.LayoutParams(-1, -2));
        scroll = new ScrollView(activity) {
            @Override protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
                int cap = Math.max(dp(240), (int) (getResources().getDisplayMetrics().heightPixels * .62f));
                super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(cap, MeasureSpec.AT_MOST));
            }
        };
        scroll.setMinimumHeight(dp(240)); scroll.setFillViewport(true); scroll.setFocusable(true); scroll.setNestedScrollingEnabled(true);
        GradientDrawable background = new GradientDrawable(); background.setColor(color(com.google.android.material.R.attr.colorSurfaceContainer)); background.setCornerRadius(dp(12)); background.setStroke(dp(1), color(com.google.android.material.R.attr.colorOutlineVariant)); scroll.setBackground(background); scroll.setClipToOutline(true);
        horizontal = new HorizontalScrollView(activity); horizontal.setFillViewport(true); scroll.addView(horizontal, new ScrollView.LayoutParams(-1, -2));
        output = new LinearLayout(activity); output.setOrientation(LinearLayout.VERTICAL); output.setPadding(0, dp(12), 0, dp(12)); horizontal.addView(output, new HorizontalScrollView.LayoutParams(-1, -2));
        LinearLayout.LayoutParams scrollParams = new LinearLayout.LayoutParams(-1, -2); scrollParams.topMargin = dp(16); viewer.addView(scroll, scrollParams);
        horizontal.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> { if (wrap && right - left != oldRight - oldLeft) render(false); });
        render(); activity.addStatusListener(snapshot -> { if (isCurrent()) renderStatus(); }); repeat(() -> { renderStatus(); if (live && !readingLogs) load(); }, 5000);
    }
    String title() { return s(R.string.web_logs_title); }
    private CompoundButton compactToggle(ToolsFlowLayout parent, String label, boolean checked, java.util.function.Consumer<Boolean> change) {
        LinearLayout option = new LinearLayout(activity); option.setGravity(Gravity.CENTER_VERTICAL);
        parent.addView(option);
        CompoundButton toggle = ControlUi.switchView(activity, checked, value -> { if (isCurrent() && !bindingStatus) change.accept(value); }); toggle.setContentDescription(label); option.addView(toggle, new LinearLayout.LayoutParams(dp(52), dp(48)));
        TextView text = ControlUi.text(activity, label, 12); text.setTextColor(color(com.google.android.material.R.attr.colorOnSurfaceVariant));
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(-2, -2); labelParams.setMarginStart(dp(9)); option.addView(text, labelParams); text.setOnClickListener(view -> toggle.performClick()); return toggle;
    }
    private void renderStatus() {
        if (status == null) return;
        boolean enabled = activity.autoRefresh(); boolean refreshing = live && enabled;
        bindingStatus = true; liveToggle.setEnabled(enabled); liveToggle.setChecked(refreshing); bindingStatus = false;
        status.removeAllViews(); badge(status, s(refreshing ? R.string.web_tools_logs_live : R.string.web_tools_logs_paused), refreshing ? ControlUi.TONE_OK : ControlUi.TONE_NEUTRAL);
        refreshDisabled.setVisibility(enabled ? View.GONE : View.VISIBLE);
    }
    void onPause() { readingLogs = false; queued = false; }
    void load() {
        if (readingLogs) { queued = true; return; }
        readingLogs = true; refresh.setEnabled(false); refresh.setText(s(R.string.web_loading));
        String requestedSource = source; int requestedLimit = limit;
        read(result -> {
            if (source.equals(requestedSource) && limit == requestedLimit) {
                JSONArray current = result.optJSONArray("lines");
                if (current == null) { failure = s(R.string.tools_invalid_response); render(false); }
                else {
                    boolean changed = lines == null || !lines.toString().equals(current.toString());
                    lines = current; failure = ""; updated = DateFormat.getTimeInstance().format(new Date()); render(changed);
                }
            }
            finishRead();
        }, error -> { if (source.equals(requestedSource) && limit == requestedLimit) { failure = RootApi.message(error); render(false); } finishRead(); }, "logs", requestedSource, String.valueOf(requestedLimit));
    }
    private void finishRead() {
        readingLogs = false; refresh.setEnabled(true); refresh.setText(s(R.string.web_tools_refresh));
        if (queued) { queued = false; content.post(() -> { if (isCurrent()) load(); }); }
    }
    private void render() { render(true); }
    private void render(boolean changed) {
        if (output == null || query == null) return;
        StringBuilder copy = new StringBuilder(); int count = 0; String needle = query.getText().toString(); output.removeAllViews();
        int width = horizontal.getWidth() > 0 ? horizontal.getWidth() : activity.getResources().getDisplayMetrics().widthPixels - dp(72);
        output.getLayoutParams().width = wrap ? width : -2;
        if (lines != null) for (int i = 0; i < lines.length(); i++) {
            String line = lines.optString(i); if (!ToolsData.matches(line, needle, matchCase)) continue;
            if (count++ > 0) copy.append('\n'); copy.append(line);
            LinearLayout row = new LinearLayout(activity); row.setPadding(0, 0, dp(14), 0);
            TextView number = logText(String.valueOf(i + 1)); number.setGravity(Gravity.END); number.setTextColor(color(com.google.android.material.R.attr.colorOnSurfaceVariant)); number.setAlpha(.5f); number.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); row.addView(number, new LinearLayout.LayoutParams(dp(42), -2));
            TextView code = logText(line.isEmpty() ? " " : ToolsData.visibleLog(line)); code.setTextIsSelectable(true); code.setHorizontallyScrolling(!wrap);
            LinearLayout.LayoutParams codeParams = new LinearLayout.LayoutParams(wrap ? 0 : -2, -2, wrap ? 1 : 0); codeParams.setMarginStart(dp(12)); row.addView(code, codeParams); output.addView(row, new LinearLayout.LayoutParams(wrap ? -1 : -2, -2));
        }
        copied = copy.toString(); copyButton.setEnabled(count > 0); horizontal.setHorizontalScrollBarEnabled(!wrap); if (wrap) horizontal.scrollTo(0, 0);
        scroll.setVisibility(count > 0 ? View.VISIBLE : View.GONE); scroll.setContentDescription(s(source.equals("daemon") ? R.string.web_logs_daemon : R.string.web_logs_service));
        empty.setVisibility(count == 0 && failure.isEmpty() ? View.VISIBLE : View.GONE); empty.setText(s(lines == null ? R.string.web_loading : needle.isEmpty() ? R.string.web_logs_empty : R.string.web_tools_logs_no_match));
        metadata.setText(s(R.string.web_tools_logs_count) + " · " + count + " / " + (lines == null ? "—" : lines.length()));
        updatedText.setText(s(R.string.web_tools_logs_updated) + " " + updated); updatedText.setVisibility(updated.isEmpty() ? View.GONE : View.VISIBLE);
        errorText.setText(failure); errorText.setVisibility(failure.isEmpty() ? View.GONE : View.VISIBLE); renderStatus();
        if (follow && changed && count > 0) followEnd();
    }
    private TextView logText(String value) { TextView text = ControlUi.text(activity, value, 11); text.setTypeface(Typeface.MONOSPACE); text.setLineHeight(Math.round(text.getTextSize() * 1.9f)); text.setIncludeFontPadding(false); return text; }
    private int color(int attr) { return MaterialColors.getColor(content, attr); }
    private void followEnd() { if (scroll != null) scroll.post(() -> { if (isCurrent()) scroll.fullScroll(View.FOCUS_DOWN); }); }
}

final class ToolsFlowLayout extends ViewGroup {
    private final int columnGap, rowGap;
    ToolsFlowLayout(android.content.Context context, int columnGapDp, int rowGapDp) {
        super(context); columnGap = ControlUi.dp(context, columnGapDp); rowGap = ControlUi.dp(context, rowGapDp);
    }
    @Override protected LayoutParams generateDefaultLayoutParams() { return new MarginLayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT); }
    @Override public LayoutParams generateLayoutParams(android.util.AttributeSet attrs) { return new MarginLayoutParams(getContext(), attrs); }
    @Override protected LayoutParams generateLayoutParams(LayoutParams source) { return source instanceof MarginLayoutParams ? new MarginLayoutParams((MarginLayoutParams) source) : new MarginLayoutParams(source); }
    @Override protected boolean checkLayoutParams(LayoutParams params) { return params instanceof MarginLayoutParams; }
    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        int maxWidth = MeasureSpec.getMode(widthSpec) == MeasureSpec.UNSPECIFIED ? Integer.MAX_VALUE : Math.max(0, MeasureSpec.getSize(widthSpec) - getPaddingLeft() - getPaddingRight());
        int used = 0, rowHeight = 0, totalHeight = 0, widest = 0, state = 0;
        for (int i = 0; i < getChildCount(); i++) {
            View child = getChildAt(i); if (child.getVisibility() == GONE) continue;
            MarginLayoutParams params = (MarginLayoutParams) child.getLayoutParams(); params.resolveLayoutDirection(getLayoutDirection()); measureChildWithMargins(child, widthSpec, 0, heightSpec, 0);
            int width = child.getMeasuredWidth() + params.leftMargin + params.rightMargin, height = child.getMeasuredHeight() + params.topMargin + params.bottomMargin;
            if (used > 0 && (long) used + columnGap + width > maxWidth) { widest = Math.max(widest, used); totalHeight += rowHeight + rowGap; used = 0; rowHeight = 0; }
            if (used > 0) used += columnGap; used += width; rowHeight = Math.max(rowHeight, height); state = combineMeasuredStates(state, child.getMeasuredState());
        }
        widest = Math.max(widest, used); totalHeight += rowHeight;
        setMeasuredDimension(resolveSizeAndState(Math.max(getSuggestedMinimumWidth(), widest + getPaddingLeft() + getPaddingRight()), widthSpec, state), resolveSizeAndState(Math.max(getSuggestedMinimumHeight(), totalHeight + getPaddingTop() + getPaddingBottom()), heightSpec, state << MEASURED_HEIGHT_STATE_SHIFT));
    }
    @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        int available = Math.max(0, right - left - getPaddingLeft() - getPaddingRight()), y = getPaddingTop(), first = 0;
        boolean rtl = getLayoutDirection() == LAYOUT_DIRECTION_RTL;
        while (first < getChildCount()) {
            int used = 0, height = 0, end = first;
            for (; end < getChildCount(); end++) {
                View child = getChildAt(end); if (child.getVisibility() == GONE) continue;
                MarginLayoutParams params = (MarginLayoutParams) child.getLayoutParams();
                int width = child.getMeasuredWidth() + params.leftMargin + params.rightMargin;
                if (used > 0 && used + columnGap + width > available) break;
                if (used > 0) used += columnGap; used += width; height = Math.max(height, child.getMeasuredHeight() + params.topMargin + params.bottomMargin);
            }
            int x = rtl ? right - left - getPaddingRight() : getPaddingLeft();
            for (int i = first; i < end; i++) {
                View child = getChildAt(i); if (child.getVisibility() == GONE) continue;
                MarginLayoutParams params = (MarginLayoutParams) child.getLayoutParams();
                int childY = y + params.topMargin + (height - child.getMeasuredHeight() - params.topMargin - params.bottomMargin) / 2;
                int childX = rtl ? x - params.rightMargin - child.getMeasuredWidth() : x + params.leftMargin;
                child.layout(childX, childY, childX + child.getMeasuredWidth(), childY + child.getMeasuredHeight());
                int advance = child.getMeasuredWidth() + params.leftMargin + params.rightMargin + columnGap; x += rtl ? -advance : advance;
            }
            y += height + rowGap; first = end;
        }
    }
}
