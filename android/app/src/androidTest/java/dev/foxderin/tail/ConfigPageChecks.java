package dev.foxderin.tail;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

final class ConfigPageChecks {
    static void run() throws Exception {
        check(TrialPage.remaining(8, 1000, 4500) == 5, "Countdown advances without a backend response");
        check(TrialPage.remaining(8, 1000, 31000) == 0, "Slow response never leaves expired trial positive");
        check(TrialPage.remaining(8, 1000, 500) == 8, "Clock boundary never extends original duration");
        List<JSONObject> peers = new ArrayList<>();
        for (int i = 0; i < 15; i++) peers.add(new JSONObject().put("id", "node" + i).put("hostname", String.format(java.util.Locale.ROOT, "node%02d", i)).put("online", i >= 10).put("relay", "sin"));
        peers.get(14).put("curAddr", "192.0.2.1:41641");
        List<JSONObject> diagram = PeerTopologyView.diagramPeers(peers);
        check(diagram.size() == 12 && diagram.get(0) == peers.get(14) && diagram.get(1) == peers.get(10) && diagram.get(5) == peers.get(0) && !diagram.contains(peers.get(9)), "Dense topology orders direct, relay and offline peers before bounding the diagram");
        check(peers.get(0).getString("id").equals("node0") && peers.get(14).getString("id").equals("node14"), "Diagram sorting does not mutate source inventory");
        check(PeerTopologyView.pathRank(new JSONObject().put("online", false).put("curAddr", "192.0.2.1:41641")) == 2, "Offline node does not inherit previous direct path");
    }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
