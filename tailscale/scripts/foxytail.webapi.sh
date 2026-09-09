#!/system/bin/sh
# FoxyTail WebAPI
#
# JSON-only backend for the WebUI. Every command prints exactly one JSON
# document to stdout; diagnostics go to stderr / the log file.
#
# Commands (optionally prefix with --request-id <unix-seconds>_<unique-token>):
#   cancel              cancel <request-id>, exact registered child cancellation
#   status              Overall snapshot {daemon,backend,mode,self,exitNode,peers,magicDns,keyExpiry,uptime}.
#                       Reads `tailscale --socket=... status --json` (10s timeout);
#                       returns daemon:"stopped" quickly when the socket is absent.
#   peers               Array of peers {id,hostname,ip,os,relay,online,rxBytes,txBytes,exitNodeOption}
#   exitnodes           Same shape as peers, restricted to ExitNodeOption peers
#   speedtest-exitnodes Ping every exit node, [{id,hostname,ip,latencyMs,ok}] sorted by
#                       latency. Serial `tailscale ping --c=2 --timeout=3s <ip>` per peer;
#                       each probe is individually time-boxed so one dead node
#                       cannot stall the whole run.
#   derp-speedtest      Parse `tailscale netcheck` into {preferred,relays:[{code,latencyMs}]}
#   control             start|stop|restart the daemon via foxytail.service
#   mode-get            {ok,mode}
#   mode-set            mode-set <bridge|tun|proxy> (tun requires /dev/net/tun)
#   exitnode-set        exitnode-set <ip-or-hostname> (tailscale set --exit-node=)
#   exitnode-clear      clear the current exit node
#   tun                 {ifaceUp,gateway,hevPid,mode,socksPort}
#   dns                 {state:running|degraded|stopped,suffix,port}
#   login               start `tailscale login`, capture the auth URL -> {url} | {already:true}.
#                       Optional extra args are appended to `tailscale login` (e.g.
#                       --login-server=...). The CLI process keeps running so the
#                       auth flow can complete after the URL is returned.
#   login-authkey       login-authkey <key> (tailscale login --authkey=, waits for result)
#   logout              tailscale logout
#   accounts            `tailscale switch --list --json` -> {accounts:[{name,id,label,current}]}
#   switch              switch <account-name>
#   serve-list          `tailscale serve status --json` passthrough {ok,status}
#   serve-set           serve-set <proto> <port> <target>
#   serve-del           serve-del <proto> <port> [path]
#   funnel-list         `tailscale funnel status --json` passthrough {ok,status}
#   funnel-set          funnel-set <proto> <port> <target>
#   funnel-del          funnel-del <proto> <port> [path]
#   traffic             traffic hourly [YYYY-MM-DD] | daily | topn [n]
#                       (foxytail.stats query passthrough)
#   traffic-uids        per-UID traffic totals across the retention window {uids:[{uid,rx}]}
#   apps                installed 3rd-party apps [{label,package,uid}].
#                       `pm list packages -3` plus per-package `dumpsys package`
#                       (5s timeout each) for the UID. Label falls back to the
#                       package name: dumpsys only exposes a label resource id,
#                       not the resolved string.
#   routes-get          {scope,uids[],subnets[]}
#   routes-set          routes-set <scope> <csv-uids|-> <csv-subnets|-> :
#                       atomic routes.conf rewrite + reload
#   settings-get        all foxytail.conf keys as JSON
#   settings-set        settings-set <KEY> <value> (whitelisted keys, type-checked values)
#   context-get         {rules:<raw context.conf text>}
#   context-set         context-set <base64> (whole rules file, base64 to dodge escaping)
#   logs                logs daemon|service [lines] -> {lines:[...]} (default 200)
#   compat              compat.json probe result + compat-alert content
#   diag                run foxytail.diag collect -> {ok,path}
#   files-inbox         list $TS_DIR/files -> {files:[{name,size,mtime}]}
#   file-send           file-send <abs-path-under-/sdcard> <peer-hostname>
#   file-receive        pull waiting Taildrop files into $TS_DIR/files
#   backup              tar conf+hooks to /sdcard/Download/foxytail-backup-<ts>.tar.gz -> {ok,path}
#   restore             restore <path-under-/sdcard> (existing conf backed up first;
#                       conf validated line by line, hooks parked as <hook>.restored)
#   key-expiry          {expiring:bool,date} from .Self.KeyExpiry
#
# Failure contract: {"ok":false,"error":"..."} with a non-zero exit code.
# Success documents carry "ok":true as their first field.

# POSIX sh (Android mksh / busybox). No bashisms, no `set -e`.

DIR=$(dirname "$(realpath "$0")")
# shellcheck source=../settings.sh
. "${DIR}/../settings.sh"
load_conf || { printf '%s\n' '{"ok":false,"error":"invalid configuration; inspect the service log"}'; exit 1; }
ensure_run_dirs

TS_SOCKET="${TS_RUN_DIR}/tailscaled.sock"
PID_FILE="${TS_PID_DIR}/tailscaled.pid"
COMPAT_JSON="${TS_RUN_DIR}/compat.json"
COMPAT_ALERT="${TS_RUN_DIR}/compat-alert"
FILES_DIR="${TS_DIR}/files"
TUN_IFACE="tailscale0"

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
  _og_now=$(date +%s)
  _og_last=$(cat "${TS_RUN_DIR}/operations/.gc-last" 2>/dev/null)
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
  [ -r "/proc/$1/stat" ] || return 1
  awk '{sub(/^.*\) /, ""); if($1!="Z") print $20}' "/proc/$1/stat" 2>/dev/null
}

_op_pid_alive() {
  _opa_record="$1"
  [ -f "${_opa_record}" ] || return 1
  IFS=' ' read -r _opa_pid _opa_start <"${_opa_record}"
  case "${_opa_pid}:${_opa_start}" in *[!0-9:]* | :* | *:) return 1 ;; esac
  _opa_now=$(_op_starttime "${_opa_pid}")
  [ -n "${_opa_now}" ] && [ "${_opa_now}" = "${_opa_start}" ] && kill -0 "${_opa_pid}" 2>/dev/null
}

_op_signal() {
  if _op_pid_alive "$1"; then kill "-$2" "${_opa_pid}" 2>/dev/null; fi
}

_op_cancelled() {
  [ -n "${_OP_DIR:-}" ] && [ -f "${_OP_DIR}/cancelled" ]
}

_op_finish() {
  conf_lock_release
  if [ -n "${_OP_DIR:-}" ]; then
    rm -f "${_OP_DIR}/runner"
    : >"${_OP_DIR}/done"
  fi
}

_op_init() {
  _op_valid_id "$1" || jerr 'invalid request ID'
  _op_recent_id "$1" || jerr 'request ID has expired or is from the future'
  mkdir -p "${TS_RUN_DIR}/operations" || jerr 'cannot create operation registry'
  _op_gc
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
}

