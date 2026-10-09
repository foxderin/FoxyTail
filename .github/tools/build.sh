#!/usr/bin/env bash
# FoxyTail release builder.
#
# Downloads the pinned upstream binaries (tailscale/VERSIONS) for arm and
# arm64, verifies the reviewed tailscale/checksums.txt, then produces:
#   dist/FoxyTail-<version>.zip       light: upstream binaries downloaded at install
#   dist/FoxyTail-<version>-full.zip  full:  all binaries bundled
# First-party foxydns and foxyfiles helpers are built from source and bundled in both.
#
# dnsmasq is intentionally NOT packaged: there is no trusted static-build
# source. Runtime prefers a supplied binary, then the system/vendor dnsmasq.
# Devices without either can supply a trusted binary (see README).
set -euo pipefail
export TZ=UTC
umask 022

cd "$(dirname "$0")/../.."
# shellcheck source=tailscale/VERSIONS
source tailscale/VERSIONS

UPDATE_CHECKSUMS=false
case "${1:-}" in
  --update-checksums) UPDATE_CHECKSUMS=true ;;
  '') ;;
  *) echo "usage: $0 [--update-checksums]" >&2; exit 1 ;;
esac
VERSION=$(sed -n 's/^version=//p' module.prop)
DIST_DIR="$PWD/dist"
REVIEWED_MANIFEST="$PWD/tailscale/checksums.txt"

for cmd in curl jq zip unzip sha256sum tar python3; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "error: required command not found: $cmd" >&2
    exit 1
  }
done

# asset_url <repo> <tag> <regex>: resolve exactly one asset URL from the
# pinned GitHub release. JSON is parsed with jq - never grep/sed.
asset_url() {
  local repo="$1" tag="$2" pattern="$3"
  local json url
  if ! json=$(curl -sf "https://api.github.com/repos/${repo}/releases/tags/${tag}"); then
    echo "error: cannot query release ${repo}@${tag}" >&2
    echo "       does the tag exist? check the pin in tailscale/VERSIONS" >&2
    return 1
  fi
  url=$(jq -r --arg p "$pattern" \
    '[.assets[].browser_download_url | select(test($p))] | if length == 1 then .[0] else error("asset must match exactly once") end' <<<"$json")
  if [ -z "$url" ]; then
    echo "error: no asset matching '${pattern}' in ${repo}@${tag}" >&2
    echo "       available assets:" >&2
    jq -r '.assets[].name' <<<"$json" >&2
    echo "       check the pins in tailscale/VERSIONS" >&2
    return 1
  fi
  echo "$url"
}

# download <url> <dest>
download() {
  echo "- Downloading $(basename "$2")"
  if ! curl -fL --retry 3 --retry-all-errors --connect-timeout 15 -o "$2" "$1"; then
    echo "error: download failed: $1" >&2
    echo "       check the pins in tailscale/VERSIONS" >&2
    return 1
  fi
}

echo "Building FoxyTail ${VERSION}"
echo "========================================"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
BIN_DIR="${WORK_DIR}/bin"
mkdir -p "$BIN_DIR" "$DIST_DIR"

for ARCH in arm arm64; do
  case $ARCH in
    arm)
      # Upstream asset names are irregular: only arm carries -androideabi.
      JQ_ASSET=jq-armv7a-linux-androideabi
      HEV_ARCH=arm32v7
      ;;
    arm64)
      JQ_ASSET=jq-aarch64-linux-android
      HEV_ARCH=arm64
      ;;
  esac

  echo "[${ARCH}] tailscaled (${TAILSCALE_REPO}@${TAILSCALE_VERSION})"
  url=$(asset_url "$TAILSCALE_REPO" "$TAILSCALE_VERSION" "tailscale_.*_${ARCH}\.tgz$")
  download "$url" "${WORK_DIR}/tailscale-${ARCH}.tgz"
  tar -xzf "${WORK_DIR}/tailscale-${ARCH}.tgz" -C "$WORK_DIR"
  mv "$WORK_DIR/tailscaled" "${BIN_DIR}/tailscaled-${ARCH}"

  echo "[${ARCH}] jq (${JQ_REPO}@${JQ_VERSION})"
  url=$(asset_url "$JQ_REPO" "$JQ_VERSION" "${JQ_ASSET}$")
  download "$url" "${BIN_DIR}/jq-${ARCH}"

  echo "[${ARCH}] hev-socks5-tunnel (${HEV_REPO}@${HEV_VERSION})"
  url=$(asset_url "$HEV_REPO" "$HEV_VERSION" "hev-socks5-tunnel-linux-${HEV_ARCH}$")
  download "$url" "${BIN_DIR}/hev-socks5-tunnel-${ARCH}"

  chmod 0755 "${BIN_DIR}/tailscaled-${ARCH}" "${BIN_DIR}/jq-${ARCH}" "${BIN_DIR}/hev-socks5-tunnel-${ARCH}"
done

