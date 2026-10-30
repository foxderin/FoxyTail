#!/system/bin/sh
# Stable module-root recovery: never source the replaceable runtime tree.

install_stamp() {
  IFS= read -r _is_line <"/proc/$1/stat" 2>/dev/null || return 1
  _is_fields=${_is_line##*) }
  [ "$_is_fields" != "$_is_line" ] || return 1
  case "$_is_fields" in Z\ *) return 1 ;; esac
  _is_i=1
  while [ "$_is_i" -lt 20 ]; do
    _is_fields=${_is_fields#* }
    _is_i=$((_is_i + 1))
  done
  _is_start=${_is_fields%% *}
  case "$_is_start" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$_is_start"
}

install_owner_valid() {
  _iv_pid=${1%%:*}
  _iv_rest=${1#*:}
  _iv_stamp=${_iv_rest%%:*}
  _iv_boot=${_iv_rest#*:}
  case "$_iv_pid:$_iv_stamp" in *[!0-9:]*|:*|*:) return 1 ;; esac
  case "$_iv_boot" in ''|*[!A-Za-z0-9-]*) return 1 ;; esac
  [ "$1" = "$_iv_pid:$_iv_stamp:$_iv_boot" ] && [ "$_iv_pid" -gt 0 ]
}

install_owner_alive() {
  install_owner_valid "$1" || return 1
  _io_pid=${1%%:*}
  _io_rest=${1#*:}
  _io_stamp=${_io_rest%%:*}
  _io_boot=${_io_rest#*:}
  [ -n "${_INSTALL_BOOT:-}" ] || return 1
  [ "$_io_boot" = "$_INSTALL_BOOT" ] &&
  kill -0 "$_io_pid" 2>/dev/null || return 1
  [ "$(install_stamp "$_io_pid")" = "$_io_stamp" ]
}

# Same PID/start-time Lamport ownership protocol as runtime locks, kept here
# because scripts/ (and its lock implementation) can be absent during recovery.
install_lock() {
  [ -d "$TS_DIR" ] && [ ! -L "$TS_DIR" ] || return 1
  _INSTALL_BOOT=$(cat /proc/sys/kernel/random/boot_id) || return 1
  IFS= read -r _il_stat </proc/self/stat || return 1
  _il_pid=${_il_stat%% *}
  _il_start=$(install_stamp "$_il_pid") || return 1
  _INSTALL_OWNER="$_il_pid:$_il_start:$_INSTALL_BOOT"
  install_owner_valid "$_INSTALL_OWNER" || return 1
  _INSTALL_LOCK="$TS_DIR/.install-lock"
  _INSTALL_WAITERS="$TS_DIR/.install-waiters"
  [ ! -L "$_INSTALL_WAITERS" ] || return 1
  mkdir -p "$_INSTALL_WAITERS" || return 1
  _INSTALL_TICKET="$_INSTALL_WAITERS/$_INSTALL_OWNER"
  ln -s choosing "$_INSTALL_TICKET" || return 1
  _il_number=1
  for _il_file in "$_INSTALL_WAITERS"/*; do
    [ -L "$_il_file" ] || continue
    _il_ticket=$(readlink "$_il_file")
    case "$_il_ticket" in ''|*[!0-9]*) continue ;; esac
    [ "$_il_ticket" -lt "$_il_number" ] || _il_number=$((_il_ticket + 1))
  done
  if ! ln -s "$_il_number" "$_INSTALL_TICKET.next" ||
     ! mv -f "$_INSTALL_TICKET.next" "$_INSTALL_TICKET"; then
    rm -f "$_INSTALL_TICKET.next" "$_INSTALL_TICKET"
    return 1
  fi
  for _il_file in "$_INSTALL_WAITERS"/*; do
    [ -L "$_il_file" ] && [ "$_il_file" != "$_INSTALL_TICKET" ] || continue
    _il_owner=${_il_file##*/}
    case "$_il_owner" in *.next) continue ;; esac
    if ! install_owner_alive "$_il_owner"; then
      rm -f "$_il_file" "$_il_file.next"
      continue
    fi
    _il_ticket=$(readlink "$_il_file")
    case "$_il_ticket" in
      '')
        # The ticket vanished between the directory scan and this read.
        continue ;;
      *[!0-9]*)
        # A contender frozen between `ln -s choosing` and the numbered rename
        # strands a non-numeric ticket. Re-verify the exact pid:starttime:boot
        # owner before yielding: only a dead owner's ticket is reaped.
        if install_owner_alive "$_il_owner"; then
          rm -f "$_INSTALL_TICKET"
          return 1
        fi
        rm -f "$_il_file" "$_il_file.next"
        continue ;;
    esac
    if [ "$_il_ticket" -lt "$_il_number" ] ||
       { [ "$_il_ticket" = "$_il_number" ] && [ "${_il_owner%%:*}" -lt "$_il_pid" ]; }; then
      rm -f "$_INSTALL_TICKET"
      return 1
    fi
  done
  if [ -L "$_INSTALL_LOCK" ]; then
    _il_owner=$(readlink "$_INSTALL_LOCK")
    if install_owner_alive "$_il_owner"; then
      rm -f "$_INSTALL_TICKET"
      return 1
    fi
    rm -f "$_INSTALL_LOCK" || { rm -f "$_INSTALL_TICKET"; return 1; }
  fi
  if ! ln -s "$_INSTALL_OWNER" "$_INSTALL_LOCK"; then
    rm -f "$_INSTALL_TICKET"
    return 1
  fi
  _INSTALL_LOCK_HELD=1
}

