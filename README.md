# FoxyTail

**Tailscale mesh VPN on Android as a Magisk/KernelSU module** — `tailscaled` runs natively on the device, with three run modes, policy-based routing, traffic analytics, MagicDNS split-DNS, coexistence probes for other proxy/firewall modules, a watchdog, network-context awareness, one-shot diagnostics, and a built-in WebUI for day-to-day management.

Data directory: `/data/adb/foxytail` (binaries, scripts, config, state, backups).
Module config: [tailscale/conf/foxytail.conf](tailscale/conf/foxytail.conf), [routes.conf](tailscale/conf/routes.conf), [context.conf](tailscale/conf/context.conf).

中文文档：[README.zh-CN.md](README.zh-CN.md)

## Relationship to Magisk-Tailscaled

FoxyTail is inspired by [anasfanani/Magisk-Tailscaled](https://github.com/anasfanani/Magisk-Tailscaled) — full credit for the original idea of shipping `tailscaled` as a Magisk module. FoxyTail is a clean-room rewrite, started because the original installer hid download/unzip failures behind `2>/dev/null || true`, pulled unpinned `latest` releases without integrity checks, mislabeled `/data/adb` files with the `system_file` SELinux context, used a 4-segment version scheme, and parsed GitHub API JSON with grep/sed. FoxyTail pins every upstream version ([tailscale/VERSIONS](tailscale/VERSIONS)), verifies every binary with SHA256 ([tailscale/checksums.txt](tailscale/checksums.txt)), and fails loudly.

## Feature matrix

| Feature | Status | Notes |
|---|---|---|
| Three run modes (`bridge` / `tun` / `proxy`) | ✅ | hot-switch via CLI; `tun` requires `/dev/net/tun` |
| Route scope (`all` / `selected` / `bypass`) | ✅ | selected/bypass require bridge and kernel `xt_owner` |
| Dedicated policy routing (table 1052, fwmark `0x40000000/0x40000000`) | ✅ | main table is never touched |
| Traffic analytics (`foxytail.stats`) | ✅ | JSONL ring buffer, 7-day default retention (`STATS_RETENTION_DAYS`), screen-off throttling |
| MagicDNS split-DNS (`foxytail.dns`) | ✅ | Built-in generic DNS endpoint, optional transparent coexistence, legacy dnsmasq support |
| IPv6 dual-stack | ✅ | `IPV6=on`, symmetric ip6tables rules |
| Coexistence probes (`foxytail.compat`) | ✅ | Clash/mihomo, AFWall+, NetGuard detection |
| Watchdog (`foxytail.watchdog`) | ✅ | crash restart + network-change rebind |
| Network-context awareness (`foxytail.context`) | ✅ | rules by Wi-Fi SSID / cellular |
| One-shot diagnostics bundle (`foxytail.diag`) | ✅ | tar.gz to `/sdcard/Download` |
| Module toggle via manager | ✅ | inotify watcher on the disable flag |
| WebUI (12 pages) | ✅ | KernelSU/MMRL only (the Magisk app has no WebUI support), see below |
| Light / full release zips, `update.json` OTA | ✅ | |

## Installation

Two packages are published on the [Releases](../../releases) page:

- **`FoxyTail-<version>.zip` (light)** — the installer downloads `tailscaled`, `jq` and `hev-socks5-tunnel` at install time from their pinned upstream releases and verifies each against `checksums.txt` (SHA256). Requires internet during install.
- **`FoxyTail-<version>-full.zip` (full)** — all binaries bundled; installs offline. The bundled binaries are SHA256-verified too, so a tampered zip is rejected.

Flash either zip in Magisk Manager, KernelSU Manager or MMRL, then reboot (or use the `/dev/` shortcuts the installer prints until you do).

Requirements: arm or arm64 device, Magisk v20.4+ or KernelSU ≥ 10670. Upgrades preserve your state, config and hook files (see below).

## Uninstall & reinstall

Removing the module from Magisk/KernelSU runs `uninstall.sh`: every FoxyTail component is stopped, the routing/DNS chains are torn down, and `/data/adb/foxytail` is deleted — **but your Tailscale identity is not lost**. Before deletion, `tailscaled.state` is moved to `/data/adb/foxytail-state.backup`. On the next install, if no state exists yet, the installer restores that backup automatically (and prints a notice), so you come back as the same node, still logged in. Delete `/data/adb/foxytail-state.backup` manually if you want a fresh identity.

## Quick start

```sh
su -c 'tailscale login'            # prints a login URL; open it in a browser
su -c 'foxytail.service status'    # colored summary of the running daemon
```

Before the first reboot after flashing, the binaries are not on `PATH` yet — use `/dev/tailscale` and `/dev/foxytail.service` instead (the installer prints exactly this).

Useful extras:

```sh
su -c 'tailscale set --exit-node=<node>'   # route via an exit node
su -c 'foxytail.service mode tun'          # switch run mode + restart
```

## CLI reference

All entry points live in `/data/adb/foxytail/scripts/` and are symlinked into `system/bin` after reboot.

| Command | Subcommands | Purpose |
|---|---|---|
| `foxytail.service` | `start` `stop` `restart` `status [summary\|peer\|exit-node\|all]` `log [daemon\|service]` `mode [bridge\|tun\|proxy]` `help [all]` | tailscaled lifecycle, colored status, mode switching |
| `foxytail.tun` | `start` `stop` `restart` `status` | hev-socks5-tunnel → `tailscale0` interface (bridge mode); runs the `foxytail.tun.up` / `.tun.down` user hooks |
| `foxytail.route` | `apply` `teardown` `reload` `status` | idempotent policy-routing engine (`FOXY_*` chains, table 1052, fwmark `0x40000000/0x40000000`) |
| `foxytail.dns` | `start` `stop` `status` | MagicDNS local endpoint, transparent coexistence and legacy DNS control |
| `foxytail.stats` | `start` `stop` `status` `collect-once` `query [hourly <date>\|daily\|topn <n>]` | traffic collector (per-peer Rx/Tx, per-UID counters) |
| `foxytail.watchdog` | `start` `stop` `status` `check-once` | restart tailscaled on crash, rebind on default-route change (rate-limited) |
| `foxytail.context` | `start` `stop` `status` `check-once` | apply `context.conf` rules on SSID / cellular changes |
| `foxytail.compat` | `probe` `check` `check-dns-hijack` `suggest` | detect coexisting proxy/firewall/VPN tools; verify `FOXY_*` chains survive |
| `foxytail.diag` | `collect [output-dir]` | one-shot diagnostics tar.gz (default `/sdcard/Download`) |

Plus the stock `tailscale` CLI (`tailscale` is a symlink to `tailscaled`; for raw use pass the socket explicitly: `tailscale --socket=/data/adb/foxytail/run/tailscaled.sock …`).

## WebUI

The WebUI is built in: it lives in `webroot/` (zero-build static HTML/JS, backed by the `foxytail.webapi.sh` JSON API). How to use it:

- Open it from the **KernelSU manager** or **MMRL**. The **official Magisk app does not support module WebUIs** — that button will not exist there.
- 13 pages (bottom nav + "More" group): Dashboard · Peers (list + SVG topology) · Exit Nodes · Account · Tunnel · Routing · Traffic · Serve / Funnel · Files (Taildrop) · Logs · Settings · Diagnostics · More.
- Chinese/English, light/dark themes, official Material Symbols, loading placeholders and accessible native controls.

For Funnel, choose a supported public listener: HTTPS, TCP or TLS-terminated TCP on port 443, 8443 or 10000. A local HTTP service such as `http://localhost:3000` normally uses a public **HTTPS** listener; the target's protocol and port are independent of the public listener. Plain HTTP listeners remain available for private Serve mappings.

<!-- Screenshots: docs/screenshots/*.png (to be added, see Roadmap) -->

## WebUI development

The WebUI source lives in `webui/` (Vite + SolidJS, native controls with Material Design 3 tokens, and the `kernelsu` npm bridge). The built output is committed to `webroot/`, so the module stays self-contained and no Node toolchain is needed to use it.

- `pnpm --dir webui install --frozen-lockfile` — install dependencies (once)
- `pnpm --dir webui dev` — Vite dev server (no root bridge there; the UI shows the no-root banner)
- `pnpm --dir webui build` — production build into `../webroot/` (commit the result)
- `pnpm --dir webui typecheck` / `check:i18n` / `smoke` — TypeScript check, zh/en key parity, jsdom smoke (13 routes + task adoption + no-root banner)

Contract: `webui/src/api.ts` is the only consumer of `tailscale/scripts/foxytail.webapi.sh`; its JSON contract is frozen.

Runtime layout: `settings.sh` initializes shared helpers; `scripts/foxytail.config.sh` owns configuration defaults, validation and applied snapshots; `scripts/foxytail.lock.sh` owns process locks. `foxytail.webapi.sh` dispatches commands to four sibling modules for request handling, networking, configuration/backup and tools. These sourced files are shipped with the scripts directory.

## Verification and release

Use Node 22.14.0, pnpm 10.30.3 and Go 1.27.1; the WebUI requires Android WebView 109+. After installing dependencies, run `bash .github/tools/verify.sh` for ShellCheck, isolated backend regression tests, types, i18n, smoke, release metadata and committed build consistency. Run `pnpm --dir webui build` after frontend changes to update `webroot/`.

Run `.github/tools/version-bump.sh`, commit version files and build outputs, then tag that commit. A branch push runs Verify and the Linux kernel tests, then builds both ZIPs against the reviewed `tailscale/checksums.txt` and retains them for 30 days. Release reuses those artifacts only from a successful Verify run in this repository at the exact tagged commit; PR artifacts are excluded. If verification is running, Release waits; if no reusable artifact exists, it requests one Verify run at the existing tag. Concurrent requests for the same commit share its successful artifacts. Failed gates stop publication, and downloaded checksums and package versions must match before uploading. Manual Release follows the same path.

An explicit `bash .github/tools/build.sh --update-checksums` creates a candidate manifest for source verification and review; it does not package binaries.

Apply saved settings through the WebUI restart action or `/data/adb/foxytail/scripts/start.sh reload`, which refreshes resident helpers as well as the network service. `foxytail.service restart` affects the network service only. Upgrades preserve received files, supplied dnsmasq, configuration and identity, stop the old components before switching, and retain rollback journals on failure.

Settings also offers a **timed configuration trial** using saved settings with an optional mode override. After startup checks pass, confirm within 30–300 seconds or the previous runtime configuration is restored. The backend timer survives closing the WebUI and preserves settings saved afterward. These checks cover local components; test actual destinations before confirming. Backup restore now selects a file from Download, previews configuration changes and verifies the same archive contents before restoring. Hooks remain parked for review.

## Configuration

Three files in `/data/adb/foxytail/conf/`, installed **only if missing** — your edits survive module upgrades.

### `foxytail.conf` (main)

| Key | Default | Meaning |
|---|---|---|
| `TS_MODE` | `bridge` | `bridge` (userspace + socks5 + hev → tailscale0) · `tun` (native TUN, needs `/dev/net/tun`) · `proxy` (socks5 only) |
| `SOCKS_PORT` | `1099` | tailscaled's local socks5 port |
| `DNS_MODE` | `legacy` | `legacy`, `local`, or `transparent`; apply with restart |
| `DNS_PORT` | `1053` | Local DNS port; must be unused by other resolvers |
| `MAGIC_DNS` | `off` | Enable Tailnet name resolution in the selected mode |
| `IPV6` | `off` | dual-stack tailscale0 + ip6tables symmetry |
| `ROUTE_TABLE` | `1052` | dedicated policy routing table (1000–65535) |
| `FWMARK` / `FWMARK_MASK` | `0x40000000` | fixed shared mark bit; legacy 0xF7 migrates on read |
| `WATCHDOG` / `WATCHDOG_INTERVAL` | `on` / `30` | crash restart + rebind, seconds between checks |
| `WATCHDOG_RESTART_LIMIT` / `WATCHDOG_RESTART_WINDOW` | `5` / `600` | restarts allowed inside the window (seconds) before the watchdog cools down |
| `WATCHDOG_COOLDOWN` / `WATCHDOG_BACKEND_BAD_LIMIT` | `300` / `3` | cool-down seconds; consecutive unanswered daemon rounds that trigger a restart |
| `WATCHDOG_PROBE` | `on` | Active connectivity probes after network changes; paused by power saving |
| `POWER_SAVE` | `off` | Reduce optional background work and WebUI refresh frequency |
| `STATS` / `CONTEXT` | `on` / `on` | Independently control traffic sampling and context automation; retain history and rules |
| `WEBUI_AUTO_REFRESH` | `on` | Automatic page refresh; initial reads and manual refresh remain available when off |
| `STATS_INTERVAL` | `60` | stats collection interval (auto-throttled when the screen is off) |
| `STATS_RETENTION_DAYS` | `7` | days of traffic samples kept in the JSONL ring |
| `CONTEXT_INTERVAL` | `20` | context check interval (auto-throttled when the screen is off) |
| `LOG_MAX_KB` | `512` | log rotation threshold (one `.bak` kept) |

`CONTEXT_INTERVAL`, `STATS_RETENTION_DAYS` and the `WATCHDOG_*` recovery limits are advanced file-only knobs: edit `foxytail.conf` and restart. The WebUI settings API neither reports nor writes them.

### Power controls

Use **Settings → Power & background** to select power saving or individual feature switches, then **Restart & apply**. Upgrades keep existing features enabled by default; power saving never enables a disabled feature. Disabling the watchdog stops automatic recovery; disabling context automation stops SSID/mobile-data actions.

| Feature | Normal: screen on / off | Power saving: screen on / off |
|---|---|---|
| Watchdog | Configured interval for both (default 30 s) | At least 60 / 180 s |
| Traffic sampling | Configured interval / interval × 5 (default 60 / 300 s) | At least 300 / 900 s |
| Context checks | 20 / 100 s | 60 / 180 s |
| Log size checks | 30 s when quiet; 2 s near the limit while size changes | 60 s when quiet; 2 s near the limit while size changes |
| WebUI status, peers and tunnel | 15 s while visible and stable | 30 s while visible and stable |
| WebUI logs | 5 s while visible | 30 s while visible |

Longer custom intervals are preserved. Hidden WebUI pages stop polling. Startup status and active configuration trials retain timely updates. Disabling automatic refresh still permits manual actions and trial confirmation. Disabling sampling or context automation exits its resident process without deleting history or rules; manual `collect-once` remains available.

Power saving pauses active network-change pings, preserves the Tailscale connection and keeps independent DNS failure monitoring at 2 s. DNS health is queried in memory over loopback, eliminating idle state writes every 2 s. Battery savings depend on the device, traffic and network and require measurement on real hardware.

### `routes.conf` (routing scope)

| Key | Default | Meaning |
|---|---|---|
| `ROUTE_SCOPE` | `all` | `all` · `selected` (only `UID_LIST`) · `bypass` (everything except `UID_LIST`) |
| `UID_LIST` | empty | space-separated app UIDs for selected/bypass |
| `ROUTE_SUBNETS` | `100.64.0.0/10` | CIDRs routed through the tunnel |

The Routing page can accept subnet routes from other Tailscale nodes. The switch reads and changes the current Tailscale profile's `accept-routes` preference; it does not create a duplicate module setting. Route advertisements are grouped by node. **Add subnet** copies a CIDR into the local draft, and **Apply** saves that draft separately. Refreshing advertisements preserves unsaved CIDR and application selections.

The two controls have different scopes: accepting routes lets Tailscale use permitted peer routes, while the custom list selects destinations for FoxyTail's local policy routing. The list is not an acceptance whitelist and importing a subnet does not pin its next hop to that node. Node online status is not a reachability test; the advertising router, administrative route approval and Tailnet access policy still determine access.

Native TUN receives routes through tailscaled; adding a custom CIDR is useful when it must also follow FoxyTail's local routing priority. Bridge mode needs the target CIDR in the custom list and remains subject to the selected application scope. Proxy mode handles traffic sent through its SOCKS5 listener and does not install an Android system route. Exit-node default routes are managed on the Exit page.

Custom CIDRs are normalized to network addresses (`192.168.1.42/24` becomes `192.168.1.0/24`) and duplicates are removed. IPv6 CIDRs may be saved before enabling IPv6; the page explicitly reports that those destinations are not applied until IPv6 is enabled in Settings.

### `context.conf` (network-context rules)

One rule per line: `<trigger>:<value>:<action>[:<arg>]`

```
ssid:HomeWifi:down            # tunnel down on this Wi-Fi
ssid:Office:exit-node:myserver
cellular:-:no-exit-node       # clear exit node on mobile data
```

Actions: `up`, `down`, `exit-node <arg>`, `no-exit-node`.

Advanced Settings supports adding, editing and reordering rules visually, with a raw-text editor that preserves comments and unrecognized lines. Invalid rules are still rejected by the backend. The latest execution result reports the outcome of the full matching action group; saving rules alone does not confirm successful execution.

### User hooks

`/data/adb/foxytail/scripts/foxytail.tun.up` and `foxytail.tun.down` run after the `tailscale0` interface comes up/down (bridge mode). Add your own routes/firewall rules there. **The installer never overwrites your modifications** — if the shipped template changed, it is saved next to yours as `<hook>.new`.

## Run modes

| | `bridge` (default) | `tun` | `proxy` |
|---|---|---|---|
| How | userspace tailscaled + socks5 + hev-socks5-tunnel → `tailscale0` | tailscaled native TUN | socks5 only, no interface |
| Needs | nothing special | `/dev/net/tun` | nothing |
| Works without TUN support | ✅ | ❌ | ✅ |
| Per-App routing / stats | ✅ (UID 0 bypasses) | all only; peer/interface stats | ❌ (no interface) |
| Performance | userspace copy overhead | best | app-level only |

Switch with `foxytail.service mode <mode>` (writes `TS_MODE` and restarts). Switching to `tun` is refused when `/dev/net/tun` is missing.

## Routing engine

`foxytail.route` keeps **everything** off the beaten path so other modules stay intact:

- all rules live in dedicated chains: `FOXY_MARK` (mangle) and `FOXY_STAT` (filter, counters for stats); built-in chains get exactly one jump each
- policy routing uses dedicated table **1052** (1000–65535, no foreign resources) with fixed mark/mask **`0x40000000/0x40000000`**; other mark bits are preserved and whole tables are never flushed
- `check` verifies configuration, both families, OUTPUT jumps and route snapshots; `apply` repairs drift, and `teardown` removes exact policy rules and protocol-186 routes on tailscale0 only
- Legacy MagicDNS adds `FOXY_DNS` (nat) for the port-53 redirect, skipped when another module already hijacks port 53

## Coexistence guide

FoxyTail never touches other modules' chains and probes for neighbors at boot (`foxytail.compat probe` → `/data/adb/foxytail/run/compat.json`).

- **Clash / mihomo / box-for-magisk**: these usually hijack DNS (redirect or TPROXY UDP/53). Legacy DNS runs `foxytail.compat check-dns-hijack` before installing its redirect; on conflict the redirect is skipped (dnsmasq still runs on port 1053, state `degraded`). Coordinate the resolvers only when an active DNS redirect conflicts; installing a proxy app alone does not disable MagicDNS.
- **AFWall+**: firewall reloads may flush our jumps off the built-in chains. FoxyTail's rules are isolated in `FOXY_*` chains; run `foxytail.compat check` (or `foxytail.route apply`) to detect/restore tampering.
- **NetGuard / other VPN apps**: FoxyTail does **not** use Android's VpnService, so it occupies zero VPN slots — but a VpnService app with "always-on" can still capture traffic before it reaches our routes.

## MagicDNS

Enable MagicDNS, choose a mode and unused port in Settings, then apply the restart. Upgrades preserve `DNS_MODE=legacy` and the saved port. Both light and full packages include the first-party `foxydns` helper, built with Go 1.27.1.

| Mode | Behavior |
|---|---|
| `legacy` (default) | Existing dnsmasq behavior and DNS conflict checks. |
| `local` | Standard loopback UDP/TCP endpoint at `127.0.0.1:DNS_PORT`, plus `[::1]:DNS_PORT` with IPv6 enabled. Configure the active Tailnet suffix in any resolver that supports split DNS. |
| `transparent` | Intercept ordinary UDP/TCP port 53 only when kernel capabilities and the original routing context can be verified. Otherwise retain the local endpoint. Validate your actual device/VPN combination. |

The local endpoint answers current Tailnet full names, known short names, A/AAAA and PTR records. Unknown names under the Tailnet suffix return NXDOMAIN; public names return REFUSED. It is not a sole global resolver. Copy the actual endpoint and suffix from the Tunnel page; configure a search suffix or short-name policy in the consuming resolver when needed. A VPN without split-DNS controls cannot automatically use local mode.

Transparent mode captures the original destination, source address, UID, mark and interface, validates the effective kernel route, and forwards public queries through that original context. Missing metadata leaves the packet on its original path. Missing context after takeover returns failure; there is no public fallback DNS. IPv4 and IPv6 interception are reported separately. Lack of IPv6 NAT retains IPv6 routing, AAAA answers and the local IPv6 listener.

Both new modes temporarily disable the current Tailscale profile's `accept-dns` to remove the Android backend's global DNS redirect. A private persistent journal records the previous value before mutation. Stop and WebUI account transitions restore only the matching profile and node identity; uncertain restoration retains the journal and blocks the account change. External preference changes relinquish ownership instead of being overwritten repeatedly. Uninstall preserves unresolved records with the saved identity. Corporate split DNS, global upstreams and search domains from Tailscale are not automatically reproduced by these modes.

Transparent mode requires root, NFQUEUE, conntrack, INET_DIAG, strict route queries and socket-context capabilities. It does not intercept DoH/DoT or reproduce arbitrary SELinux/cgroup credentials. Socket UID recovery requires an exact, unambiguous INET_DIAG match; unsupported flows retain their existing path. Existing root DNS redirects or incompatible OUTPUT policies prevent transparent takeover; use the local endpoint instead. Mark bit `0x20000000` must be unused by other programs; detected collisions stop interception. Helper failure has a short cleanup window, and passing capability probes does not establish compatibility with every VPN. The detailed implementation and validation limits are documented in the [Chinese design report](docs/reviews/2026-09-09-generic-dns.zh-CN.md).

The Android 16 / FlClash test device passed local UDP/TCP and IPv6 DNS checks, but its kernel lacks `CONFIG_NETFILTER_NETLINK_GLUE_CT` and existing OEM mark rules also prevent transparent capture. NFQUEUE and standalone conntrack support alone are insufficient. This device uses local mode and still needs Tailnet split-DNS configuration in the consuming resolver; automatic transparent coexistence was not established. The full transparent path passed a separate strict Linux kernel test.

Legacy mode selects `/data/adb/foxytail/bin/dnsmasq`, `/system/bin/dnsmasq`, then `/vendor/bin/dnsmasq`; supply a trusted binary if none is available. Its previous public fallback behavior is unchanged.

## IPv6

`IPV6=on` gives `tailscale0` a dual-stack address (`fd7a:115c:a1e0::1` in bridge mode), adds symmetric ip6tables policy rules, and routes `fd7a:115c:a1e0::/48` (add it to `ROUTE_SUBNETS`). Default is off. Add an IPv6 CIDR before enabling it; route application fails explicitly when none is configured.

DNS startup first checks IPv6 NAT capability. If absent, it searches OS module trees for `ip6table_nat` and uses the system module loader with its declared dependencies and kernel ABI/signature checks. Module attempts have a six-second total budget, and success requires the NAT table to become usable. The Tunnel page reports the detected native, module, or fallback path; reading status does not load modules.

When the module is absent or cannot load, the fallback retains IPv6 tunnel routing, the `::1` DNS listener, and A/AAAA mappings for both short and full Tailnet names. IPv4 DNS interception continues; transparent interception of DNS sent over IPv6 is unavailable on that path. The user's IPv6 setting remains enabled.

## Traffic analytics & diagnostics

- `foxytail.stats` samples per-peer Rx/Tx and dual-stack TUN OUTPUT per-UID transmit counters every `STATS_INTERVAL` seconds into `/data/adb/foxytail/run/stats/YYYY-MM-DD.jsonl` (7-day ring by default via `STATS_RETENTION_DAYS`, screen-off throttling). Query with `foxytail.stats query hourly <date> | daily | topn <n>`.
- The Diagnostics page provides on-demand service, tunnel, route and DNS summaries with links to relevant tools. Device details can test IPv4/IPv6 separately and report actual ping latency and direct/relay paths.
- `foxytail.diag collect` bundles log tails, status, netcheck, routes and configuration into `/sdcard/Download/foxytail-diag-<timestamp>.tar.gz`. Sharing mode consistently aliases collected accounts, device names, SSIDs and addresses; review custom logs before sharing. `foxytail.diag collect /sdcard/Download local` retains details for private troubleshooting; the WebUI offers the same explicit choice.

## Limitations (honest list)

- **arm / arm64 only** — the installer aborts on other architectures.
- Default `bridge` mode is userspace networking: throughput is lower than kernel TUN (`tun` mode where available).
- QR-code login is not embedded in the WebUI — use the login URL printed by `tailscale login`.
- SSID detection parses `dumpsys wifi` output, whose format varies across Android versions (tolerant parsing, worst case "unknown").
- kernel routing requires `xt_owner` to exempt control processes and fails closed when unavailable. selected/bypass require bridge; UID 0 bypasses the bridge tunnel.
- Legacy DNS still needs a supplied resolver when system dnsmasq is unavailable; new modes include their resolver but transparent capture needs supported kernel and routing capabilities.

## Troubleshooting

1. `foxytail.service status` — daemon up? backend `Running`?
2. `foxytail.service log daemon` / `log service` — recent errors.
3. `foxytail.route status` — chains/table/rule in place? If another tool flushed them: `foxytail.route apply`.
4. `foxytail.compat check` + `foxytail.compat suggest` — coexistence conflicts.
5. `foxytail.diag collect` — generate the bundle and attach it to your report.

The watchdog restarts a crashed tailscaled automatically (rate-limited: 5 restarts / 10 min, then a 5-min cooldown).

## Roadmap

- Screenshots of the WebUI under `docs/screenshots/`, embedded in this README
- A trusted static `dnsmasq` source for Android, so MagicDNS works out of the box
- Real-device compatibility matrix (Android versions × kernels × coexisting proxy modules)

## Credits

- [anasfanani/Magisk-Tailscaled](https://github.com/anasfanani/Magisk-Tailscaled) — original idea and inspiration
- [Tailscale](https://tailscale.com) — the mesh VPN itself (Android CLI builds by [anasfanani/tailscale-android-cli](https://github.com/anasfanani/tailscale-android-cli))
- [heiher/hev-socks5-tunnel](https://github.com/heiher/hev-socks5-tunnel) — socks5 → TUN bridge
- [Magisk](https://github.com/topjohnwu/Magisk) and [KernelSU](https://kernelsu.org) — the module frameworks

## Disclaimer

This is an unofficial community module, not affiliated with Tailscale Inc. It modifies system network configuration; use at your own risk. Backup before upgrading.

## License

BSD 3-Clause — see [LICENSE](LICENSE). Upstream binaries keep their own licenses.
