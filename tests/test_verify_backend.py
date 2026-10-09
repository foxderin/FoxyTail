"""Exercise real module subprocesses without running the backend recursively."""
from contextlib import redirect_stdout
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('verify_backend', ROOT / '.github/tools/verify-backend.py')
verify_backend = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify_backend)


class BackendRunnerTests(unittest.TestCase):
    def test_modules_overlap_in_isolated_processes_and_failures_propagate(self):
        for fail in (False, True):
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'fixture.py').write_text('VALUE = 42\n')
                for name in ('a', 'b', 'c'):
                    (root / f'test_{name}.py').write_text('''import os
from pathlib import Path
import time
import unittest
from fixture import VALUE

class ModuleTests(unittest.TestCase):
    def test_isolated_module(self):
        name = __name__.removeprefix('test_')
        self.assertEqual(VALUE, 42)
        self.assertNotIn('FOXYTAIL_RUNNER_PROCESS_MARKER', os.environ)
        os.environ['FOXYTAIL_RUNNER_PROCESS_MARKER'] = name
        Path(name + '.pid').write_text(str(os.getpid()))
        if name in ('a', 'b'):
            deadline = time.monotonic() + 5
            while not all(Path(peer + '.pid').exists() for peer in ('a', 'b')):
                self.assertLess(time.monotonic(), deadline, 'modules did not overlap')
                time.sleep(0.01)
        else:
            self.assertTrue(any(Path(peer + '.done').exists() for peer in ('a', 'b')),
                            'more than two modules ran at once')
        Path(name + '.done').touch()
''' + ("        self.fail('intentional module failure')\n" if fail and name == 'b' else ''))
                log = io.StringIO()
                with redirect_stdout(log):
                    code = verify_backend.verify(root, workers=2)
                self.assertEqual(code, int(fail), log.getvalue())
                self.assertEqual(len({path.read_text() for path in root.glob('*.pid')}), 3)
                self.assertEqual(len(list(root.glob('*.done'))), 3)
                for name in ('a', 'b', 'c'):
                    self.assertIn(f'::group::test_{name}.py (', log.getvalue())
                self.assertEqual(log.getvalue().count('::endgroup::'), 3)
                self.assertIn(f'Backend: 3 modules, {int(fail)} failed, ', log.getvalue())
                self.assertIn('s total', log.getvalue())

    def test_empty_discovery_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'no backend test modules'):
                verify_backend.verify(Path(directory), workers=2)
