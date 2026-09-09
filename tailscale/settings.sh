#!/system/bin/sh
# FoxyTail - common settings and helpers.
#
# This file must ONLY be sourced (`. settings.sh`), never executed directly.
#
# Conventions:
#   - POSIX sh compatible (Android mksh / busybox ash), 2-space indent.
#   - NEVER `set -e` here: it would leak into every caller that sources this
#     file and abort their scripts on any non-zero command.
#   - NEVER `set -u` here: when sourced into an interactive shell, referencing
#     an unset variable would kick the user out of their session.
#   - Functions provided:
#       log <level> <message>        colored, timestamped log to stdout + file
#       rotate_log <file>            rotate a log file when it exceeds LOG_MAX_KB
#       load_conf                    source foxytail.conf / routes.conf + defaults
#       ensure_run_dirs              create run/pids/stats directories
#       is_screen_on                 true if the screen is on (tolerant check)
#       pids_of <pattern>            PIDs whose cmdline matches (pgrep -f)
#       pids_of_path <path> [pat]    pids_of, verified via /proc/<pid>/cmdline argv[0]
#       stop_by_pids <name> <pids> [wait=3]   TERM -> wait -> KILL -> verify; 1 on survivors
#       wait_for <desc> <cmd...> [tries=20] [interval=0.5]   poll until cmd succeeds
#       isleep <seconds>             interruptible sleep (returns on TERM/INT)
#       tmo <seconds> <cmd...>       run under timeout(1); warns once if unavailable
#       jqr <jq args...>             jq entry point ($TS_BIN_DIR/jq, system fallback)
#       have_jq                      true when a usable jq exists
#       daemon_claim_pidfile <name>  claim pid file; 1 when already running (stale-safe)
#       daemon_pid_alive <name>      true when the pid file names a live process
#       daemon_stop_pidfile <name>   stop the daemon recorded in the pid file, remove it

# --- Paths -------------------------------------------------------------------

TS_DIR="/data/adb/foxytail"
TS_BIN_DIR="${TS_DIR}/bin"
TS_SCRIPTS_DIR="${TS_DIR}/scripts"
TS_CONF_DIR="${TS_DIR}/conf"
TS_RUN_DIR="${TS_DIR}/run"

# Derive the module dir from MODPATH (set by Magisk/KernelSU during install);
# fall back to the standard module path at runtime.
TS_MOD_DIR="${MODPATH:-/data/adb/modules/foxytail}"
export TS_MOD_PROP="${TS_MOD_DIR}/module.prop"

TS_LOG_FILE="${TS_RUN_DIR}/tailscaled.log"
TS_RUN_LOG_FILE="${TS_RUN_DIR}/foxytail.log"
TS_PID_DIR="${TS_RUN_DIR}/pids"
TS_STATS_DIR="${TS_RUN_DIR}/stats"

# --- Environment -------------------------------------------------------------

export PATH="${TS_BIN_DIR}:${TS_SCRIPTS_DIR}:/data/adb/magisk:/data/adb/ksu/bin:${PATH}"
export HOME="${TS_DIR}" # tailscaled writes state/logs relative to $HOME

# Base daemon command; foxytail.service appends mode-specific flags.
export TS_DAEMON_CMD="tailscaled"

# --- Colors ------------------------------------------------------------------

normal="\033[0m"
red="\033[1;31m"
green="\033[1;32m"
yellow="\033[1;33m"
blue="\033[1;34m"
orange="\033[1;38;5;208m"

# --- Functions ---------------------------------------------------------------

# Rotate <file> to <file>.bak (single backup) when it exceeds LOG_MAX_KB.
rotate_log() {
  _rl_file="$1"
  [ -f "${_rl_file}" ] || return 0
  _rl_max_kb="${LOG_MAX_KB:-512}"
  _rl_size=$(wc -c <"${_rl_file}" 2>/dev/null || echo 0)
  if [ "${_rl_size}" -gt $((_rl_max_kb * 1024)) ]; then
    mv "${_rl_file}" "${_rl_file}.bak"
  fi
}