cmd_cancel() {
  _op_valid_id "$1" || jerr 'invalid request ID'
  _oc_dir="${TS_RUN_DIR}/operations/$1"
  if [ ! -d "${_oc_dir}" ] && ! _op_recent_id "$1"; then
    echo '{"ok":true,"cancelled":true,"expired":true}'; return 0
  fi
  mkdir -p "${_oc_dir}" || jerr 'cannot record cancellation'
  _oc_cmd=$(cat "${_oc_dir}/command" 2>/dev/null)
  case "${_oc_cmd}" in
    control | mode-set | routes-set | settings-set | context-set | restore | backup)
      if _op_pid_alive "${_oc_dir}/runner"; then jerr 'operation is committing changes and cannot be cancelled'; fi ;;
  esac
  : >"${_oc_dir}/cancelled" || jerr 'cannot record cancellation'
  _oc_socket=$(cat "${_oc_dir}/socket" 2>/dev/null)
  [ -z "${_oc_socket}" ] || [ "${_oc_socket}" = "${TS_SOCKET}" ] || jerr 'operation socket mismatch'
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
  _op_cancelled && _op_signal "${_oe_record}" TERM
  (
    sleep "${_oe_seconds}" &
    _oe_sleep=$!
    trap 'kill "${_oe_sleep}" 2>/dev/null; exit 0' TERM INT HUP
    wait "${_oe_sleep}" 2>/dev/null
    if _op_pid_alive "${_oe_record}"; then
      : >"${_oe_timeout}"
      _op_signal "${_oe_record}" TERM
      sleep 1
      _op_signal "${_oe_record}" KILL
    fi
  ) >/dev/null 2>&1 &
  _oe_timer=$!
  wait "${_oe_pid}"
  _oe_rc=$?
  kill "${_oe_timer}" 2>/dev/null
  wait "${_oe_timer}" 2>/dev/null
  [ ! -f "${_oe_timeout}" ] || _oe_rc=124
  rm -f "${_oe_record}" "${_oe_timeout}"
  _op_cancelled && return 130
  return "${_oe_rc}"
}

# Diagnostics are preserved; callers choose whether to capture or suppress them.
ts_cli() {
  _tc_t="$1"
  shift
  _op_exec "${_tc_t}" tailscale --socket="${TS_SOCKET}" "$@"
}

# status --json, empty string on any failure.
ts_status_json() {
  _sj=$(ts_cli 10 status --json)
  if [ -n "${_sj}" ] && printf '%s' "${_sj}" | jqr -e . >/dev/null 2>&1; then
    printf '%s' "${_sj}"
  fi
}

# Daemon liveness: socket + process.
daemon_up() {
  [ -S "${TS_SOCKET}" ] && pidof tailscaled >/dev/null 2>&1
}

# Uptime in seconds, derived from the pid file mtime (0 when unknown).
daemon_uptime() {
  _du_mt=$(stat -c %Y "${PID_FILE}" 2>/dev/null)
  case "${_du_mt}" in '' | *[!0-9]*) echo 0; return ;; esac
  _du_now=$(date +%s)
  [ "${_du_now}" -gt "${_du_mt}" ] && echo $((_du_now - _du_mt)) || echo 0
}

