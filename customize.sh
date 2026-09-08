#!/system/bin/sh
# FoxyTail - Magisk/KernelSU module installer.
#
# Runs inside the Magisk/KernelSU installation environment (ui_print, abort,
# set_perm/set_perm_recursive, $MODPATH/$ZIPFILE/$TMPDIR/$ARCH/$BOOTMODE/$KSU
# are provided by the manager).
#
# Layout produced by this installer:
#   $MODPATH/                  module files (webroot, service.sh, symlinks)
#   $MODPATH/system/bin/       symlinks into $TS_DIR (mounted systemlessly)
#   /data/adb/foxytail/        $TS_DIR: bin/ scripts/ conf/ state/ backups/

# DEBUG=1 in the installer environment turns on execution tracing.
[ -n "${DEBUG:-}" ] && {
  PS4='+ ${0##*/}:${LINENO}: '
  set -x
}

# We unzip manually below; still mount the module (system/bin symlinks).
# shellcheck disable=SC2034
SKIPUNZIP=1
# shellcheck disable=SC2034
SKIPMOUNT=false

if [ "$BOOTMODE" != true ]; then
  ui_print "! Please install from Magisk Manager / KernelSU Manager / MMRL"
  abort "! Installation from a recovery environment is NOT supported"
fi
if [ "${KSU:-false}" = true ] && [ "${KSU_VER_CODE:-0}" -lt 10670 ]; then
  abort "! KernelSU too old: please update KernelSU and its manager (>= 10670)"
fi
# MAGISK_VER_CODE is exported by util_functions.sh (sourced by update-binary).
if [ "${KSU:-false}" != true ] && [ "${MAGISK_VER_CODE:-0}" -lt 20400 ]; then
  abort "! Magisk too old: please update to Magisk v20.4+ (versionCode >= 20400)"
fi

TS_DIR="/data/adb/foxytail"
TS_BIN_DIR="${TS_DIR}/bin"
TS_SCRIPTS_DIR="${TS_DIR}/scripts"
TS_CONF_DIR="${TS_DIR}/conf"

# --- Architecture ------------------------------------------------------------

case $ARCH in
  arm)
    # Upstream jq asset names are irregular: only the arm build carries the
    # -androideabi suffix (verified against the pinned releases).
    JQ_ASSET="jq-armv7a-linux-androideabi"
    HEV_ARCH="arm32v7"
    ;;
  arm64)
    JQ_ASSET="jq-aarch64-linux-android"
    HEV_ARCH="arm64"
    ;;
  *)
    ui_print "! Unsupported architecture: $ARCH"
    ui_print "! FoxyTail ships arm/arm64 binaries only. Manual install:"
    ui_print "!  1. install this module anyway is not possible; instead place a"
    ui_print "!     static tailscaled + jq + hev-socks5-tunnel for your platform"
    ui_print "!     into ${TS_BIN_DIR} after extracting the zip by hand."
    abort "! Unsupported architecture: $ARCH"
    ;;
esac
ui_print "- Detected architecture: ${ARCH}"

# --- Backup of a previous installation ---------------------------------------
#
# Everything under $TS_DIR is moved to $TS_DIR/backups/<old versionCode>/
# EXCEPT user-owned data, which stays in place:
#   ssh/ certs/ state/ tailscaled.state  (tailscaled identity/state)
#   conf/                                (user configuration)
#   scripts/foxytail.tun.up / .tun.down  (user hooks)
#   backups/                             (previous backups)

