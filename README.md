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
| Traffic analytics (`foxytail.stats`) | ✅ | JSONL ring buffer, 7-day retention, screen-off throttling |
| MagicDNS split-DNS (`foxytail.dns`) | ✅ | uses system dnsmasq or a supplied binary (see below) |
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
| `foxytail.dns` | `start` `stop` `status` | MagicDNS split resolver (dnsmasq on port 1053 + coexistence-aware port-53 redirect) |
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

## Verification and release

Use Node 22.14.0 and pnpm 10.30.3; the WebUI requires Android WebView 109+. After installing dependencies, run `bash .github/tools/verify.sh` for ShellCheck, isolated backend regression tests, types, i18n, smoke, release metadata and committed build consistency. Run `pnpm --dir webui build` after frontend changes to update `webroot/`.

Run `.github/tools/version-bump.sh`, commit version files and build outputs, then tag that commit. Release builds only existing tags and verifies the reviewed `tailscale/checksums.txt`. An explicit `bash .github/tools/build.sh --update-checksums` creates a candidate manifest for source verification and review; it does not package binaries.

Apply saved settings through the WebUI restart action or `/data/adb/foxytail/scripts/start.sh reload`, which refreshes resident helpers as well as the network service. `foxytail.service restart` affects the network service only. Upgrades preserve received files, supplied dnsmasq, configuration and identity, stop the old components before switching, and retain rollback journals on failure.

## Configuration

Three files in `/data/adb/foxytail/conf/`, installed **only if missing** — your edits survive module upgrades.

### `foxytail.conf` (main)

| Key | Default | Meaning |
|---|---|---|
| `TS_MODE` | `bridge` | `bridge` (userspace + socks5 + hev → tailscale0) · `tun` (native TUN, needs `/dev/net/tun`) · `proxy` (socks5 only) |
| `SOCKS_PORT` | `1099` | tailscaled's local socks5 port |
| `DNS_PORT` | `1053` | dnsmasq listen port (MagicDNS) |
| `MAGIC_DNS` | `off` | split-DNS for tailnet names via dnsmasq |
| `IPV6` | `off` | dual-stack tailscale0 + ip6tables symmetry |
| `ROUTE_TABLE` | `1052` | dedicated policy routing table (1000–65535) |
| `FWMARK` / `FWMARK_MASK` | `0x40000000` | fixed shared mark bit; legacy 0xF7 migrates on read |
| `WATCHDOG` / `WATCHDOG_INTERVAL` | `on` / `30` | crash restart + rebind, seconds between checks |
| `STATS_INTERVAL` | `60` | stats collection interval (auto-throttled when the screen is off) |
| `LOG_MAX_KB` | `512` | log rotation threshold (one `.bak` kept) |

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
- MagicDNS adds `FOXY_DNS` (nat) for the port-53 redirect, skipped when another module already hijacks port 53

## Coexistence guide

FoxyTail never touches other modules' chains and probes for neighbors at boot (`foxytail.compat probe` → `/data/adb/foxytail/run/compat.json`).

- **Clash / mihomo / box-for-magisk**: these usually hijack DNS (redirect or TPROXY UDP/53). `foxytail.dns` runs `foxytail.compat check-dns-hijack` before installing its redirect; on conflict the redirect is skipped (dnsmasq still runs on port 1053, state `degraded`). Coordinate the resolvers only when an active DNS redirect conflicts; installing a proxy app alone does not disable MagicDNS.
- **AFWall+**: firewall reloads may flush our jumps off the built-in chains. FoxyTail's rules are isolated in `FOXY_*` chains; run `foxytail.compat check` (or `foxytail.route apply`) to detect/restore tampering.
- **NetGuard / other VPN apps**: FoxyTail does **not** use Android's VpnService, so it occupies zero VPN slots — but a VpnService app with "always-on" can still capture traffic before it reaches our routes.

## MagicDNS

`MAGIC_DNS=on` starts a local dnsmasq that forwards tailnet names (`.<MagicDNSSuffix>`) to `100.100.100.100` and everything else to the system resolver, listening on port 1053 with a coexistence-aware port-53 redirect.

The resolver selects `/data/adb/foxytail/bin/dnsmasq`, `/system/bin/dnsmasq`, then `/vendor/bin/dnsmasq`. Devices with a compatible system binary need no download. Otherwise supply a trusted dnsmasq for your architecture (mode 0755). Set `MAGIC_DNS=on`, then apply through the WebUI restart action. Android Private DNS settings remain unchanged; strict DoT or app-level DoH may bypass local port-53 resolution.

The local resolver derives short and full Tailnet names, including IPv4 and IPv6 records, from the current peer table and embeds them in the main configuration, which system dnsmasq reads before dropping privileges. This also preserves AAAA answers on native DNS implementations that only return IPv4 records for full Tailnet names. The watchdog reconciles changes to names, IPs and accounts. The Tunnel page DNS check distinguishes the local resolver, its enable switch and binary source, and upstream native DNS rules.

## IPv6

`IPV6=on` gives `tailscale0` a dual-stack address (`fd7a:115c:a1e0::1` in bridge mode), adds symmetric ip6tables policy rules, and routes `fd7a:115c:a1e0::/48` (add it to `ROUTE_SUBNETS`). Default is off. Add an IPv6 CIDR before enabling it; route application fails explicitly when none is configured.

DNS startup first checks IPv6 NAT capability. If absent, it searches OS module trees for `ip6table_nat` and uses the system module loader with its declared dependencies and kernel ABI/signature checks. Module attempts have a six-second total budget, and success requires the NAT table to become usable. The Tunnel page reports the detected native, module, or fallback path; reading status does not load modules.

When the module is absent or cannot load, the fallback retains IPv6 tunnel routing, the `::1` DNS listener, and A/AAAA mappings for both short and full Tailnet names. IPv4 DNS interception continues; transparent interception of DNS sent over IPv6 is unavailable on that path. The user's IPv6 setting remains enabled.

## Traffic analytics & diagnostics

- `foxytail.stats` samples per-peer Rx/Tx and dual-stack TUN OUTPUT per-UID transmit counters every `STATS_INTERVAL` seconds into `/data/adb/foxytail/run/stats/YYYY-MM-DD.jsonl` (7-day ring, screen-off throttling). Query with `foxytail.stats query hourly <date> | daily | topn <n>`.
- `foxytail.diag collect` bundles log tails, `tailscale status --json`, `netcheck`, iptables self-check and config into `/sdcard/Download/foxytail-diag-<timestamp>.tar.gz` — attach this when asking for help.

## Limitations (honest list)

- **arm / arm64 only** — the installer aborts on other architectures.
- Default `bridge` mode is userspace networking: throughput is lower than kernel TUN (`tun` mode where available).
- QR-code login is not embedded in the WebUI — use the login URL printed by `tailscale login`.
- SSID detection parses `dumpsys wifi` output, whose format varies across Android versions (tolerant parsing, worst case "unknown").
- kernel routing requires `xt_owner` to exempt control processes and fails closed when unavailable. selected/bypass require bridge; UID 0 bypasses the bridge tunnel.
- Devices without a compatible system dnsmasq still need a supplied resolver (above).

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