# CSV (or "-") -> JSON array of non-empty trimmed items. Rejects anything
# containing shell-dangerous characters as a second line of defense.
csv_to_json() {
  [ "$1" = "-" ] && { echo '[]'; return 0; }
  printf '%s' "$1" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$' |
    jqr -R -s -c 'split("\n") | map(select(length > 0))'
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

# --- status / peers -----------------------------------------------------------

cmd_status() {
  if ! daemon_up; then
    jqr -n -c --arg mode "${TS_MODE}" \
      '{ok:true,daemon:"stopped",backend:"-",mode:$mode,self:null,exitNode:null,peers:{online:0,offline:0},magicDns:false,keyExpiry:null,uptime:0}'
    return 0
  fi
  _cs_st=$(ts_status_json)
  if [ -z "${_cs_st}" ]; then
    jqr -n -c --arg mode "${TS_MODE}" \
      '{ok:true,daemon:"stopped",backend:"unreachable",mode:$mode,self:null,exitNode:null,peers:{online:0,offline:0},magicDns:false,keyExpiry:null,uptime:0}'
    return 0
  fi
  _cs_up=$(daemon_uptime)
  printf '%s' "${_cs_st}" | jqr -c --arg mode "${TS_MODE}" --argjson uptime "${_cs_up}" '
    (.Peer // {} | to_entries | map(.value)) as $peers
    | (.ExitNodeStatus // null) as $en
    | {
        ok: true,
        daemon: "running",
        backend: (.BackendState // "unknown"),
        mode: $mode,
        self: (.Self // {} | {
          hostname: (.HostName // "-"),
          ips: (.TailscaleIPs // []),
          relay: (.Relay // "-")
        }),
        exitNode: (if $en == null or ($en.ID // "") == "" then null else
          (($peers | map(select(.ID == $en.ID)) | .[0] // {})) as $p |
          {
            id: ($en.ID // ""),
            hostname: ($p.HostName // "-"),
            ip: ((($en.TailscaleIPs // [])[0]) // (($p.TailscaleIPs // [])[0]) // "-"),
            online: ($en.Online // $p.Online // false),
            rx: ($p.RxBytes // 0),
            tx: ($p.TxBytes // 0)
          } end),
        peers: {
          online: ($peers | map(select(.Online == true)) | length),
          offline: ($peers | map(select(.Online != true)) | length)
        },
        magicDns: (.CurrentTailnet.MagicDNSEnabled // false),
        keyExpiry: (.Self.KeyExpiry // null),
        uptime: $uptime
      }'
}

_peers_jq='
  [.Peer // {} | to_entries[] | .value
   | {
       id: (.ID // ""),
       hostname: (.HostName // "-"),
       ip: ((.TailscaleIPs // [])[0] // "-"),
       os: (.OS // "-"),
       relay: (.Relay // "-"),
       online: (.Online // false),
       rxBytes: (.RxBytes // 0),
       txBytes: (.TxBytes // 0),
       exitNodeOption: (.ExitNodeOption // false)
     }]'

cmd_peers() {
  daemon_up || { echo '{"ok":true,"peers":[]}'; return 0; }
  _cp_st=$(ts_status_json)
  [ -n "${_cp_st}" ] || { echo '{"ok":true,"peers":[]}'; return 0; }
  printf '%s' "${_cp_st}" | jqr -c "${_peers_jq} | {ok:true, peers:.}"
}

cmd_exitnodes() {
  daemon_up || { echo '{"ok":true,"peers":[]}'; return 0; }
  _ce_st=$(ts_status_json)
  [ -n "${_ce_st}" ] || { echo '{"ok":true,"peers":[]}'; return 0; }
  printf '%s' "${_ce_st}" | jqr -c \
    "${_peers_jq} | map(select(.exitNodeOption == true)) | {ok:true, peers:.}"
}

cmd_speedtest_exitnodes() {
  daemon_up || jerr "tailscaled is not running"
  _se_st=$(ts_status_json)
  [ -n "${_se_st}" ] || jerr "cannot reach tailscaled status"
  _se_list=$(printf '%s' "${_se_st}" | jqr -r \
    '.Peer // {} | to_entries[] | .value | select(.ExitNodeOption == true)
     | [(.TailscaleIPs // [])[0] // "", .HostName // "-", .ID // ""] | @tsv')
  _se_out=""
  printf '%s\n' "${_se_list}" | while IFS="$(printf '\t')" read -r _se_ip _se_host _se_id; do
    _op_cancelled && break
    [ -n "${_se_ip}" ] || continue
    _se_ms=""
    _se_ping=$(ts_cli 8 ping --c=2 --timeout=3s "${_se_ip}" </dev/null)
    if [ -n "${_se_ping}" ]; then
      # pong lines end with "in 12ms"; take the best (minimum) sample.
      _se_ms=$(printf '%s\n' "${_se_ping}" | grep -o 'in [0-9.]*ms' |
        grep -o '[0-9.]*' | sort -n | head -n 1)
    fi
    case "${_se_ms}" in
      '' | *[!0-9.]*)
        jqr -n -c --arg id "${_se_id}" --arg h "${_se_host}" --arg ip "${_se_ip}" \
          '{id:$id,hostname:$h,ip:$ip,latencyMs:null,ok:false}'
        ;;
      *)
        # keep integers intact: 12.0 -> 12
        _se_ms_i=$(printf '%s' "${_se_ms}" | awk '{printf "%d", $1 + 0.5}')
        jqr -n -c --arg id "${_se_id}" --arg h "${_se_host}" --arg ip "${_se_ip}" \
          --argjson ms "${_se_ms_i}" '{id:$id,hostname:$h,ip:$ip,latencyMs:$ms,ok:true}'
        ;;
    esac
  done | jqr -s -c 'sort_by(.latencyMs // 999999) | {ok:true, results:.}'
}

cmd_derp_speedtest() {
  daemon_up || jerr "tailscaled is not running"
  _ds_nc=$(ts_cli 25 netcheck)
  [ -n "${_ds_nc}" ] || jerr "netcheck produced no output"
  # Lines look like: "\t- sin: 11.2ms (Singapore)"
  _ds_relays=$(printf '%s\n' "${_ds_nc}" |
    sed -n 's/.*- \([a-z0-9][a-z0-9-]*\): \([0-9.]*\)ms.*/\1 \2/p' |
    jqr -R -s -c '
      split("\n") | map(select(length > 0) | split(" ")
        | {code: .[0], latencyMs: ((.[1] | tonumber) + 0.5 | floor)})
      | sort_by(.latencyMs)')
  printf '%s' "${_ds_relays}" | jqr -c \
    '{ok:true, preferred: (if length > 0 then .[0].code else null end), relays: .}'
}

# --- control / mode -----------------------------------------------------------

_control_run() {
  if [ "$1" = restart ]; then "${TS_SCRIPTS_DIR}/start.sh" reload
  else "${TS_SCRIPTS_DIR}/foxytail.service" "$1"; fi
}

cmd_control() {
  case "$1" in
    start | stop | restart) ;;
    *) jerr "control: expected start|stop|restart" ;;
  esac
  if _control_run "$1" >>"${TS_RUN_LOG_FILE}" 2>&1; then
    _cc_pending=false
    [ ! -f "${TS_RUN_DIR}/settings.pending" ] || _cc_pending=true
    jqr -n -c --arg a "$1" --argjson p "${_cc_pending}" '{ok:true,action:$a,applied:(if $a=="restart" then ($p|not) else null end),restartRequired:$p}'
  else
    jerr "foxytail.service $1 failed (see ${TS_RUN_LOG_FILE})"
  fi
}

cmd_mode_get() {
  jqr -n -c --arg m "${TS_MODE}" '{ok:true,mode:$m}'
}

cmd_mode_set() {
  case "$1" in
    bridge | tun | proxy) ;;
    *) jerr "mode-set: expected bridge|tun|proxy" ;;
  esac
  if [ "$1" = tun ] && [ "${ROUTE_SCOPE}" != all ]; then
    jerr "native tun supports only route scope all; use bridge for UID routing"
  fi
  if [ "$1" = "tun" ] && [ ! -c /dev/net/tun ]; then
    jerr "tun mode unavailable: /dev/net/tun does not exist on this device"
  fi
  if "${TS_SCRIPTS_DIR}/foxytail.service" mode "$1" >>"${TS_RUN_LOG_FILE}" 2>&1; then
    jqr -n -c --arg m "$1" '{ok:true,mode:$m}'
  else
    jerr "failed to switch mode to $1"
  fi
}

cmd_exitnode_set() {
  [ -n "$1" ] || jerr "exitnode-set: missing node ip/hostname"
  case "$1" in
    *[!A-Za-z0-9._:-]*) jerr "exitnode-set: invalid node identifier" ;;
  esac
  _es_out=$(ts_cli 15 set --exit-node="$1" 2>&1) || jerr "failed to set exit node: ${_es_out}"
  jqr -n -c --arg n "$1" '{ok:true,exitNode:$n}'
}

cmd_exitnode_clear() {
  _ec_out=$(ts_cli 15 set --exit-node= 2>&1) || jerr "failed to clear exit node: ${_ec_out}"
  echo '{"ok":true,"exitNode":null}'
}

# --- tun / dns ----------------------------------------------------------------

cmd_tun() {
  _ct_up=false
  ip link show dev "${TUN_IFACE}" >/dev/null 2>&1 && _ct_up=true
  # tailscale0 has no default route by design (policy routing lives in table
  # ROUTE_TABLE); report the interface's own IPv4 as the gateway instead.
  _ct_gw=$(ip -o -4 addr show dev "${TUN_IFACE}" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
  _ct_hev=$(pids_of_path "${TS_BIN_DIR}/hev-socks5-tunnel")
  _ct_hev_pid=null
  case "${_ct_hev}" in
    '' | *[!0-9\ ]*) ;;
    *)
      # shellcheck disable=SC2086 # intentional: one PID per word
      set -- ${_ct_hev}
      _ct_hev_pid="$1"
      ;;
  esac
  jqr -n -c --argjson up "${_ct_up}" --arg gw "${_ct_gw}" \
    --argjson hev "${_ct_hev_pid}" --arg m "${TS_MODE}" \
    --argjson sp "${SOCKS_PORT}" \
    '{ok:true,ifaceUp:$up,gateway:(if $gw == "" then null else $gw end),hevPid:$hev,mode:$m,socksPort:$sp}'
}

cmd_dns() {
  # State machine lives in foxytail.dns; this is a thin passthrough.
  _cd_out=""
  if [ -x "${TS_SCRIPTS_DIR}/foxytail.dns" ]; then
    _cd_out=$("${TS_SCRIPTS_DIR}/foxytail.dns" status --json 2>/dev/null)
  fi
  if [ -n "${_cd_out}" ] && printf '%s' "${_cd_out}" | jqr -e . >/dev/null 2>&1; then
    # Contract freeze: only the original {ok,state,suffix,port} fields.
    printf '%s' "${_cd_out}" | jqr -c '{ok:true,state:.state,suffix:.suffix,port:.port}'
  else
    jqr -n -c --argjson p "${DNS_PORT}" '{ok:true,state:"stopped",suffix:"",port:$p}'
  fi
}

# --- account ------------------------------------------------------------------

# True when the login CLI output already contains an auth URL or an
# already-logged-in/success marker. Used as a wait_for check by cmd_login.
_login_probe() {
  _op_cancelled && return 0
  [ -f "${_cl_tmp}" ] || return 1
  grep -q 'https://' "${_cl_tmp}" 2>/dev/null && return 0
  grep -qi -e already -e success "${_cl_tmp}" 2>/dev/null
}

cmd_login() {
  if daemon_up; then
    _cl_st=$(ts_status_json)
    if [ -n "${_cl_st}" ] && printf '%s' "${_cl_st}" | jqr -e '.BackendState == "Running"' >/dev/null 2>&1; then
      echo '{"ok":true,"already":true}'
      return 0
    fi
  fi
  _cl_tmp="${TS_RUN_DIR}/webapi-login.$$"
  rm -f "${_cl_tmp}"
  # The CLI blocks until auth completes; keep it alive after we grab the URL.
  ( _op_exec 180 tailscale --socket="${TS_SOCKET}" login "$@"; sleep 25; rm -f "${_cl_tmp}" ) >"${_cl_tmp}" 2>&1 </dev/null &
  if wait_for "login URL" _login_probe 20 1; then
    _op_cancelled && jerr "login cancelled"
    _cl_url=$(grep -o 'https://[^ ]*' "${_cl_tmp}" 2>/dev/null | head -n 1)
    if [ -n "${_cl_url}" ]; then
      jqr -n -c --arg u "${_cl_url}" '{ok:true,url:$u}'
      return 0
    fi
    rm -f "${_cl_tmp}"
    echo '{"ok":true,"already":true}'
    return 0
  fi
  _cl_err=$(tail -n 3 "${_cl_tmp}" 2>/dev/null | tr '\n' ' ')
  rm -f "${_cl_tmp}"
  # Only this request owns its CLI record.
  if [ -n "${_OP_DIR:-}" ]; then
    for _cl_record in "${_OP_DIR}"/child.*; do _op_signal "${_cl_record}" TERM; done
  fi
  _cl_hint=""
  # If the daemon logged a control-plane reachability error, surface it so the
  # user sees *why* the URL never arrived (common cause: proxy/DNS conflict).
  if [ -f "${TS_LOG_FILE}" ]; then
    _cl_last=$(tail -n 1 "${TS_LOG_FILE}" 2>/dev/null)
    case "${_cl_last}" in
      *'controlplane.tailscale.com'*|*'connect: connection'*|*'context deadline exceeded'*)
        _cl_hint=$(printf '%s' "${_cl_last}" | sed 's/^.*Received error: //; s/"$//')
        ;;
    esac
  fi
  jerr "no login URL within 20s${_cl_err:+: ${_cl_err}}${_cl_hint:+ (${_cl_hint})}"
}

cmd_login_authkey() {
  [ -n "$1" ] || jerr "login-authkey: missing key"
  case "$1" in
    *[!A-Za-z0-9._-]*) jerr "login-authkey: invalid characters in key" ;;
  esac
  _la_out=$(ts_cli 60 login --authkey="$1" 2>&1)
  if [ $? -eq 0 ]; then
    echo '{"ok":true,"loggedIn":true}'
  else
    jerr "authkey login failed: ${_la_out:-timeout}"
  fi
}

cmd_logout() {
  daemon_up || jerr "tailscaled is not running"
  _lo_out=$(ts_cli 30 logout 2>&1)
  if [ $? -eq 0 ]; then
    echo '{"ok":true}'
  else
    jerr "logout failed: ${_lo_out:-timeout}"
  fi
}

cmd_accounts() {
  daemon_up || jerr "tailscaled is not running"
  _ac_list=$(ts_cli 15 switch --list --json 2>&1) || jerr "account list failed: ${_ac_list}"
  printf '%s' "${_ac_list}" | jqr -e 'type == "array"' >/dev/null 2>&1 || jerr "account list did not return a JSON array"
  printf '%s' "${_ac_list}" | jqr -c '{ok:true,accounts:map({
    name:.id, id:.id, current:(.selected // false),
    label:(.nickname // .account // .id), tailnet:(.tailnet // "")
  })}'
}

cmd_switch() {
  [ -n "$1" ] || jerr "switch: missing account name"
  _sw_out=$(ts_cli 30 switch "$1" 2>&1)
  if [ $? -eq 0 ]; then
    jqr -n -c --arg a "$1" '{ok:true,account:$a}'
  else
    jerr "switch failed: ${_sw_out:-timeout}"
  fi
}

# --- serve / funnel -----------------------------------------------------------

_serve_list() {
  _sl_kind="$1"
  _sl_out=$(ts_cli 15 "${_sl_kind}" status --json 2>&1)
  if [ $? -ne 0 ] || [ -z "${_sl_out}" ]; then
    # Older binaries may not support --json for status; degrade gracefully.
    jerr "${_sl_kind} status unavailable: ${_sl_out:-timeout}"
  fi
  if ! printf '%s' "${_sl_out}" | jqr -e . >/dev/null 2>&1; then
    jerr "${_sl_kind} status did not return JSON (command unsupported?)"
  fi
  printf '%s' "${_sl_out}" | jqr -c '{ok:true,status:.}'
}

_serve_set() {
  _ss_kind="$1"
  _ss_proto="$2"
  _ss_port="$3"
  _ss_target="$4"
  case "${_ss_proto}" in
    http | https | tcp | tls-terminated-tcp) ;;
    *) jerr "invalid proto: ${_ss_proto:-<empty>} (http|https|tcp|tls-terminated-tcp)" ;;
  esac
  case "${_ss_port}" in
    '' | *[!0-9]*) jerr "invalid port: ${_ss_port:-<empty>}" ;;
  esac
  _num_in_range "${_ss_port}" 1 65535 || jerr "invalid port"
  [ -n "${_ss_target}" ] || jerr "missing target"
  _ss_out=$(ts_cli 25 "${_ss_kind}" --bg --"${_ss_proto}=${_ss_port}" "${_ss_target}" 2>&1)
  if [ $? -eq 0 ]; then
    jqr -n -c --arg k "${_ss_kind}" --arg p "${_ss_proto}" --argjson port "${_ss_port}" \
      '{ok:true,kind:$k,proto:$p,port:$port}'
  else
    jerr "${_ss_kind} set failed: ${_ss_out:-timeout}"
  fi
}

_serve_del() {
  _sd_kind="$1"
  _sd_proto="$2"
  _sd_port="$3"
  _sd_path="${4:-}"
  case "${_sd_proto}" in
    http | https | tcp | tls-terminated-tcp) ;;
    *) jerr "invalid proto: ${_sd_proto:-<empty>}" ;;
  esac
  case "${_sd_port}" in
    '' | *[!0-9]*) jerr "invalid port: ${_sd_port:-<empty>}" ;;
  esac
  _num_in_range "${_sd_port}" 1 65535 || jerr "invalid port"
  if [ -n "${_sd_path}" ]; then
    case "${_sd_proto}:${_sd_path}" in http:/* | https:/*) ;; *) jerr 'path applies only to HTTP(S) handlers and must start with /' ;; esac
    printf '%s' "${_sd_path}" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null && jerr 'invalid path'
    _sd_out=$(ts_cli 25 "${_sd_kind}" --bg --"${_sd_proto}=${_sd_port}" --set-path="${_sd_path}" off 2>&1)
  else
    _sd_out=$(ts_cli 25 "${_sd_kind}" --bg --"${_sd_proto}=${_sd_port}" off 2>&1)
  fi
  if [ $? -eq 0 ]; then
    jqr -n -c --arg k "${_sd_kind}" --arg p "${_sd_proto}" --argjson port "${_sd_port}" \
      '{ok:true,kind:$k,proto:$p,port:$port,deleted:true}'
  else
    jerr "${_sd_kind} delete failed: ${_sd_out:-timeout}"
  fi
}

# --- traffic / apps -----------------------------------------------------------

cmd_traffic() {
  case "$1" in
    hourly)
      _tr_date="$2"
      case "${_tr_date}" in
        '' | *[!0-9-]*) _tr_date=$(date +%F) ;;
      esac
      _tr_out=$("${TS_SCRIPTS_DIR}/foxytail.stats" query hourly "${_tr_date}" 2>/dev/null)
      ;;
    daily)
      _tr_out=$("${TS_SCRIPTS_DIR}/foxytail.stats" query daily 2>/dev/null)
      ;;
    topn)
      _tr_n="$2"
      case "${_tr_n}" in '' | *[!0-9]*) _tr_n=10 ;; esac
      _tr_out=$("${TS_SCRIPTS_DIR}/foxytail.stats" query topn "${_tr_n}" 2>/dev/null)
      ;;
    *)
      jerr "traffic: expected hourly|daily|topn"
      ;;
  esac
  if [ -n "${_tr_out}" ] && printf '%s' "${_tr_out}" | jqr -e . >/dev/null 2>&1; then
    printf '%s' "${_tr_out}" | jqr -c '. + {ok:true}'
  else
    jerr "stats query failed (collector not running?)"
  fi
}

cmd_traffic_uids() {
  _tu_out=$("${TS_SCRIPTS_DIR}/foxytail.stats" query uids 100000 2>/dev/null) || jerr "UID stats query failed"
  printf '%s' "${_tu_out}" | jqr -e . >/dev/null 2>&1 || jerr "UID stats query returned invalid JSON"
  printf '%s' "${_tu_out}" | jqr -c '. + {ok:true}'
}

cmd_apps() {
  # Fast path: `pm list packages -3 -U` prints "package:<name> uid:<uid>" for
  # every app in a single binder call (Android 10+). The old per-package
  # dumpsys loop took minutes on devices with many apps.
  _ap_list=$(timeout 30 pm list packages -3 -U 2>/dev/null | tr -d '\r')
  if printf '%s' "${_ap_list}" | grep -q ' uid:[0-9]'; then
    printf '%s\n' "${_ap_list}" | sed -n 's/^package:\([^ ]*\) uid:\([0-9]*\).*/\1 \2/p' |
      while IFS=' ' read -r _ap_pkg _ap_uid; do
        [ -n "${_ap_pkg}" ] || continue
        # dumpsys exposes only labelRes (a resource id), never the resolved
        # label string; without aapt the package name is the best label.
        jqr -n -c --arg l "${_ap_pkg}" --arg p "${_ap_pkg}" --argjson u "${_ap_uid:-0}" \
          '{label:$l,package:$p,uid:$u}'
      done | jqr -s -c 'sort_by(.package) | {ok:true,apps:.}'
    return 0
  fi
  # Fallback for ancient pm without -U: per-package dumpsys loop.
  _ap_pkgs=$(timeout 30 pm list packages -3 2>/dev/null | sed 's/^package://' | tr -d '\r' | sort)
  if [ -z "${_ap_pkgs}" ]; then
    echo '{"ok":true,"apps":[]}'
    return 0
  fi
  printf '%s\n' "${_ap_pkgs}" | while IFS= read -r _ap_pkg; do
    [ -n "${_ap_pkg}" ] || continue
    _ap_uid=""
    _ap_dump=$(timeout 5 dumpsys package "${_ap_pkg}" </dev/null 2>/dev/null)
    if [ -n "${_ap_dump}" ]; then
      _ap_uid=$(printf '%s\n' "${_ap_dump}" | grep -o -m1 'userId=[0-9]*' | head -n 1 | cut -d= -f2)
      [ -n "${_ap_uid}" ] || _ap_uid=$(printf '%s\n' "${_ap_dump}" | grep -o -m1 'appId=[0-9]*' | head -n 1 | cut -d= -f2)
    fi
    case "${_ap_uid}" in '' | *[!0-9]*) _ap_uid=0 ;; esac
    # dumpsys exposes only labelRes (a resource id), never the resolved label
    # string; without aapt the package name is the best available label.
    jqr -n -c --arg l "${_ap_pkg}" --arg p "${_ap_pkg}" --argjson u "${_ap_uid}" \
      '{label:$l,package:$p,uid:$u}'
  done | jqr -s -c '{ok:true,apps:.}'
}

# --- routes.conf --------------------------------------------------------------

cmd_routes_get() {
  _rg_uids=$(printf '%s' "${UID_LIST}" | tr ' ' '\n' | grep -v '^$' |
    jqr -R -s -c 'split("\n") | map(select(length > 0))')
  _rg_subs=$(printf '%s' "${ROUTE_SUBNETS}" | tr ' ' '\n' | grep -v '^$' |
    jqr -R -s -c 'split("\n") | map(select(length > 0))')
  jqr -n -c --arg s "${ROUTE_SCOPE}" --argjson u "${_rg_uids}" --argjson n "${_rg_subs}" \
    '{ok:true,scope:$s,uids:$u,subnets:$n}'
}

cmd_routes_set() {
  _rs_scope="$1"
  _rs_uids=$(csv_to_json "$2")
  _rs_subs=$(csv_to_json "$3")
  _rs_uid_list=$(printf '%s' "${_rs_uids}" | jqr -r 'join(" ")')
  _rs_sub_list=$(printf '%s' "${_rs_subs}" | jqr -r 'join(" ")')
  for _rs_key in ROUTE_SCOPE UID_LIST ROUTE_SUBNETS; do
    case "${_rs_key}" in ROUTE_SCOPE) _rs_value=${_rs_scope} ;; UID_LIST) _rs_value=${_rs_uid_list} ;; *) _rs_value=${_rs_sub_list} ;; esac
    _rs_why=$(_conf_value_error "${_rs_key}" "${_rs_value}") || jerr "routes-set: ${_rs_why}"
  done
  conf_lock_acquire || jerr 'routes-set: configuration is busy'
  load_conf || { conf_lock_release; jerr 'routes-set: invalid current configuration'; }
  if [ "${TS_MODE}" = tun ] && [ "${_rs_scope}" != all ]; then
    conf_lock_release
    jerr 'native tun supports only route scope all; use bridge for UID routing'
  fi
  _rs_tmp="${TS_CONF_DIR}/.routes.conf.$$"
  if ! {
    printf '# FoxyTail routing configuration.\nROUTE_SCOPE=%s\nUID_LIST="%s"\nROUTE_SUBNETS="%s"\n' "${_rs_scope}" "${_rs_uid_list}" "${_rs_sub_list}" >"${_rs_tmp}" &&
    chmod 0600 "${_rs_tmp}" && mv "${_rs_tmp}" "${TS_CONF_DIR}/routes.conf"
  }; then
    rm -f "${_rs_tmp}"; conf_lock_release; jerr 'routes-set: cannot replace routes.conf'
  fi
  conf_mark_pending || { conf_lock_release; jerr "could not record pending configuration"; }
  conf_lock_release
  _rs_applied=false
  _rs_note='saved; routing will apply when the tunnel is ready'
  if ip link show dev "${TUN_IFACE}" >/dev/null 2>&1; then
    if "${TS_SCRIPTS_DIR}/foxytail.route" reload >>"${TS_RUN_LOG_FILE}" 2>&1; then
      _rs_applied=true; _rs_note='saved and applied'
    else _rs_note='saved, but routing reload failed; inspect the service log'; fi
  fi
  jqr -n -c --arg n "${_rs_note}" --argjson a "${_rs_applied}" '{ok:true,saved:true,applied:$a,restartRequired:($a|not),note:$n}'
}

# --- settings (foxytail.conf) --------------------------------------------------

# All values come from the runtime parser, including defaults and migrations.
cmd_settings_get() {
  _sg_pending=false
  [ ! -f "${TS_RUN_DIR}/settings.pending" ] || _sg_pending=true
  _conf_keys foxytail.conf | while IFS= read -r _sg_key; do
    # Explicit cases read only schema keys, including runtime defaults.
    case "${_sg_key}" in
      TS_MODE) _sg_val=$TS_MODE ;; SOCKS_PORT) _sg_val=$SOCKS_PORT ;; DNS_PORT) _sg_val=$DNS_PORT ;;
      MAGIC_DNS) _sg_val=$MAGIC_DNS ;; IPV6) _sg_val=$IPV6 ;; ROUTE_TABLE) _sg_val=$ROUTE_TABLE ;;
      FWMARK) _sg_val=$FWMARK ;; FWMARK_MASK) _sg_val=$FWMARK_MASK ;; WATCHDOG) _sg_val=$WATCHDOG ;;
      WATCHDOG_INTERVAL) _sg_val=$WATCHDOG_INTERVAL ;; STATS_INTERVAL) _sg_val=$STATS_INTERVAL ;; LOG_MAX_KB) _sg_val=$LOG_MAX_KB ;;
    esac
    jqr -n -c --arg k "${_sg_key}" --arg v "${_sg_val}" '{key:$k,value:$v}'
  done | jqr -s -c --argjson p "${_sg_pending}" '{ok:true,settings:from_entries,restartRequired:$p}'
}

