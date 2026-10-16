import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';

import 'app/app_state.dart';
import 'app/shell.dart';
import 'l10n/generated/app_localizations.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  LicenseRegistry.addLicense(() async* {
    yield LicenseEntryWithLineBreaks(['FoxyTail Android platform dependencies'],
      await rootBundle.loadString('android/app/src/main/assets/THIRD_PARTY_NOTICES.txt'));
  });
  final app = AppState();
  runApp(FoxyTailApp(app: app));
  unawaited(app.initialize());
}

class FoxyTailApp extends StatelessWidget {
  const FoxyTailApp({super.key, required this.app});
  final AppState app;

  ThemeData _theme(Brightness brightness) => ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(
      seedColor: const Color(0xFFB84521), brightness: brightness,
    ),
    brightness: brightness,
    inputDecorationTheme: const InputDecorationTheme(border: OutlineInputBorder()),
    appBarTheme: const AppBarTheme(centerTitle: false),
  );

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<({String theme, String language})>(
    valueListenable: app.appearance,
    builder: (context, appearance, _) => MaterialApp(
      title: 'FoxyTail',
      debugShowCheckedModeBanner: false,
      restorationScopeId: 'foxytail',
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      locale: appearance.language == 'auto' ? null : Locale(appearance.language),
      theme: _theme(Brightness.light),
      darkTheme: _theme(Brightness.dark),
      themeMode: switch (appearance.theme) {
        'light' => ThemeMode.light, 'dark' => ThemeMode.dark, _ => ThemeMode.system,
      },
      home: AppShell(app: app),
    ),
  );
}
