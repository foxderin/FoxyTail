#!/usr/bin/env bash
# Build the pinned Android daemon with a reviewed local netlink patch.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=native/tailscaled/SOURCE
source native/tailscaled/SOURCE
[[ $# == 1 ]] || { echo 'usage: build-daemon.sh <output-directory>' >&2; exit 1; }
mkdir -p "$1"
out=$(cd "$1" && pwd)
ndk="${ANDROID_NDK_HOME:-${ANDROID_HOME:?ANDROID_HOME required}/ndk/$DAEMON_NDK}"
test "$(sed -n 's/^Pkg.Revision[[:space:]]*=[[:space:]]*//p' "$ndk/source.properties")" = "$DAEMON_NDK"
cc="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin"
test -x "$cc/aarch64-linux-android21-clang"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# A full commit pin, not a release-name lookup. Never fall back to an old binary.
git -C "$work" init -q
git -C "$work" remote add origin "$DAEMON_REPO"
git -C "$work" fetch -q --depth 1 origin "$DAEMON_COMMIT"
git -C "$work" checkout -q --detach FETCH_HEAD
test "$(git -C "$work" rev-parse HEAD)" = "$DAEMON_COMMIT"
test "$(cat "$work/go.toolchain.rev")" = "$DAEMON_TOOLCHAIN"
git -C "$work" apply --check "$PWD/native/tailscaled/android-rule-events.patch"
git -C "$work" apply "$PWD/native/tailscaled/android-rule-events.patch"
patch_sha=$(sha256sum native/tailscaled/android-rule-events.patch | cut -d' ' -f1)
cd "$work"
# tool/go downloads the upstream's commit-pinned Tailscale Go toolchain.
export TS_USE_TOOLCHAIN=1 GOWORK=off GOFLAGS='' GOEXPERIMENT=''
./tool/go test ./net/netmon ./wgengine/router/osrouter -run 'TestDecodeDeletedRule|TestIgnoreDuplicateNEWADDR|TestDeletedRulePriorityOwnership'
remove='aws,bird,tap,kube,completion,completion_scripts,wakeonlan,capture,systray,syspolicy,appconnectors,identityfederation,usermetrics,logtail,netlog,linuxdnsfight,tpm'
tags=$(./tool/go run ./cmd/featuretags --remove "$remove" --add cli)
for arch in arm arm64; do
  case "$arch" in arm) compiler=armv7a-linux-androideabi21-clang ;; arm64) compiler=aarch64-linux-android21-clang ;; esac
  CGO_LDFLAGS='-Wl,-z,max-page-size=16384' CGO_ENABLED=1 GOOS=android GOARCH="$arch" GOARM=7 CC="$cc/$compiler" \
    ./tool/go build -mod=readonly -trimpath -buildvcs=false -tags="$tags" \
    -ldflags="-s -w -buildid= -X tailscale.com/version.shortStamp=$DAEMON_VERSION -X tailscale.com/version.longStamp=$DAEMON_VERSION-foxytail-netlink1 -X tailscale.com/version.gitCommitStamp=$DAEMON_COMMIT" \
    -o "$out/tailscaled-$arch" ./cmd/tailscaled
  test -s "$out/tailscaled-$arch"
done
printf 'source=%s\npatch_sha256=%s\ntoolchain=%s\nndk=%s\n' "$DAEMON_COMMIT" "$patch_sha" "$DAEMON_TOOLCHAIN" "$DAEMON_NDK" > "$out/daemon-build.txt"
(cd "$out" && sha256sum tailscaled-arm tailscaled-arm64 > daemon-checksums.txt)

# Reject wrong-architecture or non-PIE output before packaging. Android arm64
# needs 16 KiB-compatible load segments; no claim of device runtime testing.
python3 - "$out" <<'PYELF'
from pathlib import Path
import struct
import sys
for arch, cls, machine in [('arm', 1, 40), ('arm64', 2, 183)]:
    data = (Path(sys.argv[1]) / ('tailscaled-' + arch)).read_bytes()
    assert data[:6] == b'\x7fELF' + bytes([cls, 1]), 'expected little-endian ELF'
    assert struct.unpack_from('<HH', data, 16) == (3, machine), 'expected Android PIE architecture'
    if cls == 2:
        start = struct.unpack_from('<Q', data, 32)[0]
        step, count = struct.unpack_from('<HH', data, 54)
        for n in range(count):
            pos = start + n * step
            if struct.unpack_from('<I', data, pos)[0] == 1:
                assert struct.unpack_from('<Q', data, pos + 48)[0] >= 16384, 'arm64 load alignment below 16 KiB'
PYELF
