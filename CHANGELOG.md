# Changelog

## v1.5.0 — 2026-10-09 — 原生 Material 3 控制面

- Android 应用接管总览、登录/多账号、服务/模式、设备/出口、路由/DNS、设置/场景/试运行、流量/日志、Serve/Funnel、代理共存、诊断及备份恢复；保持 root 模块独立托管网络、身份和配置。
- 使用 Material Components 1.14.0 与 Material 3 中英/深浅色界面，保留系统分享/SAF，并补齐原生共享目录浏览与收件管理。
- 新增协议能力握手、受限持久控制操作及原子结果回执；保留退出码和实际状态，失联不重放，提交阶段拒绝取消。
- 备份/诊断使用私有有界产物令牌和二进制导出，SAF 导入保留双摘要预览和恢复事务；修复 Android mksh 持久 FD 的 CLOEXEC 导致恢复锁无法继承。
- 旋转后重新接管控制回执和 SAF 导入结果；写后读取排队核验，未修改草稿随恢复配置更新，编辑冲突明确提示；未知运行状态与升级期间仍保留确认停止入口。
- 修复场景 down 与配置试运行健康检查交错时误回退：失败后再次检查停止持有状态；试运行安装恢复回归等待真实 worker 退出而非固定休眠。
- 移除 WebUI 源码/静态产物、管理器 JavaScript 桥、Node/pnpm 验证和 base64 内联下载；CLI 与既有配置/身份目录保留，旧自动刷新磁盘键供原生界面继续使用。
- SOCKS 自检改用随包原生 `foxydns`，移除设备 curl 依赖；固定 HTTPS HEAD、Android APEX/系统 CA 校验、10 秒截止、不跟随重定向，真实代理拒绝/超时和取消保持失败。Android 15 无 curl 环境已通过实际 SOCKS→HTTPS 返回 HTTP 301，并验证已应用端口优先。
- 验证包含原生 race/vet、ARM/ARM64 静态构建、Android debug/release 构建与 lint、仪器检查，以及真实 Magisk 下启停/归档/Taildrop 字节核验；MD3 中英、深浅色、字体放大和旋转已实际检查。主机无 mksh 时相关回归显式跳过，CI 安装 mksh；实际 Android mksh 恢复已验证，OEM/KernelSU 全组合仍需实机验收。

### 升级说明

- 从 v1.4.x 升级模块并重启，桌面 FoxyTail 接管控制界面；原 WebUI 入口移除，不清除模块身份、配置或文件。
- APK 随模块同签名更新到 `/data/app`；App 需要单独 root 授权。Android 8.0 以下仍可使用模块 CLI，不提供原生图形界面。
- App 与模块控制协议需配套；仅更新 APK 到旧模块时会禁用不兼容写操作。不要卸载模块来解决 debug/正式签名冲突。

## v1.4.1 — 2026-10-09

- 修复 KernelSU 默认卸载模块导致 systemless APK 在桌面/App 命名空间不可见：附属应用改为随模块携带，由开机包管理器安装/更新至 `/data/app`，保留同签名数据；不关闭隐藏策略或自动授予 root。
- App root 调用使用可信绝对 su 路径、确认 UID 0 并区分启动/授权/模块/后端错误；设备读取失败不再误显示“无设备”，失败时禁用发送并支持刷新。
- 修复早期共享存储不可用遗留的 Taildrop 模式记录：通过当前 daemon 的精确 LocalAPI direct-mode 响应及前后进程身份验证恢复，不猜测模式、不强制重启网络服务。
- Android 16/OPlus + ReSukiSU 真机定位到桌面/App namespace 缺少 APK，而非资源打包错误；同签名包管理器更新与 daemon direct-mode 查询/记录恢复已实测，未关闭 SELinux 或更改 root 授权。
- CI 保留全部回归，独立后端模块最多四路并行，合并 Gradle debug/lint 调用、缓存 Go/Gradle 依赖，并移除非 PR CI 重复的 ARM 编译；构建产物权限不再受签名步骤 `umask 077` 污染。