# Log with a per-call timestamp and level-based color; always appends to
# $TS_RUN_LOG_FILE (with rotation), and mirrors to stdout on a terminal.
log() {
  case $1 in
    Info) color="${blue}" ;;
    Success) color="${green}" ;;
    Error) color="${red}" ;;
    Warning) color="${yellow}" ;;
    Debug) color="${orange}" ;;
    *) color="${normal}" ;;
  esac
  message="$(date +"%H:%M:%S") [$1]: $2"
  rotate_log "${TS_RUN_LOG_FILE}"
  if [ -t 1 ]; then
    echo "${color}${message}${normal}"
  fi
  echo "${message}" >>"${TS_RUN_LOG_FILE}" 2>&1
}

# Source foxytail.conf (and routes.conf if present), then fill in defaults
# for any key the config files did not set. This is the single source of
# truth for defaults; the shipped conf templates only override them.
load_conf() {
  if [ -f "${TS_CONF_DIR}/foxytail.conf" ]; then
    . "${TS_CONF_DIR}/foxytail.conf"
  fi
  if [ -f "${TS_CONF_DIR}/routes.conf" ]; then
    . "${TS_CONF_DIR}/routes.conf"
  fi
  TS_MODE="${TS_MODE:-bridge}"
  ROUTE_TABLE="${ROUTE_TABLE:-1052}"
  FWMARK="${FWMARK:-0xF7}"
  MAGIC_DNS="${MAGIC_DNS:-off}"
  IPV6="${IPV6:-off}"
  WATCHDOG="${WATCHDOG:-on}"
  WATCHDOG_INTERVAL="${WATCHDOG_INTERVAL:-30}"
  STATS_INTERVAL="${STATS_INTERVAL:-60}"
  LOG_MAX_KB="${LOG_MAX_KB:-512}"
  SOCKS_PORT="${SOCKS_PORT:-1099}"
  DNS_PORT="${DNS_PORT:-1053}"
  ROUTE_SCOPE="${ROUTE_SCOPE:-all}"
  ROUTE_SUBNETS="${ROUTE_SUBNETS:-100.64.0.0/10}"
  UID_LIST="${UID_LIST:-}"
}

# Create runtime directories (run/pids/stats) if missing.
ensure_run_dirs() {
  mkdir -p "${TS_RUN_DIR}" "${TS_PID_DIR}" "${TS_STATS_DIR}"
}

# Return 0 when the screen is on; tolerant of dumpsys format differences,
# assumes "on" when the power state cannot be determined.
is_screen_on() {
  _ft_power=$(dumpsys power 2>/dev/null)
  if [ -z "${_ft_power}" ]; then
    return 0
  fi
  echo "${_ft_power}" | grep -qi -e 'mScreenOn=true' -e 'Display Power: state=ON'
}

# --- Process lookup ------------------------------------------------------------

# Print PIDs whose full cmdline matches <pattern> (busybox pgrep preferred,
# plain pgrep as fallback).
pids_of() {
  busybox pgrep -f "$1" 2>/dev/null || pgrep -f "$1" 2>/dev/null
}

# Like pids_of, but every candidate PID is verified against
# /proc/<pid>/cmdline: argv[0] must be <path> itself or its basename. This
# filters false positives such as `tail -F tailscaled.log` or a foreign
# module's instance of the same program. [pat] overrides the pgrep pattern
# (default: basename of <path>).
pids_of_path() {
  _pop_path="$1"
  _pop_name="${_pop_path##*/}"
  _pop_candidates=$(pids_of "${2:-${_pop_name}}")
  for _pop_pid in ${_pop_candidates}; do
    _pop_argv0=$(tr '\0' '\n' <"/proc/${_pop_pid}/cmdline" 2>/dev/null | head -n 1)
    case "${_pop_argv0}" in
      "${_pop_path}" | "${_pop_name}")
        echo "${_pop_pid}"
        ;;
    esac
  done
}

# Echo the subset of the space-separated <pids> that are still alive.
_pids_alive() {
  _pa_alive=""
  # shellcheck disable=SC2086 # intentional: one PID per word
  for _pa_pid in $1; do
    kill -0 "${_pa_pid}" 2>/dev/null && _pa_alive="${_pa_alive}${_pa_pid} "
  done
  printf '%s' "${_pa_alive}"
}

