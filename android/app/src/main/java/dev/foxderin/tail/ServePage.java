package dev.foxderin.tail;

import android.text.InputType;
import android.widget.*;
import org.json.*;

final class ServePage extends ControlPage {
    private final LinearLayout privateRows, publicRows;
    private final EditText port, target;
    private final MaterialChoice kind, protocol;
    private static final String[] PROTOCOLS = {"https", "http", "tcp", "tls-terminated-tcp"};
    ServePage(ControlActivity activity) {
        super(activity);
        privateRows = section(s(R.string.tools_serve_private)); publicRows = section(s(R.string.tools_serve_public));
        LinearLayout form = section(s(R.string.tools_add_mapping));
        label(form, s(R.string.tools_public_warning));
        kind = choice(form, new String[]{s(R.string.tools_serve_private), s(R.string.tools_serve_public)}, activity.drafts.getInt("serve.kind", 0), index -> activity.drafts.putInt("serve.kind", index));
        protocol = choice(form, PROTOCOLS, activity.drafts.getInt("serve.protocol", 0), index -> activity.drafts.putInt("serve.protocol", index));
        port = input(form, s(R.string.tools_port), activity.drafts.getString("serve.port", "443"), InputType.TYPE_CLASS_NUMBER);
        target = input(form, s(R.string.tools_target), activity.drafts.getString("serve.target", ""), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        ToolsUi.draft(this, port, "serve.port"); ToolsUi.draft(this, target, "serve.target");
        button(form, s(R.string.tools_add_mapping), this::add);
        button(form, s(R.string.tools_refresh), this::load);
    }
    String title() { return s(R.string.tools_serve); }
    void load() { loadKind(false); loadKind(true); }
    private void loadKind(boolean funnel) {
        LinearLayout rows = funnel ? publicRows : privateRows;
        read(result -> {
            rows.removeAllViews(); label(rows, s(funnel ? R.string.tools_serve_public : R.string.tools_serve_private));
            try {
                JSONObject status = result.getJSONObject("status"); int count = 0;
                for (ToolsData.Mapping mapping : ToolsData.mappings(status)) {
                    if (mapping.funnel != funnel) continue; count++;
                    String endpoint = mapping.protocol + " " + mapping.host + ":" + mapping.port + (mapping.path == null ? "" : mapping.path);
                    mono(rows, endpoint + "\n→ " + mapping.target);
                    Button remove = button(rows, s(R.string.tools_delete), () -> confirm(s(R.string.tools_delete), s(R.string.tools_delete_mapping, endpoint), () -> mutate(s(R.string.tools_delete), done -> { if (ToolsUi.success(this, done)) load(); }, mapping.deleteArgs())));
                    remove.setEnabled(!mapping.protocol.equals("unknown"));
                }
                if (count == 0) label(rows, s(R.string.tools_no_mappings));
            } catch (Exception error) { error(error); }
        }, failure -> { rows.removeAllViews(); label(rows, s(R.string.tools_failed) + "\n" + failure.getMessage()); }, funnel ? "funnel-list" : "serve-list");
    }
    private void add() {
        String p = port.getText().toString().trim(), destination = target.getText().toString().trim(), proto = PROTOCOLS[protocol.getSelectedItemPosition()]; boolean funnel = kind.getSelectedItemPosition() == 1;
        if (!ToolsData.port(p) || destination.isEmpty() || (funnel && (proto.equals("http") || !(p.equals("443") || p.equals("8443") || p.equals("10000"))))) { notice(s(R.string.tools_serve_validation)); return; }
        Runnable submit = () -> mutate(s(R.string.tools_add_mapping), result -> { if (ToolsUi.success(this, result)) { target.setText(""); load(); } }, funnel ? "funnel-set" : "serve-set", proto, p, destination);
        if (funnel) confirm(s(R.string.tools_serve_public), s(R.string.tools_public_warning) + "\n" + proto + ":" + p + " → " + destination, submit); else submit.run();
    }
}
