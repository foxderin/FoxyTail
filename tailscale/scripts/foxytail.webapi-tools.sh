#!/system/bin/sh
# Traffic, installed apps, diagnostics, logs and Taildrop.
# Sourced by foxytail.webapi.sh.

# --- traffic / apps -----------------------------------------------------------

cmd_traffic() {
  case "$1" in
    summary|hourly)
      _tr_date="$2"
      case "${_tr_date}" in
        '' | *[!0-9-]*) _tr_date=$(date +%F) ;;
      esac
      _tr_out=$(_op_exec 60 "${TS_SCRIPTS_DIR}/foxytail.stats" query "$1" "${_tr_date}" 2>/dev/null) || jerr 'traffic query failed or cancelled'
      ;;
    daily)
      _tr_out=$(_op_exec 60 "${TS_SCRIPTS_DIR}/foxytail.stats" query daily 2>/dev/null) || jerr 'traffic query failed or cancelled'
      ;;
    topn)
      _tr_n="$2"
      case "${_tr_n}" in '' | *[!0-9]*) _tr_n=10 ;; esac
      _tr_out=$(_op_exec 60 "${TS_SCRIPTS_DIR}/foxytail.stats" query topn "${_tr_n}" 2>/dev/null) || jerr 'traffic query failed or cancelled'
      ;;
    *)
      jerr "traffic: expected summary|hourly|daily|topn"
      ;;
  esac
  if [ -n "${_tr_out}" ] && printf '%s' "${_tr_out}" | jqr -e . >/dev/null 2>&1; then
    # Preserve an ok:false the helper emitted with a zero exit status; only
    # wrap payloads that carry no verdict of their own.
    printf '%s' "${_tr_out}" | jqr -c 'if type=="object" and .ok==false then . else . + {ok:true} end'
  else
    jerr "stats query failed (collector not running?)"
  fi
}

cmd_traffic_uids() {
  _tu_out=$(_op_exec 60 "${TS_SCRIPTS_DIR}/foxytail.stats" query uids 100000 2>/dev/null) || jerr "UID stats query failed"
  printf '%s' "${_tu_out}" | jqr -e . >/dev/null 2>&1 || jerr "UID stats query returned invalid JSON"
  printf '%s' "${_tu_out}" | jqr -c 'if type=="object" and .ok==false then . else . + {ok:true} end'
}

cmd_apps() {
  # Fast path: `pm list packages -3 -U` prints "package:<name> uid:<uid>" for
  # every app in a single binder call (Android 10+). The old per-package
  # dumpsys loop took minutes on devices with many apps.
  _ap_list=$(_op_exec 30 pm list packages -3 -U 2>/dev/null | tr -d '\r')
  _op_cancelled && jerr 'app scan cancelled'
  if printf '%s' "${_ap_list}" | grep -q ' uid:[0-9]'; then
    # One jq process for the complete package list. Spawning jq for every app
    # made an otherwise single-binder-call path take seconds on Android.
    printf '%s\n' "${_ap_list}" | jqr -R -s -c '
      split("\n") | map(capture("^package:(?<package>[^ ]+) uid:(?<uid>[0-9]+)(?: .*)?$")?
        | {label:.package,package:.package,uid:(.uid|tonumber)})
      | sort_by(.package) | {ok:true,apps:.}'
    return 0
  fi
  # Fallback for ancient pm without -U: per-package dumpsys loop.
  _ap_pkgs=$(_op_exec 30 pm list packages -3 2>/dev/null | sed 's/^package://' | tr -d '\r' | sort)
  _op_cancelled && jerr 'app scan cancelled'
  if [ -z "${_ap_pkgs}" ]; then
    echo '{"ok":true,"apps":[]}'
    return 0
  fi
  _ap_result=$(printf '%s\n' "${_ap_pkgs}" | while IFS= read -r _ap_pkg; do
    _op_cancelled && break
    [ -n "${_ap_pkg}" ] || continue
    _ap_uid=""
    _ap_dump=$(_op_exec 5 dumpsys package "${_ap_pkg}" </dev/null 2>/dev/null)
    if [ -n "${_ap_dump}" ]; then
      _ap_uid=$(printf '%s\n' "${_ap_dump}" | grep -o -m1 'userId=[0-9]*' | head -n 1 | cut -d= -f2)
      [ -n "${_ap_uid}" ] || _ap_uid=$(printf '%s\n' "${_ap_dump}" | grep -o -m1 'appId=[0-9]*' | head -n 1 | cut -d= -f2)
    fi
    case "${_ap_uid}" in ('' | *[!0-9]*) _ap_uid=0 ;; esac
    # dumpsys exposes only labelRes (a resource id), never the resolved label
    # string; without aapt the package name is the best available label.
    jqr -n -c --arg l "${_ap_pkg}" --arg p "${_ap_pkg}" --argjson u "${_ap_uid}" \
      '{label:$l,package:$p,uid:$u}'
  done | jqr -s -c '{ok:true,apps:.}')
  _op_cancelled && jerr 'app scan cancelled'
  printf '%s\n' "${_ap_result}"
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
    _cm_json=$(_op_exec 30 "${TS_SCRIPTS_DIR}/foxytail.compat" probe 2>/dev/null) || jerr 'compatibility probe failed or cancelled'
  fi
  _op_cancelled && jerr 'compatibility probe cancelled'
  if [ -z "${_cm_json}" ] || ! printf '%s' "${_cm_json}" | jqr -e . >/dev/null 2>&1; then
    _cm_json='{"modules":[],"apps":[],"warnings":[]}'
  fi
  _cm_alert=""
  [ -f "${COMPAT_ALERT}" ] && _cm_alert=$(cat "${COMPAT_ALERT}")
  printf '%s' "${_cm_json}" | jqr -c --arg a "${_cm_alert}" \
    '. + {ok:true, alert:(if $a == "" then null else $a end)}'
}

