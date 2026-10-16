package dev.foxderin.tail;

import android.text.InputType;
import android.view.View;
import android.widget.*;
import org.json.*;

final class CoexistPage extends ControlPage {
    private JSONObject info, peer;
    private String address = "", snippet = "";
    private final LinearLayout inventory, filterGroup, fragment, targets, addressRows, checkControls, results;
    private final TextView yaml, checkHint, filterHint, pathHint, checking;
    private final Button copyButton, checkButton, detectButton;
    private final MaterialChoice filter;
    private final EditText targetPort, resolverPort;
    private int generation;
    private static final String[] FILTERS = {"", "blacklist", "rule", "redir-host", "whitelist"};
    CoexistPage(ControlActivity activity) {
        super(activity);
        LinearLayout wizard = section(s(R.string.web_coexist_title), R.drawable.ic_alt_route, s(R.string.web_coexist_intro));
        detectButton = tonal(wizard, s(R.string.web_coexist_detect), this::detect);
        inventory = group(wizard);
        filterGroup = group(wizard);
        label(filterGroup, s(R.string.web_coexist_filter_step));
        hint(filterGroup, s(R.string.web_coexist_core_hint));
        filter = choice(filterGroup, new String[]{s(R.string.web_coexist_filter_choose), "fake-ip · blacklist", "fake-ip · rule", "redir-host", s(R.string.web_coexist_filter_whitelist)}, activity.drafts.getInt("coexist.filter", 0), index -> { activity.drafts.putInt("coexist.filter", index); invalidate(); renderSnippet(); });
        filter.setHint(s(R.string.web_coexist_filter_label));
        filterHint = hint(filterGroup, ""); filterHint.setVisibility(View.GONE);
        fragment = group(wizard); label(fragment, s(R.string.web_coexist_snippet_step));
        hint(fragment, s(R.string.web_coexist_merge_hint));
        hint(fragment, s(R.string.web_coexist_scope_hint));
        hint(fragment, s(R.string.web_coexist_name_hint));
        pathHint = hint(fragment, "");
        hint(fragment, s(R.string.web_coexist_ipv6_hint));
        label(fragment, s(R.string.web_coexist_yaml)); yaml = mono(fragment, "");
        copyButton = button(fragment, s(R.string.web_copy), this::copySnippet); copyButton.setEnabled(false);
        targets = group(wizard); label(targets, s(R.string.web_coexist_check_step));
        addressRows = group(wizard);
        checkControls = group(wizard);
        LinearLayout ports = group(checkControls);
        if (activity.getResources().getConfiguration().screenWidthDp > 390) ports.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout targetField = group(ports), resolverField = group(ports);
        if (ports.getOrientation() == LinearLayout.HORIZONTAL) {
            targetField.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1); params.setMarginStart(dp(12)); resolverField.setLayoutParams(params);
        }
        targetPort = input(targetField, s(R.string.web_coexist_port), activity.drafts.getString("coexist.targetPort", ""), InputType.TYPE_CLASS_NUMBER);
        resolverPort = input(resolverField, s(R.string.web_coexist_resolver_port), activity.drafts.getString("coexist.resolverPort", ""), InputType.TYPE_CLASS_NUMBER);
        hint(checkControls, s(R.string.web_coexist_ports_hint));
        checkHint = hint(checkControls, s(R.string.web_coexist_invalid_port));
        checkButton = primary(checkControls, s(R.string.web_coexist_check), this::check); checkButton.setEnabled(false);
        checking = hint(checkControls, s(R.string.web_coexist_checking)); checking.setVisibility(View.GONE);
        ToolsUi.draft(this, targetPort, "coexist.targetPort"); ToolsUi.draft(this, resolverPort, "coexist.resolverPort");
        ToolsUi.watch(targetPort, this::invalidate); ToolsUi.watch(resolverPort, this::invalidate);
        results = group(wizard);
        updatePrerequisites();
    }
    private LinearLayout group(LinearLayout parent) { LinearLayout view = new LinearLayout(activity); view.setOrientation(LinearLayout.VERTICAL); parent.addView(view, new LinearLayout.LayoutParams(-1, -2)); return view; }
    String title() { return s(R.string.web_coexist_title); }
    void load() {
        info = null; peer = null; address = ""; invalidate(); inventory.removeAllViews(); targets.removeAllViews(); addressRows.removeAllViews();
        ControlUi.emptyState(inventory, s(R.string.web_coexist_unchecked), R.drawable.ic_info); detectButton.setText(s(R.string.web_coexist_detect)); renderSnippet();
    }
    void onPause() { generation++; }
    @Override void operationFinished(String command) {
        if (!"coexist-info".equals(command) && !"coexist-check".equals(command)) super.operationFinished(command);
    }
    private void copySnippet() {
        if (!snippetAvailable(info, snippet)) { notice(s(R.string.tools_detect_first)); return; }
        String expected = info.optString("snapshot"), text = snippet; int ticket = generation;
        read(current -> {
            if (ticket != generation) { notice(s(R.string.web_coexist_context_changed)); return; }
            if (!expected.equals(current.optString("snapshot")) || !current.optBoolean("dnsReady")) { load(); notice(s(R.string.web_coexist_context_changed)); return; }
            copy(s(R.string.web_coexist_yaml), text);
        }, "coexist-info");
    }
    private void invalidate() {
        generation++; if (results != null) { results.removeAllViews(); results.setVisibility(View.GONE); }
        updatePrerequisites();
    }
    private void updatePrerequisites() {
        boolean ready = info != null && info.optBoolean("ok") && info.optBoolean("dnsReady");
        if (filter != null) filter.setEnabled(ready);
        if (filterGroup != null) filterGroup.setVisibility(ready ? View.VISIBLE : View.GONE);
        if (fragment != null) fragment.setVisibility(snippetAvailable(info, snippet) ? View.VISIBLE : View.GONE);
        if (targets != null) targets.setVisibility(ready ? View.VISIBLE : View.GONE);
        boolean peers = ready && ToolsData.array(info, "peers").length() > 0;
        if (addressRows != null) addressRows.setVisibility(peers ? View.VISIBLE : View.GONE);
        if (checkControls != null) checkControls.setVisibility(peers ? View.VISIBLE : View.GONE);
        if (copyButton != null) copyButton.setEnabled(snippetAvailable(info, snippet));
        if (checkButton != null) {
            String port = targetPort.getText().toString().trim(), resolver = resolverPort.getText().toString().trim();
            checkButton.setEnabled(canCheck(info, peer, address, port, resolver) && activity.client.canWrite());
            boolean invalid = !port.isEmpty() && !ToolsData.port(port) || !resolver.isEmpty() && (!ToolsData.port(resolver) || ready && Integer.parseInt(resolver) == ToolsData.object(info, "dns").optInt("port"));
            checkHint.setVisibility(invalid ? View.VISIBLE : View.GONE);
        }
    }
    static boolean snippetAvailable(JSONObject info, String snippet) { return info != null && info.optBoolean("ok") && info.optBoolean("dnsReady") && !snippet.isEmpty(); }
    static boolean canCheck(JSONObject info, JSONObject peer, String address, String port, String resolver) {
        if (info == null || !info.optBoolean("ok") || !info.optBoolean("dnsReady") || peer == null || peer.optString("id").isEmpty() || peer.optString("dnsName").isEmpty()
                || address.isEmpty() || !ToolsData.port(port) || (!resolver.isEmpty() && (!ToolsData.port(resolver) || Integer.parseInt(resolver) == ToolsData.object(info, "dns").optInt("port")))) return false;
        JSONArray ips = ToolsData.array(peer, "ips");
        for (int i = 0; i < ips.length(); i++) if (address.equals(ips.optString(i))) return true;
        return false;
    }
    private void detect() {
        if (!activity.client.canWrite() || activity.client.busy()) { notice(activity.client.message()); return; }
        load(); int ticket = generation;
        probe(s(R.string.web_coexist_detect), response -> {
            if (ticket != generation || !ToolsUi.success(this, response)) return;
            if (!response.optString("snapshot").matches("[a-f0-9]{64}") || response.optJSONArray("peers") == null || response.optJSONObject("dns") == null || response.optJSONObject("environment") == null) { notice(s(R.string.tools_invalid_response)); return; }
            info = response; inventory.removeAllViews(); detectButton.setText(s(R.string.web_coexist_refresh));
            label(inventory, s(R.string.web_coexist_environment));
            hint(inventory, s(R.string.web_coexist_inventory_hint));
            JSONObject environment = ToolsData.object(response, "environment");
            if (ToolsData.array(environment, "modules").length() + ToolsData.array(environment, "apps").length() == 0) hint(inventory, s(R.string.web_coexist_inventory_empty));
            for (String category : new String[]{"modules", "apps"}) {
                JSONArray rows = ToolsData.array(environment, category);
                for (int i = 0; i < rows.length(); i++) { JSONObject row = rows.optJSONObject(i); if (row != null) label(inventory, row.optString(category.equals("apps") ? "package" : "name") + " · " + row.optString("kind")); }
            }
            if (!environment.isNull("alert")) label(inventory, environment.optString("alert"));
            JSONArray warnings = ToolsData.array(environment, "warnings"); for (int i = 0; i < warnings.length(); i++) label(inventory, warnings.optString(i));
            label(inventory, s(R.string.web_coexist_applied_mode) + ": " + response.optString("mode"));
            label(inventory, s(R.string.web_dns_suffix) + ": " + response.optString("suffix"));
            JSONObject dns = ToolsData.object(response, "dns");
            label(inventory, s(R.string.web_dns_title)); badge(inventory, s(TunnelPage.dnsLabel(dns)), response.optBoolean("dnsReady") ? ControlUi.TONE_OK : ControlUi.TONE_NEUTRAL);
            if (!response.optBoolean("dnsReady")) { hint(inventory, s(R.string.web_coexist_prerequisite)); iconButton(inventory, R.drawable.ic_settings, s(R.string.web_tools_dns_settings), () -> activity.navigate("settings")); }
            else {
                label(inventory, s(R.string.web_tools_dns_endpoint) + ": 127.0.0.1:" + dns.optString("port"));
                label(inventory, s(R.string.web_coexist_target_path) + ": " + (response.optString("mode").equals("tun") ? "tailscale0" : "SOCKS5 127.0.0.1:" + response.optString("socksPort")));
            }
            JSONArray peers = ToolsData.array(response, "peers");
            if (response.optBoolean("dnsReady")) {
                label(targets, s(R.string.web_coexist_check_step));
                hint(targets, s(R.string.web_coexist_check_hint));
                if (peers.length() == 0) label(targets, s(R.string.web_coexist_no_peers));
                else {
                    String[] names = new String[peers.length() + 1]; names[0] = s(R.string.web_coexist_peer_choose);
                    for (int i = 0; i < peers.length(); i++) { JSONObject p = peers.optJSONObject(i); names[i + 1] = p == null ? "—" : p.optString("dnsName") + (p.optBoolean("online") ? "" : " · " + s(R.string.web_offline)); }
                    showAddresses();
                    MaterialChoice peerChoice = choice(targets, names, 0, index -> {
                        invalidate(); peer = index == 0 ? null : peers.optJSONObject(index - 1); address = ""; showAddresses();
                        updatePrerequisites();
                    });
                    peerChoice.setHint(s(R.string.web_coexist_peer));
                }
            }
            renderSnippet();
        }, "coexist-info");
    }
    private void renderSnippet() {
        if (yaml == null || filter == null) return;
        snippet = ""; String mode = FILTERS[filter.getSelectedItemPosition()];
        filterHint.setVisibility(View.GONE);
        if (info != null && info.optBoolean("dnsReady")) {
            pathHint.setText(s(info.optString("mode").equals("tun") ? R.string.web_coexist_tun_hint : R.string.web_coexist_socks_hint));
            if (mode.equals("whitelist")) { filterHint.setText(s(R.string.web_coexist_whitelist_hint)); filterHint.setVisibility(View.VISIBLE); }
            else if (!mode.isEmpty()) try { snippet = ToolsData.snippet(info, mode); yaml.setText(snippet); } catch (Exception error) { filterHint.setText(s(R.string.web_coexist_invalid_snapshot)); filterHint.setVisibility(View.VISIBLE); }
        }
        updatePrerequisites();
    }
    private void showAddresses() {
        addressRows.removeAllViews(); JSONArray ips = peer == null ? new JSONArray() : ToolsData.array(peer, "ips");
        String[] addresses = new String[ips.length() + 1]; addresses[0] = s(R.string.web_coexist_address_choose);
        for (int i = 0; i < ips.length(); i++) addresses[i + 1] = ips.optString(i);
        MaterialChoice addressChoice = choice(addressRows, addresses, 0, selected -> { invalidate(); address = selected == 0 ? "" : addresses[selected]; updatePrerequisites(); });
        addressChoice.setHint(s(R.string.web_coexist_address)); addressChoice.setEnabled(peer != null);
    }
    private void check() {
        String port = targetPort.getText().toString().trim(), resolver = resolverPort.getText().toString().trim();
        if (!activity.client.canWrite() || activity.client.busy() || !canCheck(info, peer, address, port, resolver)) { notice(s(R.string.web_coexist_invalid_port)); return; }
        invalidate(); int ticket = generation; String snapshot = info.optString("snapshot"), name = peer.optString("dnsName"), ip = address, path = info.optString("mode").equals("tun") ? "system" : "socks5", id = peer.optString("id");
        checking.setVisibility(View.VISIBLE);
        probe(s(R.string.web_coexist_check), response -> {
            checking.setVisibility(View.GONE);
            if (ticket != generation) return;
            if (!ToolsUi.success(this, response) || !snapshot.equals(response.optString("snapshot")) || !name.equals(response.optString("name")) || !ip.equals(response.optString("address")) || response.optInt("targetPort") != Integer.parseInt(port) || !path.equals(response.optString("path"))) { load(); label(inventory, response.optString("error", s(R.string.web_coexist_context_changed))); return; }
            results.setVisibility(View.VISIBLE);
            label(results, s(R.string.web_coexist_peer) + ": " + name);
            label(results, s(R.string.web_coexist_target) + ": " + (ip.contains(":") ? "[" + ip + "]" : ip) + ":" + port);
            label(results, s(R.string.web_coexist_target_path) + ": " + s(path.equals("socks5") ? R.string.web_coexist_path_socks : R.string.web_coexist_path_system));
            String[] ids = {"dns-udp", "dns-tcp", "resolver-udp", "resolver-tcp", "tcp"};
            int[] labels = {R.string.web_coexist_dns_udp, R.string.web_coexist_dns_tcp, R.string.web_coexist_resolver_udp, R.string.web_coexist_resolver_tcp, R.string.web_coexist_tcp}; JSONArray checks = ToolsData.array(response, "checks");
            for (int j = 0; j < ids.length; j++) {
                JSONObject found = null; for (int i = 0; i < checks.length(); i++) { JSONObject item = checks.optJSONObject(i); if (item != null && ids[j].equals(item.optString("id"))) found = item; }
                String state = found == null ? s(ids[j].startsWith("resolver-") && resolver.isEmpty() ? R.string.web_coexist_skipped : R.string.web_coexist_not_checked) : s(found.optBoolean("ok") ? R.string.web_coexist_pass : R.string.web_coexist_fail);
                label(results, s(labels[j])); badge(results, state, found == null ? ControlUi.TONE_NEUTRAL : found.optBoolean("ok") ? ControlUi.TONE_OK : ControlUi.TONE_ERROR);
                if (found != null) { hint(results, found.optLong("elapsedMs") + " ms"); if (found.has("error")) hint(results, found.optString("error")); JSONArray observed = ToolsData.array(found, "addresses"); if (observed.length() > 0) { java.util.ArrayList<String> values = new java.util.ArrayList<>(); for (int i = 0; i < observed.length(); i++) values.add(observed.optString(i)); hint(results, s(R.string.web_coexist_observed) + ": " + String.join(", ", values)); } }
            }
            hint(results, s(R.string.web_coexist_result_boundary));
        }, "coexist-check", snapshot, id, ip, port, resolver.isEmpty() ? "-" : resolver);
    }
}
