#!/usr/bin/env bash
# Build first-party Android helpers from the tagged source, with a fixed Go
# toolchain and no dynamic linker/NDK dependency. Go's ordinary compilation
# cache is safe to reuse; no generated binaries or hashes enter the source tree.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ "$#" != 1 ]; then
  echo "usage: $0 <output-directory>" >&2
  exit 1
fi
for cmd in go python3; do
  command -v "$cmd" >/dev/null || { echo "missing native builder: $cmd" >&2; exit 1; }
done
export GOTOOLCHAIN=local GOENV=off GOWORK=off GOFLAGS='' GOEXPERIMENT=''
required_go="go$(awk '$1=="go" {print $2}' native/foxydns/go.mod)"
actual_go=$(go env GOVERSION)
if [ "$actual_go" != "$required_go" ]; then
  echo "native build requires ${required_go}; found ${actual_go}" >&2
  exit 1
fi
mkdir -p "$1"
output_dir=$(cd "$1" && pwd)
for helper in foxydns foxyfiles; do
  test "$(awk '$1=="go" {print $2}' "native/$helper/go.mod")" = "${required_go#go}" || {
    echo "native helper $helper requires a different Go toolchain" >&2; exit 1;
  }
  for arch in arm arm64; do
    echo "- Building ${helper}-${arch} (${required_go})"
    (cd "native/$helper" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" GOARM=7 \
      go build -mod=readonly -trimpath -buildvcs=false -ldflags='-s -w -buildid=' \
        -o "${output_dir}/${helper}-${arch}" .)
  done
done

# A linux static executable runs on Android without a bionic interpreter.
# Check the ELF itself rather than depending on a platform-specific `file`.
python3 - "$output_dir" <<'PYELF'
from pathlib import Path
import struct
import sys

root = Path(sys.argv[1])
for name, arch, elf_class, machine in [(name, arch, elf_class, machine)
        for name in ('foxydns', 'foxyfiles')
        for arch, elf_class, machine in [('arm', 1, 40), ('arm64', 2, 183)]]:
    path = root / (name + '-' + arch)
    data = path.read_bytes()
    assert data[:6] == b'\x7fELF' + bytes([elf_class, 1]), path
    assert struct.unpack_from('<HH', data, 16) == (2, machine), path
    if elf_class == 1:
        offset = struct.unpack_from('<I', data, 28)[0]
        size, count = struct.unpack_from('<HH', data, 42)
    else:
        offset = struct.unpack_from('<Q', data, 32)[0]
        size, count = struct.unpack_from('<HH', data, 54)
    types = {struct.unpack_from('<I', data, offset + i * size)[0] for i in range(count)}
    assert not types.intersection({2, 3}), f'{path}: dynamic linker dependency'
    path.chmod(0o755)
    print(f'  {path.name}: verified static ELF ({len(data)} bytes)')
PYELF
