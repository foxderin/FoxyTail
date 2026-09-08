#!/usr/bin/env bash
# FoxyTail release builder.
#
# Downloads the pinned upstream binaries (tailscale/VERSIONS) for arm and
# arm64, regenerates tailscale/checksums.txt, then produces:
#   dist/FoxyTail-<version>.zip       light: binaries downloaded at install
#   dist/FoxyTail-<version>-full.zip  full:  all binaries bundled
#
# dnsmasq is intentionally NOT packaged: there is no trusted static-build
# source. Users can drop a static dnsmasq into /data/adb/foxytail/bin/ to
# enable MagicDNS (see README).
set -euo pipefail

cd "$(dirname "$0")/../.."
# shellcheck source=tailscale/VERSIONS
source tailscale/VERSIONS

VERSION="${1:-$(grep '^version=' module.prop | cut -d'=' -f2)}"
DIST_DIR="dist"
BIN_DIR="tailscale/bin"

for cmd in curl jq zip unzip sha256sum tar; do
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
    '[.assets[].browser_download_url | select(test($p))] | first // empty' <<<"$json")
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
  if ! curl -fL --retry 3 --connect-timeout 15 -o "$2" "$1"; then
    echo "error: download failed: $1" >&2
    echo "       check the pins in tailscale/VERSIONS" >&2
    return 1
  fi
}

echo "Building FoxyTail ${VERSION}"
echo "========================================"

mkdir -p "$BIN_DIR" "$DIST_DIR"
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

for ARCH in arm arm64; do
  case $ARCH in
    arm)
      F_ARCH=armv7a
      HEV_ARCH=arm32v7
      ;;
    arm64)
      F_ARCH=aarch64
      HEV_ARCH=arm64
      ;;
  esac

  echo "[${ARCH}] tailscaled (${TAILSCALE_REPO}@${TAILSCALE_VERSION})"
  url=$(asset_url "$TAILSCALE_REPO" "$TAILSCALE_VERSION" "tailscale_.*_${ARCH}\.tgz$")
  download "$url" "${WORK_DIR}/tailscale-${ARCH}.tgz"
  tar -xzf "${WORK_DIR}/tailscale-${ARCH}.tgz" -C "$WORK_DIR"
  mv "$WORK_DIR/tailscaled" "${BIN_DIR}/tailscaled-${ARCH}"

  echo "[${ARCH}] jq (${JQ_REPO}@${JQ_VERSION})"
  url=$(asset_url "$JQ_REPO" "$JQ_VERSION" "jq-${F_ARCH}-linux-android")
  download "$url" "${BIN_DIR}/jq-${ARCH}"

  echo "[${ARCH}] hev-socks5-tunnel (${HEV_REPO}@${HEV_VERSION})"
  url=$(asset_url "$HEV_REPO" "$HEV_VERSION" "hev-socks5-tunnel-linux-${HEV_ARCH}$")
  download "$url" "${BIN_DIR}/hev-socks5-tunnel-${ARCH}"

  chmod 0755 "${BIN_DIR}/tailscaled-${ARCH}" "${BIN_DIR}/jq-${ARCH}" "${BIN_DIR}/hev-socks5-tunnel-${ARCH}"
done

echo ""
echo "- Regenerating tailscale/checksums.txt"
{
  cat <<'EOF'
# This file is regenerated at build time by .github/tools/build.sh.
# Format: `<sha256>  <filename>` (two spaces, sha256sum compatible).
# The installer (customize.sh) uses it to verify the sha256 of binaries
# downloaded at install time. Only an empty template is kept in the repo.
EOF
  (cd "$BIN_DIR" && sha256sum tailscaled-* jq-* hev-socks5-tunnel-*)
} >tailscale/checksums.txt

# Common exclusions: VCS metadata, build output, docs and lint config do not
# belong in the flashable zip. tailscale/checksums.txt and tailscale/VERSIONS
# stay in: the installer reads them.
EXCLUDES=("*.git*" "dist/*" "*.zip" "*.md" ".shellcheckrc")

echo "- Creating ${DIST_DIR}/FoxyTail-${VERSION}-full.zip"
rm -f "${DIST_DIR}/FoxyTail-${VERSION}-full.zip"
zip -9 -r "${DIST_DIR}/FoxyTail-${VERSION}-full.zip" . -x "${EXCLUDES[@]}" >/dev/null

echo "- Creating ${DIST_DIR}/FoxyTail-${VERSION}.zip (light)"
rm -f "${DIST_DIR}/FoxyTail-${VERSION}.zip"
zip -9 -r "${DIST_DIR}/FoxyTail-${VERSION}.zip" . -x "${EXCLUDES[@]}" "${BIN_DIR}/*" >/dev/null

echo "- Cleaning up ${BIN_DIR}/"
rm -rf "$BIN_DIR"

echo ""
echo "Build completed successfully!"
echo "========================================"
ls -lh "$DIST_DIR"
echo "========================================"
echo "Light: ${DIST_DIR}/FoxyTail-${VERSION}.zip (binaries downloaded + SHA256-verified on install)"
echo "Full:  ${DIST_DIR}/FoxyTail-${VERSION}-full.zip (all binaries bundled)"
