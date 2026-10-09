#!/system/bin/sh
# FoxyTail - Magisk/KernelSU late-start service.
# Recover shared software before loading settings or any replaceable script.
# Keep ownership until startup returns so an installer cannot switch under boot.

TS_DIR="/data/adb/foxytail"
MODDIR=${0%/*}
# shellcheck source=install-recovery.sh
. "$MODDIR/install-recovery.sh" || exit 1
install_lock || exit 1
trap 'install_unlock' 0
trap 'exit 1' HUP INT TERM
install_recover_locked || { echo 'FoxyTail installation recovery failed; startup deferred' >&2; exit 1; }
DIR="$TS_DIR/scripts"
# shellcheck source=tailscale/settings.sh
. "$TS_DIR/settings.sh" || exit 1

_i=0
while [ "$(getprop sys.boot_completed)" != "1" ]; do
  _i=$((_i + 1))
  if [ "$_i" -ge 300 ]; then
    exit 1
  fi
  sleep 1
done

_i=0
while command -v network_snapshot >/dev/null 2>&1 && ! network_snapshot >/dev/null 2>&1; do
  _i=$((_i + 1))
  if [ "$_i" -ge 60 ]; then
    break
  fi
  sleep 1
done

"$TS_DIR/scripts/start.sh"
_service_result=$?
exit "$_service_result"
