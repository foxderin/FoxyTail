package dev.foxderin.tail;

import androidx.appcompat.app.AlertDialog;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import android.text.Editable;
import android.text.TextWatcher;
import android.text.InputType;
import android.widget.EditText;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.view.Gravity;
import android.view.View;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

final class PeersPage extends ControlPage {
    private final LinearLayout inventory, filters;
    private final TextView state, onlineCount, resultCount;
    private final EditText search;
    private List<JSONObject> peers;
    private int filter, tab;
    private boolean reading, fresh;
    private String self = "", exitId = "";
    private String identity;
    private AlertDialog detail;
    private final List<android.widget.Button> pingButtons = new ArrayList<>();

    PeersPage(ControlActivity activity) {
        super(activity);
        boolean compact = activity.getResources().getConfiguration().screenWidthDp <= 700;
        LinearLayout summary = row(content); summary.setGravity(Gravity.CENTER_VERTICAL); ((LinearLayout.LayoutParams) summary.getLayoutParams()).bottomMargin = dp(20);
        state = ControlUi.text(activity, "—", compact ? 31 : 36); state.setTypeface(null, android.graphics.Typeface.BOLD); state.setLineHeight(Math.round(state.getTextSize())); summary.addView(state);
        TextView totalLabel = ControlUi.muted(activity, s(R.string.web_net_peer_total), R.dimen.ft_caption); LinearLayout.LayoutParams totalParams = new LinearLayout.LayoutParams(-2, -2); totalParams.setMarginStart(dp(compact ? 6 : 9)); totalParams.gravity = Gravity.BOTTOM; totalParams.bottomMargin = dp(5); summary.addView(totalLabel, totalParams);
        onlineCount = ControlUi.muted(activity, "", R.dimen.ft_caption); onlineCount.setTextSize(compact ? 10 : 12); LinearLayout.LayoutParams onlineParams = new LinearLayout.LayoutParams(0, -2, 1); onlineParams.setMarginStart(dp(compact ? 13 : 24)); summary.addView(onlineCount, onlineParams);
        summary.addView(ControlUi.button(activity, s(R.string.web_net_refresh), R.drawable.ic_refresh, () -> { if (isCurrent()) refresh(); }));
        LinearLayout toolbar = section(); ((LinearLayout) toolbar.getParent()).setPadding(dp(compact ? 16 : 20), dp(compact ? 16 : 20), dp(compact ? 16 : 20), dp(compact ? 16 : 20));
        LinearLayout top = row(toolbar); top.setOrientation(compact ? LinearLayout.VERTICAL : LinearLayout.HORIZONTAL); top.setGravity(Gravity.CENTER_VERTICAL); ((LinearLayout.LayoutParams) top.getLayoutParams()).bottomMargin = dp(15);
        search = ControlUi.compactInput(top, s(R.string.web_net_peers_search), activity.drafts.getString("network.peerSearch", ""), InputType.TYPE_CLASS_TEXT);
        android.graphics.drawable.Drawable searchIcon = androidx.appcompat.content.res.AppCompatResources.getDrawable(activity, R.drawable.ic_search); if (searchIcon != null) { searchIcon.setTint(com.google.android.material.color.MaterialColors.getColor(search, com.google.android.material.R.attr.colorOnSurfaceVariant)); searchIcon.setBounds(0, 0, dp(20), dp(20)); search.setCompoundDrawablesRelative(searchIcon, null, null, null); search.setCompoundDrawablePadding(dp(12)); }
        search.setLayoutParams(new LinearLayout.LayoutParams(compact ? -1 : 0, -2, compact ? 0 : 1));
        filter = activity.drafts.getInt("network.peerFilter", 0); tab = activity.drafts.getInt("network.peerTab", 0);
        LinearLayout tabs = ControlUi.tabs(top, new String[]{s(R.string.web_peers_list), s(R.string.web_peers_topology)}, tab,
                selected -> { tab = selected; activity.drafts.putInt("network.peerTab", tab); render(); });
        LinearLayout.LayoutParams tabParams = new LinearLayout.LayoutParams(compact ? -1 : dp(210), -2); if (compact) tabParams.topMargin = dp(12); else tabParams.setMarginStart(dp(16)); tabs.setLayoutParams(tabParams);
        int[] icons = {R.drawable.ic_group, R.drawable.ic_router};
        for (int i = 0; i < tabs.getChildCount(); i++) { TextView item = (TextView) tabs.getChildAt(i); android.graphics.drawable.Drawable icon = androidx.appcompat.content.res.AppCompatResources.getDrawable(activity, icons[i]); if (icon != null) { icon.setTint(com.google.android.material.color.MaterialColors.getColor(item, com.google.android.material.R.attr.colorOnSurfaceVariant)); icon.setBounds(0, 0, dp(18), dp(18)); item.setCompoundDrawablesRelative(icon, null, null, null); item.setCompoundDrawablePadding(dp(6)); } }
        LinearLayout filterRow = row(toolbar); filterRow.setGravity(Gravity.CENTER_VERTICAL); ((LinearLayout.LayoutParams) filterRow.getLayoutParams()).bottomMargin = dp(14);
        filters = new LinearLayout(activity); filters.setOrientation(LinearLayout.VERTICAL); filterRow.addView(filters, new LinearLayout.LayoutParams(0, -2, 1)); renderFilters();
        resultCount = ControlUi.muted(activity, "", R.dimen.ft_caption); LinearLayout.LayoutParams countParams = new LinearLayout.LayoutParams(-2, -2); countParams.setMarginStart(dp(12)); filterRow.addView(resultCount, countParams);
        inventory = row(toolbar); inventory.setOrientation(LinearLayout.VERTICAL);
        search.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence value, int start, int count, int after) { }
            public void onTextChanged(CharSequence value, int start, int before, int count) {
                activity.drafts.putString("network.peerSearch", value.toString()); render();
            }
            public void afterTextChanged(Editable value) { }
        });
        repeat(this::refresh, 15000);
    }
    @Override String title() { return s(R.string.web_peers_title); }
    @Override void load() {
        refresh();
    }
    private void refresh() {
        if (reading || detail != null && detail.isShowing()) return;
        reading = true;
        read(status -> {
            String observedIdentity = ExitNodesPage.identityOf(status);
            if (identity != null && !identity.equals(observedIdentity)) { peers = null; fresh = false; render(); }
            identity = observedIdentity;
            JSONObject own = status.optJSONObject("self");
            self = own == null ? s(R.string.network_unknown) : own.optString("hostname", s(R.string.network_unknown));
            JSONObject exit = status.optJSONObject("exitNode"); exitId = exit == null ? "" : exit.optString("id");
            read(result -> {
                reading = false;
                try {
                    List<JSONObject> loaded = decodePeers(result);
                    peers = loaded; fresh = true;
                    int online = 0; for (JSONObject peer : peers) if (peer.optBoolean("online")) online++;
                    state.setText(Integer.toString(peers.size())); onlineCount.setText("● " + online + " " + s(R.string.web_net_filter_online) + "   ● " + (peers.size() - online) + " " + s(R.string.web_net_filter_offline));
                    if (detail != null) detail.dismiss();
                    render();
                } catch (Exception invalid) { fail(invalid); }
            }, failure -> { reading = false; fail(failure); }, "peers");
        }, failure -> { reading = false; fail(failure); }, "status");
    }
    private void fail(Exception failure) {
        fresh = false; state.setText("—"); onlineCount.setText(s(R.string.web_net_status_stale));
        if (peers == null) { inventory.removeAllViews(); hint(inventory, s(R.string.web_net_unknown_hint)); textButton(inventory, s(R.string.web_retry), this::refresh); }
        for (android.widget.Button button : pingButtons) button.setEnabled(false);
        error(failure);
    }
    private void renderFilters() {
        filters.removeAllViews();
        ControlUi.chips(filters, new String[]{s(R.string.web_net_filter_all), s(R.string.web_net_filter_online), s(R.string.web_net_filter_offline)}, filter,
                selected -> { filter = selected; activity.drafts.putInt("network.peerFilter", selected); render(); });
        filters.getChildAt(0).setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
    }
    private void render() {
        inventory.removeAllViews();
        if (peers == null) { ControlUi.skeleton(inventory, 1f, 80); return; }
        String query = search.getText().toString().trim().toLowerCase(Locale.ROOT);
        List<JSONObject> visible = new ArrayList<>();
        for (JSONObject peer : peers) {
            if (filter == 1 && !peer.optBoolean("online") || filter == 2 && peer.optBoolean("online")) continue;
            String text = peer.optString("hostname") + " " + peer.optString("os") + " " + String.join(" ", addresses(peer));
            if (text.toLowerCase(Locale.ROOT).contains(query)) visible.add(peer);
        }
        visible.sort(Comparator.<JSONObject>comparingInt(peer -> peer.optBoolean("online") ? 0 : 1)
                .thenComparing(peer -> peer.optString("hostname"), String.CASE_INSENSITIVE_ORDER));
        resultCount.setText(visible.size() + " " + s(R.string.web_net_result_count));
        if (peers.isEmpty()) { hint(inventory, s(R.string.web_peers_empty)); return; }
        if (visible.isEmpty()) {
            label(inventory, s(R.string.web_net_no_results)); hint(inventory, s(R.string.web_net_no_results_hint));
            textButton(inventory, s(R.string.web_net_reset_filter), () -> { filter = 0; activity.drafts.putInt("network.peerFilter", 0); renderFilters(); search.setText(""); render(); });
            return;
        }
        if (tab == 1) {
            hint(inventory, s(R.string.web_net_topology_hint));
            inventory.addView(new PeerTopologyView(activity, self, exitId, visible, this::showDetail));
        } else for (JSONObject peer : visible) {
            ControlUi.divider(inventory);
            LinearLayout card = row(inventory); card.setOrientation(LinearLayout.VERTICAL); card.setPadding(0, dp(17), 0, dp(11));
            LinearLayout head = row(card); head.setGravity(Gravity.CENTER_VERTICAL); head.setMinimumHeight(dp(48));
            ImageView icon = ControlUi.iconTile(activity, osIcon(peer.optString("os")), 44);
            icon.setColorFilter(com.google.android.material.color.MaterialColors.getColor(icon, com.google.android.material.R.attr.colorOnSurfaceVariant));
            LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(44), dp(44)); iconParams.setMarginEnd(dp(10)); head.addView(icon, iconParams);
            LinearLayout identityRow = new LinearLayout(activity); identityRow.setOrientation(LinearLayout.VERTICAL);
            TextView name = ControlUi.textRes(activity, peer.optString("hostname"), R.dimen.ft_body); name.setTextSize(14); name.setTypeface(null, android.graphics.Typeface.BOLD);
            identityRow.addView(name);
            String os = peer.optString("os", ""), relay = peer.optString("relay", "");
            String metadata = (os.isEmpty() ? s(R.string.web_net_unknown) : os) +
                    (relay.isEmpty() || "-".equals(relay) ? "" : " · " + s(R.string.web_net_relay_region) + " " + relay.toUpperCase(Locale.ROOT));
            ToolsFlowLayout metadataRow = new ToolsFlowLayout(activity, 5, 5); LinearLayout.LayoutParams metadataParams = new LinearLayout.LayoutParams(-1, -2); metadataParams.topMargin = dp(6); identityRow.addView(metadataRow, metadataParams);
            TextView sub = ControlUi.muted(activity, metadata, R.dimen.ft_caption); sub.setTextSize(11); metadataRow.addView(sub);
            if (peer.optBoolean("exitNodeOption")) metadataRow.addView(ControlUi.badge(activity, s(R.string.web_exit_title), ControlUi.BADGE_NEUTRAL));
            head.addView(identityRow, new LinearLayout.LayoutParams(0, -2, 1));
            TextView online = ControlUi.muted(activity, "● " + s(peer.optBoolean("online") ? R.string.web_net_filter_online : R.string.web_net_filter_offline), R.dimen.ft_caption); online.setTextSize(11);
            if (peer.optBoolean("online")) online.setTextColor(androidx.core.content.ContextCompat.getColor(activity, R.color.foxy_ok));
            head.addView(online); head.setOnClickListener(view -> { if (isCurrent()) showDetail(peer); }); head.setFocusable(true);
            head.setContentDescription(s(R.string.web_net_peer_details) + ": " + peer.optString("hostname"));
            LinearLayout bottom = row(card); bottom.setGravity(Gravity.CENTER_VERTICAL); bottom.setPadding(dp(activity.getResources().getConfiguration().screenWidthDp <= 700 ? 0 : 56), dp(3), 0, 0);
            LinearLayout addresses = new LinearLayout(activity); addresses.setOrientation(LinearLayout.VERTICAL); bottom.addView(addresses, new LinearLayout.LayoutParams(0, -2, 1));
            List<String> ips = addresses(peer);
            if (ips.isEmpty()) hint(addresses, s(R.string.web_net_address_pending));
            for (String ip : ips) {
                com.google.android.material.button.MaterialButton copy = ControlUi.textButton(activity, ip, () -> copy(s(R.string.web_net_copy_address), ip));
                int muted = com.google.android.material.color.MaterialColors.getColor(copy, com.google.android.material.R.attr.colorOnSurfaceVariant);
                copy.setIconResource(R.drawable.ic_content_copy); copy.setIconSize(dp(15)); copy.setIconGravity(com.google.android.material.button.MaterialButton.ICON_GRAVITY_TEXT_END); copy.setIconPadding(dp(8)); copy.setIconTint(android.content.res.ColorStateList.valueOf(muted)); copy.setTextColor(muted);
                copy.setTypeface(android.graphics.Typeface.MONOSPACE); copy.setTextSize(activity.getResources().getConfiguration().screenWidthDp <= 700 ? 11 : 12); copy.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); copy.setPadding(0, 0, 0, 0);
                copy.setContentDescription(s(R.string.web_net_copy_address) + ": " + ip); addresses.addView(copy, new LinearLayout.LayoutParams(-1, -2));
            }
            TextView traffic = ControlUi.muted(activity, "↓ " + byteLabel(peer, "rxBytes") + "   ↑ " + byteLabel(peer, "txBytes"), R.dimen.ft_caption); traffic.setTextSize(10);
            bottom.addView(traffic, new LinearLayout.LayoutParams(-2, -2));
            bottom.addView(ControlUi.iconButton(activity, R.drawable.ic_chevron_right, s(R.string.web_net_peer_details) + ": " + peer.optString("hostname"), () -> { if (isCurrent()) showDetail(peer); }), new LinearLayout.LayoutParams(dp(44), dp(44)));
        }
    }
    private String byteLabel(JSONObject peer, String field) {
        Object value = peer.opt(field);
        return value instanceof Number && ((Number) value).longValue() >= 0
                ? Models.bytes(activity, ((Number) value).longValue()) : "—";
    }
    /* Same OS → icon mapping as the WebUI OsIcon component. */
    static int osIcon(String os) {
        String name = os == null ? "" : os.trim().toLowerCase(Locale.ROOT);
        if (name.contains("android")) return R.drawable.ic_android;
        if (name.contains("windows")) return R.drawable.ic_desktop_windows;
        if (name.contains("ios") || name.contains("ipados") || name.contains("iphone") || name.contains("ipad")) return R.drawable.ic_mobile_2;
        if (name.contains("mac") || name.contains("darwin")) return R.drawable.ic_laptop_mac;
        if (name.contains("linux") || name.contains("bsd")) return R.drawable.ic_terminal;
        return R.drawable.ic_devices;
    }
    private void showDetail(JSONObject peer) {
        if (detail != null) detail.dismiss();
        pingButtons.clear();
        LinearLayout body = new LinearLayout(activity); body.setOrientation(LinearLayout.VERTICAL); body.setPadding(dp(20), dp(8), dp(20), dp(8));
        LinearLayout heading = row(body); heading.setGravity(Gravity.CENTER_VERTICAL);
        ImageView os = new ImageView(activity); os.setImageResource(osIcon(peer.optString("os"))); os.setPadding(dp(10), dp(10), dp(10), dp(10));
        heading.addView(os, new LinearLayout.LayoutParams(dp(44), dp(44)));
        LinearLayout identity = new LinearLayout(activity); identity.setOrientation(LinearLayout.VERTICAL); heading.addView(identity, new LinearLayout.LayoutParams(0, -2, 1));
        label(identity, peer.optString("hostname"));
        hint(identity, "● " + s(peer.optBoolean("online") ? R.string.web_net_filter_online : R.string.web_net_filter_offline));
        if (addresses(peer).isEmpty()) hint(body, s(R.string.web_net_address_pending));
        for (String ip : addresses(peer)) {
            ControlUi.insetRow(body, ip, R.drawable.ic_content_copy, () -> copy(s(R.string.web_net_copy_address), ip));
            TextView resultView = label(body, ""); resultView.setVisibility(View.GONE);
            android.widget.Button ping = button(body, s(R.string.web_net_peer_probe) + (ip.contains(":") ? " IPv6" : " IPv4"), () -> {
                if (!fresh) return;
                probe(s(R.string.web_net_peer_probe), result -> {
                    resultView.setVisibility(View.VISIBLE);
                    if (validProbe(result, peer.optString("id"), ip)) {
                        String path = result.optString("path");
                        String pathText = "direct".equals(path) ? s(R.string.web_net_peer_direct) : "derp".equals(path) ? "DERP" : "peer-relay".equals(path) ? s(R.string.web_net_peer_relay) : s(R.string.web_net_unknown);
                        resultView.setText(pathText + " · " + result.opt("latencyMs") + " ms " + result.optString("via"));
                    } else resultView.setText(result.optString("error", s(R.string.web_net_peer_probe_invalid)));
                }, "peer-ping", peer.optString("id"), ip);
            });
            ping.setEnabled(fresh); pingButtons.add(ping);
        }
        hint(body, s(R.string.web_net_peer_probe_hint));
        ControlUi.infoRow(body, s(R.string.web_net_os), OverviewPage.textOrDash(peer, "os"), false);
        ControlUi.infoRow(body, s(R.string.web_net_relay_region), OverviewPage.textOrDash(peer, "relay"), false);
        ControlUi.infoRow(body, s(R.string.web_peers_rx), byteLabel(peer, "rxBytes"), false);
        ControlUi.infoRow(body, s(R.string.web_peers_tx), byteLabel(peer, "txBytes"), false);
        ControlUi.infoRow(body, s(R.string.web_exit_title), s(peer.optBoolean("exitNodeOption") ? R.string.web_net_enabled : R.string.web_net_disabled), false);
        ScrollView scroll = new ScrollView(activity); scroll.addView(body);
        detail = new MaterialAlertDialogBuilder(activity).setTitle(s(R.string.web_peers_detail))
                .setView(scroll).setPositiveButton(s(R.string.web_close), null).create(); detail.show();
    }
    @Override void onClose() { if (detail != null) detail.dismiss(); }
    @Override void onPause() { reading = false; fresh = false; if (detail != null) detail.dismiss(); }

    static List<JSONObject> decodePeers(JSONObject result) throws org.json.JSONException {
        JSONArray array = result.getJSONArray("peers");
        if (array.length() > 10000) throw new org.json.JSONException("Too many peers");
        List<JSONObject> peers = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject peer = array.getJSONObject(i);
            if (!(peer.opt("id") instanceof String) || peer.getString("id").isEmpty() ||
                    !(peer.opt("hostname") instanceof String) || !(peer.opt("online") instanceof Boolean))
                throw new org.json.JSONException("Invalid peer identity or online state");
            peers.add(peer);
        }
        return peers;
    }
    static List<String> addresses(JSONObject peer) {
        ArrayList<String> ips = new ArrayList<>();
        JSONArray array = peer.optJSONArray("ips");
        if (array == null) array = new JSONArray().put(peer.optString("ip", ""));
        for (int i = 0; i < array.length(); i++) {
            Object raw = array.opt(i);
            if (raw instanceof String && !((String) raw).isEmpty() && !"-".equals(raw) && !ips.contains(raw)) ips.add((String) raw);
        }
        return ips;
    }
    static int pathLabel(JSONObject peer) {
        if (!Boolean.TRUE.equals(peer.opt("online"))) return Boolean.FALSE.equals(peer.opt("online")) ? R.string.web_net_filter_offline : R.string.web_net_unknown;
        return peer.optString("curAddr", "").isEmpty() ? R.string.web_net_topo_relay : R.string.web_net_topo_direct;
    }
    static boolean validProbe(JSONObject result, String id, String ip) {
        Object latency = result.opt("latencyMs");
        return result.optBoolean("ok") && id.equals(result.optString("peerId")) && ip.equals(result.optString("ip")) &&
                latency instanceof Number && Double.isFinite(((Number) latency).doubleValue()) && ((Number) latency).doubleValue() >= 0 &&
                result.opt("via") instanceof String && result.opt("path") instanceof String;
    }
}
