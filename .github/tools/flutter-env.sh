#!/usr/bin/env bash
# Source this file for the one local/CI Flutter pin and locked dependency setup.
FOXYTAIL_FLUTTER_VERSION=3.47.7
FOXYTAIL_FLUTTER_REVISION=abaf9c523780a608bd46686fd5e53740a07077f8
export FLUTTER_SUPPRESS_ANALYTICS=true
export DART_SUPPRESS_ANALYTICS=true

prepare_flutter() {
  if [ -n "${FLUTTER_ROOT:-}" ]; then
    FLUTTER_BIN="$FLUTTER_ROOT/bin/flutter"
  else
    FLUTTER_BIN=$(command -v flutter) || { echo 'Flutter SDK is required' >&2; return 1; }
  fi
  export FLUTTER_BIN
  "$FLUTTER_BIN" config --no-analytics
  "$FLUTTER_BIN" --version --machine | python3 -c '
import json,sys
sdk=json.load(sys.stdin)
expected=(sys.argv[1],sys.argv[2],"stable")
actual=(sdk.get("frameworkVersion"),sdk.get("frameworkRevision"),sdk.get("channel"))
if actual != expected:
    sys.exit(f"Flutter SDK mismatch: expected {expected}, got {actual}")
' "$FOXYTAIL_FLUTTER_VERSION" "$FOXYTAIL_FLUTTER_REVISION"
  [ -f pubspec.lock ] || { echo 'Committed pubspec.lock is required' >&2; return 1; }
  "$FLUTTER_BIN" pub get --enforce-lockfile
  "$FLUTTER_BIN" gen-l10n
}
