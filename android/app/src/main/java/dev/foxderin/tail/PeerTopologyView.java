package dev.foxderin.tail;

import android.content.Context;
import com.google.android.material.button.MaterialButton;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Consumer;

/** Native, focusable tree: each observed edge terminates in an accessible device button. */
final class PeerTopologyView extends LinearLayout {
    PeerTopologyView(Context context, String self, String exitId, List<JSONObject> peers, Consumer<JSONObject> selected) {
        super(context);
        setOrientation(VERTICAL);
        TextView root = ControlUi.text(context, context.getString(R.string.network_self) + ": " + self, 20);
        if (android.os.Build.VERSION.SDK_INT >= 28) root.setAccessibilityHeading(true); addView(root);
        Map<String, java.util.ArrayList<JSONObject>> branches = new TreeMap<>();
        for (JSONObject peer : peers) {
            int path = PeersPage.pathLabel(peer);
            String branch = context.getString(path);
            if (path == R.string.network_relay) branch += " · DERP " + peer.optString("relay", "—");
            branches.computeIfAbsent(branch, ignored -> new java.util.ArrayList<>()).add(peer);
        }
        int indent = Math.round(20 * getResources().getDisplayMetrics().density);
        for (Map.Entry<String, java.util.ArrayList<JSONObject>> entry : branches.entrySet()) {
            LinearLayout group = new LinearLayout(context); group.setOrientation(VERTICAL);
            group.setPadding(indent, indent / 2, 0, 0); addView(group);
            TextView edge = ControlUi.text(context, "└─ " + entry.getKey(), 16);
            if (android.os.Build.VERSION.SDK_INT >= 28) edge.setAccessibilityHeading(true); group.addView(edge);
            for (JSONObject peer : entry.getValue()) {
                String text = peer.optString("hostname") + "\n" + String.join(" · ", PeersPage.addresses(peer));
                if (exitId.equals(peer.optString("id"))) text += "\n" + context.getString(R.string.network_selected);
                MaterialButton node = ControlUi.button(context, text, () -> selected.accept(peer));
                node.setPaddingRelative(ControlUi.dp(context, 16), ControlUi.dp(context, 12), ControlUi.dp(context, 16), ControlUi.dp(context, 12));
                node.setLineSpacing(ControlUi.dp(context, 2), 1);
                node.setContentDescription(entry.getKey() + ", " + text);
                group.addView(node, new LinearLayout.LayoutParams(-1, -2));
            }
        }
    }
}
