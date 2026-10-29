# DNS 端口劫持模式（hijack）设计

日期：2026-10-28。状态：设计评审，未实现。

## 目标与非目标

新增 `DNS_MODE=hijack`（端口劫持）：**所有 UDP/53 解析请求都经过模块的裁决**，但只有当前 Tailnet MagicDNS 后缀内的名字和已知节点短名被模块应答；其余查询**原包透传**——不重定向、不回放、不改包、不改路由，公网 DNS 路径与模块不存在时完全一致。

非目标：

- 不接管公网/公司 DNS 的上游选择（不像 legacy 的 dnsmasq 固定上游）。
- 不改变其他 VPN/代理工具的 DNS 策略（不像 transparent 需要回收全部 53 端口流量再按原上下文回放）。
- 不处理 DoH/DoT/应用内私有 DNS（与现有模式一致）。
- 第一阶段只覆盖 UDP/53；TCP/53 见「阶段与取舍」。

## 现状与动机

现有三种模式的拦截机制与内核依赖：

| 模式 | 拦截方式 | 内核依赖 | 透传方式 |
|---|---|---|---|
| legacy | `nat/OUTPUT` 全量 `REDIRECT :53 → dnsmasq` | iptables REDIRECT + conntrack 日志清理 | 非透传：dnsmasq 转发到快照的系统 DNS |
| local | 无拦截 | 无 | — |
| transparent | `mangle/OUTPUT` NFQUEUE → mark `0x20000000` → `nat` REDIRECT → listener 回放 | NFQUEUE + `GLUE_CT` + conntrack + INET_DIAG + 严格路由查询 | 回放：按原 UID/mark/接口重建 socket 向原目的转发 |

已实测设备（6.12.38-android16-5）上 transparent 不可用的两个原因：`CONFIG_NETFILTER_NETLINK_GLUE_CT` 未启用（NFQUEUE conntrack 元数据 `EOPNOTSUPP`）、OEM 已有规则用宽 mark 掩码覆盖 `0x20000000`（`modern_capture_safe` 拒绝接管）。该设备有 `NETFILTER_NETLINK_QUEUE=y`、`NF_CT_NETLINK=y`。

新模式的动机正是在这类内核能力不完整、或有其他 DNS 劫持工具共存的设备上，提供**无需配置即可只对 Tailnet 名字生效**的自动方案。关键认知：选择性拦截只需要在 DNAT 发生**之前**读到问题名，不需要 transparent 模式的原始 socket 上下文回放链——因此可以去掉 GLUE_CT、INET_DIAG、严格路由、conntrack 元数据、mark 位这些全部硬依赖。

## 方案对比

| | A（推荐）：NFQUEUE 按名裁决 + 应答注入 | B：全量 REDIRECT + conntrack 回放 | C：iptables 载荷匹配 |
|---|---|---|---|
| 机制 | `mangle/OUTPUT` 将 udp/53 送入队列；foxydns 解析问题名，命中 Tailnet 名则**自己伪造一条来自原 DNS 的应答包**（raw socket 注入，src=原目的）并 DROP 原包，未命中 NF_ACCEPT | `nat/OUTPUT` 无条件 REDIRECT 全部 udp/53 → listener；非 Tailnet 名经 conntrack 反查原目的后用 helper socket 转发 | `-m string --hex-string <后缀>`（锚定结尾）+ `-m u32`（锚定 qname 起点匹配短名/PTR）命中才 REDIRECT |
| 内核依赖 | NFQUEUE（包拷贝+UID/GID flag）+ raw socket | REDIRECT + `NF_CT_NETLINK` | REDIRECT + `xt_string` + `xt_u32` |
| 透传保真度 | 字面透传（原包原路） | 回放（丢 UID/mark/接口上下文） | 字面透传 |
| 实测设备适配 | QUEUE=y 满足；注入待验证 | CT 满足；但 helper(uid0) socket 访问 FlClash fake-IP 等 VPN 内 DNS 会因按 UID 路由失败 | 避开 mark 冲突；`xt_string`/`xt_u32` 是否存在未知 |
| 节点增删 | 无感知（records 每次查 context 文件） | 无感知 | 需重建规则链 |
| 大小写随机化(0x20) | Go 解析，正确 | Go 解析，正确 | 失配 → 透传降级 |
| 主要风险 | 注入路径（SELinux/rp_filter）待真机验证 | 回放上下文丢失，非真透传 | 匹配粒度与规则量随节点数增长；短名误匹配需 u32 锚定 |
| 新代码量 | 中（Selector+注入，均复用现有库） | 低（约等于 transparent 去掉上下文） | 中高（规则渲染/原子重建/journal） |

