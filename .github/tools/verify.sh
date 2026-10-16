#!/usr/bin/env bash
# One local/CI gate; device integration runs separately on an isolated device.
set -euo pipefail
cd "$(dirname "$0")/../.."
for cmd in shellcheck python3 jq go sha256sum; do
  command -v "$cmd" >/dev/null || { echo "missing verifier: $cmd" >&2; exit 1; }
done
# shellcheck source=.github/tools/flutter-env.sh
source .github/tools/flutter-env.sh
prepare_flutter
"$FLUTTER_BIN" analyze --no-pub
"$FLUTTER_BIN" test --no-pub
scripts=(customize.sh service.sh install-recovery.sh uninstall.sh tailscale/settings.sh META-INF/com/google/android/update-binary)
for file in tailscale/scripts/*; do
  case "$file" in *.yaml) ;; *) scripts+=("$file") ;; esac
done
for file in "${scripts[@]}"; do sh -n "$file"; done
shellcheck -s sh --severity=warning "${scripts[@]}"
shellcheck -s bash --severity=warning .github/tools/*.sh
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
for helper in foxydns foxyfiles; do
  (cd "native/$helper" && GOTOOLCHAIN=local GOENV=off GOWORK=off GOFLAGS='' \
    go test -mod=readonly -race -count=1 ./... && go vet -mod=readonly ./...)
done
export FOXYFILES_TEST_BINARY="$build_dir/foxyfiles"
(cd native/foxyfiles && GOTOOLCHAIN=local GOENV=off GOWORK=off GOFLAGS='' \
  go build -mod=readonly -o "$FOXYFILES_TEST_BINARY" .)
export FOXYDNS_TEST_BINARY="$build_dir/foxydns"
(cd native/foxydns && GOTOOLCHAIN=local GOENV=off GOWORK=off GOFLAGS='' \
  go build -mod=readonly -o "$FOXYDNS_TEST_BINARY" .)
# Cross-compile and validate the same static ELFs on every push and PR.
bash .github/tools/build-native.sh "$build_dir/native"
python3 .github/tools/native-notices.py --check
bash .github/tools/build-android.sh debug "$build_dir/FoxyTail-debug.apk"
android/gradlew --no-daemon -p android :app:assembleDebugAndroidTest
python3 .github/tools/verify-backend.py
python3 .github/tools/check-metadata.py
