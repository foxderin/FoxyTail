# Changelog

## Unreleased

- 修复 Taildrop 接收时重复导出旧文件及覆盖 Download 内容：只统计新增文件，自动/手动导出共用排他创建，保留带空格等特殊字符的文件名，编号耗尽时安全失败；清空收件箱包含隐藏文件。
- 下载通过私有临时文件与 `jq --rawfile` 传递 base64，避免 Android 单参数长度限制及外部 `printf` 导致的空响应；保留 8 MiB 上限、明确的读取错误和退出清理。
- legacy DNS 撤规则失败时保留解析器，成功重试后才停止；短名和完整名改用精确 hosts 记录，不再接管同后缀公网域名。兼容系统 dnsmasq 2.51，映射位于 `/dev/foxytail-dns/hosts`，不放宽 `/data/adb` 权限。
- 服务启动验证所属 daemon 和 LocalAPI 就绪，残留 socket 不再误报成功；内部重启停止不写用户停止标记，失败后看门狗仍可恢复，显式停止保持优先。
- 启动就绪探测沿用可选 `timeout` 策略：命令缺失时通过现有 `tmo` 记录警告并直接查询 LocalAPI，不再将正常响应的 daemon 误判为启动失败；缺失时单次查询不设时限。
- 配置恢复在目录切换前发布持久事务记录，后续配置读写先恢复中断事务；未提交恢复回滚旧配置，已提交恢复保留候选与原备份，不再静默应用默认值。
- 安装先准备回滚目录再原子发布日志，兼容清理旧版切换前中断；身份与 DNS 偏好恢复使用私有暂存和原子发布，失败或中断后可重试，不把截断文件当成有效身份。
- 移除安装器的 `/dev/tailscale`、`/dev/tailscaled`、`/dev/foxytail.service` 命令快捷方式，首次重启前改用绝对路径并显式指定模块 socket；成功升级和卸载仅清理精确匹配目标的旧自有软链接（含悬挂链接），保留其他同名条目。升级清理失败会警告并继续，卸载清理失败保留运行目录供重试；重启后的 systemless 命令入口不变。
- 出口选择改用稳定节点 ID，协调 profile 偏好与 bridge 公网默认目标；UI 分开显示选中与实际生效，明确 UID/root/IPv6、proxy 和原生 TUN 边界，路由失败可重试且不误报保护。
- 模块根目录在加载运行文件前恢复中断升级，校验事务/备份所有权；试用使用 boot ID 与单调计时，回滚后跨重启保留已接受基线，并比较恢复自有出口偏好副作用。
- 区分用户停止、场景停止和内部关闭；场景 up 不清除用户停止。驻留进程与锁统一验证 PID、启动时间、boot ID 和精确 argv，防止误认及误杀。
- 默认网络、接口、传输类型与 DNS 统一读取 Android ConnectivityService；legacy 上游随网络刷新，未知时降级且不再硬编码公共兜底。DNS 冲突扫描覆盖全端口、范围、多端口、否定与解析失败。
- 透明 DNS 故障保留 repair-needed，按持久自有元组与 conntrack ID 选择性清理 DNAT；legacy 使用独立 connmark 声明。失败保留监听器与恢复记录，升级前无标记流等待过期/重连，不清空外部连接。
- 任务取消失败可重试且保留稍后真实结果；保存、服务控制和恢复跨页面保留所有权，阻止重复操作。恢复预览绑定归档与当前配置双重 SHA256，暂存可取消、提交原子拒绝取消。
- 新增随 light/full 打包的 `foxyfiles`：恢复解包限制压缩/展开/成员大小与数量，拒绝链接及元数据扩展；固定 Android Taildrop 改为导入共享目录已完成文件，保留原件并通过私有收据去重，发送校验节点 ID/IP（含 IPv6）。
- 流量历史改用 1 MiB 分块稳定外排序与流式聚合，保留时钟跳变时的顺序语义；页面一次 summary 覆盖图表/peer/UID，超时和取消监督全部自有后代进程。
- 流量页切换小时/天视图不再先清空已挂载图表；复用同一 summary，保持图表可见。回归实际点击完整周期按钮并校验双向切换、日期桶及数值，避免匹配失败导致假通过。

## v1.3.8

- 修复透明 DNS 状态在内核重刷后的自相矛盾：`transparentAvailable` 与 `capabilityError` 现共用同一份按 boot_id 过滤的缓存，旧内核的失败原因不会再漏到新内核的状态输出。
- Taildrop 收件闭环：拉取改为阻塞等待新文件，收到后自动复制到 `/sdcard/Download` 并触发媒体扫描；收件箱新增下载/导出/删除单个与清空全部操作；发送接受 Tailscale IP 作为目标。发送进度、浏览器直传、Android 分享接入延后到后续版本（见 `docs/plans/2026-10-03-taildrop-overhaul.zh-CN.md`）。


## v1.3.7

- 修复 MagicDNS 在 tailscaled 停止时无法清理的死锁：服务 stop 阶段 daemon 已退出时，accept-dns 恢复会被推迟到下次 reconcile，cleanup 不再因此卡死并阻断服务重启；daemon 存活判断改用进程本身，避免异常退出留下的 stale socket 再次阻断 stop。
- 透明 DNS 模式在内核能力不足或规则冲突时在设置页置灰，不再允许选中一个必失败的配置；能力判定扩展到完整启动门槛（helper probe + capture mark 冲突 + OUTPUT 策略），判定结果按内核 boot_id 缓存，内核重刷后自动失效重判；已运行的 transparent 实例跳过探测直报支持。


## v1.3.6 — 2026-09-21

- 设备页拓扑图改为按实际连接路径绘制：实线表示已建立的直连（提示含对端地址），虚线经对应 DERP 区域中继节点，点线为离线成员；当前使用的出口节点高亮描边。
- 拓扑排序改为直连优先、按中继区域分组、离线靠后；无中继设备时保持原有紧凑布局；旧版后端缺少路径字段时按中继显示，不误报直连。
- 设备列表数据附带当前路径字段（CurAddr/Active）；拓扑标签页纳入 WebUI 冒烟回归覆盖。

## v1.3.5 — 2026-09-21

- 清理无调用方的 WebAPI 命令（key-expiry、mode-get）、service reconcile 子命令、stats recent-files 入口，以及 v1.0.5 之前的 dnsmasq 残留（PID 文件、hosts 清理与旧格式校验）。
- 拆分过大的脚本与前端模块：备份恢复、账号生命周期、DNS 偏好日志各自独立成库；隧道页 DNS 判断逻辑与工具页文案按特性拆分。
- 路径常量、守护状态查询、DNS 健康判断与常驻脚本停止逻辑集中到公共库；合并 DNS 拦截的 IPv4/IPv6 重复实现。
- 看门狗重启限额、窗口、冷却与后端异常阈值、场景检查间隔、流量保留天数可在 foxytail.conf 调整（高级项，不出现在 WebUI 设置页）。
- WebUI 删除 84 个未使用文案键与失效样式，统一加载门控、刷新按钮、防重入读取与复制提示；路由元数据改为单一来源。
- 删除冗余与琐碎测试，修复一个偶发失败的诊断超时回归；功能行为不变。

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
