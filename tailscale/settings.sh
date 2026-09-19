#!/system/bin/sh
# Shared runtime environment and helpers; source this file, never execute it.
# Callers set DIR to their scripts directory (also used by staged installs).
# Do not set -e/-u here: those options leak into the sourcing shell.

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

# A root command launched by a manager WebView still inherits the manager's
# app cgroup. Android freezes that cgroup when the manager is backgrounded;
# freezing a configuration-lock owner then blocks every module operation.
# Move only this process before it can acquire a lock. Its children inherit
# the detached group; the manager and Android's freezer remain untouched.
detach_from_app_cgroup() {
  [ -r /proc/self/cgroup ] || return 0
  IFS= read -r _dac_stat </proc/self/stat || return 1
  _dac_pid=${_dac_stat%% *}
  case "${_dac_pid}" in '' | *[!0-9]*) return 1 ;; esac
  _dac_v2=0 _dac_freezer=0 _dac_cpuset=0 _dac_cpu=0
  while IFS=: read -r _dac_id _dac_controllers _dac_path; do
    case "${_dac_id}:${_dac_controllers}:${_dac_path}" in
      0::/apps/* | 0::/uid_*) _dac_v2=1 ;;
      *:freezer:/frozen | *:freezer:/frozen/*) _dac_freezer=1 ;;
      *:cpuset:/background | *:cpuset:/background/*) _dac_cpuset=1 ;;
      *:cpu:/background | *:cpu:/background/*) _dac_cpu=1 ;;
    esac
  done </proc/self/cgroup
  if [ "${_dac_v2}" = 1 ]; then
    if ! { [ -w /sys/fs/cgroup/cgroup.procs ] && echo "${_dac_pid}" >/sys/fs/cgroup/cgroup.procs; } 2>/dev/null; then
      echo 'cannot detach root command from the manager app freezer' >&2; return 1
    fi
  fi
  if [ "${_dac_freezer}" = 1 ]; then
    if ! { [ -w /dev/freezer/cgroup.procs ] && echo "${_dac_pid}" >/dev/freezer/cgroup.procs; } 2>/dev/null; then
      echo 'cannot detach root command from the manager freezer' >&2; return 1
    fi
  fi
  if [ "${_dac_v2}" = 1 ] || [ "${_dac_freezer}" = 1 ]; then
    while IFS=: read -r _dac_id _dac_controllers _dac_path; do
      case "${_dac_id}:${_dac_controllers}:${_dac_path}" in
        0::/apps/* | 0::/uid_* | *:freezer:/frozen | *:freezer:/frozen/*)
          echo 'root command is still in the manager app freezer' >&2; return 1 ;;
      esac
    done </proc/self/cgroup
  fi
  # Drop inherited background CPU restrictions too. These optional moves
  # affect only this root job and do not promote the manager to top-app.
  if [ "${_dac_cpuset}" = 1 ] && [ -w /dev/cpuset/cgroup.procs ]; then
    { echo "${_dac_pid}" >/dev/cpuset/cgroup.procs; } 2>/dev/null || :
  fi
  if [ "${_dac_cpu}" = 1 ] && [ -w /dev/cpuctl/cgroup.procs ]; then
    { echo "${_dac_pid}" >/dev/cpuctl/cgroup.procs; } 2>/dev/null || :
  fi
}

# Rotate <file> to <file>.bak (single backup) when it exceeds LOG_MAX_KB.
rotate_log() (
  _rl_file="$1"
  [ -f "${_rl_file}" ] || exit 0
  _rl_max_kb="${LOG_MAX_KB:-512}"
  _rl_max_bytes=$((_rl_max_kb * 1024))
  _rl_size=$(wc -c <"${_rl_file}" 2>/dev/null || echo 0)
  [ "${_rl_size}" -gt "${_rl_max_bytes}" ] || exit 0
  _rl_locked=0
  if [ "${_CONF_LOCK_HELD:-0}" != 1 ]; then
    conf_lock_acquire || exit 1
    _rl_locked=1
  fi
  _rl_tmp="${_rl_file}.bak.$$"
  trap 'rm -f "${_rl_tmp}"; [ "${_rl_locked}" = 0 ] || conf_lock_release' 0
  trap 'exit 1' HUP INT TERM
  # Preserve writer file descriptors and bound the backup, even if the source
  # grew far beyond its target before the resident log monitor ran.
  if tail -c "${_rl_max_bytes}" "${_rl_file}" >"${_rl_tmp}" && mv "${_rl_tmp}" "${_rl_file}.bak"; then
    : >"${_rl_file}"
  fi
)

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

# Create runtime directories (run/pids/stats) if missing.
ensure_run_dirs() {
  [ -d "${TS_RUN_DIR}" ] && [ -d "${TS_PID_DIR}" ] && [ -d "${TS_STATS_DIR}" ] && return 0
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

# Snapshot only the small argument prefix needed to identify our processes.
# Never feed procfs directly to toybox tr: if a candidate exits during the
# read, some Android builds spin on the stale fd instead of reaching EOF.
# A bounded reader isolates that race and also limits unusual argv lengths.
_proc_cmdline() {
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
  tmo 2 dd "if=/proc/$1/cmdline" bs=4096 count=1 2>/dev/null | tr '\000' '\n'
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
    # Reject vanished/foreign candidates before opening their command line.
    _pop_exe=$(readlink "/proc/${_pop_pid}/exe" 2>/dev/null)
    case "${_pop_exe}" in "${_pop_path}" | "${_pop_path} (deleted)") ;; *) continue ;; esac
    _pop_argv0=$(_proc_cmdline "${_pop_pid}" | head -n 1)
    case "${_pop_argv0}" in "${_pop_path}" | "${_pop_name}") echo "${_pop_pid}" ;; esac
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

# wait_for <description> <tries> <interval> <command...>
# Keep timing before the command so numeric command arguments stay literal.
wait_for() {
  _wf_desc="$1" _wf_tries="$2" _wf_interval="$3"
  shift 3
  _wf_i=0
  while [ "${_wf_i}" -lt "${_wf_tries}" ]; do
    "$@" && return 0
    _wf_i=$((_wf_i + 1))
    [ "${_wf_i}" -ge "${_wf_tries}" ] || sleep "${_wf_interval}"
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
  conf_lock_acquire || return 1
  if [ -f "${_dcp_file}" ]; then
    _dcp_pid=$(cat "${_dcp_file}" 2>/dev/null)
    case "${_dcp_pid}" in '' | *[!0-9]*) _dcp_pid="" ;; esac
    if [ -n "${_dcp_pid}" ] && kill -0 "${_dcp_pid}" 2>/dev/null; then
      if _proc_cmdline "${_dcp_pid}" | grep -qF "${_dcp_name}"; then
        log Info "${_dcp_name} already running (pid ${_dcp_pid})"
        conf_lock_release
        return 1
      fi
      log Warning "${_dcp_name}: stale pid file (pid ${_dcp_pid} belongs to another process); overwriting."
    fi
  fi
  if ! echo "$$" >"${_dcp_file}"; then conf_lock_release; return 1; fi
  conf_lock_release
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
    if _proc_cmdline "${_dsp_pid}" | grep -qF "${_dsp_name}"; then
      stop_by_pids "${_dsp_name}" "${_dsp_pid}" || _dsp_rc=1
    else
      log Warning "${_dsp_name}: pid ${_dsp_pid} is not ours (stale pid file); not signalling it."
    fi
  else
    log Info "${_dsp_name} is not running"
  fi
  [ "${_dsp_rc}" != 0 ] || rm -f "${_dsp_file}"
  return "${_dsp_rc}"
}

# shellcheck source=tailscale/scripts/foxytail.lock.sh
. "${DIR:-${TS_SCRIPTS_DIR}}/foxytail.lock.sh"
# shellcheck source=tailscale/scripts/foxytail.config.sh
. "${DIR:-${TS_SCRIPTS_DIR}}/foxytail.config.sh"