## v1.4.0 — 2026-10-09

- 隧道页新增只读代理共存向导：基于已应用模式、当前 Tailnet、实际 DNS/SOCKS 端口生成 mihomo/Clash.Meta 合并片段，区分 fake-IP 黑名单、规则模式与 redir-host，拒绝未经审阅的白名单转换；不覆盖外部配置。
- 新增按需 UDP/TCP DNS 精确地址验证与节点 TCP/SOCKS 连接探针，错误逐项保留；当前节点身份、配置快照和前后状态校验防止旧预览或账号切换后误报成功。新 helper 随原有 native 构建打包，无新增依赖版本。
- 稳定原生探针回归的测试夹具：成对分配 TCP/UDP 监听端口，仅对临时端口占用重新分配，并等待 DNS 服务退出；TCP 夹具等待实际连接关闭后再拆除监听，避免并发验证出现假失败。
- Taildrop 文件页改为共享存储浏览与批量选择，最多 32 文件/2 GiB 每文件；新增模块持久发送队列、实际 daemon 字节进度、历史、取消与仅重试未成功项，删除旧同步 file-send 入口。
- 新增原生 Android 附属应用 `dev.foxderin.tail`：系统单/多文件分享、SAF 文件选择、确认发送、收件导入/浏览/打开/分享/另存与历史；前台服务只负责活动任务，保留 WebUI 的其余控制面。
- 使用私有 rooted 文件访问、stdin 二进制暂存和精确传输 ID 关联；成功仅以实际上传响应为准，未知进度不估算。发送任务跨 App/页面退出保留，停止/升级等待取消确认，私有暂存按需过期清理。
- Android APK 使用稳定私有签名并随 light/full 包挂载为普通 system/app 应用，不授予特权；加入 Android 构建/lint、签名和版本校验、原生传输与文件边界回归。
- 发布流水线显式选择 Android `platform-tools`，不再依赖 setup-android 默认安装的已下架 `tools` 包；验证与正式打包使用同一 SDK 配置。

### 升级与验证边界

- 从 v1.3.x 直接刷入 light/full 包并重启；两者均内置 Android 8.0+ 附属应用。首次使用在 Magisk/KernelSU 授予 root；登录、路由、DNS 等控制面仍留在 WebUI。
- 应用使用稳定正式签名；已有不同签名的 debug 应用需先移除该 debug 应用，再安装正式版本，勿卸载模块来处理签名冲突。
- 已覆盖 378 项隔离后端回归、658 项 WebUI smoke 断言、原生 race/vet、Android 构建/lint/仪器检查，以及独立 Android 15 模拟器上真实 Magisk 与两个 tailscaled 的系统分享、字节核验、收件导出、进度、取消和任务接管。
- 模拟器数据面验证不等同于 OEM 真机或 KernelSU 授权弹窗、SELinux enforcing 与后台限制验证；这些组合仍需实机确认。

## v1.3.12

- `v1.3.11` 因账户切换回归的临时目录清理竞争未通过发布门禁，未发布安装包；修正测试等待后台 DNS 重启结束，本版本包含下列实机验证的启动修复。
- 修复 Android 系统 `connmark_mangle_*` 链名被误判为 connmark 保留位冲突：仅解析规则中的 `-j CONNMARK` / `-m connmark`，保留真实位掩码冲突检查，避免关闭 MagicDNS 后旧 DNS 清理仍阻断启动。

## v1.3.10

- `v1.3.9` 标签未通过发布门禁，未发布安装包；本版本包含该批修复及下列监控启动竞争修复。
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
- 命令超时监控先发布信号处理器就绪状态，再允许父进程终止监控，避免快速失败的备份仍等待完整超时；PID 复用回归改用真实子进程 PID，消除空文件发布竞争。

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
