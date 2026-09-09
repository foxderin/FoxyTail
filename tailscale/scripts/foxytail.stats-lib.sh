#!/system/bin/sh
# Function definitions only; caller supplies settings and runtime paths.

# _date_lt <a> <b>: true when date string a sorts before b (YYYY-MM-DD).
# POSIX-safe: test's \< / \> are undefined in POSIX sh (SC3012).
_date_lt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort | head -n 1)" = "$1" ]
}

# _in_retention <file> <basename> <cut-epoch> <cut-date>: true when the
# stats file is inside the retention window. Primary comparison is by the
# file-name date; when `date -d @epoch` is unavailable (some busybox/toybox
# builds) fall back to the file mtime, warning instead of silently skipping.
_in_retention() {
  _ir_file="$1"
  _ir_base="$2"
  _ir_cut_epoch="$3"
  _ir_cut="$4"
  if [ -n "${_ir_cut}" ]; then
    ! _date_lt "${_ir_base}" "${_ir_cut}"
    return
  fi
  _ir_mt=$(stat -c %Y "${_ir_file}" 2>/dev/null)
  case "${_ir_mt}" in
    '' | *[!0-9]*)
      log Warning "stats: cannot determine age of ${_ir_file}; treating it as inside the window."
      return 0
      ;;
  esac
  [ "${_ir_mt}" -ge "${_ir_cut_epoch}" ]
}

# Print the retention cutoff: "<epoch> <YYYY-MM-DD>" (date empty when the
# local date(1) cannot convert epochs).
_stats_cutoff() {
  _sco_epoch=$(( $(date +%s) - RETENTION_DAYS * 86400 ))
  _sco_date=$(date -d "@${_sco_epoch}" +%F 2>/dev/null)
  echo "${_sco_epoch} ${_sco_date}"
}

# Delete stats files older than RETENTION_DAYS.
prune_stats() {
  _ps_failed=0
  _ps_cut=$(_stats_cutoff)
  # shellcheck disable=SC2086 # intentional: "<epoch> <date>" splits into $1/$2
  set -- ${_ps_cut}
  if [ -z "${2:-}" ]; then
    log Warning "stats: 'date -d @epoch' unsupported; pruning by file mtime instead."
  fi
  for _f in "${TS_STATS_DIR}"/????-??-??.jsonl; do
    [ -f "$_f" ] || continue
    _base=$(basename "$_f" .jsonl)
    if ! _in_retention "$_f" "$_base" "$1" "${2:-}"; then
      rm -f "$_f" || _ps_failed=1
    fi
  done
  return "$_ps_failed"
}

# Print the paths of stats files inside the retention window, oldest first.
stats_recent_files() {
  _srf_cut=$(_stats_cutoff)
  # shellcheck disable=SC2086 # intentional: "<epoch> <date>" splits into $1/$2
  set -- ${_srf_cut}
  for _f in "${TS_STATS_DIR}"/????-??-??.jsonl; do
    [ -f "$_f" ] || continue
    _base=$(basename "$_f" .jsonl)
    if _in_retention "$_f" "$_base" "$1" "${2:-}"; then
      echo "$_f"
    fi
  done | sort
}

# Retention maintenance is independent of sample frequency. Retry a failed
# cleanup after an hour; a date transition always gets a fresh attempt.
stats_maintain() {
  if [ "${_stats_maintenance_day:-}" = "$_day" ]; then
    [ "${_stats_maintenance_retry:-0}" -ne 0 ] || return 0
    [ "$_ts" -ge "$_stats_maintenance_retry" ] || return 0
  fi
  _stats_maintenance_day=$_day
  _stats_maintenance_retry=0
  if ! prune_stats; then
    _stats_maintenance_retry=$((_ts + 3600))
    log Warning "stats: retention cleanup failed; will retry in one hour"
  fi
}

# Repair legacy modes once when opening a day's file, and again if it was
# removed. The resident's umask protects new files without per-sample chmod.
stats_prepare_file() {
  if [ "${_stats_open_file:-}" != "$_file" ] || [ ! -f "$_file" ]; then
    (umask 027; : >>"$_file") && chmod 0640 "$_file" || return 1
    _stats_open_file=$_file
  fi
}

stats_interface_json() {
  _si_rx=$(cat "$1/statistics/rx_bytes" 2>/dev/null)
  _si_tx=$(cat "$1/statistics/tx_bytes" 2>/dev/null)
  case "$_si_rx:$_si_tx" in
    :*|*:|*[!0-9:]*) echo null ;;
    *) printf '{"rx":%s,"tx":%s}\n' "$_si_rx" "$_si_tx" ;;
  esac
}

