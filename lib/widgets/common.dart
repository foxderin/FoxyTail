import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

import '../app/platform_bridge.dart';
import '../l10n/generated/app_localizations.dart';
export '../l10n/generated/app_localizations.dart';

extension BuildContextStrings on BuildContext {
  AppLocalizations get l10n => AppLocalizations.of(this);
}

class PageBody extends StatelessWidget {
  const PageBody({super.key, required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    primary: true,
    padding: EdgeInsets.fromLTRB(
      MediaQuery.sizeOf(context).width < 400 ? 12 : 24, 16,
      MediaQuery.sizeOf(context).width < 400 ? 12 : 24, 32,
    ),
    child: Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 1120),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
      ),
    ),
  );
}

class Section extends StatelessWidget {
  const Section({super.key, this.title, this.trailing, required this.children});
  final String? title;
  final Widget? trailing;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Card.filled(
    margin: const EdgeInsets.only(bottom: 16),
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        if (title != null || trailing != null) ...[
          Row(children: [
            if (title != null) Expanded(child: Semantics(
              header: true,
              child: Text(title!, style: Theme.of(context).textTheme.titleMedium),
            )) else const Spacer(),
            if (trailing != null) trailing!,
          ]),
          const SizedBox(height: 12),
        ],
        ...children,
      ]),
    ),
  );
}

class InfoRow extends StatelessWidget {
  const InfoRow(this.label, this.value, {super.key, this.selectable = true});
  final String label;
  final String value;
  final bool selectable;
  @override
  Widget build(BuildContext context) {
    final labelWidget = Text(label, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant));
    final valueWidget = selectable ? SelectableText(value) : Text(value);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: LayoutBuilder(builder: (context, constraints) {
        if (constraints.maxWidth < 420 || MediaQuery.textScalerOf(context).scale(14) > 21) {
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            labelWidget, const SizedBox(height: 4), valueWidget,
          ]);
        }
        return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(flex: 2, child: labelWidget), const SizedBox(width: 16),
          Expanded(flex: 3, child: valueWidget),
        ]);
      }),
    );
  }
}

class Notice extends StatelessWidget {
  const Notice(this.message, {super.key, this.error = false});
  final String message;
  final bool error;
  @override
  Widget build(BuildContext context) {
    if (message.isEmpty) return const SizedBox.shrink();
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      liveRegion: true,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: error ? colors.errorContainer : colors.secondaryContainer,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(error ? Icons.error_outline : Icons.info_outline,
            color: error ? colors.onErrorContainer : colors.onSecondaryContainer),
          const SizedBox(width: 10),
          Expanded(child: SelectableText(message, style: TextStyle(
            color: error ? colors.onErrorContainer : colors.onSecondaryContainer,
          ))),
        ]),
      ),
    );
  }
}

class Metric extends StatelessWidget {
  const Metric(this.label, this.value, {super.key, this.icon});
  final String label;
  final String value;
  final IconData? icon;
  @override
  Widget build(BuildContext context) => Card.filled(
    child: Padding(padding: const EdgeInsets.all(16), child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (icon != null) ...[Icon(icon, color: Theme.of(context).colorScheme.primary), const SizedBox(height: 8)],
        Text(value, style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 4),
        Text(label, style: Theme.of(context).textTheme.bodyMedium),
      ],
    )),
  );
}

Future<bool> confirm(BuildContext context, String title, String message) async =>
  await showDialog<bool>(context: context, builder: (context) => AlertDialog(
    title: Text(title),
    content: SingleChildScrollView(child: Text(message)),
    actions: [
      TextButton(autofocus: true, onPressed: () => Navigator.pop(context, false), child: Text(context.l10n.cancel)),
      FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(MaterialLocalizations.of(context).okButtonLabel)),
    ],
  )) ?? false;

Future<void> copyText(BuildContext context, String value) async {
  final messenger = ScaffoldMessenger.of(context);
  final copied = context.l10n.control_copied;
  await Clipboard.setData(ClipboardData(text: value));
  messenger.showSnackBar(SnackBar(content: Text(copied)));
}

Future<void> perform(BuildContext context, Future<void> Function() action) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    await action();
  } catch (error) {
    if (messenger.mounted) {
      messenger.showSnackBar(SnackBar(content: Text(failureMessage(error))));
    }
  }
}

String formatBytes(num value) {
  if (value < 1024) return '${value.toInt()} B';
  if (value < 1048576) return '${(value / 1024).toStringAsFixed(1)} KiB';
  if (value < 1073741824) return '${(value / 1048576).toStringAsFixed(1)} MiB';
  return '${(value / 1073741824).toStringAsFixed(2)} GiB';
}
String formatUptime(num seconds) {
  final value = seconds.toInt();
  if (value < 60) return '${value}s';
  if (value < 3600) return '${value ~/ 60}m';
  if (value < 86400) return '${value ~/ 3600}h ${value % 3600 ~/ 60}m';
  return '${value ~/ 86400}d ${value % 86400 ~/ 3600}h';
}
String formatTime(num seconds) => seconds == 0 ? '-' :
  DateFormat('yyyy-MM-dd HH:mm').format(DateTime.fromMillisecondsSinceEpoch((seconds * 1000).toInt()));
