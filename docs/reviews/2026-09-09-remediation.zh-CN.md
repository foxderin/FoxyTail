# FoxyTail 并行修复记录

日期：2026-09-09
修复基线：`b0f687a26678818cb5aba2d1ae5b462906f64965`
对应审查：[代码质量、架构与设计报告](/Users/spark/Development/FoxyTail/docs/reviews/2026-09-09-code-quality-review.zh-CN.md)

## 结果与范围

本轮已对审查中的 24 项问题实施代码修复或明确的能力限制，并完成交叉审查和宿主机验证。配置/API、网络/统计、WebUI 三组并行修改；主任务负责升级、生命周期、日志、发布链及集成。未提交 Git commit、创建标签或发布版本，也未在 Android 上执行真实的路由、iptables、安装和卸载操作。

**代码与隔离验证已完成；Android 真机验收仍未完成。** 原生 tun 的按应用隔离没有被标为已实现：当前明确限制为 `all`，需要 selected/bypass 时使用 bridge。

原审查报告保留原始基线和证据，本文件记录修复后的行为，避免把原报告的历史行号和实验结果混作当前代码状态。

## 逐项处理结果

| 编号 | 处理结果 | 实现与验收证据 |
|---|---|---|
| F01 | 已修复配置执行边界 | settings.sh 固定 schema；运行、写入、恢复复用同一数据解析器；拒绝未知键、重复键、执行语法及不合法值；不再 source 用户配置。恶意输入、空列表、无末尾换行均有测试。 |
| F02 | 已修复资源清理边界 | 表号限 1000–65535；拒绝外部表/优先级冲突；teardown 按安全 applied 数据删除精确策略规则及协议 186、tailscale0 的路由，禁止整表 flush；损坏状态不选取危险表。 |
| F03 | 已修复无掩码覆盖 | 固定 `0x40000000/0x40000000`，保留其余 mark 位；仅按配置目的网段打标，排除 UID 0 和 Tailscale 已标记的控制流量；旧 0xF7 在配置读取时迁移。共存兼容性仍需真机验收。 |
| F04 | 已用能力限制消除错误承诺 | service 启动前、API 保存/模式切换/恢复、route 执行和 WebUI 均拒绝 native tun + selected/bypass；未修改上游持续管理的表 52 来伪装 UID 隔离。 |
| F05 | 已重排升级流程并增加回滚 | 完整软件候选准备后，先用新解析器检查旧配置，再通过旧路径停止 watcher、驻留组件、网络服务并验证无存活实例；之后切换。文件失败回滚，信号/EXIT 回滚，未完成事务在下一次安装前恢复。 |
| F06 | 已改为完整状态检查 | `route check` 比较配置指纹、两族链规则、唯一 OUTPUT 跳转、mark/mask/pref/table 和路由快照；apply 仅在失配时重建，避免正常检查清零计数器。 |
| F07 | 已修正 UID 统计口径 | UID RETURN 位于兜底前；只数 TUN OUTPUT，合并 IPv4/IPv6，输出 tx；UI 明确为发送量；不再把原 rx 历史误当成正确 tx。 |
| F08 | 已修正计数重置与时段聚合 | 先按时间计算相邻 delta，结合 generation 处理重启，再按结束采样时刻归桶；跨小时/日不丢失该间隔，缺样本不伪造为零。`1000→1500→0→200` 得到 700。 |
| F09 | 已串行化配置操作 | 保存设置、模式、路由、context、备份和恢复共用原子 symlink 锁；包含 PID/starttime 身份及过期所有者恢复；不同键并发测试通过，网络 apply 也在同一锁内读取配置。 |
| F10 | 已区分保存与生效 | 配置写入带 revision 的 pending；API 返回 saved/applied/restartRequired。WebUI“重启应用”调用完整 reload，刷新驻留组件。旧 reload 仅能清除自身捕获的 revision，不能清除新的保存。 |
| F11 | 已支持局部恢复 | daemon 已存在时仍协调 tunnel/route/DNS；看门狗检查伴随层并在登录就绪后重试；postinstall 走完整启动，启动 stats/watchdog/context/logd；socket/接口未就绪不再当成功。 |
| F12 | 已完善 DNS 检查及状态 | 检查双栈 nat/mangle 中可达的 REDIRECT/DNAT/TPROXY；支持 TCP/UDP DNS；进程存活不覆盖 degraded；账号、Tailnet、suffix 变化使旧 resolver 失效并重建；清理失败保留 degraded。 |
| F13 | 已实现请求归属取消 | 每次调用有唯一且带时间的 request ID，登记 child PID/starttime；取消只信号该请求实例；晚到请求受 tombstone 约束，替换等待取消确认；过期 ID 拒绝启动并回收终态记录。 |
| F14 | 已修复首屏错误显示 | Peers、ExitNodes、Files 以及 Peers 拓扑首次失败显示错误与重试，不再永久 skeleton；故障与恢复均纳入 smoke。 |
| F15 | 已修复 SOCKS 探测 | 使用 `socks5h://`，校验端口；native tun 不显示 SOCKS 探测。 |
| F16 | 已适配固定 CLI 的账户接口 | 使用 `tailscale switch --list --json`，保留 id 与 label，使用真实 id 切换。 |
| F17 | 已修正 Serve/Funnel 映射 | 独立 ServeConfig 适配器按 listener flags 判断协议，保留全部 path、TLS TCP 和 AllowFunnel；删除使用准确协议、端口、路径；HTTPS 8443 与多 path 有回归。 |
| F18 | 已保留 CLI 错误信息 | ts_cli 不再全局丢弃 stderr；调用者选择捕获或忽略；账户、Serve 和其它变更错误保留具体原因。 |
| F19 | 已保留升级用户数据 | 软件候选保留自备 dnsmasq 和用户 hooks；files、身份、证书留在原路径；备份名含时间与进程 ID，同版本安装不删除先前备份。 |
| F20 | 已增加持续日志轮转 | 独立 logd 每 2 秒检查，不依赖 WATCHDOG 开关；轮转保留活动 inode、截断活动文件并限制备份末段大小；共用锁与退出清理，不因空 owner 目录永久失效。 |
| F21 | 已使备份/恢复按结果提交 | tar 与可读性检查成功后才 rename 完整备份；恢复先校验归档路径/类型、配置，再在同文件系统准备完整候选并保留旧目录；激活及回滚失败有专项测试，不会把旧目录嵌套到未删除的新目录。 |
| F22 | 已固定发布来源与元数据 | module、OTA、WebUI 版本统一；version-bump 在提交前更新完整元数据；Release 只 checkout 既有标签，校验标签与版本，从该树构建，不再发布后补提交。 |
| F23 | 已增加统一验证门禁 | verify.sh 串联 ShellCheck、后端行为测试、类型、i18n、自动构建 smoke、webroot 逐字节一致性、版本检查；PR 与 Release 共用；固定 Node/pnpm 和 WebView 目标。 |
| F24 | 已分离校验与信任更新 | 普通构建严格验证已审阅 manifest；显式 update 模式只生成 candidate，不替换已信任清单、不打包；真实下载的 6 个上游二进制均通过现有 SHA256。 |

