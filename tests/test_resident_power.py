"""Behavioral regressions for idle residents; source public libraries directly."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ResidentFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='foxytail-residents-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        (self.base / 'stats').mkdir()

    def run_shell(self, body, library=None):
        prefix = ''
        if library:
            prefix = '. ' + shlex.quote(str(ROOT / 'tailscale/scripts' / library)) + '\n'
        result = subprocess.run(['sh', '-c', prefix + body], text=True, capture_output=True,
                                env={**os.environ, 'TEST_DIR': str(self.base)}, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def lines(self, name):
        file = self.base / name
        return file.read_text().splitlines() if file.exists() else []


class LibraryLoadTests(ResidentFixture):
    def test_libraries_load_without_runtime_side_effects(self):
        for name in ['stats', 'watchdog']:
            result = self.run_shell(':', f'foxytail.{name}-lib.sh')
            self.assertEqual(result.stdout + result.stderr, '')
        self.assertEqual(sorted(p.name for p in self.base.iterdir()), ['stats'])


@unittest.skipUnless(shutil.which('jq'), 'jq is needed for runtime stats filters')
class StatsIdleTests(ResidentFixture):
    prefix = r'''
TS_RUN_DIR="$TEST_DIR"; TS_STATS_DIR="$TEST_DIR/stats"; TS_BIN_DIR="$TEST_DIR"
TS_SOCKET="$TEST_DIR/socket"; PID_FILE="$TEST_DIR/stats.pid"; STATS_INTERVAL=60
sample_day=2026-09-10; sample_time=10000
date() {
  case "$1" in +%F) echo "$sample_day" ;; +%s) echo "$sample_time" ;; *) command date "$@" ;; esac
}
jqr() { jq "$@"; }
tmo() { echo rpc >>"$TEST_DIR/calls"; echo '{"Peer":{}}'; }
pids_of_path() { :; }
iptables() { echo v4 >>"$TEST_DIR/families"; }
ip6tables() { echo v6 >>"$TEST_DIR/families"; }
prune_stats() { echo prune >>"$TEST_DIR/maintenance"; }
chmod() { echo chmod >>"$TEST_DIR/modes"; command chmod "$@"; }
log() { echo "$*" >>"$TEST_DIR/log"; }
'''

    def stats(self, body):
        return self.run_shell(self.prefix + body, 'foxytail.stats-lib.sh')

    def test_manual_stop_has_no_rpc_samples_or_maintenance_and_resumes(self):
        self.stats('''
: >"$TS_RUN_DIR/manual-stop"
collect_once; collect_once; collect_once
[ ! -f "$TEST_DIR/calls" ] && [ ! -f "$TEST_DIR/maintenance" ] || exit 1
rm "$TS_RUN_DIR/manual-stop"
collect_once
''')
        self.assertEqual(self.lines('calls'), ['rpc'])
        rows = self.lines('stats/2026-09-10.jsonl')
        self.assertEqual(len(rows), 1)
        self.assertNotIn('error', json.loads(rows[0]))

    def test_stop_during_rpc_does_not_append_unreachable_sample(self):
        self.stats('''
tmo() { : >"$TS_RUN_DIR/manual-stop"; }
collect_once
''')
        self.assertEqual(list((self.base / 'stats').iterdir()), [])
        self.assertEqual(self.lines('maintenance'), [])

    def test_stopped_loop_skips_config_and_screen_queries_until_resume(self):
        self.stats('''
daemon_claim_pidfile() { :; }
load_conf() { echo conf >>"$TEST_DIR/calls"; }
is_screen_on() { echo screen >>"$TEST_DIR/calls"; }
collect_once() { echo collect >>"$TEST_DIR/calls"; _stats_stop; }
isleep() {
  [ "$1" = 60 ] || exit 1
  if [ -f "$TS_RUN_DIR/manual-stop" ]; then
    [ ! -f "$TEST_DIR/calls" ] || exit 1
    rm "$TS_RUN_DIR/manual-stop"
  fi
}
: >"$TS_RUN_DIR/manual-stop"
do_start
''')
        self.assertEqual(self.lines('calls'), ['conf', 'collect', 'screen'])

    def test_retention_and_modes_run_once_per_day_and_repair_legacy_mode(self):
        file = self.base / 'stats/2026-09-10.jsonl'
        file.touch(mode=0o666)
        file.chmod(0o666)
        self.stats('''
umask 000
collect_once; collect_once; collect_once
sample_day=2026-09-11
collect_once; collect_once
''')
        self.assertEqual(self.lines('maintenance'), ['prune', 'prune'])
        self.assertEqual(self.lines('modes'), ['chmod', 'chmod'])
        for file in (self.base / 'stats').iterdir():
            self.assertEqual(file.stat().st_mode & 0o777, 0o640)
        self.assertEqual(len(self.lines('stats/2026-09-10.jsonl')), 3)
        self.assertEqual(len(self.lines('stats/2026-09-11.jsonl')), 2)

    def test_failed_maintenance_retries_after_one_hour(self):
        self.stats('''
prune_stats() { echo prune >>"$TEST_DIR/maintenance"; return 1; }
collect_once
sample_time=13599; collect_once
sample_time=13600; collect_once
''')
        self.assertEqual(self.lines('maintenance'), ['prune', 'prune'])
        self.assertEqual(len(self.lines('stats/2026-09-10.jsonl')), 3)

    def test_recreated_file_has_private_mode_without_another_retention_scan(self):
        self.stats('''
umask 000
collect_once
rm "$TS_STATS_DIR/2026-09-10.jsonl"
collect_once
''')
        self.assertEqual(self.lines('modes'), ['chmod', 'chmod'])
        self.assertEqual(self.lines('maintenance'), ['prune'])
        self.assertEqual((self.base / 'stats/2026-09-10.jsonl').stat().st_mode & 0o777, 0o640)

    def test_permissions_failure_prevents_appending_sensitive_samples(self):
        file = self.base / 'stats/2026-09-10.jsonl'
        file.touch()
        self.stats('''
chmod() { return 1; }
if collect_once; then exit 1; fi
''')
        self.assertEqual(file.read_text(), '')

    def test_only_completed_applied_snapshot_can_skip_a_family(self):
        snapshot = self.base / 'route.snapshot'
        snapshot.mkdir()
        (snapshot / 'generation').write_text('1234\n')
        (snapshot / 'iptables.filter').write_text('-N FOXY_STAT\n')
        self.stats('''
IPV6=on
collect_once
rm "$TS_RUN_DIR/route.snapshot/generation"
collect_once
''')
        self.assertEqual(self.lines('families'), ['v4', 'v4', 'v6'])

    def test_unreadable_interface_is_missing_but_zero_is_valid(self):
        interface = self.base / 'interface/statistics'
        interface.mkdir(parents=True)
        for name in ['rx_bytes', 'tx_bytes']:
            (interface / name).write_text('0\n')
        result = self.stats('''
stats_interface_json "$TEST_DIR/interface"
rm "$TEST_DIR/interface/statistics/rx_bytes"
stats_interface_json "$TEST_DIR/interface"
''')
        self.assertEqual([json.loads(line) for line in result.stdout.splitlines()],
                         [{'rx': 0, 'tx': 0}, None])

    def test_failed_family_does_not_publish_partial_uid_counter(self):
        self.stats('''
iptables() { echo '1 100 RETURN all -- * tailscale0 0.0.0.0/0 0.0.0.0/0 owner UID match 10101'; }
ip6tables() { return 1; }
collect_once
''')
        row = json.loads(self.lines('stats/2026-09-10.jsonl')[0])
        self.assertIsNone(row['uids'])


@unittest.skipUnless(shutil.which('jq'), 'jq is needed for runtime watchdog filters')
class WatchdogIdleTests(ResidentFixture):
    prefix = r'''
TS_RUN_DIR="$TEST_DIR"; TS_BIN_DIR="$TEST_DIR"; TS_DAEMON_CMD=tailscaled
MANUAL_STOP_FILE="$TEST_DIR/manual-stop"; BAD_COUNT_FILE="$TEST_DIR/bad"
ROUTE_CACHE="$TEST_DIR/route"; BACKEND_BAD_LIMIT=3; TS_MODE=proxy; MAGIC_DNS=off
jqr() { jq "$@"; }
pids_of_path() { echo 123; }
ts_status_json() { echo rpc >>"$TEST_DIR/calls"; echo '{"BackendState":"Running"}'; }
ip() { echo 'default via 192.0.2.1'; }
log() { echo "$*" >>"$TEST_DIR/log"; }
recover() { echo "$*" >>"$TEST_DIR/recoveries"; }
'''

    def watchdog(self, body):
        return self.run_shell(self.prefix + body, 'foxytail.watchdog-lib.sh')

    def test_manual_stop_is_silent_and_performs_no_rpc_or_recovery(self):
        (self.base / 'manual-stop').touch()
        self.watchdog('check_once; check_once; check_once')
        for name in ['calls', 'recoveries', 'log', 'bad', 'route']:
            self.assertFalse((self.base / name).exists(), name)

    def test_healthy_rounds_do_not_rewrite_zero_or_unchanged_route(self):
        for name, content in [('bad', '0\n'), ('route', 'default via 192.0.2.1 \n')]:
            path = self.base / name
            path.write_text(content)
            os.utime(path, (100, 100))
        self.watchdog('check_once; check_once; check_once')
        for name in ['bad', 'route']:
            self.assertEqual((self.base / name).stat().st_mtime, 100)
        self.assertEqual(self.lines('calls'), ['rpc'] * 3)

    def test_recovery_still_requires_three_unanswered_rounds(self):
        self.watchdog('''
ts_status_json() { :; }
check_once; check_once
[ ! -f "$TEST_DIR/recoveries" ] || exit 1
check_once
''')
        self.assertEqual(self.lines('recoveries'), ['restart daemon-unreachable'])
        self.assertEqual(self.lines('bad'), ['0'])

    def test_user_state_resets_strikes_and_logs_only_on_transition(self):
        (self.base / 'bad').write_text('2\n')
        self.watchdog('''
ts_status_json() { echo '{"BackendState":"NeedsLogin"}'; }
check_once; check_once; check_once
''')
        self.assertEqual(self.lines('bad'), ['0'])
        self.assertEqual(len(self.lines('log')), 1)
        self.assertEqual(self.lines('recoveries'), [])


class ScreenStateTests(ResidentFixture):
    def test_explicit_and_unknown_states(self):
        cases = [('', 'unknown', 0), ('unfamiliar OEM output', 'unknown', 0),
                 ('mScreenOn=true', 'on', 0), ('mScreenOn=false', 'off', 1),
                 ('Display Power: state=ON', 'on', 0),
                 ('Display Power: state=OFF', 'off', 1),
                 ('mWakefulness=Awake', 'on', 0), ('mWakefulness=Dozing', 'off', 1),
                 ('Display Power: state=DOZE_SUSPEND', 'off', 1),
                 ('Display Power: state=OFF\nDisplay Power: state=ON', 'on', 0)]
        for text, state, status in cases:
            with self.subTest(text=text):
                (self.base / 'power').write_text(text)
                result = self.run_shell('. ' + shlex.quote(str(ROOT / 'tailscale/settings.sh')) + '''
dumpsys() { cat "$TEST_DIR/power"; }
screen_state <"$TEST_DIR/power"
is_screen_on
echo "$?"
''')
                self.assertEqual(result.stdout.splitlines(), [state, str(status)])


if __name__ == '__main__':
    unittest.main()
