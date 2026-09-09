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

# Snapshot the installed versionCode before anything extracts into
# $MODPATH; the backup pass below names its directory after it.
PROP_FILE="$(echo "$MODPATH" | sed 's/_update//')/module.prop"
[ ! -f "$PROP_FILE" ] && PROP_FILE="$MODPATH/module.prop"
OLD_CODE=$(grep '^versionCode=' "$PROP_FILE" 2>/dev/null | cut -d= -f2)
OLD_CODE="${OLD_CODE:-unknown}"
case "$OLD_CODE" in *[!0-9]* | '') OLD_CODE=unknown ;; esac

# --- Extract module files ----------------------------------------------------
# Everything under tailscale/ except settings.sh lives in $TS_DIR, not in the
# mounted module directory. unzip failures abort loudly: a half-extracted
# module must never install "successfully". Nothing below touches $TS_DIR:
# every payload is staged in TMPDIR first, so a failure anywhere in staging
# or verification aborts while the previous installation is still intact.

ui_print "- Extracting module files"
if ! unzip -qqo "$ZIPFILE" -d "$MODPATH" \
  -x 'META-INF/*' \
  'tailscale/bin/*' \
  'tailscale/scripts/*' \
  'tailscale/conf/*' \
  'tailscale/settings.sh' \
  'tailscale/checksums.txt' \
  'tailscale/native-checksums.txt' \
  'tailscale/VERSIONS'; then
  abort "! Failed to extract module files (corrupt zip?)"
fi

STAGE="${TMPDIR}/foxytail-stage"
mkdir -p "${STAGE}/root" "${STAGE}/scripts" "${STAGE}/hooks" \
  "${STAGE}/conf" "${STAGE}/bin/unpack"

for f in tailscale/settings.sh tailscale/VERSIONS tailscale/checksums.txt tailscale/native-checksums.txt; do
  if ! unzip -qqjo "$ZIPFILE" "$f" -d "${STAGE}/root"; then
    abort "! Failed to extract $f"
  fi
done
if ! unzip -qqjo "$ZIPFILE" 'tailscale/scripts/*' \
  -x 'tailscale/scripts/foxytail.tun.up' 'tailscale/scripts/foxytail.tun.down' \
  -d "${STAGE}/scripts"; then
  abort "! Failed to extract tailscale/scripts"
fi
for hook in foxytail.tun.up foxytail.tun.down; do
  if ! unzip -qqjo "$ZIPFILE" "tailscale/scripts/${hook}" -d "${STAGE}/hooks"; then
    abort "! Failed to extract ${hook}"
  fi
done
if ! unzip -qqjo "$ZIPFILE" 'tailscale/conf/*' -d "${STAGE}/conf"; then
  abort "! Failed to extract tailscale/conf"
fi

# Pinned upstream versions used by the install-time downloader.
# shellcheck source=/dev/null
. "${STAGE}/root/VERSIONS"

# The exclusions above leave only empty tailscale/* directory entries in
# $MODPATH; remove them.
rm -rf "${MODPATH}/tailscale"

# --- Download helpers --------------------------------------------------------