stats_uid_json() {
  _su_rows=$(
    for _su_cmd in iptables ip6tables; do
      # Use applied ownership, since desired IPV6 may already differ during a
      # mode change. Without a completed snapshot probe for upgrade support.
      if [ -s "${TS_RUN_DIR}/route.snapshot/generation" ] &&
        [ ! -f "${TS_RUN_DIR}/route.snapshot/${_su_cmd}.filter" ]; then
        continue
      fi
      _su_family=$("$_su_cmd" -t filter -nvxL FOXY_STAT 2>/dev/null) || exit 1
      printf '%s\n' "$_su_family" |
        awk '/owner UID match/ { for(i=1;i<=NF;i++) if($i=="match") print $2, $(i+1) }'
    done
  ) || { echo null; return 0; }
  # One unavailable family makes the aggregate missing, not a smaller counter
  # that the delta reader could incorrectly interpret as a counter reset.
  printf '%s\n' "$_su_rows" | jqr -R -s -c 'split("\n") | map(select(length > 0) | split(" ")
      | {uid:.[1],rx:0,tx:(.[0] | tonumber)}) | group_by(.uid)
      | map({uid:.[0].uid,rx:0,tx:(map(.tx)|add)})'
}

collect_once() {
  [ ! -f "${TS_RUN_DIR}/manual-stop" ] || return 0
  _ts=$(date +%s)
  _day=$(date +%F)
  _file="${TS_STATS_DIR}/${_day}.jsonl"

  _status=$(tmo 10 tailscale --socket="$TS_SOCKET" status --json 2>/dev/null)
  # A stop may have arrived during the bounded RPC. Do not record it as a
  # daemon failure or perform maintenance for a deliberately stopped service.
  [ ! -f "${TS_RUN_DIR}/manual-stop" ] || return 0
  stats_maintain
  stats_prepare_file || { log Error "stats: cannot prepare sample file"; return 1; }
  if [ -z "$_status" ] || ! printf '%s' "$_status" | jqr -e . >/dev/null 2>&1; then
    if echo "{\"ts\":${_ts},\"error\":\"daemon-unreachable\"}" >>"$_file"; then return 0; else return 1; fi
  fi
  _peers=$(printf '%s' "$_status" | jqr -c \
    '[.Peer // {} | .[] | {id:(.ID|tostring),rx:(.RxBytes // 0),tx:(.TxBytes // 0)}]')

  _iface="null"
  if [ -d /sys/class/net/tailscale0 ]; then
    _iface=$(stats_interface_json /sys/class/net/tailscale0)
  fi

  # OUTPUT counters measure only TX through tailscale0. Read both families;
  # RETURN rules are mutually exclusive per UID and reach the terminal rule.
  _uids=$(stats_uid_json)

  _daemon_generation=$(for _sg_pid in $(pids_of_path "${TS_BIN_DIR}/tailscaled"); do
    printf '%s:' "${_sg_pid}"
    awk '{print $22}' "/proc/${_sg_pid}/stat" 2>/dev/null
  done)
  _iface_generation=""
  if [ "$_iface" != null ]; then
    _iface_generation=$(cat /sys/class/net/tailscale0/ifindex 2>/dev/null)
  fi
  _uid_generation=$(cat "${TS_RUN_DIR}/route.snapshot/generation" 2>/dev/null)
  jqr -n -c --argjson ts "$_ts" --argjson peers "$_peers" \
    --argjson iface "$_iface" --argjson uids "$_uids" \
    --arg dg "${_daemon_generation}" --arg ig "${_iface_generation}" --arg ug "${_uid_generation}" \
    '{ts:$ts,peers:$peers,iface:$iface,uids:$uids,uidDirection:"tx",
      generation:{peers:$dg,iface:$ig,uids:$ug}}' >>"$_file"
}

_stats_stop() {
  _stats_running=0
}

do_start() {
  daemon_claim_pidfile foxytail.stats || return 0
  _stats_running=1
  trap '_stats_stop' TERM INT
  log Info "foxytail.stats started (pid $$, interval ${STATS_INTERVAL}s)"
  while [ "$_stats_running" = "1" ]; do
    # Keep a cheap marker check at the configured interval while stopped.
    # No RPC, configuration parsing, dumpsys, or sample/error writes here.
    # Once this branch is reached, clearing the marker resumes within one
    # normal interval. An already active screen-off sleep keeps its old bound.
    if [ -f "${TS_RUN_DIR}/manual-stop" ]; then
      isleep "$STATS_INTERVAL"
      continue
    fi
    load_conf || { log Error "stats: invalid configuration"; break; }
    collect_once
    _int="${STATS_INTERVAL}"
    is_screen_on || _int=$((_int * 5))
    isleep "$_int"
  done
  rm -f "$PID_FILE"
  log Info "foxytail.stats stopped"
  return 0
}

do_stop() {
  daemon_stop_pidfile foxytail.stats
}

