package dev.foxderin.tail;

import org.json.*;
import java.net.InetAddress;
import java.util.*;

final class ToolsData {
    static boolean port(String value) { return value.matches("[0-9]{1,5}") && Integer.parseInt(value) >= 1 && Integer.parseInt(value) <= 65535; }
    static final class Mapping {
        final String protocol, port, host, path, target; final boolean funnel;
        Mapping(String protocol, String port, String host, String path, String target, boolean funnel) {
            this.protocol = protocol; this.port = port; this.host = host; this.path = path; this.target = target; this.funnel = funnel;
        }
        String[] deleteArgs() {
            if (protocol.equals("unknown")) throw new IllegalArgumentException("Unsupported listener");
            return path == null ? new String[]{funnel ? "funnel-del" : "serve-del", protocol, port} : new String[]{funnel ? "funnel-del" : "serve-del", protocol, port, path};
        }
    }
    static JSONObject object(JSONObject parent, String key) { JSONObject o = parent.optJSONObject(key); return o == null ? new JSONObject() : o; }
    static JSONArray array(JSONObject parent, String key) { JSONArray a = parent.optJSONArray(key); return a == null ? new JSONArray() : a; }
    static List<Mapping> mappings(JSONObject status) throws JSONException {
        List<Mapping> out = new ArrayList<>(); JSONObject tcp = object(status, "TCP"), allow = object(status, "AllowFunnel");
        for (Iterator<String> keys = tcp.keys(); keys.hasNext();) {
            String port = keys.next(); JSONObject listener = object(tcp, port);
            if (!(listener.opt("TCPForward") instanceof String)) continue;
            boolean funnel = false;
            for (Iterator<String> hosts = allow.keys(); hosts.hasNext();) { String host = hosts.next(); if (host.endsWith(":" + port) && Boolean.TRUE.equals(allow.opt(host))) funnel = true; }
            out.add(new Mapping(listener.optString("TerminateTLS").isEmpty() ? "tcp" : "tls-terminated-tcp", port, "", null, listener.getString("TCPForward"), funnel));
        }
        JSONObject web = object(status, "Web");
        for (Iterator<String> hosts = web.keys(); hosts.hasNext();) {
            String hp = hosts.next(); int colon = hp.lastIndexOf(':'); if (colon < 0 || !port(hp.substring(colon + 1))) continue;
            String port = hp.substring(colon + 1), host = hp.substring(0, colon); JSONObject listener = object(tcp, port), handlers = object(object(web, hp), "Handlers");
            String protocol = listener.optBoolean("HTTPS") ? "https" : listener.optBoolean("HTTP") ? "http" : "unknown";
            for (Iterator<String> paths = handlers.keys(); paths.hasNext();) {
                String path = paths.next(); JSONObject handler = object(handlers, path); String target = "";
                for (String key : new String[]{"Proxy", "Path", "Text"}) if (handler.opt(key) instanceof String) { target = handler.getString(key); break; }
                out.add(new Mapping(protocol, port, host, path, target, Boolean.TRUE.equals(allow.opt(hp))));
            }
        }
        return out;
    }
    static String snippet(JSONObject info, String filter) throws Exception {
        if (!Arrays.asList("blacklist", "rule", "redir-host").contains(filter)) throw new IllegalArgumentException("Unsupported fake-IP filter mode");
        JSONObject dns = object(info, "dns"); String mode = info.optString("mode"), suffix = info.optString("suffix");
        if (!info.optBoolean("ok") || !info.optBoolean("dnsReady") || !dns.optBoolean("ok") || !dns.optBoolean("enabled") || !dns.optBoolean("listenerReady") || !Boolean.FALSE.equals(dns.opt("repairNeeded")) || !dns.optString("policyState").equals("owned") || !Arrays.asList("local", "transparent").contains(dns.optString("mode")) || !suffix.equals(dns.optString("suffix"))) throw new IllegalArgumentException("DNS listener is not ready");
        if (!Arrays.asList("bridge", "proxy", "tun").contains(mode) || !port(info.optString("socksPort")) || !port(dns.optString("port"))) throw new IllegalArgumentException("Invalid applied mode or port");
        if (suffix.length() > 253 || suffix.equalsIgnoreCase("ts.net") || !suffix.matches("[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+")) throw new IllegalArgumentException("Invalid Tailnet suffix");
        Set<String> cidrs = new LinkedHashSet<>(); JSONArray addresses = info.getJSONArray("addresses");
        for (int i = 0; i < addresses.length(); i++) {
            String address = addresses.getString(i); if (!address.matches("[0-9a-fA-F:.]+")) throw new IllegalArgumentException("Invalid address");
            boolean v6 = address.contains(":");
            if (!v6) { String[] octets = address.split("\\.", -1); if (octets.length != 4) throw new IllegalArgumentException("Invalid IPv4 address"); for (String octet : octets) if (!octet.matches("0|[1-9][0-9]{0,2}") || Integer.parseInt(octet) > 255) throw new IllegalArgumentException("Invalid IPv4 address"); }
            InetAddress parsed = InetAddress.getByName(address); byte[] raw = parsed.getAddress();
            if (parsed.isAnyLocalAddress() || parsed.isLoopbackAddress() || parsed.isLinkLocalAddress() || parsed.isMulticastAddress() || (v6 && raw.length != 16) || (!v6 && ((raw[0] & 255) == 0 || (raw[0] & 255) >= 224))) throw new IllegalArgumentException("Address must be unicast");
            cidrs.add(SettingsRules.cidr(address + (v6 ? "/128" : "/32")));
        }
        if (cidrs.isEmpty()) throw new IllegalArgumentException("No current addresses");
        String proxy = "FoxyTail-Tailnet"; StringBuilder text = new StringBuilder("dns:\n  enable: true\n  nameserver-policy:\n    ").append(JSONObject.quote("+." + suffix)).append(": ").append(JSONObject.quote("tcp://127.0.0.1:" + dns.getInt("port") + "#DIRECT")).append("\n  direct-nameserver-follow-policy: true\n");
        if (!filter.equals("redir-host")) text.append("  fake-ip-filter-mode: ").append(filter).append("\n  fake-ip-filter:\n    - ").append(JSONObject.quote(filter.equals("rule") ? "DOMAIN-SUFFIX," + suffix + ",real-ip" : "+." + suffix)).append('\n');
        text.append("proxies:\n  - name: \"").append(proxy).append("\"\n");
        if (mode.equals("tun")) text.append("    type: direct\n    interface-name: \"tailscale0\"\n"); else text.append("    type: socks5\n    server: \"127.0.0.1\"\n    port: ").append(info.getInt("socksPort")).append('\n');
        text.append("    udp: true\nrules:\n  - ").append(JSONObject.quote("DOMAIN-SUFFIX," + suffix + "," + proxy)).append('\n');
        for (String cidr : cidrs) text.append("  - ").append(JSONObject.quote((cidr.contains(":") ? "IP-CIDR6," : "IP-CIDR,") + cidr + "," + proxy + ",no-resolve")).append('\n');
        return text.toString();
    }
    static final class Sample {
        final String label; final Double rx, tx;
        Sample(String label, Double rx, Double tx) { this.label = label; this.rx = rx; this.tx = tx; }
    }
    static double bytes(JSONObject value, String key) { double n = value.optDouble(key, 0); return Double.isFinite(n) && n >= 0 ? n : 0; }
    static List<Sample> samples(JSONObject summary, boolean daily) throws JSONException {
        List<Sample> result = new ArrayList<>(); JSONArray rows = array(summary, daily ? "days" : "hours");
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i), counters = daily ? row : row.optJSONObject("iface");
            boolean recorded = row.has("samples") ? row.optInt("samples") > 0 : counters != null && bytes(counters, "rx") + bytes(counters, "tx") > 0;
            String label = daily ? row.getString("date") : String.format(Locale.ROOT, "%02d:00", row.getInt("hour"));
            result.add(new Sample(label, recorded && counters != null ? bytes(counters, "rx") : null, recorded && counters != null ? bytes(counters, "tx") : null));
        }
        return result;
    }
    static boolean validPreview(JSONObject value, String selected) {
        if (!selected.equals(value.optString("path")) || !value.optString("sha256").matches("[a-f0-9]{64}") || !value.optString("baselineSha256").matches("[a-f0-9]{64}")) return false;
        JSONArray changes = value.optJSONArray("changes"), hooks = value.optJSONArray("hooks"); if (changes == null || hooks == null) return false;
        for (int i = 0; i < changes.length(); i++) {
            JSONObject row = changes.optJSONObject(i); if (row == null || !Arrays.asList("foxytail.conf", "routes.conf", "context.conf").contains(row.optString("file")) || !(row.opt("key") instanceof String)) return false;
            for (String key : new String[]{"before", "after"}) if (!row.has(key) || (!row.isNull(key) && !(row.opt(key) instanceof String))) return false;
        }
        for (int i = 0; i < hooks.length(); i++) if (!Arrays.asList("foxytail.tun.up", "foxytail.tun.down").contains(hooks.optString(i))) return false;
        return true;
    }
    static String visibleLog(String line) {
        StringBuilder text = new StringBuilder(line.length());
        for (int i = 0; i < line.length(); i++) {
            char value = line.charAt(i);
            if (Character.isISOControl(value) && value != '\t' && value != '\n' && value != '\r') text.append(String.format(Locale.ROOT, "\\u%04x", (int) value));
            else text.append(value);
        }
        return text.toString();
    }
    static boolean matches(String line, String query, boolean matchCase) { return matchCase ? line.contains(query) : line.toLowerCase(Locale.ROOT).contains(query.toLowerCase(Locale.ROOT)); }
}