# wget with TLS verification first; when (and only when) the failure is a
# certificate error - the Magisk installer environment usually has no CA
# store - warn and retry that single download without certificate
# verification. Real integrity is enforced afterwards by the mandatory
# SHA256 check against checksums.txt.
wget_tls() {
  _wt_timeout="$1"
  shift
  if wget --timeout="$_wt_timeout" "$@" 2>"${TMPDIR}/.wget-err"; then
    return 0
  fi
  if ! grep -qi 'certificate' "${TMPDIR}/.wget-err" 2>/dev/null; then
    return 1
  fi
  ui_print "! WARNING: TLS certificate verification failed (no CA store in"
  ui_print "! the installer environment). Retrying without certificate"
  ui_print "! verification; integrity is still enforced by SHA256 below."
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

# verify_bin <staged-name>: mandatory SHA256 check against the staged
# checksums.txt. Applies to zip-bundled binaries too - a tampered zip must
# not slip through. Aborts on mismatch or missing entry.
verify_bin() {
  _vb_line=$(grep "  $1\$" "${STAGE}/root/checksums.txt" 2>/dev/null)
  if [ -z "$_vb_line" ]; then
    abort "! No checksum entry for $1 in checksums.txt - refusing to install"
  fi
  if ! (cd "${STAGE}/bin" && printf '%s\n' "$_vb_line" | sha256sum -c - >/dev/null 2>&1); then
    abort "! SHA256 mismatch for $1 - refusing to install"
  fi
}

# First-party helpers are mandatory in both package variants. Their manifest
# is generated from the tagged source build, separate from reviewed upstream
# hashes; installation never downloads a substitute or reuses an older helper.
verify_native_bin() {
  _vn_name="$1"
  _vn_manifest="${STAGE}/root/native-checksums.txt"
  [ -f "${STAGE}/bin/${_vn_name}" ] || abort "! Missing bundled ${_vn_name}"
  _vn_count=$(awk -v name="$_vn_name" '$2==name {n++} END {print n+0}' "$_vn_manifest")
  [ "$_vn_count" = 1 ] || abort "! Expected one native checksum for ${_vn_name}"
  _vn_line=$(awk -v name="$_vn_name" '$2==name {print}' "$_vn_manifest")
  if ! (cd "${STAGE}/bin" && printf '%s\n' "$_vn_line" | sha256sum -c - >/dev/null 2>&1); then
    abort "! SHA256 mismatch for ${_vn_name} - refusing to install"
  fi
}

# install_bin <name> <repo> <tag> <asset-regex> [tgz]: use the zip-bundled
# <name>-$ARCH when present (full zip), otherwise download the pinned
# release asset (light zip). With a 5th arg of "tgz" the downloaded asset is
# an archive whose top level contains the bare <name> binary (tailscale
# ships tailscaled only inside tailscale_<ver>_<arch>.tgz). Either way the
# binary ends up staged as <name>-$ARCH and verified; moving it into
# $TS_BIN_DIR happens later, after every download has passed.
install_bin() {
  _ib_name="$1"
  if [ ! -f "${STAGE}/bin/${_ib_name}-${ARCH}" ]; then
    gh_download "$2" "$3" "$4" "${STAGE}/bin/${_ib_name}.download" ||
      abort "! Unable to obtain ${_ib_name} for ${ARCH}"
    if [ "${5:-}" = "tgz" ]; then
      tar -xzf "${STAGE}/bin/${_ib_name}.download" -C "${STAGE}/bin/unpack" ||
        abort "! Failed to unpack the ${_ib_name} archive"
      mv -f "${STAGE}/bin/unpack/${_ib_name}" "${STAGE}/bin/${_ib_name}-${ARCH}" ||
        abort "! Unexpected contents in the ${_ib_name} archive"
      rm -f "${STAGE}/bin/${_ib_name}.download"
    else
      mv -f "${STAGE}/bin/${_ib_name}.download" "${STAGE}/bin/${_ib_name}-${ARCH}" ||
        abort "! Unable to obtain ${_ib_name} for ${ARCH}"
    fi
  fi
  verify_bin "${_ib_name}-${ARCH}"
}

# --- Binaries ----------------------------------------------------------------

ui_print "- Downloading and verifying binaries"
# The native helper is present in both variants; upstream binaries are bundled
# only in the full ZIP. Do not proceed after a failed extraction.
unzip -qqjo "$ZIPFILE" "tailscale/bin/*-${ARCH}" -d "${STAGE}/bin" ||
  abort "! Failed to extract bundled binaries"
verify_native_bin "foxydns-${ARCH}"

install_bin tailscaled "$TAILSCALE_REPO" "$TAILSCALE_VERSION" "tailscale_.*_${ARCH}\\.tgz" tgz
install_bin jq "$JQ_REPO" "$JQ_VERSION" "$JQ_ASSET"
install_bin hev-socks5-tunnel "$HEV_REPO" "$HEV_VERSION" "hev-socks5-tunnel-linux-${HEV_ARCH}"

# --- Prepare a complete replacement before stopping the installed version ----
# Data (state, received files, certificates and backups) stays in place. The
# candidate contains software/config only, including user-provided binaries.
CANDIDATE="${TS_DIR}/.install-$$"
BACKUP="${TS_DIR}/backups/${OLD_CODE}-$(date +%Y%m%d-%H%M%S)-$$"
rollback_install() {
  _ri_ok=0
  for _ri_part in bin scripts conf settings.sh VERSIONS checksums.txt native-checksums.txt; do
    if [ -e "${BACKUP}/${_ri_part}" ] || [ -e "${BACKUP}/.absent-${_ri_part}" ]; then
      if ! rm -rf "${TS_DIR:?}/${_ri_part}"; then
        _ri_ok=1
        continue
      fi
      if [ -e "${BACKUP}/${_ri_part}" ]; then
        mv "${BACKUP}/${_ri_part}" "${TS_DIR}/${_ri_part}" || _ri_ok=1
      fi
    fi
  done
  if [ "$_ri_ok" = 0 ]; then
    rm -f "${TS_DIR}/.installing" "${TS_DIR}/.install-transaction"
  fi
  return "$_ri_ok"
}

install_abort() {
  ui_print "! Installation switch failed: $1"
  _INSTALL_SWITCH_ACTIVE=0
  if rollback_install; then
    ui_print "! Previous software restored; restart FoxyTail after resolving the error"
  else
    ui_print "! Rollback incomplete; original files remain in ${BACKUP}"
  fi
  abort "! Installation failed; not reporting success"
}

switch_install() {
  mkdir -p "$BACKUP" || return 1
  for _sw_part in bin scripts conf settings.sh VERSIONS checksums.txt native-checksums.txt; do
    # Record absence as well, so rollback removes a newly installed entry.
    if [ -e "${TS_DIR}/${_sw_part}" ]; then
      mv "${TS_DIR}/${_sw_part}" "${BACKUP}/${_sw_part}" || return 1
    else
      : >"${BACKUP}/.absent-${_sw_part}" || return 1
    fi
    mv "${CANDIDATE}/${_sw_part}" "${TS_DIR}/${_sw_part}" || return 1
  done
}

# Recover an interrupted earlier switch before reading installed software.
# Journal paths are constrained to our backups directory; configuration is not
# executed to select the recovery source.
if [ -f "${TS_DIR}/.install-transaction" ]; then
  _RECOVERY_BACKUP=$(cat "${TS_DIR}/.install-transaction")
  case "$_RECOVERY_BACKUP" in
    "${TS_DIR}/backups/"*)
      _RECOVERY_NAME=${_RECOVERY_BACKUP#"${TS_DIR}/backups/"}
      case "$_RECOVERY_NAME" in ''|*[!A-Za-z0-9_-]*) abort "! Invalid installation journal" ;; esac
      ;;
    *) abort "! Invalid installation journal" ;;
  esac
  _NEXT_BACKUP=$BACKUP
  BACKUP=$_RECOVERY_BACKUP
  [ -d "$BACKUP" ] && rollback_install || abort "! Unable to recover previous interrupted installation"
  BACKUP=$_NEXT_BACKUP
