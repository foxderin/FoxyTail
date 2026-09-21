#!/system/bin/sh
# JSON-only WebUI backend; diagnostics go to stderr or the service log.
# Usage: foxytail.webapi.sh [--request-id <unix-seconds>_<token>] <command> [args]
# Commands are listed in dispatch below. Errors return {ok:false,error} and exit 1.
# POSIX sh (Android mksh / busybox); no set -e.

DIR=$(dirname "$(realpath "$0")")
# shellcheck source=../settings.sh
. "${DIR}/../settings.sh"
detach_from_app_cgroup || { echo '{"ok":false,"error":"cannot detach backend from the manager app freezer; no configuration lock was acquired"}'; exit 1; }
ensure_run_dirs

# --- Helpers -----------------------------------------------------------------

# shellcheck source=foxytail.webapi-common.sh
. "${DIR}/foxytail.webapi-common.sh"
# shellcheck source=foxytail.webapi-account.sh
. "${DIR}/foxytail.webapi-account.sh"
# shellcheck source=foxytail.webapi-network.sh
. "${DIR}/foxytail.webapi-network.sh"
# shellcheck source=foxytail.webapi-config.sh
. "${DIR}/foxytail.webapi-config.sh"
# shellcheck source=foxytail.webapi-backup.sh
. "${DIR}/foxytail.webapi-backup.sh"
# shellcheck source=foxytail.webapi-tools.sh
. "${DIR}/foxytail.webapi-tools.sh"

# --- dispatch -------------------------------------------------------------------

if [ "$1" = --request-id ]; then
  [ "$#" -ge 3 ] || jerr 'missing request command'
  _op_init "$2" "$3"
  shift 2
fi
case "$1:$2" in
  logs:* | control:stop | restore:* | cancel:* | diag-check:* | trial-status:* | trial-confirm:* | trial-revert:* | backup-list:* | restore-preview:*) ;;
  status:* | tun:* | dns:*) load_runtime_conf || jerr 'invalid runtime configuration; inspect the service log' ;;
  *) load_conf || jerr 'invalid configuration; inspect the service log' ;;
esac
case "$1" in
  control | mode-set | exitnode-set | exitnode-clear | login | login-authkey | logout | switch | serve-set | serve-del | funnel-set | funnel-del | routes-set | subnet-routes-set | settings-set | context-set | file-send | file-receive | restore | trial-start | trial-confirm | trial-revert)
    [ ! -f "${TS_DIR}/.installing" ] || jerr 'an upgrade is in progress; retry after it completes' ;;
esac

case "$1" in
  cancel) shift; cmd_cancel "$1" ;;
  status) cmd_status ;;
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
  context-set) shift; cmd_context_set "$@" ;;
  logs) shift; cmd_logs "$1" "$2" ;;
  compat) cmd_compat ;;
  diag) shift; cmd_diag "$1" ;;
  diag-check) cmd_diag_check ;;
  files-inbox) cmd_files_inbox ;;
  file-send) shift; cmd_file_send "$1" "$2" ;;
  file-receive) cmd_file_receive ;;
  backup) cmd_backup ;;
  backup-list) cmd_backup_list ;;
  restore-preview) shift; cmd_restore_preview "$1" ;;
  restore) shift; cmd_restore "$1" "$2" ;;
  trial-start) shift; cmd_trial_start "$1" "$2" ;;
  trial-status) cmd_trial_status ;;
  trial-confirm) shift; cmd_trial_confirm "$1" ;;
  trial-revert) shift; cmd_trial_revert "$1" ;;
  *)
    [ -n "$1" ] && jerr "unknown command: $1"
    jerr "usage: foxytail.webapi.sh <cmd> [args]"
    ;;
esac
