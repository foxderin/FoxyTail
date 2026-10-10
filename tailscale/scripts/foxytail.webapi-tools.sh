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
    printf '%s' "${_tr_out}" | jqr -c '. + {ok:true}'
  else
    jerr "stats query failed (collector not running?)"
  fi
}

cmd_traffic_uids() {
  _tu_out=$(_op_exec 60 "${TS_SCRIPTS_DIR}/foxytail.stats" query uids 100000 2>/dev/null) || jerr "UID stats query failed"
  printf '%s' "${_tu_out}" | jqr -e . >/dev/null 2>&1 || jerr "UID stats query returned invalid JSON"
  printf '%s' "${_tu_out}" | jqr -c '. + {ok:true}'
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
  _dg_out=$(_op_exec 120 "${TS_SCRIPTS_DIR}/foxytail.diag" collect /sdcard/Download "$_dg_mode" 2>/dev/null) || jerr 'diag collection failed or cancelled'
  _dg_path=$(printf '%s\n' "${_dg_out}" | tail -n 1 | tr -d ' ')
  if [ -n "${_dg_path}" ] && [ -f "${_dg_path}" ]; then
    _dg_artifact=$(_artifact_register diagnostic "${_dg_path}") || jerr 'diag: cannot retain private export artifact'
    jqr -n -c --arg p "${_dg_path}" --arg mode "$_dg_mode" --arg id "${_dg_artifact}" '{ok:true,path:$p,mode:$mode,artifactId:$id}'
  else
    jerr "diag collection failed (see ${TS_RUN_LOG_FILE})"
  fi
}

# --- taildrop files ---------------------------------------------------------------

_file_name_valid() {
  _fn_checked=$(jqr -n -e -r --arg n "$1" '$n | select(length > 0 and utf8bytelength <= 255 and . != "." and . != ".." and . != ".taildrop" and . != ".outgoing" and ((contains("/") or contains("\\")) | not) and all(explode[]; . >= 32 and (. < 127 or . > 159)))' 2>/dev/null) || return 1
  [ "${_fn_checked}" = "$1" ]
}

cmd_files_inbox() {
  mkdir -p "${FILES_DIR}" 2>/dev/null
  for _fi_path in "${FILES_DIR}"/* "${FILES_DIR}"/.[!.]* "${FILES_DIR}"/..?*; do
    _fi_name=${_fi_path##*/}
    [ "${_fi_name}" != .taildrop ] && [ "${_fi_name}" != .outgoing ] && [ -f "${_fi_path}" ] && [ ! -L "${_fi_path}" ] || continue
    if ! _file_name_valid "${_fi_name}"; then printf '%s\n' '{"ignored":1}'; continue; fi
    _fi_size=$(stat -c %s "${_fi_path}" 2>/dev/null)
    _fi_mtime=$(stat -c %Y "${_fi_path}" 2>/dev/null)
    case "${_fi_size}" in '' | *[!0-9]*) _fi_size=0 ;; esac
    case "${_fi_mtime}" in '' | *[!0-9]*) _fi_mtime=0 ;; esac
    jqr -n -c --arg n "${_fi_name}" --argjson s "${_fi_size}" --argjson m "${_fi_mtime}" \
      '{name:$n,size:$s,mtime:$m}'
  done | jqr -s -c '{ok:true,files:(map(select(has("name"))) | sort_by(-.mtime)),ignored:(map(.ignored // 0) | add // 0)} | if .ignored == 0 then del(.ignored) else . end'
}


cmd_file_receive() {
  taildrop_direct_ready || taildrop_confirm_direct || jerr 'Taildrop direct receive mode is unknown or shared storage is locked; unlock storage and restart FoxyTail if the current daemon cannot confirm direct mode'
  mkdir -p "${FILES_DIR}" || jerr 'file-receive: cannot create private inbox'
  _fr_out=$(_op_exec 60 "${TS_BIN_DIR}/foxyfiles" receive --source /sdcard --destination "${FILES_DIR}" 2>&1) ||
    jerr "file-receive failed: ${_fr_out:-cancelled}"
  printf '%s' "${_fr_out}" | jqr -e '.ok==true and (.received|type=="number") and (.received>=0) and (.received==(.received|floor)) and ((.ignored // 0)|type=="number") and ((.ignored // 0)>=0) and ((.ignored // 0)==((.ignored // 0)|floor)) and (.files|type=="array") and (.received==(.files|length)) and all(.files[]; type=="string" and length>0 and utf8bytelength<=255 and .!=".taildrop" and .!=".outgoing" and .!="." and .!=".." and ((contains("/") or contains("\\"))|not) and all(explode[]; .>=32 and (. < 127 or . > 159)))' >/dev/null || jerr 'invalid Taildrop import response'
  _fr_names=$(printf '%s' "${_fr_out}" | jqr -r '.files[]') || jerr 'invalid Taildrop import response'
  _fr_count=$(printf '%s' "${_fr_out}" | jqr -r '.received') || jerr 'invalid Taildrop import response'
  _fr_ignored=$(printf '%s' "${_fr_out}" | jqr -r '.ignored // 0') || jerr 'invalid Taildrop import response'
  _fr_exported=0
  while IFS= read -r _fr_name; do
    [ -n "${_fr_name}" ] || continue
    if _file_export_to_download "${FILES_DIR}/${_fr_name}" "${_fr_name}"; then _fr_exported=$((_fr_exported + 1)); fi
  done <<EOF_FILES
${_fr_names}
EOF_FILES
  jqr -n -c --argjson count "${_fr_count}" --argjson exported "${_fr_exported}" --argjson ignored "${_fr_ignored}" \
    '{ok:true,received:$count,exported:$exported} + (if $ignored > 0 then {ignored:$ignored} else {} end)'
}

