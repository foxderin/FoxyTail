#!/system/bin/sh
# Function definitions only; caller supplies settings and runtime paths.

# tailscale status --json, empty string on timeout/failure.
ts_status_json() {
  _st=$(tmo 8 tailscale --socket="$TS_SOCKET" status --json 2>/dev/null)
  if [ -n "$_st" ] && printf '%s' "$_st" | jqr -e . >/dev/null 2>&1; then
    printf '%s' "$_st"
  fi
}

# Tailnet reachability: try quad-100 first, then the first online peer.
tailnet_reachable() {
  _targets="100.100.100.100"
  _st=$(ts_status_json)
  if [ -n "$_st" ]; then
    _peer=$(printf '%s' "$_st" | jqr -r \
      '[.Peer // {} | .[] | select(.Online == true) | .TailscaleIPs[0]] | .[0] // empty' \
      2>/dev/null)
    [ -n "$_peer" ] && _targets="$_targets $_peer"
  fi
  for _t in $_targets; do
    if tmo 10 tailscale --socket="$TS_SOCKET" ping --c=1 --timeout=3s "$_t" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

# Keep only restart timestamps inside the window; print how many remain.
# Mutates RESTARTS_FILE (compaction) - use restarts_count_ro for queries.
restarts_count() {
  _now=$(date +%s)
  if [ -f "$RESTARTS_FILE" ]; then
    awk -v cut="$((_now - RESTART_WINDOW))" '$1 >= cut' "$RESTARTS_FILE" \
      >"${RESTARTS_FILE}.tmp" 2>/dev/null
    mv "${RESTARTS_FILE}.tmp" "$RESTARTS_FILE"
  else
    : >"$RESTARTS_FILE"
  fi
  wc -l <"$RESTARTS_FILE" 2>/dev/null || echo 0
}

# Read-only variant for status reporting: never touches RESTARTS_FILE.
restarts_count_ro() {
  [ -f "$RESTARTS_FILE" ] || { echo 0; return; }
  awk -v cut="$(( $(date +%s) - RESTART_WINDOW ))" '$1 >= cut {n++} END {print n+0}' \
    "$RESTARTS_FILE"
}

# Recover tailscaled via "start" or "restart", with cooldown accounting.
recover() {
  _how="$1"
  _why="$2"
  _c=$(restarts_count)
  if [ "$_c" -ge $RESTART_LIMIT ]; then
    log Error "watchdog: >${RESTART_LIMIT} restarts in ${RESTART_WINDOW}s, cooling down ${COOLDOWN}s (${_why})"
    isleep $COOLDOWN
    : >"$RESTARTS_FILE"
    return 0
  fi
  date +%s >>"$RESTARTS_FILE"
  log Warning "watchdog: tailscaled recovery (${_why})"
  if [ -x "$SERVICE" ]; then
    "$SERVICE" "$_how" >>"${TS_RUN_LOG_FILE}" 2>&1
  else
    log Error "watchdog: foxytail.service not found, cannot recover"
  fi
}

bad_count_get() {
  _bc_value=""
  if [ -f "$BAD_COUNT_FILE" ]; then IFS= read -r _bc_value <"$BAD_COUNT_FILE"; fi
  case "$_bc_value" in ''|*[!0-9]*) _bc_value=0 ;; esac
  echo "$_bc_value"
}

bad_count_reset() {
  # Missing already means zero; a healthy round need not create a file.
  [ "$(bad_count_get)" = 0 ] || echo 0 >"$BAD_COUNT_FILE"
}

bad_count_inc() {
  _n=$(( $(bad_count_get) + 1 ))
  echo "$_n" >"$BAD_COUNT_FILE"
  echo "$_n"
}

