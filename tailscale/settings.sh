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
#       load_conf                    parse foxytail.conf / routes.conf + defaults
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

# Configuration is data, never shell source. Keys and value domains are fixed;
# the same parser is used by runtime loading, writers, and archive restore.
_conf_keys() {
  case "$1" in
    foxytail.conf) printf '%s\n' TS_MODE SOCKS_PORT DNS_PORT MAGIC_DNS DNS_MODE IPV6 ROUTE_TABLE FWMARK FWMARK_MASK WATCHDOG WATCHDOG_INTERVAL STATS_INTERVAL LOG_MAX_KB ;;
    routes.conf) printf '%s\n' ROUTE_SCOPE UID_LIST ROUTE_SUBNETS ;;
    *) return 1 ;;
  esac
}

# Keep membership checks in the shell. load_conf runs for every WebAPI request;
# launching grep for every record serializes dozens of processes under its lock.
_conf_has_key() {
  case "$1:$2" in
    foxytail.conf:TS_MODE | foxytail.conf:SOCKS_PORT | foxytail.conf:DNS_PORT | foxytail.conf:MAGIC_DNS | foxytail.conf:IPV6 | foxytail.conf:ROUTE_TABLE | foxytail.conf:FWMARK | foxytail.conf:FWMARK_MASK | foxytail.conf:WATCHDOG | foxytail.conf:WATCHDOG_INTERVAL | foxytail.conf:STATS_INTERVAL | foxytail.conf:LOG_MAX_KB | routes.conf:ROUTE_SCOPE | routes.conf:UID_LIST | routes.conf:ROUTE_SUBNETS) return 0 ;;
    foxytail.conf:DNS_MODE) return 0 ;;
    *) return 1 ;;
  esac
}

_num_in_range() {
  case "$1" in '' | *[!0-9]* | ??????*) return 1 ;; esac
  [ "$1" -ge "$2" ] 2>/dev/null && [ "$1" -le "$3" ] 2>/dev/null
}

# Validate, mask host bits and deduplicate space-separated CIDRs. Keep host
# routes (/32 and /128) and input order; callers decide which destinations
# belong in their own routing policy. No platform ip command is needed.
normalize_cidrs() {
  printf '%s\n' "$1" | awk '
    function ipv4(s, oct, n,i) {
      n=split(s,oct,"."); if(n!=4) return 0
      for(i=1;i<=4;i++) {
        if(oct[i]!~/^[0-9]+$/ || length(oct[i])>3 || oct[i]+0>255) return 0
        oct[i]+=0
      }
      return 1
    }
    function hex(s, i,v,d) {
      if(s!~/^[0-9a-f]+$/ || length(s)>4) return -1
      v=0
      for(i=1;i<=length(s);i++) {d=index("0123456789abcdef",substr(s,i,1))-1;v=v*16+d}
      return v
    }
    function mask(v,bits,width) {
      if(bits<=0) return 0
      if(bits>=width) return v
      return int(v/(2^(width-bits)))*(2^(width-bits))
    }
    function norm4(s,p,oct,i,out) {
      if(p>32 || !ipv4(s,oct)) return ""
      out=""
      for(i=1;i<=4;i++) out=out (i==1 ? "" : ".") mask(oct[i],p-(i-1)*8,8)
      return out "/" p
    }
    function norm6(s,p,oct,left,right,words,pos,last,nl,nr,n,i,j,v,best,bestlen,out) {
      if(p>128) return ""
      s=tolower(s)
      if(index(s,".")) {
        last=0
        for(i=1;i<=length(s);i++) if(substr(s,i,1)==":") last=i
        if(!last || !ipv4(substr(s,last+1),oct)) return ""
        s=substr(s,1,last) sprintf("%x:%x",oct[1]*256+oct[2],oct[3]*256+oct[4])
      }
      if(s!~/^[0-9a-f:]+$/ || index(s,":::")) return ""
      pos=index(s,"::")
      if(pos) {
        if(index(substr(s,pos+2),"::")) return ""
        nl=0;nr=0
        if(pos>1) nl=split(substr(s,1,pos-1),left,":")
        if(pos+2<=length(s)) nr=split(substr(s,pos+2),right,":")
        if(nl+nr>=8) return ""
        n=0
        for(i=1;i<=nl;i++) {v=hex(left[i]);if(v<0)return "";words[++n]=v}
        for(i=1;i<=8-nl-nr;i++) words[++n]=0
        for(i=1;i<=nr;i++) {v=hex(right[i]);if(v<0)return "";words[++n]=v}
      } else {
        n=split(s,left,":");if(n!=8)return ""
        for(i=1;i<=8;i++) {v=hex(left[i]);if(v<0)return "";words[i]=v}
      }
      for(i=1;i<=8;i++) words[i]=mask(words[i],p-(i-1)*16,16)
      best=0;bestlen=1
      for(i=1;i<=8;i++) if(words[i]==0) {
        j=i;while(j<=8 && words[j]==0)j++
        if(j-i>bestlen) {best=i;bestlen=j-i}
        i=j-1
      }
      out="";i=1
      while(i<=8) {
        if(i==best) {out=out "::";i+=bestlen;continue}
        if(out!="" && substr(out,length(out),1)!=":") out=out ":"
        out=out sprintf("%x",words[i]);i++
      }
      return out "/" p
    }
    {
      for(k=1;k<=NF;k++) {
        if(split($k,pair,"/")!=2 || pair[2]!~/^[0-9]+$/ || length(pair[2])>3) {bad=1;exit 1}
        prefix=pair[2]+0
        cidr=index(pair[1],":") ? norm6(pair[1],prefix) : norm4(pair[1],prefix)
        if(cidr=="") {bad=1;exit 1}
        if(!seen[cidr]++) result=result (result=="" ? "" : " ") cidr
      }
    }
    END {if(!bad) printf "%s",result}
  '
}

