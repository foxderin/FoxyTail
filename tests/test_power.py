"""Power controls and idle work, exercised through the real shell helpers."""
import json
import shlex
import sys

from api_fixture import ApiTestCase, ROOT


class PowerTests(ApiTestCase):
    def test_independent_switches_preserve_upgrade_defaults_and_require_apply(self):
        (self.conf / 'foxytail.conf').write_text('TS_MODE=bridge\n')
        defaults = {'POWER_SAVE': 'off', 'STATS': 'on', 'CONTEXT': 'on',
                    'WATCHDOG_PROBE': 'on', 'WEBUI_AUTO_REFRESH': 'on'}
        values = json.loads(self.shell('load_conf; cmd_settings_get').stdout)['settings']
        self.assertEqual({key: values[key] for key in defaults}, defaults)
        for key, default in defaults.items():
            value = 'off' if default == 'on' else 'on'
            result = json.loads(self.shell(f'cmd_settings_set {key} {value}').stdout)
            self.assertTrue(result['restartRequired'])
            self.assertFalse(result['applied'])
            self.assertNotEqual(self.shell(f'cmd_settings_set {key} auto', ok=False).returncode, 0)
        values = json.loads(self.shell('load_conf; cmd_settings_get').stdout)['settings']
        self.assertEqual({key: values[key] for key in defaults},
                         {key: 'off' if default == 'on' else 'on' for key, default in defaults.items()})

    def test_power_intervals_keep_user_limits_and_normal_watchdog_avoids_display_probe(self):
        result = self.shell('''load_conf
is_screen_on() { return "$screen_off"; }
for POWER_SAVE in off on; do
  for screen_off in 0 1; do
    effective_interval 30 1 60 180
    effective_interval 60 5 300 900
    effective_interval 20 5 60 180
  done
done
POWER_SAVE=on; screen_off=1; effective_interval 3600 5 300 900
POWER_SAVE=off
is_screen_on() { echo unexpected >&2; return 1; }
effective_interval 30 1 60 180
''')
        self.assertEqual(result.stdout.split(), ['30', '60', '20', '30', '300', '100',
                                                '60', '300', '60', '180', '900', '180', '18000', '30'])
        self.assertNotIn('unexpected', result.stderr)

    def test_screen_probe_uses_sysfs_and_unknown_binder_output_stays_awake(self):
        settings = (ROOT / 'tailscale/settings.sh').read_text()
        function = settings[settings.index('is_screen_on() {'):settings.index('# Shared resident schedule')]
        function = function.replace('/sys/class/', str(self.base / 'sys') + '/')
        blank = self.base / 'sys/graphics/fb0/blank'
        blank.parent.mkdir(parents=True)
        for value, expected in [('0\n', 0), ('4\n', 1)]:
            blank.write_text(value)
            result = self.shell(function + '\ntmo() { echo unexpected >&2; }; is_screen_on', ok=False)
            self.assertEqual(result.returncode, expected)
            self.assertNotIn('unexpected', result.stderr)
        blank.unlink()
        for value, expected in [('mWakefulness=Awake', 0), ('mWakefulness=Dozing', 1),
                                ('Display Power: state=OFF', 1), ('unrecognized power format', 0), ('', 0)]:
            result = self.shell(function + '\ntmo() { printf "%s" ' + shlex.quote(value) + '; }; is_screen_on', ok=False)
            self.assertEqual(result.returncode, expected)

    def test_runtime_cache_avoids_lock_writes_and_invalidates_on_hot_apply_or_corruption(self):
        # Android stat metadata rendered from real host files, including inode,
        # nanosecond times and symlink identity; macOS stat has no -c option.
        stat = self.base / 'stat.py'
        stat.write_text('import os, sys\nfor path in sys.argv[1:]:\n'
                        ' s = os.lstat(path)\n'
                        ' print(s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)\n')
        self.shell('''conf_activate_runtime || exit 1
stat() { shift 2; ''' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(stat)) + ''' "$@"; }
cache_locks=0
conf_lock_acquire() { cache_locks=$((cache_locks + 1)); _CONF_LOCK_HELD=1; }
conf_lock_release() { _CONF_LOCK_HELD=0; }
load_runtime_conf || exit 2
for i in 1 2 3 4 5 6 7 8 9 10; do
  TS_MODE=invalid
  load_runtime_conf && test "$TS_MODE" = bridge || exit 3
done
test "$cache_locks" = 1 || exit 4
echo 'ROUTE_SCOPE=bypass' >"$_RUNTIME_CONF_DIR/.routes.next"
mv "$_RUNTIME_CONF_DIR/.routes.next" "$_RUNTIME_CONF_DIR/routes.conf"
load_runtime_conf && test "$ROUTE_SCOPE" = bypass && test "$cache_locks" = 2 || exit 5
# Loading desired settings must not poison the cached applied values.
echo 'TS_MODE=proxy' >"$TS_CONF_DIR/foxytail.conf"
load_conf && test "$TS_MODE" = proxy || exit 6
load_runtime_conf && test "$TS_MODE" = bridge && test "$ROUTE_SCOPE" = bypass || exit 7
echo 'TS_MODE=invalid' >"$_RUNTIME_CONF_DIR/foxytail.conf"
load_runtime_conf && exit 8
test -z "$_RUNTIME_CONF_STAMP" || exit 9
echo 'TS_MODE=bridge' >"$_RUNTIME_CONF_DIR/foxytail.conf"
load_runtime_conf || exit 10
rm "$_RUNTIME_CONF_DIR/routes.conf"
ln -s "$TS_CONF_DIR/routes.conf" "$_RUNTIME_CONF_DIR/routes.conf"
load_runtime_conf && exit 11
exit 0
''')

    def test_watchdog_quiet_rounds_do_not_scan_processes_or_rewrite_state(self):
        source = (ROOT / 'tailscale/scripts/foxytail.watchdog').read_text()
        check = source[source.index('check_once() {'):source.index('_watchdog_stop() {')]
        self.shell(check + '''
load_conf; TS_MODE=proxy; MAGIC_DNS=off
MANUAL_STOP_FILE="$TS_RUN_DIR/manual-stop"; BAD_COUNT_FILE="$TS_RUN_DIR/bad"; ROUTE_CACHE="$TS_RUN_DIR/route-cache"
ts_status_json() { echo '{"BackendState":"Running"}'; }
pids_of_path() { echo unexpected >"$TS_RUN_DIR/process-scan"; }
tailnet_reachable() { echo ping >>"$TS_RUN_DIR/probes"; }
log() { :; }
ip() { echo default dev "$network"; }
network=wlan0; check_once
cp -p "$ROUTE_CACHE" "$ROUTE_CACHE.before"
check_once
test ! -e "$BAD_COUNT_FILE" && test ! -e "$TS_RUN_DIR/process-scan" || exit 1
test ! "$ROUTE_CACHE" -nt "$ROUTE_CACHE.before" || exit 2
POWER_SAVE=on; network=wlan1; check_once
POWER_SAVE=off; WATCHDOG_PROBE=off; network=wlan2; check_once
test ! -e "$TS_RUN_DIR/probes" || exit 3
WATCHDOG_PROBE=on; network=wlan3; check_once
test "$(cat "$TS_RUN_DIR/probes")" = ping
''')

    def test_log_monitor_backs_off_when_quiet_and_speeds_up_near_limit(self):
        source = (ROOT / 'tailscale/scripts/foxytail.logd').read_text()
        function = source[source.index('rotate_all() {'):source.index('\ncase "$1" in')]
        self.shell(function + '''
load_runtime_conf() { :; }
LOG_MAX_KB=1; POWER_SAVE=off
echo quiet >"$TS_RUN_DIR/daemon.log"
rotate_all; test "$_la_interval" = 30 || exit 1
POWER_SAVE=on
rotate_all; test "$_la_interval" = 60 || exit 2
head -c 800 /dev/zero >"$TS_RUN_DIR/daemon.log"
rotate_all; test "$_la_interval" = 2 || exit 3
head -c 2000 /dev/zero >"$TS_RUN_DIR/daemon.log"
rotate_all
test ! -s "$TS_RUN_DIR/daemon.log" && test -s "$TS_RUN_DIR/daemon.log.bak"
''')

    def test_status_exposes_runtime_power_preferences_even_when_stopped(self):
        result = self.shell('''load_conf; POWER_SAVE=on; WEBUI_AUTO_REFRESH=off
daemon_up() { return 1; }; daemon_exists() { return 1; }
cmd_status
daemon_up() { return 0; }; daemon_uptime() { echo 12; }
ts_status_json() { echo '{"BackendState":"Running"}'; }
cmd_status
''')
        for line in result.stdout.splitlines():
            value = json.loads(line)
            self.assertTrue(value['powerSave'])
            self.assertFalse(value['autoRefresh'])
