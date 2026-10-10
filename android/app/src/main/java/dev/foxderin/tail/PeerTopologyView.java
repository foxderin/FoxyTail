package dev.foxderin.tail;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.text.TextUtils;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.google.android.material.color.MaterialColors;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Consumer;

/** Native port of TopologyChart: twelve ranked nodes, region pills, and a complete disclosure list. */
final class PeerTopologyView extends LinearLayout {
    PeerTopologyView(Context context, String self, String exitId, List<JSONObject> peers, Consumer<JSONObject> selected) {
        super(context); setOrientation(VERTICAL);
        List<JSONObject> shown = diagramPeers(peers);
        TextView legend = ControlUi.muted(context, "● " + context.getString(R.string.web_net_filter_online) + "   ○ " + context.getString(R.string.web_net_filter_offline) +
                "   ─ " + context.getString(R.string.web_net_topo_direct) + "   ┄ " + context.getString(R.string.web_net_topo_relay) +
                "\n" + shown.size() + " / " + peers.size() + " " + context.getString(R.string.web_net_peer_total), R.dimen.ft_caption);
        addView(legend);
        addView(new Diagram(context, self, exitId, shown, selected), new LinearLayout.LayoutParams(-1, -2));
        LinearLayout fullList = new LinearLayout(context); fullList.setOrientation(VERTICAL); fullList.setVisibility(GONE);
        Button toggle = ControlUi.textButton(context, context.getString(R.string.web_net_topology_list) + " · " + peers.size(), () -> {
            boolean open = fullList.getVisibility() != VISIBLE; fullList.setVisibility(open ? VISIBLE : GONE);
        });
        addView(toggle, new LinearLayout.LayoutParams(-1, -2)); addView(fullList, new LinearLayout.LayoutParams(-1, -2));
        for (JSONObject peer : peers) fullList.addView(ControlUi.textButton(context,
                (peer.optBoolean("online") ? "● " : "○ ") + peer.optString("hostname"), () -> selected.accept(peer)), new LinearLayout.LayoutParams(-1, -2));
    }
    static List<JSONObject> diagramPeers(List<JSONObject> peers) {
        List<JSONObject> ordered = new ArrayList<>(peers);
        ordered.sort(Comparator.<JSONObject>comparingInt(PeerTopologyView::pathRank)
                .thenComparing(peer -> pathRank(peer) == 1 ? region(peer) : "", String.CASE_INSENSITIVE_ORDER)
                .thenComparing(peer -> peer.optString("hostname"), String.CASE_INSENSITIVE_ORDER));
        return new ArrayList<>(ordered.subList(0, Math.min(12, ordered.size())));
    }
    static int pathRank(JSONObject peer) { return !peer.optBoolean("online") ? 2 : peer.optString("curAddr", "").isEmpty() ? 1 : 0; }
    private static String region(JSONObject peer) { String value = peer.optString("relay", ""); return (value.isEmpty() ? "—" : value).toUpperCase(Locale.ROOT); }

