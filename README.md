# FoxyTail

**Tailscale mesh VPN on Android as a Magisk/KernelSU module** — native `tailscaled`, three run modes, policy routing, traffic analytics, MagicDNS split DNS, a proxy coexistence wizard, watchdog and network-context rules, with a WebUI control plane and native Android Taildrop companion.

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
| Taildrop batch transfers and persistent history | Implemented | File browsing, actual byte progress, cancellation and unsuccessful-only retries |
| Android companion `dev.foxderin.tail` | Implemented | Android 8.0+; system sharing, SAF, Inbox/Send/History |
| Light / full release zips, `update.json` OTA | ✅ | |

## Installation

Two packages are published on the [Releases](../../releases) page:

- **`FoxyTail-<version>.zip` (light)** — the installer downloads `tailscaled`, `jq` and `hev-socks5-tunnel` at install time from their pinned upstream releases and verifies each against `checksums.txt` (SHA256). Requires internet during install.
- **`FoxyTail-<version>-full.zip` (full)** — all binaries bundled; installs offline. The bundled binaries are SHA256-verified too, so a tampered zip is rejected.

Flash either zip in Magisk Manager, KernelSU Manager or MMRL, then reboot (or use the absolute-path commands printed by the installer before rebooting).

Requirements: arm or arm64 device, Magisk v20.4+ or KernelSU ≥ 10670. Upgrades preserve your state, config and hook files (see below).

Both packages include the first-party `foxydns` and `foxyfiles` helpers for ARM/ARM64, verified against the bundled native manifest. Module-root recovery runs before replaceable settings/scripts at boot; interrupted upgrades restore only a transaction with matching backup ownership. Unproven or failed recovery retains its journal and backup and defers startup.

Both packages contain `companion/FoxyTail.apk`. On Android 8.0+, boot installs/updates the signed `dev.foxderin.tail` through PackageManager, preserving same-signature app data. It is no longer a `system/app` overlay: KernelSU's default module unmount otherwise hides the APK from launchers and the app itself. Installation errors go to `/data/adb/foxytail/run/companion-install.log` without blocking networking or uninstalling existing apps. **Grant root to FoxyTail itself** in Magisk/KernelSU; ADB root authorization is separate. The app never changes root grants or global hiding settings.

The v1.4.0 failure was traced on an Android 16/OPlus + ReSukiSU device to ENOENT for the systemless APK in launcher/app mount namespaces; correct permissions in ADB's namespace did not establish app access. The corrected installer updated the same-signature package via `pm install -r` on that device without stopping networking or changing global module-unmount policy.

**Upgrading to v1.4.1**: flash over v1.3.x/v1.4.0 and reboot, preserving Tailscale identity/configuration. The v1.4.0 systemless APK is removed in favor of a PackageManager-owned same-signature copy; an existing signed user app updates in place. A differently signed debug app must be removed by its user, never silently uninstalled to bypass signature checks. Login, routing and DNS remain in the WebUI.

## Uninstall & reinstall

Removing the module from Magisk/KernelSU runs `uninstall.sh`: every FoxyTail component is stopped, the routing/DNS chains are torn down, and `/data/adb/foxytail` is deleted — **but your Tailscale identity is not lost**. Before deletion, `tailscaled.state` is moved to `/data/adb/foxytail-state.backup`. On the next install, if no state exists yet, the installer restores that backup automatically (and prints a notice), so you come back as the same node, still logged in. Delete `/data/adb/foxytail-state.backup` manually if you want a fresh identity.

The normally installed companion is not automatically uninstalled with the module, preserving its app data. It reports an unavailable module afterwards and may be removed separately in Android Settings.

## Quick start

```sh
su -c 'tailscale login'            # prints a login URL; open it in a browser
su -c 'foxytail.service status'    # colored summary of the running daemon
```

Before the first reboot after flashing, the commands are not on `PATH` yet. Use the installed paths and the module's private socket:

```sh
su -c '/data/adb/foxytail/bin/tailscale --socket=/data/adb/foxytail/run/tailscaled.sock login'
su -c '/data/adb/foxytail/scripts/foxytail.service status'
```

The installer no longer creates command shortcuts under `/dev`. Successful upgrades and uninstalls remove old shortcuts only when they are symlinks to the exact FoxyTail targets; unrelated entries are left untouched. After reboot, the systemless `system/bin` commands remain available as before.

