#!/system/bin/sh
# Validated configuration writes, route preferences and runtime toggles.
# Sourced by foxytail.webapi.sh.

# --- control / mode -----------------------------------------------------------

_control_run() {
  if [ "$1" = restart ]; then "${TS_SCRIPTS_DIR}/start.sh" reload
  else "${TS_SCRIPTS_DIR}/foxytail.service" "$1"; fi
}

cmd_control() {
  case "$1" in
    start | stop | restart) ;;
    *) jerr "control: expected start|stop|restart" ;;
  esac
  if _control_run "$1" >>"${TS_RUN_LOG_FILE}" 2>&1; then
    _cc_pending=false
    [ ! -f "${TS_RUN_DIR}/settings.pending" ] || _cc_pending=true
    jqr -n -c --arg a "$1" --argjson p "${_cc_pending}" '{ok:true,action:$a,applied:(if $a=="restart" then ($p|not) else null end),restartRequired:$p}'
  else
    jerr "foxytail.service $1 failed (see ${TS_RUN_LOG_FILE})"
  fi
}

cmd_mode_set() {
  case "$1" in
    bridge | tun | proxy) ;;
    *) jerr "mode-set: expected bridge|tun|proxy" ;;
  esac
  if [ "$1" = tun ] && [ "${ROUTE_SCOPE}" != all ]; then
    jerr "native tun supports only route scope all; use bridge for UID routing"
  fi
  if [ "$1" = "tun" ] && [ ! -c /dev/net/tun ]; then
    jerr "tun mode unavailable: /dev/net/tun does not exist on this device"
  fi
  if "${TS_SCRIPTS_DIR}/foxytail.service" mode "$1" >>"${TS_RUN_LOG_FILE}" 2>&1; then
    jqr -n -c --arg m "$1" '{ok:true,mode:$m}'
  else
    jerr "failed to switch mode to $1"
  fi
}

# --- routes.conf --------------------------------------------------------------

_subnet_routes_error() {
  _sre_ipv6=false
  [ "${IPV6}" != on ] || _sre_ipv6=true
  jqr -n -c --arg error "$1" --arg mode "${TS_MODE}" --argjson accept "${2:-null}" \
    --argjson ipv6 "${_sre_ipv6}" \
    '{ok:false,error:$error,acceptRoutes:$accept,mode:$mode,ipv6Enabled:$ipv6,peers:[],applied:false}'
  return 1
}

# RouteAll is a persisted preference of the current Tailscale profile. Read
# that authoritative value instead of duplicating it in module configuration.
# Never return the rest of debug prefs, which can contain private state.
read_accept_routes() {
  _rar_prefs=$(ts_cli 5 debug prefs 2>/dev/null) || return 1
  printf '%s' "${_rar_prefs}" | jqr -r \
    'if (.RouteAll|type)=="boolean" then .RouteAll else error("RouteAll is unavailable") end' 2>/dev/null
}