cmd_settings_set() {
  [ -n "$1" ] || jerr 'settings-set: missing key'
  [ "$1" != TS_MODE ] || jerr 'TS_MODE must be changed with mode-set'
  _sk_why=$(conf_write_key foxytail.conf "$1" "$2" 2>&1) || jerr "settings-set: ${_sk_why}"
  jqr -n -c --arg k "$1" --arg v "$2" '{ok:true,key:$k,value:$v,saved:true,applied:false,restartRequired:true,requiresRestart:true}'
}

# --- context rules -------------------------------------------------------------

cmd_context_get() {
  if [ -f "${TS_CONF_DIR}/context.conf" ]; then
    jqr -R -s -c '{ok:true,rules:.}' "${TS_CONF_DIR}/context.conf"
  else
    echo '{"ok":true,"rules":""}'
  fi
}

cmd_context_set() {
  [ -n "$1" ] || jerr "context-set: missing base64 payload"
  conf_lock_acquire || jerr "context-set: configuration is busy"
  _cx_tmp="${TS_CONF_DIR}/.context.conf.$$"
  mkdir -p "${TS_CONF_DIR}"
  if ! printf '%s' "$1" | base64 -d >"${_cx_tmp}" 2>/dev/null; then
    rm -f "${_cx_tmp}"
    conf_lock_release
    jerr "context-set: invalid base64"
  fi
  mv "${_cx_tmp}" "${TS_CONF_DIR}/context.conf" || { rm -f "${_cx_tmp}"; conf_lock_release; jerr "context-set: replace failed"; }
  conf_mark_pending || { conf_lock_release; jerr "context-set: cannot record pending configuration"; }
  conf_lock_release
  # Restart the context watcher so the new rules take effect.
  if [ -x "${TS_SCRIPTS_DIR}/foxytail.context" ]; then
    "${TS_SCRIPTS_DIR}/foxytail.context" stop >>"${TS_RUN_LOG_FILE}" 2>&1
    "${TS_SCRIPTS_DIR}/foxytail.context" start >>"${TS_RUN_LOG_FILE}" 2>&1 &
  fi
  echo '{"ok":true}'
}