fi

install_interrupted() {
  if [ "${_INSTALL_SWITCH_ACTIVE:-0}" = 1 ]; then
    _INSTALL_SWITCH_ACTIVE=0
    ui_print "! Interrupted install; restoring previous software"
    rollback_install || ui_print "! Recovery incomplete; retained journal for the next installation"
  fi
}

mkdir -p "${CANDIDATE}/bin" "${CANDIDATE}/scripts" "${CANDIDATE}/conf" ||
  abort "! Unable to create installation staging directory"
for _part in bin scripts conf; do
  if [ -d "${TS_DIR}/${_part}" ]; then
    cp -a "${TS_DIR}/${_part}/." "${CANDIDATE}/${_part}/" ||
      abort "! Unable to preserve installed ${_part}; old installation unchanged"
  fi
done
for b in tailscaled jq hev-socks5-tunnel foxydns; do
  cp -f "${STAGE}/bin/${b}-${ARCH}" "${CANDIDATE}/bin/${b}" ||
    abort "! Unable to prepare ${b}; old installation unchanged"
done
ln -sf tailscaled "${CANDIDATE}/bin/tailscale" || abort "! Failed to prepare tailscale symlink"
cp -f "${STAGE}/scripts/"* "${CANDIDATE}/scripts/" || abort "! Failed to prepare scripts"
for hook in foxytail.tun.up foxytail.tun.down; do
  if [ -f "${CANDIDATE}/scripts/${hook}" ]; then
    if ! cmp -s "${STAGE}/hooks/${hook}" "${CANDIDATE}/scripts/${hook}"; then
      cp "${STAGE}/hooks/${hook}" "${CANDIDATE}/scripts/${hook}.new" || abort "! Failed to stage hook template"
      ui_print "- ${hook}: kept your copy; new template saved as ${hook}.new"
    fi
  else
    cp "${STAGE}/hooks/${hook}" "${CANDIDATE}/scripts/${hook}" || abort "! Failed to stage hook"
  fi