# Inbox item operations: delete one, clear all, export one to Download, or
# print one for the webapi caller to download. Names are validated to live
# strictly inside the inbox directory.
_file_inbox_path() {
  _file_name_valid "$1" || return 1
  [ ! -L "${FILES_DIR}/$1" ] || return 1
  printf '%s/%s' "${FILES_DIR}" "$1"
}

cmd_file_delete() {
  [ -n "$1" ] || jerr "file-delete: expected <name>"
  _fd_path=$(_file_inbox_path "$1") || jerr "file-delete: invalid name"
  [ -f "${_fd_path}" ] || jerr "file-delete: no such file: $1"
  rm -f "${_fd_path}" || jerr "file-delete failed"
  echo '{"ok":true}'
}

cmd_file_clear() {
  mkdir -p "${FILES_DIR}" 2>/dev/null
  _fc_removed=0 _fc_ignored=0
  for _fc_path in "${FILES_DIR}"/* "${FILES_DIR}"/.[!.]* "${FILES_DIR}"/..?*; do
    [ "${_fc_path##*/}" != .taildrop ] && [ "${_fc_path##*/}" != .outgoing ] && [ -f "${_fc_path}" ] && [ ! -L "${_fc_path}" ] || continue
    if ! _file_name_valid "${_fc_path##*/}"; then _fc_ignored=$((_fc_ignored + 1)); continue; fi
    rm -f "${_fc_path}" && _fc_removed=$((_fc_removed + 1))
  done
  jqr -n -c --argjson r "${_fc_removed}" --argjson ignored "${_fc_ignored}" '{ok:true,removed:$r} + (if $ignored > 0 then {ignored:$ignored} else {} end)'
}

# Both automatic and manual exports use exclusive creation. The destination
# stays open for the entire copy: a concurrent exporter cannot truncate it.
_file_export_to_download() {
  _fx_base="${2%.*}"; _fx_ext="${2##*.}"
  [ "${_fx_base}" != "${_fx_ext}" ] || _fx_ext=
  _fx_n=0
  while [ "${_fx_n}" -lt 100 ]; do
    if [ "${_fx_n}" -eq 0 ]; then
      _fx_dst="/sdcard/Download/$2"
    elif [ -n "${_fx_ext}" ] && [ "${_fx_ext}" != "$2" ]; then
      _fx_dst="/sdcard/Download/${_fx_base}-${_fx_n}.${_fx_ext}"
    else
      _fx_dst="/sdcard/Download/${2}-${_fx_n}"
    fi
    _fx_n=$((_fx_n + 1))
    [ ! -e "${_fx_dst}" ] && [ ! -L "${_fx_dst}" ] || continue
    (
      set -C
      if { cat "$1" || { rm -f "${_fx_dst}"; exit 2; }; } >"${_fx_dst}"; then
        exit 0
      fi
      exit 3
    ) 2>/dev/null
    _fx_rc=$?
    case "${_fx_rc}" in
      0)
        am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
          -d "file://${_fx_dst}" >/dev/null 2>&1 || true
        return 0 ;;
      2) return 1 ;;
    esac
    # Exclusive creation can lose a race; only a collision warrants another
    # candidate. Permission/storage errors fail without touching the inbox.
    [ -e "${_fx_dst}" ] || [ -L "${_fx_dst}" ] || return 1
  done
  return 1
}

cmd_file_export() {
  [ -n "$1" ] || jerr "file-export: expected <name>"
  _fe_path=$(_file_inbox_path "$1") || jerr "file-export: invalid name"
  [ -f "${_fe_path}" ] || jerr "file-export: no such file: $1"
  _file_export_to_download "${_fe_path}" "$1" || jerr 'file-export: cannot create an unused file in Download'
  jqr -n -c --arg p "${_fx_dst}" '{ok:true,path:$p}'
}
