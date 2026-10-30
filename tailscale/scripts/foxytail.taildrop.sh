#!/system/bin/sh
# The pinned Android CLI selects direct mode once, when its backend is created.

taildrop_prepare_direct() {
  _TAIL_DROP_READY=0
  [ -d /sdcard ] || return 1
  _td_root=$(realpath /sdcard 2>/dev/null) || return 1
  [ ! -L /sdcard/Download ] && [ ! -L /sdcard/Download/Taildrop ] || return 1
  mkdir -p /sdcard/Download/Taildrop || return 1
  _td_dir=$(realpath /sdcard/Download/Taildrop 2>/dev/null) || return 1
  [ "${_td_dir}" = "${_td_root}/Download/Taildrop" ] || return 1
  _TAIL_DROP_READY=1
}

# /sdcard/Download/Taildrop doubles as the inbox: received files land there
# directly. Validates the same boundaries as taildrop_prepare_direct but never
# creates the directory, so a missing inbox simply means "no files yet".
taildrop_inbox_dir() {
  [ -d /sdcard ] || return 1
  _tid_root=$(realpath /sdcard 2>/dev/null) || return 1
  [ ! -L /sdcard/Download ] && [ ! -L /sdcard/Download/Taildrop ] || return 1
  [ -d /sdcard/Download/Taildrop ] || return 1
  _tid_dir=$(realpath /sdcard/Download/Taildrop 2>/dev/null) || return 1
  [ "${_tid_dir}" = "${_tid_root}/Download/Taildrop" ] || return 1
  printf '%s' /sdcard/Download/Taildrop
}
