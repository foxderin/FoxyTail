import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:foxytail/widgets/common.dart';
import 'observability_data.dart';

class TrafficChart extends StatefulWidget {
  const TrafficChart({super.key, required this.samples, required this.selected, required this.onSelected});
  final List<TrafficSample> samples;
  final int selected;
  final ValueChanged<int> onSelected;
  @override
  State<TrafficChart> createState() => _TrafficChartState();
}

class _TrafficChartState extends State<TrafficChart> {
  bool focused = false;
  void select(int index) {
    if (index >= 0 && index < widget.samples.length) widget.onSelected(index);
  }
  String readout(int index) {
    if (index < 0 || index >= widget.samples.length) return context.l10n.web_net_traffic_no_samples;
    final sample = widget.samples[index];
    final l = context.l10n;
    return '${sample.label}: ${l.web_traffic_rx} ${sample.rx == null ? l.web_net_traffic_unrecorded : formatBytes(sample.rx!)}, ${l.web_traffic_tx} ${sample.tx == null ? l.web_net_traffic_unrecorded : formatBytes(sample.tx!)}';
  }
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Focus(
      onFocusChange: (value) => setState(() => focused = value),
      onKeyEvent: (_, event) {
        if (event is! KeyDownEvent && event is! KeyRepeatEvent) return KeyEventResult.ignored;
        final key = event.logicalKey;
        final target = key == LogicalKeyboardKey.arrowLeft ? widget.selected - 1
            : key == LogicalKeyboardKey.arrowRight ? widget.selected + 1
            : key == LogicalKeyboardKey.home ? 0
            : key == LogicalKeyboardKey.end ? widget.samples.length - 1 : null;
        if (target == null || widget.samples.isEmpty) return KeyEventResult.ignored;
        select(target);
        return KeyEventResult.handled;
      },
      child: Semantics(
        label: context.l10n.web_net_traffic_chart,
        value: readout(widget.selected),
        slider: widget.samples.isNotEmpty,
        increasedValue: widget.selected + 1 < widget.samples.length ? readout(widget.selected + 1) : null,
        decreasedValue: widget.selected > 0 ? readout(widget.selected - 1) : null,
        onIncrease: widget.selected + 1 < widget.samples.length ? () => select(widget.selected + 1) : null,
        onDecrease: widget.selected > 0 ? () => select(widget.selected - 1) : null,
        child: LayoutBuilder(builder: (context, constraints) {
          final scale = MediaQuery.textScalerOf(context);
          final labels = <String>['0 B', formatBytes(_maximum(widget.samples))];
          double labelWidth = 0;
          for (final label in labels) {
            final text = TextPainter(text: TextSpan(text: label, style: const TextStyle(fontSize: 11)), textDirection: TextDirection.ltr, textScaler: scale)..layout();
            labelWidth = math.max(labelWidth, text.width);
          }
          final left = math.min(constraints.maxWidth / 2, labelWidth + 12);
          void at(double x) {
            if (widget.samples.isEmpty || constraints.maxWidth <= left + 12) return;
            select(widget.samples.length == 1 ? 0 : (((x - left) / (constraints.maxWidth - left - 12)) * (widget.samples.length - 1)).round().clamp(0, widget.samples.length - 1).toInt());
          }
          return GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTapUp: (details) => at(details.localPosition.dx),
            onHorizontalDragStart: (details) => at(details.localPosition.dx),
            onHorizontalDragUpdate: (details) => at(details.localPosition.dx),
            child: Container(
              decoration: BoxDecoration(border: Border.all(color: focused ? colors.primary : Colors.transparent), borderRadius: BorderRadius.circular(12)),
              child: CustomPaint(size: Size(constraints.maxWidth, 240 + scale.scale(14)),
                painter: _TrafficPainter(widget.samples, widget.selected, colors, scale, left)),
            ),
          );
        }),
      ),
    );
  }
}

