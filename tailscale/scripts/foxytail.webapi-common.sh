#!/system/bin/sh
# Request ownership, cancellation, CLI execution and shared JSON helpers.
# Sourced by foxytail.webapi.sh after settings.sh.

COMPAT_JSON="${TS_RUN_DIR}/compat.json"
COMPAT_ALERT="${TS_RUN_DIR}/compat-alert"
FILES_DIR="${TS_DIR}/files"

# --- Helpers -----------------------------------------------------------------

# Print {"ok":false,"error":...} and exit 1.
jerr() {
  jqr -n -c --arg e "$1" '{ok:false,error:$e}'
  exit 1
}

# Requests use a never-reused ID. Cancellation leaves a tombstone so a delayed
# bridge invocation cannot start after the UI was told it had been cancelled.
_op_valid_id() {
  case "$1" in '' | *[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#1}" -le 96 ] || return 1
  _ov_epoch=${1%%_*}
  case "${_ov_epoch}" in '' | *[!0-9]* | ???????????*) return 1 ;; esac
  [ "${_ov_epoch}" -gt 0 ] 2>/dev/null
}

_op_recent_id() {
  _ori_epoch=${1%%_*}
  _ori_now=$(date +%s)
  [ "${_ori_epoch}" -ge $((_ori_now - 900)) ] && [ "${_ori_epoch}" -le $((_ori_now + 30)) ]
}

# IDs older than the acceptance window can never start again. Retain live
# operations, but collect old terminal records/tombstones at most once a minute.
_op_gc() {
  _og_now="${1:-$(date +%s)}"
  _og_last=
  [ ! -f "${TS_RUN_DIR}/operations/.gc-last" ] || IFS= read -r _og_last <"${TS_RUN_DIR}/operations/.gc-last"
  case "${_og_last}" in '' | *[!0-9]*) _og_last=0 ;; esac
  [ $((_og_now - _og_last)) -ge 60 ] || return 0
  printf '%s\n' "${_og_now}" >"${TS_RUN_DIR}/operations/.gc-last"
  for _og_dir in "${TS_RUN_DIR}/operations/"*; do
    [ -d "${_og_dir}" ] && [ ! -L "${_og_dir}" ] || continue
    _og_id=${_og_dir##*/}
    _op_valid_id "${_og_id}" || continue
    _og_epoch=${_og_id%%_*}
    [ "${_og_epoch}" -lt $((_og_now - 930)) ] || continue
    _og_alive=0
    for _og_record in "${_og_dir}/runner" "${_og_dir}"/child.*; do
      _op_pid_alive "${_og_record}" && _og_alive=1
    done
    [ "${_og_alive}" = 1 ] || rm -rf "${_og_dir}"
  done
}

_op_starttime() {
  _proc_starttime "$1"
}

_op_pid_alive() {
  _opa_record="$1"
  [ -f "${_opa_record}" ] || return 1
  IFS=' ' read -r _opa_pid _opa_start <"${_opa_record}"
  case "${_opa_pid}:${_opa_start}" in *[!0-9:]* | :* | *:) return 1 ;; esac
  _opa_now=$(_op_starttime "${_opa_pid}")
  [ -n "${_opa_now}" ] && [ "${_opa_now}" = "${_opa_start}" ] && kill -0 "${_opa_pid}" 2>/dev/null
}

# Direct descendants from procfs, never process-name or process-group matches.
# ponytail: scan procfs only on termination; use task/children if helper trees grow large.
_op_children() {
  _opc_parent=$1
  for _opc_stat in /proc/[0-9]*/stat; do
    IFS= read -r _opc_line 2>/dev/null <"${_opc_stat}" || continue
    _opc_fields=${_opc_line##*) }
    # shellcheck disable=SC2086 # proc fields after comm contain no glob chars
    set -- ${_opc_fields}
    [ "$#" -ge 20 ] && [ "$2" = "${_opc_parent}" ] || continue
    shift 19
    # Parent and starttime must come from the same read: a second lookup could
    # observe a reused PID belonging to an unrelated process.
    case "$1" in '' | *[!0-9]*) continue ;; esac
    printf '%s:%s\n' "${_opc_line%% *}" "$1"
  done
}