# --- logs ----------------------------------------------------------------------

cmd_logs() {
  _lg_lines="$2"
  case "${_lg_lines}" in '' | *[!0-9]*) _lg_lines=200 ;; esac
  case "$1" in
    daemon) _lg_file="${TS_LOG_FILE}" ;;
    service) _lg_file="${TS_RUN_LOG_FILE}" ;;
    *) jerr "logs: expected daemon|service" ;;
  esac
  if [ ! -f "${_lg_file}" ]; then
    jqr -n -c '{ok:true,lines:[]}'
    return 0
  fi
  tail -n "${_lg_lines}" "${_lg_file}" 2>/dev/null |
    _sanitize_text |
    jqr -R -s -c 'split("\n") | map(select(length > 0)) | {ok:true,lines:.}'
}

# --- compat / diag ---------------------------------------------------------------

cmd_compat() {
  _cm_json=""
  if [ -f "${COMPAT_JSON}" ] && jqr -e . "${COMPAT_JSON}" >/dev/null 2>&1; then
    _cm_json=$(cat "${COMPAT_JSON}")
  elif [ -x "${TS_SCRIPTS_DIR}/foxytail.compat" ]; then
    _cm_json=$(timeout 30 "${TS_SCRIPTS_DIR}/foxytail.compat" probe 2>/dev/null)
  fi
  if [ -z "${_cm_json}" ] || ! printf '%s' "${_cm_json}" | jqr -e . >/dev/null 2>&1; then
    _cm_json='{"modules":[],"apps":[],"warnings":[]}'
  fi
  _cm_alert=""
  [ -f "${COMPAT_ALERT}" ] && _cm_alert=$(cat "${COMPAT_ALERT}")
  printf '%s' "${_cm_json}" | jqr -c --arg a "${_cm_alert}" \
    '. + {ok:true, alert:(if $a == "" then null else $a end)}'
}

