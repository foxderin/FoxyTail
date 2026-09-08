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
#       log <level> <message>   colored, timestamped log to stdout + file
#       rotate_log <file>       rotate a log file when it exceeds LOG_MAX_KB
#       load_conf               source foxytail.conf / routes.conf + defaults
#       ensure_run_dirs         create run/pids/stats directories
#       is_screen_on            true if the screen is on (tolerant check)

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
# for any key the config files did not set.
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
  STATS_INTERVAL="${STATS_INTERVAL:-60}"
  SOCKS_PORT="${SOCKS_PORT:-1099}"
  DNS_PORT="${DNS_PORT:-1053}"
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
  echo "${_ft_power}" | grep -qi 'mScreenOn=true\|Display Power: state=ON'
}
