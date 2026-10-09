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

# Publish recovery in both roots before touching shared software. An interrupted
# modules_update install may never become the active module at the next boot.
install_recovery_entry() {
  _ie_root="$MODPATH"
  case "$MODPATH" in
    /data/adb/modules_update/foxytail)
      [ ! -d /data/adb/modules/foxytail ] || _ie_root=/data/adb/modules/foxytail ;;
  esac
  if [ "$_ie_root" != "$MODPATH" ]; then
    for _ie_file in install-recovery.sh service.sh; do
      cp "$MODPATH/$_ie_file" "$_ie_root/.$_ie_file-$$" &&
        chmod 0755 "$_ie_root/.$_ie_file-$$" &&
        mv -f "$_ie_root/.$_ie_file-$$" "$_ie_root/$_ie_file" || return 1
    done
  fi
}
# shellcheck source=install-recovery.sh
. "$MODPATH/install-recovery.sh" || abort "! Missing installation recovery helper"

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
for _native in foxydns foxyfiles; do
  verify_native_bin "${_native}-${ARCH}"
done

install_bin tailscaled "$TAILSCALE_REPO" "$TAILSCALE_VERSION" "tailscale_.*_${ARCH}\\.tgz" tgz
install_bin jq "$JQ_REPO" "$JQ_VERSION" "$JQ_ASSET"
install_bin hev-socks5-tunnel "$HEV_REPO" "$HEV_VERSION" "hev-socks5-tunnel-linux-${HEV_ARCH}"

# --- Prepare a complete replacement before stopping the installed version ----
# Data (state, received files, certificates and backups) stays in place. The
# candidate contains software/config only, including user-provided binaries.
CANDIDATE="${TS_DIR}/.install-$$"
BACKUP="${TS_DIR}/backups/${OLD_CODE}-$(date +%Y%m%d-%H%M%S)-$$"

install_abort() {
  ui_print "! Installation switch failed: $1"
  if [ "${_INSTALL_SWITCH_ACTIVE:-0}" = 1 ]; then
    _INSTALL_SWITCH_ACTIVE=0
    if rollback_install; then
      ui_print "! Previous software restored; restart FoxyTail after resolving the error"
    else
      ui_print "! Rollback incomplete; original files remain in ${BACKUP}"
    fi
  fi
  abort "! Installation failed; not reporting success"
}

install_interrupted() {
  if [ "${_INSTALL_SWITCH_ACTIVE:-0}" = 1 ]; then
    _INSTALL_SWITCH_ACTIVE=0
    ui_print "! Interrupted install; restoring previous software"
    rollback_install || ui_print "! Recovery incomplete; retained journal for boot recovery"
  fi
  rm -f "${TS_DIR}/.installing-$$" "${TS_DIR}/.install-transaction-$$"
  install_unlock
}

begin_install() {
  [ "${_INSTALL_LOCK_HELD:-0}" = 1 ] || install_lock || return 1
  # Never reuse an earlier snapshot, even if a PID/name is recycled.
  install_validate_backup && mkdir -p "$TS_DIR/backups" && mkdir "$BACKUP" || return 1
  (umask 077; printf '%s\n' "$_INSTALL_OWNER" >"$BACKUP/.install-owner") || return 1
  _INSTALL_SWITCH_ACTIVE=1
  trap 'install_interrupted' 0
  trap 'exit 1' HUP INT TERM
  (umask 077; printf '%s\n' "$_INSTALL_OWNER" >"${TS_DIR}/.installing-$$") &&
    mv "${TS_DIR}/.installing-$$" "${TS_DIR}/.installing" &&
    (umask 077; printf '%s\n' "$BACKUP" >"${TS_DIR}/.install-transaction-$$") &&
    mv "${TS_DIR}/.install-transaction-$$" "${TS_DIR}/.install-transaction"
}

switch_install() {
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
mkdir -p "$TS_DIR" || abort "! Unable to create runtime directory"
install_lock || abort "! Installation or boot recovery is already active"
trap 'install_interrupted' 0
trap 'exit 1' HUP INT TERM
install_recovery_entry || abort "! Unable to publish stable boot recovery"
_NEXT_BACKUP=$BACKUP
install_recover_locked || abort "! Unable to recover previous interrupted installation"
BACKUP=$_NEXT_BACKUP


mkdir -p "${CANDIDATE}/bin" "${CANDIDATE}/scripts" "${CANDIDATE}/conf" ||
  abort "! Unable to create installation staging directory"
for _part in bin scripts conf; do
  if [ -d "${TS_DIR}/${_part}" ]; then
    cp -a "${TS_DIR}/${_part}/." "${CANDIDATE}/${_part}/" ||
      abort "! Unable to preserve installed ${_part}; old installation unchanged"
  fi
done
for b in tailscaled jq hev-socks5-tunnel foxydns foxyfiles; do
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
    # Some Android vendors expose entries such as /proc/8350_reg. A leading
    # digit is insufficient: only an entirely numeric name can be a PID.
    case "${_ip_pid}" in ''|*[!0-9]*) continue ;; esac
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
  [ "$(cat "${TS_DIR}/.installing")" = "$_INSTALL_OWNER" ] || return 1
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
    "${TS_SCRIPTS_DIR}/foxytail.service" stop --internal || return 1
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
if ! sh -c 'DIR=$2; . "$1"; load_conf' sh "${STAGE}/root/settings.sh" "${STAGE}/scripts"; then
  abort "! Existing configuration is invalid; refusing to execute the old controller"
fi
begin_install || install_abort "cannot prepare installation journal"
ui_print "- Stopping and verifying the previous installation"
if ! quiesce_installed; then
  install_abort "old processes did not stop; old files remain in place"