**推荐方案 A**。理由：依赖最少（NFQUEUE 本身在目标设备上已确认存在）、透传是字面语义、无任何 DNAT 残留需要清理、helper 死亡时 `--queue-bypass` 自然 fail-open 到透传、且不存在 B 的「回放破坏其他 VPN DNS」问题与 C 的模块依赖/规则规模问题。方案 B 唯一优势是不依赖 NFQUEUE，但「透传」名不副实，在共存 VPN 设备上有实质功能缺陷，仅作为 NFQUEUE 也不可用时的备选记录。

## 方案 A 详细设计

### 数据路径

```
应用 UDP/53 查询
  → mangle/OUTPUT（其他模块规则）
  → FOXY_DNS_QUEUE（本链，OUTPUT 末尾挂载）
      ├─ owner uid0/gid65533 → RETURN（helper 自身流量豁免）
      └─ udp --dport 53 → NFQUEUE 1053 --queue-bypass
          → foxydns Selector 裁决：
              ├─ records.answer 命中（后缀内/短名/已知PTR）→ 构造应答
              │     → raw socket 注入 src=原dst:53 → DROP 原包
              │     → 客户端收到「来自原 DNS 服务器」的应答
              ├─ 未命中/解析失败/包不完整/注入失败 → NF_ACCEPT 原样放行
              └─ helper 不健康 → NF_ACCEPT（fail-open）
  →（未消费包）nat/OUTPUT、filter、原路由 → 原 DNS 服务器
```

注入应答是目的地址为本机的**本地生成的外发包**：源地址伪造为原 DNS 服务器，经路由本地交付给等待的客户端 socket，四元组/事务 ID/问题名完全匹配，客户端视角与真实服务器应答无差别。原包被 DROP，真实服务器不会收到——不存在双应答。

### foxydns（native/foxydns/）改动

| 文件 | 改动 |
|---|---|
| `config.go` | `Mode` 增加 `hijack`。校验：要求 `Queue != 0`（仍用 NFQUEUE）、`ContextFile`、`StateFile` 绝对路径；**不要求** `OwnershipFile`（无 DNAT 即无 ownership journal） |
| `select_linux.go`（新） | `Selector`：NFQUEUE 打开（flags：`FAIL_OPEN`、`UID_GID`，**不请求 CONNTRACK**——这是绕开 GLUE_CT 的关键）；verdict 回调先复用 `packetTuple` 做合法性过滤，再解析 UDP 载荷中 DNS 问题名，交给 `records.answer` 判决；注入成功 → `SetVerdict(DROP)`，否则 `SetVerdict(ACCEPT)`。helper `UID==0 && GID==helperSocketGID` 直接 ACCEPT 豁免。`Health()`/`Close()` 与 `Interceptor` 同接口 |
| `inject_linux.go`（新） | `injectAnswer(family, src netip.AddrPort, dst netip.AddrPort, payload []byte) error`：`SOCK_RAW`+`IP_HDRINCL` 组包（IPv4 全头/IPv6 payload），伪头部 UDP 校验和。probe 自测：对 `127.0.0.1` 自有 UDP socket 注入并确认实际收到，同时验证发送与本地交付路径（覆盖 SELinux/rp_filter 风险） |
| `records.go` | 新增 `capture(qname) bool` 或直接复用 `answer()` 返回 `(msg, ok)`——Selector 直接用 `answer()` 产出完整应答（含后缀内 NXDOMAIN、已知名空答、PTR），语义与 listener 完全一致 |
| `server.go` | `service` 的 `interceptor` 字段泛化为 `interface{ Health() error; Close() error }`；mode=hijack 时装 `Selector`。`resolver.transport` 保持 nil（非本地名→REFUSED，只有直接打到 `127.0.0.1:DNS_PORT` 的查询才会走到这）。`healthState` 的 `QueueReady` 复用为「Selector 健康」语义 |
| `main.go` | `probe` 增加 `--hijack`：打开 Selector + 注入自测，返回 `{ok,queue,inject}`；`serve`/`health`/`watch`/`quiesce`/`check` 接口不变（quiesce=关 Selector→fail-open；watch/guard 语义同 transparent）；signal 路径对 hijack 不跑 `cleanupOwnedFlows`（无 journal） |
| `control.go` | hijack 也启用 quiesce control socket（复用同一代码路径） |