install_unlock() {
  [ "${_INSTALL_LOCK_HELD:-0}" = 1 ] || return 0
  [ "$(readlink "$_INSTALL_LOCK")" != "$_INSTALL_OWNER" ] || rm -f "$_INSTALL_LOCK"
  rm -f "$_INSTALL_TICKET"
  _INSTALL_LOCK_HELD=0
}

install_validate_backup() {
  [ ! -L "$TS_DIR/backups" ] && [ ! -L "$BACKUP" ] || return 1
  case "$BACKUP" in
    "$TS_DIR/backups/"*)
      _iv_name=${BACKUP#"$TS_DIR/backups/"}
      case "$_iv_name" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac ;;
    *) return 1 ;;
  esac
  [ ! -e "$BACKUP" ] || [ -d "$BACKUP" ] || return 1
  for _iv_part in bin scripts conf settings.sh VERSIONS checksums.txt native-checksums.txt; do
    [ ! -L "$BACKUP/$_iv_part" ] && [ ! -L "$BACKUP/.absent-$_iv_part" ] || return 1
    [ ! -e "$BACKUP/.absent-$_iv_part" ] || {
      [ -f "$BACKUP/.absent-$_iv_part" ] && [ ! -e "$BACKUP/$_iv_part" ]
    } || return 1
  done
}

rollback_install() {
  install_validate_backup || return 1
  [ -d "$BACKUP" ] && [ ! -L "$BACKUP/.install-owner" ] &&
    [ -f "$BACKUP/.install-owner" ] && [ ! -L "$TS_DIR/.installing" ] &&
    [ -f "$TS_DIR/.installing" ] || return 1
  _ri_owner=$(cat "$BACKUP/.install-owner") || return 1
  install_owner_valid "$_ri_owner" &&
    [ "$(cat "$TS_DIR/.installing")" = "$_ri_owner" ] || return 1
  _ri_ok=0
  for _ri_part in bin scripts conf settings.sh VERSIONS checksums.txt native-checksums.txt; do
    if [ -e "$BACKUP/$_ri_part" ] || [ -e "$BACKUP/.absent-$_ri_part" ]; then
      if ! rm -rf "${TS_DIR:?}/$_ri_part"; then
        _ri_ok=1
        continue
      fi
      if [ -e "$BACKUP/$_ri_part" ]; then
        mv "$BACKUP/$_ri_part" "$TS_DIR/$_ri_part" || _ri_ok=1
      fi
    fi
  done
  [ "$_ri_ok" = 0 ] || return 1
  rm -f "$TS_DIR/.install-transaction" && rm -f "$TS_DIR/.installing"
}

install_recover_locked() {
  [ ! -L "$TS_DIR/.installing" ] && [ ! -L "$TS_DIR/.install-transaction" ] || return 1
  if [ -e "$TS_DIR/.installing" ]; then
    [ -f "$TS_DIR/.installing" ] || return 1
    _ir_owner=$(cat "$TS_DIR/.installing") || return 1
    install_owner_valid "$_ir_owner" || return 1
    if [ "$_ir_owner" != "$_INSTALL_OWNER" ] && install_owner_alive "$_ir_owner"; then
      return 1
    fi
  fi
  if [ -e "$TS_DIR/.install-transaction" ]; then
    [ -f "$TS_DIR/.install-transaction" ] || return 1
    BACKUP=$(cat "$TS_DIR/.install-transaction") || return 1
    rollback_install || return 1
  else
    rm -f "$TS_DIR/.installing" || return 1
  fi
}
