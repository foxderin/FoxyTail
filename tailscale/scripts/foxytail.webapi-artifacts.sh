#!/system/bin/sh
# Native-only binary transport; public commands never accept a root filesystem path.

_artifact_id_valid() {
  case "$1" in art-*) _ai_hex=${1#art-} ;; *) return 1 ;; esac
  [ "${#_ai_hex}" = 32 ] || return 1
  case "${_ai_hex}" in *[!a-f0-9]*) return 1 ;; esac
}

_artifact_register() {
  _ar_result=$(_op_exec 30 "${TS_BIN_DIR}/foxyfiles" artifact-create --root "${TS_DIR}" --kind "$1" --source "$2") || return 1
  _ar_id=$(printf '%s' "${_ar_result}" | jqr -er '.id') || return 1
  _artifact_id_valid "${_ar_id}" || return 1
  printf '%s\n' "${_ar_id}"
}

cmd_artifact_stage() {
  # Backgrounding via _op_exec would disconnect binary stdin on POSIX shells.
  "${TS_BIN_DIR}/foxyfiles" artifact-stage --root "${TS_DIR}" --name "$1" --size "${2:--1}" || jerr 'artifact-stage: invalid archive name, byte length, unsafe storage or storage full'
}

cmd_artifact_read() {
  # Even failures stay off stdout: the caller owns a binary stream, not JSON.
  _artifact_id_valid "$1" || { echo 'artifact-read: invalid token' >&2; return 1; }
  "${TS_BIN_DIR}/foxyfiles" artifact-read --root "${TS_DIR}" --id "$1" --purpose "${2:-save}"
}

cmd_artifact_delete() {
  _artifact_id_valid "$1" || jerr 'artifact-delete: invalid token'
  "${TS_BIN_DIR}/foxyfiles" artifact-delete --root "${TS_DIR}" --id "$1" || jerr 'artifact-delete: unknown, expired, unsafe or busy artifact'
}
