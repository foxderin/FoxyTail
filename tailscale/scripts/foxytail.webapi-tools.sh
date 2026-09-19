#!/system/bin/sh
# Traffic, installed apps, diagnostics, logs and Taildrop.
# Sourced by foxytail.webapi.sh.

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

cmd_diag() {
  [ -x "${TS_SCRIPTS_DIR}/foxytail.diag" ] || jerr "foxytail.diag not found"
  _dg_out=$(_op_exec 120 "${TS_SCRIPTS_DIR}/foxytail.diag" collect 2>/dev/null) || jerr 'diag collection failed or cancelled'
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
  _fr_out=$(ts_cli 60 file get --wait=false "${FILES_DIR}/" 2>&1) ||
    jerr "file-receive failed: ${_fr_out:-timeout}"
  echo '{"ok":true}'
}