check_once() {
  _state=""
  # 0. A user-requested stop (WebUI/CLI) is not a crash: stay down.
  if [ -f "$MANUAL_STOP_FILE" ]; then
    _wd_last_state=manual-stop
    return 0
  fi

  # 1. Process liveness.
  if [ -z "$(pids_of_path "${TS_BIN_DIR}/${TS_DAEMON_CMD}")" ]; then
    log Warning "watchdog: tailscaled process is dead"
    recover start "process-dead"
    return 0
  fi

  # 2. Backend state health (3 consecutive bad rounds -> restart).
  # Only an unanswered daemon (timeout/empty) counts as a strike. User-level
  # states (NeedsLogin/Stopped/Starting/...) mean the daemon is healthy and a
  # restart cannot fix them, so they reset the counter instead.
  _st=$(ts_status_json)
  if [ -z "$_st" ]; then
    _bad=$(bad_count_inc)
    log Warning "watchdog: tailscaled not answering (${_bad}/${BACKEND_BAD_LIMIT})"
    if [ "$_bad" -ge $BACKEND_BAD_LIMIT ]; then
      bad_count_reset
      recover restart "daemon-unreachable"
      return 0
    fi
  else
    _state=$(printf '%s' "$_st" | jqr -r '.BackendState // "unknown"' 2>/dev/null)
    if [ "$_state" != Running ] && [ "$_state" != "${_wd_last_state:-}" ]; then
      log Debug "watchdog: backend state '${_state}' (user state, no action)"
    fi
    bad_count_reset
  fi
  _wd_last_state=$_state

  # Reconcile layers after first login, a helper crash, or rule removal.
  # `route check` verifies complete desired state without resetting counters.
  if [ "$_state" = Running ]; then
    _wc_repair=0
    case "$TS_MODE" in
      bridge)
        [ -n "$(pids_of_path "${TS_BIN_DIR}/hev-socks5-tunnel")" ] || _wc_repair=1
        ;;
    esac
    if [ "$TS_MODE" != proxy ]; then
      "${TS_SCRIPTS_DIR}/foxytail.route" check >/dev/null 2>&1 || _wc_repair=1
    fi
    if [ "$MAGIC_DNS" = on ]; then
      _wc_dns=$("${TS_SCRIPTS_DIR}/foxytail.dns" status --json 2>/dev/null | jqr -r \
        'if (.repairNeeded | type) == "boolean" then .repairNeeded else (.state != "running") end')
      [ "$_wc_dns" = false ] || _wc_repair=1
    fi
    if [ "$_wc_repair" = 1 ]; then
      recover reconcile "companion-not-ready"
    fi
  fi

  # 3. Default route change -> verify tailnet connectivity.
  # Skipped unless the backend is Running: while logged out (NeedsLogin etc.)
  # the tailnet is unreachable by definition and a restart fixes nothing.
  _route=$(ip route show default 2>/dev/null | tr '\n' ' ' | tr -s ' ')
  _old=$(cat "$ROUTE_CACHE" 2>/dev/null)
  if [ "$_route" != "$_old" ]; then
    echo "$_route" >"$ROUTE_CACHE"
    if [ "$_state" = Running ] && [ -n "$_old" ]; then
      log Info "watchdog: default route changed, verifying tailnet connectivity"
      if tailnet_reachable; then
        log Info "watchdog: tailnet still reachable after network change"
      else
        recover restart "network-change"
      fi
    fi
  fi
  return 0
}

_watchdog_stop() {
  _wd_running=0
}

do_start() {
  if [ "$WATCHDOG" != "on" ]; then
    log Info "watchdog disabled (WATCHDOG=${WATCHDOG})"
    return 0
  fi
  daemon_claim_pidfile foxytail.watchdog || return 0
  _wd_running=1
  trap '_watchdog_stop' TERM INT
  log Info "foxytail.watchdog started (pid $$, interval ${WATCHDOG_INTERVAL}s)"
  while [ "$_wd_running" = "1" ]; do
    if load_conf; then
      [ "$WATCHDOG" = on ] || break
      check_once
    fi
    isleep "$WATCHDOG_INTERVAL"
  done
  rm -f "$PID_FILE"
  log Info "foxytail.watchdog stopped"
  return 0
}

do_stop() {
  daemon_stop_pidfile foxytail.watchdog
}

do_status() {
  # Read the pid once: the loop removes the file on exit, so a second read
  # could feed jq an empty string and produce broken JSON.
  _wds_pid=$(cat "$PID_FILE" 2>/dev/null)
  case "$_wds_pid" in '' | *[!0-9]*) _wds_pid="" ;; esac
  if [ -n "$_wds_pid" ] && kill -0 "$_wds_pid" 2>/dev/null; then
    jqr -n -c --argjson r true --argjson p "$_wds_pid" \
      --argjson i "$WATCHDOG_INTERVAL" --argjson n "$(restarts_count_ro)" \
      '{running:$r,pid:$p,interval:$i,restartsRecent:$n}'
  else
    jqr -n -c --argjson r false --argjson i "$WATCHDOG_INTERVAL" \
      --argjson n "$(restarts_count_ro)" \
      '{running:$r,pid:null,interval:$i,restartsRecent:$n}'
  fi
}