cmd_diag() {
  [ -x "${TS_SCRIPTS_DIR}/foxytail.diag" ] || jerr "foxytail.diag not found"
  _dg_out=$(timeout 120 "${TS_SCRIPTS_DIR}/foxytail.diag" collect 2>/dev/null)
  _dg_path=$(printf '%s\n' "${_dg_out}" | tail -n 1 | tr -d ' ')
  if [ -n "${_dg_path}" ] && [ -f "${_dg_path}" ]; then
    jqr -n -c --arg p "${_dg_path}" '{ok:true,path:$p}'
  else
    jerr "diag collection failed (see ${TS_RUN_LOG_FILE})"
  fi
}

# --- taildrop files ---------------------------------------------------------------

cmd_files_inbox() {
  mkdir -p "${FILES_DIR}" 2>/dev/null
  ls -A "${FILES_DIR}" 2>/dev/null | while IFS= read -r _fi_name; do
    _fi_path="${FILES_DIR}/${_fi_name}"
    [ -f "${_fi_path}" ] || continue
    _fi_size=$(stat -c %s "${_fi_path}" 2>/dev/null)
    _fi_mtime=$(stat -c %Y "${_fi_path}" 2>/dev/null)
    case "${_fi_size}" in '' | *[!0-9]*) _fi_size=0 ;; esac
    case "${_fi_mtime}" in '' | *[!0-9]*) _fi_mtime=0 ;; esac
    _fi_name=$(printf '%s' "${_fi_name}" | _sanitize_text)
    jqr -n -c --arg n "${_fi_name}" --argjson s "${_fi_size}" --argjson m "${_fi_mtime}" \
      '{name:$n,size:$s,mtime:$m}'
  done | jqr -s -c 'sort_by(-.mtime) | {ok:true,files:.}'
}

