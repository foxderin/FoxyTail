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

# Private LocalAPI socket and pid file of the tailscaled daemon; resident
# scripts keep their own PID_FILE for the process they supervise.
TS_SOCKET="${TS_RUN_DIR}/tailscaled.sock"
TS_DAEMON_PID_FILE="${TS_PID_DIR}/tailscaled.pid"

# Tunnel interface, created by hev-socks5-tunnel (bridge) or tailscaled (tun).
TUN_IFACE="tailscale0"

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
  _rl_size=${2:-$(wc -c <"${_rl_file}" 2>/dev/null || echo 0)}
  [ "${_rl_size}" -gt "${_rl_max_bytes}" ] || exit 0
  # A dedicated leaf lock serializes concurrent rotators. Logging is called
  # from inside every other critical section, so it must not wait on the
  # configuration lock; this path performs no logging itself, so its own
  # lock can never recurse.
  _lock_identity &&
    _owner_lock_acquire "${TS_RUN_DIR}/.log-rotate-lock" "${_LOCK_TOKEN}" 100 0.1 || exit 1
  trap '_owner_lock_release "${TS_RUN_DIR}/.log-rotate-lock" "${_LOCK_TOKEN}"; rm -f "${_rl_tmp}"' 0
  trap 'exit 1' HUP INT TERM
  _rl_tmp="${_rl_file}.bak.$$"
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

