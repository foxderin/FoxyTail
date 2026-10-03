#!/system/bin/sh
# Sourced by foxytail.dns. Modern listeners never choose a public DNS upstream.
# Only the native helper may capture packets whose original socket context it
# can recover; all other packets retain the device's existing DNS/VPN path.

MODERN_BIN="${TS_BIN_DIR}/foxydns"
MODERN_CONF="${TS_RUN_DIR}/foxydns.json"
MODERN_STATE="${TS_RUN_DIR}/foxydns.state.json"
MODERN_REASON="${TS_RUN_DIR}/foxydns.reason"
MODERN_POLICY="${TS_RUN_DIR}/foxydns.policy"
MODERN_MODE="${TS_RUN_DIR}/foxydns.mode"
MODERN_CAPABILITIES="${TS_RUN_DIR}/foxydns.capabilities.json"
MODERN_JOURNAL="${TS_DIR}/state/foxydns-preferences.json"
MODERN_QUEUE=1053
MODERN_UPSTREAM_GID=65533
MODERN_CAPTURE=0x20000000/0x20000000
MODERN_QUEUE_CHAIN=FOXY_DNS_QUEUE
MODERN_CAPTURE_CHAIN=FOXY_DNS_CAPTURE
MODERN_GUARD="${TS_RUN_DIR}/foxydns.guard"

# Preference journal: an installed layout ships it beside this file, while
# standalone harnesses may provide it directly.
[ ! -r "${TS_SCRIPTS_DIR}/foxytail.dns-pref.sh" ] || . "${TS_SCRIPTS_DIR}/foxytail.dns-pref.sh"

modern_pids() {
  for _mp_pid in $(pids_of_path "${MODERN_BIN}"); do
    _proc_cmdline "${_mp_pid}" | grep -qxF -- "${MODERN_CONF}" && echo "${_mp_pid}"
  done
}

modern_lock() {
  _md_lock="${TS_RUN_DIR}/.dns-lock"
  _lock_identity
  _md_token=${_LOCK_TOKEN}
  _owner_lock_acquire "${_md_lock}" "${_md_token}" 100 0.1
}

modern_unlock() {
  _owner_lock_release "${_md_lock}" "${_md_token}"
}

modern_reason() {
  _mr_old=; IFS= read -r _mr_old 2>/dev/null <"${MODERN_REASON}" || :
  [ "${_mr_old}" = "$1" ] || printf '%s\n' "$1" >"${MODERN_REASON}"
  _mr_old=; IFS= read -r _mr_old 2>/dev/null <"${MODERN_POLICY}" || :
  [ "${_mr_old}" = "${2:-unknown}" ] || printf '%s\n' "${2:-unknown}" >"${MODERN_POLICY}"
}

# Persist only bounded capability diagnostics, never arbitrary helper output.
# Repeated status polling does not probe, write files, or append service logs.
modern_record_capabilities() {
  _rc_value=$1
  [ "$(cat "${MODERN_CAPABILITIES}" 2>/dev/null)" != "${_rc_value}" ] || return 0
  (umask 077; printf '%s\n' "${_rc_value}" >"${MODERN_CAPABILITIES}.next.$$") &&
    mv "${MODERN_CAPABILITIES}.next.$$" "${MODERN_CAPABILITIES}" || return 1
  _rc_error=$(printf '%s' "${_rc_value}" | jqr -r '.error // ""')
  [ -z "${_rc_error}" ] || log Warning "MagicDNS transparent capability unavailable: ${_rc_error}"
}

# Read /proc boot_id so a cached verdict dies with the kernel that produced
# it. A reflashed or otherwise replaced kernel resets this value; without it
# a "not supported" verdict would outlive the very patch that fixes it.
modern_boot_id() {
  # Tests inject FOXY_BOOT_ID to simulate kernel changes; production reads
  # the kernel's own boot identifier.
  if [ -n "${FOXY_BOOT_ID:-}" ]; then printf '%s\n' "${FOXY_BOOT_ID}"; else cat /proc/sys/kernel/random/boot_id 2>/dev/null; fi
}

