package dev.foxderin.tail;

import org.json.*;
import java.util.*;

public final class ToolsLogicTests {
    public static void run() throws Exception {
        require(ToolsData.port("1") && ToolsData.port("65535") && !ToolsData.port("0") && !ToolsData.port("65536") && !ToolsData.port("-1") && !ToolsData.port("1;id"), "Port trust boundary");
        JSONObject serve = new JSONObject("{\"TCP\":{\"443\":{\"HTTP\":true},\"8443\":{\"HTTPS\":true},\"10000\":{\"TCPForward\":\"localhost:22\",\"TerminateTLS\":\"node.test.ts.net\"}},\"Web\":{\"node:443\":{\"Handlers\":{\"/exact\":{\"Proxy\":\"http://localhost:3000\"}}},\"node:8443\":{\"Handlers\":{\"/a/b\":{\"Text\":\"hello\"}}},\"node:1234\":{\"Handlers\":{\"/unknown\":{\"Path\":\"/tmp\"}}}},\"AllowFunnel\":{\"node:8443\":true,\"node:10000\":true}}");
        List<ToolsData.Mapping> mappings = ToolsData.mappings(serve);
        require(mappings.size() == 4, "All protocol shapes retained");
        for (ToolsData.Mapping mapping : mappings) {
            if (mapping.port.equals("443")) require(mapping.protocol.equals("http") && Arrays.equals(mapping.deleteArgs(), new String[]{"serve-del", "http", "443", "/exact"}), "Listener flags, not port, determine protocol; exact handler delete");
            if (mapping.port.equals("8443")) require(mapping.funnel && Arrays.equals(mapping.deleteArgs(), new String[]{"funnel-del", "https", "8443", "/a/b"}), "Public mapping exact path retained");
            if (mapping.port.equals("10000")) require(mapping.protocol.equals("tls-terminated-tcp") && mapping.deleteArgs().length == 3, "TLS TCP has no web path");
            if (mapping.port.equals("1234")) { try { mapping.deleteArgs(); throw new AssertionError("Unknown listener deleted"); } catch (IllegalArgumentException expected) { } }
        }
        JSONObject info = new JSONObject("{\"ok\":true,\"dnsReady\":true,\"mode\":\"bridge\",\"socksPort\":1099,\"suffix\":\"example.ts.net\",\"addresses\":[\"100.64.0.1\",\"fd7a:115c:a1e0::1\"],\"dns\":{\"ok\":true,\"enabled\":true,\"listenerReady\":true,\"repairNeeded\":false,\"policyState\":\"owned\",\"mode\":\"local\",\"port\":1053,\"suffix\":\"example.ts.net\"}}");
        String blacklist = ToolsData.snippet(info, "blacklist");
        List<String> exclusionsAndRules = quotedListValues(blacklist);
        require("tcp://127.0.0.1:1053#DIRECT".equals(quotedPolicyValue(blacklist, "+.example.ts.net")) && exclusionsAndRules.contains("+.example.ts.net") && exclusionsAndRules.contains("IP-CIDR,100.64.0.1/32,FoxyTail-Tailnet,no-resolve"), "Fragment bound to current suffix and exact host route");
        for (String value : exclusionsAndRules) if (value.startsWith("IP-CIDR")) require(value.contains("/32,") || value.contains("/128,"), "Fragment never routes a whole network");
        require(quotedListValues(ToolsData.snippet(info, "rule")).contains("DOMAIN-SUFFIX,example.ts.net,real-ip"), "Rule filter semantics");
        require(!ToolsData.snippet(info, "redir-host").contains("fake-ip-filter"), "Redir-host preserves filter semantics");
        expectSnippetFailure(info, "whitelist");
        JSONObject unsafe = new JSONObject(info.toString()); unsafe.put("suffix", "ts.net"); unsafe.getJSONObject("dns").put("suffix", "ts.net"); expectSnippetFailure(unsafe, "blacklist");
        unsafe = new JSONObject(info.toString()); unsafe.getJSONObject("dns").remove("repairNeeded"); expectSnippetFailure(unsafe, "blacklist");
        for (String address : new String[]{"localhost", "127.0.0.1", "0.0.0.2", "224.0.0.1", "169.254.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "1.2.3.999"}) { unsafe = new JSONObject(info.toString()); unsafe.put("addresses", new JSONArray().put(address)); expectSnippetFailure(unsafe, "blacklist"); }
        info.put("mode", "tun"); require(ToolsData.snippet(info, "rule").contains("interface-name: \"tailscale0\"") && !ToolsData.snippet(info, "rule").contains("type: socks5"), "Applied TUN uses interface path");
        JSONObject summary = new JSONObject("{\"hours\":[{\"hour\":0,\"samples\":0,\"iface\":{\"rx\":99,\"tx\":99}},{\"hour\":1,\"samples\":1,\"iface\":{\"rx\":0,\"tx\":0}},{\"hour\":2,\"iface\":{\"rx\":0,\"tx\":0}},{\"hour\":3,\"iface\":{\"rx\":1,\"tx\":2}}],\"days\":[{\"date\":\"2026-10-09\",\"samples\":1,\"rx\":0,\"tx\":0}]}");
        List<ToolsData.Sample> hours = ToolsData.samples(summary, false);
        require(hours.get(0).rx == null && hours.get(1).rx != null && hours.get(1).rx == 0 && hours.get(2).rx == null && hours.get(3).tx == 2, "Missing vs recorded-zero samples and legacy records");
        require(ToolsData.samples(summary, true).get(0).label.equals("2026-10-09") && ToolsData.samples(summary, true).get(0).rx == 0, "Daily labels and idle interval");
        String token = "art-0123456789abcdef0123456789abcdef", hash = String.join("", Collections.nCopies(64, "a"));
        JSONObject preview = new JSONObject().put("path", token).put("sha256", hash).put("baselineSha256", hash).put("changes", new JSONArray().put(new JSONObject().put("file", "foxytail.conf").put("key", "MODE").put("before", JSONObject.NULL).put("after", "tun"))).put("hooks", new JSONArray().put("foxytail.tun.up"));
        require(ToolsData.validPreview(preview, token), "Artifact preview with both hashes accepted");
        require(!ToolsData.validPreview(preview, "different"), "Preview cannot restore another selection");
        preview.put("baselineSha256", ""); require(!ToolsData.validPreview(preview, token), "Baseline required"); preview.put("baselineSha256", hash);
        preview.getJSONArray("hooks").put("../../evil"); require(!ToolsData.validPreview(preview, token), "Only fixed hooks accepted");
        require(ToolsData.matches("Hello", "HELLO", false) && !ToolsData.matches("Hello", "HELLO", true), "Log case filtering");
        require(ToolsData.visibleLog("prefix\u0000\u001b[31m\t中文").equals("prefix\\u0000\\u001b[31m\t中文"), "Binary log controls remain visible without breaking accessibility nodes");
    }
    private static List<String> quotedListValues(String yaml) throws JSONException {
        List<String> values = new ArrayList<>();
        for (String line : yaml.split("\n")) {
            String scalar = line.trim();
            if (scalar.startsWith("- \"")) values.add(new JSONArray("[" + scalar.substring(2) + "]").getString(0));
        }
        return values;
    }
    private static String quotedPolicyValue(String yaml, String key) throws JSONException {
        for (String line : yaml.split("\n")) {
            String entry = line.trim();
            if (!entry.startsWith("\"")) continue;
            JSONTokener tokens = new JSONTokener(entry);
            Object found = tokens.nextValue();
            if (tokens.nextClean() != ':') throw new JSONException("Missing policy separator");
            Object value = tokens.nextValue();
            if (!(value instanceof String)) throw new JSONException("Expected quoted policy value");
            if (key.equals(found)) return (String) value;
        }
        return null;
    }
    private static void expectSnippetFailure(JSONObject info, String mode) throws Exception {
        try { ToolsData.snippet(info, mode); throw new AssertionError("Unsafe coexist fragment accepted: " + mode); } catch (IllegalArgumentException expected) { }
    }
    private static void require(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
