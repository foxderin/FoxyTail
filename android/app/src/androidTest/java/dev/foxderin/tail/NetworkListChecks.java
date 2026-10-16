package dev.foxderin.tail;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

/** Main-thread UI checks; the caller supplies a themed, live activity and owns transport tests. */
final class NetworkListChecks {
    static void run(ControlActivity activity) throws Exception {
        Bundle drafts = new Bundle(activity.drafts);
        JSONObject previousStatus = activity.statusSnapshot();
        Field sharedStatus = ControlActivity.class.getDeclaredField("sharedStatus"); sharedStatus.setAccessible(true); sharedStatus.set(activity, null);
        PeersPage peers = null;
        RoutingPage routing = null;
        ExitNodesPage exits = null;
        try {
            activity.drafts.clear();
            peers = new PeersPage(activity);
            exits = new ExitNodesPage(activity);
            routing = new RoutingPage(activity);
            require(text((View) get(peers, "inventory"), activity.getString(R.string.web_loading)) != null, "Peer inventory explains initial loading");
            require(text((View) get(exits, "currentBox"), activity.getString(R.string.web_loading)) != null, "Current exit card is not blank before status");
            require(text((View) get(exits, "options"), activity.getString(R.string.web_loading)) != null, "Exit choices explain initial loading");
            require(text((View) get(routing, "advertised"), activity.getString(R.string.web_loading)) != null, "Advertised routes explain initial loading");

            List<JSONObject> inventory = new ArrayList<>();
            for (int i = 0; i < 100; i++) inventory.add(new JSONObject().put("id", "peer-" + i).put("hostname", "Peer " + i).put("online", true).put("os", "linux").put("ips", new JSONArray().put("100.64.0." + (i + 1))));
            set(peers, "peers", inventory); invoke(peers, "render");
            TextView peerName = text(peers.content, "Peer 42");
            require(peerName != null && text(peers.content, "Peer 99") != null, "All peer records remain available");
            ((EditText) get(peers, "search")).setText("100.64.0.43"); invoke(peers, "render");
            require(text(peers.content, "Peer 42") == peerName && text(peers.content, "Peer 41") == null, "Address filtering retains matching peer and hides nonmatches");
            ((EditText) get(peers, "search")).setText(""); invoke(peers, "render");
            set(peers, "peers", PeersPage.decodePeers(new JSONObject().put("peers", new JSONArray(inventory)))); invoke(peers, "render");
            require(text(peers.content, "Peer 42") == peerName && text(peers.content, "Peer 99") != null, "Unchanged peer poll preserves existing address/detail targets");
            set(peers, "tab", 1); invoke(peers, "render");
            PeerTopologyView topology = topology(peers.content);
            require(topology != null && descriptions(topology) >= 12, "Topology exposes accessible diagram targets");
            invoke(peers, "render"); require(topology(peers.content) == topology, "Unchanged topology preserves focus targets");
            View expand = action(topology, activity.getString(R.string.web_net_topology_list) + " · 100");
            require(expand != null, "Topology retains full inventory toggle"); expand.performClick();
            require(text(topology, "● Peer 99") != null, "Topology expanded list includes peers beyond diagram");
            set(peers, "tab", 0); invoke(peers, "render");
            inventory.set(42, new JSONObject(inventory.get(42).toString()).put("hostname", "Renamed peer"));
            set(peers, "peers", inventory); invoke(peers, "render");
            require(text(peers.content, "Renamed peer") != null && text(peers.content, "Peer 42") == null, "Changed identity fields replace stale peer labels");
            set(peers, "peers", null); set(peers, "failed", true); invoke(peers, "render");
            require(action(peers.content, activity.getString(R.string.web_retry)) != null && text(peers.content, "Peer 99") == null, "Failed inventory offers retry without displaying invalid identity");
            set(peers, "failed", false); invoke(peers, "render");
            require(text(peers.content, activity.getString(R.string.web_loading)) != null, "Retry returns inventory to explicit loading");
            set(peers, "peers", inventory); invoke(peers, "render");
            require(text(peers.content, "Peer 99") != null, "Inventory recovers after retry");

            JSONObject light = new JSONObject().put("ok", true).put("daemon", "running").put("backend", "Running").put("mode", "bridge")
                    .put("self", new JSONObject().put("id", "self-a"));
            set(exits, "snapshot", light); set(exits, "peers", inventory); set(exits, "freshPeers", true);
            set(exits, "routing", new JSONObject().put("known", true).put("selected", JSONObject.NULL).put("effective", "none"));
            set(exits, "freshStatus", true); setVisible(exits, true); invoke(exits, "renderOptions");
            View options = (View) get(exits, "options");
            CompoundButton fortyOne = checkbox(options, "Peer 41"), ninetyNine = checkbox(options, "Peer 99");
            require(fortyOne != null && ninetyNine != null, "All one hundred exits remain reachable");
            fortyOne.performClick();
            require(fortyOne.isChecked() && checkbox(options, "Peer 99") == ninetyNine && checkbox(options, "Peer 41") == fortyOne, "Selection changes only retained selection controls");
            ninetyNine.performClick();
            require(!fortyOne.isChecked() && ninetyNine.isChecked(), "Selection moves between existing rows");
            set(exits, "peers", PeersPage.decodePeers(new JSONObject().put("peers", new JSONArray(inventory)))); invoke(exits, "renderOptions");
            require(checkbox(options, "Peer 41") == fortyOne && checkbox(options, "Peer 99") == ninetyNine && ninetyNine.isChecked(), "Unchanged exit refresh preserves focus and draft");
            light.put("peerList", new JSONArray(inventory)); sharedStatus.set(activity, light);
            Field fresh = ControlActivity.class.getDeclaredField("statusFresh"); fresh.setAccessible(true); boolean wasFresh = fresh.getBoolean(activity); fresh.setBoolean(activity, false);
            PeersPage cached = new PeersPage(activity);
            try {
                require(text(cached.content, "Peer 99") != null && text(cached.content, activity.getString(R.string.web_net_status_stale)) != null, "Cached reentry is populated and explicitly stale");
                require(!(Boolean) get(cached, "fresh"), "Cached rows cannot authorize probes");
            } finally { cached.close(); fresh.setBoolean(activity, wasFresh); sharedStatus.set(activity, null); }

            JSONArray apps = new JSONArray();
            for (int i = 0; i < 102; i++) apps.put(new JSONObject().put("uid", i < 2 ? "10001" : Integer.toString(10000 + i)).put("label", String.format(java.util.Locale.ROOT, "App %03d", i)).put("package", "example.app" + i));
            set(routing, "apps", apps); set(routing, "mode", "bridge"); set(routing, "ownerKnown", true); set(routing, "ownerAvailable", true); set(routing, "routesKnown", true); set(routing, "selectedScope", "selected");
            setVisible(routing, true); invoke(routing, "renderApps");
            View appRows = (View) get(routing, "appRows");
            CompoundButton first = checkbox(appRows, "App 000"), shared = checkbox(appRows, "App 001");
            require(first != null && shared != null && text(appRows, "App 099") != null && text(appRows, "App 100") == null, "Initial application limit retains first hundred matches");
            first.performClick();
            require(first.isChecked() && shared.isChecked(), "Packages sharing a UID select together");
            ((EditText) get(routing, "search")).setText("example.app42");
            require(text(appRows, "App 042") != null && text(appRows, "App 041") == null, "Package search filters application rows");
            ((EditText) get(routing, "search")).setText("");
            require(checkbox(appRows, "App 000") == first && first.isChecked(), "Search preserves existing selection controls");
            set(routing, "selectedOnly", true); invoke(routing, "renderApps");
            require(text(appRows, "App 000") != null && text(appRows, "App 001") != null && text(appRows, "App 002") == null, "Selected-only includes every package with selected UID");
            shared.performClick();
            require(text(appRows, "App 000") == null && text(appRows, activity.getString(R.string.web_empty)) != null, "Clearing shared UID updates selected-only results");
            set(routing, "selectedOnly", false); invoke(routing, "renderApps");
            ((View) get(routing, "moreApps")).performClick();
            require(text(appRows, "App 101") != null, "Show more exposes remaining application data");
            set(routing, "apps", new JSONArray(apps.toString())); invoke(routing, "renderApps");
            require(checkbox(appRows, "App 000") == first, "Unchanged application inventory retains selection targets");
            setVisible(routing, false); first.performClick();
            require(!activity.drafts.getString("routing.uids", "").contains("10001"), "Hidden application page cannot change route drafts");
        } finally {
            if (peers != null) peers.close();
            if (exits != null) exits.close();
            if (routing != null) routing.close();
            sharedStatus.set(activity, previousStatus);
            activity.drafts.clear(); activity.drafts.putAll(drafts);
        }
    }
    private static TextView text(View root, String expected) {
        if (root.getVisibility() != View.VISIBLE) return null;
        if (root instanceof TextView && expected.contentEquals(((TextView) root).getText())) return (TextView) root;
        if (root instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) root).getChildCount(); i++) {
            TextView found = text(((ViewGroup) root).getChildAt(i), expected); if (found != null) return found;
        }
        return null;
    }
    private static View action(View root, String description) {
        if (root.getVisibility() != View.VISIBLE) return null;
        if (root.isClickable() && description.contentEquals(root.getContentDescription() == null ? "" : root.getContentDescription())) return root;
        if (root instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) root).getChildCount(); i++) {
            View found = action(((ViewGroup) root).getChildAt(i), description); if (found != null) return found;
        }
        return null;
    }
    private static CompoundButton checkbox(View root, String description) {
        if (root.getVisibility() != View.VISIBLE) return null;
        if (root instanceof CompoundButton && description.contentEquals(root.getContentDescription())) return (CompoundButton) root;
        if (root instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) root).getChildCount(); i++) {
            CompoundButton found = checkbox(((ViewGroup) root).getChildAt(i), description); if (found != null) return found;
        }
        return null;
    }
    private static PeerTopologyView topology(View root) {
        if (root.getVisibility() != View.VISIBLE) return null;
        if (root instanceof PeerTopologyView) return (PeerTopologyView) root;
        if (root instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) root).getChildCount(); i++) {
            PeerTopologyView found = topology(((ViewGroup) root).getChildAt(i)); if (found != null) return found;
        }
        return null;
    }
    private static int descriptions(View root) {
        if (root.getVisibility() != View.VISIBLE) return 0;
        int count = root.getContentDescription() == null ? 0 : 1;
        if (root instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) root).getChildCount(); i++) count += descriptions(((ViewGroup) root).getChildAt(i));
        return count;
    }
    private static Object get(Object target, String name) throws Exception { Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(target); }
    private static void set(Object target, String name, Object value) throws Exception { Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); field.set(target, value); }
    private static void setVisible(ControlPage page, boolean value) throws Exception { Field field = ControlPage.class.getDeclaredField("visible"); field.setAccessible(true); field.setBoolean(page, value); }
    private static void invoke(Object target, String name) throws Exception { Method method = target.getClass().getDeclaredMethod(name); method.setAccessible(true); method.invoke(target); }
    private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
