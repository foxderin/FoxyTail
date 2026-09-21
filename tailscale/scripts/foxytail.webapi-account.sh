#!/system/bin/sh
# Account lifecycle: login, logout, profile switch and DNS checkpointing.
# Sourced by foxytail.webapi.sh.

# --- account ------------------------------------------------------------------

# True when the login CLI output already contains an auth URL or an
# already-logged-in/success marker. Used as a wait_for check by cmd_login.
_login_probe() {
  _op_cancelled && return 0
  [ -f "${_cl_tmp}" ] || return 1
  grep -q 'https://' "${_cl_tmp}" 2>/dev/null && return 0
  grep -qi -e already -e success "${_cl_tmp}" 2>/dev/null
}

# Hold a profile-transition marker across preference restoration and the CLI
# mutation. The DNS reconciler observes it under its own lifecycle lock.
_dns_account_begin() {
  [ "${DNS_MODE:-legacy}" != legacy ] || [ -f "${TS_DIR}/state/foxydns-preferences.json" ] || return 0
  _DAC_MARKER="${TS_RUN_DIR}/dns-account-transition"
  _DAC_TOKEN="$$:$(_conf_pid_stamp "$$")"
  conf_lock_acquire || jerr 'account change: configuration is busy'
  _dac_owner=$(readlink "${_DAC_MARKER}" 2>/dev/null)
  if [ -n "${_dac_owner}" ] && _conf_owner_alive "${_dac_owner}"; then
    conf_lock_release
    jerr 'another account change is in progress'
  fi
  rm -f "${_DAC_MARKER}"
  ln -s "${_DAC_TOKEN}" "${_DAC_MARKER}" || { conf_lock_release; jerr 'cannot prepare DNS account transition'; }
  conf_lock_release
  trap '_dns_account_finish; _op_finish' 0
  trap 'exit 130' HUP INT TERM
  [ -x "${TS_SCRIPTS_DIR}/foxytail.dns" ] || jerr 'cannot restore DNS policy: DNS controller is missing'
  _op_exec 60 "${TS_SCRIPTS_DIR}/foxytail.dns" stop >>"${TS_RUN_LOG_FILE}" 2>&1 ||
    jerr 'account unchanged: DNS cleanup or preference restoration failed; inspect DNS status'
  _DAC_RESUME=1
}

_dns_account_finish() {
  [ -n "${_DAC_TOKEN:-}" ] || return 0
  if [ "$(readlink "${_DAC_MARKER}" 2>/dev/null)" = "${_DAC_TOKEN}" ]; then
    rm -f "${_DAC_MARKER}"
    if [ "${_DAC_RESUME:-0}" = 1 ] && [ ! -f "${TS_RUN_DIR}/manual-stop" ]; then
      nohup "${TS_SCRIPTS_DIR}/foxytail.dns" start >>"${TS_RUN_LOG_FILE}" 2>&1 </dev/null &
    fi
  fi
  _DAC_TOKEN=
}

cmd_login() {
  if daemon_up; then
    _cl_st=$(ts_status_json ts_cli 10 status --json)
    if [ -n "${_cl_st}" ] && printf '%s' "${_cl_st}" | jqr -e '.BackendState == "Running"' >/dev/null 2>&1; then
      echo '{"ok":true,"already":true}'
      return 0
    fi
  fi
  _dns_account_begin
  _cl_tmp="${TS_RUN_DIR}/webapi-login.$$"
  rm -f "${_cl_tmp}"
  # The CLI blocks until auth completes; keep it alive after we grab the URL.
  ( _op_exec 180 tailscale --socket="${TS_SOCKET}" login "$@"; sleep 25; rm -f "${_cl_tmp}" ) >"${_cl_tmp}" 2>&1 </dev/null &
  if wait_for "login URL" 20 1 _login_probe; then
    _op_cancelled && jerr "login cancelled"
    _cl_url=$(grep -o 'https://[^ ]*' "${_cl_tmp}" 2>/dev/null | head -n 1)
    if [ -n "${_cl_url}" ]; then
      jqr -n -c --arg u "${_cl_url}" '{ok:true,url:$u}'
      return 0
    fi
    rm -f "${_cl_tmp}"
    echo '{"ok":true,"already":true}'
    return 0
  fi
  _cl_err=$(tail -n 3 "${_cl_tmp}" 2>/dev/null | tr '\n' ' ')
  rm -f "${_cl_tmp}"
  # Only this request owns its CLI record.
  if [ -n "${_OP_DIR:-}" ]; then
    for _cl_record in "${_OP_DIR}"/child.*; do _op_signal "${_cl_record}" TERM; done
  fi
  _cl_hint=""
  # If the daemon logged a control-plane reachability error, surface it so the
  # user sees *why* the URL never arrived (common cause: proxy/DNS conflict).
  if [ -f "${TS_LOG_FILE}" ]; then
    _cl_last=$(tail -n 1 "${TS_LOG_FILE}" 2>/dev/null)
    case "${_cl_last}" in
      *'controlplane.tailscale.com'*|*'connect: connection'*|*'context deadline exceeded'*)
        _cl_hint=$(printf '%s' "${_cl_last}" | sed 's/^.*Received error: //; s/"$//')
        ;;
    esac
  fi
  jerr "no login URL within 20s${_cl_err:+: ${_cl_err}}${_cl_hint:+ (${_cl_hint})}"
}

cmd_login_authkey() {
  [ -n "$1" ] || jerr "login-authkey: missing key"
  case "$1" in
    *[!A-Za-z0-9._-]*) jerr "login-authkey: invalid characters in key" ;;
  esac
  _dns_account_begin
  _la_out=$(ts_cli 60 login --authkey="$1" 2>&1)
  if [ $? -eq 0 ]; then
    echo '{"ok":true,"loggedIn":true}'
  else
    jerr "authkey login failed: ${_la_out:-timeout}"
  fi
}

cmd_logout() {
  daemon_up || jerr "tailscaled is not running"
  _dns_account_begin
  _lo_out=$(ts_cli 30 logout 2>&1)
  if [ $? -eq 0 ]; then
    echo '{"ok":true}'
  else
    jerr "logout failed: ${_lo_out:-timeout}"
  fi
}

cmd_accounts() {
  daemon_up || jerr "tailscaled is not running"
  _ac_list=$(ts_cli 15 switch --list --json 2>&1) || jerr "account list failed: ${_ac_list}"
  printf '%s' "${_ac_list}" | jqr -e 'type == "array"' >/dev/null 2>&1 || jerr "account list did not return a JSON array"
  printf '%s' "${_ac_list}" | jqr -c '{ok:true,accounts:map({
    name:.id, id:.id, current:(.selected // false),
    label:(.nickname // .account // .id), tailnet:(.tailnet // "")
  })}'
}

cmd_switch() {
  [ -n "$1" ] || jerr "switch: missing account name"
  _dns_account_begin
  _sw_out=$(ts_cli 30 switch "$1" 2>&1)
  if [ $? -eq 0 ]; then
    jqr -n -c --arg a "$1" '{ok:true,account:$a}'
  else
    jerr "switch failed: ${_sw_out:-timeout}"
  fi
}
