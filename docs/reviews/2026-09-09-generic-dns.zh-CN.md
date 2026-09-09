# FoxyTail v1.3.0：通用 MagicDNS 与 Android VPN 共存

## 目标与范围

本次把 DNS 共存从特定 VPN 的配置适配，改为模块自身提供标准 DNS 端点，并在内核允许时透明处理普通 DNS。设置新增 `DNS_MODE=legacy|local|transparent`，与现有 `MAGIC_DNS` 开关、`DNS_PORT` 和 `IPV6` 配合。升级默认仍为 `legacy`，不自动改端口或接管设备 DNS。

这不是“所有 VPN 均已验证”的实现。当前没有连接的 ADB 设备，不能验证 Android SELinux、厂商内核、VpnService、网络切换和锁定模式的组合；主机回归与交叉编译的结论分开列出。

## 使用方式

1. 在设置页启用 MagicDNS，选择本地或透明模式，使用未被其他解析器占用的端口。已有 VPN 使用 1053 时，应选择空闲端口，例如 1054；模块不猜测或覆盖其他程序端口。
2. 保存后重启应用。设置保存不等于生效，待应用标记沿用现有流程。
3. 在隧道页检查实际端点、IPv4/IPv6 拦截状态及原生 DNS 策略。仅监听成功不能显示透明模式成功。
4. 本地模式或透明能力不足时，在支持分域 DNS 的解析器中，将当前 Tailnet 后缀指向所显示的本地端点。完整域名可直接按后缀分流；短名需要使用端的搜索域或短名规则。

本地端点不应作为唯一全局 DNS。它只服务当前 Tailnet 名字，公网请求返回 REFUSED。VPN 没有分域 DNS 配置入口时，不能靠本地模式自动改变其解析行为。

## 代码组织

| 位置 | 职责 |
|---|---|
| `native/foxydns/config.go` | 私有配置校验、原子状态文件写入，仅允许 loopback 监听 |
| `native/foxydns/records.go` | 当前节点表的 A/AAAA/PTR 与短名映射，文件变化和身份失效检测 |
| `native/foxydns/server.go` | UDP/TCP 服务、请求并发限制、精确上游转发与健康状态 |
| `native/foxydns/transport*.go` | Linux NFQUEUE、conntrack、路由与接口验证、原 UID/mark/socket 上下文 |
| `tailscale/scripts/foxytail.dns-modern.sh` | 新模式生命周期、能力检测、规则归属、偏好恢复日志和快速故障守护 |
| `tailscale/scripts/foxytail.dns` | 兼容入口及旧 dnsmasq 实现 |
| `tailscale/scripts/foxytail.webapi.sh` | 模式与状态 API、账户变更前恢复 DNS、变更后异步协调 |
| `tailscale/scripts/foxytail.watchdog` | 根据 `repairNeeded` 决定修复，避免对稳定降级反复重启 |
| `webui/src/pages/Settings.tsx`、`Tunnel.tsx` | 模式设置、实际端点、能力与故障提示 |
| `.github/tools/build-native.sh` | 固定 Go 工具链、arm/arm64 静态 ELF 构建与验证 |

## 解析与转发

本地记录来自当前 Tailnet 节点表，包括自身与可见节点。已知完整名、短名和反向记录在本地回答；未知 Tailnet 名返回 NXDOMAIN，已知名字缺少对应类型返回空答案。TTL 为 30 秒。每个查询检查上下文文件，替换、删除或损坏后不继续使用旧账户缓存。

透明转发先取得原始流信息。只依靠原 DNS 地址不够：Android VPN 选路还可能取决于 UID、mark、源地址及出口。实现用 NFQUEUE 捕获原上下文，再用 conntrack 的完整 NAT 回复元组和连接身份关联本地收到的查询，不按源端口猜测目标。

QUEUE 位于 mangle OUTPUT 末尾，避免 NFQUEUE 恢复后跳过已有模块在同一链中的规则。相关 OUTPUT 默认策略必须可确认是 ACCEPT；DROP 等策略不被改写或绕过。检测到其他工具已有 DNS 重定向或透明代理时退回本地端点，避免抢先接管破坏其 DNS 策略。接口字段本身不能证明最终选路，因此还需按原 UID、mark、地址和协议复核内核路由。信息缺失、出口不符、不受支持的报文或连接区域保留原路径。已经接管但无法恢复上下文时返回失败，不另选上游。

公网转发 socket 在连接前恢复 UID、mark，并绑定原接口和源地址。收到的 DNS 错误、截断位和 DNSSEC 标志保留，不增加公共 DNS、不自动更换目标或改用另一种传输。应用收到 UDP 截断结果后可自行发起原有 TCP 流程。helper 只对自己的上游 socket 使用保留文件 GID，并与 root 文件 UID 联合排除，避免循环；不排除 netd 等全部 root DNS。临时文件 GID 在独立锁定线程中使用，创建 socket 后恢复，再设置原 UID 与网络上下文。

## 偏好与生命周期

Android 版 tailscaled 原生 DNS 会安装全局重定向。两个新模式先启动并验证本地端点，再暂时设置当前账户 `accept-dns=false`。这会移除原生抢占，但不自动复制 Tailscale 配置中的公司分域 DNS、默认上游或搜索域。

修改前将原值、profile ID、节点 Self.ID 与操作阶段写入 `/data/adb/foxytail/state/foxydns-preferences.json`。只保存必要字段，不持久化包含密钥的整个 debug prefs 文档。停止时仅恢复匹配身份；原值为 false 时绝不恢复成 true。身份未知、偏好验证失败或其他账户仍有未恢复记录时保留日志并明确失败，不自动切换账户恢复。

