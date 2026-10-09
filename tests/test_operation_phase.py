"""Real process races between supervised restore staging and irreversible commit."""
import json
from pathlib import Path
import subprocess
import time

from api_fixture import ApiTestCase


class OperationPhaseTests(ApiTestCase):
    def launch(self, body):
        process = subprocess.Popen(['sh', '-c', '. "$1"\n' + body, 'phase', str(self.lib)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop, process)
        return process

    def stop(self, process):
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=10)

    def await_file(self, path):
        deadline = time.monotonic() + 8
        while not path.exists():
            if time.monotonic() > deadline:
                self.fail('operation failed to reach its boundary: ' + str(path))
            time.sleep(0.02)

    def test_cancellation_wins_staging_and_prevents_commit(self):
        request_id = str(int(time.time())) + '_restore_stage'
        process = self.launch('_op_init ' + request_id + ''' restore
_op_exec 15 sh -c 'touch "$1/staged"; sleep 10' stage "$TS_DIR" || exit 130
_op_commit_begin || exit 130
touch "$TS_DIR/committed"
''')
        self.await_file(self.base / 'staged')
        result = self.shell('cmd_cancel ' + request_id)
        self.assertTrue(json.loads(result.stdout)['cancelled'])
        process.communicate(timeout=10)
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse((self.base / 'committed').exists())
        self.assertEqual((self.run / 'operations' / request_id / 'phase').readlink(), Path('cancelled'))

    def test_commit_wins_without_cancellation_tombstone(self):
        request_id = str(int(time.time())) + '_restore_commit'
        process = self.launch('_op_init ' + request_id + ''' restore
_op_commit_begin || exit 2
touch "$TS_DIR/committing"
while [ ! -f "$TS_DIR/release" ]; do sleep 0.05; done
touch "$TS_DIR/committed"
''')
        self.await_file(self.base / 'committing')
        result = self.shell('cmd_cancel ' + request_id, ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertEqual((self.run / 'operations' / request_id / 'phase').readlink(), Path('committing'))
        (self.base / 'release').touch()
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, stdout + stderr)
        self.assertTrue((self.base / 'committed').exists())
        late = json.loads(self.shell('cmd_cancel ' + request_id).stdout)
        self.assertTrue(late['completed'])
        self.assertFalse(late.get('cancelled', False))

    def test_timeout_kills_owned_descendants_before_terminal_response(self):
        request_id = str(int(time.time())) + '_child_timeout'
        process = self.launch('_op_init ' + request_id + r''' traffic
_op_exec 1 sh -c 'sh -c '\''trap "" TERM; echo $$ >"$1/child-pid"; while :; do sleep 1; done'\'' child "$1" & wait' parent "$TS_DIR"
''')
        self.await_file(self.base / 'child-pid')
        child = int((self.base / 'child-pid').read_text())
        stdout, stderr = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 124, stdout + stderr)
        result = self.shell('_proc_starttime ' + str(child), ok=False)
        self.assertNotEqual(result.returncode, 0, 'owned descendant survived the terminal response')
        self.assertTrue((self.run / 'operations' / request_id / 'done').exists())