_diag_row() {
  jqr -n -c --arg id "$1" --arg level "$2" --arg reason "$3" --arg page "$4" \
    '{id:$id,level:$level,reason:$reason,page:$page}'
}

# Read-only, bounded probes. A stopped service is not a broken route; a
# missing/invalid response is never promoted to a healthy DNS result.
cmd_diag_check() {
  if ! load_runtime_conf; then
    _diag_row config fail invalid_config settings | jqr -s -c '{ok:true,checks:.}'
    return
  fi
  _dc_status=$(cmd_status) || _dc_status='{}'
  _dc_state=$(printf '%s' "$_dc_status" | jqr -r '.backend // "unknown"' 2>/dev/null)
  _dc_daemon=$(printf '%s' "$_dc_status" | jqr -r '.daemon // "unknown"' 2>/dev/null)
  _dc_rows=$(
    if [ -f "${TS_RUN_DIR}/settings.pending" ]; then
      _diag_row config warn pending settings
    else
      _diag_row config pass applied settings
    fi
    if [ "$_dc_daemon" = stopped ]; then
      _diag_row service warn stopped dashboard
    elif [ "$_dc_state" = Running ]; then
      _diag_row service pass connected dashboard
    else
      case "$_dc_state" in
        (NeedsLogin|NeedsMachineAuth) _diag_row service warn login account ;;
        (*) _diag_row service fail unreachable logs ;;
      esac
    fi
    if [ "$_dc_state" != Running ]; then
      _diag_row tunnel skip needs_connection dashboard
      _diag_row routes skip needs_connection dashboard
    else
      if [ "${TS_MODE}" = proxy ]; then
        _diag_row tunnel skip proxy tunnel
      elif ip link show dev "${TUN_IFACE}" >/dev/null 2>&1 &&
        { [ "${TS_MODE}" != bridge ] || [ -n "$(pids_of_path "${TS_BIN_DIR}/hev-socks5-tunnel")" ]; }; then
        _diag_row tunnel pass interface_ready tunnel
      else
        _diag_row tunnel fail interface_missing tunnel
      fi
      if [ "${TS_MODE}" != bridge ]; then
        _diag_row routes skip managed_routes routing
      elif _op_exec 10 "${TS_SCRIPTS_DIR}/foxytail.route" check >/dev/null 2>&1; then
        _diag_row routes pass routes_ready routing
      else
        _diag_row routes fail routes_incomplete routing
      fi
    fi
    if [ "${MAGIC_DNS}" != on ]; then
      _diag_row dns skip dns_disabled settings
    else
      _dc_dns=$(_op_exec 20 "${TS_SCRIPTS_DIR}/foxytail.dns" status --json 2>/dev/null) || _dc_dns='{}'
      _dc_reason=$(printf '%s' "$_dc_dns" | jqr -r '.reason // "unknown"' 2>/dev/null)
      case "$_dc_reason" in
        (*conflict*) _diag_row dns warn dns_conflict tunnel ;;
        (transparent-unavailable|ipv6-unavailable|private-dns) _diag_row dns warn dns_limited tunnel ;;
        (*)
          if dns_status_healthy "$_dc_dns"; then _diag_row dns pass dns_ready tunnel
          else _diag_row dns fail dns_unavailable tunnel; fi ;;
      esac
    fi
  )
  _op_cancelled && jerr 'diagnostics cancelled'
  printf '%s\n' "$_dc_rows" | jqr -s -c '{ok:true,checks:.}'
}