    private static final class Diagram extends FrameLayout {
        private final String self, exitId;
        private final List<JSONObject> peers;
        private final android.text.TextPaint paint = new android.text.TextPaint(Paint.ANTI_ALIAS_FLAG);
        private final android.graphics.Typeface medium = android.graphics.Typeface.create("sans-serif-medium", 0);
        private final Path edge = new Path();
        private final RectF bounds = new RectF();
        private final android.graphics.DashPathEffect relayDash, offlineDash;
        private final Map<String, List<Integer>> regions = new TreeMap<>();
        private final int outline, surface, primary, onSurface, muted, active, inactive, container, onContainer, relaySurface;
        private final float density, font;
        private int columns;
        private float cell, gridTop, stride, cardHeight;
        Diagram(Context context, String self, String exitId, List<JSONObject> peers, Consumer<JSONObject> selected) {
            super(context); setWillNotDraw(false);
            this.self = self; this.exitId = exitId; this.peers = peers;
            density = getResources().getDisplayMetrics().density;
            font = Math.max(1, getResources().getConfiguration().fontScale);
            relayDash = new android.graphics.DashPathEffect(new float[]{dp(6), dp(4)}, 0);
            offlineDash = new android.graphics.DashPathEffect(new float[]{dp(4), dp(4)}, 0);
            outline = MaterialColors.getColor(this, com.google.android.material.R.attr.colorOutlineVariant);
            surface = MaterialColors.getColor(this, com.google.android.material.R.attr.colorSurface);
            primary = MaterialColors.getColor(this, androidx.appcompat.R.attr.colorPrimary);
            onSurface = MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurface);
            muted = MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnSurfaceVariant);
            container = MaterialColors.getColor(this, com.google.android.material.R.attr.colorPrimaryContainer);
            onContainer = MaterialColors.getColor(this, com.google.android.material.R.attr.colorOnPrimaryContainer);
            relaySurface = MaterialColors.getColor(this, com.google.android.material.R.attr.colorSurfaceContainerHigh);
            active = androidx.core.content.ContextCompat.getColor(context, R.color.foxy_ok);
            inactive = MaterialColors.getColor(this, com.google.android.material.R.attr.colorOutline);
            for (int i = 0; i < peers.size(); i++) {
                JSONObject peer = peers.get(i);
                if (pathRank(peer) == 1) regions.computeIfAbsent(region(peer), ignored -> new ArrayList<>()).add(i);
                Button target = new androidx.appcompat.widget.AppCompatButton(context);
                target.setBackgroundColor(android.graphics.Color.TRANSPARENT); target.setText("");
                target.setContentDescription(context.getString(R.string.web_net_peer_details) + ": " + peer.optString("hostname") + " · " +
                        String.join(" · ", PeersPage.addresses(peer)) + " · " + pathLabel(peer) +
                        (pathRank(peer) == 0 ? " · " + peer.optString("curAddr") : "") +
                        (exitId.equals(peer.optString("id")) ? " · " + context.getString(R.string.web_net_topo_exit) : ""));
                target.setOnClickListener(view -> selected.accept(peer));
                target.setOnFocusChangeListener((view, focus) -> invalidate());
                addView(target, new FrameLayout.LayoutParams(0, 0));
            }
        }
        private float dp(float value) { return value * density; }
        @Override protected void onMeasure(int widthSpec, int heightSpec) {
            int width = MeasureSpec.getSize(widthSpec);
            columns = width / density >= 560 ? 3 : 2;
            cell = (width - dp(20) - (columns - 1) * dp(14)) / columns;
            cardHeight = dp(66 * font); stride = dp(88 * font);
            gridTop = dp(118 * font + (regions.isEmpty() ? 0 : 40 * font));
            int height = Math.round(gridTop + ((peers.size() + columns - 1) / columns) * stride);
            for (int i = 0; i < getChildCount(); i++) getChildAt(i).measure(MeasureSpec.makeMeasureSpec(Math.round(cell), MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(Math.round(cardHeight), MeasureSpec.EXACTLY));
            setMeasuredDimension(width, height);
        }
        @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
            for (int i = 0; i < getChildCount(); i++) getChildAt(i).layout(Math.round(x(i)), Math.round(y(i)), Math.round(x(i) + cell), Math.round(y(i) + cardHeight));
        }
        private float x(int index) { return dp(10) + index % columns * (cell + dp(14)); }
        private float y(int index) { return gridTop + index / columns * stride; }
        private float center(List<Integer> indices) {
            float sum = 0; for (int index : indices) sum += x(index) + cell / 2;
            return Math.min(Math.max(sum / indices.size(), dp(50)), getWidth() - dp(50));
        }
        private String pathLabel(JSONObject peer) {
            return getContext().getString(pathRank(peer) == 0 ? R.string.web_net_topo_direct : pathRank(peer) == 1 ? R.string.web_net_topo_relay : R.string.web_net_filter_offline) +
                    (pathRank(peer) == 1 ? " " + region(peer) : "");
        }
        private void line(Canvas canvas, float x1, float y1, float x2, float y2, int rank) {
            paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(1.25f)); paint.setColor(rank == 0 ? primary : outline);
            paint.setAlpha(rank == 0 ? 102 : rank == 2 ? 153 : 255); paint.setPathEffect(rank == 0 ? null : rank == 2 ? offlineDash : relayDash);
            edge.reset(); edge.moveTo(x1, y1); edge.lineTo(x2, y1); edge.lineTo(x2, y2); canvas.drawPath(edge, paint);
            paint.setPathEffect(null); paint.setAlpha(255);
        }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas); float center = getWidth() / 2f, bus = dp(93 * font), pillTop = dp(109 * font), pillBottom = dp(127 * font);
            paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(1.5f)); paint.setColor(outline);
            canvas.drawLine(center, dp(71 * font), center, bus, paint);
            for (int i = 0; i < peers.size(); i++) if (pathRank(peers.get(i)) != 1) line(canvas, center, bus, x(i) + cell / 2, gridTop, pathRank(peers.get(i)));
            for (Map.Entry<String, List<Integer>> region : regions.entrySet()) {
                float cx = center(region.getValue()); line(canvas, center, bus, cx, pillTop, 1);
                for (int index : region.getValue()) {
                    float middle = (pillBottom + gridTop) / 2;
                    line(canvas, cx, pillBottom, cx, middle, 1); line(canvas, cx, middle, x(index) + cell / 2, gridTop, 1);
                }
                float width = dp(Math.max(36, region.getKey().length() * 7 + 16) * font);
                bounds.set(cx - width / 2, pillTop, cx + width / 2, pillBottom);
                paint.setStyle(Paint.Style.FILL); paint.setColor(relaySurface); canvas.drawRoundRect(bounds, dp(10), dp(10), paint);
                paint.setStyle(Paint.Style.STROKE); paint.setColor(outline); canvas.drawRoundRect(bounds, dp(10), dp(10), paint);
                text(canvas, region.getKey(), cx, pillTop + dp(12.5f * font), width, 9, muted, false, true);
            }
            paint.setStyle(Paint.Style.FILL); paint.setColor(container);
            canvas.drawRoundRect(center - dp(92), dp(6 * font), center + dp(92), dp(71 * font), dp(15), dp(15), paint);
            String hostname = self.isEmpty() ? getContext().getString(R.string.web_dash_self) : self;
            text(canvas, hostname.substring(0, Math.min(25, hostname.length())), center, dp(31 * font), dp(174), 13, onContainer, true, true);
            text(canvas, getContext().getString(R.string.web_dash_self) + " · Tailnet", center, dp(51 * font), dp(174), 10, onContainer, false, true);
            for (int i = 0; i < peers.size(); i++) {
                JSONObject peer = peers.get(i); float left = x(i), top = y(i);
                bounds.set(left, top, left + cell, top + cardHeight);
                paint.setStyle(Paint.Style.FILL); paint.setColor(surface); canvas.drawRoundRect(bounds, dp(12), dp(12), paint);
                boolean highlighted = exitId.equals(peer.optString("id")) || getChildAt(i).hasFocus();
                paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(highlighted ? 2 : 1)); paint.setColor(highlighted ? primary : outline);
                canvas.drawRoundRect(bounds, dp(12), dp(12), paint);
                paint.setStyle(Paint.Style.FILL); paint.setColor(peer.optBoolean("online") ? active : inactive);
                canvas.drawCircle(left + dp(14), top + dp(21 * font), dp(3.5f), paint);
                int max = Math.max(11, (int) ((cell / density - 26) / 7)); String name = peer.optString("hostname");
                if (name.length() > max) name = name.substring(0, max - 1) + "…";
                text(canvas, name, left + dp(25), top + dp(25 * font), cell - dp(30), 11, onSurface, true, false);
                String os = peer.optString("os", "");
                text(canvas, (os.isEmpty() ? "—" : os) + " · " + pathLabel(peer), left + dp(14), top + dp(46 * font), cell - dp(20), 9, muted, false, false);
            }
        }
        private void text(Canvas canvas, String value, float x, float baseline, float width, int sp, int color, boolean bold, boolean centered) {
            paint.setStyle(Paint.Style.FILL); paint.setColor(color); paint.setTextSize(dp(sp * font));
            paint.setTypeface(bold ? medium : android.graphics.Typeface.DEFAULT);
            paint.setTextAlign(centered ? Paint.Align.CENTER : Paint.Align.LEFT);
            canvas.drawText(TextUtils.ellipsize(value, paint, Math.max(0, width), TextUtils.TruncateAt.END).toString(), x, baseline, paint);
        }
    }
}