# Pause each verified parent while recording its children, so a helper cannot
# fork between discovery and its termination. Persist descendants until the
# executor has confirmed their exit; cancellation also covers orphaned children.
_op_signal() (
  if _op_pid_alive "$1"; then
    _ops_pid=${_opa_pid}
    kill -STOP "${_ops_pid}" 2>/dev/null || exit 0
    for _ops_child in $(_op_children "${_ops_pid}"); do
      _op_pid_alive "$1" || continue
      printf '%s %s\n' "${_ops_child%%:*}" "${_ops_child#*:}" >"$1.child.${_ops_child%%:*}"
    done
  fi
  for _ops_record in "$1".child.*; do
    [ -f "${_ops_record}" ] && _op_signal "${_ops_record}" "$2"
  done
  if _op_pid_alive "$1"; then
    kill "-$2" "${_opa_pid}" 2>/dev/null
    [ "$2" = KILL ] || kill -CONT "${_opa_pid}" 2>/dev/null
  fi
)

_op_cancelled() {
  [ -n "${_OP_DIR:-}" ] && [ "$(readlink "${_OP_DIR}/phase" 2>/dev/null)" = cancelled ]
}

# A single atomic link elects cancellation or commit; neither can overtake it.
_op_commit_begin() {
  [ -n "${_OP_DIR:-}" ] || return 0
  ln -s committing "${_OP_DIR}/phase" 2>/dev/null ||
    [ "$(readlink "${_OP_DIR}/phase" 2>/dev/null)" = committing ]
}

_op_finish() {
  _of_rc=${1:-$?}
  if [ -n "${_OP_DIR:-}" ]; then
    if [ "${_of_rc}" != 0 ] || _op_cancelled; then
      for _of_record in "${_OP_DIR}"/child.*; do
        _op_signal "${_of_record}" KILL
        while _op_pid_alive "${_of_record}"; do
          sleep 0.1
          _op_signal "${_of_record}" KILL
        done
      done
    fi
    rm -f "${_OP_DIR}/runner"
    : >"${_OP_DIR}/done"
  fi
  conf_lock_release
}

_op_init() {
  _op_valid_id "$1" || jerr 'invalid request ID'
  _op_recent_id "$1" || jerr 'request ID has expired or is from the future'
  [ -d "${TS_RUN_DIR}/operations" ] || mkdir -p "${TS_RUN_DIR}/operations" || jerr 'cannot create operation registry'
  _op_gc "${_ori_now}"
  _OP_DIR="${TS_RUN_DIR}/operations/$1"
  # mkdir claims the ID; an existing ID is either a cancellation tombstone or
  # a previous invocation. Both must prevent duplicate execution.
  mkdir "${_OP_DIR}" 2>/dev/null || jerr 'request already exists or was cancelled'
  printf '%s\n' "$2" >"${_OP_DIR}/command"
  printf '%s\n' "${TS_SOCKET}" >"${_OP_DIR}/socket"
  printf '%s %s\n' "$$" "$(_op_starttime "$$")" >"${_OP_DIR}/runner"
  trap '_op_finish' 0
  trap 'exit 130' HUP INT TERM
  _op_cancelled && jerr 'request was cancelled'
  case "$2" in
    control | mode-set | routes-set | subnet-routes-set | settings-set | context-set | backup | trial-start | trial-confirm | trial-revert)
      _op_commit_begin || jerr 'request was cancelled before committing changes' ;;
  esac
}

cmd_cancel() {
  _op_valid_id "$1" || jerr 'invalid request ID'
  _oc_dir="${TS_RUN_DIR}/operations/$1"
  if [ ! -d "${_oc_dir}" ] && ! _op_recent_id "$1"; then
    echo '{"ok":true,"cancelled":true,"expired":true}'; return 0
  fi
  mkdir -p "${_oc_dir}" || jerr 'cannot record cancellation'
  _oc_socket=$(cat "${_oc_dir}/socket" 2>/dev/null)
  [ -z "${_oc_socket}" ] || [ "${_oc_socket}" = "${TS_SOCKET}" ] || jerr 'operation socket mismatch'
  if ! ln -s cancelled "${_oc_dir}/phase" 2>/dev/null; then
    case "$(readlink "${_oc_dir}/phase" 2>/dev/null)" in
      cancelled) ;;
      committing)
        if _op_pid_alive "${_oc_dir}/runner"; then jerr 'operation is committing changes and cannot be cancelled'; fi
        echo '{"ok":true,"completed":true}'; return 0 ;;
      *) jerr 'cannot record cancellation' ;;
    esac
  fi
  _oc_i=0
  while [ "${_oc_i}" -lt 50 ]; do
    _oc_busy=0
    for _oc_record in "${_oc_dir}"/child.*; do
      if _op_pid_alive "${_oc_record}"; then
        _oc_busy=1
        if [ "${_oc_i}" -lt 30 ]; then _op_signal "${_oc_record}" TERM
        else _op_signal "${_oc_record}" KILL; fi
      fi
    done
    _op_pid_alive "${_oc_dir}/runner" && _oc_busy=1
    [ "${_oc_busy}" = 0 ] && { jqr -n -c --arg id "$1" '{ok:true,cancelled:true,requestId:$id}'; return 0; }
    sleep 0.1
    _oc_i=$((_oc_i + 1))
  done
  jerr 'operation has not stopped; replacement was not authorized'
}

