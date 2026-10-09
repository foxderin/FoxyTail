package dev.foxderin.tail;

import org.json.JSONArray;
import org.json.JSONObject;

/** Deterministic decoder checks invoked by the shared instrumentation runner. */
final class NetworkChecks {
    static void run() throws Exception {
        JSONObject status = new JSONObject().put("ok", true).put("daemon", "running").put("mode", "bridge");
        check(OverviewPage.connectionLabel(status) == R.string.network_unknown, "Missing backend must not request login");
        check(OverviewPage.connectionLabel(status.put("backend", "NeedsMachineAuth")) == R.string.network_machine_auth, "Machine authorization is not login");
        check(OverviewPage.connectionLabel(status.put("backend", "NeedsLogin")) == R.string.network_login_needed, "Explicit NeedsLogin");
        check(OverviewPage.connectionLabel(status.put("backend", "Starting")) == R.string.network_starting, "Starting preserved");
        check(!OverviewPage.serviceKnown(status.put("backend", "unreachable")), "Unreachable disables service guesses");
        check(OverviewPage.stopAvailable(status, true), "Unreachable daemon retains recovery Stop");
        check(OverviewPage.stopAvailable(null, false), "Invalid runtime configuration retains recovery Stop");
        check(!OverviewPage.stopAvailable(new JSONObject().put("ok", true).put("daemon", "stopped"), true), "Confirmed stopped does not offer redundant Stop");
        check(OverviewPage.connectionLabel(status.put("daemon", "stopped")) == R.string.network_unknown, "Unreachable takes precedence");
        check(!OverviewPage.expiresSoon("invalid", 0), "Malformed expiry does not become expired");
        check(OverviewPage.expiresSoon("1970-01-02T00:00:00Z", 0), "Expiry within seven days");
        JSONObject peer = new JSONObject().put("id", "node1").put("hostname", "peer").put("online", true).put("ips", new JSONArray().put("100.64.0.1").put("fd7a:115c:a1e0::1").put("-").put(17));
        check(PeersPage.addresses(peer).size() == 2, "Both address families with invalid elements omitted");
        check(PeersPage.pathLabel(peer) == R.string.network_relay, "Online does not imply direct");
        check(PeersPage.pathLabel(peer.put("curAddr", "192.0.2.1:41641")) == R.string.network_direct, "Observed direct path");
        check(PeersPage.pathLabel(peer.put("online", false)) == R.string.network_offline, "Offline overrides old direct path");
        check(PeersPage.decodePeers(new JSONObject().put("peers", new JSONArray().put(peer))).size() == 1, "Inventory decoder");
        try { PeersPage.decodePeers(new JSONObject().put("peers", new JSONArray().put(new JSONObject().put("id", "broken")))); throw new AssertionError("Missing online state accepted"); }
        catch (org.json.JSONException expected) { }
        JSONObject ping = new JSONObject().put("ok", true).put("peerId", "node1").put("ip", "100.64.0.1").put("latencyMs", 0).put("via", "DERP(sin)").put("path", "derp");
        check(PeersPage.validProbe(ping, "node1", "100.64.0.1"), "Measured zero latency valid");
        check(!PeersPage.validProbe(ping, "node2", "100.64.0.1"), "Probe cannot belong to another peer");
        check(!PeersPage.validProbe(ping.put("latencyMs", "3"), "node1", "100.64.0.1"), "String latency is not measured");
        check(AccountPage.validServer("http://headscale.example:8080/path") && AccountPage.validServer("https://headscale.example"), "HTTP and HTTPS Headscale accepted");
        check(!AccountPage.validServer("javascript:alert(1)") && !AccountPage.validServer("https://user:secret@example.com") && !AccountPage.validServer("https://example.com:65536"), "Invalid server URL rejected");
        check(AccountPage.hasActiveTransfers(new JSONObject().put("transfers", new JSONArray().put(new JSONObject().put("status", "sending")))), "Active transfer blocks account change");
        check(!AccountPage.hasActiveTransfers(new JSONObject().put("transfers", new JSONArray().put(new JSONObject().put("status", "interrupted")))), "Terminal transfer permits account change");
        try { AccountPage.hasActiveTransfers(new JSONObject()); throw new AssertionError("Unknown history accepted"); } catch (org.json.JSONException expected) { }
        JSONObject routing = new JSONObject().put("known", true);
        check(ExitNodesPage.selectedId(routing) == null, "Missing selection is unknown");
        check("".equals(ExitNodesPage.selectedId(routing.put("selected", JSONObject.NULL))), "Explicit null means no exit");
        routing.put("selected", new JSONObject().put("id", "node1")).put("effective", "not-effective");
        check("node1".equals(ExitNodesPage.selectedId(routing)) && ExitNodesPage.effectiveLabel(routing) == R.string.network_exit_failed, "Failed routing retains selection");
        routing.put("selected", new JSONObject().put("auto", "any"));
        check("auto:any".equals(ExitNodesPage.selectedId(routing)), "Automatic selection preserved");
        check(TunnelPage.socksEndpoint(new JSONObject().put("socksPort", "1099")) == null, "Port strings cannot masquerade as actual ports");
        check(TunnelPage.socksEndpoint(new JSONObject().put("socksPort", 65536)) == null, "Port upper bound");
        JSONObject dns = new JSONObject().put("mode", "transparent").put("enabled", true).put("listenerReady", true).put("state", "running").put("repairNeeded", false).put("policyState", "owned").put("reason", "running").put("interception4", true).put("interception6", false).put("port", 1053);
        check(TunnelPage.dnsLabel(dns) == R.string.network_dns_v4, "IPv4-only transparent DNS must remain limited");
        check("127.0.0.1:1053".equals(TunnelPage.dnsEndpoint(dns)), "Actual listener port");
        check(TunnelPage.dnsLabel(dns.put("repairNeeded", true)) != R.string.network_dns_v4, "Repair needed cannot appear healthy");
        dns.put("repairNeeded", false).put("policyState", "foreign");
        check(!TunnelPage.dnsReady(dns), "Foreign policy cannot appear owned");
        dns.put("policyState", "owned").remove("enabled");
        check(!TunnelPage.dnsReady(dns), "Missing enabled is unknown not healthy");
        check(TunnelPage.dnsEndpoint(dns.put("port", 1053.5)) == null, "Fractional port rejected");
        check(TunnelPage.dnsLabel(new JSONObject()) == R.string.network_unknown, "Empty DNS response is unknown");
    }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