done
for f in "${STAGE}/conf/"*; do
  [ -f "$f" ] || continue
  if [ ! -e "${CANDIDATE}/conf/${f##*/}" ]; then
    cp "$f" "${CANDIDATE}/conf/${f##*/}" || abort "! Failed to stage configuration"
  fi
done
cp -f "${STAGE}/root/"* "$CANDIDATE/" || abort "! Failed to stage shared runtime"

# Match executable paths and exact script/callback arguments, never a broad
# `pkill -f foxytail`. The installer itself is outside these software paths.
installed_pids() {
  for _ip_proc in /proc/[0-9]*; do
    _ip_pid=${_ip_proc##*/}
    [ "$_ip_pid" != "$$" ] || continue
    _ip_exe=$(readlink "${_ip_proc}/exe" 2>/dev/null)
    case "$_ip_exe" in
      "${TS_BIN_DIR}/"*) echo "$_ip_pid"; continue ;;
    esac
    if tr '\0' '\n' <"${_ip_proc}/cmdline" 2>/dev/null |
      awk -v prefix="${TS_SCRIPTS_DIR}/" 'index($0,prefix)==1 {found=1} END {exit !found}'; then
      echo "$_ip_pid"
    fi
  done
}

quiesce_installed() {
  # Gate controllers in current/new versions. Old releases lack the gate,
  # hence explicit watcher and resident shutdown before the old service.
  : >"${TS_DIR}/.installing" || return 1
  for _qi_pid in $(installed_pids); do
    if tr '\0' '\n' <"/proc/${_qi_pid}/cmdline" 2>/dev/null |
      grep -qxF "${TS_SCRIPTS_DIR}/foxytail.inotify"; then
      kill -TERM "$_qi_pid" 2>/dev/null
    fi
  done
  for _qi_name in foxytail.watchdog foxytail.context foxytail.stats foxytail.logd; do
    [ ! -x "${TS_SCRIPTS_DIR}/${_qi_name}" ] ||
      "${TS_SCRIPTS_DIR}/${_qi_name}" stop || return 1
  done
  [ ! -x "${TS_SCRIPTS_DIR}/foxytail.service" ] ||
    "${TS_SCRIPTS_DIR}/foxytail.service" stop || return 1
  _qi_left=$(installed_pids)
  for _qi_pid in $_qi_left; do kill -TERM "$_qi_pid" 2>/dev/null; done
  _qi_tries=0
  while [ -n "$(installed_pids)" ] && [ "$_qi_tries" -lt 20 ]; do
    sleep 0.2
    _qi_tries=$((_qi_tries + 1))
  done
  [ -z "$(installed_pids)" ]
}

