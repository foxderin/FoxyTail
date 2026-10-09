#!/system/bin/sh
# Backup creation, validated restore preview and restore application.
# Sourced by foxytail.webapi.sh.

# --- backup / restore ---------------------------------------------------------------

cmd_backup() (
  conf_lock_acquire || jerr 'backup: configuration is busy'
  _bk_ts="$(date +%Y%m%d-%H%M%S)-$$"
  _bk_out="/sdcard/Download/foxytail-backup-${_bk_ts}.tar.gz"
  _bk_tmp=''
  _bk_stage=''
  trap 'rm -f "${_bk_tmp}"; [ -z "${_bk_stage}" ] || rm -rf "${_bk_stage}"; conf_lock_release' 0
  trap 'exit 1' HUP INT TERM
  _bk_stage=$(mktemp -d "${TS_RUN_DIR}/.backup.XXXXXX") || jerr 'backup: cannot create staging directory'
  _bk_tmp="${_bk_stage}/backup.tar.gz"
  _bk_err="${_bk_stage}/error"
  _bk_fail() {
    _bk_detail=$(tail -c 2048 "${_bk_err}" 2>/dev/null | _sanitize_text)
    jerr "backup: $1${_bk_detail:+: ${_bk_detail}}"
  }
  mkdir -p /sdcard/Download 2>"${_bk_err}" || _bk_fail 'cannot create Download directory'
  # Android toybox/busybox tar treats -C as one global directory, unlike the
  # positional -C supported by GNU/BSD tar. Stage the portable archive layout
  # first, while the config lock keeps the snapshot consistent.
  mkdir "${_bk_stage}/conf" || _bk_fail 'cannot stage configuration'
  for _bk_f in foxytail.conf routes.conf context.conf; do
    [ ! -f "${TS_CONF_DIR}/${_bk_f}" ] || _op_exec 10 cp "${TS_CONF_DIR}/${_bk_f}" "${_bk_stage}/conf/${_bk_f}" 2>"${_bk_err}" || _bk_fail 'cannot stage configuration'
  done
  set --
  for _bk_h in foxytail.tun.up foxytail.tun.down; do
    if [ -f "${TS_SCRIPTS_DIR}/${_bk_h}" ]; then
      cat "${TS_SCRIPTS_DIR}/${_bk_h}" >"${_bk_stage}/${_bk_h}" 2>"${_bk_err}" || _bk_fail "cannot stage ${_bk_h}"
      set -- "$@" "${_bk_h}"
    fi
  done
  _op_exec 30 tar -czf "${_bk_tmp}" -C "${_bk_stage}" conf "$@" 2>"${_bk_err}" || _bk_fail 'archive creation failed'
  _op_exec 30 "${TS_BIN_DIR}/foxyfiles" extract "${_bk_tmp}" "${_bk_stage}/verify" >/dev/null 2>"${_bk_err}" || _bk_fail 'archive verification failed'
  _bk_size=$(wc -c <"${_bk_tmp}" 2>"${_bk_err}") || _bk_fail 'cannot read archive size'
  [ "${_bk_size}" -gt 0 ] 2>/dev/null || jerr 'backup: archive is empty'
  _bk_artifact=$(_artifact_register backup "${_bk_tmp}") || _bk_fail 'cannot retain private export artifact'
  (set -C; { cat "${_bk_tmp}" || { rm -f "${_bk_out}"; exit 1; }; } >"${_bk_out}") 2>"${_bk_err}" || _bk_fail 'cannot publish archive to Download'
  jqr -n -c --arg p "${_bk_out}" --arg id "${_bk_artifact}" --argjson size "${_bk_size}" '{ok:true,path:$p,size:$size,artifactId:$id}'
)

# Hash the complete saved content set, including absent files, under the config lock.
_restore_baseline() {
  [ ! -L "${TS_CONF_DIR}" ] || return 1
  _rb_records=''
  for _rb_name in foxytail.conf routes.conf context.conf; do
    if [ -e "${TS_CONF_DIR}/${_rb_name}" ] || [ -L "${TS_CONF_DIR}/${_rb_name}" ]; then
      [ -f "${TS_CONF_DIR}/${_rb_name}" ] && [ ! -L "${TS_CONF_DIR}/${_rb_name}" ] || return 1
      _rb_hash=$(sha256sum "${TS_CONF_DIR}/${_rb_name}") || return 1
      _rb_hash=${_rb_hash%% *}
    else _rb_hash=missing; fi
    _rb_records="${_rb_records}${_rb_name}:${_rb_hash};"
  done
  _rb_hash=$(printf '%s' "${_rb_records}" | sha256sum) || return 1
  printf '%s\n' "${_rb_hash%% *}"
}