_conf_value_error() {
  case "$1:$2" in
    TS_MODE:bridge | TS_MODE:tun | TS_MODE:proxy | ROUTE_SCOPE:all | ROUTE_SCOPE:selected | ROUTE_SCOPE:bypass) return 0 ;;
    MAGIC_DNS:on | MAGIC_DNS:off | IPV6:on | IPV6:off | WATCHDOG:on | WATCHDOG:off) return 0 ;;
    DNS_MODE:legacy | DNS_MODE:local | DNS_MODE:transparent) return 0 ;;
    FWMARK:0x40000000 | FWMARK_MASK:0x40000000 | FWMARK:0xF7 | FWMARK:0xf7) return 0 ;;
  esac
  case "$1" in
    SOCKS_PORT | DNS_PORT) _num_in_range "$2" 1024 65535 && return 0 ;;
    ROUTE_TABLE) _num_in_range "$2" 1000 65535 && return 0 ;;
    WATCHDOG_INTERVAL) _num_in_range "$2" 5 300 && return 0 ;;
    STATS_INTERVAL) _num_in_range "$2" 10 3600 && return 0 ;;
    LOG_MAX_KB) _num_in_range "$2" 64 10240 && return 0 ;;
    UID_LIST)
      case "$2" in
        *[!0-9\ ]*) ;;
        *) if printf '%s\n' "$2" | awk '{for(i=1;i<=NF;i++) if($i+0==0 || $i+0>2147483647) exit 1}'; then return 0; fi ;;
      esac
      ;;
    ROUTE_SUBNETS)
      if normalize_cidrs "$2" >/dev/null; then return 0; fi
      ;;
  esac
  printf '%s\n' "invalid value for $1 (unknown keys are not allowed)"
  return 1
}