# TERM every PID in <pids> (space-separated), wait up to [wait] seconds for
# them to exit, KILL the survivors, then verify 1s later. Logs throughout;
# returns 1 when any of the original PIDs is still alive at the end.
stop_by_pids() {
  _sbp_name="$1"
  _sbp_pids="$2"
  _sbp_wait="${3:-3}"
  [ -n "${_sbp_pids}" ] || return 0
  log Info "Stopping ${_sbp_name} (pids: ${_sbp_pids})."
  # shellcheck disable=SC2086 # intentional: one PID per word
  for _sbp_pid in ${_sbp_pids}; do
    kill -TERM "${_sbp_pid}" 2>/dev/null
  done
  _sbp_tries=$((_sbp_wait * 5))
  _sbp_i=0
  _sbp_alive="${_sbp_pids} "
  while [ "${_sbp_i}" -lt "${_sbp_tries}" ] && [ -n "${_sbp_alive}" ]; do
    _sbp_alive=$(_pids_alive "${_sbp_pids}")
    [ -z "${_sbp_alive}" ] && break
    sleep 0.2
    _sbp_i=$((_sbp_i + 1))
  done
  if [ -n "${_sbp_alive}" ]; then
    log Warning "${_sbp_name} still running after TERM; force killing."
    # shellcheck disable=SC2086 # intentional: one PID per word
    for _sbp_pid in ${_sbp_alive}; do
      kill -KILL "${_sbp_pid}" 2>/dev/null
    done
    sleep 1
    _sbp_alive=$(_pids_alive "${_sbp_pids}")
  fi
  if [ -n "${_sbp_alive}" ]; then
    log Error "${_sbp_name} could not be stopped (still running:${_sbp_alive})."
    return 1
  fi
  return 0
}

# --- Waiting / sleeping / timing -------------------------------------------------

# Run the first <n> args of "$@" as a command; private helper for wait_for.
# (Trailing args are rotated to the front and shifted off, quote-safe.)
_wait_for_run() {
  _wr_n="$1"
  shift
  _wr_drop=$(( $# - _wr_n ))
  _wr_i=0
  while [ "${_wr_i}" -lt "${_wr_n}" ]; do
    _wr_first="$1"
    shift
    set -- "$@" "${_wr_first}"
    _wr_i=$((_wr_i + 1))
  done
  [ "${_wr_drop}" -gt 0 ] && shift "${_wr_drop}"
  "$@"
}

# Poll <cmd...> until it succeeds; returns 1 after [tries] attempts (default
# 20) spaced [interval] seconds apart (default 0.5). Trailing numeric
# arguments set tries / interval; <desc> only labels the timeout log.
# Caveat: a trailing numeric cmd argument would be parsed as tries.
wait_for() {
  _wf_desc="$1"
  shift
  _wf_tries=20
  _wf_interval="0.5"
  _wf_last=""
  _wf_prev=""
  for _wf_a in "$@"; do
    _wf_prev="${_wf_last}"
    _wf_last="${_wf_a}"
  done
  _wf_nums=0
  case "${_wf_last}" in
    '' | *[!0-9.]*) ;;
    *)
      case "${_wf_prev}" in
        '' | *[!0-9.]*)
          _wf_tries="${_wf_last}"
          _wf_nums=1
          ;;
        *)
          _wf_tries="${_wf_prev}"
          _wf_interval="${_wf_last}"
          _wf_nums=2
          ;;
      esac
      ;;
  esac
  _wf_cmdlen=$(( $# - _wf_nums ))
  if [ "${_wf_cmdlen}" -lt 1 ]; then
    log Error "wait_for: no check command given (${_wf_desc})."
    return 2
  fi
  _wf_i=0
  while [ "${_wf_i}" -lt "${_wf_tries}" ]; do
    if _wait_for_run "${_wf_cmdlen}" "$@"; then
      return 0
    fi
    sleep "${_wf_interval}"
    _wf_i=$((_wf_i + 1))
  done
  log Debug "wait_for: ${_wf_desc} not ready after ${_wf_tries} tries."
  return 1
}

# Interruptible sleep: returns promptly when the shell receives TERM/INT.
isleep() {
  sleep "$1" &
  _isleep_pid=$!
  wait "${_isleep_pid}" 2>/dev/null
  kill "${_isleep_pid}" 2>/dev/null
}

# Run <cmd...> under timeout(1) when available; otherwise log one Warning
# (per process) and run without a time limit.
tmo() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$@"
    return
  fi
  if [ "${_TMO_WARNED:-0}" != "1" ]; then
    _TMO_WARNED=1
    log Warning "timeout(1) not available; running commands without a time limit."
  fi
  shift
  "$@"
}