cmd_file_send() {
  [ -n "$1" ] && [ -n "$2" ] || jerr "file-send: expected <path> <peer>"
  # /sdcard is a symlink to /storage/emulated/0 on Android: validate the raw
  # input first, then require the resolved path to stay in shared storage.
  case "$1" in
    /sdcard/*) ;;
    *) jerr "file-send: path must live under /sdcard/" ;;
  esac
  _fs_path=$(realpath "$1" 2>/dev/null)
  case "${_fs_path}" in
    /sdcard/* | /storage/emulated/*) ;;
    *) jerr "file-send: path must live under /sdcard/" ;;
  esac
  [ -f "${_fs_path}" ] || jerr "file-send: no such file: ${_fs_path}"
  case "$2" in
    *[!A-Za-z0-9._-]*) jerr "file-send: invalid peer name" ;;
  esac
  _fs_out=$(ts_cli 300 file cp "${_fs_path}" "$2:" 2>&1)
  if [ $? -eq 0 ]; then
    jqr -n -c --arg p "${_fs_path}" --arg t "$2" '{ok:true,path:$p,peer:$t}'
  else
    jerr "file-send failed: ${_fs_out:-timeout}"
  fi
}

cmd_file_receive() {
  mkdir -p "${FILES_DIR}" 2>/dev/null
  _fr_out=$(ts_cli 60 file get --wait=false "${FILES_DIR}/" 2>&1)
  if [ $? -ne 0 ]; then
    # Older CLI without --wait flag: plain get under a timeout.
    _fr_out=$(ts_cli 60 file get "${FILES_DIR}/" 2>&1)
    [ $? -eq 0 ] || jerr "file-receive failed: ${_fr_out:-timeout}"
  fi
  echo '{"ok":true}'
}

# --- backup / restore ---------------------------------------------------------------

cmd_backup() (
  conf_lock_acquire || jerr 'backup: configuration is busy'
  _bk_ts="$(date +%Y%m%d-%H%M%S)-$$"
  _bk_out="/sdcard/Download/foxytail-backup-${_bk_ts}.tar.gz"
  _bk_tmp="${_bk_out}.partial"
  trap 'rm -f "${_bk_tmp}"; conf_lock_release' 0
  trap 'exit 1' HUP INT TERM
  mkdir -p /sdcard/Download || jerr 'backup: cannot create Download directory'
  set --
  for _bk_h in foxytail.tun.up foxytail.tun.down; do
    [ ! -f "${TS_SCRIPTS_DIR}/${_bk_h}" ] || set -- "$@" "${_bk_h}"
  done
  if ! tar -czf "${_bk_tmp}" -C "${TS_DIR}" conf -C "${TS_SCRIPTS_DIR}" "$@" 2>/dev/null ||
     ! tar -tzf "${_bk_tmp}" >/dev/null 2>&1 ||
     ! mv "${_bk_tmp}" "${_bk_out}"; then
    jerr 'backup failed; incomplete archive was removed'
  fi
  jqr -n -c --arg p "${_bk_out}" '{ok:true,path:$p}'
)

# Validate member paths and entry types before extraction. In particular, a
# symlink earlier in an archive must never redirect a later extraction outside
# the staging directory. Hard links and special device entries are disallowed.
_restore_archive_safe() {
  tar -tzf "$1" >"$2/members" 2>/dev/null || return 1
  while IFS= read -r _ras_member; do
    case "${_ras_member}" in
      '' | /* | .. | ../* | */../* | */.. | -* | *\\*) return 1 ;;
    esac
  done <"$2/members"
  tar -tvzf "$1" >"$2/types" 2>/dev/null || return 1
  LC_ALL=C awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {exit 1}' "$2/types"
}

_restore_cleanup() {
  if [ "${_rt_committed:-0}" != 1 ] && [ "${_rt_swapped:-0}" = 1 ]; then
    if rm -rf "${TS_CONF_DIR}" && [ ! -e "${TS_CONF_DIR}" ] && [ ! -L "${TS_CONF_DIR}" ]; then
      if [ "${_rt_moved:-0}" = 1 ]; then
        mv "${_rt_old}" "${TS_CONF_DIR}" || echo "restore rollback failed: previous configuration retained at ${_rt_old}" >&2
      fi
    else
      echo "restore rollback could not remove the replacement; previous configuration retained at ${_rt_old}" >&2
    fi
  elif [ "${_rt_committed:-0}" != 1 ] && [ "${_rt_moved:-0}" = 1 ]; then
    if [ ! -e "${TS_CONF_DIR}" ] && [ ! -L "${TS_CONF_DIR}" ]; then
      mv "${_rt_old}" "${TS_CONF_DIR}" || echo "restore rollback failed: previous configuration retained at ${_rt_old}" >&2
    else
      echo "restore rollback destination is occupied; previous configuration retained at ${_rt_old}" >&2
    fi
  fi
  [ "${_rt_committed:-0}" = 1 ] || [ -z "${_rt_parked:-}" ] || rm -rf "${_rt_parked}"
  [ -z "${_rt_tmp:-}" ] || rm -rf "${_rt_tmp}"
  conf_lock_release
}

