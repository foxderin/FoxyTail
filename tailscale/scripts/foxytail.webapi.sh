#!/system/bin/sh
# FoxyTail WebAPI
#
# JSON-only backend for the WebUI. Every command prints exactly one JSON
# document to stdout; diagnostics go to stderr / the log file.
#
# Commands:
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
#   accounts            parse `tailscale switch list` -> {accounts:[{name,current}]}
#   switch              switch <account-name>
#   serve-list          `tailscale serve status --json` passthrough {ok,status}
#   serve-set           serve-set <proto> <port> <target>
#   serve-del           serve-del <proto> <port>
#   funnel-list         `tailscale funnel status --json` passthrough {ok,status}
#   funnel-set          funnel-set <proto> <port> <target>
#   funnel-del          funnel-del <proto> <port>
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
#   settings-set        settings-set <KEY> <value> (whitelisted keys, injection-filtered value)
#   context-get         {rules:<raw context.conf text>}
#   context-set         context-set <base64> (whole rules file, base64 to dodge escaping)
#   logs                logs daemon|service [lines] -> {lines:[...]} (default 200)
#   compat              compat.json probe result + compat-alert content
#   diag                run foxytail.diag collect -> {ok,path}
#   files-inbox         list $TS_DIR/files -> {files:[{name,size,mtime}]}
#   file-send           file-send <abs-path-under-/sdcard> <peer-hostname>
#   file-receive        pull waiting Taildrop files into $TS_DIR/files
#   backup              tar conf+hooks to /sdcard/Download/foxytail-backup-<ts>.tar.gz -> {ok,path}
#   restore             restore <path-under-/sdcard> (existing conf backed up first)
#   key-expiry          {expiring:bool,date} from .Self.KeyExpiry
#
# Failure contract: {"ok":false,"error":"..."} with a non-zero exit code.
# Success documents carry "ok":true as their first field.

# POSIX sh (Android mksh / busybox). No bashisms, no `set -e`.

DIR=$(dirname "$(realpath "$0")")
# shellcheck source=../settings.sh
. "${DIR}/../settings.sh"
load_conf
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

# tailscale CLI against our socket. $1: timeout seconds, rest: argv.
ts_cli() {
  _tc_t="$1"
  shift
  timeout "${_tc_t}" tailscale --socket="${TS_SOCKET}" "$@" 2>/dev/null
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

cmd_control() {
  case "$1" in
    start | stop | restart) ;;
    *) jerr "control: expected start|stop|restart" ;;
  esac
  if "${TS_SCRIPTS_DIR}/foxytail.service" "$1" >>"${TS_RUN_LOG_FILE}" 2>&1; then
    jqr -n -c --arg a "$1" '{ok:true,action:$a}'
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
  [ -f "${_cl_tmp}" ] || return 1
  grep -q 'https://' "${_cl_tmp}" 2>/dev/null && return 0
  grep -qi 'already\|success' "${_cl_tmp}" 2>/dev/null
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
  ( timeout 180 tailscale --socket="${TS_SOCKET}" login "$@" >"${_cl_tmp}" 2>&1 ) &
  if wait_for "login URL" _login_probe 20 1; then
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
  jerr "no login URL within 20s${_cl_err:+: ${_cl_err}}"
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
  _ac_list=$(ts_cli 15 switch list 2>&1)
  if [ $? -ne 0 ]; then
    jerr "switch list failed: ${_ac_list:-timeout}"
  fi
  printf '%s\n' "${_ac_list}" | grep -v '^$' | while IFS= read -r _ac_line; do
    _ac_cur=false
    case "${_ac_line}" in
      *\**) _ac_cur=true ;;
    esac
    _ac_name=$(printf '%s' "${_ac_line}" | sed 's/\*//g' | awk '{print $1}')
    [ -n "${_ac_name}" ] || continue
    jqr -n -c --arg n "${_ac_name}" --argjson c "${_ac_cur}" '{name:$n,current:$c}'
  done | jqr -s -c '{ok:true,accounts:.}'
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
  case "${_sd_proto}" in
    http | https | tcp | tls-terminated-tcp) ;;
    *) jerr "invalid proto: ${_sd_proto:-<empty>}" ;;
  esac
  case "${_sd_port}" in
    '' | *[!0-9]*) jerr "invalid port: ${_sd_port:-<empty>}" ;;
  esac
  _sd_out=$(ts_cli 25 "${_sd_kind}" --bg --"${_sd_proto}=${_sd_port}" off 2>&1)
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
  _tu_lines=""
  for _tu_f in "${TS_STATS_DIR}"/????-??-??.jsonl; do
    [ -f "${_tu_f}" ] || continue
    _tu_lines="${_tu_lines}$(jqr -s -c '
      [ .[] | select(.error == null) | .uids[]? ]
      | group_by(.uid) | .[]
      | { uid: .[0].uid,
          rx: ([(map(.rx) | max) - (map(.rx) | min), 0] | max) }' "${_tu_f}" 2>/dev/null)