# Emit normalized KEY=value records only after each record passes the schema.
# Callers capture the complete output and discard it if any line is invalid.
_conf_parse_file() {
  _cpf_file="$1"
  _cpf_name="${2:-${_cpf_file##*/}}"
  _cpf_seen=" "
  _cpf_n=0
  [ -f "${_cpf_file}" ] && [ ! -L "${_cpf_file}" ] || { echo "${_cpf_name}: expected regular file" >&2; return 1; }
  while IFS= read -r _cpf_line || [ -n "${_cpf_line}" ]; do
    _cpf_n=$((_cpf_n + 1))
    case "${_cpf_line}" in '' | '#'*) continue ;; *=*) ;; *) echo "${_cpf_name}:${_cpf_n}: expected KEY=value" >&2; return 1 ;; esac
    _cpf_key=${_cpf_line%%=*}
    _cpf_val=${_cpf_line#*=}
    if ! _conf_has_key "${_cpf_name}" "${_cpf_key}"; then
      echo "${_cpf_name}:${_cpf_n}: unknown key" >&2; return 1
    fi
    case "${_cpf_seen}" in *" ${_cpf_key} "*) echo "${_cpf_name}:${_cpf_n}: duplicate key ${_cpf_key}" >&2; return 1 ;; esac
    _cpf_seen="${_cpf_seen}${_cpf_key} "
    case "${_cpf_val}" in
      \"*\") _cpf_val=${_cpf_val#\"}; _cpf_val=${_cpf_val%\"} ;;
    esac
    if ! _conf_value_error "${_cpf_key}" "${_cpf_val}" >/dev/null; then
      echo "${_cpf_name}:${_cpf_n}: invalid value for ${_cpf_key}" >&2; return 1
    fi
    # Upgrade the old unmasked low-byte mark; no shell evaluation occurs.
    case "${_cpf_key}:${_cpf_val}" in FWMARK:0xF7 | FWMARK:0xf7) _cpf_val=0x40000000 ;; esac
    # Android mksh invokes external printf. Validated schema values contain no
    # backslashes and the fixed KEY= prefix cannot be an echo option.
    echo "${_cpf_key}=${_cpf_val}"
  done <"${_cpf_file}"
}

_conf_file_error() {
  { _conf_parse_file "$1" "${2:-${1##*/}}" >/dev/null; } 2>&1
}

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
  _proc_starttime "$1" || printf '%s' '-'
}

_conf_owner_alive() {
  _coa_pid=${1%%:*}
  _coa_stamp=${1#*:}
  case "${_coa_pid}" in '' | *[!0-9]*) return 0 ;; esac
  kill -0 "${_coa_pid}" 2>/dev/null || return 1
  [ "$(_conf_pid_stamp "${_coa_pid}")" = "${_coa_stamp}" ]
}

conf_lock_acquire() {
  [ -d "${TS_RUN_DIR}" ] || mkdir -p "${TS_RUN_DIR}" || return 1
  _cfl_dir="${TS_RUN_DIR}/.conf-write-lock"
  _cfl_token="$$:$(_conf_pid_stamp "$$")"
  _cfl_i=0
  while ! ln -s "${_cfl_token}" "${_cfl_dir}" 2>/dev/null; do
    _cfl_owner=$(readlink "${_cfl_dir}" 2>/dev/null)
    if [ -n "${_cfl_owner}" ] && ! _conf_owner_alive "${_cfl_owner}"; then
      # Only one stale-owner reaper can recheck/remove the primary lock. A
      # recheck is required because another waiter may already own a new lock.
      if ln -s "${_cfl_token}" "${_cfl_dir}.reap" 2>/dev/null; then
        _cfl_owner=$(readlink "${_cfl_dir}" 2>/dev/null)
        if [ -n "${_cfl_owner}" ] && ! _conf_owner_alive "${_cfl_owner}"; then rm -f "${_cfl_dir}"; fi
        rm -f "${_cfl_dir}.reap"
      fi
    fi
    _cfl_i=$((_cfl_i + 1))
    [ "${_cfl_i}" -lt 100 ] || { echo 'configuration is busy; retry' >&2; return 1; }
    sleep 0.1
  done
  _CONF_LOCK_HELD=1
  _CONF_LOCK_TOKEN=${_cfl_token}
}

conf_lock_release() {
  if [ "${_CONF_LOCK_HELD:-0}" = 1 ]; then
    if [ "$(readlink "${TS_RUN_DIR}/.conf-write-lock" 2>/dev/null)" = "${_CONF_LOCK_TOKEN}" ]; then
      rm -f "${TS_RUN_DIR}/.conf-write-lock"
    fi
    _CONF_LOCK_HELD=0
  fi
}

# Must be called under conf_lock_acquire. A restart clears only the revision it
# captured before loading settings, so later writes retain their pending marker.
conf_mark_pending() {
  _cmp_sum=$(cat "${TS_CONF_DIR}/foxytail.conf" "${TS_CONF_DIR}/routes.conf" "${TS_CONF_DIR}/context.conf" 2>/dev/null | cksum)
  printf '%s-%s-%s\n' "$$" "$(date +%s)" "${_cmp_sum}" >"${TS_RUN_DIR}/.settings.pending.$$" &&
    mv "${TS_RUN_DIR}/.settings.pending.$$" "${TS_RUN_DIR}/settings.pending"
}