if [ -d "$TS_DIR" ]; then
  ui_print "- Backing up previous installation"
  PROP_FILE="$(echo "$MODPATH" | sed 's/_update//')/module.prop"
  [ ! -f "$PROP_FILE" ] && PROP_FILE="$MODPATH/module.prop"
  OLD_CODE=$(grep '^versionCode=' "$PROP_FILE" 2>/dev/null | cut -d= -f2)
  OLD_CODE="${OLD_CODE:-unknown}"
  rm -rf "${TS_DIR}/backups/${OLD_CODE}"
  mkdir -p "${TS_DIR}/backups/${OLD_CODE}"
  for p in "${TS_DIR}"/*; do
    [ -e "$p" ] || continue
    case "$(basename "$p")" in
      ssh | certs | state | tailscaled.state | conf | backups)
        : # user data: keep in place
        ;;
      scripts)
        mkdir -p "${TS_DIR}/backups/${OLD_CODE}/scripts"
        for s in "$p"/*; do
          [ -e "$s" ] || continue
          case "$(basename "$s")" in
            foxytail.tun.up | foxytail.tun.down)
              : # user hooks: keep in place
              ;;
            *)
              mv -f -- "$s" "${TS_DIR}/backups/${OLD_CODE}/scripts/"
              ;;
          esac
        done
        ;;
      *)
        mv -f -- "$p" "${TS_DIR}/backups/${OLD_CODE}/"
        ;;
    esac
  done
fi

mkdir -p "$TS_BIN_DIR" "$TS_SCRIPTS_DIR" "$TS_CONF_DIR"

# --- Restore state left behind by uninstall.sh --------------------------------
# uninstall.sh moves tailscaled.state to /data/adb/foxytail-state.backup before
# wiping $TS_DIR. On a reinstall with no state of its own yet, adopt that
# backup so the node keeps its identity and login.

STATE_BACKUP="/data/adb/foxytail-state.backup"
if [ -f "$STATE_BACKUP" ] &&
  [ ! -f "${TS_DIR}/state/tailscaled.state" ] &&
  [ ! -f "${TS_DIR}/tailscaled.state" ]; then
  mkdir -p "${TS_DIR}/state"
  mv "$STATE_BACKUP" "${TS_DIR}/state/tailscaled.state"
  ui_print "- Restored tailscaled state from a previous install"
  ui_print "  (${STATE_BACKUP} -> state/tailscaled.state)"
fi

# --- Extract module files ----------------------------------------------------
# Everything under tailscale/ except settings.sh lives in $TS_DIR, not in the
# mounted module directory. unzip failures abort loudly: a half-extracted
# module must never install "successfully".

ui_print "- Extracting module files"
if ! unzip -qqo "$ZIPFILE" -d "$MODPATH" \
  -x 'META-INF/*' \
  'tailscale/bin/*' \
  'tailscale/scripts/*' \
  'tailscale/conf/*' \
  'tailscale/settings.sh' \
  'tailscale/checksums.txt' \
  'tailscale/VERSIONS'; then
  abort "! Failed to extract module files (corrupt zip?)"
fi

for f in tailscale/settings.sh tailscale/VERSIONS tailscale/checksums.txt; do
  if ! unzip -qqjo "$ZIPFILE" "$f" -d "$TS_DIR"; then
    abort "! Failed to extract $f"
  fi
done

# Pinned upstream versions used by the install-time downloader.
# shellcheck source=/dev/null
. "${TS_DIR}/VERSIONS"

# The exclusions above leave only empty tailscale/* directory entries in
# $MODPATH; remove them.
rm -rf "${MODPATH}/tailscale"

# --- Download helpers --------------------------------------------------------

# wget with TLS verification first; if (and only if) the failure is a
# certificate error - the Magisk installer environment usually has no CA
# store - warn once and fall back to --no-check-certificate. Real integrity
# is enforced afterwards by the mandatory SHA256 check against checksums.txt.
WGET_INSECURE=0
wget_tls() {
  _wt_timeout="$1"
  shift
  if [ "$WGET_INSECURE" != 1 ]; then
    if wget --timeout="$_wt_timeout" "$@" 2>"${TMPDIR}/.wget-err"; then
      return 0
    fi
    if ! grep -qi 'certificate' "${TMPDIR}/.wget-err" 2>/dev/null; then
      return 1
    fi
    ui_print "! WARNING: TLS certificate verification failed (no CA store in"
    ui_print "! the installer environment). Retrying without certificate"
    ui_print "! verification; integrity is still enforced by SHA256 below."
    WGET_INSECURE=1
  fi
  wget --no-check-certificate --timeout="$_wt_timeout" "$@" 2>/dev/null
}

# gh_download <repo> <tag> <asset-regex> <dest>
# Downloads ONE pinned-release asset. (On-device we cannot rely on jq yet -
# it is itself one of the payloads - so the API JSON is flattened to one
# browser_download_url per line with tr/sed and the regex is matched against
# the URL's last path segment, i.e. the asset name. build.sh uses jq
# properly.)
gh_download() {
  _gd_repo="$1"
  _gd_tag="$2"
  _gd_match="$3"
  _gd_dest="$4"
  _gd_api="https://api.github.com/repos/${_gd_repo}/releases/tags/${_gd_tag}"
  _gd_json=$(wget_tls 10 -qO- "$_gd_api") || {
    ui_print "! Unable to query ${_gd_api}"
    return 1
  }
  _gd_url=$(printf '%s\n' "$_gd_json" |
    tr ',' '\n' |
    sed -n 's/.*"browser_download_url": *"\([^"]*\)".*/\1/p' |
    grep "/${_gd_match}\$" |
    head -n 1)
  if [ -z "$_gd_url" ]; then
    ui_print "! No asset matching '${_gd_match}' in ${_gd_repo}@${_gd_tag}"
    ui_print "! Check the pins in ${TS_DIR}/VERSIONS"
    return 1
  fi
  ui_print "- Downloading $(basename "$_gd_url")"
  wget_tls 100 -qO "$_gd_dest" "$_gd_url" || {
    ui_print "! Download failed: ${_gd_url}"
    return 1
  }
}