Selector 用与 resolver 相同的 `recordStore`：每个包 `stat` context 文件（mtime/inode 变更才重解析），与 listener 每查询 stat 一次语义一致；账户切换/文件损坏时立刻停止应答（无法判决 → ACCEPT 透传，tailnet 名走公网得 NXDOMAIN——降级而非断网）。

### Shell 生命周期（tailscale/scripts/foxytail.dns-modern.sh）

hijack 与 transparent 共用现代模式全部骨架：listener 就绪先于偏好接管、`modern_pref_claim/restore`（accept-dns=false 关掉原生全局 DNAT——否则 ACCEPT 的包会被 tailscaled 原生规则劫走，透传语义被破坏，**必须保留**）、`MODERN_*` 状态文件、guard/watch/quiesce、能力缓存。差异点：

1. **规则集**：hijack 只用 mangle `FOXY_DNS_QUEUE` 链（owner 豁免 + `udp --dport 53 NFQUEUE --queue-num 1053 --queue-bypass`），**不建 nat 捕获链**。`modern_rules_family/present/teardown` 按 mode 参数化；teardown 对两链全删，天然兼容。
2. **能力门禁**：不复用 `modern_probe_capabilities`（那是 transparent 的全要素探测）。新 `modern_probe_hijack`：queue Ready 快速路径 → `foxydns probe --queue N --hijack`（验证 NFQUEUE 绑定+注入自测）→ `modern_packet_policy_safe`。**跳过 `modern_capture_safe`**（不用 mark）与 socket/route 检查——这是它能覆盖 transparent 不可用设备的根本原因。Verdict 缓存到独立文件 `foxydns.hijack-capabilities.json`（含 bootId，与 transparent 缓存互不干扰）。
3. **冲突检查**：跳过 `dns_hijack_conflict`——本模式在 mangle 层先于任何 nat 劫持做裁决，外来 REDIRECT 只能影响我们放行的包，不会抢走 tailnet 名；外来 mangle 早位规则只会 drop/mark（mangle 不能 NAT），属对方策略范围。共存性优于 transparent。
4. **IPv6**：不依赖 `ip6table_nat`/`ensure_ipv6_nat`——只需 `ip6tables -t mangle -S OUTPUT` 可用就装对称 v6 队列规则。缺 ip6table_nat 的设备上 hijack 仍可拦 IPv6 DNS（transparent 做不到）。
5. **失败降级**：`DNS_MODE=hijack` 且探测失败 → 退回 local 端点 + reason=`hijack-unavailable`，与 transparent→local 的既有降级语义一致。
6. **状态**：`modern_dns_status` 的 mode 白名单加 `hijack`；`interception4/6` 表示队列规则就位且 `queueReady`；reason 复用 running/queue-failed/guard-failed/local 等。

### 其余触点

| 位置 | 改动 |
|---|---|
| `tailscale/conf/foxytail.conf` | DNS_MODE 注释加 hijack 行：「hijack: 仅 Tailnet 名由本模块应答，其余 DNS 原包透传；需要内核 NFQUEUE。」 |
| `foxytail.config.sh` | `_conf_value_error` 加 `DNS_MODE:hijack` |
| `settings.sh` `dns_status_healthy` | 加 `(.mode=="hijack" and .reason=="running" and .interception4==true)` 分支 |
| `foxytail.webapi-network.sh` | `cmd_dns` 透传新增 `hijackAvailable`/`hijackUnavailableReason`；`cmd_dns_probe`（或新增 `probe-hijack`）运行 hijack 探测并缓存 |
| `foxytail.webapi-coexist.sh` | mode 白名单加 `hijack`，reason 白名单补 hijack 专有项 |
| `webui/src/settings.ts`、`Settings.tsx` | DNS_MODE choices 加 hijack；`hijackAvailable===false` 时按 transparent 同款逻辑置灰+原因提示 |
| `webui/src/pages/tunnel-dns.ts` | `mode` 联合类型、`modernDns()` 纳入 `hijack`，reason 映射补 hijack 文案 |
| `webui/src/i18n-tools-settings.ts` | 中英词条：`tools_dns_mode_hijack`（端口劫持 / Port hijack）+ hint（仅 Tailnet 名由本机应答，其余 DNS 原样透传）+ unavailable |

### 失败与降级矩阵

