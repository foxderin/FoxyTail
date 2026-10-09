#!/system/bin/sh
# The pinned Android CLI selects direct mode once, when its backend is created.
TAIL_DROP_MODE="${TS_RUN_DIR}/taildrop-direct"

taildrop_prepare_direct() {
  _TAIL_DROP_READY=0
  rm -f "${TAIL_DROP_MODE}" || return 1
  [ -d /sdcard ] || return 1
  _td_root=$(realpath /sdcard 2>/dev/null) || return 1
  [ ! -L /sdcard/Download ] && [ ! -L /sdcard/Download/Taildrop ] || return 1
  mkdir -p /sdcard/Download/Taildrop || return 1
  _td_dir=$(realpath /sdcard/Download/Taildrop 2>/dev/null) || return 1
  [ "${_td_dir}" = "${_td_root}/Download/Taildrop" ] || return 1
  _TAIL_DROP_READY=1
}

taildrop_record_direct() {
  [ "${_TAIL_DROP_READY:-0}" = 1 ] || return 1
  _td_stamp=$(_proc_starttime "$1") _td_boot=$(boot_identity)
  [ -n "${_td_stamp}" ] && [ -n "${_td_boot}" ] || return 1
  (umask 077; printf '%s %s %s\n' "$1" "${_td_stamp}" "${_td_boot}" >"${TAIL_DROP_MODE}.$$") &&
    mv -f "${TAIL_DROP_MODE}.$$" "${TAIL_DROP_MODE}"
}

taildrop_direct_ready() {
  [ -f "${TAIL_DROP_MODE}" ] && [ ! -L "${TAIL_DROP_MODE}" ] || return 1
  IFS=' ' read -r _td_pid _td_stamp _td_boot <"${TAIL_DROP_MODE}" || return 1
  case "${_td_pid}:${_td_stamp}" in *[!0-9:]* | :* | *:) return 1 ;; esac
  [ -n "${_td_boot}" ] || return 1
  [ "${_td_boot}" = "$(boot_identity)" ] &&
    [ "$(_proc_starttime "${_td_pid}")" = "${_td_stamp}" ] || return 1
  for _td_owned in $(pids_of_path "${TS_BIN_DIR}/tailscaled"); do
    [ "${_td_owned}" != "${_td_pid}" ] || return 0
  done
  return 1
}
