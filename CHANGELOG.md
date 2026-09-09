# Changelog

## v1.3.0

- 新增不依赖特定 VPN 应用的 DNS 模式：内置 `foxydns` 本地端点，以及按内核能力启用的透明共存；升级保留旧模式与端口。
- 新模式支持当前 Tailnet 的完整名、短名、A/AAAA/PTR；透明模式的公网查询保留原 DNS 与 VPN 选路上下文，本地端点对公网名返回 REFUSED，无公共兜底 DNS。
- 原生 DNS 偏好修改增加账户身份校验、持久恢复日志和账户切换保护；透明故障由独立轻量守护撤规则。
- 设置页增加 DNS 模式选择，隧道页显示实际端点、IPv4/IPv6 拦截与可操作的故障状态。
- 固定 Go 1.27.1；arm/arm64 静态 helper 随 light/full 包内置并校验，新增并发、解析、生命周期与 UI 回归。
- 真实 Linux NFQUEUE/conntrack 门禁通过；Android 16 + FlClash 实测本地解析、IPv6、偏好恢复及服务开关。该测试机缺少 conntrack 队列元数据支持，透明模式安全降级，不声称免配置共存已实现。
- 明确报告缺少 `CONFIG_NETFILTER_NETLINK_GLUE_CT` 的能力错误；修复安装器误扫 OEM 非 PID 的 procfs 条目。不接管 DoH/DoT，不自动复制 Tailscale 公司分域 DNS 配置。


## v1.2.1 — 2026-09-09

- Keep the login card hidden while Tailscale reports startup `NoState` or awaits administrator approval (`NeedsMachineAuth`); only an explicit `NeedsLogin` prompts reauthentication.
- Hide stale login/start prompts when status reads fail, and recheck current state before submitting login actions.
- Preserve immediate login access for actual authentication failures without adding polling or a fixed restart delay.
- Fix configuration backups on Android toybox tar by staging the archive layout and using a single working directory; verify archive integrity and return the saved file path and size.
- Keep backups running across page navigation, show persistent errors with retry, retain the latest successful path, and reject incomplete success responses.

## v1.2.0 — 2026-09-09

- Add a Routing control for accepting subnet routes from other Tailscale nodes, backed by the current profile's actual preference and verified after changes.
- List node subnet announcements separately from local routing rules, with one-click CIDR import into the unsaved draft; refreshing announcements preserves local edits.
- Add individual custom IPv4/IPv6 CIDR editing, network-address normalization and deduplication; explicitly report IPv6 routes saved while IPv6 is disabled.
- Keep receive-route changes active across page navigation, distinguish unknown state and failures, and preserve native TUN and bridge routing constraints.
- Restyle the dashboard Tailnet status card after KernelSU's working-state card, with a full tonal surface, official outlined status icons and generous spacing.
- Separate Serve and Funnel protocol validation: Funnel uses supported HTTPS/TCP listeners and public ports, while local HTTP targets and private Serve HTTP listeners remain supported.

## v1.1.0 — 2026-09-09

- Redesign all 13 WebUI pages with a shared component system, neutral light/dark surfaces, semantic status cards, platform icons, skeletons and reduced-motion-aware feedback.
- Add responsive grouped desktop navigation, official Material Symbols icons, accessible controls and a global activity menu for ongoing tasks.
- Keep service, mode and restart controls in the fixed page header; remove duplicate mode and running-state indicators from the dashboard.
- Bound Android process-command reads to prevent stale procfs descriptors from holding service locks; verify actual daemon state after control failures and distinguish unavailable state from a stopped service.
- Detect native IPv6 DNS interception, try existing matching system modules within a bounded budget, and retain IPv6 connectivity and dual-stack DNS mappings when falling back; expose the detected path in Tunnel.
- Preserve full-name AAAA records, normalize Android route ownership output, and wait briefly for xtables write locks to avoid repeated service recovery.
- Make device search/filtering instant, require explicit exit selection application, and show responsive SVG traffic charts with keyboard controls and data tables.
- Group settings by purpose with a persistent pending-application card and lazy advanced reads; add log filtering, line numbers and pause controls.
- Improve account, tunnel/DNS, routing, service mapping, Taildrop and diagnostic workflows with useful loading, empty, error and completion states.
- Distinguish missing interface samples from recorded zero traffic; keep mutation results pending until a fresh status snapshot is available.
- Preserve asynchronous native spawn, first-paint scheduling, exact request cancellation and page teardown behavior from v1.0.5.
- Add isolated populated/empty/error/slow development previews and regression coverage for the redesigned workflows.

