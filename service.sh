#!/system/bin/sh
# FoxyTail - Magisk/KernelSU late-start service.
# Wait for boot to complete (300s cap) and for a default route (60s cap),
# then hand over to the FoxyTail entry point.

_i=0
while [ "$(getprop sys.boot_completed)" != "1" ]; do
  _i=$((_i + 1))
  if [ "$_i" -ge 300 ]; then
    exit 1
  fi
  sleep 1
done

_i=0
while [ -z "$(ip route show default 2>/dev/null)" ]; do
  _i=$((_i + 1))
  if [ "$_i" -ge 60 ]; then
    break
  fi
  sleep 1
done

/data/adb/foxytail/scripts/start.sh
