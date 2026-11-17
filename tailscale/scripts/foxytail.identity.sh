#!/system/bin/sh
# Sourced by the service manager. Its lifecycle lock covers the entire operation.
identity_stopped() {
  [ -f "${TS_RUN_DIR}/manual-stop" ] && [ ! -L "${TS_RUN_DIR}/manual-stop" ] || {
    echo 'Stop the service explicitly before managing identity state' >&2; return 1;
  }
  [ -z "$(daemon_pids)" ] || { echo 'Identity state requires a stopped daemon' >&2; return 1; }
  ! conf_trial_active || { echo 'Finish the configuration trial before identity maintenance' >&2; return 1; }
  [ ! -f "${TS_DIR}/.installing" ] || return 1
  _identity_history=$("${TS_BIN_DIR}/foxyfiles" send-history --root "${TS_DIR}" 2>/dev/null) || return 1
  printf '%s' "${_identity_history}" | jqr -e '.ok==true and (.transfers|type)=="array" and all(.transfers[]; .status=="completed" or .status=="failed" or .status=="cancelled" or .status=="interrupted")' >/dev/null 2>&1 || {
    echo 'Finish outgoing transfers before identity maintenance' >&2; return 1;
  }
}
identity_service() {
  identity_stopped || return 1
  case "$1:$#" in
    export:1) "${TS_BIN_DIR}/foxyfiles" identity-export --root "${TS_DIR}" ;;
    preview:2) "${TS_BIN_DIR}/foxyfiles" identity-preview --root "${TS_DIR}" --id "$2" ;;
    restore:4) "${TS_BIN_DIR}/foxyfiles" identity-restore --root "${TS_DIR}" --id "$2" --sha256 "$3" --baseline "$4" ;;
    *) echo 'Invalid identity maintenance arguments' >&2; return 1 ;;
  esac
}