Useful extras:

```sh
su -c 'foxytail.exitnode set <node-id-or-ip>' # select an exit and reconcile local capture
su -c 'foxytail.service mode tun'          # switch run mode + restart
```

## CLI reference

All entry points live in `/data/adb/foxytail/scripts/` and are symlinked into `system/bin` after reboot.

| Command | Subcommands | Purpose |
|---|---|---|
| `foxytail.service` | `start` `stop` `restart` `status [summary\|peer\|exit-node\|all]` `log [daemon\|service]` `mode [bridge\|tun\|proxy]` `help [all]` | tailscaled lifecycle, colored status, mode switching |
| `foxytail.tun` | `start` `stop` `restart` `status` | hev-socks5-tunnel → `tailscale0` interface (bridge mode); runs the `foxytail.tun.up` / `.tun.down` user hooks |
| `foxytail.route` | `apply` `teardown` `reload` `status` | idempotent policy-routing engine (`FOXY_*` chains, table 1052, fwmark `0x40000000/0x40000000`) |
| `foxytail.exitnode` | `set <node-id-or-ip>` `clear` `status` | coordinate profile exit preferences with actual mode/scope routing |
| `foxytail.dns` | `start` `stop` `status` | MagicDNS local endpoint, transparent coexistence and legacy DNS control |
| `foxytail.stats` | `start` `stop` `status` `collect-once` `query [summary [date]\|hourly <date>\|daily\|topn <n>\|uids <n>]` | traffic collector and chronological streaming aggregation |
| `foxytail.watchdog` | `start` `stop` `status` `check-once` | restart tailscaled on crash, rebind on Android default-network changes (rate-limited) |
| `foxytail.context` | `start` `stop` `status` `check-once` | apply `context.conf` rules on SSID / cellular changes |
| `foxytail.compat` | `probe` `check` `check-dns-hijack` `suggest` | detect coexisting proxy/firewall/VPN tools; verify `FOXY_*` chains survive |
| `foxytail.diag` | `collect [output-dir]` | one-shot diagnostics tar.gz (default `/sdcard/Download`) |

Plus the stock `tailscale` CLI (`tailscale` is a symlink to `tailscaled`; for raw use pass the socket explicitly: `tailscale --socket=/data/adb/foxytail/run/tailscaled.sock …`).

## WebUI

The WebUI is built in: it lives in `webroot/` (zero-build static HTML/JS, backed by the `foxytail.webapi.sh` JSON API). How to use it:

- Open it from the **KernelSU manager** or **MMRL**. The **official Magisk app does not support module WebUIs** — that button will not exist there.
- 13 pages (bottom nav + "More" group): Dashboard · Peers (list + SVG topology with direct/relay paths) · Exit Nodes · Account · Tunnel · Routing · Traffic · Serve / Funnel · Files (Taildrop) · Logs · Settings · Diagnostics · More.
- Chinese/English, light/dark themes, official Material Symbols, loading placeholders and accessible native controls.

For Funnel, choose a supported public listener: HTTPS, TCP or TLS-terminated TCP on port 443, 8443 or 10000. A local HTTP service such as `http://localhost:3000` normally uses a public **HTTPS** listener; the target's protocol and port are independent of the public listener. Plain HTTP listeners remain available for private Serve mappings.

The pinned Android CLI receives directly into `/sdcard/Download/Taildrop`. **Import received files** copies completed regular files into the private inbox without waiting for buffered `tailscale file get`; shared originals remain, private receipts deduplicate, partial/deleted files and symlinks are excluded. If early-boot storage left the mode record missing, a strict LocalAPI response from the current daemon can confirm direct mode and restore the record only while PID/start-time/boot identity remain unchanged. Directory existence alone is insufficient. Unlock and restart FoxyTail if the daemon cannot confirm direct mode. Sends bind the stable peer ID to its current IP, including IPv6.

Automatic and manual exports preserve existing Download files, try numbered names through `-99`, and fail without removing the inbox copy when no safe destination is available. Clearing the inbox includes hidden regular files but preserves private receipts and directories. Inline downloads support files up to and including 8 MiB; larger files must be exported. Encoding uses a private temporary file, not command-line payload arguments.

### Everyday Taildrop and Android companion