"
  done
  if [ -z "${_tu_lines}" ]; then
    echo '{"ok":true,"uids":[]}'
    return 0
  fi
  printf '%s' "${_tu_lines}" | jqr -s -c '
    [ group_by(.uid) | .[]
      | { uid: .[0].uid, rx: (map(.rx) | add) }
      | select(.rx > 0) ]
    | sort_by(.rx) | reverse | {ok:true, uids:.}'
}

cmd_apps() {
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
  case "${_rs_scope}" in
    all | selected | bypass) ;;
    *) jerr "routes-set: scope must be all|selected|bypass" ;;
  esac
  _rs_uids=$(csv_to_json "$2")
  _rs_subs=$(csv_to_json "$3")

  # Validate: numeric uids, CIDR-shaped subnets.
  if ! printf '%s' "${_rs_uids}" | jqr -e 'all(test("^[0-9]+$"))' >/dev/null 2>&1; then
    jerr "routes-set: uids must be numeric"
  fi
  if ! printf '%s' "${_rs_subs}" | jqr -e 'all(test("^[0-9a-fA-F.:]+/[0-9]+$"))' >/dev/null 2>&1; then
    jerr "routes-set: subnets must be CIDR (e.g. 100.64.0.0/10)"
  fi

  _rs_uid_list=$(printf '%s' "${_rs_uids}" | jqr -r 'join(" ")')
  _rs_sub_list=$(printf '%s' "${_rs_subs}" | jqr -r 'join(" ")')
  [ -z "${_rs_sub_list}" ] && _rs_sub_list="100.64.0.0/10"

  mkdir -p "${TS_CONF_DIR}"
  _rs_tmp="${TS_CONF_DIR}/.routes.conf.$$"
  {
    echo "# FoxyTail routing configuration."
    echo "# Written by foxytail.webapi.sh routes-set on $(date +"%Y-%m-%d %H:%M:%S")."
    echo "# ROUTE_SCOPE: all | selected | bypass"
    echo "ROUTE_SCOPE=${_rs_scope}"
    echo "UID_LIST=\"${_rs_uid_list}\""
    echo "ROUTE_SUBNETS=\"${_rs_sub_list}\""
  } >"${_rs_tmp}" || { rm -f "${_rs_tmp}"; jerr "routes-set: cannot write temp file"; }
  mv "${_rs_tmp}" "${TS_CONF_DIR}/routes.conf" || { rm -f "${_rs_tmp}"; jerr "routes-set: cannot replace routes.conf"; }

  # Best effort reload: routing only applies when the tunnel interface exists.
  _rs_note="saved"
  if ip link show dev "${TUN_IFACE}" >/dev/null 2>&1; then
    if "${TS_SCRIPTS_DIR}/foxytail.route" reload >>"${TS_RUN_LOG_FILE}" 2>&1; then
      _rs_note="saved+reloaded"
    else
      _rs_note="saved but reload failed (see log)"
    fi
  fi
  jqr -n -c --arg n "${_rs_note}" '{ok:true,note:$n}'
}

