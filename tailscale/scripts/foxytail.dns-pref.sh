#!/system/bin/sh
# Profile preference journal for the modern DNS lifecycle: public profile
# identity, accept-dns ownership and its restore record.
# Sourced by foxytail.dns-modern.sh.

# Read only the public profile identity and one preference. Debug prefs can
# contain credentials, so never persist or return that whole document.
modern_profile_id() {
  tmo 5 tailscale --socket="${TS_SOCKET}" switch --list --json 2>/dev/null |
    jqr -e -r '[.[] | select(.selected == true) | .id | select(type == "string" and length > 0)]
      | select(length == 1) | .[0]' 2>/dev/null
}

modern_profile_snapshot() {
  _ms_id=$(modern_profile_id) || return 1
  _ms_pref=$(tmo 5 tailscale --socket="${TS_SOCKET}" debug prefs 2>/dev/null |
    jqr -e -c 'select(.CorpDNS | type == "boolean") | {acceptDns:.CorpDNS}' 2>/dev/null) || return 1
  _ms_self=$(ts_status_json tmo 5 tailscale --socket="${TS_SOCKET}" status --json 2>/dev/null |
    jqr -e -r '.Self.ID | select(type == "string" and length > 0)' 2>/dev/null) || return 1
  [ "$(modern_profile_id)" = "${_ms_id}" ] || return 1
  printf '%s' "${_ms_pref}" | jqr -c --arg id "${_ms_id}" --arg self "${_ms_self}" '. + {id:$id,self:$self}'
}

modern_journal_read() {
  if [ ! -e "${MODERN_JOURNAL}" ]; then
    echo '{"version":1,"entries":[]}'
    return 0
  fi
  [ ! -L "${MODERN_JOURNAL}" ] || return 1
  jqr -e -c 'select(.version == 1 and (.entries | type == "array"))
    | select(all(.entries[]; (.id | type == "string") and (.self | type == "string")
      and (.original | type == "boolean") and (.phase == "prepared" or .phase == "owned" or .phase == "drift")))' \
    "${MODERN_JOURNAL}" 2>/dev/null
}

modern_journal_write() {
  mkdir -p "${TS_DIR}/state" || return 1
  (umask 077; printf '%s\n' "$1" >"${MODERN_JOURNAL}.next.$$") &&
    mv "${MODERN_JOURNAL}.next.$$" "${MODERN_JOURNAL}"
}

modern_journal_entry() {
  printf '%s' "$1" | jqr -c --arg id "$2" '.entries[] | select(.id == $id)'
}

modern_journal_set() {
  _mj_data=$(modern_journal_read) || return 1
  _mj_data=$(printf '%s' "${_mj_data}" | jqr -c --argjson entry "$1" \
    '.entries = ([.entries[] | select(.id != $entry.id)] + [$entry])') || return 1
  modern_journal_write "${_mj_data}"
}

modern_journal_remove() {
  _mj_data=$(modern_journal_read) || return 1
  _mj_data=$(printf '%s' "${_mj_data}" | jqr -c --arg id "$1" '.entries |= map(select(.id != $id))') || return 1
  modern_journal_write "${_mj_data}"
}

# Return 2 for explicit preference drift. Reconciliation must not overwrite a
# user who changed accept-dns while this mode was active.
modern_pref_claim() {
  _mc_snapshot=$(modern_profile_snapshot) || { modern_reason native-policy-unavailable unknown; return 1; }
  _mc_id=$(printf '%s' "${_mc_snapshot}" | jqr -r '.id')
  _mc_self=$(printf '%s' "${_mc_snapshot}" | jqr -r '.self')
  [ -n "${_mc_self}" ] || { modern_reason native-policy-unavailable account-unavailable; return 1; }
  _mc_current=$(printf '%s' "${_mc_snapshot}" | jqr -r '.acceptDns')
  _mc_journal=$(modern_journal_read) || { modern_reason native-policy-unavailable invalid-journal; return 1; }
  _mc_entry=$(modern_journal_entry "${_mc_journal}" "${_mc_id}")
  if [ -n "${_mc_entry}" ]; then
    if [ "$(printf '%s' "${_mc_entry}" | jqr -r '.self')" != "${_mc_self}" ]; then
      modern_reason native-policy-changed account-changed
      return 2
    fi
    _mc_phase=$(printf '%s' "${_mc_entry}" | jqr -r '.phase')
    if [ "${_mc_phase}" = drift ] || { [ "${_mc_phase}" = owned ] && [ "${_mc_current}" != false ]; }; then
      modern_journal_set "$(printf '%s' "${_mc_entry}" | jqr -c '.phase="drift"')" || return 1
      modern_reason native-policy-changed changed
      return 2
    fi
  else
    _mc_entry=$(printf '%s' "${_mc_snapshot}" | jqr -c '{id,self,original:.acceptDns,phase:"prepared"}')
    # Persist before changing the native preference, so interruption remains
    # recoverable even if the CLI response never arrives.
    modern_journal_set "${_mc_entry}" || { modern_reason native-policy-unavailable journal-failed; return 1; }
  fi
  if [ "${_mc_current}" != false ]; then
    [ "$(modern_profile_id)" = "${_mc_id}" ] || { modern_reason native-policy-unavailable account-changed; return 1; }
    tmo 5 tailscale --socket="${TS_SOCKET}" set --accept-dns=false >/dev/null 2>&1 || {
      modern_reason native-policy-unavailable set-failed; return 1;
    }
  fi
  _mc_after=$(modern_profile_snapshot) || { modern_reason native-policy-unavailable verify-failed; return 1; }
  if [ "$(printf '%s' "${_mc_after}" | jqr -r '.id')" != "${_mc_id}" ] ||
    [ "$(printf '%s' "${_mc_after}" | jqr -r '.self')" != "${_mc_self}" ] ||
    [ "$(printf '%s' "${_mc_after}" | jqr -r '.acceptDns')" != false ]; then
    modern_reason native-policy-unavailable verify-failed
    return 1
  fi
  modern_journal_set "$(printf '%s' "${_mc_entry}" | jqr -c '.phase="owned"')" || return 1
  printf '%s\n' owned >"${MODERN_POLICY}"
}