| 情况 | 行为 |
|---|---|
| NFQUEUE 不可用/队列被占/注入自测失败 | 探测返回 unavailable → 退回 local 端点 + `hijack-unavailable` |
| records 文件损坏/账户切换中 | Selector 无法判决 → 全部 ACCEPT 透传（tailnet 名得公网 NXDOMAIN），listener 同理 REFUSED |
| helper 崩溃 | `--queue-bypass` + FAIL_OPEN：新包直接透传；guard 2 秒内撤规则并记 `queue-failed`/`guard-failed` |
| 注入失败（SELinux/rp_filter 拦截） | 该包 ACCEPT 放行给真实 DNS；probe 阶段已自测，运行时失败按不健康处理 |
| 解析不出问题名（碎片、扩展头、压缩、多 question、非标准 opcode） | ACCEPT 透传，绝不猜测 |
| 外来工具已劫持 53 | 不冲突：tailnet 名在 mangle 层已被我们消费，其余包走对方规则 |
| OUTPUT 策略非 ACCEPT | 探测拒绝接管，退回 local |
| 旧 conntrack 残留 | 不存在：本模式不产生 DNAT |

### TCP/53 取舍

无法在 SYN 阶段知道问题名，选择性劫持 TCP 不可能在包级完成。阶段一 TCP:53 全透传（libc/netd 的常规路径是 UDP；应用仅在收到 TC 或主动 TCP 时才走 TCP，Tailnet 应答都很小，影响面极低）。若后续需要覆盖：阶段二可选「无条件 REDIRECT tcp/53 → listener 读首个 query，Tailnet 名本地答，非 Tailnet 名按 `SO_ORIGINAL_DST` 转发并管道转发整个连接」——注意 TCP 回放同样丢 UID 上下文，作为显式子开关单独评审。

## 备选方案备忘

- **B（全量重定向+回放）**：规则与 legacy 同形（nat REDIRECT 全部 53 + owner 豁免），listener 非 Tailnet 名用 conntrack 反查原目的回放。内核只要 REDIRECT+conntrack，连 NFQUEUE 都不要；但非 Tailnet 查询全部以 helper socket 上下文发出，对依赖按 UID/mark 路由的 VPN 内 DNS（如 FlClash fake-IP）会解析失败——不满足「透传」语义。仅当 NFQUEUE 也不存在时才值得考虑。
- **C（iptables string/u32 匹配）**：无需 NFQUEUE、无 mark、无 conntrack，后缀用 `--hex-string` 锚定结尾零误匹配；但短名必须 u32 锚定 qname 起点（否则 `x.<短名>` 公网域被误劫），节点变化要原子重建整链，且 `xt_string`/`xt_u32` 模块在 Android 内核的可用性未知。若方案 A 的注入路径在真机被 SELinux 阻断，C 是首选后备。
- **A′（NFQUEUE+mark+REDIRECT，即「透明 minus 上下文」）**：仍要 mark 位与 `modern_capture_safe`，在实测设备上被 OEM 掩码挡掉，淘汰。

## 验证计划

1. **Go 单测**：问题名解析（大小写、压缩指针拒绝、多 question、EDNS）、`records.answer` 判决一致性、注入包构造（校验和、四元组）、Selector verdict 路径（注入失败→ACCEPT、不健康→ACCEPT）。
2. **Linux netns e2e**（复用 `transport_e2e_linux_test.go` 门禁）：真实 NFQUEUE+规则下，tailnet 查询收到注入应答、公网查询字节级透传到真实上游、helper 死后 bypass 生效。
3. **Shell 回归**（`tests/test_dns_hijack.py`，对照 `test_dns_modern.py` fixture）：探测缓存/降级、规则装拆与幂等、pref claim/restore、guard 死亡撤规则、状态机各 reason、与 legacy/transparent 互切。
4. **真机验收**（在已知的 GLUE_CT 缺失 + mark 冲突 + FlClash 共存设备上）：tailnet 全名/短名/PTR 解析正确；公网解析结果与模式关闭时逐字节一致（尤其 FlClash fake-IP 路径）；`accept-dns` 恢复；helper kill 后自动恢复；注入自测确认 SELinux/rp_filter 不拦。

## 实施步骤

1. foxydns：`Selector` + `injectAnswer` + `records.capture`/`answer` 复用 + config mode + `probe --hijack` + health/quiesce 接入。
2. `foxytail.dns-modern.sh`：mode 分支、规则函数参数化、`modern_probe_hijack`、hijack 独立能力缓存与状态 reason。
3. `foxytail.config.sh`/`foxytail.conf`/`settings.sh`/webapi（network、coexist）白名单与透传字段。
4. WebUI：choice+i18n+tunnel-dns 逻辑+置灰逻辑。
5. 测试：`test_dns_hijack.py` + Go 单测/e2e + 真机验收。
6. 文档：`foxytail.conf` 注释、README 双语的 DNS_MODE 表、CHANGELOG。