_restore_hash_valid() {
  [ "${#1}" = 64 ] || return 1
  case "$1" in *[!a-f0-9]*) return 1 ;; esac
}

_restore_cleanup() {
  if [ "${_rt_journal_owned:-0}" = 1 ]; then
    if ! conf_recover_restore; then
      echo "restore recovery pending: previous configuration retained at ${_rt_old}" >&2
      conf_lock_release
      [ "${_rt_artifact_pinned:-0}" != 1 ] || exec 8<&-
      return 1
    fi
  fi
  [ "${_rt_committed:-0}" = 1 ] || [ -z "${_rt_parked:-}" ] || rm -rf "${_rt_parked}"
  [ -z "${_rt_tmp:-}" ] || rm -rf "${_rt_tmp}"
  conf_lock_release
  [ "${_rt_artifact_pinned:-0}" != 1 ] || exec 8<&-
}

_restore_stage() {
  [ -n "$1" ] || jerr 'restore: missing path'
  _rt_artifact=''
  if _artifact_id_valid "$1"; then
    _rt_artifact=$1
  else
    case "$1" in /sdcard/*.tar.gz) ;; *) jerr 'restore: expected an artifact token or .tar.gz under /sdcard/' ;; esac
    [ ! -L "$1" ] || jerr 'restore: archive must not be a symlink'
    _rt_path=$(realpath "$1" 2>/dev/null)
    case "${_rt_path}" in /sdcard/*.tar.gz | /storage/emulated/*.tar.gz) ;; *) jerr 'restore: archive must resolve under shared storage' ;; esac
    [ -f "${_rt_path}" ] || jerr 'restore: archive does not exist'
  fi
  _rt_tmp=$(mktemp -d "${TS_DIR}/.restore.XXXXXX") || jerr 'restore: cannot create staging directory'
  trap '_restore_cleanup' 0
  trap 'exit 1' HUP INT TERM
  mkdir "${_rt_tmp}/next" || jerr 'restore: staging failed'
  _rt_expected=${2:-}
  if [ -n "${_rt_artifact}" ]; then
    [ -d "${TS_DIR}/.artifacts" ] && [ ! -L "${TS_DIR}/.artifacts" ] &&
      [ -d "${TS_DIR}/.artifacts/${_rt_artifact}" ] && [ ! -L "${TS_DIR}/.artifacts/${_rt_artifact}" ] || jerr 'restore: unsafe artifact directory'
    exec 8<"${TS_DIR}/.artifacts/${_rt_artifact}" || jerr 'restore: artifact is unavailable'
    _rt_artifact_pinned=1
    # mksh marks persistent exec descriptors CLOEXEC; explicitly inherit this one.
    "${TS_BIN_DIR}/foxyfiles" artifact-pin --root "${TS_DIR}" --id "${_rt_artifact}" 8<&8 || jerr 'restore: artifact is unsafe, expired or in use'
    set -- artifact-extract --root "${TS_DIR}" --id "${_rt_artifact}" --destination "${_rt_tmp}/unpack"
  else
    set -- extract "$1" "${_rt_tmp}/unpack"
  fi
  _rt_sha=$(_op_exec 30 "${TS_BIN_DIR}/foxyfiles" "$@" 2>"${_rt_tmp}/error") || {
    _rt_error=$(tail -c 2048 "${_rt_tmp}/error" | _sanitize_text)
    jerr "restore: unsafe, oversized, damaged or cancelled archive${_rt_error:+: ${_rt_error}}"
  }
  _restore_hash_valid "${_rt_sha}" || jerr 'restore: invalid archive digest'
  [ -z "${_rt_expected}" ] || [ "${_rt_expected}" = "${_rt_sha}" ] || jerr 'restore: backup changed after preview; preview it again'
  _rt_src="${_rt_tmp}/unpack/archive"
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
    _op_exec 10 cp "${_rt_from}" "${_rt_tmp}/next/${_rt_f}" && chmod 0600 "${_rt_tmp}/next/${_rt_f}" || jerr 'restore: cannot prepare configuration'
  done
  if [ -f "${_rt_tmp}/next/context.conf" ]; then
    _rt_why=$(_op_exec 15 "${TS_SCRIPTS_DIR}/foxytail.context" validate "${_rt_tmp}/next/context.conf" 2>&1) || jerr "restore: ${_rt_why}"
  fi
  if ! ( TS_CONF_DIR="${_rt_tmp}/next"; load_conf && { [ "$TS_MODE" != tun ] || [ "$ROUTE_SCOPE" = all ]; } ); then
    jerr 'restore: invalid configuration or native tun UID routing is unsupported'
  fi
}

cmd_restore() (
  [ ! -f "${TS_DIR}/.installing" ] || jerr 'restore: an upgrade is in progress'
  _restore_hash_valid "${2:-}" && _restore_hash_valid "${3:-}" || jerr 'restore: preview archive and saved configuration before restoring'
  _restore_stage "$1" "${2:-}"
  conf_lock_acquire || jerr 'restore: configuration is busy'
  [ ! -f "${TS_DIR}/.installing" ] || jerr 'restore: an upgrade is in progress'
  _rt_baseline=$(_restore_baseline) || jerr 'restore: cannot hash saved configuration'
  [ "$3" = "${_rt_baseline}" ] || jerr 'restore: saved configuration changed after preview; preview it again'
  _restore_prepare_next
  _rt_ts="$(date +%Y%m%d-%H%M%S)-${_rt_tmp##*.}"
  _rt_old="${TS_DIR}/conf.bak-${_rt_ts}"
  _rt_note=''
  # Restored hooks stay in a separate review directory, never executable and
  # never overwrite a live hook or an earlier review copy.
  for _rt_h in foxytail.tun.up foxytail.tun.down; do
    if [ -f "${_rt_src}/${_rt_h}" ]; then
      _rt_parked="${TS_DIR}/restored-hooks-${_rt_ts}"
      mkdir -p "${_rt_parked}" || jerr 'restore: cannot prepare hook review directory'
      _op_exec 10 cp "${_rt_src}/${_rt_h}" "${_rt_parked}/${_rt_h}.restored" && chmod 0600 "${_rt_parked}/${_rt_h}.restored" || jerr 'restore: cannot park hook'
      _rt_note="hooks parked for review in ${_rt_parked}"
    fi
  done
  # Publish complete recovery metadata before the first live rename. It is
  # outside run/ so fresh loaders recover even after runtime state is cleared.
  mkdir "${_rt_tmp}/journal" || jerr 'restore: cannot prepare transaction'
  _rt_had_previous=0
  if [ -e "${TS_CONF_DIR}" ] || [ -L "${TS_CONF_DIR}" ]; then
    [ -d "${TS_CONF_DIR}" ] && [ ! -L "${TS_CONF_DIR}" ] || jerr 'restore: invalid configuration directory'
    _rt_had_previous=1
  fi
  printf '%s\n' "${_rt_old##*/}" >"${_rt_tmp}/journal/previous" &&
    printf '%s\n' "${_rt_tmp##*/}" >"${_rt_tmp}/journal/staging" &&
    printf '%s\n' "${_rt_had_previous}" >"${_rt_tmp}/journal/had-previous" || jerr 'restore: cannot write transaction'
  _op_commit_begin || jerr 'restore: cancelled before commit'
  _rt_journal_owned=1
  mv "${_rt_tmp}/journal" "${TS_DIR}/.restore-transaction" || jerr 'restore: cannot publish transaction'
  if [ "${_rt_had_previous}" = 1 ]; then
    mv "${TS_CONF_DIR}" "${_rt_old}" || jerr 'restore: cannot retain previous configuration'
  fi
  mv "${_rt_tmp}/next" "${TS_CONF_DIR}" || jerr 'restore: cannot activate configuration; rolling back'
  conf_mark_pending || jerr 'restore: cannot record pending configuration; rolling back'
  : >"${_rt_tmp}/commit" && mv "${_rt_tmp}/commit" "${TS_DIR}/.restore-transaction/committed" || jerr 'restore: cannot commit configuration; rolling back'
  _rt_committed=1
  conf_recover_restore || jerr 'restore: cannot finish committed transaction; retry'
  _rt_journal_owned=0
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
  _artifact_id_valid "$1" || _backup_selected_path "$1" || jerr 'restore-preview: select a staged artifact or regular FoxyTail backup from Download'
  _restore_stage "$1"
  conf_lock_acquire || jerr 'restore-preview: configuration is busy'
  _rp_baseline=$(_restore_baseline) || jerr 'restore-preview: cannot hash saved configuration'
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
  jqr -n -c --arg p "$1" --arg sha "${_rt_sha}" --arg baseline "${_rp_baseline}" --argjson changes "${_rp_changes}" --arg hooks "${_rp_hooks}" \
    '{ok:true,path:$p,sha256:$sha,baselineSha256:$baseline,changes:$changes,hooks:($hooks|split(" ")|map(select(length>0)))}'
)