do_status() {
  _st_pid=$(cat "$PID_FILE" 2>/dev/null)
  case "${_st_pid}" in '' | *[!0-9]*) _st_pid="" ;; esac
  if [ -n "${_st_pid}" ] && kill -0 "${_st_pid}" 2>/dev/null; then
    jqr -n -c --argjson r true --argjson p "${_st_pid}" \
      --argjson i "${STATS_INTERVAL}" --arg d "$TS_STATS_DIR" \
      '{running:$r,pid:$p,interval:$i,dir:$d}'
  else
    jqr -n -c --argjson r false --argjson i "${STATS_INTERVAL}" \
      --arg d "$TS_STATS_DIR" '{running:$r,pid:null,interval:$i,dir:$d}'
  fi
}

# Compute adjacent deltas before assigning buckets. A decrease or a known
# generation change starts a new counter segment; the first sample is only a
# baseline. The interval is attributed to its ending sample (including across
# midnight). Missing/error samples are not fabricated as zero traffic.
stats_deltas() {
  for _sd_file in $(stats_recent_files); do cat "${_sd_file}"; done |
    jqr -R -s -c '
      def delta($old; $new; $changed):
        if $old == null then 0
        elif $changed or $new < $old then $new
        else $new - $old end;
      def pair($old; $new; $changed):
        {rx:delta($old.rx; ($new.rx // 0); $changed),
         tx:delta($old.tx; ($new.tx // 0); $changed)};
      split("\n") | map(select(length>0) | fromjson? | select(type=="object")
        | select(.error==null and (.ts|type)=="number")) | sort_by(.ts)
      | reduce .[] as $s ({lastIface:null,lastPeers:{},lastUids:{},rows:[]};
          . as $acc
          | ($s.generation // {}) as $gen
          | (if $s.iface == null then null else
              pair(.lastIface.value; $s.iface;
                .lastIface != null and ($gen.iface // "") != (.lastIface.gen // "")) end) as $iface
          | [ $s.peers[]? | . as $p | ($acc.lastPeers[$p.id]) as $old
              | pair($old.value; $p; $old != null and ($gen.peers // "") != ($old.gen // ""))
                + {id:$p.id} ] as $peers
          | [ $s.uids[]? | select($s.uidDirection == "tx") | . as $u
              | ($acc.lastUids[$u.uid|tostring]) as $old
              | pair($old.value; $u; $old != null and ($gen.uids // "") != ($old.gen // ""))
                + {uid:($u.uid|tostring)} ] as $uids
          | .rows += [{ts:$s.ts,iface:$iface,peers:$peers,uids:$uids}]
          | if $s.iface != null then .lastIface={value:$s.iface,gen:$gen.iface} else . end
          | reduce $s.peers[]? as $p (. ; .lastPeers[$p.id]={value:$p,gen:$gen.peers})
          | if $s.uidDirection == "tx" then
              reduce $s.uids[]? as $u (. ; .lastUids[$u.uid|tostring]={value:$u,gen:$gen.uids})
            else . end)
      | .rows'
}

query() {
  _q="$1"; shift
  case "$_q" in
    hourly)
      _d="$1"
      stats_deltas | jqr -c --arg d "$_d" '
        [ .[] | select((.ts|strflocaltime("%F"))==$d) ] as $s
        | {date:$d,attribution:"interval-end",hours:[range(0;24) | . as $h
            | [$s[] | select((.ts|strflocaltime("%H")|tonumber)==$h)] as $b
            | {hour:$h,samples:([$b[]|select(.iface!=null)]|length),
                iface:{rx:([$b[].iface.rx // 0]|add // 0),tx:([$b[].iface.tx // 0]|add // 0)},
                peers:([$b[].peers[]] | group_by(.id) | map(
                  {id:.[0].id,rx:(map(.rx)|add),tx:(map(.tx)|add)}))}]}'
      ;;
    daily)
      stats_deltas | jqr -c '
        group_by(.ts|strflocaltime("%F")) | {attribution:"interval-end",days:map(
          {date:(.[0].ts|strflocaltime("%F")),samples:([.[]|select(.iface!=null)]|length),
           rx:([.[].iface.rx // 0]|add // 0),tx:([.[].iface.tx // 0]|add // 0)})}'
      ;;
    topn|uids)
      _n="$1"; case "$_n" in ""|*[!0-9]*) _n=10 ;; esac
      stats_deltas | jqr -c --arg q "$_q" --argjson n "$_n" '
        if $q == "topn" then
          [.[].peers[]] | group_by(.id) | map(
            {id:.[0].id,rx:(map(.rx)|add),tx:(map(.tx)|add)})
          | map(select(.rx+.tx>0)) | sort_by(.rx+.tx) | reverse | {topn:.[0:$n]}
        else
          [.[].uids[]] | group_by(.uid) | map(
            {uid:.[0].uid,rx:0,tx:(map(.tx)|add)})
          | map(select(.tx>0)) | sort_by(.tx) | reverse | {uids:.[0:$n],direction:"tx"}
        end'
      ;;
    *) echo "usage: $0 query {hourly <YYYY-MM-DD>|daily|topn <n>|uids <n>}" >&2; return 1 ;;
  esac
}
