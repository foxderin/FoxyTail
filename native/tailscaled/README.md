# Pinned daemon source build

The daemon remains based on `anasfanani/tailscale-android-cli` v1.98.8-android, exact commit in `SOURCE`. `android-rule-events.patch` is a local, BSD-3-Clause-compatible patch, not a swap to another daemon fork:

- Subscribe to IPv6 rule-deletion events as well as IPv4.
- Decode `fib_rule_hdr`/`FRA_*`, including full 32-bit table IDs, rather than treating FIB rules as route messages. Malformed events are ignored without publishing a fabricated deletion.
- Include Android priorities 12500/13001 in the existing rate-limited rule-restoration trigger. It still uses priorities, not precise rule ownership; same-priority other-table deletions can trigger rechecking, as the original table-agnostic design did.

No fwmarks, routing rule shape, DNS behavior, UID policy, subnet/hotspot forwarding, identity schema or Taildrop location changes are included.

## Build / distribution

`.github/tools/build-daemon.sh OUTPUT` fetches the exact source commit, applies the checked-in patch, verifies the upstream toolchain revision and NDK r27c revision, runs focused host tests, then builds Android arm/arm64 PIE executables. Source/patch/toolchain/NDK provenance is emitted in `daemon-build.txt`. Go trimpath/buildvcs=false and explicit version stamps avoid random checkout paths and timestamps. arm64 ELF load alignment must support 16 KiB pages. The official NDK must already be installed; the script never accepts licenses or silently substitutes host compilers.

Both architectures are built in the release workflow. Deterministic daemon archives containing the executable and upstream license are uploaded alongside that same FoxyTail module release. Full ZIPs bundle the binaries. Light ZIPs retain their smaller download-at-install behavior, but obtain the **matching FoxyTail release asset**, not an unpatched upstream fallback. Both verify daemon hashes from the package's source-built `native-checksums.txt`. Missing asset, digest mismatch or build failure aborts; previous installed state remains untouched until the ordinary installation transaction.

The hashes are build-output integrity pins carried by the module package, not signatures proving the package's publisher. Download the module from its trusted release source. No daemon assets or releases are published by local test runs.

## Verification limits

Focused parser and priority tests cover IPv4/IPv6, UID-range attributes, 32-bit table, padding, malformed/duplicate scalar attributes, Android and Linux priority boundaries. Synthetic package tests exercise light/full consistency and missing/tampered daemon rejection. Android compile/ELF checks are not evidence of on-device VPN, netd, SELinux or routing behavior. Real-device acceptance should delete only known test rules under an isolated test configuration and confirm bounded restoration; never delete arbitrary user routing rules.

Local verification: both NDK-built architectures passed ELF checks; two independent temporary source checkouts produced identical per-architecture SHA256 values. Six package/installer fixture methods and twelve lifecycle methods passed. This is not a signed release build or device execution.