# Prefer kernel display state: no Binder dump or helper process on this path.
# Unknown state stays awake; an unrecognized dumpsys format must not throttle.
is_screen_on() {
  if [ -r /sys/class/graphics/fb0/blank ] && IFS= read -r _ft_blank </sys/class/graphics/fb0/blank; then
    case "${_ft_blank}" in 0) return 0 ;; 1|2|3|4) return 1 ;; esac
  fi
  _ft_seen=0
  for _ft_backlight in /sys/class/backlight/*/bl_power; do
    [ -r "${_ft_backlight}" ] && IFS= read -r _ft_blank <"${_ft_backlight}" || continue
    case "${_ft_blank}" in 0) return 0 ;; 4) _ft_seen=1 ;; *) _ft_seen=0; break ;; esac
  done
  [ "${_ft_seen}" = 0 ] || return 1
  _ft_power=$(tmo 2 dumpsys power 2>/dev/null) || return 0
  printf '%s\n' "${_ft_power}" | awk '
    /mScreenOn=true|Display Power: state=ON|mWakefulness=(Awake|Dreaming)/ {on=1}
    /mScreenOn=false|Display Power: state=(OFF|DOZE)|mWakefulness=(Asleep|Dozing)/ {off=1}
    END {exit on || !off ? 0 : 1}'
}

# Shared resident schedule. Explicitly disabled features never reach this
# helper; power saving changes cadence without re-enabling them.
effective_interval() {
  _ei_interval=$1 _ei_min=$3
  if [ "$2" != 1 ] || [ "${POWER_SAVE:-off}" = on ]; then
    if ! is_screen_on; then
      _ei_interval=$(($1 * $2))
      _ei_min=$4
    fi
  fi
  if [ "${POWER_SAVE:-off}" = on ] && [ "$_ei_interval" -lt "$_ei_min" ]; then
    _ei_interval=$_ei_min
  fi
  echo "$_ei_interval"
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
  tmo 2 dd "if=/proc/$1/cmdline" bs=4096 count=1 2>/dev/null | tr '\n' '\r' | tr '\000' '\n'
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

# Echo the subset of the space-separated "pid:starttime" targets whose
# process is still alive with the same start time. A recycled PID carries a
# different start time, so a dead target's slot can never match a foreign
# replacement process.
_pids_alive_verified() {
  _pav_alive=""
  for _pav_target in $1; do
    _pav_pid=${_pav_target%%:*}
    if kill -0 "${_pav_pid}" 2>/dev/null &&
      [ "$(_proc_starttime "${_pav_pid}")" = "${_pav_target##*:}" ]; then
      _pav_alive="${_pav_alive}${_pav_target} "
    fi
  done
  printf '%s' "${_pav_alive}"
}

# TERM every PID in <pids> (space-separated), wait up to [wait] seconds for
# them to exit, KILL the survivors, then verify 1s later. Each PID is bound
# to its /proc start time once at entry; every liveness check and every
# signal afterwards revalidates that pair, so a recycled PID is never
# signalled or awaited. Returns 1 when any original target is still alive.
stop_by_pids() {
  _sbp_name="$1"
  _sbp_pids="$2"
  _sbp_wait="${3:-3}"
  [ -n "${_sbp_pids}" ] || return 0
  log Info "Stopping ${_sbp_name} (pids: ${_sbp_pids})."
  _sbp_targets=""
  for _sbp_pid in ${_sbp_pids}; do
    _sbp_stamp=$(_proc_starttime "${_sbp_pid}") || continue
    _sbp_targets="${_sbp_targets}${_sbp_pid}:${_sbp_stamp} "
  done
  for _sbp_target in ${_sbp_targets}; do
    _sbp_pid=${_sbp_target%%:*}
    [ "$(_proc_starttime "${_sbp_pid}")" = "${_sbp_target##*:}" ] &&
      kill -TERM "${_sbp_pid}" 2>/dev/null
  done
  _sbp_tries=$((_sbp_wait * 5))
  _sbp_i=0
  _sbp_alive=" "
  while [ "${_sbp_i}" -lt "${_sbp_tries}" ] && [ -n "${_sbp_alive}" ]; do
    _sbp_alive=$(_pids_alive_verified "${_sbp_targets}")
    [ -z "${_sbp_alive}" ] && break
    sleep 0.2
    _sbp_i=$((_sbp_i + 1))
  done
  if [ -n "${_sbp_alive}" ]; then
    log Warning "${_sbp_name} still running after TERM; force killing."
    for _sbp_target in ${_sbp_alive}; do
      _sbp_pid=${_sbp_target%%:*}
      [ "$(_proc_starttime "${_sbp_pid}")" = "${_sbp_target##*:}" ] &&
        kill -KILL "${_sbp_pid}" 2>/dev/null
    done
    sleep 1
    _sbp_alive=$(_pids_alive_verified "${_sbp_targets}")
  fi
  if [ -n "${_sbp_alive}" ]; then
    _sbp_left=""
    for _sbp_target in ${_sbp_alive}; do _sbp_left="${_sbp_left}${_sbp_target%%:*} "; done
    log Error "${_sbp_name} could not be stopped (still running:${_sbp_left})."
    return 1
  fi
  return 0
}

# --- Network interface ---------------------------------------------------------

# True when the configured tunnel interface exists.
iface_exists() {
  ip link show dev "${TUN_IFACE}" >/dev/null 2>&1
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

# --- Daemon status --------------------------------------------------------------

# Run a `status --json` query against the private socket and print the reply only
# when it parses as JSON. <runner> wraps the CLI and receives <timeout> first:
# tmo in the resident scripts (which degrades to an unbounded run, with one
# Warning, when timeout(1) is missing), timeout(1) itself where an unbounded run
# is unacceptable, and ts_cli in the WebAPI (which registers the child for
# cancellation). The CLI command follows the runner and each call site keeps its
# own stderr redirection. A failed, empty or non-JSON reply prints nothing and
# returns 1.
ts_status_json() {
  _tsj_runner="$1"
  shift
  _tsj_json=$("${_tsj_runner}" "$@") || return 1
  [ -n "${_tsj_json}" ] || return 1
  printf '%s' "${_tsj_json}" | jqr -e . >/dev/null 2>&1 || return 1
  printf '%s' "${_tsj_json}"
}

# MagicDNS readiness of one `foxytail.dns status --json` document: a running
# resolver whose listener, policy and interception match the current DNS_MODE.
dns_status_healthy() {
  printf '%s' "$1" | jqr -e --arg mode "${DNS_MODE}" '
  type=="object" and .state=="running" and .repairNeeded!=true and
  (if (.mode // $mode)=="legacy" then (.pid|type)=="number" and .pid>0 and .enabled==true
   else .enabled==true and .listenerReady==true and .repairNeeded==false and .policyState=="owned" and
     (((.mode // $mode)=="local" and .reason=="local") or
      ((.mode // $mode)=="transparent" and .reason=="running" and .interception4==true)) end)
' >/dev/null 2>&1
}

# --- Resident daemon scaffolding -------------------------------------------------

# Linux boot identity and elapsed time are independent of wall-clock corrections.
monotonic_seconds() {
  IFS=' ' read -r _mono _mono_idle </proc/uptime || return 1
  printf '%s\n' "${_mono%%.*}"
}

service_stop_held() {
  [ -f "${TS_RUN_DIR}/manual-stop" ] || [ -f "${TS_RUN_DIR}/context-stop" ]
}

# Match the executable/script argument, never a substring in an unrelated argv.
resident_identity_alive() {
  _ria_name=$1 _ria_pid=$2 _ria_stamp=$3 _ria_boot=$4
  case "${_ria_pid}:${_ria_stamp}" in *[!0-9:]*|:*|*:) return 1 ;; esac
  [ -n "${_ria_boot}" ] && [ "${_ria_boot}" = "$(boot_identity)" ] || return 1
  [ "$(_proc_starttime "${_ria_pid}")" = "${_ria_stamp}" ] || return 1
  if [ "${_ria_name}" = inotifyd ]; then
    _proc_cmdline "${_ria_pid}" | awk -v script="${TS_SCRIPTS_DIR}/foxytail.inotify" -v module="${TS_MOD_DIR}" '
      NR==1 { if ($0 ~ /(^|\/)inotifyd$/) command=2; busybox=($0 ~ /(^|\/)busybox$/) }
      NR==2 && busybox && $0=="inotifyd" { command=3 }
      NR==command && $0==script { handler=1 }
      NR==command+1 && $0==module { directory=1 }
      END { exit !(handler && directory) }'
    return $?
  fi
  _ria_action=start
  [ "${_ria_name}" != foxytail.trial ] || _ria_action=run
  _proc_cmdline "${_ria_pid}" | awk -v script="${TS_SCRIPTS_DIR}/${_ria_name}" -v action="${_ria_action}" '
    NR==1 { if ($0==script) command=2; shell=($0 ~ /(^|\/)(sh|mksh|ash|bash)$/) }
    NR==2 && shell && $0==script { command=3 }
    NR==command && $0==action { found=1 }
    END { exit !found }'
}

# The same predicate backs readiness, cold recovery, status, claim and stop.
daemon_pid_alive() {
  _dpa_file="${TS_PID_DIR}/$1.pid"
  [ -f "${_dpa_file}" ] && [ ! -L "${_dpa_file}" ] || return 1
  IFS=' ' read -r _dpa_pid _dpa_stamp _dpa_boot <"${_dpa_file}" || return 1
  resident_identity_alive "$1" "${_dpa_pid}" "${_dpa_stamp}" "${_dpa_boot}"
}

daemon_claim_pidfile() {
  _dcp_name=$1 _dcp_file="${TS_PID_DIR}/$1.pid"
  _lock_identity || return 1
  _dcp_token=${_LOCK_TOKEN}
  _dcp_lock="${TS_PID_DIR}/.$1.lock"
  _owner_lock_acquire "${_dcp_lock}" "${_dcp_token}" 100 0.1 || return 1
  if daemon_pid_alive "${_dcp_name}"; then
    _owner_lock_release "${_dcp_lock}" "${_dcp_token}"
    return 2
  fi
  _dcp_stamp=$(_proc_starttime "$$") _dcp_boot=$(boot_identity)
  _dcp_rc=0
  if [ -z "${_dcp_stamp}" ] || [ -z "${_dcp_boot}" ] ||
     ! { printf '%s %s %s\n' "$$" "${_dcp_stamp}" "${_dcp_boot}" >"${_dcp_file}.$$" &&
         mv -f "${_dcp_file}.$$" "${_dcp_file}"; }; then
    rm -f "${_dcp_file}.$$"
    _dcp_rc=1
  fi
  _owner_lock_release "${_dcp_lock}" "${_dcp_token}"
  return "${_dcp_rc}"
}

daemon_release_pidfile() {
  _drp_file="${TS_PID_DIR}/$1.pid"
  [ -f "${_drp_file}" ] && [ ! -L "${_drp_file}" ] || return 0
  IFS=' ' read -r _drp_pid _drp_stamp _drp_boot <"${_drp_file}" || return 0
  [ "${_drp_pid}" = "$$" ] && [ "${_drp_stamp}" = "$(_proc_starttime "$$")" ] &&
    [ "${_drp_boot}" = "$(boot_identity)" ] || return 0
  rm -f "${_drp_file}"
}

daemon_stop_pidfile() (
  _dsp_name=$1 _dsp_file="${TS_PID_DIR}/$1.pid"
  _lock_identity || exit 1
  _dsp_token=${_LOCK_TOKEN} _dsp_lock="${TS_PID_DIR}/.$1.lock"
  _owner_lock_acquire "${_dsp_lock}" "${_dsp_token}" 100 0.1 || exit 1
  trap '_owner_lock_release "${_dsp_lock}" "${_dsp_token}"' 0
  trap 'exit 1' HUP INT TERM
  if daemon_pid_alive "${_dsp_name}"; then
    _dsp_pid=${_dpa_pid} _dsp_stamp=${_dpa_stamp} _dsp_boot=${_dpa_boot}
    resident_identity_alive "${_dsp_name}" "${_dsp_pid}" "${_dsp_stamp}" "${_dsp_boot}" && kill -TERM "${_dsp_pid}" 2>/dev/null
    _dsp_i=0
    while resident_identity_alive "${_dsp_name}" "${_dsp_pid}" "${_dsp_stamp}" "${_dsp_boot}"; do
      if [ "${_dsp_i}" -ge 50 ]; then
        resident_identity_alive "${_dsp_name}" "${_dsp_pid}" "${_dsp_stamp}" "${_dsp_boot}" && kill -KILL "${_dsp_pid}" 2>/dev/null
        sleep 0.1
        resident_identity_alive "${_dsp_name}" "${_dsp_pid}" "${_dsp_stamp}" "${_dsp_boot}" && exit 1
        break
      fi
      sleep 0.1
      _dsp_i=$((_dsp_i + 1))
    done
  fi
  daemon_pid_alive "${_dsp_name}" || rm -f "${_dsp_file}"
)

# shellcheck source=tailscale/scripts/foxytail.lock.sh
. "${DIR:-${TS_SCRIPTS_DIR}}/foxytail.lock.sh"
# shellcheck source=tailscale/scripts/foxytail.config.sh
. "${DIR:-${TS_SCRIPTS_DIR}}/foxytail.config.sh"
# shellcheck source=tailscale/scripts/foxytail.network.sh
. "${DIR:-${TS_SCRIPTS_DIR}}/foxytail.network.sh"
# shellcheck source=tailscale/scripts/foxytail.taildrop.sh
. "${DIR:-${TS_SCRIPTS_DIR}}/foxytail.taildrop.sh"
