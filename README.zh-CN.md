# FoxyTail

**在 Android 上以 Magisk/KernelSU 模块运行的 Tailscale  mesh VPN** —— `tailscaled` 原生运行在设备上，支持三种运行模式、策略路由、流量分析、MagicDNS 分流 DNS、与代理/防火墙模块的共存探针、看门狗、网络环境感知、一键诊断包，以及一个内置的 WebUI 管理界面。

数据目录：`/data/adb/foxytail`（二进制、脚本、配置、状态、备份）。
模块配置：[tailscale/conf/foxytail.conf](tailscale/conf/foxytail.conf)、[routes.conf](tailscale/conf/routes.conf)、[context.conf](tailscale/conf/context.conf)。

English: [README.md](README.md)

## 与原项目的关系

FoxyTail 的灵感来自 [anasfanani/Magisk-Tailscaled](https://github.com/anasfanani/Magisk-Tailscaled)——感谢其首创把 `tailscaled` 打包为 Magisk 模块。FoxyTail 是全新重写，原因包括：原安装器用 `2>/dev/null || true` 掩盖下载/解包失败；拉取未固定版本的 `latest` 产物且无完整性校验；把 `/data/adb` 下文件错误打上 `system_file` SELinux 标签；使用四段版本号；用 grep/sed 解析 GitHub API JSON。FoxyTail 固定所有上游版本（[tailscale/VERSIONS](tailscale/VERSIONS)），对每个二进制做 SHA256 校验（[tailscale/checksums.txt](tailscale/checksums.txt)），并且出错即中止。

## 功能矩阵

| 功能 | 状态 | 说明 |
|---|---|---|
| 三种运行模式（`bridge` / `tun` / `proxy`） | ✅ | CLI 热切换；`tun` 需要 `/dev/net/tun` |
| 路由范围（`all` / `selected` / `bypass`） | ✅ | selected/bypass 仅 bridge；需要内核 `xt_owner` |
| 独立策略路由（表 1052，fwmark `0x40000000/0x40000000`） | ✅ | 绝不写 main 表 |
| 流量分析（`foxytail.stats`） | ✅ | JSONL 环形存储 7 天，熄屏自动降频 |
| MagicDNS 分流（`foxytail.dns`） | ✅ | 内置通用 DNS 端点，可选透明共存；保留旧 dnsmasq 模式 |
| IPv6 双栈 | ✅ | `IPV6=on`，ip6tables 对称规则 |
| 共存探针（`foxytail.compat`） | ✅ | 识别 Clash/mihomo、AFWall+、NetGuard |
| 看门狗（`foxytail.watchdog`） | ✅ | 崩溃自动拉起 + 网络切换 rebind |
| 网络环境感知（`foxytail.context`） | ✅ | 按 Wi-Fi SSID / 蜂窝执行规则 |
| 一键诊断包（`foxytail.diag`） | ✅ | tar.gz 输出到 `/sdcard/Download` |
| 管理器开关联动 | ✅ | inotify 监听 disable 标志 |
| WebUI（12 页） | ✅ | 仅 KernelSU/MMRL（Magisk 官方管理器不支持 WebUI），见下文 |
| light/full 双 zip、`update.json` OTA | ✅ | |

## 安装

[Releases](../../releases) 页面发布两种包：

- **`FoxyTail-<version>.zip`（light 轻量包）** —— 安装时从固定的上游 release 下载 `tailscaled`、`jq`、`hev-socks5-tunnel`，并按 `checksums.txt` 逐个 SHA256 校验。安装过程需要联网。自研 `foxydns` 已随轻量包内置。
- **`FoxyTail-<version>-full.zip`（full 完整包）** —— 内置全部二进制，可离线安装。内置二进制同样做 SHA256 校验，被篡改的 zip 会被拒绝。

在 Magisk Manager、KernelSU Manager 或 MMRL 中刷入任一 zip，然后重启（重启前可使用安装器打印的 `/dev/` 快捷方式）。

要求：arm 或 arm64 设备，Magisk v20.4+ 或 KernelSU ≥ 10670。升级时保留你的状态、配置与钩子文件（见下文）。

## 卸载与重装

从 Magisk/KernelSU 移除模块时会执行 `uninstall.sh`：停止所有 FoxyTail 组件、拆除路由/DNS 链、删除 `/data/adb/foxytail`——**但 Tailscale 身份不会丢**。删除前 `tailscaled.state` 会先备份到 `/data/adb/foxytail-state.backup`；下次安装时若尚无状态文件，安装器会自动恢复该备份（并打印提示），重装后仍是原节点、保持登录。如需全新身份，手动删除 `/data/adb/foxytail-state.backup` 即可。

## 快速上手

```sh
su -c 'tailscale login'            # 打印登录 URL，用浏览器打开完成登录
su -c 'foxytail.service status'    # 彩色摘要查看运行状态
```

刷入后首次重启之前，二进制还没挂上 `PATH`——请改用 `/dev/tailscale` 和 `/dev/foxytail.service`（安装器会打印同样的提示）。

常用扩展：

```sh
su -c 'tailscale set --exit-node=<节点>'   # 走出口节点
su -c 'foxytail.service mode tun'          # 切换运行模式并重启
```

## CLI 参考

所有入口位于 `/data/adb/foxytail/scripts/`，重启后软链进 `system/bin`。

| 命令 | 子命令 | 用途 |
|---|---|---|
| `foxytail.service` | `start` `stop` `restart` `status [summary\|peer\|exit-node\|all]` `log [daemon\|service]` `mode [bridge\|tun\|proxy]` `help [all]` | tailscaled 生命周期、彩色状态、模式切换 |
| `foxytail.tun` | `start` `stop` `restart` `status` | hev-socks5-tunnel → `tailscale0` 接口（bridge 模式）；调用 `foxytail.tun.up` / `.tun.down` 用户钩子 |
| `foxytail.route` | `apply` `teardown` `reload` `status` | 幂等策略路由引擎（`FOXY_*` 链、表 1052、fwmark `0x40000000/0x40000000`） |
| `foxytail.dns` | `start` `stop` `status` | MagicDNS 本地端点、透明共存和旧 DNS 控制 |
| `foxytail.stats` | `start` `stop` `status` `collect-once` `query [hourly <日期>\|daily\|topn <n>]` | 流量采集（按 peer Rx/Tx、按 UID 计数） |
| `foxytail.watchdog` | `start` `stop` `status` `check-once` | 崩溃重启、默认路由变化后 rebind（有限频） |
| `foxytail.context` | `start` `stop` `status` `check-once` | SSID / 蜂窝变化时执行 `context.conf` 规则 |
| `foxytail.compat` | `probe` `check` `check-dns-hijack` `suggest` | 探测共存的代理/防火墙/VPN 工具；校验 `FOXY_*` 链是否被清 |
| `foxytail.diag` | `collect [输出目录]` | 一键诊断 tar.gz（默认 `/sdcard/Download`） |

另有原版 `tailscale` CLI（`tailscale` 是指向 `tailscaled` 的软链；裸用时带 socket：`tailscale --socket=/data/adb/foxytail/run/tailscaled.sock …`）。

## WebUI

WebUI 已内置：位于 `webroot/`（纯静态零构建，后端为 `foxytail.webapi.sh` JSON 接口）。使用须知：

- 从 **KernelSU 管理器** 或 **MMRL** 打开。**Magisk 官方管理器不支持模块 WebUI**——那里不会出现入口按钮。
- 共 12 页（底部导航 +「更多」分组）：Dashboard · Peers（列表 + canvas 拓扑图）· Exit Nodes · Account · Tunnel · Routing · Traffic · Serve · Files（Taildrop）· Logs · Settings · Diagnostics。
- 无第三方依赖；中/英 i18n 与深浅色主题。

<!-- 截图占位：docs/screenshots/*.png（待补充，见 Roadmap） -->

## WebUI 开发

WebUI 源码位于 `webui/`（Vite + SolidJS + Material Web 3 组件 + `kernelsu` npm 桥接）。构建产物已提交进 `webroot/`，模块自包含，使用者无需安装 Node 工具链。

- `pnpm --dir webui install --frozen-lockfile` —— 安装依赖（一次性）
- `pnpm --dir webui dev` —— Vite 开发服务器（无 root 桥环境，界面显示 no-root 横幅）
- `pnpm --dir webui build` —— 生产构建输出到 `../webroot/`（构建结果需提交）
- `pnpm --dir webui typecheck` / `check:i18n` / `smoke` —— 类型检查、中英键值对齐校验、jsdom 冒烟（13 条路由 + 任务接管 + no-root 横幅）

契约：`webui/src/api.ts` 是 `tailscale/scripts/foxytail.webapi.sh` 的唯一消费者，其 JSON 契约冻结不可改。

## 验证与发布

开发工具链固定为 Node 22.14.0、pnpm 10.30.3、Go 1.27.1，WebUI 要求 Android WebView 109+。安装依赖后执行 `bash .github/tools/verify.sh`，统一检查 ShellCheck、隔离后端回归、类型、国际化、smoke、版本元数据和生产产物一致性；前端改动后先执行 `pnpm --dir webui build` 更新 `webroot/`。

发布前运行 `.github/tools/version-bump.sh`，提交版本元数据与前端产物后创建版本标签。分支推送执行 Verify 和 Linux 内核测试，通过后按已审阅的 `tailscale/checksums.txt` 构建两种 ZIP 并保存 30 天。Release 仅复用同仓库、标签对应完整提交 SHA 的成功 Verify 产物，排除 PR 产物；验证进行中则等待，没有可复用产物则对现有标签触发一次 Verify。同一提交的并发请求复用成功产物，失败门禁阻止发布，上传前再次核对下载包的校验和与版本。手动 Release 走同一路径。

更新依赖时显式运行 `bash .github/tools/build.sh --update-checksums` 生成候选文件，核对上游来源后再审阅、替换并提交；该模式不打包。

设置保存后以 WebUI 的“重启应用”或 `/data/adb/foxytail/scripts/start.sh reload` 刷新主服务和驻留组件。`foxytail.service restart` 仅重启网络服务层。升级保留接收文件、自备 dnsmasq、配置和身份；切换前停止旧组件，失败保留回滚记录。

设置页也可选择 **限时试用配置**：以已保存配置为候选，可单独选择运行模式；启动检查通过后，在 30–300 秒内确认保留，否则恢复之前的运行配置。计时由后台进程负责，关闭 WebUI 不影响回退；试用期间后续保存的配置不会被覆盖。检查只确认本机组件状态，仍需自行测试实际目标连通性。备份恢复先从 Download 选择文件并预览差异，恢复时校验相同文件内容；钩子仍只停放供审阅。

## 配置

`/data/adb/foxytail/conf/` 下三个文件，**仅在不存在时安装**——你的修改在模块升级后保留。

### `foxytail.conf`（主配置）

| 键 | 默认值 | 含义 |
|---|---|---|
| `TS_MODE` | `bridge` | `bridge`（userspace + socks5 + hev → tailscale0）· `tun`（原生 TUN，需 `/dev/net/tun`）· `proxy`（仅 socks5） |
| `SOCKS_PORT` | `1099` | tailscaled 本地 socks5 端口 |
| `DNS_PORT` | `1053` | 本地 DNS 端口；必须与其他解析器错开 |
| `DNS_MODE` | `legacy` | `legacy` 旧模式 / `local` 本地端点 / `transparent` 透明共存 |
| `MAGIC_DNS` | `off` | 启用所选模式的 Tailnet 域名解析 |
| `IPV6` | `off` | tailscale0 双栈 + ip6tables 对称规则 |
| `ROUTE_TABLE` | `1052` | 独立策略路由表号（1000–65535） |
| `FWMARK` / `FWMARK_MASK` | `0x40000000` | 固定共享标记位；旧 0xF7 配置读取时迁移 |
| `WATCHDOG` / `WATCHDOG_INTERVAL` | `on` / `30` | 崩溃重启 + rebind，检查间隔秒数 |
| `STATS_INTERVAL` | `60` | 流量采集间隔（熄屏自动降频） |
| `LOG_MAX_KB` | `512` | 日志轮转阈值（保留一个 `.bak`） |

### `routes.conf`（路由范围）

| 键 | 默认值 | 含义 |
|---|---|---|
| `ROUTE_SCOPE` | `all` | `all` · `selected`（仅 `UID_LIST`）· `bypass`（除 `UID_LIST` 外全部） |
| `UID_LIST` | 空 | 空格分隔的 App UID 列表 |
| `ROUTE_SUBNETS` | `100.64.0.0/10` | 走隧道的 CIDR 列表 |

### `context.conf`（网络环境感知）

每行一条规则：`<触发>:<值>:<动作>[:<参数>]`

```
ssid:HomeWifi:down            # 连上该 Wi-Fi 时关闭隧道
ssid:Office:exit-node:myserver
cellular:-:no-exit-node       # 切到蜂窝时清除出口节点
```

动作：`up`、`down`、`exit-node <参数>`、`no-exit-node`。

WebUI 设置的高级选项支持可视化增删、编辑与排序，也可切换原文编辑；保留注释和未识别行，非法规则仍由后端拒绝。最近执行结果来自实际整组动作，保存成功不等于动作已执行成功。

### 用户钩子

`/data/adb/foxytail/scripts/foxytail.tun.up` 与 `foxytail.tun.down` 在 `tailscale0` 接口 建立/拆除 后执行（bridge 模式）。可在此添加自定义路由/防火墙规则。**安装器绝不覆盖你的修改**——若新模板有更新，会保存为旁边的 `<hook>.new`。

## 运行模式详解

| | `bridge`（默认） | `tun` | `proxy` |
|---|---|---|---|
| 原理 | userspace tailscaled + socks5 + hev-socks5-tunnel → `tailscale0` | tailscaled 原生 TUN | 仅 socks5，不建接口 |
| 依赖 | 无特殊要求 | `/dev/net/tun` | 无 |
| 无 TUN 支持可用 | ✅ | ❌ | ✅ |
| 按 App 路由 / 流量统计 | ✅（UID 0 绕行） | 仅 all；支持 peer/接口统计 | ❌（无接口） |
| 性能 | userspace 拷贝开销 | 最佳 | 仅应用层 |

切换：`foxytail.service mode <模式>`（写入 `TS_MODE` 并重启）。`/dev/net/tun` 缺失时拒绝切到 `tun`。

## 路由引擎

`foxytail.route` 把一切放在独立位置，不影响其他模块：

- 所有规则进专用链：`FOXY_MARK`（mangle）与 `FOXY_STAT`（filter，供流量统计计数）；内置链各只挂一跳
- 策略路由使用独立表 **1052**（1000–65535，须无外部资源冲突）与固定 mark/mask **`0x40000000/0x40000000`**；保留其他标记位，不清空整张路由表
- `check` 比较完整配置、双栈规则、OUTPUT 跳转及路由快照；`apply` 在失配时修复，`teardown` 只移除精确策略规则和协议 186、设备 tailscale0 的路由
- 旧 DNS 模式额外使用 `FOXY_DNS`（nat）做 53 重定向；检测到其他模块已劫持 53 端口时自动跳过

## 共存指南

FoxyTail 从不动其他模块的链，开机时自动探测邻居（`foxytail.compat probe` → `/data/adb/foxytail/run/compat.json`）。

- **Clash / mihomo / box-for-magisk**：这类工具通常劫持 DNS（redirect 或 TPROXY UDP/53）。旧 DNS 模式安装重定向前先跑 `foxytail.compat check-dns-hijack`；冲突时跳过重定向（dnsmasq 仍在 1053 端口运行，状态记为 `degraded`）。只有检测到实际 DNS 重定向冲突时才需要协调两者；仅安装代理应用不会禁用 MagicDNS。
- **AFWall+**：防火墙重载可能清掉我们在内置链上的跳转。FoxyTail 的规则隔离在 `FOXY_*` 链中；用 `foxytail.compat check` 检测、`foxytail.route apply` 恢复。
- **NetGuard / 其他 VPN 应用**：FoxyTail **不占用** Android VpnService，零 VPN 槽位冲突——但开启「始终在线」的 VpnService 应用仍可能在我们的路由之前截获流量。

## MagicDNS 说明

在设置页打开 MagicDNS，选择 DNS 模式和空闲端口，再重启应用。升级沿用 `legacy`，不自动更改现有端口。新模式使用随两种安装包内置的 `foxydns`，无需自备 dnsmasq，也不依赖某个 VPN 应用的名称或私有接口。

| 模式 | 行为 | 适用条件 |
|---|---|---|
| `legacy` | 保留 dnsmasq 分流及原有 DNS 冲突检测 | 沿用现有配置 |
| `local` | 提供 `127.0.0.1:DNS_PORT` 的 UDP/TCP DNS；启用 IPv6 时同时监听 `[::1]:DNS_PORT` | 在支持分域 DNS 的任意解析器中，把当前 Tailnet 后缀交给此端点 |
| `transparent` | 内核和原请求选路信息都可验证时，接管普通 UDP/TCP 53 查询；无法启用时保留本地端点 | root、NFQUEUE、conntrack、INET_DIAG、严格路由查询及 socket 上下文能力可用；需验证实际设备/VPN组合 |

本地端点只回答当前节点表中的完整名、已知短名、A/AAAA/PTR。未知 Tailnet 名返回 NXDOMAIN，公网名返回 REFUSED，不能把它设为唯一的全局 DNS。后缀与实际端口可在隧道页查看并复制；需要短名时，在使用端配置该 Tailnet 搜索域或相应短名规则。某些 VPN 不提供分域 DNS 配置，此时本地模式不能自动接管它的解析。

透明模式先保留原请求的目标地址、UID、mark、源地址与出口信息，再验证内核路由。只有完整且一致的上下文才允许重定向；公网查询按原上下文访问原 DNS，不添加公共兜底 DNS。端口占用、能力缺失、规则丢失及策略恢复失败分别报告，只有实际 IPv4/IPv6 拦截就绪才显示对应能力。内核没有 IPv6 NAT 时保留 IPv6 隧道、AAAA 和本地 IPv6 监听，透明接管仅覆盖可用的 IPv4 路径。

新模式会暂时关闭当前 Tailscale 账户的 `accept-dns`，避免 Android tailscaled 的全局 DNS 重定向与 VPN 争抢。原值在修改前记录到私有持久日志；停止或 WebUI 切换账户前，仅对匹配的 profile 和节点身份恢复。用户从外部更改该偏好后，模块停止争抢，不反复覆盖。无法确认身份或恢复结果时保留日志并报告，账户切换也会中止。卸载将未解决的记录随原身份备份保留。**Tailscale 配置的公司分域 DNS、全局上游和搜索域不会自动复制到新模式**，需要使用端保留相应策略。

透明模式仍有明确边界：不接管 DoH/DoT，不重建 SELinux/cgroup 等任意应用身份；无法精确确认 socket UID 的流及不受支持的报文保持原路径。检测到其他 root 模块已劫持 DNS，或相关 OUTPUT 默认策略不兼容时，保留本地端点。保留位 `0x20000000` 必须不被其他程序使用；检测到冲突时停止透明拦截。辅助进程故障与规则移除之间存在短暂窗口，不能把能力探测成功等同于所有 VPN 已验证。完整设计、故障行为及验证范围见 [通用 DNS 共存实现说明](docs/reviews/2026-09-09-generic-dns.zh-CN.md)。

Android 16 + FlClash 测试机已通过本地 UDP/TCP 与 IPv6 DNS 验证，但缺少 `CONFIG_NETFILTER_NETLINK_GLUE_CT`，现有 OEM mark 规则也阻止透明接管；单独支持 NFQUEUE 和 conntrack 并不足够。这台设备使用本地模式，仍需使用端配置 Tailnet 分域 DNS，未实现免配置的透明共存。完整透明路径通过的是独立的严格 Linux 内核测试。

旧模式依次使用 `/data/adb/foxytail/bin/dnsmasq`、`/system/bin/dnsmasq`、`/vendor/bin/dnsmasq`；三者都不存在时仍需用户提供可信二进制。其公网兜底策略保持原样，以上“无公共兜底”约束针对两个新模式。

## IPv6

`IPV6=on` 为 `tailscale0` 配置双栈地址（bridge 模式下为 `fd7a:115c:a1e0::1`），添加对称的 ip6tables 策略规则，并路由 `fd7a:115c:a1e0::/48`（请加入 `ROUTE_SUBNETS`）。默认关闭。开启前必须在路由子网中添加 IPv6 CIDR，否则路由应用会明确失败。

## 流量分析与诊断包

- `foxytail.stats` 每 `STATS_INTERVAL` 秒采样一次 per-peer Rx/Tx 与双栈隧道 OUTPUT 的 UID 发送计数，写入 `/data/adb/foxytail/run/stats/YYYY-MM-DD.jsonl`（7 天环形，熄屏降频）。查询：`foxytail.stats query hourly <日期> | daily | topn <n>`。
- 诊断页可按需查看服务、隧道、路由和 DNS 摘要，并跳转到对应处理页面；设备详情可分别测试 IPv4/IPv6，显示实际 Ping 的延迟及直连/中继路径。
- `foxytail.diag collect` 把日志尾部、状态、netcheck、路由与配置打包到 `/sdcard/Download/foxytail-diag-<时间戳>.tar.gz`，默认用一致代号替换采集到的账户、设备名、SSID 和地址。分享前仍应检查自定义日志内容。`foxytail.diag collect /sdcard/Download local` 保留详细信息，仅供本机排查；WebUI 也可显式选择此模式。

## 限制（如实说明）

- **仅 arm / arm64**——其他架构安装器直接中止。
- 默认 `bridge` 模式为 userspace 网络栈：吞吐低于内核 TUN（有条件请用 `tun` 模式）。
- WebUI 未内嵌登录二维码——请使用 `tailscale login` 打印的 URL。
- SSID 探测解析 `dumpsys wifi` 输出，各 Android 版本格式有差异（已做容错，最坏情况返回 "unknown"）。
- 内核路由需要 `xt_owner` 以排除控制进程；缺失时拒绝应用。按 App selected/bypass 仅支持 bridge，UID 0 不进入 bridge 隧道。
- 旧 DNS 模式在没有兼容系统 dnsmasq 时仍需自备；新模式内置解析器，但透明接管取决于设备内核和 VPN 选路能力。

## 故障排查

1. `foxytail.service status`——daemon 是否运行？backend 是否 `Running`？
2. `foxytail.service log daemon` / `log service`——最近的错误。
3. `foxytail.route status`——链/表/规则是否在位？被其他工具清了则 `foxytail.route apply`。
4. `foxytail.compat check` + `foxytail.compat suggest`——共存冲突。
5. `foxytail.diag collect`——生成诊断包并附到 issue。

看门狗会自动拉起崩溃的 tailscaled（限频：10 分钟内最多 5 次重启，随后冷却 5 分钟）。

## Roadmap

- 补全 `docs/screenshots/` 下的 WebUI 截图并嵌入本文档
- 接入可信的 Android 静态 dnsmasq 来源，让 MagicDNS 开箱即用
- 真机兼容性矩阵（Android 版本 × 内核 × 共存代理模块）

## 致谢

- [anasfanani/Magisk-Tailscaled](https://github.com/anasfanani/Magisk-Tailscaled)——原始创意与灵感来源
- [Tailscale](https://tailscale.com)——mesh VPN 本体（Android CLI 构建来自 [anasfanani/tailscale-android-cli](https://github.com/anasfanani/tailscale-android-cli)）
- [heiher/hev-socks5-tunnel](https://github.com/heiher/hev-socks5-tunnel)——socks5 → TUN 桥
- [Magisk](https://github.com/topjohnwu/Magisk) 与 [KernelSU](https://kernelsu.org)——模块框架

## 免责声明

本模块为非官方社区作品，与 Tailscale Inc. 无关。它会修改系统网络配置，使用风险自负。升级前请做好备份。

## 许可证

BSD 3-Clause——见 [LICENSE](LICENSE)。上游二进制保留其各自许可证。
