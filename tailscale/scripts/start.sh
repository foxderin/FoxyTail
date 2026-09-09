#!/system/bin/sh
# Boot/install and explicit settings reload share the same complete startup.
DIR=$(dirname "$(realpath "$0")")
# shellcheck source=../settings.sh
. "$DIR"/../settings.sh
if [ "${1:-}" != stop ]; then load_conf || exit 1; fi
ensure_run_dirs

stop_inotifyd() {
  _si_pids=""
  for _si_pid in $(busybox pidof inotifyd 2>/dev/null || pidof inotifyd 2>/dev/null); do
    if tr '\0' '\n' <"/proc/${_si_pid}/cmdline" 2>/dev/null |
      grep -qxF "${TS_SCRIPTS_DIR}/foxytail.inotify"; then
      _si_pids="${_si_pids} ${_si_pid}"
    fi
  done
  stop_by_pids inotifyd "$_si_pids"
}

start_inotifyd() {
  stop_inotifyd || return 1
  [ -x "${TS_SCRIPTS_DIR}/foxytail.inotify" ] || return 0
  inotifyd "${TS_SCRIPTS_DIR}/foxytail.inotify" "${TS_MOD_DIR}" \
    >>"${TS_RUN_DIR}/inotifyd.log" 2>&1 &
}

stop_residents() {
  _sr_failed=0
  for _sr_name in foxytail.watchdog foxytail.context foxytail.stats foxytail.logd; do
    [ -x "${TS_SCRIPTS_DIR}/${_sr_name}" ] || continue
    "${TS_SCRIPTS_DIR}/${_sr_name}" stop || _sr_failed=1
  done
  return "$_sr_failed"
}

start_residents() {
  for _sr_name in foxytail.stats foxytail.watchdog foxytail.context foxytail.logd; do
    [ -x "${TS_SCRIPTS_DIR}/${_sr_name}" ] || continue
    nohup "${TS_SCRIPTS_DIR}/${_sr_name}" start \
      >>"${TS_RUN_DIR}/${_sr_name}.log" 2>&1 &
  done
}

case "${1:-start}" in
  stop)
    # Stop controllers before the resources they can recreate.
    stop_inotifyd || exit 1
    stop_residents || exit 1
    "${TS_SCRIPTS_DIR}/foxytail.service" stop
    exit $?
    ;;
  reload-residents)
    stop_residents || exit 1
    [ -f "${TS_MOD_DIR}/disable" ] || start_residents
    exit 0
    ;;
  reload)
    _reload_revision=$(cat "${TS_RUN_DIR}/settings.pending" 2>/dev/null)
    stop_residents || exit 1
    _start_action=restart
    ;;
  postinstall|start|enable) _start_action=start ;;
  *) echo "usage: $0 {start|postinstall|reload|reload-residents|stop}" >&2; exit 1 ;;
esac

if [ -f "${TS_MOD_DIR}/disable" ]; then
  log Info "module disabled; starting watcher only"
  start_inotifyd || exit 1
  if [ "${1:-}" = reload ]; then
    log Warning "module is disabled; saved configuration remains pending"
    exit 1
  fi
  exit 0
fi

# Preserve run/ (PID files, route ownership, stats and manual-stop state).
# Even a partially ready tunnel needs the watchdog for eventual recovery.
_start_rc=0
"${TS_SCRIPTS_DIR}/foxytail.service" "$_start_action" || _start_rc=1
start_residents
if [ -x "${TS_SCRIPTS_DIR}/foxytail.compat" ]; then
  "${TS_SCRIPTS_DIR}/foxytail.compat" probe >"${TS_RUN_DIR}/compat.json" 2>/dev/null
fi
[ "${1:-}" = enable ] || start_inotifyd || _start_rc=1
if [ "${1:-}" = reload ] && [ "$_start_rc" = 0 ]; then
  if conf_lock_acquire; then
    if [ "$(cat "${TS_RUN_DIR}/settings.pending" 2>/dev/null)" = "${_reload_revision}" ]; then
      rm -f "${TS_RUN_DIR}/settings.pending"
    fi
    conf_lock_release
  else
    _start_rc=1
  fi
fi
exit "$_start_rc"
