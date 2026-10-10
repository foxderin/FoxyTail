#!/system/bin/sh
# Private receipts and detached workers; only the fixed dispatcher can run work.

_control_commands='control mode-set exitnode-set exitnode-clear login-authkey logout switch serve-set serve-del funnel-set funnel-del routes-set subnet-routes-set settings-set context-set backup restore trial-start trial-confirm trial-revert file-delete file-clear file-export file-receive file-send-start file-send-cancel peer-ping speedtest-exitnodes derp-speedtest coexist-check coexist-info diag diag-check dns-probe socks-check'

_control_validate() {
  _cv_command=$1
  shift
  case " ${_control_commands} " in *" ${_cv_command} "*) ;; *) jerr 'command is not allowed as a detached operation' ;; esac
  case "${_cv_command}:$#" in
    control:1|mode-set:1|exitnode-set:1|login-authkey:1|switch:1|subnet-routes-set:1|context-set:1|trial-confirm:1|trial-revert:1|file-delete:1|file-export:1|file-send-cancel:1|diag:1) ;;
    settings-set:2|peer-ping:2|trial-start:2|serve-set:3|serve-del:2|serve-del:3|funnel-set:3|funnel-del:2|funnel-del:3|routes-set:3|restore:3|file-send-start:3|coexist-check:5) ;;
    exitnode-clear:0|logout:0|backup:0|file-clear:0|file-receive:0|speedtest-exitnodes:0|derp-speedtest:0|coexist-info:0|diag:0|diag-check:0|dns-probe:0|socks-check:0|trial-start:0|trial-start:1) ;;
    *) jerr 'invalid operation argument count' ;;
  esac
  _cv_total=0
  for _cv_arg in "$@"; do
    [ "${#_cv_arg}" -le 65536 ] || jerr 'operation argument exceeds 65536 bytes'
    _cv_total=$((_cv_total + ${#_cv_arg}))
  done
  [ "${_cv_total}" -le 98304 ] || jerr 'operation arguments exceed 98304 bytes'
  [ "${_cv_command}" != login-authkey ] || [ "${#1}" -le 512 ] || jerr 'authkey exceeds 512 bytes'
}

_control_lock() {
  _op_registry || jerr 'cannot open private operation registry'
  _lock_identity || jerr 'cannot identify operation controller'
  _CONTROL_LOCK_TOKEN=${_LOCK_TOKEN}
  _owner_lock_acquire "${TS_RUN_DIR}/operations/.registry-lock" "${_CONTROL_LOCK_TOKEN}" 100 0.05 ||
    jerr 'operation registry is busy; retry status'
}

_control_unlock() {
  _owner_lock_release "${TS_RUN_DIR}/operations/.registry-lock" "${_CONTROL_LOCK_TOKEN}"
}

_control_alive() {
  for _ca_record in "$1/supervisor" "$1/runner" "$1"/runner.child.* "$1"/child.*; do
    _op_pid_alive "${_ca_record}" && return 0
  done
  return 1
}

# Caller holds the registry lock. Expiry cleanup is safe for status queries;
# capacity-slot eviction is kept in _control_capacity_gc so reads never evict
# an unrelated receipt while answering a requested status.
_control_gc() {
  _cg_now=$(date +%s)
  _cg_count=0
  for _cg_dir in "${TS_RUN_DIR}/operations/"*; do
    [ -d "${_cg_dir}" ] && [ ! -L "${_cg_dir}" ] && [ -f "${_cg_dir}/durable" ] || continue
    _cg_id=${_cg_dir##*/}
    _op_valid_id "${_cg_id}" || continue
    [ -f "${_cg_dir}/result.json" ] || _control_alive "${_cg_dir}" || _control_publish "${_cg_dir}" 125 interrupted || return 1
    if [ "${_cg_id%%_*}" -lt $((_cg_now - 86400)) ] && ! _control_alive "${_cg_dir}"; then
      rm -rf "${_cg_dir}"
    else _cg_count=$((_cg_count + 1)); fi
  done
}

# Caller holds the registry lock. Creation only: never evict a live worker or
# a reusable ID, and never let the private receipt registry exceed 128 slots.
_control_capacity_gc() {
  [ "${_cg_count:-0}" -ge 128 ] || return 0
  _ccg_now=$(date +%s)
  for _ccg_dir in "${TS_RUN_DIR}/operations/"*; do
    [ -d "${_ccg_dir}" ] && [ ! -L "${_ccg_dir}" ] && [ -f "${_ccg_dir}/result.json" ] || continue
    _ccg_id=${_ccg_dir##*/}
    _op_valid_id "${_ccg_id}" || continue
    [ "${_ccg_id%%_*}" -lt $((_ccg_now - 930)) ] || continue
    _control_alive "${_ccg_dir}" && continue
    rm -rf "${_ccg_dir}"
    _cg_count=$((_cg_count - 1))
    [ "${_cg_count}" -ge 128 ] || break
  done
}

_control_publish() (
  _cp_dir=$1 _cp_rc=$2 _cp_state=$3
  [ ! -f "${_cp_dir}/result.json" ] || exit 0
  _cp_recovery=${_cp_state}
  _cp_command=$(cat "${_cp_dir}/command") || exit 1
  _cp_id=${_cp_dir##*/}
  _cp_tmp=$(mktemp "${_cp_dir}/.result.XXXXXX") || exit 1
  trap 'rm -f "${_cp_tmp}"' 0
  ln -s completed "${_cp_dir}/phase" 2>/dev/null || :
  if [ "$(readlink "${_cp_dir}/phase")" = cancelled ]; then _cp_state=cancelled; _cp_rc=130; fi
  if [ "${_cp_recovery}" = interrupted ]; then
    printf '%s\n' '{"ok":false,"error":"operation worker was interrupted; outcome is unknown; refresh current state before making another change"}' >"${_cp_dir}/output"
  fi
  jqr -s -c --arg id "${_cp_id}" --arg command "${_cp_command}" --arg state "${_cp_state}" --argjson rc "${_cp_rc}" '
    (if length==1 and (.[0]|type)=="object" and (.[0].ok|type)=="boolean" then .[0]
     else {ok:false,error:"operation did not return one complete JSON result; outcome is unknown"} end) as $result
    | {ok:true,operation:{id:$id,command:$command,state:$state,cancellable:false,exitCode:$rc,
        result:($result | if $rc!=0 or $state!="completed" then
          .ok=false | .error=(.error // (if $state=="cancelled" then "operation cancelled" else "operation exited unsuccessfully; refresh current state" end))
          else . end)}}' "${_cp_dir}/output" >"${_cp_tmp}" 2>/dev/null ||
    jqr -n -c --arg id "${_cp_id}" --arg command "${_cp_command}" --arg state "${_cp_state}" --argjson rc "${_cp_rc}" \
      '{ok:true,operation:{id:$id,command:$command,state:$state,cancellable:false,exitCode:$rc,result:{ok:false,error:"operation result was invalid or exceeded 1 MiB; outcome is unknown"}}}' >"${_cp_tmp}" || exit 1
  chmod 0600 "${_cp_tmp}" && { ln "${_cp_tmp}" "${_cp_dir}/result.json" 2>/dev/null || [ -f "${_cp_dir}/result.json" ]; } || exit 1
  : >"${_cp_dir}/done"
  rm -f "${_cp_dir}/output"
)

_control_response() {
  _cr_dir=$1
  [ -d "${_cr_dir}" ] && [ ! -L "${_cr_dir}" ] && [ -f "${_cr_dir}/durable" ] || jerr 'unknown or expired operation; do not resubmit'
  _cr_socket=$(cat "${_cr_dir}/socket" 2>/dev/null)
  [ -z "${_cr_socket}" ] || [ "${_cr_socket}" = "${TS_SOCKET}" ] || jerr 'operation socket mismatch'
  if [ -f "${_cr_dir}/result.json" ]; then cat "${_cr_dir}/result.json"; return; fi
  if ! _control_alive "${_cr_dir}"; then
    _control_publish "${_cr_dir}" 125 interrupted || jerr 'cannot record interrupted operation'
    cat "${_cr_dir}/result.json"
    return
  fi
  _cr_cancellable=true
  [ -z "$(readlink "${_cr_dir}/phase" 2>/dev/null)" ] || _cr_cancellable=false
  jqr -n -c --arg id "${_cr_dir##*/}" --arg command "$(cat "${_cr_dir}/command")" --argjson cancel "${_cr_cancellable}" \
    '{ok:true,operation:{id:$id,command:$command,state:"running",cancellable:$cancel,result:null,exitCode:null}}'
}

cmd_operation_status() {
  [ "$#" = 1 ] && _op_valid_id "$1" || jerr 'invalid operation ID'
  _control_lock
  _control_gc || { _control_unlock; jerr 'cannot recover private operation receipts'; }
  _cs_dir="${TS_RUN_DIR}/operations/$1"
  # Release before responding: interrupted receipt publication never owns work.
  _control_unlock
  _control_response "${_cs_dir}"
}

_control_worker() (
  _OP_DIR=$1
  shift
  _CONF_LOCK_HELD=0
  trap '' HUP
  trap 'rm -f "${_OP_DIR}/supervisor" "${_OP_DIR}/output.pipe"' 0
  _lock_identity || exit 1
  _cw_identity=${_LOCK_TOKEN#*:}
  printf '%s %s %s\n' "${_LOCK_TOKEN%%:*}" "${_cw_identity%%:*}" "${_LOCK_TOKEN##*:}" >"${_OP_DIR}/supervisor.worker" &&
    mv -f "${_OP_DIR}/supervisor.worker" "${_OP_DIR}/supervisor" || exit 1
  : >"${_OP_DIR}/accepted"
  # Drain the entire stream but retain at most 1 MiB + one overflow byte. A
  # large result must not SIGPIPE an irreversible operation in progress.
  mkfifo "${_OP_DIR}/output.pipe" || exit 1
  (head -c 1048577 >"${_OP_DIR}/output"; cat >/dev/null) <"${_OP_DIR}/output.pipe" &
  _cw_reader=$!
  (
    _CONTROL_DURABLE=1
    trap '_op_finish' 0
    trap 'exit 130' INT TERM
    trap '' HUP
    while [ ! -f "${_OP_DIR}/ready" ]; do sleep 0.01; done
    [ ! -f "${_OP_DIR}/result.json" ] || exit 125
    _op_cancelled && jerr 'operation cancelled before execution'
    _op_initial_phase "$1" || jerr 'operation cancelled before committing changes'
    _webapi_dispatch "$@"
  ) >"${_OP_DIR}/output.pipe" 2>/dev/null &
  _cw_pid=$!
  _op_record "${_OP_DIR}/runner" "${_cw_pid}" || { kill "${_cw_pid}" 2>/dev/null; exit 1; }
  : >"${_OP_DIR}/ready"
  wait "${_cw_pid}"
  _cw_rc=$?
  for _cw_record in "${_OP_DIR}"/runner.child.* "${_OP_DIR}"/child.*; do
    _op_signal "${_cw_record}" KILL
    while _op_pid_alive "${_cw_record}"; do sleep 0.1; _op_signal "${_cw_record}" KILL; done
  done
  wait "${_cw_reader}"
  if [ "$(wc -c <"${_OP_DIR}/output")" -gt 1048576 ]; then : >"${_OP_DIR}/output"; fi
  _control_publish "${_OP_DIR}" "${_cw_rc}" completed
)

cmd_operation_start() {
  [ "$#" -ge 2 ] && _op_valid_id "$1" || jerr 'invalid operation ID or missing command'
  _cs_id=$1
  shift
  _control_validate "$@"
  _control_lock
  _control_gc || { _control_unlock; jerr 'cannot recover private operation receipts'; }
  _cs_dir="${TS_RUN_DIR}/operations/${_cs_id}"
  if [ -d "${_cs_dir}" ]; then
    _cs_existing=$(cat "${_cs_dir}/command" 2>/dev/null)
    _control_unlock
    [ "${_cs_existing}" = "$1" ] || jerr 'operation ID already belongs to another command or cancellation'
    _control_response "${_cs_dir}"
    return
  fi
  if ! _op_recent_id "${_cs_id}"; then
    _control_unlock
    jerr 'operation ID expired or private receipt capacity reached; no work started'
  fi
  _control_capacity_gc
  if [ "${_cg_count}" -ge 128 ]; then
    _control_unlock
    jerr 'operation ID expired or private receipt capacity reached; no work started'
  fi
  if ! { mkdir "${_cs_dir}" && printf '%s\n' "$1" >"${_cs_dir}/command" &&
      printf '%s\n' "${TS_SOCKET}" >"${_cs_dir}/socket" && : >"${_cs_dir}/durable" &&
      _op_record "${_cs_dir}/supervisor" "${_CONTROL_LOCK_TOKEN%%:*}"; }; then
    _control_unlock
    jerr 'cannot claim operation; check operation-status before another change'
  fi
  # Fork retains arguments only in memory, and no app descriptor in the worker.
  # The explicit subshell is required: dash keeps the caller's stdout open when
  # a function is backgrounded directly, starving the caller's pipe until the
  # operation finishes.
  trap '' HUP
  ( _control_worker "${_cs_dir}" "$@" ) </dev/null >/dev/null 2>&1 &
  _cs_i=0
  while [ ! -f "${_cs_dir}/accepted" ] && [ "${_cs_i}" -lt 100 ]; do
    sleep 0.02
    _cs_i=$((_cs_i + 1))
  done
  _control_unlock
  _control_response "${_cs_dir}"
}

_control_cancel() {
  _cc_dir=$1
  _cc_socket=$(cat "${_cc_dir}/socket" 2>/dev/null)
  [ -z "${_cc_socket}" ] || [ "${_cc_socket}" = "${TS_SOCKET}" ] || jerr 'operation socket mismatch'
  if [ -f "${_cc_dir}/result.json" ]; then
    jqr -c '{ok:true,cancelled:(.operation.state=="cancelled"),completed:(.operation.state!="cancelled"),operation:.operation}' "${_cc_dir}/result.json"; return
  fi
  if ! ln -s cancelled "${_cc_dir}/phase" 2>/dev/null; then
    case "$(readlink "${_cc_dir}/phase")" in
      cancelled) ;;
      committing) jerr 'operation is committing changes and cannot be cancelled; query operation-status' ;;
      completed) ;;
      *) jerr 'cannot record cancellation' ;;
    esac
  fi
  _cc_i=0
  while [ "${_cc_i}" -lt 70 ]; do
    if [ -f "${_cc_dir}/result.json" ]; then
      jqr -c '{ok:true,cancelled:(.operation.state=="cancelled"),completed:(.operation.state!="cancelled"),operation:.operation}' "${_cc_dir}/result.json"; return
    fi
    if [ "$(readlink "${_cc_dir}/phase")" = cancelled ]; then
      _cc_signal=TERM
      [ "${_cc_i}" -lt 30 ] || _cc_signal=KILL
      _op_signal "${_cc_dir}/runner" "${_cc_signal}"
      for _cc_record in "${_cc_dir}"/child.*; do _op_signal "${_cc_record}" "${_cc_signal}"; done
    fi
    if ! _control_alive "${_cc_dir}"; then _control_publish "${_cc_dir}" 125 interrupted || jerr 'cannot record operation outcome'; fi
    sleep 0.1
    _cc_i=$((_cc_i + 1))
  done
  jerr 'operation has not stopped; replacement was not authorized'
}

cmd_backend_info() {
  [ "$(id -u)" = 0 ] || jerr 'backend-info requires root'
  _bi_version='' _bi_code=0 _bi_disabled=false _bi_upgrade=false
  if [ -f "${TS_MOD_PROP}" ]; then
    while IFS='=' read -r _bi_key _bi_value; do
      case "${_bi_key}" in version) _bi_version=${_bi_value} ;; versionCode) _bi_code=${_bi_value} ;; esac
    done <"${TS_MOD_PROP}"
  fi
  case "${_bi_code}" in ''|*[!0-9]*|??????????*) _bi_code=0 ;; esac
  [ ! -f "${TS_MOD_DIR}/disable" ] || _bi_disabled=true
  [ ! -f "${TS_DIR}/.installing" ] || _bi_upgrade=true
  jqr -n -c --arg version "${_bi_version}" --argjson code "${_bi_code}" --argjson disabled "${_bi_disabled}" --argjson upgrading "${_bi_upgrade}" \
    --arg commands "${_control_commands} backend-info operation-start operation-status cancel status peers exitnodes tun dns login accounts serve-list funnel-list traffic traffic-uids apps routes-get subnet-routes-get settings-get context-get logs compat files-inbox taildrop-targets files-browse file-send-status file-send-history file-stage file-stage-delete file-read backup-list restore-preview trial-status owner-capability hooks-get artifact-stage artifact-read artifact-delete" \
    '{ok:true,protocol:1,moduleVersion:$version,versionCode:$code,disabled:$disabled,upgrading:$upgrading,commands:($commands|split(" "))}'
}