cmd_diag() {
  _dg_mode=${1:-share}
  case "$_dg_mode" in share|local) ;; *) jerr 'diag: expected share|local' ;; esac
  [ -x "${TS_SCRIPTS_DIR}/foxytail.diag" ] || jerr "foxytail.diag not found"
  # Local bundles are not anonymized; leave their destination to the private
  # default rather than publishing raw identities to shared storage.
  _dg_outdir=/sdcard/Download
  [ "$_dg_mode" = local ] && _dg_outdir=
  _dg_out=$(_op_exec 120 "${TS_SCRIPTS_DIR}/foxytail.diag" collect "$_dg_outdir" "$_dg_mode" 2>/dev/null) || jerr 'diag collection failed or cancelled'
  # Strip CR/LF and trim only surrounding whitespace: a generated path may
  # legitimately contain inner spaces.
  _dg_path=$(printf '%s\n' "${_dg_out}" | tail -n 1 | tr -d '\r\n' |
    sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [ -n "${_dg_path}" ] && [ -f "${_dg_path}" ]; then
    _dg_artifact=$(_artifact_register diagnostic "${_dg_path}") || jerr 'diag: cannot retain private export artifact'
    jqr -n -c --arg p "${_dg_path}" --arg mode "$_dg_mode" --arg id "${_dg_artifact}" '{ok:true,path:$p,mode:$mode,artifactId:$id}'
  else
    jerr "diag collection failed (see ${TS_RUN_LOG_FILE})"
  fi
}

# --- taildrop files ---------------------------------------------------------------

# Code-point predicate shared by the batch and import name validators; it must
# reject everything _file_name_valid rejects, including the Unicode format
# characters enumerated there as UTF-8 byte sequences: U+061C (1564),
# U+200B (8203), U+200E (8206), U+200F (8207), U+202A..U+202E (8234..8238),
# U+2060..U+2064 (8288..8292), U+FEFF (65279).
_file_name_codepoint_jq='. >= 32 and (. < 127 or . > 159) and . != 1564 and . != 8203 and . != 8206 and . != 8207 and (. < 8234 or . > 8238) and (. < 8288 or . > 8292) and . != 65279'

_file_name_valid() {
  _fn_checked=$(jqr -n -e -r --arg n "$1" '$n | select(length > 0 and utf8bytelength <= 255 and . != "." and . != ".." and . != ".taildrop" and . != ".outgoing" and ((contains("/") or contains("\\")) | not) and all(explode[]; . >= 32 and (. < 127 or . > 159)))' 2>/dev/null) || return 1
  [ "${_fn_checked}" = "$1" ] || return 1
  # Unicode format characters (Cf) pass the C0/C1 range check above but let a
  # sender spoof the visible name (bidi overrides, zero-width marks, BOM).
  # POSIX case patterns operate on raw bytes, so match each UTF-8 sequence.
  for _fn_seq in \
    '\330\234' \
    '\342\200\213' '\342\200\216' '\342\200\217' \
    '\342\200\252' '\342\200\253' '\342\200\254' '\342\200\255' '\342\200\256' \
    '\342\201\240' '\342\201\241' '\342\201\242' '\342\201\243' '\342\201\244' \
    '\357\273\277'; do
    case "$1" in *"$(printf '%b' "${_fn_seq}")"*) return 1 ;; esac
  done
}

