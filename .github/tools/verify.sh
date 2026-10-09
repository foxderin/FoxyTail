#!/usr/bin/env bash
# One local/CI gate; all runtime tests use mocks and temporary data directories.
set -euo pipefail
cd "$(dirname "$0")/../.."
for cmd in shellcheck python3 pnpm jq go sha256sum; do
  command -v "$cmd" >/dev/null || { echo "missing verifier: $cmd" >&2; exit 1; }
done
scripts=(customize.sh service.sh install-recovery.sh install-companion.sh uninstall.sh tailscale/settings.sh META-INF/com/google/android/update-binary)
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
# Non-PR CI packages and validates these same static ELFs after verification.
if [ "${FOXYTAIL_NATIVE_IN_PACKAGE:-0}" != 1 ]; then
  bash .github/tools/build-native.sh "$build_dir/native"
fi
python3 .github/tools/native-notices.py --check
bash .github/tools/build-android.sh debug "$build_dir/FoxyTail-debug.apk"
python3 .github/tools/verify-backend.py
pnpm --dir webui typecheck
pnpm --dir webui check:i18n
pnpm --dir webui check:theme
pnpm --dir webui smoke
pnpm --dir webui exec vite build --outDir "$build_dir/webroot"
diff -qr webroot "$build_dir/webroot"
python3 .github/tools/check-metadata.py
