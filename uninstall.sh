#!/system/bin/sh
# FoxyTail - module uninstall hook.
# Stops every FoxyTail component, tears down routes/DNS chains, removes
# /data/adb/foxytail but keeps a backup of tailscaled.state.

TS_DIR="/data/adb/foxytail"
SCRIPTS_DIR="${TS_DIR}/scripts"
STATE_BACKUP="/data/adb/foxytail-state.backup"

say() {
  if type ui_print >/dev/null 2>&1; then
    ui_print "$1"
  else
    echo "$1"
  fi
}

# 1. Graceful stop, best effort.
if [ -x "${SCRIPTS_DIR}/foxytail.service" ]; then
  "${SCRIPTS_DIR}/foxytail.service" stop >/dev/null 2>&1
fi
for _s in foxytail.stats foxytail.watchdog foxytail.context; do
  if [ -x "${SCRIPTS_DIR}/${_s}" ]; then
    "${SCRIPTS_DIR}/${_s}" stop >/dev/null 2>&1
  fi
done

# 2. Teardown policy routing and MagicDNS chains.
if [ -x "${SCRIPTS_DIR}/foxytail.route" ]; then
  "${SCRIPTS_DIR}/foxytail.route" teardown >/dev/null 2>&1
fi
if [ -x "${SCRIPTS_DIR}/foxytail.dns" ]; then
  "${SCRIPTS_DIR}/foxytail.dns" stop >/dev/null 2>&1
fi

# 3. Kill leftovers. tailscaled is ours; dnsmasq/hev-socks5-tunnel/inotifyd
#    may belong to other modules, so only kill instances whose cmdline
#    references FoxyTail paths or scripts.
for _pid in $(pidof tailscaled 2>/dev/null); do
  kill -TERM "$_pid" 2>/dev/null
done
for _d in /proc/[0-9]*; do
  _pid=${_d#/proc/}
  [ "$_pid" = "$$" ] && continue
  _cmd=$(tr '\0' ' ' <"${_d}/cmdline" 2>/dev/null)
  case "$_cmd" in
    *foxytail.stats* | *foxytail.watchdog* | *foxytail.context* | \
      *foxytail.inotify* | *foxytail.tun* | *foxytail.dns* | *foxytail*)
      kill -TERM "$_pid" 2>/dev/null
      ;;
  esac
done

# 4. Keep a state backup, then remove the data directory. foxytail.service
#    uses --statedir=$TS_DIR/state; also check the legacy flat path.
for _state in "${TS_DIR}/state/tailscaled.state" "${TS_DIR}/tailscaled.state"; do
  if [ -f "$_state" ]; then
    mv "$_state" "$STATE_BACKUP"
    say "- tailscaled.state backed up to ${STATE_BACKUP}"
    break
  fi
done
rm -rf "$TS_DIR"
say "- FoxyTail data removed"
