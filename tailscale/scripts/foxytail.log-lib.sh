#!/system/bin/sh
# Source-only log maintenance. No work is performed until called by logd.
# inotifyd stdout is consumed by one resident shell, never a callback process
# per write. A two-second window coalesces bursts; a 30-second audit covers
# dropped events. Without usable events, retain the old two-second protection.

logd_config_signature() {
  # Checksums also detect equal-size in-place edits within one timestamp tick.
  # Do not follow a symlink that the configuration parser would reject.
  for _ldc_name in foxytail.conf routes.conf; do
    _ldc_file="${TS_CONF_DIR}/${_ldc_name}"
    if [ -L "${_ldc_file}" ]; then
      echo "${_ldc_name}:symlink"
    elif [ -f "${_ldc_file}" ]; then
      cksum "${_ldc_file}" 2>/dev/null || echo "${_ldc_name}:unreadable"
    elif [ -e "${_ldc_file}" ]; then
      echo "${_ldc_name}:not-regular"
    else
      echo "${_ldc_name}:missing"
    fi
  done
}

logd_reload_config() {
  _ldc_next=$(logd_config_signature)
  [ "${_LD_CONFIG_SET:-0}" != 1 ] || [ "${_ldc_next}" != "${_LD_CONFIG_SIGNATURE}" ] || return 0
  # The speculative comparison cannot authorize reading a mixed pair. Repeat
  # it under the same lock used by configuration writers and load_conf.
  conf_lock_acquire || return 1
  _ldc_next=$(logd_config_signature)
  if [ "${_LD_CONFIG_SET:-0}" != 1 ] || [ "${_ldc_next}" != "${_LD_CONFIG_SIGNATURE}" ]; then
    # Invalid files leave load_conf's safe defaults. Remember that version so
    # its parse diagnostic cannot cause a log/event/parse feedback loop.
    load_conf || :
    _LD_CONFIG_SIGNATURE=${_ldc_next}
    _LD_CONFIG_SET=1
  fi
  conf_lock_release
}

