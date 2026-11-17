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
  grep -qi -e already -e success -e foxytail-login-lock-busy "${_cl_tmp}" 2>/dev/null
}

# Hold a profile-transition marker across preference restoration and the CLI
# mutation. The DNS reconciler observes it under its own lifecycle lock.
_dns_account_begin() {
  [ "${DNS_MODE:-legacy}" != legacy ] || [ -f "${TS_DIR}/state/foxydns-preferences.json" ] || return 0
  _DAC_MARKER="${TS_RUN_DIR}/dns-account-transition"
  _lock_identity || jerr 'cannot identify account controller'
  _DAC_TOKEN=${_LOCK_TOKEN}
  conf_lock_acquire || jerr 'account change: configuration is busy'
  _dac_owner=$(readlink "${_DAC_MARKER}" 2>/dev/null)
  if [ -n "${_dac_owner}" ] && _conf_owner_alive "${_dac_owner}"; then
    conf_lock_release
    jerr 'another account change is in progress'
  fi
  rm -f "${_DAC_MARKER}"
  ln -s "${_DAC_TOKEN}" "${_DAC_MARKER}" || { conf_lock_release; jerr 'cannot prepare DNS account transition'; }
  conf_lock_release
  _dac_exit=0
  trap '_dac_exit=$?; _dns_account_finish; _op_finish "${_dac_exit}"' 0
  trap 'exit 130' HUP INT TERM
  [ "${_CONTROL_DURABLE:-0}" != 1 ] || trap '' HUP
  [ -x "${TS_SCRIPTS_DIR}/foxytail.dns" ] || jerr 'cannot restore DNS policy: DNS controller is missing'
  _op_exec 60 "${TS_SCRIPTS_DIR}/foxytail.dns" stop >>"${TS_RUN_LOG_FILE}" 2>&1 ||
    jerr 'account unchanged: DNS cleanup or preference restoration failed; inspect DNS status'
  _DAC_RESUME=1
}

_dns_account_finish() {
  [ -n "${_DAC_TOKEN:-}" ] || return 0
  if [ "$(readlink "${_DAC_MARKER}" 2>/dev/null)" = "${_DAC_TOKEN}" ]; then
    rm -f "${_DAC_MARKER}"
    if [ "${_DAC_RESUME:-0}" = 1 ] && ! service_stop_held; then
      nohup "${TS_SCRIPTS_DIR}/foxytail.dns" start >>"${TS_RUN_LOG_FILE}" 2>&1 </dev/null &
    fi
  fi
  _DAC_TOKEN=
}

cmd_login() {
  [ "$#" -le 1 ] || jerr 'login accepts only an optional login server'
  if [ "$#" = 1 ]; then
    [ "${#1}" -le 2048 ] || jerr 'login server is too long'
    case "$1" in --login-server=http://?*|--login-server=https://?*) ;; *) jerr 'invalid login server option' ;; esac
    printf '%s' "$1" | jqr -R -s -e 'test("^--login-server=https?://[^\\s\\x00-\\x1f]+$")' >/dev/null 2>&1 || jerr 'invalid login server URL'
  fi
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
  # A dedicated owner lock serializes the interactive login: the worker owns
  # it, so it covers the whole CLI even after this request has returned.
  (
    _lock_identity || exit 1
    _cl_token=${_LOCK_TOKEN}
    _owner_lock_acquire "${TS_RUN_DIR}/.login-lock" "${_cl_token}" 3 0.1 || {
      echo 'foxytail-login-lock-busy'
      exit 1
    }
    trap '_owner_lock_release "${TS_RUN_DIR}/.login-lock" "${_cl_token}"' 0
    _op_exec 180 tailscale --socket="${TS_SOCKET}" login "$@"
    _owner_lock_release "${TS_RUN_DIR}/.login-lock" "${_cl_token}"
    sleep 25
    rm -f "${_cl_tmp}"
  ) >"${_cl_tmp}" 2>&1 </dev/null &
  if wait_for "login URL" 20 1 _login_probe; then
    _op_cancelled && jerr "login cancelled"
    if grep -q foxytail-login-lock-busy "${_cl_tmp}" 2>/dev/null; then
      rm -f "${_cl_tmp}"
      jerr 'another login is in progress; retry when it completes'
    fi
    _cl_url=$(grep -o 'https://[^ ]*' "${_cl_tmp}" 2>/dev/null | head -n 1)
    if [ -n "${_cl_url}" ]; then
      rm -f "${_cl_tmp}"
      jqr -n -c --arg u "${_cl_url}" '{ok:true,url:$u}'
      return 0
    fi
    rm -f "${_cl_tmp}"
    echo '{"ok":true,"already":true}'
    return 0
  fi
  if grep -q foxytail-login-lock-busy "${_cl_tmp}" 2>/dev/null; then
    rm -f "${_cl_tmp}"
    jerr 'another login is in progress; retry when it completes'
  fi
  rm -f "${_cl_tmp}"
  # Only this request owns its CLI record.
  if [ -n "${_OP_DIR:-}" ]; then
    for _cl_record in "${_OP_DIR}"/child.*; do _op_signal "${_cl_record}" TERM; done
  fi
  jerr 'no login URL within 20s; check network connectivity and retry'
}

cmd_login_authkey() {
  [ -n "$1" ] && [ "${#1}" -le 512 ] || jerr 'login-authkey: missing or oversized key'
  case "$1" in
    *[!A-Za-z0-9._-]*) jerr "login-authkey: invalid characters in key" ;;
  esac
  _dns_account_begin
  if ts_cli 60 login --authkey="$1" >/dev/null 2>&1; then
    echo '{"ok":true,"loggedIn":true}'
  else
    jerr 'authkey login failed; verify the key and network connectivity'
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
  case "$1" in
    -*) jerr "switch: invalid account name" ;;
  esac
  _dns_account_begin
  _sw_out=$(ts_cli 30 switch "$1" 2>&1)
  if [ $? -eq 0 ]; then
    jqr -n -c --arg a "$1" '{ok:true,account:$a}'
  else
    jerr "switch failed: ${_sw_out:-timeout}"
  fi
}

cmd_account_rename() {
  printf '%s' "$1" | jqr -R -s -e 'test("^[A-Za-z0-9_-]{1,64}$")' >/dev/null 2>&1 || jerr 'invalid profile ID'
  printf '%s' "$2" | jqr -R -s -e 'length>0 and length<=128 and (test("[\\x00-\\x1f\\x7f]")|not)' >/dev/null 2>&1 || jerr 'nickname must be 1 to 128 characters on one line'
  _ar_profiles=$(ts_cli 10 switch --list --json 2>/dev/null) || jerr 'cannot verify current profile'
  printf '%s' "${_ar_profiles}" | jqr -e --arg id "$1" '[.[]|select(.selected==true)] | length==1 and .[0].id==$id' >/dev/null 2>&1 || jerr 'current profile changed; refresh before renaming'
  ts_cli 15 set --nickname="$2" >/dev/null 2>&1 || jerr 'nickname update failed; refresh current account before retry'
  _ar_profiles=$(ts_cli 10 switch --list --json 2>/dev/null) || jerr 'nickname outcome unconfirmed; refresh current account'
  printf '%s' "${_ar_profiles}" | jqr -e --arg id "$1" --arg name "$2" 'any(.[];.selected==true and .id==$id and .nickname==$name)' >/dev/null 2>&1 || jerr 'nickname outcome unconfirmed; refresh current account'
  echo '{"ok":true,"renamed":true}'
}
