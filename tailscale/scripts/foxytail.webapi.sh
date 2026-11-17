#!/system/bin/sh
# JSON-only native control backend; diagnostics go to stderr or the service log.
# Usage: foxytail.webapi.sh [--request-id <unix-seconds>_<token>] <command> [args]
# Commands are listed in dispatch below. Errors return {ok:false,error} and exit 1.
# POSIX sh (Android mksh / busybox); no set -e.

DIR=$(dirname "$(realpath "$0")")
# shellcheck source=../settings.sh
. "${DIR}/../settings.sh"
detach_from_app_cgroup || {
  if [ "$1" = artifact-read ] || { [ "$1" = --request-id ] && [ "$3" = artifact-read ]; }; then
    echo 'cannot detach backend from the manager app freezer' >&2
  else echo '{"ok":false,"error":"cannot detach backend from the manager app freezer; no configuration lock was acquired"}'; fi
  exit 1
}
umask 077
ensure_run_dirs

# --- Helpers -----------------------------------------------------------------

# shellcheck source=foxytail.webapi-common.sh
. "${DIR}/foxytail.webapi-common.sh"
# shellcheck source=foxytail.webapi-control.sh
. "${DIR}/foxytail.webapi-control.sh"
# shellcheck source=foxytail.webapi-account.sh
. "${DIR}/foxytail.webapi-account.sh"
. "${DIR}/foxytail.webapi-identity.sh"
# shellcheck source=foxytail.webapi-network.sh
. "${DIR}/foxytail.webapi-network.sh"
# shellcheck source=foxytail.webapi-config.sh
. "${DIR}/foxytail.webapi-config.sh"
# shellcheck source=foxytail.webapi-artifacts.sh
. "${DIR}/foxytail.webapi-artifacts.sh"
# shellcheck source=foxytail.webapi-backup.sh
. "${DIR}/foxytail.webapi-backup.sh"
# shellcheck source=foxytail.webapi-tools.sh
. "${DIR}/foxytail.webapi-tools.sh"
# shellcheck source=foxytail.webapi-coexist.sh
. "${DIR}/foxytail.webapi-coexist.sh"
# shellcheck source=foxytail.webapi-taildrop.sh
. "${DIR}/foxytail.webapi-taildrop.sh"

# --- dispatch -------------------------------------------------------------------

_webapi_dispatch() {
case "$1" in
  backend-info|owner-capability|hooks-get)
    [ "$#" = 1 ] || jerr 'unexpected control arguments' ;;
  operation-status)
    [ "$#" = 2 ] || jerr 'operation-status requires one ID' ;;
  file-send-delete|file-delete-many)
    [ "$#" = 2 ] || jerr 'command requires one argument' ;;
  file-send-clear)
    [ "$#" = 1 ] || jerr 'command takes no arguments' ;;
  artifact-delete|cancel)
    [ "$#" = 2 ] || jerr 'command requires one identifier' ;;
  artifact-read)
    { [ "$#" = 2 ] || [ "$#" = 3 ]; } || { echo 'artifact-read requires one identifier' >&2; return 1; } ;;
esac
case "$1:$2" in
  identity-stage:* | identity-export:* | identity-preview:* | identity-restore:* | backend-info:* | operation-start:* | operation-status:* | owner-capability:* | hooks-get:* | artifact-stage:* | artifact-read:* | artifact-delete:*) ;;
  logs:* | control:stop | restore:* | cancel:* | diag-check:* | trial-status:* | trial-confirm:* | trial-revert:* | backup-list:* | restore-preview:*) ;;
  taildrop-targets:* | files-browse:* | file-send-start:* | file-send-status:* | file-send-cancel:* | file-send-history:* | file-send-delete:* | file-send-clear:* | file-receive:* | file-delete:* | file-delete-many:* | file-clear:* | file-stage:* | file-stage-delete:* | file-read:*) ;;
  peers:* | exitnodes:* | peer-ping:* | speedtest-exitnodes:* | derp-speedtest:* | accounts:* | serve-list:* | funnel-list:* | traffic:* | traffic-uids:* | apps:* | files-inbox:* | context-status:*) ;;
  status:* | exit-routing:* | tun:* | dns:* | dns-probe:* | coexist-info:* | coexist-check:* | socks-check:*) load_runtime_conf || jerr 'invalid runtime configuration; inspect the service log' ;;
  *) load_conf || jerr 'invalid configuration; inspect the service log' ;;
esac
case "$1" in
  identity-export | identity-restore | account-rename | control | mode-set | exitnode-set | exitnode-clear | login | login-authkey | logout | switch | serve-set | serve-del | funnel-set | funnel-del | routes-set | subnet-routes-set | settings-set | context-set | file-send-start | file-send-delete | file-send-clear | file-stage | file-stage-delete | file-receive | file-delete | file-delete-many | file-clear | backup | restore | trial-start | trial-confirm | trial-revert | dns-probe)
    [ "$1:$2" = control:stop ] || [ ! -f "${TS_DIR}/.installing" ] || jerr 'an upgrade is in progress; retry after it completes' ;;
esac