WebUI 登录、密钥登录、退出、账户切换通过临时归属标记阻止 DNS 看门狗在账户变化过程中重新接管。DNS 停止和恢复必须先完成，否则账户变更不执行。外部显式更改偏好后放弃接管，不持续强改用户选择。卸载会将未恢复日志随原身份备份保存；安装时只随对应身份恢复。

透明模式先安装自有 NAT 入口，再启用队列；停止或降级按 NAT、mangle、守护与 helper 的次序拆除。删除失败时保留仍被重定向引用的监听进程，返回失败。状态区分监听、实际拦截、原生策略归属及是否需要修复。轻量守护以约两秒间隔检查 helper 健康，发生故障后撤除本模块规则，避免等待通常 30 秒的主看门狗周期。

## 能力不足与限制

| 情况 | 行为 |
|---|---|
| 端口占用、配置无效、helper 缺失 | 不报告监听成功，不先改原生 DNS 偏好 |
| NFQUEUE、conntrack、严格路由查询或 socket 能力不足 | 保留可用的本地 DNS 端点，不报告透明就绪 |
| IPv6 NAT 不存在 | 按已有机制尝试系统模块；仍不可用时保留 IPv6 隧道、AAAA 与本地 IPv6 DNS |
| 元数据不完整、socket 匹配不唯一或未连接、碎片、未支持的 IPv6 扩展头或非默认 conntrack 区域 | 原包保持原路径，不猜测公网目标 |
| 其他模块已劫持 DNS、相关 OUTPUT 默认策略不是 ACCEPT | 保留本地端点，不抢占现有 DNS/防火墙策略 |
| 捕获位 `0x20000000` 已被使用 | 拒绝透明接管或触发故障撤规则；不会清除其他程序的 mark |
| helper 退出、假死或队列健康失效 | 快速守护撤规则；监听仍可用时保留本地端点 |
| 外部更改账户 DNS 偏好 | 放弃本模块接管，报告策略变化 |
| DoH、DoT、应用内 DNS | 不透明解密或接管，仍需应用提供分域配置 |

当前透明能力探测同时要求 IPv4 和 IPv6 的严格路由查询支持；完全禁用 IPv6 路由的内核会整体降级本地端点。这与仅缺少 IPv6 NAT 的情况不同，后者仍可保留 IPv4 透明拦截。

保留位必须与其他程序约定不冲突。规则扫描不能证明未来某个进程不会设置同一位；冲突检测、进程故障和撤除规则之间仍存在短暂窗口。透明捕获也不能复制任意 SELinux、cgroup、文件凭据或其他 root 模块的全部策略，不能替代对实际 VPN 的验证。

DNS 解析成功与 Tailnet IP 可达是两件事。路由、ACL、接收子网通告、退出节点和 Android VPN 锁定策略仍决定实际连接。此改动不关闭 IPv6，也不修改其他模块的路由表、hosts 或 VPN 配置。

## 构建和验证

Go 固定为 1.27.1，依赖由 `go.mod`/`go.sum` 固定。两个架构使用 `CGO_ENABLED=0` 的 Linux 静态构建，验证 ELF 架构并拒绝动态加载器依赖。light 与 full 都内置 helper；其构建摘要使用独立 native 清单，原有已审阅上游二进制摘要不变。构建源码、依赖缓存和测试材料不进入模块包。

本次完整主机门禁通过：133 项后端隔离回归、556 项中英词条、26 组 WebUI smoke、类型检查、ShellCheck、产物一致性；Go race/vet 与两个架构静态编译通过。

主机验证覆盖真实 loopback UDP/TCP 查询、多次 TCP 查询、记录失效、大小与并发边界、上游响应保留、上下文丢失无回退；隔离 shell 回归覆盖偏好修改顺序、恢复与失败、规则归属、IPv6 降级、守护、账户变更与安装日志保留。WebUI smoke 覆盖默认模式、保存待应用、回滚、端点复制及能力不足不伪成功。

新增严格 Linux 网络命名空间门禁，用真实 NFQUEUE/conntrack、模块规则和 netd 风格 socket 验证；CI 中禁止跳过而伪称通过。

尚未完成真实 Android NFQUEUE → conntrack → VPN 上游的端到端验证，也未测实际 Wi-Fi/移动网络切换、锁定 VPN、DoH/DoT 客户端及不同 OEM 内核。设备重新连接后应先验证本地模式，再分别验证透明 IPv4/IPv6、公网请求出口、VPN 开关和故障撤规则。

## 核对的上游语义

- [Android common nfnetlink_queue.c](https://android.googlesource.com/kernel/common/+/refs/heads/android16-6.12/net/netfilter/nfnetlink_queue.c)：NFQUEUE 的 UID/GID 来自 socket 文件凭据，不能直接当作当前 `sk_uid`。
- [AOSP DnsResolver resolv_private.h](https://android.googlesource.com/platform/packages/modules/DnsResolver/+/refs/heads/main/resolv_private.h)：系统解析器通过 `fchown` 标记 socket 的请求 UID。
- [AOSP DnsResolver res_send.cpp](https://android.googlesource.com/platform/packages/modules/DnsResolver/+/refs/heads/main/res_send.cpp)：普通 UDP DNS 使用连接后的 socket。
- [AOSP netd.rc](https://android.googlesource.com/platform/system/netd/+/refs/heads/main/server/netd.rc)：netd 以 root 运行，因此不能把排除全部 root DNS 作为完整的系统 DNS 共存方案。
- [AOSP RouteController.cpp](https://android.googlesource.com/platform/system/netd/+/refs/heads/main/server/RouteController.cpp)：Android VPN 的 UID 与 fwmark 选路。

这些源码用于核对实现条件；分支源码核对不等于已连接设备的内核实测。
