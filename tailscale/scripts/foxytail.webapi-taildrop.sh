#!/system/bin/sh
# Native transfer jobs outlive UI requests; shared storage and stdin stay data.

_file_json_command() (
  _fj_timeout=$1
  shift
  [ -x "${TS_BIN_DIR}/foxyfiles" ] || jerr 'FoxyTail file helper not found; update the module'
  _fj_error=$(mktemp "${TS_RUN_DIR}/.taildrop-error.XXXXXX") || jerr 'cannot allocate Taildrop error record'
  trap 'rm -f "${_fj_error}"' 0
  trap 'exit 1' HUP INT TERM
  if [ "${_fj_timeout}" = detached ]; then
    _fj_result=$("${TS_BIN_DIR}/foxyfiles" "$@" 2>"${_fj_error}")
    _fj_rc=$?
  else
    _fj_result=$(_op_exec "${_fj_timeout}" "${TS_BIN_DIR}/foxyfiles" "$@" 2>"${_fj_error}")
    _fj_rc=$?
  fi
  _op_cancelled && jerr 'Taildrop request cancelled'
  if [ "${_fj_rc}" != 0 ]; then
    _fj_message=$(tail -c 2048 "${_fj_error}" | _sanitize_text)
    jerr "Taildrop: ${_fj_message:-command failed or timed out}"
  fi
  printf '%s' "${_fj_result}" | jqr -e 'type=="object" and .ok==true' >/dev/null 2>&1 || jerr 'invalid Taildrop helper response'
  printf '%s\n' "${_fj_result}"
)

cmd_taildrop_targets() {
  _file_json_command 20 taildrop-targets --socket "${TS_SOCKET}"
}

taildrop_confirm_direct() {
  _tcd_before=$(pids_of_path "${TS_BIN_DIR}/tailscaled")
  case "${_tcd_before}" in ''|*[!0-9]*) return 1 ;; esac
  _tcd_stamp=$(_proc_starttime "${_tcd_before}") _tcd_boot=$(boot_identity)
  [ -n "${_tcd_stamp}" ] && [ -n "${_tcd_boot}" ] || return 1
  _tcd_result=$(_op_exec 6 "${TS_BIN_DIR}/foxyfiles" receive-mode --socket "${TS_SOCKET}" 2>/dev/null) || return 1
  printf '%s' "${_tcd_result}" | jqr -e '.ok==true and .direct==true' >/dev/null 2>&1 || return 1
  [ "$(pids_of_path "${TS_BIN_DIR}/tailscaled")" = "${_tcd_before}" ] &&
    [ "$(_proc_starttime "${_tcd_before}")" = "${_tcd_stamp}" ] && [ "$(boot_identity)" = "${_tcd_boot}" ] || return 1
  taildrop_prepare_direct || return 1
  # Use the pre-probe stamp; a replaced process must never inherit this result.
  (umask 077; printf '%s %s %s\n' "${_tcd_before}" "${_tcd_stamp}" "${_tcd_boot}" >"${TAIL_DROP_MODE}.$$") &&
    mv -f "${TAIL_DROP_MODE}.$$" "${TAIL_DROP_MODE}" || return 1
  taildrop_direct_ready
}

cmd_files_browse() {
  _fb_path=${1:--}
  [ "${_fb_path}" != - ] || _fb_path=
  _file_json_command 20 browse --source /sdcard --path "${_fb_path}"
}

cmd_file_send_start() {
  [ "$#" = 3 ] || jerr 'file-send-start: expected peer ID, current IP and file path array'
  [ "${#3}" -le 16384 ] || jerr 'file-send-start: file selection is too large'
  _op_commit_begin || jerr 'file-send-start: request cancelled before submission'
  _file_json_command detached send-start --socket "${TS_SOCKET}" --root "${TS_DIR}" --source /sdcard \
    --peer "$1" --address "$2" --paths "$3"
}

cmd_file_send_status() {
  _file_json_command 15 send-status --root "${TS_DIR}" --id "$1"
}

cmd_file_send_cancel() {
  _file_json_command 15 send-cancel --root "${TS_DIR}" --id "$1"
}

cmd_file_send_history() {
  _file_json_command 15 send-history --root "${TS_DIR}"
}

cmd_file_send_delete() {
  [ "$#" = 1 ] || jerr 'file-send-delete: expected transfer ID'
  _file_json_command 15 send-delete --root "${TS_DIR}" --id "$1"
}

cmd_file_send_clear() {
  [ "$#" = 0 ] || jerr 'file-send-clear: expected no arguments'
  _file_json_command 15 send-clear --root "${TS_DIR}"
}

# _op_exec backgrounds its child: preserve stdin explicitly across POSIX async lists.
_file_stage_exec() {
  "${TS_BIN_DIR}/foxyfiles" stage --root "${TS_DIR}" --name "$1" --size "$2" <&3
}

cmd_file_stage() (
  [ "$#" = 2 ] || jerr 'file-stage: expected filename and size (-1 if unknown)'
  [ -x "${TS_BIN_DIR}/foxyfiles" ] || jerr 'FoxyTail file helper not found; update the module'
  _fst_error=$(mktemp "${TS_RUN_DIR}/.taildrop-stage.XXXXXX") || jerr 'cannot stage Taildrop errors'
  trap 'rm -f "${_fst_error}"' 0
  trap 'exit 1' HUP INT TERM
  exec 3<&0
  _fst_result=$(_op_exec 1800 _file_stage_exec "$1" "$2" 2>"${_fst_error}")
  _fst_rc=$?
  exec 3<&-
  _op_cancelled && jerr 'Taildrop staging cancelled'
  if [ "${_fst_rc}" != 0 ]; then
    _fst_message=$(tail -c 2048 "${_fst_error}" | _sanitize_text)
    jerr "Taildrop staging: ${_fst_message:-failed or timed out}"
  fi
  printf '%s' "${_fst_result}" | jqr -e '.ok==true and (.path|type)=="string" and (.size|type)=="number"' >/dev/null 2>&1 || jerr 'invalid staged file response'
  printf '%s\n' "${_fst_result}"
)

cmd_file_stage_delete() {
  _file_json_command 15 stage-delete --root "${TS_DIR}" --path "$1"
}

cmd_file_read() {
  [ -x "${TS_BIN_DIR}/foxyfiles" ] || { echo 'FoxyTail file helper not found' >&2; return 1; }
  _op_exec 1800 "${TS_BIN_DIR}/foxyfiles" inbox-read --root "${TS_DIR}" --name "$1"
}
