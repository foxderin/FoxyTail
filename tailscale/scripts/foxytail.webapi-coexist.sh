#!/system/bin/sh
# Read-only snapshots and bounded probes; never edit a neighbouring resolver.

_coexist_snapshot() {
  load_runtime_conf || jerr 'invalid applied configuration'
  daemon_up || jerr 'tailscaled is unavailable; start it before detecting coexistence'
  _cx_status=$(ts_status_json ts_cli 10 status --json) || jerr 'cannot read the current Tailnet'
  _cx_base=$(printf '%s' "${_cx_status}" | jqr -e -c \
    --arg mode "${TS_MODE}" --argjson port "${SOCKS_PORT}" --arg ipv6 "${IPV6}" '
    def domain: type=="string" and length>0 and length<=253 and
      (split(".") | all(.[]; length>0 and length<=63 and test("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")));
    def ips: if type=="array" and length>0 and
      all(.[]; type=="string" and length<=45 and test("^[0-9a-fA-F:.]+$")) then unique else error("invalid node addresses") end;
    if type!="object" or .BackendState!="Running" or (.Self.ID|type)!="string" or .Self.ID=="" or
      (.Peer!=null and (.Peer|type)!="object") then error("Tailnet is not ready") else . end
    | (.MagicDNSSuffix // "" | ascii_downcase | rtrimstr(".")) as $suffix
    | if ($suffix|domain|not) then error("Tailnet suffix is unavailable") else . end
    | {selfId:.Self.ID,magicDns:(.CurrentTailnet.MagicDNSEnabled==true),suffix:$suffix,
       mode:$mode,socksPort:$port,ipv6Enabled:($ipv6=="on"),
       addresses:([.Self, (.Peer // {} | .[])] | map(.TailscaleIPs|ips) | add | unique),
       peers:([.Peer // {} | .[]
         | (.DNSName // "" | ascii_downcase | rtrimstr(".")) as $name
         | select((.ID|type)=="string" and .ID!="" and ($name|domain) and ($name|endswith("."+$suffix)))
         | {id:.ID,hostname:(.HostName // $name),dnsName:$name,ips:(.TailscaleIPs|ips),online:(.Online==true)}]
         | sort_by(.id))}' 2>/dev/null) || jerr 'current Tailnet names or addresses are unavailable or invalid'
  _cx_cidrs=$(printf '%s' "${_cx_base}" | jqr -r '.addresses | map(. + (if contains(":") then "/128" else "/32" end)) | join(" ")')
  normalize_cidrs "${_cx_cidrs}" >/dev/null || jerr 'current Tailnet has invalid IP addresses'
  [ -x "${TS_SCRIPTS_DIR}/foxytail.dns" ] || jerr 'DNS controller not found'
  _cx_dns=$(_op_exec 20 "${TS_SCRIPTS_DIR}/foxytail.dns" status --json 2>/dev/null) || jerr 'DNS status failed or timed out'
  _cx_info=$(printf '%s\n%s\n' "${_cx_base}" "${_cx_dns}" | jqr -e -s -c '
    if length!=2 or (.[1]|type)!="object" then error("invalid DNS status") else . end
    | .[0] as $base | .[1] as $dns
    | $base + {dns:($dns + {ok:true}),dnsReady:($base.magicDns and
        ($dns.mode=="local" or $dns.mode=="transparent") and $dns.enabled==true and
        $dns.listenerReady==true and $dns.repairNeeded==false and $dns.policyState=="owned" and
        $dns.suffix==$base.suffix and ($dns.port|type)=="number" and
        $dns.port>=1 and $dns.port<=65535 and ($dns.port|floor)==$dns.port and
        (["local","running","ipv6-unavailable","transparent-unavailable","capture-mark-conflict",
          "packet-policy-conflict","dns-interception-conflict"]|index($dns.reason))!=null)}' 2>/dev/null) || jerr 'DNS status is invalid'
  # Ignore transient peer activity, but bind previews to identity, addresses and applied endpoints.
  _cx_identity=$(printf '%s' "${_cx_info}" | jqr -c '{selfId,magicDns,suffix,mode,socksPort,ipv6Enabled,addresses,
    peers:[.peers[]|{id,dnsName,ips}],dnsReady,dns:{mode:.dns.mode,port:.dns.port,suffix:.dns.suffix}}') || jerr 'cannot identify coexistence snapshot'
  _cx_hash=$(printf '%s' "${_cx_identity}" | sha256sum) || jerr 'cannot hash coexistence snapshot'
  _cx_hash=${_cx_hash%% *}
  _op_cancelled && jerr 'coexistence detection cancelled'
  printf '%s' "${_cx_info}" | jqr -c --arg snapshot "${_cx_hash}" 'del(.selfId,.magicDns) + {ok:true,snapshot:$snapshot}'
}

cmd_coexist_info() {
  [ -x "${TS_SCRIPTS_DIR}/foxytail.compat" ] || jerr 'compatibility controller not found'
  _ci_environment=$(_op_exec 30 "${TS_SCRIPTS_DIR}/foxytail.compat" probe 2>/dev/null) || jerr 'compatibility detection failed or timed out'
  _op_cancelled && jerr 'coexistence detection cancelled'
  _ci_info=$(_coexist_snapshot) || { printf '%s\n' "${_ci_info}"; return 1; }
  printf '%s\n%s\n' "${_ci_info}" "${_ci_environment}" | jqr -e -s -c '
    if length!=2 or (.[1]|type)!="object" or (.[1].modules|type)!="array" or
      (.[1].apps|type)!="array" or (.[1].warnings|type)!="array" then error("invalid compatibility result")
    else .[0] + {environment:.[1]} end' || jerr 'invalid compatibility detection result'
}

cmd_coexist_check() {
  [ "$#" = 5 ] || jerr 'coexist-check: expected snapshot, peer ID, IP, TCP port and optional resolver port'
  _cc_expected=$1 _cc_id=$2 _cc_ip=$3 _cc_port=$4 _cc_resolver=$5
  case "${_cc_expected}" in ''|*[!0-9a-f]*) jerr 'coexist-check: invalid snapshot' ;; esac
  [ "${#_cc_expected}" = 64 ] || jerr 'coexist-check: invalid snapshot'
  case "${_cc_port}" in ''|*[!0-9]*|??????*) jerr 'coexist-check: invalid TCP port' ;; esac
  _num_in_range "${_cc_port}" 1 65535 || jerr 'coexist-check: TCP port must be 1-65535'
  if [ "${_cc_resolver}" != - ]; then
    case "${_cc_resolver}" in ''|*[!0-9]*|??????*) jerr 'coexist-check: invalid resolver port' ;; esac
    _num_in_range "${_cc_resolver}" 1 65535 || jerr 'coexist-check: resolver port must be 1-65535'
  fi
  case "${_cc_ip}" in ''|*[!0-9a-fA-F:.]*) jerr 'coexist-check: invalid peer IP' ;; esac
  [ "${#_cc_ip}" -le 45 ] || jerr 'coexist-check: invalid peer IP'
  _cc_before=$(_coexist_snapshot) || { printf '%s\n' "${_cc_before}"; return 1; }
  printf '%s' "${_cc_before}" | jqr -e --arg snapshot "${_cc_expected}" '.snapshot==$snapshot and .dnsReady==true' >/dev/null ||
    jerr 'coexist-check: environment changed or DNS is unready; detect again'
  _cc_name=$(printf '%s' "${_cc_before}" | jqr -e -r --arg id "${_cc_id}" --arg ip "${_cc_ip}" '
    [.peers[]|select(.id==$id and (.ips|index($ip))!=null)]
    | if length==1 then .[0].dnsName else error("peer identity changed") end') || jerr 'coexist-check: address is not a current peer address'
  _cc_dns_port=$(printf '%s' "${_cc_before}" | jqr -r '.dns.port')
  [ "${_cc_resolver}" = - ] || [ "${_cc_resolver}" -ne "${_cc_dns_port}" ] || jerr 'coexist-check: proxy DNS port must differ from FoxyTail DNS port'
  [ -x "${TS_BIN_DIR}/foxydns" ] || jerr 'FoxyTail DNS helper not found'
  set -- verify --dns-port "${_cc_dns_port}" --name "${_cc_name}" --address "${_cc_ip}" --target-port "${_cc_port}"
  [ "${_cc_resolver}" = - ] || set -- "$@" --resolver-port "${_cc_resolver}"
  _cc_mode=$(printf '%s' "${_cc_before}" | jqr -r '.mode')
  if [ "${_cc_mode}" != tun ]; then
    _cc_socks=$(printf '%s' "${_cc_before}" | jqr -r '.socksPort')
    set -- "$@" --socks-port "${_cc_socks}"
  fi
  _cc_result=$(_op_exec 15 "${TS_BIN_DIR}/foxydns" "$@") || {
    _op_cancelled && jerr 'coexistence verification cancelled'
    jerr 'coexistence probe failed or timed out'
  }
  _op_cancelled && jerr 'coexistence verification cancelled'
  _cc_after=$(_coexist_snapshot) || { printf '%s\n' "${_cc_after}"; return 1; }
  printf '%s' "${_cc_after}" | jqr -e --arg snapshot "${_cc_expected}" '.snapshot==$snapshot and .dnsReady==true' >/dev/null ||
    jerr 'coexist-check: environment changed during verification; detect again'
  printf '%s' "${_cc_result}" | jqr -e -c --arg snapshot "${_cc_expected}" '
    select(type=="object" and .ok==true and (.checks|type)=="array") | . + {snapshot:$snapshot}' ||
    jerr 'coexistence probe returned an invalid result'
}
