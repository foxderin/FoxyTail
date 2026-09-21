#!/system/bin/sh
# Backup creation, validated restore preview and restore application.
# Sourced by foxytail.webapi.sh.

# --- backup / restore ---------------------------------------------------------------

cmd_backup() (
  conf_lock_acquire || jerr 'backup: configuration is busy'
  _bk_ts="$(date +%Y%m%d-%H%M%S)-$$"
  _bk_out="/sdcard/Download/foxytail-backup-${_bk_ts}.tar.gz"
  _bk_tmp="${_bk_out}.partial"
  _bk_stage=''
  trap 'rm -f "${_bk_tmp}"; [ -z "${_bk_stage}" ] || rm -rf "${_bk_stage}"; conf_lock_release' 0
  trap 'exit 1' HUP INT TERM
  _bk_stage=$(mktemp -d "${TS_RUN_DIR}/.backup.XXXXXX") || jerr 'backup: cannot create staging directory'
  _bk_err="${_bk_stage}/error"
  _bk_fail() {
    _bk_detail=$(tail -c 2048 "${_bk_err}" 2>/dev/null | _sanitize_text)
    jerr "backup: $1${_bk_detail:+: ${_bk_detail}}"
  }
  mkdir -p /sdcard/Download 2>"${_bk_err}" || _bk_fail 'cannot create Download directory'
  # Android toybox/busybox tar treats -C as one global directory, unlike the
  # positional -C supported by GNU/BSD tar. Stage the portable archive layout
  # first, while the config lock keeps the snapshot consistent.
  cp -R "${TS_CONF_DIR}" "${_bk_stage}/conf" 2>"${_bk_err}" || _bk_fail 'cannot stage configuration'
  set --
  for _bk_h in foxytail.tun.up foxytail.tun.down; do
    if [ -f "${TS_SCRIPTS_DIR}/${_bk_h}" ]; then
      cat "${TS_SCRIPTS_DIR}/${_bk_h}" >"${_bk_stage}/${_bk_h}" 2>"${_bk_err}" || _bk_fail "cannot stage ${_bk_h}"
      set -- "$@" "${_bk_h}"
    fi
  done
  tar -czf "${_bk_tmp}" -C "${_bk_stage}" conf "$@" 2>"${_bk_err}" || _bk_fail 'archive creation failed'
  tar -tzf "${_bk_tmp}" >/dev/null 2>"${_bk_err}" || _bk_fail 'archive verification failed'
  _bk_size=$(wc -c <"${_bk_tmp}" 2>"${_bk_err}") || _bk_fail 'cannot read archive size'
  [ "${_bk_size}" -gt 0 ] 2>/dev/null || jerr 'backup: archive is empty'
  mv "${_bk_tmp}" "${_bk_out}" 2>"${_bk_err}" || _bk_fail 'cannot publish archive to Download'
  jqr -n -c --arg p "${_bk_out}" --argjson size "${_bk_size}" '{ok:true,path:$p,size:$size}'
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

_restore_stage() {
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
  _rt_sha=$(sha256sum "${_rt_input}") || jerr 'restore: cannot hash archive'
  _rt_sha=${_rt_sha%% *}
  [ -z "${2:-}" ] || [ "$2" = "${_rt_sha}" ] || jerr 'restore: backup changed after preview; preview it again'
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
}

_restore_prepare_next() {
  # Prepare a complete replacement on the same filesystem. Any copy failure
  # aborts before the first live rename; archive ownership/modes are discarded.
  for _rt_f in foxytail.conf routes.conf context.conf; do
    if [ -f "${_rt_src}/conf/${_rt_f}" ]; then _rt_from="${_rt_src}/conf/${_rt_f}"
    elif [ -f "${TS_CONF_DIR}/${_rt_f}" ]; then _rt_from="${TS_CONF_DIR}/${_rt_f}"
    else continue; fi
    cat "${_rt_from}" >"${_rt_tmp}/next/${_rt_f}" && chmod 0600 "${_rt_tmp}/next/${_rt_f}" || jerr 'restore: cannot prepare configuration'
  done
  if [ -f "${_rt_tmp}/next/context.conf" ]; then
    _rt_why=$("${TS_SCRIPTS_DIR}/foxytail.context" validate "${_rt_tmp}/next/context.conf" 2>&1) || jerr "restore: ${_rt_why}"
  fi
  if ! ( TS_CONF_DIR="${_rt_tmp}/next"; load_conf && { [ "$TS_MODE" != tun ] || [ "$ROUTE_SCOPE" = all ]; } ); then
    jerr 'restore: invalid configuration or native tun UID routing is unsupported'
  fi
}

cmd_restore() (
  [ ! -f "${TS_DIR}/.installing" ] || jerr 'restore: an upgrade is in progress'
  _restore_stage "$1" "${2:-}"
  conf_lock_acquire || jerr 'restore: configuration is busy'
  [ ! -f "${TS_DIR}/.installing" ] || jerr 'restore: an upgrade is in progress'
  _restore_prepare_next
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

# Only ordinary backups created in Download are offered by the picker.
_backup_selected_path() {
  case "$1" in /sdcard/Download/foxytail-backup-*.tar.gz) ;; *) return 1 ;; esac
  _bsp_name=${1##*/}
  case "${_bsp_name}" in *[!A-Za-z0-9._-]*) return 1 ;; esac
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  _bsp_root=$(realpath /sdcard/Download) || return 1
  _bsp_path=$(realpath "$1") || return 1
  [ "${_bsp_path%/*}" = "${_bsp_root}" ]
}

