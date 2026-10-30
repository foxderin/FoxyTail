#!/system/bin/sh
# Boot/install and explicit settings reload share the same complete startup.
DIR=$(dirname "$(realpath "$0")")
# shellcheck source=../settings.sh
. "$DIR"/../settings.sh
ensure_run_dirs

# A reboot or interrupted upgrade must not silently keep an unconfirmed trial.
_start_applied=
case "${1:-start}" in
  start|postinstall|enable)
    _start_applied=--boot
    if [ -x "${TS_SCRIPTS_DIR}/foxytail.trial" ]; then
      "${TS_SCRIPTS_DIR}/foxytail.trial" boot
      _start_trial_rc=$?
      case "${_start_trial_rc}" in 0|3) ;; *) exit 1 ;; esac
    fi
    # run/ survives reboot. Never promote saved edits during automatic recovery.
    if [ -e "${TS_RUN_DIR}/applied-config" ] || [ -L "${TS_RUN_DIR}/applied-config" ]; then
      _start_applied=--applied
    fi ;;
esac

stop_inotifyd() {
  daemon_stop_pidfile inotifyd
}

start_inotifyd() (
  [ -x "${TS_SCRIPTS_DIR}/foxytail.inotify" ] || exit 0
  _lock_identity || exit 1
  _si_token=${_LOCK_TOKEN} _si_lock="${TS_PID_DIR}/.inotifyd.lock"
  _owner_lock_acquire "${_si_lock}" "${_si_token}" 100 0.1 || exit 1
  _si_published=0 _si_pid='' _si_stamp='' _si_boot=''
  trap 'if [ "${_si_published}" = 0 ] && resident_identity_alive inotifyd "${_si_pid}" "${_si_stamp}" "${_si_boot}"; then kill -TERM "${_si_pid}" 2>/dev/null; fi; rm -f "${TS_PID_DIR}/inotifyd.pid.$$"; _owner_lock_release "${_si_lock}" "${_si_token}"' 0
  trap 'exit 1' HUP INT TERM
  daemon_pid_alive inotifyd && exit 0
  # The watched entity is the manager-visible module directory. During a staged
  # install TS_MOD_DIR names the staging tree; watch the live directory when it
  # exists so a manager `disable` toggle is seen without waiting for reboot.
  _si_watch=${TS_MOD_DIR}
  [ ! -d /data/adb/modules/foxytail ] || _si_watch=/data/adb/modules/foxytail
  inotifyd "${TS_SCRIPTS_DIR}/foxytail.inotify" "${_si_watch}" \
    >>"${TS_RUN_DIR}/inotifyd.log" 2>&1 &
  _si_pid=$! _si_boot=$(boot_identity)
  _si_stamp=$(_proc_starttime "${_si_pid}") || exit 1
  _si_i=0
  until resident_identity_alive inotifyd "${_si_pid}" "${_si_stamp}" "${_si_boot}"; do
    [ "$(_proc_starttime "${_si_pid}")" = "${_si_stamp}" ] && [ "${_si_i}" -lt 20 ] || exit 1
    sleep 0.05
    _si_i=$((_si_i + 1))
  done
  printf '%s %s %s\n' "${_si_pid}" "${_si_stamp}" "${_si_boot}" >"${TS_PID_DIR}/inotifyd.pid.$$" &&
    mv "${TS_PID_DIR}/inotifyd.pid.$$" "${TS_PID_DIR}/inotifyd.pid" || exit 1
  _si_published=1
)

stop_residents() {
  _sr_failed=0
  for _sr_name in foxytail.watchdog foxytail.context foxytail.stats foxytail.logd; do
    [ -x "${TS_SCRIPTS_DIR}/${_sr_name}" ] || continue
    "${TS_SCRIPTS_DIR}/${_sr_name}" stop || _sr_failed=1
  done
  return "$_sr_failed"
}

start_residents() {
  load_runtime_conf || return 1
  _sr_failed=0
  for _sr_name in foxytail.stats foxytail.watchdog foxytail.context foxytail.logd; do
    [ -x "${TS_SCRIPTS_DIR}/${_sr_name}" ] || continue
    nohup "${TS_SCRIPTS_DIR}/${_sr_name}" start \
      >>"${TS_RUN_DIR}/${_sr_name}.log" 2>&1 &
    _sr_child=$!
    _sr_i=0
    while kill -0 "${_sr_child}" 2>/dev/null && ! daemon_pid_alive "${_sr_name}" && [ "${_sr_i}" -lt 20 ]; do
      sleep 0.1
      _sr_i=$((_sr_i + 1))
    done
    if ! daemon_pid_alive "${_sr_name}"; then
      if kill -0 "${_sr_child}" 2>/dev/null; then
        log Error "${_sr_name} did not confirm startup"
        _sr_failed=1
      else
        # Disabled watchdog / empty context rules are successful no-ops.
        wait "${_sr_child}" || _sr_failed=1
      fi
    fi
  done
  return "${_sr_failed}"
}

case "${1:-start}" in
  pause-residents) stop_residents; exit $? ;;
  resume-residents)
    [ ! -f "${TS_MOD_DIR}/disable" ] && [ ! -f "${TS_RUN_DIR}/manual-stop" ] || exit 1
    start_residents; exit $? ;;
  stop)
    # Stop controllers before the resources they can recreate.
    stop_inotifyd || exit 1
    stop_residents || exit 1
    "${TS_SCRIPTS_DIR}/foxytail.service" stop --internal
    exit $?
    ;;
  reload-residents)
    load_runtime_conf || exit 1
    stop_residents || exit 1
    [ -f "${TS_MOD_DIR}/disable" ] || start_residents || exit 1
    exit 0
    ;;
  reload)
    if conf_trial_active; then
      log Error 'confirm or revert the active configuration trial before restarting'
      exit 1
    fi
    stop_residents || exit 1
    _start_action=restart
    ;;
  reload-trial)
    "${TS_SCRIPTS_DIR}/foxytail.service" trial "$2" "$3"
    exit $? ;;
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
if [ -n "${_start_applied}" ]; then
  "${TS_SCRIPTS_DIR}/foxytail.service" "$_start_action" "${_start_applied}" || _start_rc=1
else
  "${TS_SCRIPTS_DIR}/foxytail.service" "$_start_action" || _start_rc=1
fi
start_residents || _start_rc=1
if [ -x "${TS_SCRIPTS_DIR}/foxytail.compat" ]; then
  "${TS_SCRIPTS_DIR}/foxytail.compat" probe >"${TS_RUN_DIR}/compat.json" 2>/dev/null
fi
# The watcher must run on every start path, including a manual `enable`:
# start_inotifyd is idempotent and returns early when one is already alive.
start_inotifyd || _start_rc=1
if [ "${1:-}" = reload ] && [ "$_start_rc" = 0 ]; then
  if conf_lock_acquire; then
    if _conf_runtime_dir && [ "${_RUNTIME_CONF_DIR}" != "${TS_CONF_DIR}" ] &&
       [ -f "${_RUNTIME_CONF_DIR}/revision" ] &&
       [ "$(cat "${TS_RUN_DIR}/settings.pending" 2>/dev/null)" = "$(cat "${_RUNTIME_CONF_DIR}/revision")" ]; then
      rm -f "${TS_RUN_DIR}/settings.pending"
    fi
    conf_lock_release
  else
    _start_rc=1
  fi
fi
exit "$_start_rc"
