#!/usr/bin/env bash
# One local/CI gate. No arguments still runs every check; named stages are for
# focused local iteration, not a substitute for the full pre-release gate.
set -euo pipefail
cd "$(dirname "$0")/../.."
stages=(lint native backend web metadata)
usage() {
  echo 'usage: bash .github/tools/verify.sh [all | lint native backend web metadata]'
  echo 'No arguments runs all stages. The privileged Linux gate remains a separate CI job.'
}
if [ "${1:-}" = --help ] || [ "${1:-}" = -h ]; then usage; exit 0; fi
if [ "$#" -gt 0 ] && ! { [ "$#" = 1 ] && [ "$1" = all ]; }; then stages=("$@"); fi
for stage in "${stages[@]}"; do
  case "$stage" in lint|native|backend|web|metadata) ;; *) usage >&2; exit 2 ;; esac
done
build_dir=$(mktemp -d)
started=$SECONDS
active_stage=''
stage_started=$SECONDS
finish() {
  local status=$?
  trap - EXIT
  if [ -n "$active_stage" ]; then printf 'VERIFY stage=%s seconds=%s status=failed\n' "$active_stage" "$((SECONDS - stage_started))" >&2; fi
  printf 'VERIFY total_seconds=%s exit_status=%s\n' "$((SECONDS - started))" "$status"
  rm -rf "$build_dir"
  exit "$status"
}
trap finish EXIT
require() {
  local cmd
  for cmd in "$@"; do command -v "$cmd" >/dev/null || { echo "missing verifier: $cmd" >&2; return 1; }; done
}
verify_lint() {
  require shellcheck
  local file
  local scripts=(customize.sh service.sh uninstall.sh tailscale/settings.sh META-INF/com/google/android/update-binary tools/perf/collect-android.sh)
  for file in tailscale/scripts/*; do
    case "$file" in *.yaml) ;; *) scripts+=("$file") ;; esac
  done
  for file in "${scripts[@]}"; do sh -n "$file"; done
  shellcheck -s sh --severity=warning "${scripts[@]}"
  shellcheck -s bash --severity=warning .github/tools/*.sh
}
verify_native() {
  require go python3
  (cd native/foxydns && GOTOOLCHAIN=local GOENV=off GOWORK=off GOFLAGS='' \
    go test -mod=readonly -race -count=1 ./...)
  (cd native/foxydns && GOTOOLCHAIN=local GOENV=off GOWORK=off GOFLAGS='' \
    go vet -mod=readonly ./...)
  bash .github/tools/build-native.sh "$build_dir/native"
  python3 .github/tools/native-notices.py --check
}
verify_backend() {
  require python3 jq
  local file
  python3 -m unittest discover -s tests -p 'test_*.py' -v
  # Standalone shell regression files are equally first-class checks.
  for file in tests/*.sh; do [ ! -f "$file" ] || bash "$file"; done
}
verify_web() {
  require pnpm
  pnpm --dir webui typecheck
  pnpm --dir webui check:i18n
  pnpm --dir webui check:theme
  pnpm --dir webui smoke
  pnpm --dir webui exec vite build --outDir "$build_dir/webroot"
  diff -qr webroot "$build_dir/webroot"
}
verify_metadata() {
  require python3
  python3 .github/tools/check-metadata.py
}
for stage in "${stages[@]}"; do
  active_stage=$stage
  stage_started=$SECONDS
  printf 'VERIFY stage=%s status=started\n' "$stage"
  "verify_$stage"
  printf 'VERIFY stage=%s seconds=%s status=passed\n' "$stage" "$((SECONDS - stage_started))"
  active_stage=''
done