cmd_owner_capability() {
  if _op_exec 5 iptables -m owner --help >/dev/null 2>&1; then
    echo '{"ok":true,"available":true,"reason":""}'
  else echo '{"ok":true,"available":false,"reason":"xt_owner is unavailable or its capability probe failed"}'; fi
}

cmd_socks_check() {
  case "${TS_MODE}" in bridge|proxy) ;; *) jerr 'SOCKS check requires applied bridge or proxy mode' ;; esac
  [ -x "${TS_BIN_DIR}/foxydns" ] || jerr 'FoxyTail DNS helper not found; update the module'
  _sc_result=$(_op_exec 12 "${TS_BIN_DIR}/foxydns" socks-check --socks-port "${SOCKS_PORT}")
  _sc_rc=$?
  _op_cancelled && jerr 'SOCKS check cancelled'
  if [ "${_sc_rc}" != 0 ]; then
    printf '%s' "${_sc_result}" | jqr -e 'type=="object" and .ok==false and (.error|type)=="string"' >/dev/null 2>&1 || jerr 'SOCKS helper failed or timed out'
    printf '%s\n' "${_sc_result}"
    return "${_sc_rc}"
  fi
  printf '%s' "${_sc_result}" | jqr -e 'type=="object" and .ok==true and (.success|type)=="boolean" and (.httpCode|type)=="string" and (.elapsedMs|type)=="number" and .elapsedMs>=0 and (.success==false or (.httpCode|test("^[23][0-9][0-9]$")))' >/dev/null 2>&1 || jerr 'SOCKS helper returned an invalid result'
  printf '%s\n' "${_sc_result}"
}

