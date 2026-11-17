"""Power controls and idle work, exercised through the real shell helpers."""
import json
import shlex
import sys

from api_fixture import ApiTestCase, ROOT


class PowerTests(ApiTestCase):


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


    def test_watchdog_honors_both_holds_and_ignores_unknown_network(self):
        source = (ROOT / 'tailscale/scripts/foxytail.watchdog').read_text()
        check = source[source.index('check_once() {'):source.index('_watchdog_stop() {')]
        self.shell(check + '''
load_conf; TS_MODE=proxy; MAGIC_DNS=off
BAD_COUNT_FILE="$TS_RUN_DIR/bad"; ROUTE_CACHE="$TS_RUN_DIR/route-cache"
ts_status_json() { echo queried >>"$TS_RUN_DIR/queries"; echo '{"BackendState":"Running"}'; }
for hold in manual-stop context-stop; do
  touch "$TS_RUN_DIR/$hold"
  check_once || exit 1
  test ! -e "$TS_RUN_DIR/queries" || exit 2
  rm "$TS_RUN_DIR/$hold"
done
network_snapshot() { echo '{"known":false}'; return 1; }
echo accepted >"$ROUTE_CACHE"
check_once || exit 3
test "$(cat "$ROUTE_CACHE")" = accepted || exit 4
test "$(cat "$TS_RUN_DIR/queries")" = queried
''')