# Run the actual CLI as a registered child, with a separate timeout monitor.
# No pgrep/pkill patterns or process groups can target unrelated invocations.
_op_exec() {
  _oe_seconds="$1"
  shift
  _op_cancelled && return 130
  "$@" &
  _oe_pid=$!
  _oe_start=$(_op_starttime "${_oe_pid}")
  _oe_record="${TS_RUN_DIR}/.cli-${_oe_pid}"
  [ -z "${_OP_DIR:-}" ] || _oe_record="${_OP_DIR}/child.${_oe_pid}"
  printf '%s %s\n' "${_oe_pid}" "${_oe_start}" >"${_oe_record}"
  _oe_timeout="${_oe_record}.timeout"
  _oe_ready="${_oe_record}.ready"
  rm -f "${_oe_ready}"
  _op_cancelled && _op_signal "${_oe_record}" TERM
  (
    sleep "${_oe_seconds}" &
    _oe_sleep=$!
    trap 'kill "${_oe_sleep}" 2>/dev/null; exit 0' TERM INT HUP
    : >"${_oe_ready}"
    wait "${_oe_sleep}" 2>/dev/null
    if _op_pid_alive "${_oe_record}"; then
      : >"${_oe_timeout}"
      _op_signal "${_oe_record}" TERM
      sleep 1
      _op_signal "${_oe_record}" KILL
    fi
  ) >/dev/null 2>&1 &
  _oe_timer=$!
  # Fast children can exit before the timer installs its signal handler.
  while [ ! -f "${_oe_ready}" ] && kill -0 "${_oe_timer}" 2>/dev/null; do sleep 0.01; done
  wait "${_oe_pid}"
  _oe_rc=$?
  kill "${_oe_timer}" 2>/dev/null
  wait "${_oe_timer}" 2>/dev/null
  [ ! -f "${_oe_timeout}" ] || _oe_rc=124
  # A terminated helper may have left a child ignoring TERM. Its recorded
  # identity remains ours even after reparenting; finish cleanup before return.
  _op_signal "${_oe_record}" KILL
  for _oe_child in "${_oe_record}".child.*; do
    while _op_pid_alive "${_oe_child}"; do
      sleep 0.1
      _op_signal "${_oe_child}" KILL
    done
    rm -f "${_oe_child}"
  done
  rm -f "${_oe_record}" "${_oe_timeout}" "${_oe_ready}"
  _op_cancelled && return 130
  return "${_oe_rc}"
}

# Diagnostics are preserved; callers choose whether to capture or suppress them.
ts_cli() {
  _tc_t="$1"
  shift
  _op_exec "${_tc_t}" tailscale --socket="${TS_SOCKET}" "$@"
}

# Process liveness is independent of LocalAPI/socket health. An unresponsive
# daemon still needs a working Stop control, and cannot be called stopped.
daemon_exists() {
  [ -n "$(pids_of_path "${TS_BIN_DIR}/${TS_DAEMON_CMD}")" ]
}

# Ready for CLI requests: socket + our exact daemon process.
daemon_up() {
  [ -S "${TS_SOCKET}" ] && daemon_exists
}

# Uptime in seconds, derived from the pid file mtime (0 when unknown).
daemon_uptime() {
  _du_mt=$(stat -c %Y "${TS_DAEMON_PID_FILE}" 2>/dev/null)
  case "${_du_mt}" in '' | *[!0-9]*) echo 0; return ;; esac
  _du_now=$(date +%s)
  [ "${_du_now}" -gt "${_du_mt}" ] && echo $((_du_now - _du_mt)) || echo 0
}

# jq is a strict UTF-8 parser: strip invalid bytes before raw text (log
# tails, file names) reaches it. iconv -c keeps valid multi-byte sequences;
# when iconv is unusable the high bytes are dropped instead.
_sanitize_text() {
  if printf '\377' | iconv -c -f UTF-8 -t UTF-8 >/dev/null 2>&1; then
    iconv -c -f UTF-8 -t UTF-8
  else
    tr -d '\200-\377'
  fi
}