cmd_subnet_routes_get() {
  daemon_up || { _subnet_routes_error 'tailscaled is not available; accepted routes are unknown'; return 1; }
  _srg_accept=$(read_accept_routes) || {
    _subnet_routes_error 'could not read the current accepted-routes preference'; return 1;
  }
  _srg_status=$(ts_cli 10 status --json 2>/dev/null) || {
    _subnet_routes_error 'could not read peer subnet routes' "${_srg_accept}"; return 1;
  }
  _srg_ipv6=false
  [ "${IPV6}" != on ] || _srg_ipv6=true
  _srg_result=$(printf '%s' "${_srg_status}" | jqr -c \
    --argjson accept "${_srg_accept}" --arg mode "${TS_MODE}" --argjson ipv6 "${_srg_ipv6}" '
    def array: if .==null then [] elif type=="array" then . else error("expected route array") end;
    if type!="object" or (.BackendState|type)!="string" or
      (.Peer!=null and (.Peer|type)!="object") then error("invalid status snapshot") else . end
    | [.Peer // {} | .[]
      | . as $peer
      | (($peer.TailscaleIPs|array) | map(. + (if contains(":") then "/128" else "/32" end))) as $self
      | ($peer.PrimaryRoutes|array) as $primary
      | (($peer.AllowedIPs|array) + $primary | unique
        | map(. as $cidr
          | select(type=="string" and (endswith("/0")|not) and ($self|index($cidr)|not))
          | {cidr:$cidr,primary:($primary|index($cidr)!=null)})) as $routes
      | select($routes|length>0)
      | {id:($peer.ID // ""),hostname:($peer.HostName // $peer.DNSName // "-"),
         online:($peer.Online==true),routes:$routes}]
    | sort_by(.hostname,.id)
    | {ok:true,acceptRoutes:$accept,mode:$mode,ipv6Enabled:$ipv6,peers:.}' 2>/dev/null) || {
    _subnet_routes_error 'invalid peer subnet routes snapshot' "${_srg_accept}"; return 1;
  }
  printf '%s\n' "${_srg_result}"
}

cmd_subnet_routes_set() {
  case "$1" in
    on) _srs_want=true ;;
    off) _srs_want=false ;;
    *) _subnet_routes_error 'subnet-routes-set: expected on|off'; return 1 ;;
  esac
  daemon_up || { _subnet_routes_error 'tailscaled is not available; no preference was changed'; return 1; }
  _srs_before=$(read_accept_routes) || {
    _subnet_routes_error 'accepted routes are unknown; no preference was changed'; return 1;
  }
  if [ "${_srs_before}" = "${_srs_want}" ]; then
    jqr -n -c --argjson accept "${_srs_before}" '{ok:true,applied:true,acceptRoutes:$accept}'
    return 0
  fi
  _srs_output=$(ts_cli 10 set "--accept-routes=${_srs_want}" 2>&1)
  _srs_rc=$?
  _srs_actual=$(read_accept_routes) || _srs_actual=null
  if [ "${_srs_rc}" != 0 ]; then
    _subnet_routes_error "could not change accepted subnet routes: ${_srs_output:-tailscale set failed}" "${_srs_actual}"
    return 1
  fi
  if [ "${_srs_actual}" != "${_srs_want}" ]; then
    _subnet_routes_error 'accepted-routes change could not be confirmed; refresh the current state' "${_srs_actual}"
    return 1
  fi
  jqr -n -c --argjson accept "${_srs_actual}" '{ok:true,applied:true,acceptRoutes:$accept}'
}

cmd_routes_get() {
  jqr -n -c --arg s "${ROUTE_SCOPE}" --arg u "${UID_LIST}" --arg n "${ROUTE_SUBNETS}" '
    def words: split(" ") | map(select(length > 0));
    {ok:true,scope:$s,uids:($u|words),subnets:($n|words)}'
}

# Convert CSV (or "-") to the config parser's space-separated values.
_csv_words() {
  [ "$1" != "-" ] || return 0
  printf '%s' "$1" | jqr -R -s -r '[splits("[,\n]") | gsub("^ +| +$"; "") | select(length > 0)] | join(" ")'
}