double _maximum(List<TrafficSample> samples) {
  double maximum = 1;
  for (final sample in samples) maximum = math.max(maximum, math.max(sample.rx ?? 0, sample.tx ?? 0));
  final step = math.pow(10, (math.log(maximum) / math.ln10).floor()).toDouble();
  return (maximum / step).ceil() * step;
}

class _TrafficPainter extends CustomPainter {
  _TrafficPainter(this.samples, this.selected, this.colors, this.scale, this.left);
  final List<TrafficSample> samples;
  final int selected;
  final ColorScheme colors;
  final TextScaler scale;
  final double left;
  @override
  void paint(Canvas canvas, Size size) {
    final bottom = size.height - scale.scale(16) - 12;
    final width = size.width - left - 12;
    if (width <= 0) return;
    const top = 12.0;
    final maximum = _maximum(samples);
    double x(int index) => left + width * (samples.length == 1 ? .5 : index / (samples.length - 1));
    double y(double value) => bottom - value / maximum * (bottom - top);
    void text(String label, Offset position, {double alignment = 0}) {
      final painter = TextPainter(text: TextSpan(text: label, style: TextStyle(fontSize: 11, color: colors.onSurfaceVariant)), textDirection: TextDirection.ltr, textScaler: scale)..layout();
      painter.paint(canvas, Offset(position.dx - painter.width * alignment, position.dy));
    }
    final paint = Paint()..strokeWidth = 1;
    for (var i = 0; i <= 4; i++) {
      final value = maximum * i / 4;
      paint.color = colors.outlineVariant;
      canvas.drawLine(Offset(left, y(value)), Offset(left + width, y(value)), paint);
      text(formatBytes(value), Offset(left - 8, y(value) - scale.scale(6)), alignment: 1);
    }
    for (var direction = 0; direction < 2; direction++) {
      final color = direction == 0 ? colors.primary : colors.tertiary;
      Path? path;
      int start = 0;
      void finish(int end) {
        if (path == null) return;
        final area = Path.from(path!)..lineTo(x(end), bottom)..lineTo(x(start), bottom)..close();
        paint..style = PaintingStyle.fill..color = color.withValues(alpha: .08);
        canvas.drawPath(area, paint);
        paint..style = PaintingStyle.stroke..strokeWidth = (direction == 0 ? 2.5 : 1.75)..color = color;
        canvas.drawPath(path!, paint);
        paint.style = PaintingStyle.fill;
        if (end == start) {
          final value = direction == 0 ? samples[start].rx! : samples[start].tx!;
          canvas.drawCircle(Offset(x(start), y(value)), 3, paint);
        }
        path = null;
      }
      for (var i = 0; i < samples.length; i++) {
        final value = direction == 0 ? samples[i].rx : samples[i].tx;
        if (value == null) { finish(i - 1); continue; }
        if (path == null) { start = i; path = Path()..moveTo(x(i), y(value)); }
        else { path!.lineTo(x(i), y(value)); }
      }
      finish(samples.length - 1);
    }
    if (selected >= 0 && selected < samples.length) {
      paint..color = colors.onSurfaceVariant..strokeWidth = 1;
      canvas.drawLine(Offset(x(selected), top), Offset(x(selected), bottom), paint);
      final sample = samples[selected];
      for (var direction = 0; direction < 2; direction++) {
        final value = direction == 0 ? sample.rx : sample.tx;
        if (value == null) continue;
        paint.color = direction == 0 ? colors.primary : colors.tertiary;
        canvas.drawCircle(Offset(x(selected), y(value)), 4, paint);
      }
    }
    final count = math.min(samples.length, math.max(2, (width / scale.scale(74)).floor()));
    for (var tick = 0; tick < count; tick++) {
      final index = count == 1 ? 0 : (tick * (samples.length - 1) / (count - 1)).round();
      final label = samples[index].label;
      text(label.length > 5 ? label.substring(5) : label, Offset(x(index), bottom + 8), alignment: index == 0 ? 0 : index == samples.length - 1 ? 1 : .5);
    }
  }
  @override
  bool shouldRepaint(_TrafficPainter old) => samples != old.samples || selected != old.selected || colors != old.colors || scale != old.scale || left != old.left;
}