# verify_bin <suffixed-name>: mandatory SHA256 check against
# $TS_DIR/checksums.txt. Applies to zip-bundled binaries too - a tampered
# zip must not slip through. Aborts on mismatch or missing entry.
verify_bin() {
  _vb_line=$(grep "  $1\$" "${TS_DIR}/checksums.txt" 2>/dev/null)
  if [ -z "$_vb_line" ]; then
    abort "! No checksum entry for $1 in checksums.txt - refusing to install"
  fi
  if ! (cd "$TS_BIN_DIR" && printf '%s\n' "$_vb_line" | sha256sum -c - >/dev/null 2>&1); then
    abort "! SHA256 mismatch for $1 - refusing to install"
  fi
}

# install_bin <name> <repo> <tag> <asset-regex> [tgz]: use the zip-bundled
# <name>-$ARCH when present (full zip), otherwise download the pinned
# release asset (light zip). With a 5th arg of "tgz" the downloaded asset is
# an archive whose top level contains the bare <name> binary (tailscale
# ships tailscaled only inside tailscale_<ver>_<arch>.tgz). Either way:
# verify, then strip the suffix.
install_bin() {
  _ib_name="$1"
  if [ ! -f "${TS_BIN_DIR}/${_ib_name}-${ARCH}" ]; then
    gh_download "$2" "$3" "$4" "${TMPDIR}/${_ib_name}.download" ||
      abort "! Unable to obtain ${_ib_name} for ${ARCH}"
    if [ "${5:-}" = "tgz" ]; then
      tar -xzf "${TMPDIR}/${_ib_name}.download" -C "${TMPDIR}" ||
        abort "! Failed to unpack the ${_ib_name} archive"
      mv -f "${TMPDIR}/${_ib_name}" "${TS_BIN_DIR}/${_ib_name}-${ARCH}"
      rm -f "${TMPDIR}/${_ib_name}.download"
    else
      mv -f "${TMPDIR}/${_ib_name}.download" "${TS_BIN_DIR}/${_ib_name}-${ARCH}"
    fi
  fi
  verify_bin "${_ib_name}-${ARCH}"
  mv -f "${TS_BIN_DIR}/${_ib_name}-${ARCH}" "${TS_BIN_DIR}/${_ib_name}"
}

# --- Binaries ----------------------------------------------------------------

ui_print "- Installing binaries"
# Optional: bundled binaries of the -full zip. unzip exit 11 (no matching
# files) is expected for the light zip and simply means "download instead".
unzip -qqjo "$ZIPFILE" "tailscale/bin/*-${ARCH}" -d "$TS_BIN_DIR" 2>/dev/null

install_bin tailscaled "$TAILSCALE_REPO" "$TAILSCALE_VERSION" "tailscale_.*_${ARCH}\\.tgz" tgz
install_bin jq "$JQ_REPO" "$JQ_VERSION" "$JQ_ASSET"
install_bin hev-socks5-tunnel "$HEV_REPO" "$HEV_VERSION" "hev-socks5-tunnel-linux-${HEV_ARCH}"
ln -sf tailscaled "${TS_BIN_DIR}/tailscale"

# --- Scripts, hooks, configuration -------------------------------------------

ui_print "- Installing scripts"
if ! unzip -qqjo "$ZIPFILE" 'tailscale/scripts/*' \
  -x 'tailscale/scripts/foxytail.tun.up' 'tailscale/scripts/foxytail.tun.down' \
  -d "$TS_SCRIPTS_DIR"; then
  abort "! Failed to extract tailscale/scripts"
fi

# User hooks: never overwrite local modifications. If the installed hook
# differs from the new template, keep the user's copy and drop the template
# next to it as <hook>.new.
for hook in foxytail.tun.up foxytail.tun.down; do
  if ! unzip -qqjo "$ZIPFILE" "tailscale/scripts/${hook}" -d "$TMPDIR"; then
    abort "! Failed to extract ${hook}"
  fi
  if [ -f "${TS_SCRIPTS_DIR}/${hook}" ]; then
    if ! cmp -s "${TMPDIR}/${hook}" "${TS_SCRIPTS_DIR}/${hook}"; then
      cp "${TMPDIR}/${hook}" "${TS_SCRIPTS_DIR}/${hook}.new"
      ui_print "- ${hook}: your modified copy was kept;"
      ui_print "  new template saved as scripts/${hook}.new"
    fi
    rm -f "${TMPDIR}/${hook}"
  else
    mv "${TMPDIR}/${hook}" "${TS_SCRIPTS_DIR}/${hook}"
  fi