case "$1" in
  backend-info) cmd_backend_info ;;
  operation-start) shift; cmd_operation_start "$@" ;;
  operation-status) shift; cmd_operation_status "$@" ;;
  owner-capability) cmd_owner_capability ;;
  socks-check) [ "$#" = 1 ] || jerr 'socks-check takes no arguments'; cmd_socks_check ;;
  hooks-get) cmd_hooks_get ;;
  artifact-stage) shift; [ "$#" = 2 ] || jerr 'artifact-stage requires filename and length'; cmd_artifact_stage "$1" "$2" ;;
  artifact-read) shift; cmd_artifact_read "$1" "${2:-save}" ;;
  identity-stage) shift; [ "$#" = 2 ] || jerr "identity-stage requires filename and size"; cmd_identity_stage "$1" "$2" ;;
  identity-export) [ "$#" = 1 ] || jerr "identity-export takes no arguments"; cmd_identity export ;;
  identity-preview) [ "$#" = 2 ] || jerr "identity-preview requires token"; cmd_identity preview "$2" ;;
  identity-restore) shift; [ "$#" = 3 ] || jerr "identity-restore requires token and two digests"; cmd_identity restore "$@" ;;
  account-rename) shift; [ "$#" = 2 ] || jerr "account-rename requires profile ID and nickname"; cmd_account_rename "$1" "$2" ;;
  artifact-delete) shift; cmd_artifact_delete "$1" ;;
  cancel) shift; cmd_cancel "$1" ;;
  status) cmd_status ;;
  exit-routing) cmd_exit_routing ;;
  peers) cmd_peers ;;
  peer-ping) shift; cmd_peer_ping "$1" "$2" ;;
  exitnodes) cmd_exitnodes ;;
  speedtest-exitnodes) cmd_speedtest_exitnodes ;;
  derp-speedtest) cmd_derp_speedtest ;;
  control) shift; cmd_control "$1" ;;
  mode-set) shift; cmd_mode_set "$1" ;;
  exitnode-set) shift; cmd_exitnode_set "$1" ;;
  exitnode-clear) cmd_exitnode_clear ;;
  tun) cmd_tun ;;
  dns) cmd_dns ;;
  dns-probe) cmd_dns_probe ;;
  coexist-info) cmd_coexist_info ;;
  coexist-check) shift; cmd_coexist_check "$@" ;;
  login) shift; cmd_login "$@" ;;
  login-authkey) shift; cmd_login_authkey "$1" ;;
  logout) cmd_logout ;;
  accounts) cmd_accounts ;;
  switch) shift; cmd_switch "$1" ;;
  serve-list) _serve_list serve ;;
  serve-set) shift; _serve_set serve "$1" "$2" "$3" ;;
  serve-del) shift; _serve_del serve "$1" "$2" "$3" ;;
  funnel-list) _serve_list funnel ;;
  funnel-set) shift; _serve_set funnel "$1" "$2" "$3" ;;
  funnel-del) shift; _serve_del funnel "$1" "$2" "$3" ;;
  traffic) shift; cmd_traffic "$1" "$2" ;;
  traffic-uids) cmd_traffic_uids ;;
  apps) cmd_apps ;;
  routes-get) cmd_routes_get ;;
  routes-set) shift; cmd_routes_set "$1" "$2" "$3" ;;
  subnet-routes-get) cmd_subnet_routes_get ;;
  subnet-routes-set) shift; cmd_subnet_routes_set "$1" ;;
  settings-get) cmd_settings_get ;;
  settings-set) shift; cmd_settings_set "$1" "$2" ;;
  context-get) cmd_context_get ;;
  context-status) cmd_context_status ;;
  context-set) shift; cmd_context_set "$@" ;;
  logs) shift; cmd_logs "$1" "$2" ;;
  compat) cmd_compat ;;
  diag) shift; cmd_diag "$1" ;;
  diag-check) cmd_diag_check ;;
  files-inbox) cmd_files_inbox ;;
  taildrop-targets) cmd_taildrop_targets ;;
  files-browse) shift; cmd_files_browse "$1" ;;
  file-send-start) shift; cmd_file_send_start "$@" ;;
  file-send-status) shift; cmd_file_send_status "$1" ;;
  file-send-cancel) shift; cmd_file_send_cancel "$1" ;;
  file-send-history) cmd_file_send_history ;;
  file-send-delete) shift; cmd_file_send_delete "$@" ;;
  file-send-clear) shift; cmd_file_send_clear "$@" ;;
  file-stage) shift; cmd_file_stage "$@" ;;
  file-stage-delete) shift; cmd_file_stage_delete "$1" ;;
  file-read) shift; cmd_file_read "$1" ;;
  file-receive) shift; [ "$#" = 2 ] || jerr 'file-receive requires name and identity'; cmd_file_receive "$1" "$2" ;;
  file-delete) shift; cmd_file_delete "$1" ;;
  file-delete-many) shift; cmd_file_delete_many "$@" ;;
  file-clear) cmd_file_clear ;;
  backup) cmd_backup ;;
  backup-list) cmd_backup_list ;;
  restore-preview) shift; cmd_restore_preview "$1" ;;
  restore) shift; cmd_restore "$1" "$2" "$3" ;;
  trial-start) shift; cmd_trial_start "$1" "$2" ;;
  trial-status) cmd_trial_status ;;
  trial-confirm) shift; cmd_trial_confirm "$1" ;;
  trial-revert) shift; cmd_trial_revert "$1" ;;
  *)
    [ -n "$1" ] && jerr "unknown command: $1"
    jerr "usage: foxytail.webapi.sh <cmd> [args]"
    ;;
esac
}

if [ "$1" = --request-id ]; then
  [ "$#" -ge 3 ] || jerr 'missing request command'
  case "$3" in
    artifact-read) echo 'artifact-read does not accept a wrapping request ID' >&2; exit 1 ;;
    operation-start|operation-status|backend-info|artifact-stage) jerr 'command does not accept a wrapping request ID' ;;
  esac
  _op_init "$2" "$3"
  shift 2
fi
_webapi_dispatch "$@"