## 主要代码入口

- [共享配置、锁、进程识别与日志](/Users/spark/Development/FoxyTail/tailscale/settings.sh)
- [WebAPI](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.webapi.sh)
- [路由控制器](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.route)、[统计](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.stats)、[DNS](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.dns)
- [安装器](/Users/spark/Development/FoxyTail/customize.sh)、[完整启动与 reload](/Users/spark/Development/FoxyTail/tailscale/scripts/start.sh)、[服务协调](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.service)、[logd](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.logd)
- [请求生命周期](/Users/spark/Development/FoxyTail/webui/src/api.ts)、[任务替换](/Users/spark/Development/FoxyTail/webui/src/tasks.ts)、[Serve 适配器](/Users/spark/Development/FoxyTail/webui/src/serve.ts)
- [统一门禁](/Users/spark/Development/FoxyTail/.github/tools/verify.sh)、[打包器](/Users/spark/Development/FoxyTail/.github/tools/build.sh)、[发布工作流](/Users/spark/Development/FoxyTail/.github/workflows/release.yml)

## 验证记录

完整门禁在 **Node 22.14.0 / pnpm 10.30.3 / ShellCheck 0.11.0** 下通过。隔离测试使用宿主机 Python 3.14.7；CI 的 Ubuntu/Python、Android mksh/BusyBox 组合仍由对应环境执行验证。