# Cache reader shared by modern_dns_status and the legacy passthrough. Prints
# `{ok,error?}` when the cached verdict was recorded under the current boot,
# nothing otherwise. Callers distinguish "no verdict" (probe again) from
# "verdict is no" (grey out the option).
modern_cached_capabilities() {
  [ -e "${MODERN_CAPABILITIES}" ] || return 1
  _mc_boot=$(modern_boot_id)
  [ -n "${_mc_boot}" ] || return 1
  jqr -c --arg boot "${_mc_boot}" '
    select(.bootId == $boot and (.ok | type == "boolean"))
    | {ok:.ok, error:(.error // ""), reason:(.reason // "")}' \
    "${MODERN_CAPABILITIES}" 2>/dev/null
}

# Full verdict for transparent mode. Gates (in order):
#   1. An owned, ready queue already proves the kernel path works — skip the
#      probe, which would falsely fail against a live queue.
#   2. foxydns probe verifies NFQUEUE/conntrack/socketContext.
#   3. modern_capture_safe verifies no foreign rule can clobber the capture
#      mark (e.g. OEM wide mark masks that cover 0x20000000).
#   4. modern_packet_policy_safe verifies OUTPUT policies are ACCEPT.
# The persisted verdict carries the boot id so kernel changes invalidate it.
modern_probe_capabilities() {
  _pc_boot=$(modern_boot_id)
  [ -n "${_pc_boot}" ] || return 1
  if modern_queue_ready; then
    _pc_result=$(jqr -n -c --arg boot "${_pc_boot}" '{ok:true,reason:"queue-active",bootId:$boot}') || return 1
    modern_record_capabilities "${_pc_result}" || return 1
    return 0
  fi
  _pc_output=$(tmo 5 "${MODERN_BIN}" probe --queue "${MODERN_QUEUE}" 2>/dev/null)
  _pc_rc=$?
  _pc_result=$(printf '%s' "${_pc_output}" | jqr -e -c -s --argjson rc "${_pc_rc}" '
    select(length == 1) | .[0] | select(type == "object")
    | if $rc == 0 and .ok == true and .queue == true and .conntrack == true and .socketContext == true
      then {ok:true}
      else {ok:false,error:(if (.error | type) == "string" and (.error | length) > 0
        then (.error | gsub("[[:cntrl:]]";" ") | .[0:512])
        else "DNS capability probe returned an invalid result" end)} end' 2>/dev/null)
  if [ -z "${_pc_result}" ]; then
    _pc_error="DNS capability probe did not return valid JSON (exit ${_pc_rc})"
    [ "${_pc_rc}" != 124 ] || _pc_error='DNS capability probe timed out'
    _pc_result=$(jqr -n -c --arg error "${_pc_error}" '{ok:false,error:$error}') || return 1
  fi
  # A passing helper probe is not sufficient: the capture mark and the OUTPUT
  # packet policy must also be compatible with this device's actual rules.
  if [ "$(printf '%s' "${_pc_result}" | jqr -r '.ok')" = true ]; then
    if ! modern_capture_safe; then
      _pc_result=$(jqr -n -c '{ok:false,error:"capture mark 0x20000000 conflicts with an existing rule or mask"}') || return 1
    elif ! modern_packet_policy_safe; then
      _pc_result=$(jqr -n -c '{ok:false,error:"OUTPUT chain default policy is not ACCEPT"}') || return 1
    fi
  fi
  _pc_result=$(printf '%s' "${_pc_result}" | jqr -c --arg boot "${_pc_boot}" '. + {bootId:$boot}') || return 1
  modern_record_capabilities "${_pc_result}" || return 1
  printf '%s' "${_pc_result}" | jqr -e '.ok == true' >/dev/null 2>&1
}

modern_rules_teardown() {
  _mt_rc=0
  for _mt_cmd in iptables ip6tables; do
    for _mt_pair in "nat:${MODERN_CAPTURE_CHAIN}" "mangle:${MODERN_QUEUE_CHAIN}"; do
      _mt_table=${_mt_pair%%:*}; _mt_chain=${_mt_pair#*:}
      while "${_mt_cmd}" -w 2 -t "${_mt_table}" -D OUTPUT -j "${_mt_chain}" 2>/dev/null; do :; done
      "${_mt_cmd}" -w 2 -t "${_mt_table}" -F "${_mt_chain}" 2>/dev/null
      "${_mt_cmd}" -w 2 -t "${_mt_table}" -X "${_mt_chain}" 2>/dev/null
      "${_mt_cmd}" -t "${_mt_table}" -C OUTPUT -j "${_mt_chain}" 2>/dev/null && _mt_rc=1
      "${_mt_cmd}" -t "${_mt_table}" -S "${_mt_chain}" >/dev/null 2>&1 && _mt_rc=1
    done
  done
  return "${_mt_rc}"
}

modern_family_policy_safe() {
  for _fp_table in mangle nat; do
    [ "$("$1" -t "${_fp_table}" -S OUTPUT 2>/dev/null |
      awk '$1=="-P" && $2=="OUTPUT" {print $3; exit}')" = ACCEPT ] || return 1
  done
}

modern_rules_family() {
  _mf_cmd=$1
  modern_family_policy_safe "${_mf_cmd}" || return 1
  "${_mf_cmd}" -w 2 -t mangle -N "${MODERN_QUEUE_CHAIN}" 2>/dev/null || return 1
  "${_mf_cmd}" -w 2 -t nat -N "${MODERN_CAPTURE_CHAIN}" 2>/dev/null || return 1
  "${_mf_cmd}" -w 2 -t mangle -A "${MODERN_QUEUE_CHAIN}" -m owner --uid-owner 0 --gid-owner "${MODERN_UPSTREAM_GID}" -j RETURN || return 1
  "${_mf_cmd}" -w 2 -t nat -A "${MODERN_CAPTURE_CHAIN}" -m owner --uid-owner 0 --gid-owner "${MODERN_UPSTREAM_GID}" -j RETURN || return 1
  for _mf_proto in udp tcp; do
    "${_mf_cmd}" -w 2 -t mangle -A "${MODERN_QUEUE_CHAIN}" -p "${_mf_proto}" --dport 53 \
      -j NFQUEUE --queue-num "${MODERN_QUEUE}" --queue-bypass || return 1
    "${_mf_cmd}" -w 2 -t nat -A "${MODERN_CAPTURE_CHAIN}" -p "${_mf_proto}" --dport 53 \
      -m mark --mark "${MODERN_CAPTURE}" -j REDIRECT --to-ports "${DNS_PORT}" || return 1
  done
  # Mount NAT before queueing begins; no packet can be captured into a missing
  # redirect path. Teardown removes interception first so a stale mark cannot
  # send unrelated packets into an unavailable listener.
  "${_mf_cmd}" -w 2 -t nat -I OUTPUT 1 -j "${MODERN_CAPTURE_CHAIN}" || return 1
  # NF_ACCEPT resumes after the iptables hook, so queueing must be last: the
  # device/VPN mark rules need to run before the helper snapshots the packet.
  "${_mf_cmd}" -w 2 -t mangle -A OUTPUT -j "${MODERN_QUEUE_CHAIN}"
}

modern_rules_present() {
  _mp_cmd=$1
  _mp_port=${2:-${DNS_PORT}}
  modern_family_policy_safe "${_mp_cmd}" || return 1
  for _mp_pair in "mangle:${MODERN_QUEUE_CHAIN}" "nat:${MODERN_CAPTURE_CHAIN}"; do
    _mp_table=${_mp_pair%%:*}; _mp_chain=${_mp_pair#*:}
    "${_mp_cmd}" -t "${_mp_table}" -C OUTPUT -j "${_mp_chain}" 2>/dev/null || return 1
    if [ "${_mp_table}" = mangle ]; then
      [ "$("${_mp_cmd}" -t "${_mp_table}" -S OUTPUT 2>/dev/null | awk '$1=="-A" {last=$0} END {print last}')" = "-A OUTPUT -j ${_mp_chain}" ] || return 1
    else
      [ "$("${_mp_cmd}" -t "${_mp_table}" -S OUTPUT 2>/dev/null | awk '$1=="-A" {print; exit}')" = "-A OUTPUT -j ${_mp_chain}" ] || return 1
    fi
    "${_mp_cmd}" -t "${_mp_table}" -C "${_mp_chain}" -m owner --uid-owner 0 --gid-owner "${MODERN_UPSTREAM_GID}" -j RETURN 2>/dev/null || return 1
  done
  for _mp_proto in udp tcp; do
    "${_mp_cmd}" -t mangle -C "${MODERN_QUEUE_CHAIN}" -p "${_mp_proto}" --dport 53 \
      -j NFQUEUE --queue-num "${MODERN_QUEUE}" --queue-bypass 2>/dev/null || return 1
    "${_mp_cmd}" -t nat -C "${MODERN_CAPTURE_CHAIN}" -p "${_mp_proto}" --dport 53 \
      -m mark --mark "${MODERN_CAPTURE}" -j REDIRECT --to-ports "${_mp_port}" 2>/dev/null || return 1
  done
}

modern_rules_exist() {
  for _me_cmd in iptables ip6tables; do
    "${_me_cmd}" -t nat -S "${MODERN_CAPTURE_CHAIN}" >/dev/null 2>&1 && return 0
    "${_me_cmd}" -t mangle -S "${MODERN_QUEUE_CHAIN}" >/dev/null 2>&1 && return 0
  done
  return 1
}

# The capture bit is reserved only while transparent mode is active. Refuse
# known rule/route users of that bit, including broad masks that would erase
# it after the queue. Socket marks can still change later; the native helper
# treats an observed collision as a fatal capability loss and stops capture.
modern_capture_safe() {
  {
    for _mb_cmd in iptables ip6tables; do
      for _mb_table in mangle nat filter; do "${_mb_cmd}" -t "${_mb_table}" -S 2>/dev/null; done
    done
    ip -4 rule show 2>/dev/null
    ip -6 rule show 2>/dev/null
  } | awk -v queue="${MODERN_QUEUE_CHAIN}" -v capture="${MODERN_CAPTURE_CHAIN}" '
    function num(s, result,i,c) {
      if(s ~ /^0[xX][0-9a-fA-F]+$/) {
        s=tolower(substr(s,3)); result=0
        for(i=1;i<=length(s);i++) { c=index("0123456789abcdef",substr(s,i,1))-1; result=result*16+c }
        return result
      }
      if(s ~ /^[0-9]+$/) return s+0
      return -1
    }
    function bit(s,n) {n=num(s); return n>=0 && int(n/536870912)%2==1}
    function masked(s,parts,n) { n=split(s,parts,"/"); return n<2 || bit(parts[2]) }
    $1=="-A" && ($2==queue || $2==capture) {next}
    {
      for(i=1;i<=NF;i++) {
        if(($i=="--mark" || $i=="fwmark" || $i=="--set-mark" || $i=="--set-xmark") && masked($(i+1))) bad=1
        if(($i=="--or-mark" || $i=="--xor-mark") && bit($(i+1))) bad=1
        if($i=="--and-mark" && !bit($(i+1))) bad=1
        if($i=="--restore-mark" || $i=="--save-mark") {
          mask="0xffffffff"
          for(j=i+1;j<=NF;j++) if($j=="--nfmask") mask=$(j+1)
          if(bit(mask)) bad=1
        }
      }
    }
    END {exit bad ? 1 : 0}'
}

modern_packet_policy_safe() {
  for _pp_cmd in iptables ip6tables; do
    if [ "${_pp_cmd}" = ip6tables ]; then
      [ "${IPV6}" = on ] && ipv6_nat_available || continue
    fi
    modern_family_policy_safe "${_pp_cmd}" || return 1
  done
}

modern_listener_ready() {
  _ml_state=
  _ml_pids=$(modern_pids)
  [ -n "${_ml_pids}" ] && [ -r "${MODERN_STATE}" ] || return 1
  _ml_state=$("${MODERN_BIN}" health --config "${MODERN_CONF}" 2>/dev/null) || return 1
  printf '%s' "${_ml_state}" | jqr -e --arg pids " ${_ml_pids} " '
    . as $s | $s.ready == true and ($s.pid | type == "number")
    and (($pids | [splits("[[:space:]]+")]) | index($s.pid | tostring) != null)' \
    >/dev/null 2>&1
}

modern_queue_ready() {
  modern_listener_ready && printf '%s' "${_ml_state}" | jqr -e '.queueReady == true' >/dev/null 2>&1
}

modern_stop_process() {
  modern_guard_stop || return 1
  _mk_pids=$(modern_pids)
  [ -z "${_mk_pids}" ] || stop_by_pids foxydns "${_mk_pids}" || return 1
  [ -z "$(modern_pids)" ] || return 1
  rm -f "${MODERN_STATE}"
}

modern_guard_alive() {
  _ga_owner=$(readlink "${MODERN_GUARD}" 2>/dev/null)
  [ -n "${_ga_owner}" ] && _conf_owner_alive "${_ga_owner}"
}

modern_guard_stop() {
  _gs_owner=$(readlink "${MODERN_GUARD}" 2>/dev/null)
  [ -n "${_gs_owner}" ] || return 0
  _gs_pid=${_gs_owner%%:*}
  if _conf_owner_alive "${_gs_owner}"; then
    # Exact script argv and start time protect against PID reuse or a foreign
    # process. The guard never calls this stop path for itself.
    _gs_args=$(_proc_cmdline "${_gs_pid}")
    printf '%s\n' "${_gs_args}" | grep -qxF -- "${TS_SCRIPTS_DIR}/foxytail.dns" || return 1
    printf '%s\n' "${_gs_args}" | grep -qxF -- guard || return 1
    stop_by_pids foxydns-guard "${_gs_pid}" || return 1
  fi
  [ "$(readlink "${MODERN_GUARD}" 2>/dev/null)" != "${_gs_owner}" ] || rm -f "${MODERN_GUARD}"
}

modern_guard_start() {
  modern_guard_alive && return 0
  rm -f "${MODERN_GUARD}"
  nohup "${TS_SCRIPTS_DIR}/foxytail.dns" guard >>"${TS_RUN_DIR}/foxydns.log" 2>&1 </dev/null &
  _gg_wait=0
  while ! modern_guard_alive; do
    _gg_wait=$((_gg_wait + 1))
    [ "${_gg_wait}" -lt 20 ] || return 1
    sleep 0.1
  done
}

modern_guard_health() {
  [ "$(_proc_starttime "${_GUARD_HELPER_PID}")" = "${_GUARD_HELPER_STAMP}" ] &&
    _gh_state=$("${MODERN_BIN}" health --config "${MODERN_CONF}" --instance "${_GUARD_HELPER_INSTANCE}" 2>/dev/null) &&
    printf '%s' "${_gh_state}" | jqr -e '.ready == true and .queueReady == true' >/dev/null 2>&1
}

modern_guard_cleanup() {
  if [ -n "${_GUARD_WATCH_PID:-}" ]; then
    _conf_owner_alive "${_GUARD_WATCH_PID}:${_GUARD_WATCH_STAMP}" && kill "${_GUARD_WATCH_PID}" 2>/dev/null
    wait "${_GUARD_WATCH_PID}" 2>/dev/null
  fi
  [ "${_GUARD_LOCK_HELD:-0}" != 1 ] || modern_unlock
  [ "$(readlink "${MODERN_GUARD}" 2>/dev/null)" != "${_GUARD_TOKEN}" ] || rm -f "${MODERN_GUARD}"
}

# One native monitor keeps the existing two-second health cadence entirely in
# memory. The shell wakes only on failure; no heartbeat files, jq/date/sleep
# children or iptables inventory occur on its healthy path.
modern_dns_guard() {
  ensure_run_dirs
  _GUARD_TOKEN="$$:$(_conf_pid_stamp "$$")"
  ln -s "${_GUARD_TOKEN}" "${MODERN_GUARD}" 2>/dev/null || return 0
  trap 'modern_guard_cleanup' 0
  trap 'exit 0' HUP INT TERM
  _GUARD_HELPER_PID=$(jqr -e -r '.pid | select(type == "number" and . > 0)' "${MODERN_STATE}" 2>/dev/null) || return 1
  _GUARD_HELPER_STAMP=$(_proc_starttime "${_GUARD_HELPER_PID}")
  [ -n "${_GUARD_HELPER_STAMP}" ] || return 1
  _GUARD_HELPER_INSTANCE=$(jqr -e -r '.instance | select(type == "string" and length > 0)' "${MODERN_STATE}" 2>/dev/null) || return 1
  "${MODERN_BIN}" watch --config "${MODERN_CONF}" --instance "${_GUARD_HELPER_INSTANCE}" --parent "$$" &
  _GUARD_WATCH_PID=$!
  _GUARD_WATCH_STAMP=$(_conf_pid_stamp "${_GUARD_WATCH_PID}")
  wait "${_GUARD_WATCH_PID}"
  _GUARD_WATCH_PID=
  # A killed/broken monitor must also withdraw capture, even if the listener
  # still responds. The ordinary watchdog can later reconcile a fresh guard.
  while :; do
    modern_lock || { isleep 2; continue; }
    _GUARD_LOCK_HELD=1
    _gg_reason=queue-failed
    modern_guard_health && _gg_reason=guard-failed
    if modern_rules_teardown; then
      modern_reason "${_gg_reason}" "$(cat "${MODERN_POLICY}" 2>/dev/null)"
      modern_unlock; _GUARD_LOCK_HELD=0
      return 0
    fi
    modern_reason cleanup-failed "$(cat "${MODERN_POLICY}" 2>/dev/null)"
    modern_unlock; _GUARD_LOCK_HELD=0
    isleep 2
  done
}

modern_dns_stop() (
  ensure_run_dirs
  modern_lock || return 1
  trap 'modern_unlock' 0
  trap 'exit 1' HUP INT TERM
  _md_rc=0
  modern_rules_teardown || _md_rc=1
  # A listener must remain while an owned REDIRECT still exists.
  if [ "${_md_rc}" = 0 ]; then modern_stop_process || _md_rc=1; fi
  modern_pref_restore || _md_rc=1
  if [ "${_md_rc}" = 0 ]; then
    # A pending restore (daemon-down) must survive the stop so the next
    # reconcile can finish flipping accept-dns back. All other outcomes are
    # final and safe to forget.
    if [ "$(cat "${MODERN_REASON}" 2>/dev/null)" = restore-pending ]; then
      rm -f "${MODERN_MODE}"
    else
      modern_reason stopped restored
      rm -f "${MODERN_MODE}"
    fi
  fi
  return "${_md_rc}"
)

modern_dns_start() (
  ensure_run_dirs
  load_runtime_conf || return 1
  modern_lock || return 1
  trap 'modern_unlock' 0
  trap 'exit 1' HUP INT TERM
  # Account mutations stop DNS before changing profile identity. The marker
  # blocks a concurrent watchdog from claiming the departing profile again.
  if [ -L "${TS_RUN_DIR}/dns-account-transition" ]; then
    _mn_transition=$(readlink "${TS_RUN_DIR}/dns-account-transition" 2>/dev/null)
    if [ -n "${_mn_transition}" ] && _conf_owner_alive "${_mn_transition}"; then return 0; fi
    rm -f "${TS_RUN_DIR}/dns-account-transition"
  fi
  [ "${MAGIC_DNS}" = on ] || return 0
  _mn_context=$(current_dns_context)
  if [ -z "${_mn_context}" ]; then
    modern_rules_teardown || return 1
    modern_stop_process || return 1
    modern_pref_restore || return 1
    modern_reason tailnet-unavailable restored
    return 0
  fi
  # Transition from the compatibility path only touches our old resolver.
  redirect_teardown && redirect6_teardown || return 1
  _mn_old=$(dns_pids)
  [ -z "${_mn_old}" ] || stop_by_pids dnsmasq "${_mn_old}" || return 1
  if [ ! -x "${MODERN_BIN}" ]; then
    modern_rules_teardown || return 1
    modern_stop_process || return 1
    modern_pref_restore || return 1
    modern_reason missing-binary restored
    return 0
  fi
  _mn_mode=local
  _mn_degraded_reason=transparent-unavailable
  if [ "${DNS_MODE}" = transparent ]; then
    # A running queue already owns its number; probing it would falsely fail.
    if ! modern_packet_policy_safe; then
      _mn_degraded_reason=packet-policy-conflict
    elif ! modern_capture_safe; then
      _mn_degraded_reason=capture-mark-conflict
    elif modern_queue_ready; then
      modern_record_capabilities "$(jqr -n -c --arg boot "$(modern_boot_id)" '{ok:true,reason:"queue-active",bootId:$boot}')" || return 1
      _mn_mode=transparent
    elif modern_probe_capabilities; then
      _mn_mode=transparent
    fi
  fi
  _mn_v6=false; [ "${IPV6}" != on ] || _mn_v6=true
  _mn_config=$(jqr -n -c --arg listen "127.0.0.1:${DNS_PORT}" --arg mode "${_mn_mode}" \
    --arg context "${DNS_CONTEXT_FILE}" --arg state "${MODERN_STATE}" --argjson v6 "${_mn_v6}" --argjson queue "${MODERN_QUEUE}" \
    '{listen:$listen,ipv6:$v6,mode:$mode,queue:$queue,contextFile:$context,stateFile:$state}') || return 1
  _mn_changed=false
  if [ "$(cat "${DNS_CONTEXT_FILE}" 2>/dev/null)" != "${_mn_context}" ] ||
    [ "$(cat "${MODERN_CONF}" 2>/dev/null)" != "${_mn_config}" ] || ! modern_listener_ready; then
    modern_rules_teardown || return 1
    modern_stop_process || return 1
    (umask 077; printf '%s\n' "${_mn_context}" >"${DNS_CONTEXT_FILE}" && printf '%s\n' "${_mn_config}" >"${MODERN_CONF}") || return 1
    if ! tmo 5 "${MODERN_BIN}" check --config "${MODERN_CONF}" >/dev/null 2>&1; then
      modern_pref_restore || return 1
      modern_reason invalid-config restored
      return 1
    fi
    printf '%s\n' "${DNS_MODE}" >"${MODERN_MODE}" || return 1
    rotate_log "${TS_RUN_DIR}/foxydns.log"
    nohup "${MODERN_BIN}" serve --config "${MODERN_CONF}" --state "${MODERN_STATE}" >>"${TS_RUN_DIR}/foxydns.log" 2>&1 &
    _mn_wait=0
    while ! modern_listener_ready; do
      _mn_wait=$((_mn_wait + 1))
      [ "${_mn_wait}" -lt 20 ] || break
      sleep 0.1
    done
    if ! modern_listener_ready; then
      modern_pref_restore || return 1
      modern_reason listener-failed restored
      return 1
    fi
    _mn_changed=true
  fi
  modern_pref_claim
  _mn_claim=$?
  if [ "${_mn_claim}" != 0 ]; then
    modern_rules_teardown || return 1
    [ "${_mn_claim}" = 2 ] && return 0
    return 1
  fi
  # The Android backend removes its own DNAT asynchronously. Do not announce
  # coexistence while that older global interceptor still owns ordinary DNS.
  if native_dns_present; then
    modern_rules_teardown || return 1
    modern_reason native-policy-unavailable native-rules-pending
    return 1
  fi
  if [ "${DNS_MODE}" = transparent ] && dns_hijack_conflict; then
    # A root DNS interceptor may exempt this helper's uid, making replay miss
    # the original app's DNS policy. Leave that policy intact and provide only
    # the explicit local endpoint. VpnService routing alone is not a conflict.
    modern_rules_teardown || return 1
    modern_guard_stop || return 1
    modern_reason dns-interception-conflict owned
    printf '%s\n' "${DNS_MODE}" >"${MODERN_MODE}"
    return 0
  fi
  _mn_reason=local
  if [ "${DNS_MODE}" = transparent ] && modern_queue_ready; then
    _mn_v6_nat=false
    [ "${IPV6}" != on ] || ! ensure_ipv6_nat || _mn_v6_nat=true
    if ! modern_rules_present iptables || { [ "${_mn_v6_nat}" = true ] && ! modern_rules_present ip6tables; }; then
      modern_rules_teardown || return 1
      if ! modern_rules_family iptables || { [ "${_mn_v6_nat}" = true ] && ! modern_rules_family ip6tables; }; then
        modern_rules_teardown || return 1
        modern_pref_restore || return 1
        modern_reason interception-failed restored
        return 1
      fi
      _mn_changed=true
    fi
    _mn_reason=running
    [ "${IPV6}" != on ] || [ "${_mn_v6_nat}" = true ] || _mn_reason=ipv6-unavailable
    if ! modern_guard_start; then
      modern_rules_teardown || return 1
      modern_reason guard-failed owned
      return 1
    fi
  else
    modern_rules_teardown || return 1
    modern_guard_stop || return 1
    [ "${DNS_MODE}" != transparent ] || _mn_reason="${_mn_degraded_reason}"
  fi
  modern_reason "${_mn_reason}" owned
  printf '%s\n' "${DNS_MODE}" >"${MODERN_MODE}" || return 1
  [ "${_mn_changed}" != true ] || flush_android_dns_cache || :
  return 0
)

modern_runtime_active() {
  [ -e "${MODERN_MODE}" ] || [ -e "${MODERN_STATE}" ] || [ -e "${MODERN_CONF}" ] || return 1
  [ -n "$(modern_pids)" ] && return 0
  modern_rules_exist && return 0
  case "$(cat "${MODERN_REASON}" 2>/dev/null)" in restore-pending|cleanup-failed) return 0 ;; esac
  return 1
}

modern_dns_status() {
  _mo_mode=${DNS_MODE}
  _mo_active_mode=$(cat "${MODERN_MODE}" 2>/dev/null)
  [ -n "${_mo_active_mode}" ] || _mo_active_mode=$(jqr -r '.mode // ""' "${MODERN_CONF}" 2>/dev/null)
  case "${_mo_active_mode}" in local|transparent) _mo_mode=${_mo_active_mode} ;; esac
  _mo_pending=false; [ "${_mo_mode}" = "${DNS_MODE}" ] || _mo_pending=true
  _mo_port=$(jqr -r '.listen | split(":") | last | tonumber' "${MODERN_CONF}" 2>/dev/null)
  case "${_mo_port}" in ''|*[!0-9]*) _mo_port=${DNS_PORT} ;; esac
  _mo_ready=false; modern_listener_ready && _mo_ready=true
  _mo_queue=false
  [ "${_mo_ready}" != true ] || ! printf '%s' "${_ml_state}" | jqr -e '.queueReady == true' >/dev/null 2>&1 || _mo_queue=true
  _mo_v4=false; [ "${_mo_queue}" != true ] || ! modern_rules_present iptables "${_mo_port}" || _mo_v4=true
  _mo_v6=false; [ "${_mo_queue}" != true ] || ! modern_rules_present ip6tables "${_mo_port}" || _mo_v6=true
  _mo_reason=$(cat "${MODERN_REASON}" 2>/dev/null)
  _mo_policy=$(cat "${MODERN_POLICY}" 2>/dev/null)
  _mo_expect_capture=false
  case "${_mo_reason}" in running|ipv6-unavailable|interception-lost|guard-failed) _mo_expect_capture=true ;; esac
  _mo_state=stopped; _mo_repair=false
  if [ "${MAGIC_DNS}" = on ]; then
    _mo_state=degraded
    if [ "${_mo_ready}" = true ]; then
      case "${_mo_reason}" in
        running|local|transparent-unavailable|capture-mark-conflict|packet-policy-conflict|dns-interception-conflict|ipv6-unavailable) _mo_state=running ;;
        native-policy-unavailable|restore-pending|cleanup-failed) _mo_repair=true ;;
      esac
      if [ "${_mo_mode}" = transparent ] && [ "${_mo_queue}" != true ] && [ "${_mo_state}" = running ]; then
        case "${_mo_reason}" in capture-mark-conflict|packet-policy-conflict|dns-interception-conflict) ;; *) _mo_reason=transparent-unavailable ;; esac
        if modern_rules_exist; then
          _mo_state=degraded; _mo_reason=queue-failed; _mo_repair=true
        fi
      fi
      _mo_context=$(current_dns_context)
      if [ -z "${_mo_context}" ] || [ "$(cat "${DNS_CONTEXT_FILE}" 2>/dev/null)" != "${_mo_context}" ]; then
        _mo_state=degraded; _mo_reason=context-changed; _mo_repair=true
      elif [ "${_mo_mode}" = transparent ] && [ "${_mo_expect_capture}" = true ] && [ "${_mo_queue}" = true ] && [ "${_mo_policy}" = owned ] &&
        { [ "${_mo_v4}" != true ] || { [ "${IPV6}" = on ] && ipv6_nat_available && [ "${_mo_v6}" != true ]; }; }; then
        _mo_state=degraded; _mo_reason=interception-lost; _mo_repair=true
      elif [ "${_mo_v4}" = true ] && ! modern_guard_alive; then
        _mo_state=degraded; _mo_reason=guard-failed; _mo_repair=true
      fi
    else
      case "${_mo_reason}" in missing-binary|invalid-config|listener-failed) ;; *) _mo_repair=true ;; esac
      [ -n "${_mo_reason}" ] || _mo_reason=apply-pending
    fi
  elif [ "${_mo_ready}" = true ] || [ "${_mo_v4}" = true ] || [ "${_mo_v6}" = true ]; then
    _mo_state=degraded; _mo_reason=disable-pending; _mo_repair=true
  else
    _mo_reason=disabled
  fi
  _mo_suffix=$(jqr -r '.suffix // ""' "${DNS_CONTEXT_FILE}" 2>/dev/null)
  _mo_native=false; native_dns_present && _mo_native=true
  if [ "${_mo_native}" = true ] && [ "${MAGIC_DNS}" = on ] && [ "${_mo_policy}" = owned ]; then
    _mo_state=degraded; _mo_reason=native-policy-changed; _mo_repair=true
    _mo_v4=false; _mo_v6=false
  fi
  if { [ "${_mo_v4}" = true ] || [ "${_mo_v6}" = true ]; } && dns_hijack_conflict; then
    _mo_state=degraded; _mo_reason=dns-interception-conflict; _mo_repair=true
    _mo_v4=false; _mo_v6=false
  fi
  _mo_capability_error=
  _mo_ta=null; _mo_ta_reason=
  _mo_ta_cache=$(modern_cached_capabilities)
  if [ -n "${_mo_ta_cache}" ]; then
    if [ "$(printf '%s' "${_mo_ta_cache}" | jqr -r '.ok')" = true ]; then
      _mo_ta=true
    else
      _mo_ta=false
      _mo_ta_reason=$(printf '%s' "${_mo_ta_cache}" | jqr -r '.error | select(type == "string" and length > 0) | gsub("[[:cntrl:]]";" ") | .[0:512]' 2>/dev/null)
    fi
  fi
  if [ "${_mo_mode}" = transparent ]; then
    _mo_capability_error=$(printf '%s' "${_ml_state:-}" | jqr -r '(.error // "") | select(type == "string") | gsub("[[:cntrl:]]";" ") | .[0:512]' 2>/dev/null)
    if [ -z "${_mo_capability_error}" ] && [ "${_mo_reason}" = transparent-unavailable ]; then
      _mo_capability_error=${_mo_ta_reason}
    fi
  fi

  if [ "${1:-}" = --json ]; then
    jqr -n -c --arg state "${_mo_state}" --arg mode "${_mo_mode}" --arg configured "${DNS_MODE}" --argjson pending "${_mo_pending}" \
      --arg reason "${_mo_reason}" --arg policy "${_mo_policy:-unknown}" \
      --arg suffix "${_mo_suffix}" --arg binary "${MODERN_BIN}" --argjson port "${_mo_port}" --arg enabled "${MAGIC_DNS}" \
      --argjson ready "${_mo_ready}" --argjson v4 "${_mo_v4}" --argjson v6 "${_mo_v6}" --argjson repair "${_mo_repair}" \
      --argjson native "${_mo_native}" --arg module "$(ipv6_module_status)" --arg ipv6 "${IPV6}" \
      --arg capabilityError "${_mo_capability_error}" \
      --argjson ta "${_mo_ta}" --arg taReason "${_mo_ta_reason}" \
      '{state:$state,mode:$mode,configuredMode:$configured,pendingMode:$pending,reason:$reason,policyState:$policy,suffix:$suffix,port:$port,binary:$binary,
        enabled:($enabled=="on"),listenerReady:$ready,interception4:$v4,interception6:$v6,repairNeeded:$repair,
        upstreamNative:$native,ipv6ModuleStatus:$module,capabilityError:(if $capabilityError=="" then null else $capabilityError end),
        transparentAvailable:$ta,transparentUnavailableReason:(if $taReason=="" then null else $taReason end),
        ipv6DnsInterception:(if $v6 then "available" elif $ipv6!="on" then "disabled" else "fallback" end)}'
  else
    printf 'MagicDNS: %s (%s), 127.0.0.1:%s; %s\n' "${_mo_state}" "${_mo_mode}" "${_mo_port}" "${_mo_reason}"
  fi
}
