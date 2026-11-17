#!/usr/bin/env bash
# One local/CI gate; all runtime tests use mocks and temporary data directories.
# CI splits the gate across dedicated runners so the timing-sensitive backend
# suite never shares a CPU with the compile checks:
#   verify.sh backend  host helper binaries + python backend suite
#   verify.sh checks   everything else (lint, go test, native, android, webui)
#   verify.sh          both, sequentially (local use)
set -euo pipefail
cd "$(dirname "$0")/../.."
mode=${1:-all}
case "$mode" in all|checks|backend) ;; *)
  echo "usage: $0 [all|checks|backend]" >&2; exit 1 ;;
esac
cmds="python3 go"
case "$mode" in
  backend) ;;
  *) cmds="$cmds shellcheck jq sha256sum node pnpm" ;;
esac
for cmd in $cmds; do
  command -v "$cmd" >/dev/null || { echo "missing verifier: $cmd" >&2; exit 1; }
done
build_dir=$(mktemp -d)
cleanup() {
  for pid in $(jobs -p); do kill "$pid" 2>/dev/null || true; done
  rm -rf "$build_dir"
}
trap cleanup EXIT

run_backend() {
  export FOXYFILES_TEST_BINARY="$build_dir/foxyfiles"
  export FOXYDNS_TEST_BINARY="$build_dir/foxydns"
  # The suite execs the helpers directly; build both up front.
  (cd native/foxyfiles && GOTOOLCHAIN=local GOENV=off GOWORK=off GOFLAGS='' \
    go build -mod=readonly -o "$FOXYFILES_TEST_BINARY" .) &
  foxyfiles_pid=$!
  (cd native/foxydns && GOTOOLCHAIN=local GOENV=off GOWORK=off GOFLAGS='' \
    go build -mod=readonly -o "$FOXYDNS_TEST_BINARY" .) &
  foxydns_pid=$!
  wait "$foxyfiles_pid"
  wait "$foxydns_pid"
  python3 .github/tools/verify-backend.py
}

run_checks() {
  local scripts=(customize.sh service.sh install-recovery.sh uninstall.sh tailscale/settings.sh META-INF/com/google/android/update-binary)
  local file helper pid
  for file in tailscale/scripts/*; do
    case "$file" in *.yaml) ;; *) scripts+=("$file") ;; esac
  done
  for file in "${scripts[@]}"; do sh -n "$file"; done
  shellcheck -s sh --severity=warning "${scripts[@]}"
  shellcheck -s bash --severity=warning .github/tools/*.sh
  local helper_pids=()
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
  javac -d "$build_dir/notification-check" android/app/src/main/java/dev/foxderin/tail/IncomingNotificationReceipt.java android/app/src/test/java/dev/foxderin/tail/IncomingNotificationReceiptTest.java
  java -cp "$build_dir/notification-check" dev.foxderin.tail.IncomingNotificationReceiptTest
  for pid in "${helper_pids[@]}"; do wait "$pid"; done
  python3 .github/tools/check-metadata.py
}

case "$mode" in
  backend) run_backend ;;
  checks) run_checks ;;
  all) run_checks; run_backend ;;
esac