| 验证 | 结果 |
|---|---|
| Shell 语法与 ShellCheck warning 门禁 | 通过全部运行脚本及 Bash 发布工具 |
| [配置/API 测试](/Users/spark/Development/FoxyTail/tests/test_config_api.py) | 20 项通过 |
| [生命周期/升级测试](/Users/spark/Development/FoxyTail/tests/test_lifecycle.py) | 8 项通过，包括较新 revision 保留、并发 service 锁和删除失败回滚 |
| [网络测试](/Users/spark/Development/FoxyTail/tests/test_network.py) | 8 项通过，包括 12 个并发进程争锁、部分规则丢失、DNS 换账号及清理失败 |
| [统计测试](/Users/spark/Development/FoxyTail/tests/test_stats.py) | 7 项通过 |
| [发布打包测试](/Users/spark/Development/FoxyTail/tests/test_release.py) | 3 项通过；合成资源测试无网络；包含跨时区产物一致、变更资产拒绝与候选 manifest 模式 |
| 后端合计 | **46 项通过** |
| TypeScript / i18n | 通过；中英文各 **206** 键 |
| WebUI smoke | 通过；含 13 路由 × 3 轮及新增失败、取消、Serve、IPv6、并发应用状态场景 |
| 生产构建 | 通过；JS 195.48 kB（gzip 58.68 kB）、CSS 14.39 kB；已更新 webroot |
| 临时生产构建与 webroot 比较 | 逐字节一致 |
| 真实固定版本上游下载 | arm/arm64 的 tailscaled、jq、hev 共 6 个二进制 SHA256 全部通过；未更改哈希值 |
| 本地 light/full 打包 | 成功；只包含明确的运行时文件清单；源码与打包内容逐项核对 |
| Git diff --check | 通过 |
| Android 真机、Magisk/KernelSU 安装、真实路由与取消 | 未执行 |

统一入口：先用固定工具链安装 `webui` 依赖，再运行 `bash .github/tools/verify.sh`。本轮在完整门禁之后仅补充 README、安装提示文字、manifest 注释过滤及 release 上传 SHA256SUMS；对应脚本又经语法、ShellCheck、打包行为测试和真实打包验证。

本地产物沿用仓库当前 `v1.0.3` 元数据，属于**未发布验证包**，不是一个新发布版本：

- [轻量包](/Users/spark/Development/FoxyTail/dist/FoxyTail-v1.0.3.zip)
- [完整包](/Users/spark/Development/FoxyTail/dist/FoxyTail-v1.0.3-full.zip)
- [包摘要](/Users/spark/Development/FoxyTail/dist/SHA256SUMS)

## 明确的行为变化和验收边界

1. **native tun 只支持 all。** 按应用 selected/bypass 使用 bridge；bridge 排除 root UID 0，防止 root tailscaled/HEV 控制与转发连接回环。固定 mark 位也必须未被其它模块占用，不能据宿主机测试保证所有 Android 厂商内核共存。
2. **IPv6 需要显式子网。** 在开关 IPV6 前，先把所需 IPv6 CIDR 加入路由子网，例如 `fd7a:115c:a1e0::/48`。没有 IPv6 子网时明确拒绝应用，不把“接口有 IPv6”当成“IPv6 已被路由”。
3. **配置严格作为数据。** 仅支持固定键及经过校验的赋值；旧自定义未知变量或 Shell 表达式会被拒绝。非法配置不再以 root 执行。停止与路由清理尽量基于已有资源归属，不依赖非法的 desired 配置。
4. **完整应用设置使用 reload。** WebUI“重启应用”或 `/data/adb/foxytail/scripts/start.sh reload` 会重建驻留组件；底层 `foxytail.service restart` 管理网络服务层。禁用模块时不会报告重启应用成功。
5. **历史统计有口径限制。** 旧 UID rx 数据已被证明不可靠，因此不转成新的 tx。相邻采样跨时段的流量归入结束采样所在时段，返回 attribution 字段；首条采样是基线，不推算未观察到的流量。
6. **旧无归属标记的路由保守处理。** 正常升级先让旧版停止清理；单独替换脚本时遇到旧版未标协议的路由，只精确删除旧规则并告警，不凭表号删掉归属不明的条目。
7. **日志上限为周期控制。** 备份大小受 LOG_MAX_KB 限制，活动日志可能在两次 2 秒检查之间暂时超过阈值；copytruncate 在并发写入时仍可能丢失极短窗口的诊断输出。未声称零丢失日志或实时硬字节上限。
8. **事务不能替代设备恢复验证。** 常规失败、清理失败、并发与部分切换已有隔离回归；信号/退出回滚和下次安装恢复 journal 已实现，但未模拟真实断电、闪存故障及管理器自身的模块目录切换。

建议设备验收至少覆盖：bridge/tun/proxy 三模式、两个真实 App UID、已带 mark 的流量、Tailnet/子网/出口节点、双栈、DNS 代理共存、未登录到登录的转换、运行中升级/禁用/卸载，以及两个 WebUI 会话同时取消和保存设置。此清单是尚未执行的验收范围，不代表已经通过。

## 组织与后续设计

本轮把配置 schema、配置锁、待生效 revision 和统计 delta 收敛到共享入口，Serve JSON 适配从页面独立出来，建立统一验证和发布门禁。没有对整个 Shell 项目进行目录搬迁或引入大型运行框架；API、服务状态输出仍是较大的脚本，安装器的 flatten 布局仍保留。后续如拆分库，应同时修改安装、打包和 source 路径，并由本轮行为测试保护迁移。