logd_rotate_all() {
  for _ldr_file in "${TS_RUN_DIR}"/*.log; do
    [ -f "${_ldr_file}" ] && [ ! -L "${_ldr_file}" ] || continue
    rotate_log "${_ldr_file}"
  done
}

logd_clock() {
  # Builtin read avoids a date process per event. Uptime also makes the audit
  # deadline independent of wall-clock/NTP changes. date is a host fallback.
  if { IFS=' ' read -r _ldc_uptime _ldc_rest </proc/uptime; } 2>/dev/null; then
    _LD_NOW=${_ldc_uptime%%.*}
  else
    _LD_NOW=$(date +%s)
  fi
}

logd_stop_events() {
  # Close the pipe's last reader before waiting. The child must not inherit
  # FD 3: a blocked producer then receives EPIPE instead of waiting on itself.
  if [ "${_LD_EVENTS_OPEN:-0}" = 1 ]; then
    exec 3>&-
    _LD_EVENTS_OPEN=0
  fi
  if [ -n "${_LD_WATCH_PID:-}" ]; then
    if logd_watch_owned; then
      kill "${_LD_WATCH_PID}" 2>/dev/null || :
      _lds_tries=0
      while [ "${_lds_tries}" -lt 10 ] && kill -0 "${_LD_WATCH_PID}" 2>/dev/null; do
        sleep 0.05
        _lds_tries=$((_lds_tries + 1))
      done
      # BusyBox only notices TERM at its outer poll loop. A full output pipe
      # or misbehaving watcher must not make module shutdown unbounded.
      if logd_watch_owned; then kill -KILL "${_LD_WATCH_PID}" 2>/dev/null || :; fi
    fi
    wait "${_LD_WATCH_PID}" 2>/dev/null || :
    _LD_WATCH_PID=
  fi
  [ -z "${_LD_FIFO:-}" ] || rm -f "${_LD_FIFO}"
  _LD_FIFO=
}

logd_watch_owned() {
  kill -0 "${_LD_WATCH_PID}" 2>/dev/null || return 1
  # Check birth identity before sending signals. Missing /proc is only a
  # host-test fallback; the shell's own child table must still contain it.
  if [ -n "${_LD_WATCH_STAMP:-}" ]; then
    [ "$(_proc_starttime "${_LD_WATCH_PID}")" = "${_LD_WATCH_STAMP}" ]
    return
  fi
  for _ldw_child in $(jobs -p); do
    [ "${_ldw_child}" != "${_LD_WATCH_PID}" ] || return 0
  done
  return 1
}

logd_start_events() {
  command -v inotifyd >/dev/null 2>&1 || return 1
  # Android mksh and BusyBox ash provide timed read. Other host shells retain
  # the polling fallback instead of spinning on an unsupported read option.
  # shellcheck disable=SC3045
  printf '\n' | (read -r -t 1 _lds_probe) 2>/dev/null || return 1
  [ -d "${TS_CONF_DIR}" ] || return 1
  # Keep the pipe outside the watched directory itself. FIFO writes also
  # generate modify notifications and would otherwise feed the watcher back
  # into itself. Directory watches are not recursive into run/pids.
  _LD_FIFO="${TS_PID_DIR}/.logd-events.$$"
  mkfifo -m 600 "${_LD_FIFO}" || { _LD_FIFO=; return 1; }
  exec 3<>"${_LD_FIFO}"
  _LD_EVENTS_OPEN=1
  # c=modify, n/d=create/delete, m/y=rename, D/M=self delete/move,
  # o/x=overflow/watch removal (BusyBox/toybox inotifyd event alphabet).
  inotifyd - "${TS_RUN_DIR}:cndmyDMox" "${TS_CONF_DIR}:cndmyDMox" 3>&- >"${_LD_FIFO}" 2>/dev/null &
  _LD_WATCH_PID=$!
  _LD_WATCH_STAMP=$(_proc_starttime "${_LD_WATCH_PID}")
  return 0
}

logd_note_event() {
  # A timed read can consume a line prefix before failing. The next read then
  # starts inside a path: its "x" must not masquerade as a removed watch.
  # Treat malformed records as lost events and audit, keeping a live watcher.
  case "$1" in
    '' | *[!cndmyDMoxu]*) _LD_RELOAD=1; _LD_SCAN=1; return 0 ;;
  esac
  case "$2" in
    "${TS_RUN_DIR}" | "${TS_CONF_DIR}") ;;
    *) _LD_RELOAD=1; _LD_SCAN=1; return 0 ;;
  esac
  case "$1" in
    *x* | *D* | *M* | *u*) _LD_RELOAD=1; _LD_SCAN=1; _LD_EVENT_FAULT=1 ;;
    *o*) _LD_RELOAD=1; _LD_SCAN=1 ;;
  esac
  case "$2/$3" in
    "${TS_CONF_DIR}/foxytail.conf" | "${TS_CONF_DIR}/routes.conf") _LD_RELOAD=1; _LD_SCAN=1 ;;
    "${TS_RUN_DIR}/"*.log) _LD_SCAN=1 ;;
  esac
}

logd_read_event() {
  # inotifyd separates fields with tabs; filenames containing spaces remain
  # a single field. The only accepted names are the fixed config/log paths.
  # shellcheck disable=SC3045
  IFS='	' read -r -t "$1" _lde_events _lde_dir _lde_name <&3
}

logd_cleanup() {
  if [ -n "${_LD_SLEEP_PID:-}" ]; then
    kill "${_LD_SLEEP_PID}" 2>/dev/null || :
    wait "${_LD_SLEEP_PID}" 2>/dev/null || :
    _LD_SLEEP_PID=
  fi
  logd_stop_events
  conf_lock_release
  if { IFS= read -r _ldc_pid <"${TS_PID_DIR}/foxytail.logd.pid"; } 2>/dev/null && [ "${_ldc_pid}" = "$$" ]; then
    rm -f "${TS_PID_DIR}/foxytail.logd.pid"
  fi
}

logd_pause() {
  sleep "$1" &
  _LD_SLEEP_PID=$!
  wait "${_LD_SLEEP_PID}" 2>/dev/null || :
  _LD_SLEEP_PID=
}

logd_run() {
  _LD_RUNNING=1
  _LD_AUDIT_SECONDS=30
  _LD_COALESCE_SECONDS=2
  # Some shells resume timed read after a flag-only trap. Exit runs our
  # cleanup immediately and also reaps a currently coalescing sleep child.
  trap 'exit 0' TERM INT HUP
  trap 'logd_cleanup' 0
  logd_reload_config || :
  logd_rotate_all
  logd_start_events || :
  logd_clock
  _LD_NEXT_AUDIT=$((_LD_NOW + _LD_AUDIT_SECONDS))
  while [ "${_LD_RUNNING}" = 1 ]; do
    _LD_RELOAD=0 _LD_SCAN=0 _LD_EVENT_FAULT=0
    logd_clock
    if [ -n "${_LD_WATCH_PID:-}" ] && kill -0 "${_LD_WATCH_PID}" 2>/dev/null; then
      _ld_wait=$((_LD_NEXT_AUDIT - _LD_NOW))
      if [ "${_ld_wait}" -gt 0 ] && logd_read_event "${_ld_wait}"; then
        logd_note_event "${_lde_events}" "${_lde_dir}" "${_lde_name}"
        [ "${_LD_RUNNING}" = 1 ] || break
        if [ "${_LD_SCAN}" = 1 ]; then
          logd_pause "${_LD_COALESCE_SECONDS}"
          [ "${_LD_RUNNING}" = 1 ] || break
          # Drain a bounded burst after the window. A full pipe cannot cause
          # starvation of rotation or shutdown, even under continuous writes.
          _ld_drained=0
          while [ "${_ld_drained}" -lt 256 ] && logd_read_event 0.01; do
            logd_note_event "${_lde_events}" "${_lde_dir}" "${_lde_name}"
            _ld_drained=$((_ld_drained + 1))
          done
        fi
      else
        _LD_RELOAD=1 _LD_SCAN=1
      fi
    else
      # A dead/unsupported watcher is not repeatedly respawned. Preserve
      # capacity protection, with periodic configuration checks, until restart.
      logd_stop_events
      logd_pause "${_LD_COALESCE_SECONDS}"
      _LD_SCAN=1
    fi
    [ "${_LD_RUNNING}" = 1 ] || break
    # One watch can disappear while the other keeps inotifyd alive. Do not
    # mistake that surviving PID for coverage of both current directories.
    [ "${_LD_EVENT_FAULT}" != 1 ] || logd_stop_events
    logd_clock
    if [ "${_LD_NOW}" -ge "${_LD_NEXT_AUDIT}" ]; then
      _LD_RELOAD=1 _LD_SCAN=1
      _LD_NEXT_AUDIT=$((_LD_NOW + _LD_AUDIT_SECONDS))
    fi
    [ "${_LD_RELOAD}" != 1 ] || logd_reload_config || :
    [ "${_LD_SCAN}" != 1 ] || logd_rotate_all
  done
}
