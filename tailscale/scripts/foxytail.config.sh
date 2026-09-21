#!/system/bin/sh
# Configuration parsing, atomic writes and applied snapshots. Sourced by settings.sh.

# Configuration is data, never shell source. Keys and value domains are fixed;
# the same parser is used by runtime loading, writers, and archive restore.
# Keep membership checks in the shell. load_conf runs for every WebAPI request;
# launching grep for every record serializes dozens of processes under its lock.
_conf_has_key() {
  case "$1:$2" in
    foxytail.conf:TS_MODE | foxytail.conf:SOCKS_PORT | foxytail.conf:DNS_PORT | foxytail.conf:MAGIC_DNS | foxytail.conf:IPV6 | foxytail.conf:ROUTE_TABLE | foxytail.conf:FWMARK | foxytail.conf:FWMARK_MASK | foxytail.conf:WATCHDOG | foxytail.conf:WATCHDOG_INTERVAL | foxytail.conf:STATS_INTERVAL | foxytail.conf:LOG_MAX_KB | routes.conf:ROUTE_SCOPE | routes.conf:UID_LIST | routes.conf:ROUTE_SUBNETS) return 0 ;;
    foxytail.conf:DNS_MODE) return 0 ;;
    foxytail.conf:POWER_SAVE | foxytail.conf:STATS | foxytail.conf:CONTEXT | foxytail.conf:WATCHDOG_PROBE | foxytail.conf:WEBUI_AUTO_REFRESH) return 0 ;;
    # Advanced resident knobs; edited in foxytail.conf, never returned by
    # cmd_settings_get so the WebUI schema stays unchanged.
    foxytail.conf:CONTEXT_INTERVAL | foxytail.conf:STATS_RETENTION_DAYS | foxytail.conf:WATCHDOG_RESTART_LIMIT | foxytail.conf:WATCHDOG_RESTART_WINDOW | foxytail.conf:WATCHDOG_COOLDOWN | foxytail.conf:WATCHDOG_BACKEND_BAD_LIMIT) return 0 ;;
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
    POWER_SAVE:on | POWER_SAVE:off | STATS:on | STATS:off | CONTEXT:on | CONTEXT:off | WATCHDOG_PROBE:on | WATCHDOG_PROBE:off | WEBUI_AUTO_REFRESH:on | WEBUI_AUTO_REFRESH:off) return 0 ;;
    DNS_MODE:legacy | DNS_MODE:local | DNS_MODE:transparent) return 0 ;;
    FWMARK:0x40000000 | FWMARK_MASK:0x40000000 | FWMARK:0xF7 | FWMARK:0xf7) return 0 ;;
  esac
  case "$1" in
    SOCKS_PORT | DNS_PORT) _num_in_range "$2" 1024 65535 && return 0 ;;
    ROUTE_TABLE) _num_in_range "$2" 1000 65535 && return 0 ;;
    WATCHDOG_INTERVAL) _num_in_range "$2" 5 300 && return 0 ;;
    STATS_INTERVAL) _num_in_range "$2" 10 3600 && return 0 ;;
    CONTEXT_INTERVAL) _num_in_range "$2" 5 3600 && return 0 ;;
    STATS_RETENTION_DAYS) _num_in_range "$2" 1 3650 && return 0 ;;
    WATCHDOG_RESTART_LIMIT) _num_in_range "$2" 1 100 && return 0 ;;
    WATCHDOG_RESTART_WINDOW) _num_in_range "$2" 60 86400 && return 0 ;;
    WATCHDOG_COOLDOWN) _num_in_range "$2" 10 3600 && return 0 ;;
    WATCHDOG_BACKEND_BAD_LIMIT) _num_in_range "$2" 1 100 && return 0 ;;
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

# Must be called under conf_lock_acquire. A restart clears only the revision it
# captured in its candidate snapshot, so later writes retain their pending marker.
conf_mark_pending() {
  _cmp_sum=$(cat "${TS_CONF_DIR}/foxytail.conf" "${TS_CONF_DIR}/routes.conf" "${TS_CONF_DIR}/context.conf" 2>/dev/null | cksum)
  printf '%s-%s-%s\n' "$$" "$(date +%s)" "${_cmp_sum}" >"${TS_RUN_DIR}/.settings.pending.$$" &&
    mv "${TS_RUN_DIR}/.settings.pending.$$" "${TS_RUN_DIR}/settings.pending"
}

