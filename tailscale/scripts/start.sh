#!/system/bin/sh
# FoxyTail - main entry point.
#
#   start.sh              boot/normal start: service + daemons + watcher
#   start.sh postinstall  called by the installer: rebuild run dir, restart
#                         the service in the background, then exit
#
# When the module is disabled (disable flag file present) only the inotify
# watcher is started so a later re-enable brings everything up.

DIR=$(dirname "$(realpath "$0")")
# shellcheck source=../settings.sh
. "$DIR"/../settings.sh
load_conf
ensure_run_dirs

run_script() {
  # run_script <script> <args...>: call a sibling script when executable.
  _rs_name="$1"
  shift
  if [ -x "${TS_SCRIPTS_DIR}/${_rs_name}" ]; then
    "${TS_SCRIPTS_DIR}/${_rs_name}" "$@"
  else
    log Warning "${_rs_name} not found or not executable, skipped"
  fi
}

start_inotifyd() {
  # Replace only OUR watcher: match the callback path in /proc/<pid>/cmdline.
  _pids=$(busybox pidof inotifyd 2>/dev/null || pidof inotifyd 2>/dev/null)
  for _pid in $_pids; do
    if tr '\0' ' ' <"/proc/${_pid}/cmdline" 2>/dev/null | grep -q "foxytail.inotify"; then
      kill -TERM "$_pid" 2>/dev/null
    fi
  done
  if [ -x "${TS_SCRIPTS_DIR}/foxytail.inotify" ]; then
    log Info "starting foxytail inotify watcher"
    inotifyd "${TS_SCRIPTS_DIR}/foxytail.inotify" "${TS_MOD_DIR}" \
      >>"${TS_RUN_DIR}/inotifyd.log" 2>&1 &
  else
    log Warning "foxytail.inotify not found or not executable, skipped"
  fi
}

case "$1" in
  postinstall)
    # Stop the resident components first: wiping the run dir would orphan
    # their pid files and the next start would spawn duplicates.
    for _pi_s in foxytail.stats foxytail.watchdog foxytail.context; do
      if [ -x "${TS_SCRIPTS_DIR}/${_pi_s}" ]; then
        "${TS_SCRIPTS_DIR}/${_pi_s}" stop >/dev/null 2>&1
      fi
    done
    rm -rf "$TS_RUN_DIR"
    ensure_run_dirs
    if [ -f "${TS_MOD_DIR}/disable" ]; then
      log Info "module is disabled; skipping postinstall service restart"
      start_inotifyd
      exit 0
    fi
    if [ -x "${TS_SCRIPTS_DIR}/foxytail.service" ]; then
      "${TS_SCRIPTS_DIR}/foxytail.service" restart >/dev/null 2>&1 &
    else
      log Warning "foxytail.service not found, skipping postinstall restart"
    fi
    start_inotifyd
    exit 0
    ;;
esac

module_version=$(awk -F'=' '!/^ *#/ && /version=/ { print $2 }' "$TS_MOD_PROP" 2>/dev/null)
log Info "FoxyTail version: ${module_version}"

if [ -f "${TS_MOD_DIR}/disable" ]; then
  log Info "module is disabled; starting inotify watcher only"
  start_inotifyd
  exit 0
fi

run_script foxytail.service start
run_script foxytail.stats start >>"${TS_RUN_DIR}/foxytail.stats.log" 2>&1 &
run_script foxytail.watchdog start >>"${TS_RUN_DIR}/foxytail.watchdog.log" 2>&1 &
run_script foxytail.context start >>"${TS_RUN_DIR}/foxytail.context.log" 2>&1 &

if [ -x "${TS_SCRIPTS_DIR}/foxytail.compat" ]; then
  "${TS_SCRIPTS_DIR}/foxytail.compat" probe >"${TS_RUN_DIR}/compat.json" 2>/dev/null
fi

start_inotifyd