## v1.0.5 — 2026-09-09

- Use asynchronous KernelSU/MMRL spawn instead of the blocking exec bridge; defer root calls until after painting and discard reads from pages already left.
- Detach each WebAPI process from the manager app freezer before acquiring configuration locks, preventing frozen requests from blocking the module.
- Reduce shell/jq process launches, avoid redundant status/app queries, and precompute theme tokens to reduce startup JavaScript.
- Use system/vendor dnsmasq when available; resolve Tailnet short names with inline mappings compatible with Android privilege dropping.
- Coexist with the pinned native DNS redirect, route resolver upstream traffic correctly, and refresh negative DNS caches through verified Android resolver interfaces.
- Distinguish local DNS readiness from native Tailnet DNS, and only warn about proxy DNS conflicts when active interception is detected.
- Validate on a rooted Android 16 device with KernelSU 3.3.0, including WebView timing, background freezing and actual short-name resolution.

## v1.0.4 — 2026-09-09

- Treat runtime configuration as validated data with a fixed schema; serialize writes and make backup/restore transactional.
- Isolate policy routing with a masked mark, reserved-table protection, explicit resource ownership, complete drift detection and recoverable apply/cleanup.
- Restrict native TUN to `all`; per-app selected/bypass routing requires bridge mode, and root UID 0 bypasses the bridge tunnel. IPv6 requires explicitly configured IPv6 subnets.
- Stop and verify old components before an upgrade, preserve user files and supplied dnsmasq, and recover interrupted software switches from a rollback journal.
- Reconcile partial service failures and DNS readiness; preserve degraded status and rebuild the resolver after an account or Tailnet change.
- Apply saved settings through a full service/helper reload, keeping a newer concurrent configuration revision marked as pending.
- Correct UID traffic direction and dual-stack counters; aggregate adjacent deltas across counter resets and time-bucket boundaries.
- Replace global process-name cancellation with request IDs and verified child identities; wait for cancellation acknowledgement before replacing tasks.
- Fix first-load error recovery, SOCKS5 probes, account listing, and Serve/Funnel protocol, path and deletion handling in the WebUI.
- Bound runtime logs continuously while preserving open writer descriptors and retaining a capped backup.
- Add 46 isolated backend regressions and expanded WebUI smoke coverage, pin Node/pnpm and WebView targets, and verify committed production assets in CI.
- Build releases from existing version tags; verify reviewed upstream checksums and publish light/full packages with SHA256SUMS.

Android device routing, module-manager installation and coexistence tests remain pending; host regression checks do not replace device validation.

## v1.0.3

- Replace @material/web (Lit) with hand-built native components: no shadow-DOM overhead, lighter bundle
- Fix icon alignment and reduce layout jank across the WebUI
- Watchdog now respects manual stop: it no longer resurrects tailscaled after the user taps Stop
- Improve login error feedback when the daemon cannot reach the Tailscale control plane
- WebUI bundle: 190 KB JS / 14.6 KB CSS (was ~460 KB JS / ~8 KB CSS)

## v1.0.2

- Rebuild WebUI with SolidJS + Material Web (MD3 theme, fox-orange palette)
- Login hero on Dashboard (non-blocking, dismissible), global status indicator in top bar
- API timeouts everywhere; heavy operations are cancellable session tasks that survive page switches
- Instant page switching with skeletons; fast apps listing (single pm call)


## v1.0.1

- Fix KSU/MMRL WebUI exec bridge signature (string options + string callback name)
- Fix watchdog restart loop while backend state is NeedsLogin
- Fix compat probe false positives on sandbox/searchbox packages
- Fix WebUI tunnel gateway parsing
- Silence duplicate route apply on service start
- Tighten stats sample file permissions

## v1.0.0

- Initial release.