cmd_backup_list() {
  for _bl_path in /sdcard/Download/foxytail-backup-*.tar.gz; do
    _backup_selected_path "${_bl_path}" || continue
    _bl_size=$(wc -c <"${_bl_path}") || continue
    _bl_mtime=$(stat -c %Y "${_bl_path}" 2>/dev/null) || _bl_mtime=0
    jqr -n -c --arg p "${_bl_path}" --arg n "${_bl_path##*/}" --argjson s "${_bl_size}" --argjson m "${_bl_mtime}" \
      '{path:$p,name:$n,size:$s,mtime:$m}'
  done | jqr -s -c '{ok:true,backups:sort_by(-.mtime,.name)}'
}

cmd_restore_preview() (
  _backup_selected_path "$1" || jerr 'restore-preview: select a regular FoxyTail backup from Download'
  _restore_stage "$1"
  conf_lock_acquire || jerr 'restore-preview: configuration is busy'
  _restore_prepare_next
  _rp_changes=$(
    for _rp_file in foxytail.conf routes.conf context.conf; do
      if [ "${_rp_file}" = context.conf ]; then
        _rp_before=$(cat "${TS_CONF_DIR}/${_rp_file}" 2>/dev/null)
        _rp_after=$(cat "${_rt_tmp}/next/${_rp_file}" 2>/dev/null)
        [ "${_rp_before}" = "${_rp_after}" ] || jqr -n -c --arg f "${_rp_file}" --arg b "${_rp_before}" --arg a "${_rp_after}" \
          '{file:$f,key:"rules",before:$b,after:$a}'
      else
        _rp_before=$(_conf_parse_file "${TS_CONF_DIR}/${_rp_file}" 2>/dev/null) || _rp_before=''
        _rp_after=$(_conf_parse_file "${_rt_tmp}/next/${_rp_file}" 2>/dev/null) || _rp_after=''
        jqr -n -c --arg f "${_rp_file}" --arg b "${_rp_before}" --arg a "${_rp_after}" '
          def records: split("\n") | map(select(length>0) | capture("^(?<key>[^=]+)=(?<value>.*)$")) | from_entries;
          ($b|records) as $before | ($a|records) as $after
          | (($before|keys)+($after|keys)|unique)[] as $key
          | select($before[$key]!=$after[$key]) | {file:$f,key:$key,before:$before[$key],after:$after[$key]}'
      fi
    done | jqr -s -c .
  ) || jerr 'restore-preview: cannot compare configuration'
  _rp_hooks=''
  for _rp_hook in foxytail.tun.up foxytail.tun.down; do
    [ ! -f "${_rt_src}/${_rp_hook}" ] || _rp_hooks="${_rp_hooks} ${_rp_hook}"
  done
  jqr -n -c --arg p "$1" --arg sha "${_rt_sha}" --argjson changes "${_rp_changes}" --arg hooks "${_rp_hooks}" \
    '{ok:true,path:$p,sha256:$sha,changes:$changes,hooks:($hooks|split(" ")|map(select(length>0)))}'
)