# --- jq ------------------------------------------------------------------------

# True when a usable jq exists: bundled in $TS_BIN_DIR or on PATH.
have_jq() {
  [ -x "${TS_BIN_DIR}/jq" ] || command -v jq >/dev/null 2>&1
}

# Unified jq entry point: prefer the bundled binary, fall back to the system
# one; report clearly on stderr and return 127 when neither exists.
jqr() {
  if [ -x "${TS_BIN_DIR}/jq" ]; then
    "${TS_BIN_DIR}/jq" "$@"
  elif command -v jq >/dev/null 2>&1; then
    jq "$@"
  else
    echo "jqr: jq binary not found (looked in ${TS_BIN_DIR}/jq and PATH)" >&2
    return 127
  fi
}

# --- Resident daemon scaffolding -------------------------------------------------

# True when the pid file for <name> names a live process.
daemon_pid_alive() {
  _dpa_file="${TS_PID_DIR}/$1.pid"
  [ -f "${_dpa_file}" ] || return 1
  _dpa_pid=$(cat "${_dpa_file}" 2>/dev/null)
  case "${_dpa_pid}" in '' | *[!0-9]*) return 1 ;; esac
  kill -0 "${_dpa_pid}" 2>/dev/null
}

# Claim ${TS_PID_DIR}/<name>.pid for the current process. Returns 1 when a
# live pid file already points to a running instance of this script. PID
# reuse guard: a live pid whose cmdline does not mention <name> is treated
# as stale and the file is overwritten.
daemon_claim_pidfile() {
  _dcp_name="$1"
  _dcp_file="${TS_PID_DIR}/${_dcp_name}.pid"
  if [ -f "${_dcp_file}" ]; then
    _dcp_pid=$(cat "${_dcp_file}" 2>/dev/null)
    case "${_dcp_pid}" in '' | *[!0-9]*) _dcp_pid="" ;; esac
    if [ -n "${_dcp_pid}" ] && kill -0 "${_dcp_pid}" 2>/dev/null; then
      if tr '\0' ' ' <"/proc/${_dcp_pid}/cmdline" 2>/dev/null | grep -qF "${_dcp_name}"; then
        log Info "${_dcp_name} already running (pid ${_dcp_pid})"
        return 1
      fi
      log Warning "${_dcp_name}: stale pid file (pid ${_dcp_pid} belongs to another process); overwriting."
    fi
  fi
  echo "$$" >"${_dcp_file}"
  return 0
}

# Stop the daemon recorded in ${TS_PID_DIR}/<name>.pid via stop_by_pids and
# remove the pid file. A pid file pointing at a process that is not <name>
# (PID reuse) is only cleaned up, never signalled.
daemon_stop_pidfile() {
  _dsp_name="$1"
  _dsp_file="${TS_PID_DIR}/${_dsp_name}.pid"
  _dsp_rc=0
  _dsp_pid=$(cat "${_dsp_file}" 2>/dev/null)
  case "${_dsp_pid}" in '' | *[!0-9]*) _dsp_pid="" ;; esac
  if [ -n "${_dsp_pid}" ] && kill -0 "${_dsp_pid}" 2>/dev/null; then
    if tr '\0' ' ' <"/proc/${_dsp_pid}/cmdline" 2>/dev/null | grep -qF "${_dsp_name}"; then
      stop_by_pids "${_dsp_name}" "${_dsp_pid}" || _dsp_rc=1
    else
      log Warning "${_dsp_name}: pid ${_dsp_pid} is not ours (stale pid file); not signalling it."
    fi
  else
    log Info "${_dsp_name} is not running"
  fi
  rm -f "${_dsp_file}"
  return "${_dsp_rc}"
}
