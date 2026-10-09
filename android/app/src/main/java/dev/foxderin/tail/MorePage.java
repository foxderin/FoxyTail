package dev.foxderin.tail;

import android.widget.LinearLayout;

/** WebUI "more" page: grouped entries with icons and entry indicators. */
final class MorePage extends ControlPage {
    MorePage(ControlActivity activity) {
        super(activity);
        LinearLayout services = section(s(R.string.nav_group_services));
        entryRow(services, R.drawable.ic_router, s(R.string.control_tunnel), null, () -> activity.navigate("tunnel"));
        entryRow(services, R.drawable.ic_alt_route, s(R.string.control_routing), null, () -> activity.navigate("routing"));
        entryRow(services, R.drawable.ic_dns, s(R.string.control_serve), null, () -> activity.navigate("serve"));
        entryRow(services, R.drawable.ic_network_check, s(R.string.control_coexist), null, () -> activity.navigate("coexist"));
        entryRow(services, R.drawable.ic_folder, s(R.string.control_files), null, activity::openFiles);
        LinearLayout manage = section(s(R.string.nav_group_manage));
        entryRow(manage, R.drawable.ic_person, s(R.string.control_account), null, () -> activity.navigate("account"));
        entryRow(manage, R.drawable.ic_hub, s(R.string.control_context), null, () -> activity.navigate("context"));
        entryRow(manage, R.drawable.ic_speed, s(R.string.control_trial), null, () -> activity.navigate("trial"));
        entryRow(manage, R.drawable.ic_article, s(R.string.control_logs), null, () -> activity.navigate("logs"));
        entryRow(manage, R.drawable.ic_settings, s(R.string.control_settings), null, () -> activity.navigate("settings"));
        entryRow(manage, R.drawable.ic_bug_report, s(R.string.control_diagnostics), null, () -> activity.navigate("diagnostics"));
        entryRow(manage, R.drawable.ic_backup, s(R.string.control_backup), null, () -> activity.navigate("backup"));
        entryRow(manage, R.drawable.ic_dark_mode, s(R.string.control_appearance), null, activity::appearance);
    }
    @Override String title() { return s(R.string.control_more); }
    @Override void load() { }
}
