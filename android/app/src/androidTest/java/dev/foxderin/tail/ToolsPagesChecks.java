package dev.foxderin.tail;

import org.json.JSONObject;

final class ToolsPagesChecks {
    static void run() throws Exception {
        JSONObject pass = new JSONObject("{\"ok\":true,\"checks\":[{\"id\":\"service\",\"level\":\"pass\",\"reason\":\"connected\"}]}");
        JSONObject failed = new JSONObject("{\"ok\":false,\"error\":\"fixture latest failure\"}");
        require(DiagnosticsPage.currentChecks(false, 0, 20, failed, pass) == failed, "Latest failure replaces old passing checks");
        require(DiagnosticsPage.currentChecks(true, 21, 20, pass, pass) == null, "New running check cannot show old success");
        require(DiagnosticsPage.currentChecks(false, 21, 20, pass, pass) == null, "Unknown new run cannot revive old success");
        require(DiagnosticsPage.currentChecks(false, 21, 22, failed, pass) == failed, "Reconnected terminal failure is current");
        require(DiagnosticsPage.currentChecks(false, 0, 0, null, failed) == failed, "Stored failure remains failed");
        require(DiagnosticsPage.currentChecks(false, 0, 0, null, pass) == pass, "Retained check is used only without newer request");
        JSONObject bundle = new JSONObject().put("ok", true).put("artifactId", "art-0123456789abcdef0123456789abcdef").put("mode", "share").put("path", "/data/adb/foxytail/diagnostics/report.tar.gz");
        require(DiagnosticsPage.validBundle(bundle), "Backend artifact identifier and absolute archive path accepted");
        require(!DiagnosticsPage.validBundle(new JSONObject(bundle.toString()).put("path", "/tmp/report\n.tar.gz")), "Control character path rejected");
        require(!DiagnosticsPage.validBundle(new JSONObject(bundle.toString()).put("artifactId", "/tmp/report.tar.gz")), "Filesystem path cannot substitute artifact capability");
        require(!DiagnosticsPage.validBundle(new JSONObject(bundle.toString()).put("ok", false)), "Failed collection cannot expose old archive");
        require(DiagnosticsPage.currentChecks(true, 21, 20, bundle, bundle) == null, "Pending collection hides retained bundle");
        require(DiagnosticsPage.currentChecks(false, 21, 22, failed, bundle) == failed, "Failed collection replaces old bundle");
        JSONObject ready = new JSONObject("{\"ok\":true,\"dnsReady\":true,\"mode\":\"bridge\",\"socksPort\":1099,\"suffix\":\"example.ts.net\",\"addresses\":[\"100.64.0.1\"],\"dns\":{\"ok\":true,\"enabled\":true,\"listenerReady\":true,\"repairNeeded\":false,\"policyState\":\"owned\",\"mode\":\"local\",\"port\":1053,\"suffix\":\"example.ts.net\"}}");
        JSONObject peer = new JSONObject("{\"id\":\"n1\",\"dnsName\":\"peer.example.ts.net\",\"ips\":[\"100.64.0.2\"]}");
        String snippet = ToolsData.snippet(ready, "blacklist");
        require(!CoexistPage.snippetAvailable(null, snippet), "Copy requires environment");
        require(!CoexistPage.snippetAvailable(ready, ""), "Copy requires an actual snippet");
        require(CoexistPage.snippetAvailable(ready, snippet), "Actual validated snippet is copyable");
        require(!CoexistPage.canCheck(null, peer, "100.64.0.2", "443", ""), "Check requires environment");
        require(!CoexistPage.canCheck(ready, null, "100.64.0.2", "443", ""), "Check requires peer");
        require(!CoexistPage.canCheck(ready, peer, "", "443", ""), "Check requires address");
        require(!CoexistPage.canCheck(ready, peer, "100.64.0.3", "443", ""), "Check requires the selected peer advertised address");
        require(!CoexistPage.canCheck(ready, peer, "100.64.0.2", "0", ""), "Check requires valid TCP port");
        require(!CoexistPage.canCheck(ready, peer, "100.64.0.2", "443", "1053"), "Resolver cannot probe FoxyTail listener as third party");
        require(CoexistPage.canCheck(ready, peer, "100.64.0.2", "443", ""), "Ready target without optional resolver is checkable");
        require(CoexistPage.canCheck(ready, peer, "100.64.0.2", "443", "5353"), "Distinct valid optional resolver is checkable");
        ready.put("dnsReady", false);
        require(!CoexistPage.snippetAvailable(ready, snippet) && !CoexistPage.canCheck(ready, peer, "100.64.0.2", "443", ""), "Lost DNS readiness disables downstream actions");
    }
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