_conf_assign() {
  TS_MODE=bridge ROUTE_TABLE=1052 FWMARK=0x40000000 FWMARK_MASK=0x40000000
  MAGIC_DNS=off DNS_MODE=legacy IPV6=off WATCHDOG=on WATCHDOG_INTERVAL=30 STATS_INTERVAL=60
  POWER_SAVE=off STATS=on CONTEXT=on WATCHDOG_PROBE=on WEBUI_AUTO_REFRESH=on
  CONTEXT_INTERVAL=20 STATS_RETENTION_DAYS=7 WATCHDOG_RESTART_LIMIT=5
  WATCHDOG_RESTART_WINDOW=600 WATCHDOG_COOLDOWN=300 WATCHDOG_BACKEND_BAD_LIMIT=3
  LOG_MAX_KB=512 SOCKS_PORT=1099 DNS_PORT=1053 ROUTE_SCOPE=all
  ROUTE_SUBNETS=100.64.0.0/10 UID_LIST=
  while IFS= read -r _lc_record; do
    [ -n "${_lc_record}" ] || continue
    # shellcheck disable=SC2163 # fixed-schema KEY=value record, no evaluation
    export "${_lc_record}"
  done <<EOF_CONF_DATA
$1
EOF_CONF_DATA
}

# Read both files under the writer lock, so restore cannot expose a mixed pair.
load_conf() {
  _lc_dir="${1:-${TS_CONF_DIR}}"
  _conf_assign ''
  _lc_locked=0
  if [ "${_CONF_LOCK_HELD:-0}" != 1 ]; then
    conf_lock_acquire || return 1
    _lc_locked=1
  fi
  _lc_data=$(
    for _lc_file in foxytail.conf routes.conf; do
      if [ -e "${_lc_dir}/${_lc_file}" ] || [ -L "${_lc_dir}/${_lc_file}" ]; then
        _conf_parse_file "${_lc_dir}/${_lc_file}" || exit 1
      fi
    done
  )
  _lc_rc=$?
  [ "${_lc_locked}" = 0 ] || conf_lock_release
  [ "${_lc_rc}" = 0 ] || return 1
  _conf_assign "${_lc_data}"
}

# Called under the configuration lock. The pointer is a regular file, replaced
# atomically; consumers never see a half-copied pair of runtime config files.
_conf_runtime_dir() {
  _RUNTIME_CONF_DIR=${TS_CONF_DIR}
  if [ -e "${TS_RUN_DIR}/applied-config" ] || [ -L "${TS_RUN_DIR}/applied-config" ]; then
    [ -f "${TS_RUN_DIR}/applied-config" ] && [ ! -L "${TS_RUN_DIR}/applied-config" ] || return 1
    IFS= read -r _crd_name <"${TS_RUN_DIR}/applied-config" || return 1
    case "${_crd_name}" in *[!A-Za-z0-9._-]*|*..*) return 1 ;; esac
    case "${_crd_name}" in .applied.?*) ;; *) return 1 ;; esac
    _RUNTIME_CONF_DIR="${TS_RUN_DIR}/${_crd_name}"
    [ -d "${_RUNTIME_CONF_DIR}" ] && [ ! -L "${_RUNTIME_CONF_DIR}" ] || return 1
    for _crd_file in foxytail.conf routes.conf context.conf; do
      [ -f "${_RUNTIME_CONF_DIR}/${_crd_file}" ] && [ ! -L "${_RUNTIME_CONF_DIR}/${_crd_file}" ] || return 1
    done
  elif [ -f "${TS_RUN_DIR}/settings.pending" ]; then
    echo 'runtime configuration is unknown; explicitly restart to apply saved settings' >&2
    return 1
  fi
}