fi
if [ -d "$TS_CONF_DIR" ]; then
  cp -a "${TS_CONF_DIR}/." "${CANDIDATE}/conf/" || install_abort "latest configuration snapshot failed"
fi
ui_print "- Switching software; backup: ${BACKUP}"
switch_install || install_abort "file replacement failed"
rmdir "$CANDIDATE" 2>/dev/null

# Restore identity from an earlier uninstall, only when no active identity exists.
STATE_BACKUP="/data/adb/foxytail-state.backup"
restore_identity() (
  # Publish the identity last: a failed journal restore must leave the next
  # install eligible to retry both files. Killed copies remain private staging
  # files, never active identities, and are ignored on the next attempt.
  umask 077
  mkdir -p "${TS_DIR}/state" && chmod 0700 "${TS_DIR}/state" || exit 1
  _RESTORE_STAGE=$(mktemp -d "${TS_DIR}/state/.restore-XXXXXX") || exit 1
  trap 'rm -rf "$_RESTORE_STAGE"' 0
  trap 'exit 1' HUP INT TERM
  cp "$STATE_BACKUP" "${_RESTORE_STAGE}/tailscaled.state" &&
    chmod 0600 "${_RESTORE_STAGE}/tailscaled.state" || exit 1
  # Never attach an old journal to a current identity or overwrite an existing
  # journal retained by an ordinary module upgrade.
  DNS_PREF_BACKUP="/data/adb/foxytail-dns-preferences.backup"
  DNS_PREF_JOURNAL="${TS_DIR}/state/foxydns-preferences.json"
  if [ -f "$DNS_PREF_BACKUP" ] && [ ! -e "$DNS_PREF_JOURNAL" ] && [ ! -L "$DNS_PREF_JOURNAL" ]; then
    cp "$DNS_PREF_BACKUP" "${_RESTORE_STAGE}/foxydns-preferences.json" &&
      chmod 0600 "${_RESTORE_STAGE}/foxydns-preferences.json" &&
      mv "${_RESTORE_STAGE}/foxydns-preferences.json" "$DNS_PREF_JOURNAL" || exit 1
  fi
  mv "${_RESTORE_STAGE}/tailscaled.state" "${TS_DIR}/state/tailscaled.state"
)

if [ -f "$STATE_BACKUP" ] &&
  [ ! -f "${TS_DIR}/state/tailscaled.state" ] &&
  [ ! -f "${TS_DIR}/tailscaled.state" ]; then
  restore_identity || install_abort "identity and DNS preference restore failed"
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
set_perm "$MODPATH/install-recovery.sh" 0 0 0755 "u:object_r:system_file:s0"
set_perm "$MODPATH/uninstall.sh" 0 0 0755 "u:object_r:system_file:s0"
[ -d "$MODPATH/webroot" ] &&
  set_perm_recursive "$MODPATH/webroot" 0 0 0755 0644 "u:object_r:system_file:s0"

# --- Symlinks into the systemless PATH ---------------------------------------

mkdir -p "$MODPATH/system/bin"
ln -sf "${TS_BIN_DIR}/tailscaled" "$MODPATH/system/bin/tailscaled"
ln -sf "${TS_BIN_DIR}/tailscaled" "$MODPATH/system/bin/tailscale"
for s in "${TS_SCRIPTS_DIR}"/foxytail.*; do
  [ -f "$s" ] || continue
  case "${s##*/}" in
    foxytail.webapi.sh) ;;
    *.sh | *.yaml | *.new) continue ;;
  esac
  ln -sf "$s" "$MODPATH/system/bin/${s##*/}"
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

# --- Commit and remove legacy /dev shortcuts ---------------------------------

rm -f "${TS_DIR}/.install-transaction" && rm -f "${TS_DIR}/.installing" || install_abort "cannot commit installation journal"
_INSTALL_SWITCH_ACTIVE=0
install_unlock
for _name in tailscale tailscaled foxytail.service; do
  case "$_name" in
    tailscale | tailscaled) _target="${TS_BIN_DIR}/tailscaled" ;;
    foxytail.service) _target="${TS_SCRIPTS_DIR}/foxytail.service" ;;
  esac
  _link="/dev/${_name}"
  if [ -L "$_link" ] && [ "$(readlink "$_link")" = "$_target" ]; then
    rm "$_link" || ui_print "! WARNING: Failed to remove legacy shortcut ${_link}; installed software retained"
  fi
done

# --- Start service in background ----------------------------------------------

ui_print "- Starting FoxyTail service and resident helpers in background"
"${TS_SCRIPTS_DIR}/start.sh" postinstall >/dev/null 2>&1 &

# --- Quickstart --------------------------------------------------------------

ui_print "-----------------------------------------------------------"
ui_print " Quick start"
ui_print "-----------------------------------------------------------"
if [ -f "${TS_DIR}/state/tailscaled.state" ] || [ -f "${TS_DIR}/tailscaled.state" ]; then
  ui_print "- Welcome back. Your tailscaled state was preserved."
  ui_print "- Until reboot, manage the service via:"
  ui_print "    su -c '${TS_SCRIPTS_DIR}/foxytail.service status'"
  ui_print "- After reboot the commands are on PATH:"
  ui_print "    su -c 'foxytail.service status'"
else
  ui_print "- New install. Until reboot, log in via:"
  ui_print "    su -c '${TS_BIN_DIR}/tailscale --socket=${TS_DIR}/run/tailscaled.sock login'"
  ui_print "    su -c '${TS_SCRIPTS_DIR}/foxytail.service status'"
  ui_print "- After reboot simply:"
  ui_print "    su -c 'tailscale login'"
fi
ui_print "- Docs: README.md / README.zh-CN.md in the module repo"