echo ""
if [ "$UPDATE_CHECKSUMS" = true ]; then
  # Explicit dependency update mode creates a candidate for human review.
  # It never packages or publishes binaries under newly accepted checksums.
  {
    echo '# Reviewed upstream binary hashes. Normal builds only verify this file.'
    echo '# Update explicitly with .github/tools/build.sh --update-checksums and review the diff.'
    (cd "$BIN_DIR" && sha256sum tailscaled-* jq-* hev-socks5-tunnel-*)
  } >"${REVIEWED_MANIFEST}.candidate"
  echo "Candidate written to tailscale/checksums.txt.candidate; verify upstream provenance before replacing the reviewed manifest."
  exit 0
fi

echo "- Verifying every pinned binary against the reviewed manifest"
awk '!/^[[:space:]]*(#|$)/' "$REVIEWED_MANIFEST" >"${WORK_DIR}/checksums.verify"
(cd "$BIN_DIR" && sha256sum --strict -c "${WORK_DIR}/checksums.verify")
for binary in tailscaled-arm tailscaled-arm64 jq-arm jq-arm64 hev-socks5-tunnel-arm hev-socks5-tunnel-arm64; do
  # Missing/duplicate entries must fail even if sha256sum accepted other lines.
  test "$(awk -v name="$binary" '$2==name {n++} END {print n+0}' "$REVIEWED_MANIFEST")" = 1
 done

NATIVE_DIR="${WORK_DIR}/native"
bash .github/tools/build-native.sh "$NATIVE_DIR"
COMPANION_APK="${WORK_DIR}/FoxyTail.apk"
bash .github/tools/build-android.sh release "$COMPANION_APK"

# An explicit shipping allowlist prevents tests, local evidence, dependency
# caches or future development directories from entering a root module ZIP.
PACKAGE_DIR="${WORK_DIR}/package"
mkdir -p "$PACKAGE_DIR/tailscale/bin"
mkdir -p "$PACKAGE_DIR/companion"
cp "$COMPANION_APK" "$PACKAGE_DIR/companion/FoxyTail.apk"
(cd "$PACKAGE_DIR/companion" && sha256sum FoxyTail.apk | cut -d' ' -f1 >FoxyTail.apk.sha256)
cp -R META-INF webroot "$PACKAGE_DIR/"
cp customize.sh service.sh install-recovery.sh install-companion.sh uninstall.sh module.prop update.json LICENSE "$PACKAGE_DIR/"
cp native/foxydns/THIRD_PARTY_NOTICES.txt "$PACKAGE_DIR/THIRD_PARTY_NOTICES.txt"
cp -R tailscale/scripts tailscale/conf "$PACKAGE_DIR/tailscale/"
cp tailscale/settings.sh tailscale/VERSIONS tailscale/checksums.txt "$PACKAGE_DIR/tailscale/"
cp "$NATIVE_DIR/foxydns-arm" "$NATIVE_DIR/foxydns-arm64" \
  "$NATIVE_DIR/foxyfiles-arm" "$NATIVE_DIR/foxyfiles-arm64" "$PACKAGE_DIR/tailscale/bin/"
{
  echo '# First-party helpers built from this release source with the pinned Go toolchain.'
  (cd "$NATIVE_DIR" && sha256sum foxydns-arm foxydns-arm64 foxyfiles-arm foxyfiles-arm64)
} >"$PACKAGE_DIR/tailscale/native-checksums.txt"
# ZIP metadata gets a fixed timestamp from the source commit.
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}
export SOURCE_DATE_EPOCH
python3 - "$PACKAGE_DIR" <<'PYTIME'
import os, sys
stamp = int(os.environ['SOURCE_DATE_EPOCH'])
for root, dirs, files in os.walk(sys.argv[1]):
    for name in dirs + files:
        os.utime(os.path.join(root, name), (stamp, stamp), follow_symlinks=False)
PYTIME
rm -f "${DIST_DIR}/FoxyTail-${VERSION}.zip" "${DIST_DIR}/FoxyTail-${VERSION}-full.zip"
(cd "$PACKAGE_DIR" && LC_ALL=C find . -type f | LC_ALL=C sort | zip -X -9 "${DIST_DIR}/FoxyTail-${VERSION}.zip" -@ >/dev/null)
cp "$BIN_DIR/"* "$PACKAGE_DIR/tailscale/bin/"
python3 - "$PACKAGE_DIR/tailscale/bin" <<'PYTIME'
import os, sys
stamp = int(os.environ['SOURCE_DATE_EPOCH'])
for name in os.listdir(sys.argv[1]):
    os.utime(os.path.join(sys.argv[1], name), (stamp, stamp))
PYTIME
(cd "$PACKAGE_DIR" && LC_ALL=C find . -type f | LC_ALL=C sort | zip -X -9 "${DIST_DIR}/FoxyTail-${VERSION}-full.zip" -@ >/dev/null)
(cd "$DIST_DIR" && sha256sum "FoxyTail-${VERSION}.zip" "FoxyTail-${VERSION}-full.zip" >SHA256SUMS)
echo "Build complete: ${DIST_DIR} (reviewed manifest unchanged)"
