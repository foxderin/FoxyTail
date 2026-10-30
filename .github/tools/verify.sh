#!/usr/bin/env bash
# One local/CI gate; all runtime tests use mocks and temporary data directories.
set -euo pipefail
cd "$(dirname "$0")/../.."
for cmd in shellcheck python3 jq go sha256sum node pnpm; do
  command -v "$cmd" >/dev/null || { echo "missing verifier: $cmd" >&2; exit 1; }
done
build_dir=$(mktemp -d)
cleanup() {
  # An early foreground failure must not leave background work running.
  for pid in $(jobs -p); do kill "$pid" 2>/dev/null || true; done
  rm -rf "$build_dir"
}
trap cleanup EXIT

export FOXYFILES_TEST_BINARY="$build_dir/foxyfiles"
export FOXYDNS_TEST_BINARY="$build_dir/foxydns"
# Build the host helpers first: the backend suite execs them directly.
(cd native/foxyfiles && GOTOOLCHAIN=local GOENV=off GOWORK=off GOFLAGS='' \
  go build -mod=readonly -o "$FOXYFILES_TEST_BINARY" .) &
foxyfiles_pid=$!
(cd native/foxydns && GOTOOLCHAIN=local GOENV=off GOWORK=off GOFLAGS='' \
  go build -mod=readonly -o "$FOXYDNS_TEST_BINARY" .) &
foxydns_pid=$!
wait "$foxyfiles_pid"
wait "$foxydns_pid"
# Backend modules dominate wall time and are IO-bound; overlap them with the
# compile-style checks below. Their log prints after the foreground work.
python3 .github/tools/verify-backend.py >"$build_dir/backend.log" 2>&1 &
backend_pid=$!

scripts=(customize.sh service.sh install-recovery.sh uninstall.sh tailscale/settings.sh META-INF/com/google/android/update-binary)
for file in tailscale/scripts/*; do
  case "$file" in *.yaml) ;; *) scripts+=("$file") ;; esac
done
for file in "${scripts[@]}"; do sh -n "$file"; done
shellcheck -s sh --severity=warning "${scripts[@]}"
shellcheck -s bash --severity=warning .github/tools/*.sh
helper_pids=()
for helper in foxydns foxyfiles; do
  (cd "native/$helper" && GOTOOLCHAIN=local GOENV=off GOWORK=off GOFLAGS='' \
    go test -mod=readonly -race -count=1 ./... && go vet -mod=readonly ./...) &
  helper_pids+=("$!")
done
# Cross-compile and validate the same static ELFs on every push and PR.
bash .github/tools/build-native.sh "$build_dir/native"
python3 .github/tools/native-notices.py --check
bash .github/tools/build-android.sh debug "$build_dir/FoxyTail-debug.apk"
android/gradlew --no-daemon -p android :app:assembleDebugAndroidTest
pnpm --dir webui run typecheck
pnpm --dir webui run check:i18n
pnpm --dir webui run check:theme
pnpm --dir webui run smoke
javac -d "$build_dir/settings-check" android/app/src/main/java/dev/foxderin/tail/SettingsRules.java android/app/src/test/java/dev/foxderin/tail/SettingsRulesTest.java
java -cp "$build_dir/settings-check" dev.foxderin.tail.SettingsRulesTest
for pid in "${helper_pids[@]}"; do wait "$pid"; done

wait "$backend_pid" && backend_status=0 || backend_status=$?
cat "$build_dir/backend.log"
[ "$backend_status" -eq 0 ] || exit "$backend_status"
python3 .github/tools/check-metadata.py