# Snapshot files are atomically replaced by their writers. One metadata read
# avoids parsing and creating/removing lock tickets on every resident tick.
# Include high-resolution times and inodes to detect hot applies and edits.
_runtime_conf_stamp() {
  stat -c '%d:%i:%s:%y:%z' "${TS_RUN_DIR}/applied-config" "$1" \
    "$1/foxytail.conf" "$1/routes.conf" "$1/context.conf" 2>/dev/null
}

load_runtime_conf() {
  if [ -n "${_RUNTIME_CONF_STAMP:-}" ] &&
     _lrc_stamp=$(_runtime_conf_stamp "${_RUNTIME_CONF_CACHE_DIR}") &&
     [ "${_lrc_stamp}" = "${_RUNTIME_CONF_STAMP}" ]; then
    _RUNTIME_CONF_DIR=${_RUNTIME_CONF_CACHE_DIR}
    _conf_assign "${_RUNTIME_CONF_DATA}"
    return 0
  fi
  _RUNTIME_CONF_STAMP=
  _lrc_locked=0
  if [ "${_CONF_LOCK_HELD:-0}" != 1 ]; then
    conf_lock_acquire || return 1
    _lrc_locked=1
  fi
  _lrc_rc=0
  _conf_runtime_dir && load_conf "${_RUNTIME_CONF_DIR}" || _lrc_rc=1
  if [ "${_lrc_rc}" = 0 ] && [ "${_RUNTIME_CONF_DIR}" != "${TS_CONF_DIR}" ]; then
    _RUNTIME_CONF_CACHE_DIR=${_RUNTIME_CONF_DIR}
    _RUNTIME_CONF_DATA=${_lc_data}
    _RUNTIME_CONF_STAMP=$(_runtime_conf_stamp "${_RUNTIME_CONF_DIR}") || _RUNTIME_CONF_STAMP=
  fi
  [ "${_lrc_locked}" = 0 ] || conf_lock_release
  return "${_lrc_rc}"
}

# Freeze and validate one candidate before teardown; concurrent saves cannot
# change the configuration that was preflighted. Prints its private directory.
conf_prepare_runtime() (
  conf_lock_acquire || exit 1
  _car_next=
  trap 'if [ -n "${_car_next}" ]; then rm -rf "${_car_next}"; fi; conf_lock_release' 0
  trap 'exit 1' HUP INT TERM
  _car_source_dir="${1:-${TS_CONF_DIR}}"
  load_conf "${_car_source_dir}" || exit 1
  [ "${TS_MODE}" != tun ] || [ "${ROUTE_SCOPE}" = all ] || exit 1
  _car_next=$(mktemp -d "${TS_RUN_DIR}/.applied.XXXXXX") || exit 1
  for _car_file in foxytail.conf routes.conf context.conf; do
    _car_source="${_car_source_dir}/${_car_file}"
    [ ! -L "${_car_source}" ] || exit 1
    if [ -f "${_car_source}" ]; then cp "${_car_source}" "${_car_next}/${_car_file}" || exit 1
    else : >"${_car_next}/${_car_file}"; fi
    chmod 0600 "${_car_next}/${_car_file}" || exit 1
  done
  if [ -x "${TS_SCRIPTS_DIR}/foxytail.context" ]; then
    "${TS_SCRIPTS_DIR}/foxytail.context" validate "${_car_next}/context.conf" || exit 1
  fi
  cat "${TS_RUN_DIR}/settings.pending" >"${_car_next}/revision" 2>/dev/null || :
  printf '%s\n' "${_car_next}"
  _car_next=
)