# Each successfully moved old entry is the rollback journal. Never replace an
# earlier backup on a reinstall of the same version.
# Old releases sourced configuration. Validate it with the newly shipped data
# parser before invoking any old controller, including its destructive stop.
if ! sh -c '. "$1"; load_conf' sh "${STAGE}/root/settings.sh"; then
  abort "! Existing configuration is invalid; refusing to execute the old controller"
fi
ui_print "- Stopping and verifying the previous installation"
if ! quiesce_installed; then
  rm -f "${TS_DIR}/.installing"
  abort "! Old processes did not stop; old files remain in place"
fi
if [ -d "$TS_CONF_DIR" ]; then
  cp -a "${TS_CONF_DIR}/." "${CANDIDATE}/conf/" || install_abort "latest configuration snapshot failed"
fi
ui_print "- Switching software; backup: ${BACKUP}"
printf '%s\n' "$BACKUP" >"${TS_DIR}/.install-transaction" || install_abort "cannot record installation journal"
_INSTALL_SWITCH_ACTIVE=1
trap 'install_interrupted' 0
trap 'exit 1' HUP INT TERM
switch_install || install_abort "file replacement failed"
rmdir "$CANDIDATE" 2>/dev/null

# Restore identity from an earlier uninstall, only when no active identity exists.
STATE_BACKUP="/data/adb/foxytail-state.backup"
if [ -f "$STATE_BACKUP" ] &&
  [ ! -f "${TS_DIR}/state/tailscaled.state" ] &&
  [ ! -f "${TS_DIR}/tailscaled.state" ]; then
  mkdir -p "${TS_DIR}/state" &&
    cp "$STATE_BACKUP" "${TS_DIR}/state/tailscaled.state" || install_abort "state restore failed"
  # A DNS preference journal belongs to the identity that created it. Restore
  # it only alongside that identity; never attach an old journal to a current
  # account or overwrite a journal retained by an ordinary module upgrade.
  DNS_PREF_BACKUP="/data/adb/foxytail-dns-preferences.backup"
  DNS_PREF_JOURNAL="${TS_DIR}/state/foxydns-preferences.json"
  if [ -f "$DNS_PREF_BACKUP" ] && [ ! -e "$DNS_PREF_JOURNAL" ] && [ ! -L "$DNS_PREF_JOURNAL" ]; then
    (umask 077; cp "$DNS_PREF_BACKUP" "$DNS_PREF_JOURNAL" && chmod 0600 "$DNS_PREF_JOURNAL") ||
      install_abort "DNS preference journal restore failed"
  fi
  ui_print "- Restored tailscaled identity from a previous install"
fi

# --- Permissions -------------------------------------------------------------
# /data/adb is NOT the system partition: plain ownership/modes only, no SELinux
# relabeling. Magisk's set_perm_recursive without a context argument leaves the
# SELinux label untouched. $MODPATH gets the regular systemless labels.

ui_print "- Setting permissions"
set_perm_recursive "$TS_BIN_DIR" 0 0 0755 0755 || install_abort "binary permissions"
set_perm_recursive "$TS_SCRIPTS_DIR" 0 0 0755 0755 || install_abort "script permissions"
set_perm_recursive "$TS_CONF_DIR" 0 0 0700 0600 || install_abort "configuration permissions"
set_perm "${TS_DIR}/settings.sh" 0 0 0644 || install_abort "runtime permissions"

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
  ui_print "- xt_owner present: bridge per-App routing available (native tun: all only)"
else
  ui_print "! xt_owner match missing: policy routing will refuse to apply"
  ui_print "! Use proxy mode on this kernel"
fi

# --- Start service in background ----------------------------------------------

_INSTALL_SWITCH_ACTIVE=0
rm -f "${TS_DIR}/.installing" "${TS_DIR}/.install-transaction"
ui_print "- Starting FoxyTail service and resident helpers in background"
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
