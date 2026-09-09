#!/usr/bin/env python3
"""Generate/check shipped native notices from the pinned, local Go sources.

No license text is fetched separately. Module downloads must already have been
verified by Go; GOPROXY=off makes an incomplete local cache a visible failure.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
NATIVE = ROOT / 'native/foxydns'
DESTINATION = NATIVE / 'THIRD_PARTY_NOTICES.txt'
LICENSE_NAMES = {'LICENSE', 'LICENSE.MD', 'LICENSE.TXT', 'COPYING', 'NOTICE', 'PATENTS'}


def json_stream(text):
    decoder = json.JSONDecoder()
    position = 0
    while position < len(text):
        while position < len(text) and text[position].isspace():
            position += 1
        if position == len(text):
            break
        value, position = decoder.raw_decode(text, position)
        yield value


def licenses(directory):
    files = sorted(path for path in directory.iterdir()
                   if path.is_file() and path.name.upper() in LICENSE_NAMES)
    if not any(path.name.upper().startswith(('LICENSE', 'COPYING')) for path in files):
        raise RuntimeError(f'No cached license found for {directory.name}')
    return files


def generated_notices():
    environment = {**os.environ, 'GOTOOLCHAIN': 'local', 'GOENV': 'off', 'GOWORK': 'off',
                   'GOFLAGS': '', 'GOEXPERIMENT': '', 'GOPROXY': 'off', 'GOSUMDB': 'off',
                   'CGO_ENABLED': '0', 'GOOS': 'linux', 'GOARM': '7'}

    def go(*arguments, arch='arm64'):
        result = subprocess.run(['go', *arguments], cwd=NATIVE,
                                env={**environment, 'GOARCH': arch}, check=True,
                                text=True, capture_output=True)
        return result.stdout

    go_version = go('env', 'GOVERSION').strip()
    expected = next('go' + line.split()[1] for line in (NATIVE / 'go.mod').read_text().splitlines()
                    if line.startswith('go '))
    if go_version != expected:
        raise RuntimeError(f'Notice generation requires {expected}, found {go_version}')
    goroot = Path(go('env', 'GOROOT').strip())
    modules = {}
    vendored = {}
    for architecture in ['arm', 'arm64']:
        for package in json_stream(go('list', '-mod=readonly', '-deps', '-json', '.', arch=architecture)):
            module = package.get('Module')
            if module and not module.get('Main'):
                if module.get('Replace') or not module.get('Version'):
                    raise RuntimeError('Notices require version-pinned module sources')
                modules[(module['Path'], module['Version'])] = Path(module['Dir'])
            directory = Path(package['Dir'])
            if directory.is_relative_to(goroot / 'src/vendor'):
                while directory != goroot / 'src/vendor':
                    if any(path.is_file() and path.name.upper().startswith('LICENSE')
                           for path in directory.iterdir()):
                        vendored[str(directory.relative_to(goroot / 'src/vendor'))] = directory
                        break
                    directory = directory.parent

    sections = [(f'Go runtime and standard library — {go_version}', licenses(goroot))]
    sections += [(f'{path} — {version}', licenses(directory))
                 for (path, version), directory in sorted(modules.items())]
    sections += [(f'{path} — vendored with {go_version}', licenses(directory))
                 for path, directory in sorted(vendored.items())]
    output = [
        'Third-party notices for foxydns\n',
        'This file accompanies the FoxyTail DNS helper built for Linux ARMv7/ARM64\n'
        'with CGO disabled. It retains the notices for its linked module dependencies\n'
        'and the pinned Go runtime/standard library, including used vendored packages.\n'
        'Test-only and developer-tool dependencies are not linked into these binaries.\n'
        'License text below is copied from the local Go module/toolchain source cache.\n'
        'Regenerate with: python3 .github/tools/native-notices.py\n',
    ]
    for title, files in sections:
        output += ['\n' + '=' * 78 + '\n', title + '\n', '=' * 78 + '\n']
        for path in files:
            output += ['\n--- ' + path.name + ' ---\n\n', path.read_text().rstrip() + '\n']
    return ''.join(output), len(modules), len(vendored)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='fail if committed notices differ')
    args = parser.parse_args()
    content, module_count, vendor_count = generated_notices()
    if args.check:
        if not DESTINATION.exists() or DESTINATION.read_text() != content:
            raise SystemExit('Native notices are stale; run python3 .github/tools/native-notices.py')
    else:
        DESTINATION.write_text(content)
    print(f'Native notices {"verified" if args.check else "generated"}: '
          f'{module_count} linked modules, Go runtime, {vendor_count} Go vendor notices')


if __name__ == '__main__':
    main()
