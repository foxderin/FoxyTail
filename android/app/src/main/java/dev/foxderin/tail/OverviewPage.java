package dev.foxderin.tail;

import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.time.Instant;

final class OverviewPage extends ControlPage {
    private final LinearLayout statusBox, compatibility;
    private final TextView state, feedback;
    private final Button startButton, stopButton, restartButton, modeButton, loginButton;
    private final MaterialChoice modes;
    private JSONObject snapshot;
    private boolean fresh, reading;
    private java.util.function.Consumer<JSONObject> queuedAfter;
    private int sequence;
    private String draftMode;
    private static final String[] MODES = {"tun", "bridge", "proxy"};

    OverviewPage(ControlActivity activity) {
        super(activity);
        LinearLayout service = section(s(R.string.network_service));
        state = label(service, s(R.string.network_unknown));
        feedback = label(service, "");
        startButton = button(service, s(R.string.network_start), () -> change("start", null));
        stopButton = button(service, s(R.string.network_stop), () -> change("stop", null));
        restartButton = button(service, s(R.string.network_restart), () -> change("restart", null));
        label(service, s(R.string.network_mode));
        draftMode = activity.drafts.getString("network.mode", "tun");
        int selected = java.util.Arrays.asList(MODES).indexOf(draftMode);
        modes = choice(service, MODES, Math.max(0, selected), index -> {
            draftMode = MODES[index]; activity.drafts.putString("network.mode", draftMode);
        });
        modeButton = button(service, s(R.string.network_apply_mode), () -> change("mode", draftMode));
        button(service, s(R.string.network_refresh), () -> refresh(null));
        loginButton = button(service, s(R.string.network_login), () -> activity.navigate("account"));
        loginButton.setVisibility(View.GONE);
        statusBox = section(s(R.string.network_self));
        compatibility = section(s(R.string.network_compat));
        label(compatibility, s(R.string.network_unknown));
        LinearLayout links = section(s(R.string.network_overview));
        button(links, s(R.string.network_peers), () -> activity.navigate("peers"));
        button(links, s(R.string.network_exits), () -> activity.navigate("exitnodes"));
        button(links, s(R.string.network_tunnel), () -> activity.navigate("tunnel"));
        button(links, s(R.string.network_routing), () -> activity.navigate("routing"));
        button(links, s(R.string.network_logs), () -> activity.navigate("logs"));
        button(links, s(R.string.network_files), activity::openFiles);
        repeat(() -> { if (!reading) refresh(null); }, 15000);
        enableControls();
    }

    @Override String title() { return s(R.string.network_overview); }
    @Override void load() {
        refresh(null);
        read(result -> {
            compatibility.removeAllViews();
            JSONArray warnings = result.optJSONArray("warnings");
            if (warnings == null) { label(compatibility, s(R.string.network_unknown)); return; }
            int count = 0;
            if (warnings != null) for (int i = 0; i < warnings.length(); i++) {
                if (warnings.opt(i) instanceof String) { label(compatibility, warnings.optString(i)); count++; }
            }
            String alert = result.optString("alert", "");
            if (!alert.isEmpty()) { label(compatibility, alert); count++; }
            if (count == 0) label(compatibility, s(R.string.network_compat_ok));
        }, failure -> { compatibility.removeAllViews(); label(compatibility, s(R.string.network_stale)); error(failure); }, "compat");
    }

    private void refresh(java.util.function.Consumer<JSONObject> after) {
        if (reading) { if (after != null) queuedAfter = after; return; }
        final int request = ++sequence;
        reading = true;
        read(result -> {
            if (request != sequence) return;
            reading = false; fresh = true; snapshot = result;
            if (!activity.drafts.containsKey("network.mode") && serviceKnown(result)) {
                draftMode = result.optString("mode"); modes.setSelection(java.util.Arrays.asList(MODES).indexOf(draftMode));
            }
            render(); enableControls();
            if (after != null) after.accept(result);
            followUp();
        }, failure -> {
            if (request != sequence) return;
            reading = false; fresh = false; state.setText(s(R.string.network_stale));
            loginButton.setVisibility(View.GONE); enableControls(); error(failure);
            if (after != null) after.accept(null);
            followUp();
        }, "status");
    }
    private void followUp() {
        java.util.function.Consumer<JSONObject> after = queuedAfter; queuedAfter = null;
        if (after != null) refresh(after);
    }
    @Override void onPause() { reading = false; fresh = false; queuedAfter = null; sequence++; enableControls(); }

    private void enableControls() {
        boolean known = fresh && serviceKnown(snapshot);
        startButton.setEnabled(known && "stopped".equals(snapshot.optString("daemon")));
        stopButton.setEnabled(stopAvailable(snapshot, fresh) && !activity.client.busy());
        restartButton.setEnabled(known && "running".equals(snapshot.optString("daemon")));
        modeButton.setEnabled(known); modes.setEnabled(known);
    }

