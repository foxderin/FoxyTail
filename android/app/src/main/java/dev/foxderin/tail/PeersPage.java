package dev.foxderin.tail;

import androidx.appcompat.app.AlertDialog;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import android.text.Editable;
import android.text.TextWatcher;
import android.text.InputType;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

final class PeersPage extends ControlPage {
    private final LinearLayout inventory;
    private final TextView state;
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
        LinearLayout toolbar = section(s(R.string.network_peers));
        state = label(toolbar, s(R.string.network_unknown));
        search = input(toolbar, s(R.string.network_search), activity.drafts.getString("network.peerSearch", ""), InputType.TYPE_CLASS_TEXT);
        filter = activity.drafts.getInt("network.peerFilter", 0);
        tab = activity.drafts.getInt("network.peerTab", 0);
        choice(toolbar, new String[]{s(R.string.network_all), s(R.string.network_online), s(R.string.network_offline)}, filter,
                selected -> { filter = selected; activity.drafts.putInt("network.peerFilter", selected); render(); });
        choice(toolbar, new String[]{s(R.string.network_list), s(R.string.network_topology)}, tab,
                selected -> { tab = selected; activity.drafts.putInt("network.peerTab", selected); render(); });
        button(toolbar, s(R.string.network_refresh), this::refresh);
        inventory = section(s(R.string.network_peers));
        search.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence value, int start, int count, int after) { }
            public void onTextChanged(CharSequence value, int start, int before, int count) {
                activity.drafts.putString("network.peerSearch", value.toString()); render();
            }
            public void afterTextChanged(Editable value) { }
        });
        repeat(this::refresh, 15000);
    }
    @Override String title() { return s(R.string.network_peers); }
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
                    state.setText(s(R.string.network_counts, online, peers.size() - online));
                    if (detail != null) detail.dismiss();
                    render();
                } catch (Exception invalid) { fail(invalid); }
            }, failure -> { reading = false; fail(failure); }, "peers");
        }, failure -> { reading = false; fail(failure); }, "status");
    }
    private void fail(Exception failure) {
        fresh = false; state.setText(s(R.string.network_stale));
        for (android.widget.Button button : pingButtons) button.setEnabled(false);
        error(failure);
    }
    private void render() {
        inventory.removeAllViews();
        if (peers == null) { label(inventory, s(R.string.network_unknown)); return; }
        String query = search.getText().toString().trim().toLowerCase(Locale.ROOT);
        List<JSONObject> visible = new ArrayList<>();
        for (JSONObject peer : peers) {
            if (filter == 1 && !peer.optBoolean("online") || filter == 2 && peer.optBoolean("online")) continue;
            String text = peer.optString("hostname") + " " + peer.optString("os") + " " + String.join(" ", addresses(peer));
            if (text.toLowerCase(Locale.ROOT).contains(query)) visible.add(peer);
        }
        visible.sort(Comparator.<JSONObject>comparingInt(peer -> peer.optBoolean("online") ? 0 : 1)
                .thenComparing(peer -> peer.optString("hostname"), String.CASE_INSENSITIVE_ORDER));
        if (visible.isEmpty()) { label(inventory, s(R.string.network_empty)); return; }
        if (tab == 1) {
            label(inventory, s(R.string.network_topology_hint));
            inventory.addView(new PeerTopologyView(activity, self, exitId, visible, this::showDetail));
        } else for (JSONObject peer : visible) {
            LinearLayout card = row(inventory); card.setOrientation(LinearLayout.VERTICAL);
            button(card, peer.optString("hostname") + " · " + s(pathLabel(peer)), () -> showDetail(peer));
            label(card, peer.optString("os", "—") + " · " + peer.optString("relay", "—"));
            for (String ip : addresses(peer)) button(card, s(R.string.network_copy, ip), () -> copy(ip, ip));
            label(card, s(R.string.network_rx) + ": " + peer.optLong("rxBytes") + " B · " + s(R.string.network_tx) + ": " + peer.optLong("txBytes") + " B");
        }
    }
    private void showDetail(JSONObject peer) {
        if (detail != null) detail.dismiss();
        pingButtons.clear();
        LinearLayout body = new LinearLayout(activity); body.setOrientation(LinearLayout.VERTICAL); body.setPadding(dp(20), dp(8), dp(20), dp(8));
        label(body, s(pathLabel(peer)));
        label(body, s(R.string.network_os) + ": " + peer.optString("os", "—"));
        label(body, s(R.string.network_region) + ": " + peer.optString("relay", "—"));
        label(body, s(R.string.network_rx) + ": " + peer.optLong("rxBytes") + " B");
        label(body, s(R.string.network_tx) + ": " + peer.optLong("txBytes") + " B");
        label(body, s(R.string.network_exits) + ": " + s(peer.optBoolean("exitNodeOption") ? R.string.network_yes : R.string.network_no));
        for (String ip : addresses(peer)) {
            button(body, s(R.string.network_copy, ip), () -> copy(ip, ip));
            TextView resultView = label(body, s(R.string.network_unchecked));
            android.widget.Button ping = button(body, s(R.string.network_ping, (ip.contains(":") ? "IPv6 " : "IPv4 ") + ip), () -> {
                if (!fresh) return;
                probe(s(R.string.network_ping, ip), result -> {
                    if (validProbe(result, peer.optString("id"), ip))
                        resultView.setText(result.optDouble("latencyMs") + " ms · " + result.optString("path") + " · " + result.optString("via"));
                    else resultView.setText(s(R.string.network_failed, result.optString("error", s(R.string.network_invalid_result))));
                }, "peer-ping", peer.optString("id"), ip);
            });
            ping.setEnabled(fresh); pingButtons.add(ping);
        }
        ScrollView scroll = new ScrollView(activity); scroll.addView(body);
        detail = new MaterialAlertDialogBuilder(activity).setTitle(s(R.string.network_details, peer.optString("hostname")))
                .setView(scroll).setPositiveButton(s(R.string.network_close), null).create();
        detail.show();
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
        if (!Boolean.TRUE.equals(peer.opt("online"))) return Boolean.FALSE.equals(peer.opt("online")) ? R.string.network_offline : R.string.network_unknown;
        return peer.optString("curAddr", "").isEmpty() ? R.string.network_relay : R.string.network_direct;
    }
    static boolean validProbe(JSONObject result, String id, String ip) {
        Object latency = result.opt("latencyMs");
        return result.optBoolean("ok") && id.equals(result.optString("peerId")) && ip.equals(result.optString("ip")) &&
                latency instanceof Number && Double.isFinite(((Number) latency).doubleValue()) && ((Number) latency).doubleValue() >= 0 &&
                result.opt("via") instanceof String && result.opt("path") instanceof String;
    }
}