cmd_restore() (
  [ ! -f "${TS_DIR}/.installing" ] || jerr 'restore: an upgrade is in progress'
  [ -n "$1" ] || jerr 'restore: missing path'
  case "$1" in /sdcard/*.tar.gz) ;; *) jerr 'restore: expected .tar.gz under /sdcard/' ;; esac
  _rt_path=$(realpath "$1" 2>/dev/null)
  case "${_rt_path}" in /sdcard/*.tar.gz | /storage/emulated/*.tar.gz) ;; *) jerr 'restore: archive must resolve under shared storage' ;; esac
  [ -f "${_rt_path}" ] || jerr 'restore: archive does not exist'
  _rt_tmp=$(mktemp -d "${TS_DIR}/.restore.XXXXXX") || jerr 'restore: cannot create staging directory'
  trap '_restore_cleanup' 0
  trap 'exit 1' HUP INT TERM
  mkdir "${_rt_tmp}/archive" "${_rt_tmp}/next" || jerr 'restore: staging failed'
  _rt_input="${_rt_tmp}/input.tar.gz"
  cat "${_rt_path}" >"${_rt_input}" && chmod 0600 "${_rt_input}" || jerr 'restore: cannot stage archive'
  _restore_archive_safe "${_rt_input}" "${_rt_tmp}" || jerr 'restore: unsafe or damaged archive'
  tar --no-same-owner -xzf "${_rt_input}" -C "${_rt_tmp}/archive" 2>/dev/null || jerr 'restore: archive extraction failed'
  _rt_src="${_rt_tmp}/archive"
  if [ ! -d "${_rt_src}/conf" ]; then
    for _rt_d in "${_rt_src}"/*/; do
      [ ! -d "${_rt_d}conf" ] || { _rt_src="${_rt_d%/}"; break; }
    done
  fi
  [ -d "${_rt_src}/conf" ] && [ ! -L "${_rt_src}/conf" ] || jerr 'restore: missing conf directory'
  # Validate every incoming entry before touching live configuration.
  for _rt_f in "${_rt_src}/conf/"*; do
    [ -e "${_rt_f}" ] || continue
    [ -f "${_rt_f}" ] && [ ! -L "${_rt_f}" ] || jerr 'restore: conf may contain only regular files'
    case "${_rt_f##*/}" in
      foxytail.conf | routes.conf)
        _rt_why=$(_conf_file_error "${_rt_f}") || jerr "restore: ${_rt_why}" ;;
      context.conf) ;;
      *) jerr "restore: unknown configuration file ${_rt_f##*/}" ;;
    esac
  done
  conf_lock_acquire || jerr 'restore: configuration is busy'
  [ ! -f "${TS_DIR}/.installing" ] || jerr 'restore: an upgrade is in progress'
  # Prepare a complete replacement on the same filesystem. Any copy failure
  # aborts before the first live rename; archive ownership/modes are discarded.
  for _rt_f in foxytail.conf routes.conf context.conf; do
    if [ -f "${_rt_src}/conf/${_rt_f}" ]; then _rt_from="${_rt_src}/conf/${_rt_f}"
    elif [ -f "${TS_CONF_DIR}/${_rt_f}" ]; then _rt_from="${TS_CONF_DIR}/${_rt_f}"
    else continue; fi
    cat "${_rt_from}" >"${_rt_tmp}/next/${_rt_f}" && chmod 0600 "${_rt_tmp}/next/${_rt_f}" || jerr 'restore: cannot prepare configuration'
  done
  if ! ( TS_CONF_DIR="${_rt_tmp}/next"; load_conf && { [ "$TS_MODE" != tun ] || [ "$ROUTE_SCOPE" = all ]; } ); then
    jerr 'restore: invalid configuration or native tun UID routing is unsupported'
  fi
  _rt_ts="$(date +%Y%m%d-%H%M%S)-$$"
  _rt_old="${TS_DIR}/conf.bak-${_rt_ts}"
  _rt_note=''
  # Restored hooks stay in a separate review directory, never executable and
  # never overwrite a live hook or an earlier review copy.
  for _rt_h in foxytail.tun.up foxytail.tun.down; do
    if [ -f "${_rt_src}/${_rt_h}" ]; then
      _rt_parked="${TS_DIR}/restored-hooks-${_rt_ts}"
      mkdir -p "${_rt_parked}" || jerr 'restore: cannot prepare hook review directory'
      cat "${_rt_src}/${_rt_h}" >"${_rt_parked}/${_rt_h}.restored" && chmod 0600 "${_rt_parked}/${_rt_h}.restored" || jerr 'restore: cannot park hook'
      _rt_note="hooks parked for review in ${_rt_parked}"
    fi
  done
  if [ -d "${TS_CONF_DIR}" ]; then
    mv "${TS_CONF_DIR}" "${_rt_old}" || jerr 'restore: cannot retain previous configuration'
    _rt_moved=1
  fi
  mv "${_rt_tmp}/next" "${TS_CONF_DIR}" || jerr 'restore: cannot activate configuration; rolling back'
  _rt_swapped=1
  conf_mark_pending || jerr 'restore: cannot record pending configuration; rolling back'
  _rt_committed=1
  conf_lock_release
  jqr -n -c --arg b "${_rt_old}" --arg n "${_rt_note}" '{ok:true,previous:$b,saved:true,applied:false,restartRequired:true,note:(if $n=="" then null else $n end)}'
)

# --- key expiry --------------------------------------------------------------------

cmd_key_expiry() {
  daemon_up || { echo '{"ok":true,"expiring":false,"date":null}'; return 0; }
  _ke_st=$(ts_status_json)
  [ -n "${_ke_st}" ] || { echo '{"ok":true,"expiring":false,"date":null}'; return 0; }
  printf '%s' "${_ke_st}" | jqr -c '
    (.Self.KeyExpiry // null) as $k
    | if $k == null then {ok:true,expiring:false,date:null}
      else ($k | fromdateiso8601) as $e
      | {ok:true, expiring:(($e - now) < 604800), date:$k}
      end'
}

# --- dispatch -------------------------------------------------------------------

if [ "$1" = --request-id ]; then
  [ "$#" -ge 3 ] || jerr 'missing request command'
  _op_init "$2" "$3"
  shift 2
fi
case "$1" in
  control | mode-set | exitnode-set | exitnode-clear | login | login-authkey | logout | switch | serve-set | serve-del | funnel-set | funnel-del | routes-set | settings-set | context-set | file-send | file-receive | restore)
    [ ! -f "${TS_DIR}/.installing" ] || jerr 'an upgrade is in progress; retry after it completes' ;;
esac

case "$1" in
  cancel) shift; cmd_cancel "$1" ;;
  status) cmd_status ;;
  peers) cmd_peers ;;
  exitnodes) cmd_exitnodes ;;
  speedtest-exitnodes) cmd_speedtest_exitnodes ;;
  derp-speedtest) cmd_derp_speedtest ;;
  control) shift; cmd_control "$1" ;;
  mode-get) cmd_mode_get ;;
  mode-set) shift; cmd_mode_set "$1" ;;
  exitnode-set) shift; cmd_exitnode_set "$1" ;;
  exitnode-clear) cmd_exitnode_clear ;;
  tun) cmd_tun ;;
  dns) cmd_dns ;;
  login) shift; cmd_login "$@" ;;
  login-authkey) shift; cmd_login_authkey "$1" ;;
  logout) cmd_logout ;;
  accounts) cmd_accounts ;;
  switch) shift; cmd_switch "$1" ;;
  serve-list) _serve_list serve ;;
  serve-set) shift; _serve_set serve "$1" "$2" "$3" ;;
  serve-del) shift; _serve_del serve "$1" "$2" "$3" ;;
  funnel-list) _serve_list funnel ;;
  funnel-set) shift; _serve_set funnel "$1" "$2" "$3" ;;
  funnel-del) shift; _serve_del funnel "$1" "$2" "$3" ;;
  traffic) shift; cmd_traffic "$1" "$2" ;;
  traffic-uids) cmd_traffic_uids ;;
  apps) cmd_apps ;;
  routes-get) cmd_routes_get ;;
  routes-set) shift; cmd_routes_set "$1" "$2" "$3" ;;
  settings-get) cmd_settings_get ;;
  settings-set) shift; cmd_settings_set "$1" "$2" ;;
  context-get) cmd_context_get ;;
  context-set) shift; cmd_context_set "$1" ;;
  logs) shift; cmd_logs "$1" "$2" ;;
  compat) cmd_compat ;;
  diag) cmd_diag ;;
  files-inbox) cmd_files_inbox ;;
  file-send) shift; cmd_file_send "$1" "$2" ;;
  file-receive) cmd_file_receive ;;
  backup) cmd_backup ;;
  restore) shift; cmd_restore "$1" ;;
  key-expiry) cmd_key_expiry ;;
  *)
    [ -n "$1" ] && jerr "unknown command: $1"
    jerr "usage: foxytail.webapi.sh <cmd> [args] (see header for the full list)"
    ;;
esac
