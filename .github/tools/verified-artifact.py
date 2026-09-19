#!/usr/bin/env python3
"""Reuse release artifacts only from this repository's successful exact-SHA Verify runs."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import zipfile

WORKFLOW = 'shellcheck.yml'


def api(path, *, ref=None):
    command = ['gh', 'api', path]
    if ref is not None:
        command += ['--method', 'POST', '-f', 'ref=' + ref]
    else:
        command += ['--paginate', '--slurp']
    result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=60)
    return json.loads(result.stdout) if result.stdout.strip() else None


def lookup(repository, sha, exclude=''):
    pages = api(f'repos/{repository}/actions/workflows/{WORKFLOW}/runs?head_sha={sha}&per_page=100')
    runs = sorted((run for page in pages for run in page['workflow_runs']
                   if run['head_sha'] == sha and str(run['id']) != str(exclude)
                   and run['head_repository']['full_name'] == repository
                   and run['path'] == '.github/workflows/' + WORKFLOW
                   and run['event'] in ('push', 'workflow_dispatch')),
                  key=lambda run: run['id'], reverse=True)
    if exclude:
        # The caller already owns Verify's SHA concurrency slot. Other queued
        # runs are waiting on it and must not hide an existing reusable package.
        runs = [run for run in runs if run['status'] == 'completed']
    if not runs:
        return 'missing', ''
    latest = str(runs[0]['id'])
    if any(run['status'] != 'completed' for run in runs):
        return 'pending', latest
    if runs[0]['conclusion'] != 'success':
        return 'failed', latest
    for run in runs:
        if run['conclusion'] != 'success':
            continue
        pages = api(f"repos/{repository}/actions/runs/{run['id']}/artifacts?per_page=100")
        for page in pages:
            for artifact in page['artifacts']:
                if (artifact['name'] == 'verified-' + sha and not artifact['expired']
                        and artifact['workflow_run']['id'] == run['id']
                        and artifact['workflow_run']['head_sha'] == sha):
                    return 'ready', str(run['id'])
    return 'missing', latest


def ensure(repository, sha, tag, timeout=1800):
    deadline = time.monotonic() + timeout
    dispatched_after = None
    while time.monotonic() < deadline:
        state, run = lookup(repository, sha)
        if state == 'ready':
            return run
        if state == 'failed':
            raise RuntimeError(f'Verify run {run} failed; fix or explicitly rerun that gate before publishing')
        if state == 'missing':
            if dispatched_after is None:
                api(f'repos/{repository}/actions/workflows/{WORKFLOW}/dispatches', ref=tag)
                dispatched_after = run
            elif run != dispatched_after:
                raise RuntimeError(f'Verify run {run} completed without release artifacts; check its workflow and upload step')
        print(f'Waiting for Verify at {sha}: {state}', file=sys.stderr)
        time.sleep(20)
    raise RuntimeError(f'Verify did not produce artifacts for {sha} within {timeout} seconds')


def check_packages(directory, tag):
    expected = {f'FoxyTail-{tag}.zip', f'FoxyTail-{tag}-full.zip'}
    directory = Path(directory)
    if {path.name for path in directory.iterdir()} != expected | {'SHA256SUMS'}:
        raise ValueError('release artifact must contain exactly the two versioned ZIPs and SHA256SUMS')
    hashes = {}
    for line in (directory / 'SHA256SUMS').read_text().splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  (\S+)', line)
        if not match or match[2] not in expected or match[2] in hashes:
            raise ValueError('invalid or duplicate release checksum entry')
        hashes[match[2]] = match[1]
    if set(hashes) != expected:
        raise ValueError('release checksums do not cover both ZIPs')
    for name, digest in hashes.items():
        path = directory / name
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                raise ValueError(f'checksum mismatch: {name}')
        with zipfile.ZipFile(path) as archive:
            versions = re.findall(r'^version=(.+)$', archive.read('module.prop').decode(), re.MULTILINE)
            if versions != [tag]:
                raise ValueError(f'package version does not match {tag}: {name}')


def main():
    command, value, *args = sys.argv[1:]
    if command == 'check':
        if not re.fullmatch(r'v\d+\.\d+\.\d+(-rc\.\d+)?', value):
            raise ValueError('invalid release tag')
        check_packages(args[0], value)
        return
    if not re.fullmatch(r'[0-9a-f]{40}', value):
        raise ValueError('expected a full source commit SHA')
    repository = os.environ['GITHUB_REPOSITORY']
    if command == 'find':
        state, run = lookup(repository, value, os.environ['GITHUB_RUN_ID'])
        print(run if state == 'ready' else '')
    elif command == 'ensure':
        if not re.fullmatch(r'v\d+\.\d+\.\d+(-rc\.\d+)?', args[0]):
            raise ValueError('invalid release tag')
        print(ensure(repository, value, args[0]))
    else:
        raise ValueError('usage: verified-artifact.py find SHA | ensure SHA TAG | check TAG DIRECTORY')


if __name__ == '__main__':
    main()