# Read both files under the writer lock, so restore cannot expose a mixed pair.
load_conf() {
  TS_MODE=bridge ROUTE_TABLE=1052 FWMARK=0x40000000 FWMARK_MASK=0x40000000
  MAGIC_DNS=off DNS_MODE=legacy IPV6=off WATCHDOG=on WATCHDOG_INTERVAL=30 STATS_INTERVAL=60
  LOG_MAX_KB=512 SOCKS_PORT=1099 DNS_PORT=1053 ROUTE_SCOPE=all
  ROUTE_SUBNETS=100.64.0.0/10 UID_LIST=
  _lc_locked=0
  if [ "${_CONF_LOCK_HELD:-0}" != 1 ]; then
    conf_lock_acquire || return 1
    _lc_locked=1
  fi
  _lc_data=$(
    for _lc_file in foxytail.conf routes.conf; do
      if [ -e "${TS_CONF_DIR}/${_lc_file}" ] || [ -L "${TS_CONF_DIR}/${_lc_file}" ]; then
        _conf_parse_file "${TS_CONF_DIR}/${_lc_file}" || exit 1
      fi
    done
  )
  _lc_rc=$?
  [ "${_lc_locked}" = 0 ] || conf_lock_release
  [ "${_lc_rc}" = 0 ] || return 1
  while IFS= read -r _lc_record; do
    [ -n "${_lc_record}" ] || continue
    # shellcheck disable=SC2163 # fixed-schema KEY=value record, no evaluation
    export "${_lc_record}"
  done <<EOF_CONF_DATA
${_lc_data}
EOF_CONF_DATA

}

# Public writer for service mode changes and WebAPI settings. The subshell owns
# its cleanup trap without replacing signal handlers in long-lived callers.
conf_write_key() (
  [ ! -f "${TS_DIR}/.installing" ] || { echo "upgrade in progress" >&2; exit 1; }
  _cw_file="$1" _cw_key="$2" _cw_value="$3"
  _conf_has_key "${_cw_file}" "${_cw_key}" || { echo 'unknown configuration key' >&2; exit 1; }
  _conf_value_error "${_cw_key}" "${_cw_value}" >&2 || exit 1
  case "${_cw_key}:${_cw_value}" in FWMARK:0xF7 | FWMARK:0xf7) echo 'FWMARK must be 0x40000000' >&2; exit 1 ;; esac
  conf_lock_acquire || exit 1
  trap 'rm -f "${_cw_tmp}"; conf_lock_release' 0
  trap 'exit 1' HUP INT TERM
  load_conf || exit 1
  case "${_cw_key}:${_cw_value}" in
    TS_MODE:tun) [ "${ROUTE_SCOPE}" = all ] || { echo 'native tun supports only ROUTE_SCOPE=all' >&2; exit 1; } ;;
    ROUTE_SCOPE:selected | ROUTE_SCOPE:bypass) [ "${TS_MODE}" != tun ] || { echo 'UID routing requires bridge mode' >&2; exit 1; } ;;
  esac
  mkdir -p "${TS_CONF_DIR}" || exit 1
  _cw_tmp="${TS_CONF_DIR}/.${_cw_file}.$$"
  _cw_source="${TS_CONF_DIR}/${_cw_file}"
  [ -f "${_cw_source}" ] || _cw_source=/dev/null
  awk -v k="${_cw_key}" -v v="${_cw_value}" '
    BEGIN {done=0}
    index($0,k "=")==1 {print k "=\"" v "\""; done=1; next}
    {print}
    END {if(!done) print k "=\"" v "\""}
  ' "${_cw_source}" >"${_cw_tmp}" || exit 1
  _conf_parse_file "${_cw_tmp}" "${_cw_file}" >/dev/null || exit 1
  chmod 0600 "${_cw_tmp}" || exit 1
  mv "${_cw_tmp}" "${TS_CONF_DIR}/${_cw_file}" && conf_mark_pending
)

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
