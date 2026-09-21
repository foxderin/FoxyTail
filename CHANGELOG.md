# Changelog

## v1.3.4 — 2026-09-21

- 修复半满日志停止增长后仍每 2 秒扫描的问题；静止后恢复普通 30 秒、省电 60 秒周期，保留超限轮转。
- 新 DNS 服务的 UDP 空闲读超时由 5 秒延长至 1 小时，减少零请求时的周期性处理；保留 TCP 请求限时和及时关闭。
- WebUI 配置试用回滚失败后停止自动查询，保留错误提示与手动重试；重试执行期间恢复进度跟踪。
- 等待管理员审批时按普通 15 秒、省电 30 秒刷新；保留启动阶段快速刷新及隐藏页面暂停。
- 补充后台日志、DNS 响应与关闭、前端轮询回归，并更新内置 WebUI。实际续航收益仍需设备测量。

## v1.3.3 — 2026-09-19

- 设置新增节能模式，以及看门狗、网络切换主动探测、流量采集、场景自动化和 WebUI 自动刷新的独立开关；保存后重启应用生效，关闭采集或场景功能保留历史与规则。
- 节能模式按亮屏/熄屏降低后台检查频率，暂停网络切换主动探测；保留 Tailscale 主连接和独立 DNS 故障保护。
- DNS 健康监测改用现有本机监听器的内存响应，移除每 2 秒状态落盘、fsync 和守护脚本子进程；仍检测卡死、队列故障及实例更替，故障时撤除透明接管规则。
- 缓存已校验的运行配置，合并流量样本解析，按需读取 UID 计数；看门狗常规查询省略设备列表，避免重复写状态与日志，低流量日志降低轮转检查频率。
- WebUI 隐藏时停止刷新定时器，稳定状态降低刷新频率，空闲配置试用不再每秒唤醒；手动操作和活动试用确认仍可使用。

## v1.3.2 — 2026-09-19

- 设备详情新增按需 IPv4/IPv6 连通性测试，显示实际直连或中继路径；详情随设备列表刷新。
- 诊断页展示本机服务、隧道、路由和 DNS 检查摘要；导出默认统一匿名化账户、设备名、SSID 和地址，可显式选择本机详细包。
- 设置新增限时配置试用、确认与回退；后台计时独立于 WebUI，保留之后保存的设置。
- 场景规则支持可视编辑、排序和高级原文编辑，展示最近一次实际执行结果；备份恢复增加文件选择、差异预览及预览后内容校验。
- 发布复用同一提交通过源码和 Linux 内核检查后的安装包；缺少产物时请求一次验证构建，避免分支、标签和发布重复跑完整检查。

## v1.3.1 — 2026-09-19

- 修复设备页丢失 IPv6 地址：保留节点完整地址列表，列表、详情、拓扑提示、搜索和复制均支持 IPv6；保留旧版单地址字段兼容。
- 拆分 WebAPI、配置事务、共享锁、设置与路由页面、网络样式及测试，集中设置元数据、API 路径与超时；删除废弃 UI 兼容层、未用依赖和重复测试。
- 安装暂存阶段加载同批次共享库，内部库不再注册为系统命令；保留配置校验、安装回滚、身份与用户 hook。
- 固化已保存与已应用配置的隔离，损坏配置下仍可停止、查看日志和恢复；统一锁恢复与长任务取消，保留场景和隧道失败后的重试与清理。
- 更新内置 WebUI；上游二进制版本与已审核 SHA256 清单保持不变。

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
