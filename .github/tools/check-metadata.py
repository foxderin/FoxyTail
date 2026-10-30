#!/usr/bin/env python3
"""All release metadata must describe the same tagged source tree."""
import json
import re
from pathlib import Path

props = dict(line.split('=', 1) for line in Path('module.prop').read_text().splitlines() if '=' in line)
version = props['version']
assert re.fullmatch(r'v\d+\.\d+\.\d+(?:-rc\.\d+)?', version), version
update = json.loads(Path('update.json').read_text())
assert update['version'] == version
assert update['versionCode'] == int(props['versionCode'])
assert update['zipUrl'].endswith(f'/releases/download/{version}/FoxyTail-{version}.zip')
changelog = Path('CHANGELOG.md').read_text()
top = re.search(r'^##\s+\[?(v\d+\.\d+\.\d+(?:-rc\.\d+)?)\]?', changelog, re.M)
assert top is not None, 'CHANGELOG.md has no version heading'
assert top.group(1) == version, f'CHANGELOG.md top entry {top.group(1)} != module.prop {version}'
print(f'Release metadata consistent: {version} / {props["versionCode"]}')
