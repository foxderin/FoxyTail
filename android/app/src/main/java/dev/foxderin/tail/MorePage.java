package dev.foxderin.tail;

import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.android.material.color.MaterialColors;

/** Original More tool groups, with the same responsive card grid. */
final class MorePage extends ControlPage {
    MorePage(ControlActivity activity) {
        super(activity);
        group(R.string.web_tools_network,
                new String[]{"tunnel", "routing", "serve"},
                new int[]{R.drawable.ic_router, R.drawable.ic_alt_route, R.drawable.ic_dns},
                new int[]{R.string.web_more_tunnel, R.string.web_more_routing, R.string.web_more_serve});
        group(R.string.web_tools_device,
                new String[]{"account", "files"}, new int[]{R.drawable.ic_person, R.drawable.ic_folder},
                new int[]{R.string.web_more_account, R.string.web_more_files});
        group(R.string.web_tools_maintenance,
                new String[]{"logs", "diagnostics", "settings"},
                new int[]{R.drawable.ic_article, R.drawable.ic_bug_report, R.drawable.ic_settings},
                new int[]{R.string.web_more_logs, R.string.web_more_diag, R.string.web_more_settings});
    }
    private void group(int title, String[] destinations, int[] icons, int[] labels) {
        LinearLayout group = new LinearLayout(activity); group.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams groupParams = new LinearLayout.LayoutParams(-1, -2); groupParams.bottomMargin = dp(20);
        content.addView(group, groupParams);
        TextView heading = ControlUi.text(activity, s(title), 15); heading.setPadding(0, 0, 0, dp(17)); heading.setTypeface(null, Typeface.BOLD); group.addView(heading);
        boolean columns = activity.getResources().getConfiguration().screenWidthDp >= 700;
        LinearLayout row = null;
        for (int i = 0; i < destinations.length; i++) {
            if (!columns || i % 2 == 0) {
                row = new LinearLayout(activity); row.setOrientation(LinearLayout.HORIZONTAL); row.setBaselineAligned(false);
                LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(-1, -2); if (i > 0) rowParams.topMargin = dp(10); group.addView(row, rowParams);
            }
            LinearLayout card = new LinearLayout(activity); card.setGravity(Gravity.CENTER_VERTICAL); card.setPadding(dp(16), dp(16), dp(16), dp(16)); card.setMinimumHeight(dp(82));
            GradientDrawable background = new GradientDrawable(); background.setCornerRadius(dp(16));
            background.setColor(MaterialColors.getColor(card, com.google.android.material.R.attr.colorSurfaceContainerLow));
            background.setStroke(dp(1), MaterialColors.getColor(card, com.google.android.material.R.attr.colorOutlineVariant)); card.setBackground(background);
            LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(0, -1, 1); if (columns && i % 2 == 1) cardParams.setMarginStart(dp(10)); row.addView(card, cardParams);
            ImageView icon = new ImageView(activity); icon.setImageResource(icons[i]); icon.setColorFilter(MaterialColors.getColor(icon, androidx.appcompat.R.attr.colorPrimary)); icon.setPadding(dp(11), dp(11), dp(11), dp(11));
            GradientDrawable tile = new GradientDrawable(); tile.setCornerRadius(dp(13)); tile.setColor(MaterialColors.getColor(icon, com.google.android.material.R.attr.colorPrimaryContainer)); icon.setBackground(tile); card.addView(icon, new LinearLayout.LayoutParams(dp(44), dp(44)));
            LinearLayout copy = new LinearLayout(activity); copy.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams copyParams = new LinearLayout.LayoutParams(0, -2, 1); copyParams.setMargins(dp(14), 0, dp(14), 0); card.addView(copy, copyParams);
            TextView name = ControlUi.text(activity, s(labels[i]), 15); name.setTypeface(null, Typeface.BOLD); copy.addView(name);
            ImageView arrow = new ImageView(activity); arrow.setImageResource(R.drawable.ic_chevron_right); arrow.setColorFilter(MaterialColors.getColor(arrow, com.google.android.material.R.attr.colorOnSurfaceVariant)); card.addView(arrow, new LinearLayout.LayoutParams(dp(19), dp(19)));
            String destination = destinations[i]; card.setFocusable(true); card.setOnClickListener(v -> activity.navigate(destination));
            if (columns && i == destinations.length - 1 && i % 2 == 0) { android.view.View space = new android.view.View(activity); LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, 1, 1); p.setMarginStart(dp(10)); row.addView(space, p); }
        }
    }
    @Override String title() { return s(R.string.web_more_title); }
    @Override void load() { }
}
