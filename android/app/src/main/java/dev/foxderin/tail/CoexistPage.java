package dev.foxderin.tail;

import android.text.InputType;
import android.widget.*;
import org.json.*;

final class CoexistPage extends ControlPage {
    private JSONObject info, peer;
    private String address = "", snippet = "";
    private final LinearLayout inventory, targets, addressRows, results;
    private final TextView yaml;
    private final MaterialChoice filter;
    private final EditText targetPort, resolverPort;
    private int generation;
    private static final String[] FILTERS = {"", "blacklist", "rule", "redir-host", "whitelist"};
    CoexistPage(ControlActivity activity) {
        super(activity);
        LinearLayout intro = section(s(R.string.tools_coexist));
        label(intro, s(R.string.tools_coexist_readonly));
        button(intro, s(R.string.tools_detect), this::detect);
        inventory = section(s(R.string.tools_environment));
        LinearLayout fragment = section(s(R.string.tools_fragment));
        label(fragment, s(R.string.tools_fragment_help));
        filter = choice(fragment, new String[]{s(R.string.tools_choose_filter), "fake-ip · blacklist", "fake-ip · rule", "redir-host", "fake-ip · whitelist"}, activity.drafts.getInt("coexist.filter", 0), index -> { activity.drafts.putInt("coexist.filter", index); invalidate(); renderSnippet(); });
        yaml = mono(fragment, "");
        button(fragment, s(R.string.tools_copy), this::copySnippet);
        targets = section(s(R.string.tools_peer)); addressRows = section(s(R.string.tools_address));
        LinearLayout check = section(s(R.string.tools_check));
        label(check, s(R.string.tools_coexist_ports));
        targetPort = input(check, s(R.string.tools_target_port), activity.drafts.getString("coexist.targetPort", ""), InputType.TYPE_CLASS_NUMBER);
        resolverPort = input(check, s(R.string.tools_resolver_port), activity.drafts.getString("coexist.resolverPort", ""), InputType.TYPE_CLASS_NUMBER);
        ToolsUi.draft(this, targetPort, "coexist.targetPort"); ToolsUi.draft(this, resolverPort, "coexist.resolverPort");
        ToolsUi.watch(targetPort, this::invalidate); ToolsUi.watch(resolverPort, this::invalidate);
        button(check, s(R.string.tools_check), this::check);
        results = section(s(R.string.tools_results));
        label(check, s(R.string.tools_coexist_boundary));
    }
    String title() { return s(R.string.tools_coexist); }
    void load() {
        info = null; peer = null; address = ""; invalidate(); inventory.removeAllViews(); targets.removeAllViews(); addressRows.removeAllViews();
        label(inventory, s(R.string.tools_detect_first)); renderSnippet();
    }
    void onPause() { generation++; }
    @Override void operationFinished(String command) {
        if (!"coexist-info".equals(command) && !"coexist-check".equals(command)) super.operationFinished(command);
    }
    private void copySnippet() {
        if (info == null || snippet.isEmpty()) return;
        String expected = info.optString("snapshot"), text = snippet; int ticket = generation;
        read(current -> {
            if (ticket != generation) return;
            if (!expected.equals(current.optString("snapshot")) || !current.optBoolean("dnsReady")) { load(); notice(s(R.string.tools_snapshot_invalid)); return; }
            copy(s(R.string.tools_fragment), text);
        }, "coexist-info");
    }
    private void invalidate() { generation++; if (results != null) results.removeAllViews(); }
    private void detect() {
        load(); int ticket = generation;
        probe(s(R.string.tools_detect), response -> {
            if (ticket != generation || !ToolsUi.success(this, response)) return;
            if (!response.optString("snapshot").matches("[a-f0-9]{64}") || response.optJSONArray("peers") == null || response.optJSONObject("dns") == null || response.optJSONObject("environment") == null) { notice(s(R.string.tools_invalid_response)); return; }
            info = response; inventory.removeAllViews();
            label(inventory, s(R.string.tools_applied_mode) + ": " + response.optString("mode") + "\n" + s(R.string.tools_suffix) + ": " + response.optString("suffix"));
            JSONObject dns = ToolsData.object(response, "dns");
            label(inventory, "DNS: " + dns.optString("mode") + " · " + dns.optString("policyState") + " · 127.0.0.1:" + dns.optString("port"));
            label(inventory, s(R.string.tools_path) + ": " + (response.optString("mode").equals("tun") ? "tailscale0" : "SOCKS5 127.0.0.1:" + response.optString("socksPort")));
            JSONObject environment = ToolsData.object(response, "environment");
            for (String category : new String[]{"modules", "apps"}) {
                JSONArray rows = ToolsData.array(environment, category);
                for (int i = 0; i < rows.length(); i++) { JSONObject row = rows.optJSONObject(i); if (row != null) label(inventory, row.optString(category.equals("apps") ? "package" : "name") + " · " + row.optString("kind")); }
            }
            if (!environment.isNull("alert")) label(inventory, environment.optString("alert"));
            JSONArray warnings = ToolsData.array(environment, "warnings"); for (int i = 0; i < warnings.length(); i++) label(inventory, warnings.optString(i));
            if (!response.optBoolean("dnsReady")) { label(inventory, s(R.string.tools_dns_prerequisite)); button(inventory, s(R.string.tools_settings), () -> activity.navigate("settings")); }
            JSONArray peers = ToolsData.array(response, "peers"); String[] names = new String[peers.length() + 1]; names[0] = s(R.string.tools_choose_peer);
            for (int i = 0; i < peers.length(); i++) { JSONObject p = peers.optJSONObject(i); names[i + 1] = p == null ? "—" : p.optString("dnsName") + (p.optBoolean("online") ? "" : " · " + s(R.string.tools_offline)); }
            choice(targets, names, 0, index -> {
                invalidate(); peer = index == 0 ? null : peers.optJSONObject(index - 1); address = ""; addressRows.removeAllViews();
                JSONArray ips = peer == null ? new JSONArray() : ToolsData.array(peer, "ips"); String[] addresses = new String[ips.length() + 1]; addresses[0] = s(R.string.tools_choose_address);
                for (int i = 0; i < ips.length(); i++) addresses[i + 1] = ips.optString(i);
                choice(addressRows, addresses, 0, selected -> { invalidate(); address = selected == 0 ? "" : addresses[selected]; });
            });
            renderSnippet();
        }, "coexist-info");
    }
    private void renderSnippet() {
        if (yaml == null || filter == null) return;
        snippet = ""; String mode = FILTERS[filter.getSelectedItemPosition()];
        if (mode.equals("whitelist")) yaml.setText(s(R.string.tools_whitelist_refused));
        else if (info == null || mode.isEmpty()) yaml.setText(s(R.string.tools_detect_first));
        else try { snippet = ToolsData.snippet(info, mode); yaml.setText(snippet); } catch (Exception error) { yaml.setText(s(R.string.tools_snapshot_invalid) + "\n" + error.getMessage()); }
    }
    private void check() {
        String port = targetPort.getText().toString().trim(), resolver = resolverPort.getText().toString().trim();
        if (info == null || !info.optBoolean("dnsReady") || peer == null || address.isEmpty() || !ToolsData.port(port) || (!resolver.isEmpty() && (!ToolsData.port(resolver) || Integer.parseInt(resolver) == ToolsData.object(info, "dns").optInt("port")))) { notice(s(R.string.tools_coexist_validation)); return; }
        invalidate(); int ticket = generation; String snapshot = info.optString("snapshot"), name = peer.optString("dnsName"), ip = address, path = info.optString("mode").equals("tun") ? "system" : "socks5", id = peer.optString("id");
        probe(s(R.string.tools_check), response -> {
            if (ticket != generation) return;
            if (!ToolsUi.success(this, response) || !snapshot.equals(response.optString("snapshot")) || !name.equals(response.optString("name")) || !ip.equals(response.optString("address")) || response.optInt("targetPort") != Integer.parseInt(port) || !path.equals(response.optString("path"))) { info = null; renderSnippet(); label(results, s(R.string.tools_snapshot_invalid)); return; }
            label(results, name + "\n" + ip + ":" + port + " · " + path);
            String[] ids = {"dns-udp", "dns-tcp", "resolver-udp", "resolver-tcp", "tcp"};
            int[] labels = {R.string.tools_dns_udp, R.string.tools_dns_tcp, R.string.tools_resolver_udp, R.string.tools_resolver_tcp, R.string.tools_target_tcp}; JSONArray checks = ToolsData.array(response, "checks");
            for (int j = 0; j < ids.length; j++) {
                JSONObject found = null; for (int i = 0; i < checks.length(); i++) { JSONObject item = checks.optJSONObject(i); if (item != null && ids[j].equals(item.optString("id"))) found = item; }
                String state = found == null ? s(ids[j].startsWith("resolver-") && resolver.isEmpty() ? R.string.tools_skipped : R.string.tools_unchecked) : s(found.optBoolean("ok") ? R.string.tools_pass : R.string.tools_fail);
                label(results, s(labels[j]) + " · " + state);
                if (found != null) { label(results, found.optLong("elapsedMs") + " ms"); if (found.has("error")) label(results, found.optString("error")); JSONArray observed = ToolsData.array(found, "addresses"); for (int i = 0; i < observed.length(); i++) mono(results, observed.optString(i)); }
            }
        }, "coexist-check", snapshot, id, ip, port, resolver.isEmpty() ? "-" : resolver);
    }
}