# --- settings (foxytail.conf) --------------------------------------------------

# Whitelist: keys present in the shipped template, plus a fixed known list.
_settings_keys() {
  {
    [ -f "${TS_CONF_DIR}/foxytail.conf" ] &&
      grep -o '^[A-Z_][A-Z_]*=' "${TS_CONF_DIR}/foxytail.conf" | tr -d '='
    printf '%s\n' TS_MODE SOCKS_PORT DNS_PORT MAGIC_DNS IPV6 ROUTE_TABLE FWMARK \
      WATCHDOG WATCHDOG_INTERVAL STATS_INTERVAL LOG_MAX_KB
  } | sort -u
}

cmd_settings_get() {
  if [ ! -f "${TS_CONF_DIR}/foxytail.conf" ]; then
    echo '{"ok":true,"settings":{}}'
    return 0
  fi
  jqr -R -s -c '
    split("\n")
    | map(select(test("^[A-Za-z_][A-Za-z0-9_]*=")) | split("=")
        | {key: .[0], value: (.[1:] | join("=") | gsub("^\"|\"$"; ""))})
    | map({(.key): .value}) | add // {}
    | {ok:true, settings:.}' "${TS_CONF_DIR}/foxytail.conf"
}

cmd_settings_set() {
  _sk="$1"
  _sv="$2"
  [ -n "${_sk}" ] || jerr "settings-set: missing key"
  if ! _settings_keys | grep -qx "${_sk}"; then
    jerr "settings-set: key '${_sk}' is not allowed"
  fi
  # Injection filter: no quotes, dollar, backslash, backtick, newline.
  case "${_sv}" in
    *\"* | *\'* | *\$* | *\\* | *\`* | *"$_FTNL"*) jerr "settings-set: forbidden character in value" ;;
  esac
  case "${_sv}" in
    *\ * | *"$_FTTB"*) jerr "settings-set: whitespace is not allowed in values" ;;
  esac

  _sk_conf="${TS_CONF_DIR}/foxytail.conf"
  mkdir -p "${TS_CONF_DIR}"
  [ -f "${_sk_conf}" ] || : >"${_sk_conf}"
  _sk_tmp="${TS_CONF_DIR}/.foxytail.conf.$$"
  awk -v k="${_sk}" -v v="${_sv}" '
    BEGIN { done = 0 }
    $0 ~ "^" k "=" { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "${_sk_conf}" >"${_sk_tmp}" || { rm -f "${_sk_tmp}"; jerr "settings-set: write failed"; }
  mv "${_sk_tmp}" "${_sk_conf}" || { rm -f "${_sk_tmp}"; jerr "settings-set: replace failed"; }
  jqr -n -c --arg k "${_sk}" --arg v "${_sv}" '{ok:true,key:$k,value:$v}'
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
  _cx_tmp="${TS_CONF_DIR}/.context.conf.$$"
  mkdir -p "${TS_CONF_DIR}"
  if ! printf '%s' "$1" | base64 -d >"${_cx_tmp}" 2>/dev/null; then
    rm -f "${_cx_tmp}"
    jerr "context-set: invalid base64"
  fi
  mv "${_cx_tmp}" "${TS_CONF_DIR}/context.conf" || { rm -f "${_cx_tmp}"; jerr "context-set: replace failed"; }
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
    jqr -n -c --arg n "${_fi_name}" --argjson s "${_fi_size}" --argjson m "${_fi_mtime}" \
      '{name:$n,size:$s,mtime:$m}'
  done | jqr -s -c 'sort_by(-.mtime) | {ok:true,files:.}'
}