modern_pref_restore() {
  # tailscaled is required to flip accept-dns back. When the daemon is down
  # (service stop, crash, reboot), the preference persists in tailscaled
  # state and the journal entry must survive so the next reconcile can finish
  # the restore. Failing here would deadlock service stop: cleanup can never
  # complete, restart aborts, and the daemon never comes back to restore.
  # Liveness is the daemon process, not the socket file: an unclean exit
  # (kill -9, OOM) leaves the socket behind, and relying on it would re-block
  # stop exactly like the unfixed code did.
  if [ -z "$(pids_of_path "${TS_BIN_DIR}/${TS_DAEMON_CMD}" 2>/dev/null)" ]; then
    _mr_journal=$(modern_journal_read) || return 0
    if [ "$(printf '%s' "${_mr_journal}" | jqr '.entries | length')" = 0 ]; then
      [ "$(cat "${MODERN_REASON}" 2>/dev/null)" != restore-pending ] || rm -f "${MODERN_REASON}"
    else
      modern_reason restore-pending daemon-down
    fi
    return 0
  fi
  _mr_journal=$(modern_journal_read) || { modern_reason restore-pending invalid-journal; return 1; }
  if [ "$(printf '%s' "${_mr_journal}" | jqr '.entries | length')" = 0 ]; then
    # Nothing left to restore; drop any stale pending marker so the caller
    # records a clean stopped state instead of a phantom restore-pending.
    [ "$(cat "${MODERN_REASON}" 2>/dev/null)" != restore-pending ] || rm -f "${MODERN_REASON}"
    return 0
  fi
  _mr_snapshot=$(modern_profile_snapshot) || { modern_reason restore-pending unknown; return 1; }
  _mr_id=$(printf '%s' "${_mr_snapshot}" | jqr -r '.id')
  _mr_entry=$(modern_journal_entry "${_mr_journal}" "${_mr_id}")
  # Never switch accounts or apply another profile's saved preference here.
  if [ -z "${_mr_entry}" ] ||
    [ "$(printf '%s' "${_mr_snapshot}" | jqr -r '.self')" != "$(printf '%s' "${_mr_entry}" | jqr -r '.self')" ]; then
    modern_reason restore-pending account-changed
    return 1
  fi
  if [ "$(printf '%s' "${_mr_entry}" | jqr -r '.phase')" != drift ] &&
    [ "$(printf '%s' "${_mr_entry}" | jqr -r '.original')" = true ] &&
    [ "$(printf '%s' "${_mr_snapshot}" | jqr -r '.acceptDns')" = false ]; then
    [ "$(modern_profile_id)" = "${_mr_id}" ] || return 1
    tmo 5 tailscale --socket="${TS_SOCKET}" set --accept-dns=true >/dev/null 2>&1 || {
      modern_reason restore-pending set-failed; return 1;
    }
    _mr_after=$(modern_profile_snapshot) || return 1
    [ "$(printf '%s' "${_mr_after}" | jqr -r '.id')" = "${_mr_id}" ] &&
      [ "$(printf '%s' "${_mr_after}" | jqr -r '.self')" = "$(printf '%s' "${_mr_entry}" | jqr -r '.self')" ] &&
      [ "$(printf '%s' "${_mr_after}" | jqr -r '.acceptDns')" = true ] || return 1
  fi
  modern_journal_remove "${_mr_id}" || return 1
  _mr_journal=$(modern_journal_read) || return 1
  if [ "$(printf '%s' "${_mr_journal}" | jqr '.entries | length')" != 0 ]; then
    modern_reason restore-pending inactive-profile
    return 1
  fi
  printf '%s\n' restored >"${MODERN_POLICY}"
  # Successful restore clears any stale restore-pending reason left by an
  # earlier daemon-down stop, so the caller's final state is accurate.
  [ "$(cat "${MODERN_REASON}" 2>/dev/null)" != restore-pending ] || rm -f "${MODERN_REASON}"
  return 0
}