    private void change(String action, String nextMode) {
        boolean stopping = "stop".equals(action);
        if ((!stopping && (!fresh || !serviceKnown(snapshot))) || activity.client.busy()) return;
        String expectedMode = nextMode == null ? snapshot == null ? "" : snapshot.optString("mode") : nextMode;
        Runnable run = () -> {
            if (!stopping && (!fresh || !serviceKnown(snapshot))) return;
            mutate(s(R.string.network_service), result -> {
                feedback.setText(result.optBoolean("ok") ? s(R.string.network_unverified) : s(R.string.network_failed, result.optString("error", s(R.string.network_unknown))));
                refresh(observed -> {
                    if (!result.optBoolean("ok")) return;
                    boolean matches = observed != null && observed.optBoolean("ok") &&
                            (stopping ? "stopped".equals(observed.optString("daemon")) :
                            serviceKnown(observed) && expectedMode.equals(observed.optString("mode")) && "running".equals(observed.optString("daemon")));
                    feedback.setText(s(matches ? R.string.network_verified : R.string.network_unverified));
                    if (Boolean.FALSE.equals(result.opt("applied")) || result.optBoolean("restartRequired"))
                        feedback.append("\n" + s(R.string.network_pending_config));
                });
            }, "mode".equals(action) ? new String[]{"mode-set", expectedMode} : new String[]{"control", action});
        };
        if ("start".equals(action)) run.run();
        else confirm(s(R.string.network_service), s(R.string.network_interrupt), run);
    }

    private void render() {
        state.setText(s(connectionLabel(snapshot)) + "\n" + value(snapshot, "daemon") + " · " + value(snapshot, "backend") + " · " + value(snapshot, "mode"));
        loginButton.setVisibility(connectionLabel(snapshot) == R.string.network_login_needed ? View.VISIBLE : View.GONE);
        statusBox.removeAllViews();
        JSONObject self = snapshot.optJSONObject("self");
        if (self == null) label(statusBox, s(R.string.network_unknown));
        else {
            label(statusBox, value(self, "hostname"));
            for (String ip : PeersPage.addresses(self)) button(statusBox, s(R.string.network_copy, ip), () -> copy(ip, ip));
            label(statusBox, s(R.string.network_region) + ": " + value(self, "relay"));
        }
        label(statusBox, s(R.string.network_runtime, value(snapshot, "uptime")));
        JSONObject peers = snapshot.optJSONObject("peers");
        boolean connected = connectionLabel(snapshot) == R.string.network_connected;
        if (connected && peers != null && peers.opt("online") instanceof Number && peers.opt("offline") instanceof Number)
            label(statusBox, s(R.string.network_counts, peers.optInt("online"), peers.optInt("offline")));
        else label(statusBox, s(R.string.network_peers) + ": " + s(R.string.network_unknown));
        label(statusBox, "MagicDNS: " + (connected ? bool(snapshot, "magicDns") : s(R.string.network_unknown)));
        String expiry = snapshot.optString("keyExpiry", "");
        if (!expiry.isEmpty() && !"null".equals(expiry)) {
            label(statusBox, s(R.string.network_key_expiry, expiry));
            if (expiresSoon(expiry, System.currentTimeMillis())) label(statusBox, s(R.string.network_key_soon));
        }
        JSONObject routing = snapshot.optJSONObject("exitRouting");
        label(statusBox, s(R.string.network_selected) + ": " + ExitNodesPage.selectedLabel(this, routing));
        label(statusBox, s(R.string.network_effective) + ": " + s(ExitNodesPage.effectiveLabel(routing)));
    }

    String value(JSONObject object, String key) {
        Object value = object == null ? null : object.opt(key);
        return value == null || value == JSONObject.NULL || value instanceof JSONObject || value instanceof JSONArray
                ? s(R.string.network_unknown) : String.valueOf(value);
    }
    String bool(JSONObject object, String key) {
        Object value = object == null ? null : object.opt(key);
        return s(Boolean.TRUE.equals(value) ? R.string.network_yes : Boolean.FALSE.equals(value) ? R.string.network_no : R.string.network_unknown);
    }
    static boolean stopAvailable(JSONObject value, boolean fresh) {
        return !fresh || value == null || !value.optBoolean("ok") || !"stopped".equals(value.optString("daemon"));
    }
    static boolean serviceKnown(JSONObject value) {
        return value != null && value.optBoolean("ok") && !"unreachable".equals(value.optString("backend")) &&
                ("running".equals(value.optString("daemon")) || "stopped".equals(value.optString("daemon"))) &&
                java.util.Arrays.asList(MODES).contains(value.optString("mode"));
    }
    static int connectionLabel(JSONObject value) {
        if (value == null || !value.optBoolean("ok") || "unreachable".equals(value.optString("backend"))) return R.string.network_unknown;
        if ("stopped".equals(value.optString("daemon"))) return R.string.network_stopped;
        if (!"running".equals(value.optString("daemon"))) return R.string.network_unknown;
        switch (value.optString("backend")) {
            case "Running": return R.string.network_connected;
            case "NeedsLogin": return R.string.network_login_needed;
            case "NeedsMachineAuth": return R.string.network_machine_auth;
            case "Starting": case "NoState": return R.string.network_starting;
            default: return R.string.network_unknown;
        }
    }
    static boolean expiresSoon(String date, long now) {
        try { return Instant.parse(date).toEpochMilli() - now < 7L * 24 * 60 * 60 * 1000; }
        catch (java.time.format.DateTimeParseException | ArithmeticException invalid) { return false; }
    }
}