cmd_hooks_get() {
  _hg_up="${TS_SCRIPTS_DIR}/foxytail.tun.up" _hg_down="${TS_SCRIPTS_DIR}/foxytail.tun.down"
  _hg_up_missing=false _hg_down_missing=false
  for _hg_file in "${_hg_up}" "${_hg_down}"; do
    if [ ! -e "${_hg_file}" ] && [ ! -L "${_hg_file}" ]; then
      if [ "${_hg_file}" = "${_hg_up}" ]; then _hg_up=/dev/null; _hg_up_missing=true
      else _hg_down=/dev/null; _hg_down_missing=true; fi
    else
      [ -f "${_hg_file}" ] && [ ! -L "${_hg_file}" ] && [ -r "${_hg_file}" ] || jerr 'hook is not a readable regular file'
      [ "$(wc -c <"${_hg_file}")" -le 65536 ] || jerr 'hook exceeds 65536 bytes'
    fi
  done
  jqr -n -c --rawfile up "${_hg_up}" --rawfile down "${_hg_down}" --argjson upMissing "${_hg_up_missing}" --argjson downMissing "${_hg_down_missing}" \
    '{ok:true,hooks:[{name:"foxytail.tun.up",content:$up,missing:$upMissing},{name:"foxytail.tun.down",content:$down,missing:$downMissing}]}' || jerr 'cannot read hooks'
}