cmd_file_send() {
  [ -n "$1" ] && [ -n "$2" ] || jerr "file-send: expected <path> <peer>"
  _fs_path=$(realpath "$1" 2>/dev/null)
  case "${_fs_path}" in
    /sdcard/*) ;;
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

cmd_backup() {
  _bk_ts=$(date +%Y%m%d-%H%M%S)
  _bk_out="/sdcard/Download/foxytail-backup-${_bk_ts}.tar.gz"
  mkdir -p /sdcard/Download 2>/dev/null
  _bk_hooks=""
  for _bk_h in foxytail.tun.up foxytail.tun.down foxytail.tun.config.yaml; do
    [ -f "${TS_SCRIPTS_DIR}/${_bk_h}" ] && _bk_hooks="${_bk_hooks} ${_bk_h}"
  done
  if [ -n "${_bk_hooks}" ]; then
    # shellcheck disable=SC2086 # intentional: hook names are fixed words
    tar -czf "${_bk_out}" -C "${TS_DIR}" conf -C "${TS_SCRIPTS_DIR}" ${_bk_hooks} 2>/dev/null
  else
    tar -czf "${_bk_out}" -C "${TS_DIR}" conf 2>/dev/null
  fi
  if [ -f "${_bk_out}" ]; then
    jqr -n -c --arg p "${_bk_out}" '{ok:true,path:$p}'
  else
    jerr "backup failed (is /sdcard/Download writable?)"
  fi
}

cmd_restore() {
  [ -n "$1" ] || jerr "restore: missing path"
  _rt_path=$(realpath "$1" 2>/dev/null)
  case "${_rt_path}" in
    /sdcard/*.tar.gz) ;;
    *) jerr "restore: path must be a .tar.gz under /sdcard/" ;;
  esac
  [ -f "${_rt_path}" ] || jerr "restore: no such file: ${_rt_path}"
  _rt_tmp=$(mktemp -d "${TS_RUN_DIR}/restore.XXXXXX" 2>/dev/null) ||
    { _rt_tmp="${TS_RUN_DIR}/restore.$$"; rm -rf "${_rt_tmp}"; mkdir -p "${_rt_tmp}"; }
  if ! tar -xzf "${_rt_path}" -C "${_rt_tmp}" 2>/dev/null; then
    rm -rf "${_rt_tmp}"
    jerr "restore: cannot unpack ${_rt_path}"
  fi
  _rt_src="${_rt_tmp}"
  # Bundles created by cmd_backup contain conf/ at top level; the diag bundle
  # nests under a diag.* dir. Look one level deep as a fallback.
  if [ ! -d "${_rt_src}/conf" ]; then
    for _rt_d in "${_rt_tmp}"/*/; do
      [ -d "${_rt_d}conf" ] && _rt_src="${_rt_d%/}" && break
    done
  fi
  if [ ! -d "${_rt_src}/conf" ]; then
    rm -rf "${_rt_tmp}"
    jerr "restore: no conf/ directory inside the archive"
  fi
  _rt_ts=$(date +%Y%m%d-%H%M%S)
  cp -a "${TS_CONF_DIR}" "${TS_DIR}/conf.bak-${_rt_ts}" 2>/dev/null
  mkdir -p "${TS_CONF_DIR}"
  cp -a "${_rt_src}/conf/." "${TS_CONF_DIR}/" || {
    rm -rf "${_rt_tmp}"
    jerr "restore: failed to copy conf files"
  }
  for _rt_h in foxytail.tun.up foxytail.tun.down; do
    if [ -f "${_rt_src}/${_rt_h}" ]; then
      cp -a "${_rt_src}/${_rt_h}" "${TS_SCRIPTS_DIR}/${_rt_h}"
      chmod 0755 "${TS_SCRIPTS_DIR}/${_rt_h}"
    fi
  done
  rm -rf "${_rt_tmp}"
  jqr -n -c --arg b "${TS_DIR}/conf.bak-${_rt_ts}" '{ok:true,previous:$b}'
}

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

# Whitespace tokens used in settings-set validation (POSIX-safe constants).
_FTNL='
'
_FTTB='	'

case "$1" in
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
  serve-del) shift; _serve_del serve "$1" "$2" ;;
  funnel-list) _serve_list funnel ;;
  funnel-set) shift; _serve_set funnel "$1" "$2" "$3" ;;
  funnel-del) shift; _serve_del funnel "$1" "$2" ;;
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