# Only explicit start/restart publishes a full candidate. Recovery retains it.
conf_activate_runtime() (
  _car_next=${1:-}
  [ -n "${_car_next}" ] || _car_next=$(conf_prepare_runtime "${TS_CONF_DIR}") || exit 1
  case "${_car_next}" in "${TS_RUN_DIR}"/.applied.*) ;; *) exit 1 ;; esac
  [ -d "${_car_next}" ] && [ ! -L "${_car_next}" ] || exit 1
  trap 'rm -f "${TS_RUN_DIR}/.applied-config.$$"; if [ -n "${_car_next}" ]; then rm -rf "${_car_next}"; fi; conf_lock_release' 0
  trap 'exit 1' HUP INT TERM
  conf_lock_acquire || exit 1
  if conf_trial_active && [ "${_TRIAL_ID:-}" != "$(cat "${TS_DIR}/state/config-trial/id")" ]; then
    echo 'configuration trial active; confirm or revert it before applying another configuration' >&2
    exit 1
  fi
  load_conf "${_car_next}" || exit 1
  if [ -e "${TS_RUN_DIR}/applied-config" ] || [ -L "${TS_RUN_DIR}/applied-config" ]; then
    [ -f "${TS_RUN_DIR}/applied-config" ] && [ ! -L "${TS_RUN_DIR}/applied-config" ] || exit 1
  fi
  printf '%s\n' "${_car_next##*/}" >"${TS_RUN_DIR}/.applied-config.$$" &&
    mv -f "${TS_RUN_DIR}/.applied-config.$$" "${TS_RUN_DIR}/applied-config" || exit 1
  _car_current=${_car_next}
  _car_next=
  # A resident may still have its old rules file open. Full reload stops it
  # before activating, which is also the safe opportunity to collect snapshots.
  if ! daemon_pid_alive foxytail.context; then
    for _car_old in "${TS_RUN_DIR}"/.applied.*; do
      [ -d "${_car_old}" ] && [ ! -L "${_car_old}" ] && [ "${_car_old}" != "${_car_current}" ] || continue
      rm -rf "${_car_old}"
    done
  fi
  exit 0
)

# Routing and context have explicit hot-apply commands. Promote only that
# file; never leak an unrelated pending main setting into a live controller.
conf_apply_runtime() {
  case "$1" in routes.conf|context.conf) ;; *) return 1 ;; esac
  _cap_file=$1 _cap_locked=0 _cap_rc=0
  if [ "${_CONF_LOCK_HELD:-0}" != 1 ]; then
    conf_lock_acquire || return 1
    _cap_locked=1
  fi
  if conf_trial_active; then
    [ "${_cap_locked}" = 0 ] || conf_lock_release
    echo 'configuration saved; confirm or revert the active trial before applying it' >&2
    return 1
  fi
  if _conf_runtime_dir; then
    if [ "${_RUNTIME_CONF_DIR}" != "${TS_CONF_DIR}" ]; then
      if [ "${_cap_file}" = routes.conf ]; then
        _cap_main=$(_conf_parse_file "${_RUNTIME_CONF_DIR}/foxytail.conf") || _cap_rc=1
        _cap_routes=$(_conf_parse_file "${TS_CONF_DIR}/routes.conf") || _cap_rc=1
        _cap_mode=$(printf '%s\n' "${_cap_main}" | sed -n 's/^TS_MODE=//p')
        _cap_scope=$(printf '%s\n' "${_cap_routes}" | sed -n 's/^ROUTE_SCOPE=//p')
        if [ "${_cap_mode}" = tun ] && [ "${_cap_scope:-all}" != all ]; then _cap_rc=1; fi
      fi
      if [ "${_cap_rc}" = 0 ]; then
        _cap_tmp="${_RUNTIME_CONF_DIR}/.${_cap_file}.$$"
        cp "${TS_CONF_DIR}/${_cap_file}" "${_cap_tmp}" && chmod 0600 "${_cap_tmp}" &&
          mv -f "${_cap_tmp}" "${_RUNTIME_CONF_DIR}/${_cap_file}" || _cap_rc=1
        rm -f "${_cap_tmp}"
      fi
    fi
  else _cap_rc=1; fi
  [ "${_cap_locked}" = 0 ] || conf_lock_release
  return "${_cap_rc}"
}

conf_trial_active() {
  [ -r "${TS_DIR}/state/config-trial/status" ] &&
    IFS= read -r _cta_state <"${TS_DIR}/state/config-trial/status" || return 1
  case "${_cta_state}" in
    preparing|running|rolling-back|rollback-failed) return 0 ;;
    *) return 1 ;;
  esac
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
