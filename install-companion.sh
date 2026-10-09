#!/system/bin/sh
# A normal installed APK remains readable when KernelSU unmounts module overlays.
MODDIR=${0%/*}
APK="$MODDIR/companion/FoxyTail.apk"
PACKAGE=dev.foxderin.tail

install_companion() {
  _ic_sdk=$(getprop ro.build.version.sdk)
  case "$_ic_sdk" in ''|*[!0-9]*) echo 'Cannot determine Android version' >&2; return 1 ;; esac
  [ "$_ic_sdk" -ge 26 ] || { echo 'Android companion requires Android 8.0; module remains available'; return 0; }
  [ -f "$APK" ] && [ ! -L "$APK" ] || { echo 'Companion APK is missing or is a symlink' >&2; return 1; }
  _ic_expected=$(cat "$MODDIR/companion/FoxyTail.apk.sha256") || return 1
  case "$_ic_expected" in ''|*[!0-9a-f]*) echo 'Invalid companion checksum' >&2; return 1 ;; esac
  [ "${#_ic_expected}" -eq 64 ] || return 1
  _ic_actual=$(sha256sum "$APK") || return 1
  [ "${_ic_actual%% *}" = "$_ic_expected" ] || { echo 'Companion APK checksum mismatch' >&2; return 1; }
  _ic_paths=$(pm path --user 0 "$PACKAGE" 2>/dev/null) || _ic_paths=
  _ic_path=${_ic_paths#package:}
  # Only PackageManager-owned /data/app code can survive overlay removal.
  case "$_ic_path" in
    /data/app/*/base.apk)
      case "$_ic_path" in *'
'*) ;; *)
        _ic_installed=$(sha256sum "$_ic_path" 2>/dev/null) || _ic_installed=
        [ "${_ic_installed%% *}" != "$_ic_expected" ] || { echo 'Companion is already installed'; return 0; } ;;
      esac ;;
  esac
  _ic_size=$(wc -c <"$APK") || return 1
  command -v timeout >/dev/null 2>&1 || { echo 'Cannot safely install companion: timeout command unavailable' >&2; return 1; }
  # Stream into PackageManager; its shell service cannot read private /data/adb paths.
  _ic_result=$(timeout 90 pm install -r --user 0 -S "$_ic_size" <"$APK" 2>&1)
  _ic_rc=$?
  if [ "$_ic_rc" != 0 ]; then
    printf 'Companion install failed; existing app/data preserved: %s\n' "$_ic_result" >&2
    return 1
  fi
  _ic_paths=$(pm path --user 0 "$PACKAGE" 2>/dev/null) || return 1
  _ic_path=${_ic_paths#package:}
  case "$_ic_path" in /data/app/*/base.apk) ;; *) echo 'Companion was not installed into /data/app' >&2; return 1 ;; esac
  case "$_ic_path" in *'
'*) echo 'Unexpected split companion package' >&2; return 1 ;; esac
  _ic_installed=$(sha256sum "$_ic_path") || return 1
  [ "${_ic_installed%% *}" = "$_ic_expected" ] || { echo 'Installed companion does not match bundled APK' >&2; return 1; }
  echo 'FoxyTail companion installed; grant root in Magisk/KernelSU before use'
}

install_companion
