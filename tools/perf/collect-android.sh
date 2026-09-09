#!/system/bin/sh
# Opt-in, read-only diagnostic. Never sourced by the module or its installer.
set -eu
usage() {
  cat <<'USAGE'
usage: sh collect-android.sh --duration SECONDS --label LABEL --build BUILD --output NEW_DIRECTORY [--interval SECONDS] [--pss]
Duration: 1..43200 seconds; interval: 5..300 seconds (default 15).
LABEL and BUILD: letters, digits, dot, underscore or dash, at most 100 characters.
Supply a scenario label and source commit; do not put private names in labels.
Run as root on Android. Files remain private. No collection without explicit args.
USAGE
}
duration='' label='' build='' output='' interval=15 collect_pss=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --pss) collect_pss=1; shift ;;
    --duration|--label|--build|--output|--interval)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      case "$1" in
        --duration) duration=$2 ;;
        --label) label=$2 ;;
        --build) build=$2 ;;
        --output) output=$2 ;;
        --interval) interval=$2 ;;
      esac
      shift 2 ;;
    *) usage >&2; exit 2 ;;
  esac
done
case "$duration:$interval" in *[!0-9:]*|:*|*:) usage >&2; exit 2 ;; esac
# Avoid shell arithmetic interpreting leading zeroes as octal or overflowing.
while [ "${duration#0}" != "$duration" ]; do duration=${duration#0}; done
while [ "${interval#0}" != "$interval" ]; do interval=${interval#0}; done
duration=${duration:-0} interval=${interval:-0}
[ "${#duration}" -le 5 ] && [ "${#interval}" -le 3 ] || { usage >&2; exit 2; }
[ "$duration" -ge 1 ] && [ "$duration" -le 43200 ] && [ "$interval" -ge 5 ] && [ "$interval" -le 300 ] || { usage >&2; exit 2; }
for value in "$label" "$build"; do
  case "$value" in ''|*[!a-zA-Z0-9_.-]*) usage >&2; exit 2 ;; esac
  [ "${#value}" -le 100 ] || exit 2
done
case "$output" in /*) ;; *) echo 'output must be a new absolute directory' >&2; exit 2 ;; esac
[ "$(id -u)" = 0 ] || { echo 'root is required for process metrics' >&2; exit 1; }
command -v getprop >/dev/null || { echo 'Android getprop is required' >&2; exit 1; }
if command -v awk >/dev/null; then
  awk_bin='awk'
elif command -v busybox >/dev/null && busybox awk 'BEGIN {exit 0}'; then
  awk_bin=busybox
else
  echo 'awk or BusyBox awk is required; no collection started' >&2; exit 1
fi
run_awk() {
  if [ "$awk_bin" = busybox ]; then busybox awk "$@"; else awk "$@"; fi
}
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
[ -r "$script_dir/snapshot.awk" ] || { echo 'snapshot.awk must be beside the collector' >&2; exit 1; }
umask 077
# Atomic refusal of existing output protects earlier experiments and symlinks.
mkdir -m 700 -- "$output"
sleep_pid=''
finish() {
  result=$?
  trap - EXIT INT TERM
  if [ -n "$sleep_pid" ]; then kill "$sleep_pid" 2>/dev/null || :; wait "$sleep_pid" 2>/dev/null || :; fi
  printf 'exit_status\t%s\n' "$result" >>"$output/metadata.tsv"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
clean() { tr -cd 'a-zA-Z0-9_.:/ +=-'; }
property() {
  value=$(getprop "$2" | clean)
  printf '%s\t%s\n' "$1" "${value:-missing}"
}
ticks=$(getconf CLK_TCK 2>/dev/null || :)
case "$ticks" in ''|*[!0-9]*) ticks=missing ;; esac
{
  printf 'schema\t1\nlabel\t%s\ndeclared_build\t%s\nduration_seconds\t%s\ninterval_seconds\t%s\nclock_ticks_per_second\t%s\npss_enabled\t%s\n' "$label" "$build" "$duration" "$interval" "$ticks" "$collect_pss"
  property device_model ro.product.model
  property device_manufacturer ro.product.manufacturer
  property android_build ro.build.fingerprint
  property android_sdk ro.build.version.sdk
  printf 'kernel_release\t%s\n' "$(uname -r | clean)"
  printf 'architecture\t%s\n' "$(uname -m | clean)"
  printf 'start_utc\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'collector_pid\t%s\nconfiguration\tmissing-use-experiment-notes\n' "$$"
  printf 'coverage\tpartial-proc-polling\nexec_count\tmissing\nstatus_rpc_count\tmissing\nsync_count\tmissing\nhardware_wakeups\tmissing\nenergy_mwh\tmissing\ndeep_sleep_seconds\tmissing\n'
} >"$output/metadata.tsv"
printf 'sample\tuptime_seconds\tcomponent\tattribution\tpid\tstart_ticks\tuser_ticks\tsystem_ticks\trss_kib\tpss_kib\tread_bytes\twrite_bytes\trchar\twchar\tmain_thread_voluntary_switches\tmain_thread_involuntary_switches\n' >"$output/processes.tsv"
printf 'sample\tuptime_seconds\tscan_end_uptime_seconds\n' >"$output/samples.tsv"
read -r start _ < /proc/uptime
start=${start%.*}
sample=0
while :; do
  read -r now _ < /proc/uptime
  run_awk -v sample="$sample" -v uptime="$now" -v collector_pid="$$" -v collect_pss="$collect_pss" -f "$script_dir/snapshot.awk" /proc/[0-9]* >>"$output/processes.tsv"
  read -r scan_end _ < /proc/uptime
  printf '%s\t%s\t%s\n' "$sample" "$now" "$scan_end" >>"$output/samples.tsv"
  elapsed=$((${scan_end%.*} - start))
  [ "$elapsed" -lt "$duration" ] || break
  delay=$interval
  remaining=$((duration - elapsed))
  [ "$delay" -le "$remaining" ] || delay=$remaining
  sleep "$delay" &
  sleep_pid=$!
  wait "$sleep_pid"
  sleep_pid=''
  sample=$((sample + 1))
done
printf 'end_utc\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$output/metadata.tsv"
printf 'Collection complete: %s\n' "$output"
