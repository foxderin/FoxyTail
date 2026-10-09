#!/system/bin/sh
# PID/starttime owner locks shared by configuration, service and DNS.
# Sourced by settings.sh.

# Publish the owner atomically in a symlink: interruption cannot leave an empty
# lock directory with no PID. /proc starttime also guards against PID reuse.
_proc_starttime() {
  [ -r "/proc/$1/stat" ] || return 1
  IFS= read -r _pst_line <"/proc/$1/stat" 2>/dev/null || return 1
  # comm may contain spaces and closing parentheses; fields begin after the
  # last ') '. Starttime is field 20 after comm (field 22 in the complete stat).
  _pst_fields=${_pst_line##*) }
  [ "${_pst_fields}" != "${_pst_line}" ] || return 1
  case "${_pst_fields}" in Z\ *) return 1 ;; esac
  _pst_i=1
  while [ "${_pst_i}" -lt 20 ]; do
    _pst_fields=${_pst_fields#* }
    _pst_i=$((_pst_i + 1))
  done
  _pst_start=${_pst_fields%% *}
  case "${_pst_start}" in '' | *[!0-9]*) return 1 ;; esac
  echo "${_pst_start}"
}

_conf_pid_stamp() {
  _proc_starttime "$1"
}

boot_identity() { cat /proc/sys/kernel/random/boot_id 2>/dev/null; }

_conf_owner_alive() {
  _coa_pid=${1%%:*}
  _coa_rest=${1#*:}
  _coa_stamp=${_coa_rest%%:*}
  _coa_boot=${_coa_rest#*:}
  case "${_coa_pid}:${_coa_stamp}" in *[!0-9:]*|:*|*:) return 1 ;; esac
  [ -n "${_coa_boot}" ] && [ "${_coa_boot}" = "$(boot_identity)" ] || return 1
  [ "$(_proc_starttime "${_coa_pid}")" = "${_coa_stamp}" ]
}

# $$ can name the parent inside a shell subshell. Record the actual owner so
# its death is recoverable even while the parent remains alive.
_lock_identity() {
  _li_pid=$$
  if [ -r /proc/self/stat ] && IFS= read -r _li_stat </proc/self/stat; then
    _li_pid=${_li_stat%% *}
  fi
  _li_stamp=$(_conf_pid_stamp "${_li_pid}") && _li_boot=$(boot_identity) || return 1
  [ -n "${_li_stamp}" ] && [ -n "${_li_boot}" ] || return 1
  _LOCK_TOKEN="${_li_pid}:${_li_stamp}:${_li_boot}"
}

# Lamport tickets serialize both ownership and stale-primary recovery. Each
# ticket has a PID/starttime-specific name: removing a dead ticket cannot
# delete a new owner's ticket. There is no second shared reaper lock to strand.
# ponytail: O(waiters) scan; use a verified platform flock if contention grows.
_owner_lock_acquire() {
  _ola_path="$1" _ola_token="$2" _ola_limit="$3" _ola_delay="$4"
  _conf_owner_alive "${_ola_token}" || return 1
  _ola_dir="${_ola_path}.waiters"
  _ola_pid=${_ola_token%%:*}
  mkdir -p "${_ola_dir}" || return 1
  _ola_mine="${_ola_dir}/${_ola_token}"
  ln -s choosing "${_ola_mine}" 2>/dev/null || return 1
  _ola_number=1
  for _ola_file in "${_ola_dir}"/[0-9]*:*; do
    [ -L "${_ola_file}" ] || continue
    _ola_ticket=$(readlink "${_ola_file}")
    case "${_ola_ticket}" in ''|*[!0-9]*) continue ;; esac
    [ "${_ola_ticket}" -lt "${_ola_number}" ] || _ola_number=$((_ola_ticket + 1))
  done
  if ! ln -s "${_ola_number}" "${_ola_dir}/.ticket.${_ola_token}" ||
     ! mv -f "${_ola_dir}/.ticket.${_ola_token}" "${_ola_mine}"; then
    rm -f "${_ola_dir}/.ticket.${_ola_token}" "${_ola_mine}"
    return 1
  fi
  _ola_i=0
  while [ "${_ola_i}" -lt "${_ola_limit}" ]; do
    _ola_busy=0
    for _ola_file in "${_ola_dir}"/[0-9]*:*; do
      [ -L "${_ola_file}" ] && [ "${_ola_file}" != "${_ola_mine}" ] || continue
      _ola_owner=${_ola_file##*/}
      if ! _conf_owner_alive "${_ola_owner}"; then
        rm -f "${_ola_file}" "${_ola_dir}/.ticket.${_ola_owner}"
        continue
      fi
      _ola_ticket=$(readlink "${_ola_file}")
      case "${_ola_ticket}" in
        '') continue ;;
        *[!0-9]*) _ola_busy=1; break ;;
      esac
      if [ "${_ola_ticket}" -lt "${_ola_number}" ] ||
         { [ "${_ola_ticket}" = "${_ola_number}" ] && [ "${_ola_owner%%:*}" -lt "${_ola_pid}" ]; }; then
        _ola_busy=1; break
      fi
    done
    if [ "${_ola_busy}" = 0 ]; then
      if ln -s "${_ola_token}" "${_ola_path}" 2>/dev/null; then return 0; fi
      # Also honor a live owner from an earlier version. Only the winning
      # ticket may retire a dead primary; no stale read can unlink a new one.
      _ola_owner=$(readlink "${_ola_path}" 2>/dev/null)
      if [ -n "${_ola_owner}" ] && ! _conf_owner_alive "${_ola_owner}"; then
        if rm -f "${_ola_path}"; then continue; fi
      fi
    fi
    _ola_i=$((_ola_i + 1))
    [ "${_ola_i}" -ge "${_ola_limit}" ] || sleep "${_ola_delay}"
  done
  rm -f "${_ola_mine}"
  return 1
}

_owner_lock_release() {
  [ "$(readlink "$1" 2>/dev/null)" != "$2" ] || rm -f "$1"
  rm -f "$1.waiters/$2"
}

conf_lock_acquire() {
  _lock_identity || return 1
  _CONF_LOCK_TOKEN=${_LOCK_TOKEN}
  _owner_lock_acquire "${TS_RUN_DIR}/.conf-write-lock" "${_CONF_LOCK_TOKEN}" 100 0.1 || {
    echo 'configuration is busy; retry' >&2; return 1;
  }
  _CONF_LOCK_HELD=1
  # The lock module is also usable on its own; settings.sh loads the config
  # recovery implementation before any configuration operation acquires it.
  if command -v conf_recover_restore >/dev/null 2>&1 && ! conf_recover_restore; then
    conf_lock_release
    echo 'configuration restore recovery failed; retry after correcting storage errors' >&2
    return 1
  fi
}

conf_lock_release() {
  if [ "${_CONF_LOCK_HELD:-0}" = 1 ]; then
    _owner_lock_release "${TS_RUN_DIR}/.conf-write-lock" "${_CONF_LOCK_TOKEN}"
    _CONF_LOCK_HELD=0
  fi
}
