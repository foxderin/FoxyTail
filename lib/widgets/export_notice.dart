import 'package:flutter/material.dart';

import '../app/app_state.dart';
import '../app/platform_bridge.dart';
import 'common.dart';

class ExportNotice extends StatelessWidget {
  const ExportNotice({super.key, required this.app});
  final AppState app;

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: app.bridge,
    builder: (context, _) {
      final files = app.bridge.files;
      if (app.destination == 'files' || string(files['exportKind']).isEmpty) {
        return const SizedBox.shrink();
      }
      final pending = boolean(files['exporting']) || boolean(files['exportPickerPending']);
      final result = json(files['exportResult']);
      final message = string(files['exportMessage']);
      if (!pending && message.isEmpty) return const SizedBox.shrink();
      final progress = json(files['exportProgress']);
      final l = context.l10n;
      final description = pending && progress.isNotEmpty
        ? progress['phase'] == 'committing'
          ? l.repair_files_save_committing(string(progress['name']), formatBytes(number(progress['bytes'])))
          : l.taildrop_share_progress(number(progress['index']).toInt(), number(progress['total']).toInt(),
              string(progress['name']), formatBytes(number(progress['bytes'])))
        : message;
      return Material(
        color: Theme.of(context).colorScheme.surfaceContainerLow,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (pending) const LinearProgressIndicator(),
            Row(children: [
              Expanded(child: Semantics(liveRegion: true, child: Text(description,
                style: TextStyle(color: result['ok'] == false ? Theme.of(context).colorScheme.error : null)))),
              if (boolean(files['canCancel'])) IconButton(
                tooltip: l.cancel, icon: const Icon(Icons.close),
                onPressed: () => perform(context, () async { await app.bridge.invoke<void>('cancelExport'); }),
              ),
            ]),
          ]),
        ),
      );
    },
  );
}
