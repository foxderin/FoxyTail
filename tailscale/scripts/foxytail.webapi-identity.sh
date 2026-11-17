#!/system/bin/sh
# JSON metadata only. Secret payloads use the native binary artifact channel.
cmd_identity_stage() {
  "${TS_BIN_DIR}/foxyfiles" identity-stage --root "${TS_DIR}" --name "$1" --size "$2" || jerr 'identity import rejected: unsupported format, unsafe storage or size limit'
}
cmd_identity() (
  _identity_action=$1; shift
  _identity_output=$(_op_exec 45 "${TS_SCRIPTS_DIR}/foxytail.service" identity "${_identity_action}" "$@" 2>/dev/null) || jerr 'identity operation failed: explicitly stop the service; verify source format, current-state digest and recovery status'
  printf '%s' "${_identity_output}" | jqr -e 'type=="object" and .ok==true' >/dev/null 2>&1 || jerr 'identity operation result invalid; do not retry a restore blindly'
  printf '%s\n' "${_identity_output}"
)