cmd_routes_set() {
  _rs_scope="$1"
  _rs_uid_list=$(_csv_words "$2") || jerr 'routes-set: invalid UID list'
  _rs_sub_list=$(_csv_words "$3") || jerr 'routes-set: invalid subnet list'
  _rs_sub_list=$(normalize_cidrs "${_rs_sub_list}") || jerr 'routes-set: invalid IPv4 or IPv6 CIDR'
  for _rs_key in ROUTE_SCOPE UID_LIST ROUTE_SUBNETS; do
    case "${_rs_key}" in ROUTE_SCOPE) _rs_value=${_rs_scope} ;; UID_LIST) _rs_value=${_rs_uid_list} ;; *) _rs_value=${_rs_sub_list} ;; esac
    _rs_why=$(_conf_value_error "${_rs_key}" "${_rs_value}") || jerr "routes-set: ${_rs_why}"
  done
  conf_lock_acquire || jerr 'routes-set: configuration is busy'
  load_conf || { conf_lock_release; jerr 'routes-set: invalid current configuration'; }
  if [ "${TS_MODE}" = tun ] && [ "${_rs_scope}" != all ]; then
    conf_lock_release
    jerr 'native tun supports only route scope all; use bridge for UID routing'
  fi
  _rs_tmp="${TS_CONF_DIR}/.routes.conf.$$"
  if ! {
    printf '# FoxyTail routing configuration.\nROUTE_SCOPE=%s\nUID_LIST="%s"\nROUTE_SUBNETS="%s"\n' "${_rs_scope}" "${_rs_uid_list}" "${_rs_sub_list}" >"${_rs_tmp}" &&
    chmod 0600 "${_rs_tmp}" && mv "${_rs_tmp}" "${TS_CONF_DIR}/routes.conf"
  }; then
    rm -f "${_rs_tmp}"; conf_lock_release; jerr 'routes-set: cannot replace routes.conf'
  fi
  conf_mark_pending || { conf_lock_release; jerr "could not record pending configuration"; }
  conf_apply_runtime routes.conf || { conf_lock_release; jerr 'routes saved, but runtime configuration promotion failed; routing was not applied'; }
  load_runtime_conf || { conf_lock_release; jerr 'routes saved, but runtime configuration is unavailable; routing was not applied'; }
  conf_lock_release
  _rs_applied=false
  _rs_apply_error=''
  _rs_note='saved; routing will apply when the tunnel is ready'
  if ip link show dev "${TUN_IFACE}" >/dev/null 2>&1; then
    if "${TS_SCRIPTS_DIR}/foxytail.route" reload >>"${TS_RUN_LOG_FILE}" 2>&1; then
      _rs_applied=true; _rs_note='saved and applied'
    else
      _rs_apply_error='routing reload failed; inspect the service log'
      _rs_note="saved, but ${_rs_apply_error}"
    fi
  fi
  _rs_ipv6_skipped='[]'
  if [ "${IPV6}" != on ]; then
    _rs_ipv6_skipped=$(printf '%s' "${_rs_sub_list}" | jqr -R -c 'split(" ")|map(select(contains(":")))')
    if [ "${_rs_ipv6_skipped}" != '[]' ]; then
      if [ "${_rs_applied}" = true ]; then _rs_note='saved; IPv4 routing applied'; fi
      _rs_applied=false
      _rs_note="${_rs_note}; IPv6 destinations are not applied while IPv6 is disabled"
    fi
  fi
  jqr -n -c --arg n "${_rs_note}" --argjson a "${_rs_applied}" --arg subnets "${_rs_sub_list}" \
    --argjson skipped "${_rs_ipv6_skipped}" --arg applyError "${_rs_apply_error}" \
    '{ok:true,saved:true,applied:$a,restartRequired:($a|not),note:$n,
      applyError:(if $applyError=="" then null else $applyError end),
      subnets:($subnets|split(" ")|map(select(length>0))),ipv6Skipped:$skipped,requiresIpv6:($skipped|length>0)}'
}

# --- settings (foxytail.conf) --------------------------------------------------

# All values come from the runtime parser, including defaults and migrations.
cmd_settings_get() {
  _sg_pending=false
  [ ! -f "${TS_RUN_DIR}/settings.pending" ] || _sg_pending=true
  jqr -n -c --arg TS_MODE "$TS_MODE" --arg SOCKS_PORT "$SOCKS_PORT" \
    --arg DNS_PORT "$DNS_PORT" --arg MAGIC_DNS "$MAGIC_DNS" --arg DNS_MODE "$DNS_MODE" --arg IPV6 "$IPV6" \
    --arg ROUTE_TABLE "$ROUTE_TABLE" --arg FWMARK "$FWMARK" --arg FWMARK_MASK "$FWMARK_MASK" \
    --arg WATCHDOG "$WATCHDOG" --arg WATCHDOG_INTERVAL "$WATCHDOG_INTERVAL" \
    --arg POWER_SAVE "$POWER_SAVE" --arg STATS "$STATS" --arg CONTEXT "$CONTEXT" \
    --arg WATCHDOG_PROBE "$WATCHDOG_PROBE" --arg WEBUI_AUTO_REFRESH "$WEBUI_AUTO_REFRESH" \
    --arg STATS_INTERVAL "$STATS_INTERVAL" --arg LOG_MAX_KB "$LOG_MAX_KB" \
    --argjson pending "${_sg_pending}" \
    '{ok:true,settings:($ARGS.named|del(.pending)),restartRequired:$pending}'
}