- **WebUI**: browse `/sdcard` directories and select up to 32 files, each at most 2 GiB, for a currently send-capable Taildrop peer. Directory listings stop at 1000 entries with an explicit truncation notice; no manual source-path entry is needed.
- **Android**: native Inbox, Send and History pages. Use the multi-file system document picker or a file manager's **Share → FoxyTail** entry. Single/multiple shares only populate the selection; reading and sending begin after explicit device/file confirmation.
- **Receiving**: tailscaled still receives directly into `Download/Taildrop`. Import completed files into the private inbox, then open, share or save a copy using a system destination picker. Import does not wait for new files or delete shared originals. Android binary streaming avoids the WebUI's 8 MiB inline-download limit; its per-file limit is 2 GiB.
- **Progress/history**: one module-owned batch at a time, sent sequentially. Actual `OutgoingFiles.Sent` events are matched to exact transfer/file IDs and peer identity. Missing events remain unknown; local URI staging is not network progress. Only a successful upload HTTP response marks completion. Per-file failures retain their errors and can be retried without resending completed files.
- **Background/cancel**: accepted jobs survive page/app closure and are adopted from History. The app runs a foreground notification only while working; denying notifications still allows in-app progress/cancel. Cancellation waits for worker acknowledgement and cannot revoke bytes already accepted remotely. Service stop/upgrade waits for transfer ownership to release.
- **Data boundary**: the app reads granted `content://` URIs with its own `ContentResolver` and streams bytes into private staging through `su` stdin. No large command-line payloads, root reads of arbitrary external Intent paths, or root HTTP server. Export URIs expire after 24 hours. Successful stages are removed immediately; unused/failed stages older than 24 hours are cleaned on the next Taildrop operation, excluding active jobs. At most 100 history records and 256 staged items are retained. Original files are never removed.

Login, routing and DNS remain in the WebUI. The app distinguishes root launch failure, insufficient grant, unreadable module and actual backend failure; failed target reads are not presented as a successfully empty device list.

### Android builds and signing

`android/` uses JDK 21, Gradle 9.7.1 (checksum-pinned wrapper), AGP 9.3.2, SDK `platforms;android-37.0` and `build-tools;36.0.0`, minimum API 26 and target API 36. Versions come directly from `module.prop`.

With `JAVA_HOME` and `ANDROID_HOME` set, run `bash .github/tools/build-android.sh debug dist/FoxyTail-debug.apk`. For `release`, supply `FOXYTAIL_KEYSTORE_PATH`, `FOXYTAIL_KEYSTORE_PASSWORD`, `FOXYTAIL_KEY_ALIAS` and `FOXYTAIL_KEY_PASSWORD`. Missing credentials fail rather than generating a replacement signing identity. Never commit private keys; keep an offline backup because losing the key prevents in-place updates. Only trusted CI packaging reads signing secrets; PRs build debug APKs.

Instrumentation: `android/gradlew -p android :app:assembleDebugAndroidTest`, install both debug APKs, then run `adb -s <device> shell am instrument -w dev.foxderin.tail.test/dev.foxderin.tail.BridgeInstrumentation`. Exercised runtime validation used a disposable Android 15 emulator, actual Magisk su and two pinned tailscaled nodes: binary/empty batches, system multi-share, SAF, inbox import/save, rotation, job adoption, real byte events and cancellation. OEM-device/KernelSU authorization and background restrictions are not established by this emulator result.

