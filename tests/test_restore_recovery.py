"""Untrappable restore exits recover through the real shared configuration lock."""
import base64
import hashlib
import json
import shlex
import unittest

from api_fixture import ApiTestCase


class RestoreRecoveryTests(ApiTestCase):
    def prepare_restore(self):
        (self.conf / 'foxytail.conf').write_text('TS_MODE=proxy\nSOCKS_PORT=1277\nMAGIC_DNS=off\n')
        (self.conf / 'routes.conf').write_text('ROUTE_SCOPE=selected\nUID_LIST="10001"\n')
        (self.conf / 'context.conf').write_text('cellular:-:no-exit-node\n')
        self.previous = self.snapshot()
        self.shell('conf_activate_runtime')
        self.archive_path = self.archive({
            'conf/foxytail.conf': 'TS_MODE=bridge\nSOCKS_PORT=1456\nMAGIC_DNS=off\n',
            'conf/routes.conf': 'ROUTE_SCOPE=bypass\nUID_LIST="10002"\n',
            'conf/context.conf': 'cellular:-:exit-node:100.64.0.2\n',
        })
        baseline = self.shell('conf_lock_acquire && _restore_baseline').stdout.strip()
        self.restore_command = ('cmd_restore ' + shlex.quote(str(self.archive_path)) + ' ' +
                                hashlib.sha256(self.archive_path.read_bytes()).hexdigest() + ' ' + baseline)

    def interrupt_restore(self, boundary):
        # Run the real rename first, then kill the actual shell executing the
        # restore subshell (POSIX $$ still names its parent). No EXIT trap runs.
        conditions = {
            'journal': '[ "$src" = "$_rt_tmp/journal" ]',
            'previous': '[ "$src" = "$TS_CONF_DIR" ]',
            'candidate': '[ "$src" = "$_rt_tmp/next" ]',
            'pending': '[ "$dst" = "$TS_RUN_DIR/settings.pending" ]',
            'commit': '[ "$dst" = "$TS_DIR/.restore-transaction/committed" ]',
            'retire': '[ "$src" = "$TS_DIR/.restore-transaction" ]',
        }
        result = self.shell('''
mv() {
  src=$1
  dst=$2
  command mv "$@" || return
  if ''' + conditions[boundary] + '''; then
    sh -c 'kill -KILL "$PPID"'
  fi
}
''' + self.restore_command, ok=False)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_uncommitted_boundaries_restore_prior_set_before_load_or_activation(self):
        for boundary in ('journal', 'previous', 'candidate', 'pending'):
            with self.subTest(boundary=boundary):
                self.prepare_restore()
                self.interrupt_restore(boundary)
                output = self.shell('''
load_conf || exit 1
printf '%s\n' "$TS_MODE:$SOCKS_PORT:$ROUTE_SCOPE:$UID_LIST"
conf_activate_runtime || exit 2
load_runtime_conf || exit 3
printf '%s\n' "$TS_MODE:$SOCKS_PORT:$ROUTE_SCOPE:$UID_LIST"
''').stdout.splitlines()
                self.assertEqual(output, ['proxy:1277:selected:10001'] * 2)
                self.assertEqual(self.snapshot(), self.previous)
                self.assertFalse((self.base / '.restore-transaction').exists())

    def test_committed_boundaries_keep_candidate_and_previous_backup(self):
        for boundary in ('commit', 'retire'):
            with self.subTest(boundary=boundary):
                self.prepare_restore()
                self.interrupt_restore(boundary)
                result = self.shell('load_conf && printf "%s\\n" "$TS_MODE:$SOCKS_PORT:$ROUTE_SCOPE:$UID_LIST"')
                self.assertEqual(result.stdout.strip(), 'bridge:1456:bypass:10002')
                self.assertEqual((self.conf / 'context.conf').read_text(), 'cellular:-:exit-node:100.64.0.2\n')
                backups = list(self.base.glob('conf.bak-*'))
                self.assertTrue(any({p.name: p.read_bytes() for p in backup.iterdir()} == self.previous for backup in backups))
                self.assertTrue((self.run / 'settings.pending').exists())
                self.assertEqual(self.shell('load_runtime_conf && echo "$SOCKS_PORT"').stdout.strip(), '1277')
                self.assertFalse((self.base / '.restore-transaction').exists())

    def test_recovery_itself_can_be_interrupted_and_retried(self):
        self.prepare_restore()
        self.interrupt_restore('candidate')
        result = self.shell('''
mv() {
  command mv "$@" || return
  case "$1" in "$TS_DIR"/conf.bak-*) sh -c 'kill -KILL "$PPID"' ;; esac
}
load_conf
''', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.base / '.restore-transaction').exists())
        self.shell('load_conf && test "$TS_MODE:$SOCKS_PORT:$ROUTE_SCOPE" = proxy:1277:selected')
        self.assertEqual(self.snapshot(), self.previous)
        self.assertFalse((self.base / '.restore-transaction').exists())

    def test_context_writer_recovers_before_creating_missing_live_directory(self):
        self.prepare_restore()
        self.interrupt_restore('previous')
        context = 'cellular:-:exit-node:100.64.0.3\n'
        payload = base64.b64encode(context.encode()).decode()
        result = json.loads(self.shell('cmd_context_set ' + shlex.quote(payload)).stdout)
        self.assertTrue(result['ok'])
        self.assertEqual((self.conf / 'foxytail.conf').read_bytes(), self.previous['foxytail.conf'])
        self.assertEqual((self.conf / 'routes.conf').read_bytes(), self.previous['routes.conf'])
        self.assertEqual((self.conf / 'context.conf').read_text(), context)

    def test_failed_recovery_blocks_writer_and_remains_retryable(self):
        self.prepare_restore()
        self.interrupt_restore('candidate')
        result = self.shell('''
rm() { [ "$*" != "-rf $TS_CONF_DIR" ] || return 1; command rm "$@"; }
conf_write_key foxytail.conf SOCKS_PORT 1555
''', ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.base / '.restore-transaction').exists())
        self.shell('conf_write_key foxytail.conf SOCKS_PORT 1555')
        result = self.shell('load_conf && echo "$TS_MODE:$SOCKS_PORT:$ROUTE_SCOPE"')
        self.assertEqual(result.stdout.strip(), 'proxy:1555:selected')
        self.assertEqual((self.conf / 'context.conf').read_bytes(), self.previous['context.conf'])
        self.assertFalse((self.base / '.restore-transaction').exists())


if __name__ == '__main__':
    unittest.main()
