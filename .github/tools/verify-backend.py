#!/usr/bin/env python3
"""Run isolated backend test modules concurrently, retaining each module's log."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]


def run_module(path):
    started = time.monotonic()
    try:
        result = subprocess.run(
            [sys.executable, '-m', 'unittest', '-v', path.stem], cwd=path.parent,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            timeout=300,
        )
        return result.returncode, result.stdout, time.monotonic() - started
    except subprocess.TimeoutExpired as error:
        output = error.stdout or ''
        if isinstance(output, bytes):
            output = output.decode(errors='replace')
        return 1, f'{output}\n{path.name}: module timed out after 300s\n', time.monotonic() - started


def verify(test_dir, workers):
    modules = sorted(test_dir.glob('test_*.py'))
    if not modules:
        raise RuntimeError(f'no backend test modules in {test_dir}')
    started = time.monotonic()
    failures = 0
    print(f'Running {len(modules)} backend modules with {workers} workers', flush=True)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = {pool.submit(run_module, path): path for path in modules}
        for future in as_completed(pending):
            path = pending[future]
            code, output, elapsed = future.result()
            failures += code != 0
            print(f'::group::{path.name} ({elapsed:.1f}s, exit {code})')
            print(output, end='' if output.endswith('\n') else '\n')
            print('::endgroup::', flush=True)
    print(f'Backend: {len(modules)} modules, {failures} failed, '
          f'{time.monotonic() - started:.1f}s total', flush=True)
    return int(failures != 0)


if __name__ == '__main__':
    sys.exit(verify(ROOT / 'tests', min(4, os.cpu_count() or 1)))
