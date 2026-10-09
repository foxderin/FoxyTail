#!/system/bin/sh
# Stop verified module-owned processes before deleting their files and state.
TS_DIR="/data/adb/foxytail"
SCRIPTS_DIR="${TS_DIR}/scripts"
STATE_BACKUP="/data/adb/foxytail-state.backup"
DNS_PREFERENCES_BACKUP="/data/adb/foxytail-dns-preferences.backup"

say() {
  if type ui_print >/dev/null 2>&1; then ui_print "$1"; else echo "$1"; fi
}

if [ -x "${SCRIPTS_DIR}/start.sh" ]; then
  if ! "${SCRIPTS_DIR}/start.sh" stop; then
    say "! FoxyTail cleanup failed; data retained for recovery"
    exit 1
  fi
elif [ -d "$TS_DIR" ]; then
  say "! FoxyTail control scripts are missing; data retained for recovery"
  exit 1
fi

# Do not signal processes based on a substring in their command line. The
# controller verified each daemon PID and stopped the exact watcher callback.
for _state in "${TS_DIR}/state/tailscaled.state" "${TS_DIR}/tailscaled.state"; do
  if [ -f "$_state" ]; then
    if ! cp "$_state" "${STATE_BACKUP}.tmp" ||
      ! chmod 0600 "${STATE_BACKUP}.tmp" ||
      ! mv "${STATE_BACKUP}.tmp" "$STATE_BACKUP"; then
      say "! Unable to preserve tailscaled identity; data retained"
      exit 1
    fi
    say "- tailscaled identity backed up to ${STATE_BACKUP}"
    # Keep preference ownership with the identity whose profiles it describes.
    # An empty journal deliberately replaces an older backup; absence clears
    # stale ownership rather than attaching it to a different saved identity.
    _dns_journal="${TS_DIR}/state/foxydns-preferences.json"
    if [ -f "${_dns_journal}" ] && [ ! -L "${_dns_journal}" ]; then
      if ! cp "${_dns_journal}" "${DNS_PREFERENCES_BACKUP}.tmp" ||
        ! chmod 0600 "${DNS_PREFERENCES_BACKUP}.tmp" ||
        ! mv "${DNS_PREFERENCES_BACKUP}.tmp" "${DNS_PREFERENCES_BACKUP}"; then
        say "! Unable to preserve DNS preference ownership; FoxyTail data retained"
        exit 1
      fi
    elif ! rm -f "${DNS_PREFERENCES_BACKUP}"; then
      say "! Unable to remove stale DNS preference ownership; FoxyTail data retained"
      exit 1
    fi
    break
  fi
done
for _name in tailscale tailscaled foxytail.service; do
  case "$_name" in
    tailscale|tailscaled) _target="${TS_DIR}/bin/tailscaled" ;;
    foxytail.service) _target="${TS_DIR}/scripts/foxytail.service" ;;
  esac
  _link="/dev/${_name}"
  if [ -L "$_link" ] && [ "$(readlink "$_link")" = "$_target" ]; then
    if ! rm "$_link"; then
      say "! Unable to remove legacy FoxyTail entry ${_link}; data retained for recovery"
      exit 1
    fi
  fi
done
if ! rm -rf "$TS_DIR"; then
  say "! Could not remove all FoxyTail data"
  exit 1
fi
say "- FoxyTail data removed"
