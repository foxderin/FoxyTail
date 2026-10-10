package dev.foxderin.tail;

import android.text.InputType;
import android.view.View;
import android.widget.*;
import org.json.*;

final class ServePage extends ControlPage {
    private final LinearLayout privateRows, publicRows, protocolHost, portHost, numericPort;
    private final EditText port, target;
    private final MaterialChoice kind, funnelPort;
    private MaterialChoice protocol;
    private final TextView publicHint, formError;
    private static final String[] PROTOCOLS = {"https", "http", "tcp", "tls-terminated-tcp"};
    private static final String[] FUNNEL_PORTS = {"443", "8443", "10000"};
    ServePage(ControlActivity activity) {
        super(activity);
        LinearLayout privateCard = section(s(R.string.web_serve_serve), R.drawable.ic_vpn_key, s(R.string.web_tools_serve_private));
        ControlUi.cardAction(privateCard, textButton(privateCard, s(R.string.web_tools_refresh), () -> loadKind(false)));
        privateRows = group(privateCard);
        LinearLayout publicCard = section(s(R.string.web_serve_funnel), R.drawable.ic_dns, s(R.string.web_tools_serve_public));
        ControlUi.cardAction(publicCard, textButton(publicCard, s(R.string.web_tools_refresh), () -> loadKind(true)));
        publicRows = group(publicCard);
        LinearLayout form = section(s(R.string.web_serve_add), R.drawable.ic_add, null);
        kind = choice(form, new String[]{"Serve · " + s(R.string.web_tools_serve_private), "Funnel · " + s(R.string.web_tools_serve_public)}, activity.drafts.getInt("serve.kind", 0), index -> {
            activity.drafts.putInt("serve.kind", index); updateKind();
        });
        kind.setHint(s(R.string.web_serve_kind));
        publicHint = hint(form, s(R.string.web_tools_serve_public_hint));
        LinearLayout fields = group(form);
        if (activity.getResources().getConfiguration().screenWidthDp > 390) fields.setOrientation(LinearLayout.HORIZONTAL);
        protocolHost = group(fields); portHost = group(fields);
        if (fields.getOrientation() == LinearLayout.HORIZONTAL) {
            protocolHost.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1); params.setMarginStart(dp(12)); portHost.setLayoutParams(params);
        }
        numericPort = group(portHost);
        port = input(numericPort, s(R.string.web_tools_serve_listener_port), activity.drafts.getString("serve.port", ""), InputType.TYPE_CLASS_NUMBER); port.setHint("443");
        funnelPort = choice(portHost, FUNNEL_PORTS, 0, index -> port.setText(FUNNEL_PORTS[index])); funnelPort.setHint(s(R.string.web_tools_serve_listener_port));
        target = input(form, s(R.string.web_tools_serve_local_target), activity.drafts.getString("serve.target", ""), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        ToolsUi.draft(this, port, "serve.port"); ToolsUi.draft(this, target, "serve.target");
        formError = label(form, ""); formError.setVisibility(View.GONE);
        primary(form, s(R.string.web_serve_add), R.drawable.ic_add, this::add);
        updateKind();
    }
    private LinearLayout group(LinearLayout parent) { LinearLayout view = new LinearLayout(activity); view.setOrientation(LinearLayout.VERTICAL); parent.addView(view, new LinearLayout.LayoutParams(-1, -2)); return view; }
    private int protocolIndex() { int selected = protocol.getSelectedItemPosition(); return kind.getSelectedItemPosition() == 1 && selected > 0 ? selected + 1 : selected; }
    private void updateKind() {
        boolean funnel = kind.getSelectedItemPosition() == 1;
        int selected = activity.drafts.getInt("serve.protocol", 0);
        if (funnel && selected == 1) selected = 0;
        activity.drafts.putInt("serve.protocol", selected);
        protocolHost.removeAllViews();
        protocol = choice(protocolHost, funnel ? new String[]{"HTTPS", "TCP", "TLS → TCP"} : new String[]{"HTTPS", "HTTP", "TCP", "TLS → TCP"}, funnel && selected > 1 ? selected - 1 : selected, index -> { activity.drafts.putInt("serve.protocol", protocolIndex()); updateTarget(); });
        protocol.setHint(s(R.string.web_tools_serve_listener_protocol));
        publicHint.setVisibility(funnel ? View.VISIBLE : View.GONE);
        numericPort.setVisibility(funnel ? View.GONE : View.VISIBLE); funnelPort.setVisibility(funnel ? View.VISIBLE : View.GONE);
        if (funnel) {
            int index = java.util.Arrays.asList(FUNNEL_PORTS).indexOf(port.getText().toString().trim());
            if (index < 0) index = 0;
            funnelPort.setSelection(index); port.setText(FUNNEL_PORTS[index]);
        }
        updateTarget();
    }
    private void updateTarget() { target.setHint(PROTOCOLS[protocolIndex()].contains("tcp") ? "localhost:3000" : "http://localhost:3000"); formError.setVisibility(View.GONE); }
    String title() { return s(R.string.web_serve_title); }
    void load() { loadKind(false); loadKind(true); }
    private void loadKind(boolean funnel) {
        LinearLayout rows = funnel ? publicRows : privateRows;
        read(result -> {
            rows.removeAllViews();
            try {
                java.util.List<ToolsData.Mapping> mappings = ToolsData.mappings(result.getJSONObject("status"));
                int count = 0; for (ToolsData.Mapping mapping : mappings) if (mapping.funnel == funnel) count++;
                badge(rows, count + " " + s(R.string.web_tools_mapping_count), funnel && count > 0 ? ControlUi.TONE_WARN : ControlUi.TONE_NEUTRAL);
                for (ToolsData.Mapping mapping : mappings) {
                    if (mapping.funnel != funnel) continue;
                    String endpoint = mapping.protocol + " " + mapping.host + ":" + mapping.port + (mapping.path == null ? "" : mapping.path);
                    LinearLayout entry = row(rows); entry.setGravity(android.view.Gravity.CENTER_VERTICAL);
                    LinearLayout main = group(entry); main.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
                    mono(main, endpoint); if (!mapping.target.isEmpty()) mono(main, "→ " + mapping.target);
                    View remove = ControlUi.iconButton(activity, R.drawable.ic_delete, s(R.string.web_delete) + " " + endpoint, () -> confirm(s(R.string.web_delete), s(R.string.web_serve_del_confirm), () -> mutate(s(R.string.web_delete), done -> { if (ToolsUi.success(this, done)) load(); }, mapping.deleteArgs())));
                    entry.addView(remove); remove.setEnabled(!mapping.protocol.equals("unknown") && activity.client.canWrite() && !activity.client.busy());
                }
                if (count == 0) label(rows, s(R.string.web_serve_empty));
            } catch (Exception failure) { error(failure); }
        }, failure -> { rows.removeAllViews(); label(rows, failure.getMessage()); textButton(rows, s(R.string.web_tools_refresh), () -> loadKind(funnel)); }, funnel ? "funnel-list" : "serve-list");
    }
    private void add() {
        String portDraft = port.getText().toString(), targetDraft = target.getText().toString();
        int kindDraft = kind.getSelectedItemPosition(), protocolDraft = protocolIndex();
        String p = portDraft.trim(), destination = targetDraft.trim(), proto = PROTOCOLS[protocolDraft]; boolean funnel = kindDraft == 1;
        if (!ToolsData.port(p)) { formError.setText(s(R.string.web_tools_port_invalid)); formError.setVisibility(View.VISIBLE); return; }
        if (destination.isEmpty()) return;
        if (funnel && (proto.equals("http") || !java.util.Arrays.asList(FUNNEL_PORTS).contains(p))) { formError.setText(s(R.string.web_tools_funnel_port_invalid)); formError.setVisibility(View.VISIBLE); return; }
        Runnable submit = () -> mutate(s(R.string.web_serve_add), result -> {
            if (ToolsUi.success(this, result)) {
                if (sameDraft(portDraft, targetDraft, kindDraft, protocolDraft, port.getText().toString(), target.getText().toString(), kind.getSelectedItemPosition(), protocolIndex())) target.setText("");
                notice(s(R.string.web_tools_serve_add_done)); load();
            } else { formError.setText(result.optString("error", s(R.string.web_error))); formError.setVisibility(View.VISIBLE); }
        }, funnel ? "funnel-set" : "serve-set", proto, p, destination);
        if (funnel) confirm(s(R.string.web_serve_funnel), s(R.string.web_tools_serve_public_hint) + "\n" + proto + ":" + p + " → " + destination, submit); else submit.run();
    }
    static boolean sameDraft(String submittedPort, String submittedTarget, int submittedKind, int submittedProtocol,
                             String currentPort, String currentTarget, int currentKind, int currentProtocol) {
        return submittedPort.equals(currentPort) && submittedTarget.equals(currentTarget) && submittedKind == currentKind && submittedProtocol == currentProtocol;
    }
}