<!-- Screenshots: docs/screenshots/*.png (to be added, see Roadmap) -->

## WebUI development

The WebUI source lives in `webui/` (Vite + SolidJS, native controls with Material Design 3 tokens, and the `kernelsu` npm bridge). The built output is committed to `webroot/`, so the module stays self-contained and no Node toolchain is needed to use it.

- `pnpm --dir webui install --frozen-lockfile` — install dependencies (once)
- `pnpm --dir webui dev` — Vite dev server (no root bridge there; the UI shows the no-root banner)
- `pnpm --dir webui build` — production build into `../webroot/` (commit the result)
- `pnpm --dir webui typecheck` / `check:i18n` / `smoke` — TypeScript check, zh/en key parity, jsdom smoke (13 routes + task adoption + no-root banner)

Contract: frontend and backend JSON schemas ship together. Restore requires the selected archive SHA256 and saved-configuration baseline SHA256; stale previews must be repeated. Trial status reports monotonic remaining seconds, and exit status separates selected preference from effective routing.

Runtime layout: `settings.sh` initializes shared helpers; `scripts/foxytail.config.sh` owns configuration validation/applied snapshots and `scripts/foxytail.lock.sh` owns process locks. `foxytail.webapi.sh` dispatches to sibling libraries for operations, accounts, networking, configuration, backup, coexistence and Taildrop. Android and WebUI share those module APIs.

## Verification and release

Use Node 22.14.0, pnpm 10.30.3, Go 1.27.1 and the Android toolchain above; the WebUI requires Android WebView 109+. After installing dependencies, run `bash .github/tools/verify.sh` for ShellCheck, isolated backend regressions, Android debug build/lint, types, i18n, smoke, release metadata and committed build consistency. Run `pnpm --dir webui build` after frontend changes to update `webroot/`.

CI runs isolated Python test modules with at most four workers, preserving all tests and failure statuses; Android debug assembly and lint share one Gradle invocation. Go/Gradle dependency caches exclude signing keys and release outputs. Non-PR CI builds/checks ARM/ARM64 static ELFs once in packaging; PR and local verification retain cross-compilation. Native race checks and the isolated Linux kernel gate remain required.

Run `.github/tools/version-bump.sh`, commit version files and build outputs, then tag that commit. A branch push runs Verify and the Linux kernel tests, then builds both ZIPs against the reviewed `tailscale/checksums.txt` and retains them for 30 days. Release reuses those artifacts only from a successful Verify run in this repository at the exact tagged commit; PR artifacts are excluded. If verification is running, Release waits; if no reusable artifact exists, it requests one Verify run at the existing tag. Concurrent requests for the same commit share its successful artifacts. Failed gates stop publication, and downloaded checksums and package versions must match before uploading. Manual Release follows the same path.

An explicit `bash .github/tools/build.sh --update-checksums` creates a candidate manifest for source verification and review; it does not package binaries.

Apply saved settings through the WebUI restart action or `/data/adb/foxytail/scripts/start.sh reload`, which refreshes resident helpers as well as the network service. `foxytail.service restart` affects the network service only. Upgrades preserve received files, supplied dnsmasq, configuration and identity, stop the old components before switching, and retain rollback journals on failure.

Startup requires an owned daemon and answering LocalAPI; a leftover socket is insufficient, while `NeedsLogin` is a valid ready state. Resident records and controller locks validate PID, process start time, boot identity and exact command arguments. User Stop and context-down holds are separate: context-up cannot undo a user Stop, and internal restarts do not create one. Restored identity and DNS ownership files are staged privately and published only after complete copies.

**Timed configuration trials** use saved settings with an optional mode override. Confirm within 30–300 monotonic seconds after startup checks or restore the accepted runtime baseline. Reboot expires unconfirmed trials; subsequent boots do not reapply the rejected saved candidate. Owned exit-preference side effects are restored only for the original profile and unchanged expected preference; newer manual choices win. These are local readiness checks, not an end-to-end connectivity guarantee.

Backup restore previews both archive contents and the current saved configuration. The native reader allows only three configuration files and two review-only hooks, with limits of 1 MiB compressed, 2 MiB expanded, 512 KiB per member and 16 physical headers; links, metadata extensions and trailing archives are rejected. Staging is supervised and cancellable. An atomic phase gate rejects cancellation once commit begins; restore and settings/service tasks survive page navigation, retain real late results after cancellation failure and allow cancellation retry without duplicate mutations.

Configuration restore journals directory replacement before changing live files. After an interrupted process, the next configuration-lock acquisition restores the prior set if uncommitted, or keeps the complete candidate if committed. Recovery errors block configuration access for retry instead of treating missing configuration as defaults; already-applied runtime snapshots remain separate.

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
| `ROUTE_TABLE` | `1052` | fixed dedicated policy routing table; foreign resources block application |
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

Bridge public defaults require a matching selected and actual exit identity and remain limited to `all`/`selected`/`bypass` scope. UID 0 and Tailscale-marked traffic stay exempt; IPv6-off leaves IPv6 uncovered. Proxy mode covers explicit proxy clients only; native TUN is daemon-owned and not claimed as independently verified. The Exit page reports failed/unknown policy separately from a saved selection. Use the coordinated exit helper rather than raw `tailscale set` when immediate bridge reconciliation is required.

Custom CIDRs are normalized to network addresses (`192.168.1.42/24` becomes `192.168.1.0/24`) and duplicates are removed. IPv6 CIDRs may be saved before enabling IPv6; the page explicitly reports that those destinations are not applied until IPv6 is enabled in Settings.

### `context.conf` (network-context rules)

One rule per line: `<trigger>:<value>:<action>[:<arg>]`

```
ssid:HomeWifi:down            # tunnel down on this Wi-Fi
ssid:Office:exit-node:myserver
cellular:-:no-exit-node       # clear exit node on mobile data
```

Actions: `up`, `down`, `exit-node <arg>`, `no-exit-node`.

ConnectivityService's active default network and its LinkProperties supply network identity, transport, interface and DNS. Main-table default routes are not authoritative on Android. Unknown, VPN and Ethernet snapshots never masquerade as cellular; context and watchdog observe the same snapshot.

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
- policy routing uses fixed dedicated table **1052** with mark/mask **`0x40000000/0x40000000`**; foreign resources block application, other mark bits are preserved and whole tables are never flushed
- `check` verifies configuration, both families, OUTPUT jumps and route snapshots; `apply` repairs drift, and `teardown` removes exact policy rules and protocol-186 routes on tailscale0 only
- Legacy MagicDNS adds `FOXY_DNS` (nat) for the port-53 redirect, skipped when another module already hijacks port 53

## Coexistence guide

FoxyTail never touches other modules' chains and probes for neighbors at boot (`foxytail.compat probe` → `/data/adb/foxytail/run/compat.json`).

- **Clash / mihomo / box-for-magisk**: these usually hijack DNS (redirect or TPROXY UDP/53). Legacy DNS runs `foxytail.compat check-dns-hijack` before installing its redirect; on conflict the redirect is skipped (dnsmasq still runs on port 1053, state `degraded`). Coordinate the resolvers only when an active DNS redirect conflicts; installing a proxy app alone does not disable MagicDNS.
- **AFWall+**: firewall reloads may flush our jumps off the built-in chains. FoxyTail's rules are isolated in `FOXY_*` chains; run `foxytail.compat check` (or `foxytail.route apply`) to detect/restore tampering.
- **NetGuard / other VPN apps**: FoxyTail does **not** use Android's VpnService, so it occupies zero VPN slots — but a VpnService app with "always-on" can still capture traffic before it reaches our routes.

### WebUI proxy coexistence wizard

Open **Tunnel → Proxy coexistence wizard → Detect environment**. It reads applied settings, the current Tailnet and actual DNS state without changing FoxyTail or another module. A ready FoxyTail-owned `local` / `transparent` DNS listener is required. Disabled, legacy or repair-pending DNS shows prerequisites and a Settings link rather than an unusable snippet. Installed modules/apps do not prove a proxy is running.

1. Confirm the destination is **mihomo / Clash.Meta** with the required fields, and select its existing fake-IP blacklist, rule mode or `redir-host`. Whitelist semantics require reviewing the existing list; the wizard does not silently convert it.
2. Preview, copy and **merge** into existing `dns.nameserver-policy`, `proxies`, `rules` and applicable `fake-ip-filter` entries. Preserve other entries; prepend routing and rule-mode filter entries before catchalls. Do not replace the complete configuration or use the local endpoint as global DNS.
3. Only the current full Tailnet suffix and exact self/peer `/32` and `/128` addresses are included, never the whole CGNAT range or every `ts.net` name. Short names, company DNS, subnet and exit routes are not imported. Regenerate after address changes. The `FoxyTail-Tailnet` outbound name must be unique.
4. `bridge` / `proxy` uses the actual local SOCKS5 port. `tun` uses a direct outbound bound to `tailscale0`, requiring core support and interface permission. Global IPv6 settings remain unchanged; check AAAA support separately.
5. Select a current peer/address and supply its actual TCP service port. Optionally specify a different proxy DNS listener port on `127.0.0.1`. Verification independently reports exact-address UDP/TCP queries to FoxyTail DNS and optional proxy DNS, plus a numeric-address TCP connection. An omitted resolver is explicitly skipped. Account, address or applied-endpoint changes require detection again.

Probes run as root. TCP uses local tailscaled SOCKS5 in bridge/proxy or system routing in tun, without application payload. Results **do not prove** a third-party app path, proxy interface binding, UDP traffic, application health or that the snippet was merged. Service status and individual probes are not interchangeable evidence.

Field semantics follow [mihomo DNS](https://wiki.metacubex.one/en/config/dns/) and [DIRECT outbound](https://wiki.metacubex.one/en/config/proxies/direct/). Nine mode combinations were parsed by mihomo 1.19.32; isolated runtime checks exercised real split DNS and HTTP over SOCKS. Android device checks exercised an isolated local resolver and successful/refused TCP through the existing tailscaled SOCKS, without changing the existing proxy configuration or establishing third-party app routing.


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

Legacy mode selects `/data/adb/foxytail/bin/dnsmasq`, `/system/bin/dnsmasq`, then `/vendor/bin/dnsmasq`; supply a trusted binary if none is available. Public upstreams come only from the current Android default-network snapshot and are refreshed on change. Unknown upstreams disable interception and report degradation instead of using a hard-coded public fallback.

Legacy aliases use exact hosts records, so a peer named `dev` does not intercept unrelated `*.dev` names. To support system dnsmasq 2.51 after its privilege drop, only the peer-name/address mappings are stored at `/dev/foxytail-dns/hosts`: a root-owned `0755` directory and world-readable `0644` file. No `/data/adb` permissions are widened. Successful cleanup removes the mappings and the directory when empty. If either family's redirect removal fails, the listener and mappings remain available in degraded state until cleanup can be retried.

Removing redirect rules does not retire existing DNAT connections. Transparent capture journals exact flows before issuing its marked verdict, quiesces the queue, then deletes only matching original/reply tuples and conntrack IDs in zone zero. Legacy capture reserves a separate connmark bit `0x20000000` after checking foreign masks and existing use; cleanup requires its boot/port claim and exact redirected DNS tuple. Neither path flushes the connection table. Failed cleanup retains ownership and the old listener for retry; pre-upgrade unmarked flows remain `reconnect-needed` until they expire or clients reconnect. Queue failure remains repair-needed after rules are gone. DNS conflict scanning treats all-port, ranges, negations, multiport, ambiguous matches and failed inventories conservatively.

Current isolated Android validation covers real journaled/connmark cleanup, same-source UDP reuse across port changes and stop, stale-ID rejection, unrelated-flow preservation and unmarked-flow retention. This emulator lacks `CONFIG_NETFILTER_NETLINK_GLUE_CT`, so the updated full NFQUEUE forwarding path still requires the separate Linux kernel gate; capability rejection is not counted as successful transparent forwarding.

## IPv6

`IPV6=on` gives `tailscale0` a dual-stack address (`fd7a:115c:a1e0::1` in bridge mode), adds symmetric ip6tables policy rules, and routes `fd7a:115c:a1e0::/48` (add it to `ROUTE_SUBNETS`). Default is off. Add an IPv6 CIDR before enabling it; route application fails explicitly when none is configured.

DNS startup first checks IPv6 NAT capability. If absent, it searches OS module trees for `ip6table_nat` and uses the system module loader with its declared dependencies and kernel ABI/signature checks. Module attempts have a six-second total budget, and success requires the NAT table to become usable. The Tunnel page reports the detected native, module, or fallback path; reading status does not load modules.

When the module is absent or cannot load, the fallback retains IPv6 tunnel routing, the `::1` DNS listener, and A/AAAA mappings for both short and full Tailnet names. IPv4 DNS interception continues; transparent interception of DNS sent over IPv6 is unavailable on that path. The user's IPv6 setting remains enabled.

## Traffic analytics & diagnostics

- `foxytail.stats` samples per-peer Rx/Tx and dual-stack TUN OUTPUT per-UID transmit counters every `STATS_INTERVAL` seconds into `/data/adb/foxytail/run/stats/YYYY-MM-DD.jsonl` (7-day ring by default via `STATS_RETENTION_DAYS`, screen-off throttling). Query with `foxytail.stats query hourly <date> | daily | topn <n>`.
- Each Traffic refresh obtains one summary for charts, peer totals and UID totals. A private 1 MiB-chunk stable external sort preserves timestamp order across clock changes; streaming reduction retains only last counters and aggregate buckets. Oversized rows fail explicitly at 512 KiB, and supervised timeout/cancellation covers descendant processes.
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
