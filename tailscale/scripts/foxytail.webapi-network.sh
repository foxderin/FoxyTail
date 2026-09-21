#!/system/bin/sh
# Daemon status, peers, tun/DNS state and Serve/Funnel commands.
# Sourced by foxytail.webapi.sh.

# --- status / peers -----------------------------------------------------------

cmd_status() {
  _cs_st=""
  daemon_up && _cs_st=$(ts_status_json ts_cli 10 status --json)
  if [ -z "${_cs_st}" ]; then
    # A Stop may have completed during the CLI read. Recheck before reporting
    # either a stopped daemon or a live process with an unavailable LocalAPI.
    _cs_daemon=stopped _cs_backend=- _cs_uptime=0
    if daemon_exists; then
      _cs_daemon=running _cs_backend=unreachable _cs_uptime=$(daemon_uptime)
    fi
    jqr -n -c --arg mode "${TS_MODE}" --arg daemon "${_cs_daemon}" \
      --arg backend "${_cs_backend}" --argjson uptime "${_cs_uptime}" \
      --arg power "${POWER_SAVE:-off}" --arg refresh "${WEBUI_AUTO_REFRESH:-on}" \
      '{ok:true,daemon:$daemon,backend:$backend,mode:$mode,self:null,exitNode:null,peers:{online:0,offline:0},magicDns:false,keyExpiry:null,uptime:$uptime,powerSave:($power=="on"),autoRefresh:($refresh=="on")}'
    return 0
  fi
  _cs_up=$(daemon_uptime)
  printf '%s' "${_cs_st}" | jqr -c --arg mode "${TS_MODE}" --argjson uptime "${_cs_up}" \
    --arg power "${POWER_SAVE:-off}" --arg refresh "${WEBUI_AUTO_REFRESH:-on}" '
    (.Peer // {} | to_entries | map(.value)) as $peers
    | (.ExitNodeStatus // null) as $en
    | {
        ok: true,
        daemon: "running",
        backend: (.BackendState // "unknown"),
        mode: $mode,
        powerSave: ($power=="on"),
        autoRefresh: ($refresh=="on"),
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
       ips: (.TailscaleIPs // []),
       os: (.OS // "-"),
       relay: (.Relay // "-"),
       online: (.Online // false),
       rxBytes: (.RxBytes // 0),
       txBytes: (.TxBytes // 0),
       exitNodeOption: (.ExitNodeOption // false)
     }]'

cmd_peers() {
  daemon_up || jerr 'tailscaled is unavailable; peers are unknown'
  _cp_st=$(ts_status_json ts_cli 10 status --json)
  [ -n "${_cp_st}" ] || jerr 'cannot reach tailscaled status; peers are unknown'
  _cp_result=$(printf '%s' "${_cp_st}" | jqr -c --argjson exits "${1:-false}" '
    if type!="object" or .BackendState!="Running" or
      (.Peer!=null and (.Peer|type)!="object") then error("peers are unknown") else . end
    | '"${_peers_jq}"' | map(select($exits==false or .exitNodeOption==true))
    | {ok:true,peers:.}' 2>/dev/null) || jerr 'invalid or unavailable peer status; peers are unknown'
  printf '%s\n' "${_cp_result}"
}

cmd_exitnodes() {
  cmd_peers true
}

cmd_peer_ping() {
  [ -n "$1" ] || jerr 'peer-ping: missing peer id'
  case "$2" in '' | *[!0-9a-fA-F:.]*) jerr 'peer-ping: expected a peer IP address' ;; esac
  case "$2" in *:*) _pp_bits=128 ;; *.*) _pp_bits=32 ;; *) jerr 'peer-ping: expected a peer IP address' ;; esac
  normalize_cidrs "$2/${_pp_bits}" >/dev/null || jerr 'peer-ping: invalid IP address'
  daemon_up || jerr 'tailscaled is unavailable'
  _pp_status=$(ts_status_json ts_cli 10 status --json)
  _pp_ips=$(printf '%s' "${_pp_status}" | jqr -e -c --arg id "$1" --arg ip "$2" '
    if type=="object" and .BackendState=="Running" and (.Peer|type)=="object" then
      [.Peer[] | select(type=="object" and .ID==$id and (.TailscaleIPs|type)=="array")
        | .TailscaleIPs[] | select(type=="string")] | select(index($ip)!=null)
    else empty end' 2>/dev/null) ||
    jerr 'peer-ping: address does not belong to this peer in the current device list'
  # ponytail: the pinned CLI has no JSON ping; use structured output when available.
  # DERP pongs count even when --until-direct exits nonzero. Disco replies use
  # the peer's primary NodeIP, which can differ from the requested IPv6 address.
  _pp_out=$(ts_cli 12 ping --c=3 --timeout=3s "$2" </dev/null 2>&1)
  _op_cancelled && jerr 'peer ping cancelled'
  _pp_result=$(printf '%s\n' "${_pp_out}" | jqr -R -s -e -c --arg id "$1" --arg ip "$2" --argjson ips "${_pp_ips}" '
    [split("\n")[] | capture("^pong from .+ \\((?<ip>[^),]+)(?:, [0-9]+)?\\) via (?<via>.+) in (?<latency>[0-9]+(?:\\.[0-9]+)?)(?<unit>ms|s)$")
      | select(.ip as $reply | $ips | index($reply)!=null)] | last | select(.!=null)
    | {ok:true,peerId:$id,ip:$ip,
       latencyMs:((.latency|tonumber) * (if .unit=="s" then 1000 else 1 end)),via:.via,
       path:(if (.via|test("^DERP\\([a-z0-9-]+\\)$")) then "derp"
         elif (.via|test("^peer-relay\\(.+\\)$")) then "peer-relay"
         elif (.via|test("^([0-9]{1,3}\\.){3}[0-9]{1,3}:[0-9]+$|^\\[[0-9a-fA-F:]+\\]:[0-9]+$")) then "direct"
         else "unknown" end)}' 2>/dev/null) || jerr "peer ping failed: ${_pp_out:-no reply}"
  printf '%s\n' "${_pp_result}"
}

cmd_speedtest_exitnodes() {
  daemon_up || jerr "tailscaled is not running"
  _se_st=$(ts_status_json ts_cli 10 status --json)
  [ -n "${_se_st}" ] || jerr "cannot reach tailscaled status"
  _se_list=$(printf '%s' "${_se_st}" | jqr -r \
    '.Peer // {} | to_entries[] | .value | select(.ExitNodeOption == true)
     | [(.TailscaleIPs // [])[0] // "", .HostName // "-", .ID // ""] | @tsv')
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
    printf '%s' "${_cd_out}" | jqr -c '{ok:true,state:.state,suffix:.suffix,port:.port,
      mode:(.mode // "legacy"),configuredMode:.configuredMode,pendingMode:.pendingMode,
      listenerReady:(.listenerReady // false),interception4:(.interception4 // false),
      interception6:(.interception6 // false),repairNeeded:.repairNeeded,policyState:.policyState,
      capabilityError:.capabilityError,
      enabled:(.enabled // false),reason:(.reason // ""),binary:(.binary // null),
      upstreamNative:(.upstreamNative // false),
      ipv6DnsInterception:(.ipv6DnsInterception // null),
      ipv6ModuleStatus:(.ipv6ModuleStatus // null)}'
  else
    jqr -n -c --argjson p "${DNS_PORT}" --arg enabled "${MAGIC_DNS}" \
      '{ok:true,state:"stopped",suffix:"",port:$p,enabled:($enabled=="on"),
        reason:"DNS status is unavailable",binary:null,upstreamNative:false}'
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

# Validate a listener against the pinned CLI before invoking it. The upstream
# target scheme is independent: Funnel HTTPS can proxy an http:// local target.
# Publish the decimal port in _sv_port for both CLI flags and JSON responses.
_serve_validate_listener() {
  case "$1" in
    serve)
      case "$2" in
        http | https | tcp | tls-terminated-tcp) ;;
        *) jerr "serve supports only http, https, tcp, or tls-terminated-tcp listeners" ;;
      esac ;;
    funnel)
      case "$2" in
        https | tcp | tls-terminated-tcp) ;;
        *) jerr "funnel supports only https, tcp, or tls-terminated-tcp listeners; HTTP targets must use an HTTPS listener" ;;
      esac ;;
    *) jerr 'invalid listener kind: expected serve or funnel' ;;
  esac
  case "$3" in
    '' | *[!0-9]*) jerr "invalid port: ${3:-<empty>} (expected 1-65535)" ;;
  esac
  # Go numeric flags accept leading-zero octal, while the UI means decimal.
  _sv_port=$(printf '%s' "$3" | sed 's/^0*//')
  _num_in_range "${_sv_port}" 1 65535 || jerr 'invalid port: expected 1-65535'
  if [ "$1" = funnel ]; then
    case "${_sv_port}" in
      443 | 8443 | 10000) ;;
      *) jerr 'funnel public port must be 443, 8443, or 10000' ;;
    esac
  fi
}

_serve_set() {
  _ss_kind="$1"
  _ss_proto="$2"
  _ss_target="$4"
  _serve_validate_listener "${_ss_kind}" "${_ss_proto}" "$3"
  _ss_port=${_sv_port}
  [ -n "${_ss_target}" ] || jerr "missing target"
  case "${_ss_target}" in
    off | -*) jerr 'invalid target: off and CLI flags are control arguments, not service targets' ;;
  esac
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
  _sd_path="${4:-}"
  _serve_validate_listener "${_sd_kind}" "${_sd_proto}" "$3"
  _sd_port=${_sv_port}
  # The WebUI already confirms deletion of this listener/path. Without --yes,
  # the CLI can decline a multi-handler deletion on EOF and still exit zero.
  if [ -n "${_sd_path}" ]; then
    case "${_sd_proto}:${_sd_path}" in http:/* | https:/*) ;; *) jerr 'path applies only to HTTP(S) handlers and must start with /' ;; esac
    printf '%s' "${_sd_path}" | LC_ALL=C grep '[[:cntrl:]]' >/dev/null && jerr 'invalid path'
    _sd_out=$(ts_cli 25 "${_sd_kind}" --bg --yes --"${_sd_proto}=${_sd_port}" --set-path="${_sd_path}" off 2>&1)
  else
    _sd_out=$(ts_cli 25 "${_sd_kind}" --bg --yes --"${_sd_proto}=${_sd_port}" off 2>&1)
  fi
  if [ $? -eq 0 ]; then
    jqr -n -c --arg k "${_sd_kind}" --arg p "${_sd_proto}" --argjson port "${_sd_port}" \
      '{ok:true,kind:$k,proto:$p,port:$port,deleted:true}'
  else
    jerr "${_sd_kind} delete failed: ${_sd_out:-timeout}"
  fi
}