done

# Configuration templates: install only when missing (user edits survive
# module upgrades; unzip -n never overwrites).
if ! unzip -qqjn "$ZIPFILE" 'tailscale/conf/*' -d "$TS_CONF_DIR"; then
  abort "! Failed to extract tailscale/conf"
fi

# --- Permissions -------------------------------------------------------------
# /data/adb is NOT the system partition: plain ownership/modes only, no SELinux
# relabeling. Magisk's set_perm_recursive without a context argument leaves the
# SELinux label untouched. $MODPATH gets the regular systemless labels.

ui_print "- Setting permissions"
set_perm_recursive "$TS_BIN_DIR" 0 0 0755 0755
set_perm_recursive "$TS_SCRIPTS_DIR" 0 0 0755 0755
set_perm_recursive "$TS_CONF_DIR" 0 0 0755 0644
set_perm "${TS_DIR}/settings.sh" 0 0 0644

set_perm "$MODPATH/service.sh" 0 0 0755 "u:object_r:system_file:s0"
set_perm "$MODPATH/uninstall.sh" 0 0 0755 "u:object_r:system_file:s0"
[ -d "$MODPATH/webroot" ] &&
  set_perm_recursive "$MODPATH/webroot" 0 0 0755 0644 "u:object_r:system_file:s0"

# --- Symlinks into the systemless PATH ---------------------------------------

mkdir -p "$MODPATH/system/bin"
ln -sf "${TS_BIN_DIR}/tailscaled" "$MODPATH/system/bin/tailscaled"
ln -sf "${TS_BIN_DIR}/tailscaled" "$MODPATH/system/bin/tailscale"
for s in "${TS_SCRIPTS_DIR}"/foxytail.*; do
  [ -f "$s" ] || continue
  case "$(basename "$s")" in
    *.yaml | *.new) continue ;;
  esac
  ln -sf "$s" "$MODPATH/system/bin/$(basename "$s")"
done

# Only now does system/bin exist with its symlinks: set perms/labels last.
set_perm_recursive "$MODPATH/system/bin" 0 0 0755 0755 "u:object_r:system_file:s0"

# --- Environment probes (advisory only, never abort) --------------------------

if [ -c /dev/net/tun ]; then
  ui_print "- /dev/net/tun present: tun mode available"
else
  ui_print "! /dev/net/tun missing: tun mode is unavailable;"
  ui_print "! bridge (default) and proxy modes still work"
fi
if iptables -m owner --help >/dev/null 2>&1 ||
  grep -qw owner /proc/net/ip_tables_matches 2>/dev/null; then
  ui_print "- xt_owner present: per-App routing available"
else
  ui_print "! xt_owner match missing: per-App route scopes"
  ui_print "! (selected/bypass) will not work on this kernel"
fi

# --- Start service in background ----------------------------------------------

ui_print "- Starting FoxyTail service in background"
"${TS_SCRIPTS_DIR}/start.sh" postinstall >/dev/null 2>&1 &

# --- /dev shortcuts + quickstart ----------------------------------------------
# /dev is a tmpfs: these links survive only until the next reboot, which is
# exactly when the systemless $MODPATH/system/bin mount takes over.

ln -sf "${TS_BIN_DIR}/tailscaled" /dev/tailscaled
ln -sf "${TS_BIN_DIR}/tailscaled" /dev/tailscale
ln -sf "${TS_SCRIPTS_DIR}/foxytail.service" /dev/foxytail.service

ui_print "-----------------------------------------------------------"
ui_print " Quick start"
ui_print "-----------------------------------------------------------"
if [ -f "${TS_DIR}/state/tailscaled.state" ] || [ -f "${TS_DIR}/tailscaled.state" ]; then
  ui_print "- Welcome back. Your tailscaled state was preserved."
  ui_print "- Until reboot, manage the service via:"
  ui_print "    su -c '/dev/foxytail.service status'"
  ui_print "- After reboot the commands are on PATH:"
  ui_print "    su -c 'foxytail.service status'"
else
  ui_print "- New install. Until reboot, log in via:"
  ui_print "    su -c '/dev/tailscale login'"
  ui_print "    su -c '/dev/foxytail.service status'"
  ui_print "- After reboot simply:"
  ui_print "    su -c 'tailscale login'"
fi
ui_print "- Docs: README.md / README.zh-CN.md in the module repo"
