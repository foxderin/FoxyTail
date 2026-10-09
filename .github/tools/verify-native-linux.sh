#!/usr/bin/env bash
# Real-kernel DNS integration. Only the test inside a new network AND mount
# namespace may touch netfilter; no ip/iptables command is run on the host.
set -euo pipefail
cd "$(dirname "$0")/../.."
unavailable() {
  if [ "${FOXYTAIL_REQUIRE_PRIVILEGED_TESTS:-0}" = 1 ]; then
    echo "ERROR: required privileged DNS integration unavailable: $*" >&2
    exit 1
  fi
  echo "SKIP: $*"
  exit 0
}
if [ "$(uname -s)" != Linux ]; then
  unavailable 'privileged DNS integration requires a Linux kernel.'
fi
for command in go unshare ip iptables ip6tables timeout; do
  if ! command -v "$command" >/dev/null; then
    unavailable "privileged DNS integration requires ${command}."
  fi
done
privilege=()
if [ "$(id -u)" != 0 ]; then
  if ! command -v sudo >/dev/null || ! sudo -n true 2>/dev/null; then
    unavailable 'isolated DNS integration requires root or passwordless sudo.'
  fi
  privilege=(sudo -n)
fi
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
if ! "${privilege[@]}" unshare --net --mount --fork --propagation private true >"$work_dir/probe.log" 2>&1; then
  cat "$work_dir/probe.log"
  unavailable 'the runner does not permit isolated network/mount namespaces.'
fi
export GOTOOLCHAIN=local GOENV=off GOWORK=off GOFLAGS='' GOEXPERIMENT=''
expected_go="go$(awk '$1=="go" {print $2}' native/foxydns/go.mod)"
[ "$(go env GOVERSION)" = "$expected_go" ] || { echo "requires ${expected_go}" >&2; exit 1; }
(cd native/foxydns && CGO_ENABLED=0 go test -mod=readonly -c -trimpath -o "$work_dir/foxydns-e2e.test" .)
parent_netns=$(readlink /proc/self/ns/net)
parent_mntns=$(readlink /proc/self/ns/mnt)
echo 'Running real DNS ownership checks in separate disposable network namespaces.'
for group in DNS LegacyOwnership; do
  timeout --signal=TERM --kill-after=10s 75s "${privilege[@]}" \
    unshare --net --mount --fork --kill-child --propagation private \
    env FOXYTAIL_PRIVILEGED_TESTS=1 FOXYTAIL_TEST_PARENT_NETNS="$parent_netns" \
      FOXYTAIL_REQUIRE_PRIVILEGED_TESTS="${FOXYTAIL_REQUIRE_PRIVILEGED_TESTS:-0}" \
      FOXYTAIL_TEST_PARENT_MNTNS="$parent_mntns" FOXYTAIL_TEST_REPO_ROOT="$PWD" \
      "$work_dir/foxydns-e2e.test" -test.v -test.timeout=60s -test.run="^TestPrivileged${group}" \
    | tee "$work_dir/result-$group.log"
  if grep -q '^--- SKIP: TestPrivileged' "$work_dir/result-$group.log"; then
    unavailable 'kernel integration did not execute; see the explicit capability reason above.'
  fi
done
for test in TestPrivilegedDNSNamespace TestPrivilegedDNSIsolatedSocketUID TestPrivilegedDNSSocketTupleAmbiguity TestPrivilegedLegacyOwnershipNamespace; do
  if ! grep -q "^--- PASS: ${test} " "$work_dir"/result-*.log; then
    echo "ERROR: privileged DNS test ${test} produced no verified result." >&2
    exit 1
  fi
done
echo 'Verified: real UDP/TCP Tailnet resolution, original DNS forwarding, socket credentials and owned-rule cleanup.'