cmd_settings_set() {
  [ -n "$1" ] || jerr 'settings-set: missing key'
  [ "$1" != TS_MODE ] || jerr 'TS_MODE must be changed with mode-set'
  _sk_why=$(conf_write_key foxytail.conf "$1" "$2" 2>&1) || jerr "settings-set: ${_sk_why}"
  jqr -n -c --arg k "$1" --arg v "$2" '{ok:true,key:$k,value:$v,saved:true,applied:false,restartRequired:true,requiresRestart:true}'
}

cmd_trial_start() {
  "${TS_SCRIPTS_DIR}/foxytail.trial" begin "${1:-120}" "${2:-saved}"
}
cmd_trial_status() {
  _cts_out=$(_op_exec 20 "${TS_SCRIPTS_DIR}/foxytail.trial" status) || jerr 'trial status failed or cancelled'
  _op_cancelled && jerr 'trial status cancelled'
  printf '%s\n' "${_cts_out}"
}
cmd_trial_confirm() { "${TS_SCRIPTS_DIR}/foxytail.trial" confirm "$1"; }
cmd_trial_revert() { "${TS_SCRIPTS_DIR}/foxytail.trial" revert "$1"; }

# --- context rules -------------------------------------------------------------

cmd_context_get() {
  _cg_status=$(_op_exec 15 "${TS_SCRIPTS_DIR}/foxytail.context" status 2>/dev/null) || _cg_status=null
  _op_cancelled && jerr 'context status cancelled'
  printf '%s' "$_cg_status" | jqr -e 'type=="object" and (.running|type)=="boolean"' >/dev/null 2>&1 || _cg_status=null
  if [ -f "${TS_CONF_DIR}/context.conf" ]; then
    jqr -R -s -c --argjson status "$_cg_status" '{ok:true,rules:.,status:$status}' "${TS_CONF_DIR}/context.conf"
  else
    jqr -n -c --argjson status "$_cg_status" '{ok:true,rules:"",status:$status}'
  fi
}

cmd_context_set() {
  [ "$#" -gt 0 ] || jerr "context-set: missing base64 payload"
  [ "$#" = 1 ] && [ "${#1}" -le 65536 ] || jerr 'context-set: payload exceeds 48 KiB or has extra arguments'
  conf_lock_acquire || jerr "context-set: configuration is busy"
  _cx_tmp="${TS_CONF_DIR}/.context.conf.$$"
  mkdir -p "${TS_CONF_DIR}"
  if ! printf '%s' "$1" | base64 -d >"${_cx_tmp}" 2>/dev/null; then
    rm -f "${_cx_tmp}"
    conf_lock_release
    jerr "context-set: invalid base64"
  fi
  [ "$(wc -c <"${_cx_tmp}")" -le 49152 ] || {
    rm -f "${_cx_tmp}"; conf_lock_release; jerr 'context-set: decoded rules exceed 48 KiB';
  }
  if ! _cx_why=$("${TS_SCRIPTS_DIR}/foxytail.context" validate "${_cx_tmp}" 2>&1); then
    rm -f "${_cx_tmp}"
    conf_lock_release
    jerr "context-set: ${_cx_why}"
  fi
  mv "${_cx_tmp}" "${TS_CONF_DIR}/context.conf" || { rm -f "${_cx_tmp}"; conf_lock_release; jerr "context-set: replace failed"; }
  conf_mark_pending || { conf_lock_release; jerr "context-set: cannot record pending configuration"; }
  conf_apply_runtime context.conf || { conf_lock_release; jerr 'context rules saved, but runtime configuration promotion failed; watcher was not restarted'; }
  conf_lock_release
  # The shared lifecycle confirms startup (or an empty-rules no-op) before success.
  "${TS_SCRIPTS_DIR}/start.sh" reload-residents >>"${TS_RUN_LOG_FILE}" 2>&1 ||
    jerr 'context rules saved, but resident startup failed; inspect the service log'
  echo '{"ok":true}'
}
