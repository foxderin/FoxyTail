package dev.foxderin.tail;

import android.content.Context;
import android.view.ContextThemeWrapper;
import android.view.View;
import android.widget.HorizontalScrollView;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;
import org.json.JSONArray;

final class LogsChecks {
    static void run(Context context) throws Exception {
        Context themed = new ContextThemeWrapper(context, R.style.AppTheme);
        int width = ControlUi.dp(themed, 320);
        HorizontalScrollView horizontal = new HorizontalScrollView(themed); horizontal.setFillViewport(true);
        LogsPage.LogList list = new LogsPage.LogList(themed);
        LogsPage.LogAdapter rows = new LogsPage.LogAdapter(themed); list.setAdapter(rows);
        horizontal.addView(list, new HorizontalScrollView.LayoutParams(width, -2));
        JSONArray lines = new JSONArray(); StringBuilder full = new StringBuilder(), matches = new StringBuilder();
        StringBuilder longText = new StringBuilder(); for (int i = 0; i < 12; i++) longText.append("long log text ");
        for (int i = 0; i < 1000; i++) {
            String line = (i % 2 == 0 ? "Alpha " : "alpha ") + i + " " + longText;
            lines.put(line); if (i > 0) full.append('\n'); full.append(line);
            if (i % 2 == 0) { if (matches.length() > 0) matches.append('\n'); matches.append(line); }
        }
        rows.update(lines, "", false, true); layout(horizontal, width);
        require(rows.getItemCount() == 1000 && rows.copied.equals(full.toString()), "Full copy includes every offscreen line");
        require(list.getChildCount() > 0 && list.getChildCount() < 100, "Wrapped log view count is bounded by viewport, not log count");
        View first = list.getChildAt(0);
        LogsPage.LogRow firstRow = (LogsPage.LogRow) list.getChildViewHolder(first);
        require(firstRow.number.getText().toString().equals("1") && firstRow.code.isTextSelectable() && firstRow.code.getLineCount() > 1, "Original numbering, selectable text and wrapped lines survive virtualization");
        final int[] changes = {0};
        rows.registerAdapterDataObserver(new RecyclerView.AdapterDataObserver() { @Override public void onChanged() { changes[0]++; } });
        rows.update(new JSONArray(lines.toString()), "", false, true); layout(horizontal, width);
        require(changes[0] == 0 && list.getChildAt(0) == first, "Unchanged response retains actual row instances without rebinding the tree");
        rows.update(lines, "Alpha", true, true); layout(horizontal, width);
        require(rows.getItemCount() == 500 && rows.copied.equals(matches.toString()), "Case-sensitive filter copies all matching offscreen lines");
        LogsPage.LogRow secondRow = (LogsPage.LogRow) list.findViewHolderForAdapterPosition(1);
        require(secondRow != null && secondRow.number.getText().toString().equals("3"), "Filtered row numbers retain original positions");
        rows.update(lines, "Alpha", false, true); layout(horizontal, width);
        require(rows.getItemCount() == 1000 && rows.copied.equals(full.toString()), "Case toggle restores all matching lines");
        list.followEnd(); layout(horizontal, width);
        LinearLayoutManager manager = (LinearLayoutManager) list.getLayoutManager();
        require(manager.findLastVisibleItemPosition() == 999 && !list.canScrollVertically(1), "Follow reaches the bottom of the last wrapped line");
        View last = manager.findViewByPosition(999); int lastTop = last.getTop();
        rows.update(new JSONArray(lines.toString()), "Alpha", false, true); layout(horizontal, width);
        require(manager.findViewByPosition(999) == last && last.getTop() == lastTop, "Unchanged refresh preserves the current scroll position");
        rows.update(lines, "", false, false); list.getLayoutParams().width = Math.max(width, rows.contentWidth()); list.requestLayout(); layout(horizontal, width);
        manager.scrollToPositionWithOffset(0, 0); layout(horizontal, width);
        firstRow = (LogsPage.LogRow) list.findViewHolderForAdapterPosition(0);
        require(firstRow != null && firstRow.code.getLineCount() == 1 && list.getWidth() > horizontal.getWidth(), "Unwrapped rows retain full text and expose horizontal overflow");
        horizontal.scrollTo(list.getWidth(), 0);
        require(horizontal.getScrollX() > 0, "Unwrapped viewer can scroll to offscreen text");
        rows.update(lines, "", false, true); list.getLayoutParams().width = width; list.requestLayout(); horizontal.scrollTo(0, 0); layout(horizontal, width);
        firstRow = (LogsPage.LogRow) list.findViewHolderForAdapterPosition(0);
        require(firstRow != null && firstRow.code.getLineCount() > 1 && horizontal.getScrollX() == 0, "Wrap transition restores viewport width without losing text");
        rows.update(lines, "no matching record", true, true); layout(horizontal, width);
        require(rows.getItemCount() == 0 && rows.copied.isEmpty() && list.getChildCount() == 0, "No-match filter removes stale visible and copy content");
        JSONArray special = new JSONArray().put("").put("raw\tline\u001b[31m");
        rows.update(special, "", false, true); layout(horizontal, width);
        require(rows.copied.equals("\nraw\tline\u001b[31m"), "Copy keeps raw text, including blank lines and control characters");
        LogsPage.LogRow blank = (LogsPage.LogRow) list.findViewHolderForAdapterPosition(0);
        LogsPage.LogRow control = (LogsPage.LogRow) list.findViewHolderForAdapterPosition(1);
        require(blank != null && blank.code.getText().toString().equals(" ") && control != null && control.code.getText().toString().equals(ToolsData.visibleLog(special.optString(1))), "Visible text preserves existing blank-line and control-character formatting");
        rows.update(null, "", false, true); layout(horizontal, width);
        require(rows.getItemCount() == 0 && rows.copied.isEmpty(), "Source reset clears stale log content");
    }
    private static void layout(View view, int width) {
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        view.layout(0, 0, view.getMeasuredWidth(), view.getMeasuredHeight());
    }
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