cmd_files_inbox() {
  _fi_snapshot=$(_file_json_command 15 inbox-list --root /sdcard/Download/Taildrop --socket "${TS_SOCKET}") || { printf '%s\n' "${_fi_snapshot}"; return 1; }
  _fi_auto=$(_conf_parse_file "${TS_CONF_DIR}/foxytail.conf" | sed -n 's/^TAILDROP_AUTO_RECEIVE=//p')
  [ "${_fi_auto}" = 1 ] && _fi_enabled=true || _fi_enabled=false
  # Only a small fixed-shape root-owned status crosses the bridge. No journal
  # filename, file contents, socket paths, or unbounded state is exposed.
  _fi_monitor=$(head -c 4096 "${TS_RUN_DIR}/receive-status.json" 2>/dev/null | jqr -ce '
    select(.state=="idle" or .state=="running" or .state=="blocked")
    | {state} + (if (.error|type)=="string" then {error:(.error|.[0:256])} else {} end)
      + (if (.operationId|type)=="string" then {operationId:(.operationId|.[0:96])} else {} end)' 2>/dev/null) || _fi_monitor='{"state":"idle"}'
  if [ "${_fi_enabled}" = true ] && ! daemon_pid_alive foxytail.receive; then
    _fi_monitor='{"state":"blocked","error":"Receive monitor is not running; start FoxyTail before automatic recovery"}'
  fi
  printf '%s' "${_fi_snapshot}" | jqr -c --argjson enabled "${_fi_enabled}" --argjson monitor "${_fi_monitor}" \
    '.receive.automatic=($monitor+{enabled:$enabled})'
}

cmd_file_receive() {
  _file_name_valid "$1" || jerr 'file-receive: invalid name'
  [ -n "$2" ] || jerr 'file-receive: expected account identity'
  taildrop_prepare_direct || jerr 'shared storage unavailable; unlock device and retry'
  _file_json_command 1530 receive --root /sdcard/Download/Taildrop --socket "${TS_SOCKET}" --name "$1" --self "$2"
}

# Inbox item operations on the shared Taildrop directory: delete one, clear
# all, or read one for the caller. Received files already live under
# Download/Taildrop, so there is no import or export step. Names are validated
# to live strictly inside the inbox directory.
_file_inbox_path() {
  _file_name_valid "$1" || return 1
  _fip_dir=$(taildrop_inbox_dir) || return 1
  [ ! -L "${_fip_dir}/$1" ] || return 1
  printf '%s/%s' "${_fip_dir}" "$1"
}

cmd_file_delete() {
  [ -n "$1" ] || jerr "file-delete: expected <name>"
  _fd_path=$(_file_inbox_path "$1") || jerr "file-delete: invalid name"
  [ -f "${_fd_path}" ] || jerr "file-delete: no such file: $1"
  rm -f "${_fd_path}" || jerr "file-delete failed"
  echo '{"ok":true}'
}

cmd_file_clear() {
  _fc_dir=$(taildrop_inbox_dir) || { echo '{"ok":true,"removed":0}'; return 0; }
  _fc_removed=0 _fc_ignored=0
  for _fc_path in "${_fc_dir}"/* "${_fc_dir}"/.[!.]* "${_fc_dir}"/..?*; do
    _fc_name=${_fc_path##*/}
    case "${_fc_name}" in .taildrop | .outgoing | *.partial | *.deleted) continue ;; esac
    [ -f "${_fc_path}" ] && [ ! -L "${_fc_path}" ] || continue
    if ! _file_name_valid "${_fc_name}"; then _fc_ignored=$((_fc_ignored + 1)); continue; fi
    rm -f "${_fc_path}" && _fc_removed=$((_fc_removed + 1))
  done
  jqr -n -c --argjson r "${_fc_removed}" --argjson ignored "${_fc_ignored}" '{ok:true,removed:$r} + (if $ignored > 0 then {ignored:$ignored} else {} end)'
}

_file_batch() (
  _fb_action=$1 _fb_json=$2
  [ "${#_fb_json}" -le 16384 ] || jerr 'file batch exceeds 16 KiB'
  _fb_names=$(printf '%s' "${_fb_json}" | jqr -e -r '
    select(type=="array" and length>=1 and length<=32) |
    select(length==(unique|length)) |
    select(all(.[]; type=="string" and length>0 and utf8bytelength<=255 and .!="." and .!=".." and .!=".taildrop" and .!=".outgoing" and ((contains("/") or contains("\\"))|not) and all(explode[]; ('"${_file_name_codepoint_jq}"')))) | .[]') || jerr 'invalid inbox file selection'
  _fb_output=$(mktemp "${TS_RUN_DIR}/.file-batch.XXXXXX") || jerr 'cannot prepare inbox results'
  chmod 600 "${_fb_output}" || { rm -f "${_fb_output}"; jerr 'cannot protect inbox results'; }
  trap 'rm -f "${_fb_output}"' 0
  while IFS= read -r _fb_name; do
    case "${_fb_action}" in
      delete) if _fb_result=$(cmd_file_delete "${_fb_name}"); then _fb_rc=0; else _fb_rc=$?; fi ;;
      *) jerr 'invalid inbox batch action' ;;
    esac
    jqr -n -c --arg name "${_fb_name}" --argjson result "${_fb_result}" --argjson code "${_fb_rc}" '
      {name:$name,ok:($code==0 and $result.ok==true)} |
      if .ok then . + (if ($result.path|type)=="string" then {path:$result.path} else {} end)
      else . + {error:($result.error // "Inbox operation failed")} end' >>"${_fb_output}" || jerr 'cannot record inbox result'
  done <<EOF_BATCH
${_fb_names}
EOF_BATCH
  jqr -s -c '{ok:true,results:.,succeeded:([.[]|select(.ok)]|length),failed:([.[]|select(.ok|not)]|length)}' "${_fb_output}"
)

cmd_file_delete_many() {
  [ "$#" = 1 ] || jerr 'file-delete-many: expected a file name array'
  _file_batch delete "$1"
}
