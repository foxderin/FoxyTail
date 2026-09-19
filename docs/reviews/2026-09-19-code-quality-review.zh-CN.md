# FoxyTail 代码质量、架构与设计审查报告

日期：2026-09-19

审查基线：`5b1dbbca5e59a87609c7871174aba272ba3e8b11`，版本 `v1.3.0 / 10300`

方法：Ponytail full 简化审计 + 常规正确性、可靠性和工程质量审查

范围：只审查、验证并记录；未修改业务代码、配置、依赖或发布产物。

## 1. 总体结论

**项目已有扎实的防护与交付基础，但故障恢复和状态语义尚未贯穿所有入口。当前最值得投入的是补齐已有机制的调用链，而不是整体重写、引入大型框架或单纯拆小文件。**

本轮确认 **8 项缺陷：1 项 P1、7 项 P2**。最优先的问题是：配置一旦损坏，WebAPI 的日志、停止、恢复与取消入口一并被前置校验挡住，完整停止流程也会在驻留组件处提前退出。其他问题主要集中在锁恢复、取消接入、保存与生效边界、场景规则和未知状态处理。

已有测试全部通过并不与这些发现矛盾：不少后端测试直接提取函数，WebUI smoke 使用模拟桥接；本轮问题恰好分布在脚本入口、多个控制器之间，以及真实后端操作与前端承诺之间。

| 维度 | 判断 | 主要依据 |
|---|---|---|
| 代码正确性 | 主路径受测试保护，失败分支仍有缺口 | 135 项 Python 测试通过；额外隔离探针复现多个遗漏分支 |
| 架构 | 技术分层合理，控制职责和状态契约不够统一 | Shell 编排、Go 内核相关处理、SolidJS 展示的分工合理；多个入口自行决定何时加载、应用和确认状态 |
| 组织形式 | 功能目录清晰，共享代码边界有漂移 | WebAPI 与 settings 职责集中；跨页面工具寄居于业务组件/页面目录 |
| 设计 | 资源归属设计强于操作完成语义 | 路由、进程、DNS 偏好有归属校验；部分成功、取消、未知状态仍不准确 |
| 可维护性 | 可渐进改善，无需大规模迁移 | 最有价值的改动可以落在现有公共函数和少量调用点 |
| 发布保障 | 仓库门禁较完整，本机未完成整个门禁 | Shell/前端/宿主机测试通过；本机缺 Go，未运行原生与真实内核验证 |

优先级含义：P1 表示应优先处理的恢复/控制能力问题；P2 表示明确但触发条件或影响面相对受限的功能与可靠性问题。架构建议和未经设备测量的性能风险不混入缺陷数量。

## 2. 范围与证据边界

审查开始时工作区干净，仓库有 143 个 Git 跟踪文件、30,051 个物理行。这个总量包含测试、文档、锁文件和生成产物，**不能当作业务代码行数**。

本轮重点追踪了以下链路：

- 安装、升级、启动、重载、停机、卸载，以及 watchdog/context/logd/stats 的协同。
- 配置解析、写锁、pending revision、备份恢复、WebAPI 分发及请求级取消。
- bridge/native tun/proxy 模式、路由资源归属、传统和现代 DNS 控制。
- Go DNS 服务、原始连接上下文、路由与套接字校验等生产代码的静态实现。
- WebUI 桥接、共享状态、任务、主要页面、原生控件、构建和 smoke 验证。
- 现有 Python 测试夹具、CI/发布门禁，以及 2026-09-09 审查和后续整改记录。

这不是逐行形式化证明，也不是 Android 全平台兼容性认证。Go 部分本轮仅做静态审查；没有实际执行 root 网络操作、安装卸载、真实断电测试或真机抓包。

历史报告中的配置执行、保留路由表、无掩码 mark、全局模式杀进程和发布顺序等问题，在当前实现中已有针对性整改，本报告没有把旧基线的问题直接当作现存问题重新计数。历史文档曾记录的真机验证，也不等同于本轮对当前 HEAD 的重新验证。

## 3. 当前架构：应保留什么

| 层次 | 主要入口 | 合理的职责 | 当前关注点 |
|---|---|---|---|
| 模块交付 | `customize.sh`、构建/发布脚本 | 候选准备、校验、安装切换、身份保留 | 路径布局与运行时脚本耦合，移动文件需联动打包测试 |
| 总体生命周期 | `start.sh`、`foxytail.service` | 完整组件重载、网络服务串行控制 | 外层入口不能破坏底层已有的失败恢复能力 |
| 驻留控制器 | watchdog、context、stats、logd | 健康检查、网络场景动作、采样和日志轮转 | 需要一致的配置生效与成功确认规则 |
| 网络组件 | route、tun、dns、dns-modern | 组件就绪、资源归属、回滚与清理 | 保留独立组件；收敛重复锁算法和错误传播 |
| 原生 DNS | `native/foxydns` | DNS 协议、NFQUEUE、连接上下文、路由与 socket 操作 | 平台相关复杂性有实际必要，应靠真实 Linux 验证 |
| 管理协议 | `foxytail.webapi.sh` | 命令输入、JSON 输出、操作归属 | 当前混合多种责任，协议能力未被所有命令遵守 |
| WebUI | api/state/tasks + 页面 | 原生桥接、共享读取、会话任务和交互 | 统一未知状态与响应契约，清理旧控件兼容接口 |

值得保留的具体设计：

1. **配置作为数据解析。** 固定键、值域、重复键检查和写入/恢复复用解析器，明显优于重新执行配置文件。F01 的修复不能退回到宽松解析或忽略坏配置继续启动。
2. **网络资源按归属清理。** 路由清理不整表 flush，校验 mark/mask、优先级、协议和设备，失败保留状态。相关实现见 [route_cleanup](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.route:160)。
3. **请求身份和进程身份明确。** operation ID、取消 tombstone、PID/starttime 校验已有价值；问题在漏接入，不在该机制本身。
4. **现代 DNS 的防护不是可随意删掉的复杂性。** 原始 socket/路由上下文校验、并发上限、偏好归属和 guard 服务都有具体运行或隔离目的。不能为了减少行数而删除这些检查或增加未经授权的公共 DNS fallback。
5. **前端依赖总体克制。** SolidJS、轻量导航、共享状态轮询、会话任务已经够用；没有明显理由再增加全局状态框架、路由框架或图表框架。
6. **发布链有可重复性意识。** 固定二进制摘要、白名单打包、标签与版本校验、webroot 一致性检查及 Linux 原生门禁都应保留。

## 4. 缺陷总表

| 编号 | 级别 | 问题 | 证据强度 |
|---|---|---|---|
| F01 | P1 | 坏配置阻断日志、停止、恢复和取消等救援入口 | 真实脚本入口经私有路径重定位后复现；完整停机影响由调用链确认 |
| F02 | P2 | 锁回收器自身不可恢复，可能遗留永久争用 | 配置锁隔离复现；service/DNS 同类实现静态确认 |
| F03 | P2 | 诊断任务未接入已实现的取消机制 | 真实 operation registry + 模拟慢诊断命令复现 |
| F04 | P2 | 声称未生效的设置会被驻留控制器提前读取并协调 | pending 文件存在时，watchdog 仍选择新配置进行 reconcile |
| F05 | P2 | 场景动作失败仍记录为已处理，不再重试 | 同一场景连续两轮，失败动作只执行一次 |
| F06 | P2 | 场景规则末行无换行被跳过，保存/恢复缺少规则校验 | 有效单行规则无末尾换行时执行次数为零 |
| F07 | P2 | tun 停机忽略 down hook 失败，restart 不检查 stop 结果 | hook 返回 9，tun_stop 仍返回 0；restart 调用链确认 |
| F08 | P2 | 后端不可达被出口节点页解释成“当前不使用出口节点” | 当前 WebUI bundle 在 jsdom 中复现错误选中和状态徽标 |

### F01：坏配置阻断救援入口

**位置：** [WebAPI 前置加载](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.webapi.sh:78)、[context 前置加载](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.context:13)、[watchdog](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.watchdog:13)、[stats](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.stats:15)、[完整停止](/Users/spark/Development/FoxyTail/tailscale/scripts/start.sh:45)、[卸载](/Users/spark/Development/FoxyTail/uninstall.sh:12)。

WebAPI 在命令分发前无条件 `load_conf`。因此，只要已有配置不合法，`logs service`、`control stop`、`restore`、`cancel` 都无法进入各自处理器。错误文案要求查看 service log，但同一 WebAPI 的日志入口也被挡住。

watchdog/context/stats 同样先加载配置再分发 `stop`。外层 `start.sh stop` 在 `stop_residents` 失败后直接退出，尚未执行网络服务的 stop。卸载又依赖这个完整停止入口。底层 service、tun 和 DNS 原本部分支持坏配置下清理，外层调用链却绕不过前置失败。

**触发条件与影响：** 配置被手工改坏、迁移不兼容或文件异常后，管理界面的恢复能力下降，完整停机/卸载无法正常继续。不是“任何非法输入都会破坏配置”，也不是“底层服务完全无法通过人工命令停止”。

**隔离结果：** 将运行路径迁入临时目录，设置 `TS_MODE=invalid` 后，三个 WebAPI 救援命令及三个 resident stop 全部返回 1。restore 探针在检查归档路径之前就失败，因此它证明的是分发被阻断，而非归档恢复算法出错。

**最小修复：** 固定路径与进程归属初始化不依赖 desired 配置；先分发，再只在需要配置的启动/应用/业务命令内加载。日志、停止、取消、导入恢复仍校验各自输入。统一修正 sibling 入口，不能只给 WebAPI 的 stop 加例外。

**验收：** 坏 main/routes 配置下，日志可读、请求可取消、完整 stop 能清理已拥有资源、合法备份可恢复；start/apply 仍严格拒绝坏配置；任何清理失败仍阻止卸载删除现场。

### F02：锁回收器自身不可恢复

**位置：** [conf_lock_acquire](/Users/spark/Development/FoxyTail/tailscale/settings.sh:359)、[service_lock](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.service:562)、[modern_lock](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.dns-modern.sh:27)。

三处实现都能识别死亡的主锁 owner，但删除主锁前还要取得第二把回收锁。配置/DNS 使用 `.reap` symlink，service 使用没有 owner 信息的 `.service-reap` 目录。取得回收锁后、删除旧主锁前若进程被杀死或异常中断，回收锁本身不会再被回收。

后续调用持续等待至超时：配置/DNS 的名义重试时长约 10 秒，service 约 60 秒，实际还包含命令开销。这是持久的争用失败，不是一次超时后会自然修好；配置读取也要持有配置锁，影响不限于写操作。

**隔离结果：** 同时放置死亡 owner 的主锁与 `.reap`，`conf_lock_acquire` 返回 1；只移除 `.reap` 后，同一个过期主锁即可自动恢复。探针跳过 sleep 加速重试，未声称测得真实设备等待时间。service/DNS 是相同失效结构的静态确认，未分别做中断注入。

**最小修复：** 三处复用一套经过故障测试的锁算法，保留各自锁域和超时；回收阶段也必须有可确认归属和可恢复语义。如果目标设备稳定提供合适的 `flock`，可优先评估，但不能未经 Android/BusyBox 能力核实就替换。也不能按任意 TTL 删除仍由活进程持有的主锁。

**验收：** 覆盖正常并发、死亡 owner、回收前中断、回收中断、PID 复用，以及慢但存活的持锁者；检查既能恢复，也不会出现两个同时进入临界区的控制器。

### F03：诊断任务无法按 UI 承诺取消

**位置：** [cmd_diag](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.webapi.sh:1066)、[cmd_cancel](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.webapi.sh:181)、[现有 _op_exec](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.webapi.sh:216)、[诊断页 TaskProgress](/Users/spark/Development/FoxyTail/webui/src/pages/Diag.tsx:18)。

`cmd_diag` 直接调用 `timeout 120 ... collect`，没有使用 `_op_exec`，也没有轮询取消标记。取消处理器只向已登记的 `child.*` 发信号；它检查 runner 是否仍活着，但不会信号 runner。因此前端显示取消按钮，并不意味着该命令实际具备取消能力。

**隔离结果：** 保留真实请求注册与取消函数，用私有 `sleep 8` 诊断命令替代设备采集；注册子进程数为 0，取消返回 `operation has not stopped; replacement was not authorized`，runner 仍存活。由于宿主机没有 Linux procfs，探针替代了 starttime 读取，并以真实 `kill -0` 检查探针自己的进程；这不是 Android 信号行为认证。

**影响：** 慢诊断不能立即停止，任务替换不能取得确认。前端等待取消确认的保守设计是正确的，不能通过“直接把 UI 标为 cancelled”掩盖后端仍在运行。

**最小修复：** 可取消长操作统一走已有进程归属执行入口；检查 helper 脚本的子孙进程清理，不能仅杀外层 Shell。类似直接 timeout 的 compat 路径也应核查。确实需要不可中断提交的操作，显式暴露该能力并与 UI 一致。

**验收：** 从真实 WebAPI 入口启动慢采集，取消后确认采集与其拥有的子进程退出、无误杀其他任务、替换只在确认后启动；不可取消提交仍被明确拒绝。

### F04：保存与生效之间没有稳定边界

**位置：** [settings-set 响应](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.webapi.sh:991)、[watchdog 重读配置](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.watchdog:201)、[watchdog 伴随层修复](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.watchdog:144)、[service 重新加载并协调](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.service:104)。

设置保存返回 `saved:true, applied:false, restartRequired:true`，并写入 pending revision。但 watchdog 每轮读取最新文件，并根据它检查/修复 companion layers；没有以 pending 为边界保留原运行配置。service 的 reconcile 路径又读取最新配置。

**隔离结果：** 保存 `DNS_MODE=local` 和 `MAGIC_DNS=on`，保留 pending 文件，在模拟已运行 daemon、DNS 需修复的场景下，watchdog 选择 `reconcile`，使用的已经是新 DNS 设置。探针证明决策与调用链，不代表在本机真正启动了 Android DNS。更直接的例子是保存 `WATCHDOG=off`：下一轮重读会退出，发生在用户显式重启应用之前。

**影响：** 用户看到“仅保存、尚未生效”，实际可能已有部分组件改变，其他组件仍使用旧值。单个全局 pending 标记不足以表达这种混合状态。此处不是 settings-set 可以修改 TS_MODE：该接口已经明确禁止通过它修改模式。

**最小修复：** 先明确哪些键可热生效、哪些必须重启。可热生效项返回真实结果；对必须重启的项，reconcile 应维护已应用设置，或在明确的 apply 边界才切换。若需要快照，只保留协调所需的最小 applied 数据及 revision，不必引入通用状态机框架。

仅让 watchdog 在任何 pending 时停止全部修复也不充分：它会连旧配置下应有的故障恢复一起停掉。还应避免后台异步启动 residents 后就无条件把“已启动”当作“已就绪”。

**验收：** 保存、热应用、完整 reload、失败重试各自有清楚状态；pending 时能按已应用配置恢复崩溃组件；并发新保存不会被旧 reload 清除；页面展示的端口/模式区分配置值和已确认运行值。

### F05：场景动作失败后不再重试

**位置：** [check_once](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.context:114)、[apply_context](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.context:91)、[run_action](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.context:64)。

`check_once` 先把当前 context 写入 STATE_FILE，再执行动作，最后固定返回 0。`apply_context` 也没有汇总多个匹配动作的失败。临时没有 daemon、CLI 超时或启动失败后，下一轮发现 token 未变化，就不再尝试。

**隔离结果：** 固定 `cellular:-` 场景，令动作始终失败，连续执行两次 check；只记录到一次动作，但状态文件已记为 `cellular:-`。

**影响：** “观察到该场景”被当成“该场景动作已经完成”。自动化会一直保持漏执行状态，直到网络场景改变或 watcher 重启。

**最小修复：** 聚合匹配动作结果，只在所需动作成功后记录 applied token，并向上返回失败。已有 20 秒轮询可以承担基本重试；无需新增任务调度框架。多动作部分成功时，要保证重试动作幂等，并避免一个成功动作覆盖前面的失败。

**验收：** 首次动作失败、下次成功时执行两次并最终记录状态；同场景成功后不重复执行；多动作任一个失败不能整组确认成功。

### F06：场景规则输入与执行契约不完整

**位置：** [规则读取循环](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.context:95)、[context-set](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.webapi.sh:1008)、[restore 对 context 的分支](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.webapi.sh:1230)。

规则读取使用 `while IFS= read -r _line`，没有处理 EOF 前无换行的最后一行。文本编辑器和 WebUI textarea 完全可能提交没有末尾换行的文本。与此同时，context-set 只校验 base64 解码，restore 对 `context.conf` 不做语义校验。

**隔离结果：** 内容为 `cellular:-:no-exit-node`、末尾不带换行时，规则被认为存在，但动作执行次数为 0；check_once 仍记录场景。F05 会进一步使这个问题表现为“保存成功、自动化从未执行”。

另外，未知 action 只记日志并跳过；`#` 注释与 `:` 分隔也对 SSID 取值有隐含限制。当前没有一致的保存时反馈。这是功能输入契约问题，本轮没有据此声称存在任意命令执行。

**最小修复：** EOF 读取补上 `|| [ -n "$_line" ]`；保存和恢复共用最小规则校验，检查 trigger、字段和 action，并返回行号。明确特殊字符是否支持及其表示方式，无需升级成通用 DSL。

**验收：** 空规则、仅注释、合法末行无换行、非法动作、缺字段、多条规则以及特殊 SSID 的接受/拒绝行为一致；校验失败不替换旧规则，不报告已经应用。

### F07：tun hook 和 restart 的失败传播不完整

**位置：** [tun_stop](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.tun:122)、[restart 分支](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.tun:185)、[tun_start 快路径](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.tun:83)。

`tun_stop` 保存的是停止 HEV 的返回值，随后执行 down hook 却忽略 hook 的结果，最后仍返回前一个结果。restart 直接依次 stop、sleep、start，不检查 stop 是否成功。它与 service 层已经做到的“stop 失败禁止 restart”不一致。

**隔离结果：** 没有残留 HEV 进程、down hook 返回 9 时，`tun_stop` 返回 0。自定义 hook 若承担额外网络清理，调用方会错误地认为清理成功。

同一设计边界还有一个静态问题：up hook 失败会正确返回失败，但后续 tun_start 在进程和接口仍存在时立即成功返回，不会重试尚未完成的 post-up 工作。是否需要重试或回滚，必须与 hook 的承诺一致。

**最小修复：** 汇总停止和 down hook 的失败；stop 失败时中止 restart；停止未确认时保留诊断/归属信息。明确 up hook 失败后的重试或回滚语义。复用 service 已有的失败优先惯例，不需要新生命周期框架。

**验收：** down hook 失败可见，restart 不继续；up hook 失败不会被下一次快路径掩盖；没有 hook 时保留正常行为。

### F08：未知出口状态被显示成已确认的本地出口

**位置：** [后端 unreachable 响应](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.webapi.sh:312)、[ExitNodes 状态判定](/Users/spark/Development/FoxyTail/webui/src/pages/ExitNodes.tsx:43)、[偏好成功确认](/Users/spark/Development/FoxyTail/webui/src/pages/ExitNodes.tsx:63)、[本地出口选项](/Users/spark/Development/FoxyTail/webui/src/pages/ExitNodes.tsx:220)。

daemon 仍存在、LocalAPI 不可达时，后端明确返回 `ok:true, daemon:"running", backend:"unreachable", exitNode:null`。`ok` 表示成功取得了“后端不可达”这个状态，不代表出口偏好已被读取。

ExitNodes 的 `statusKnown` 只检查有 status、无 statusError、daemon running，忽略 backend unreachable；随后把 null exitNode 映射成空字符串，即“没有使用出口节点”。

**界面复现：** 当前 WebUI bundle 在现有 smoke 的 jsdom/桥接环境中接收上述快照后，本地出口 radio 被选中且未禁用，显示“当前”徽标，未知状态区域不出现。这不是只根据代码推测的文案问题。

如果存在待确认的清除操作，同一判定还可能把不可达响应当作清除成功；这部分由 effect 调用链确认，本轮未单独进行交互复现。

**关联协议问题：** [peers/exitnodes 后端](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.webapi.sh:374) 在读取失败时返回 `ok:true, peers:[]`，把不可读与确实为空混为一谈，削弱页面错误/重试能力。这里是同一类 unknown/null/empty 语义缺口，不另计一项。

**最小修复：** 在现有共享状态层区分“进程已确认存在”和“连接/偏好已确认可读”，出口页复用后一种判定。不可达不能确认清除成功；列表读取失败保留 unknown/error，不伪装为空。不要连带禁止停止已确认存活的 daemon——即使 LocalAPI 坏了，停止/重启仍是必要恢复能力。

**验收：** Running、NeedsLogin、stopped、unreachable、读取失败各有明确显示；只用有效偏好快照确认变更；LocalAPI 不可达时仍可停止已确认存活的服务。

## 5. 架构与组织形式的改进建议

### 5.1 首先收敛协议不变量，再决定是否拆文件

最突出的维护热点：

| 文件/组合 | 当前物理行数 | 为什么需要关注 |
|---|---:|---|
| `foxytail.webapi.sh` | 1,347 | 同时管理请求生命周期、CLI 调用、JSON、配置、恢复、DNS/账户协调和诊断 |
| `settings.sh` | 728 | 配置 schema、CIDR、锁、进程识别、cgroup、日志和等待工具集中 |
| `foxytail.dns` + `foxytail.dns-modern.sh` | 622 + 673 | 传统/现代实现、偏好归属、规则与守护协同；不少复杂度是功能所需 |
| `foxytail.service` | 628 | 生命周期、模式、组件协调、状态展示和独立锁实现混合 |
| WebUI `Settings` / `Routing` | 529 / 498 | 交互、数据请求与运行契约紧耦合，类型边界不够明确 |
| `webui/scripts/smoke.mjs` | 1,558 | 大量顺序场景共享模拟状态，定位和增加跨层用例的成本上升 |

这些数字用于定位，不是“超过 N 行必须拆”的阈值。建议先固定四条不变量：

- 清理、日志与救援不依赖有效的 desired 配置。
- 只有完成的效果能被确认；失败、未知、排队和 pending 不冒充成功。
- 可取消能力与实际进程归属一致。
- 相同锁协议只有一份实现，但不同资源保留独立锁域。

修复后，如果 WebAPI 仍难以独立测试，可先将“请求生命周期/受控执行”和“配置事务/恢复”作为两个候选边界。保留现有命令分发，避免一条命令一个文件。settings 中同样优先减少重复和隐藏依赖，而非先创建庞大的 utils 目录。

文件迁移需要同步 `source`、安装 flatten 布局和发布白名单；这是当前部署模型的真实成本。没有联动打包验证的目录美化不值得做。

### 5.2 类型应约束命令契约，而不仅是页面内部变量

[ApiResult](/Users/spark/Development/FoxyTail/webui/src/api.ts:28) 只有 `ok`、`error` 和开放索引；[parseResult](/Users/spark/Development/FoxyTail/webui/src/api.ts:256) 主要检查 JSON 与 `ok:boolean`。页面大量使用 `as Peer[]`、`as HourSample[]` 等断言，编译器无法检查命令参数和返回载荷是否匹配。

例如 [Traffic](/Users/spark/Development/FoxyTail/webui/src/pages/Traffic.tsx:95) 对 `res.hours` 断言后直接 `.forEach`；一个结构合法但字段类型不对的 JSON 可越过 envelope 检查。这里是边界防御不足，不是声称正常后端一定会返回这种载荷。

建议在现有 `types.ts/api.ts` 增加小型 command map，先覆盖 status、settings、routes、peers、traffic 等真正使用的命令；对外部数据做必要的数组/字段检查，给失败、未知、已保存和已应用清楚类型。复用已有 subnet-routes/backup 的边界处理经验。无需新增 schema 框架，更不必先做全仓库自动代码生成。

### 5.3 共享工具不应依赖业务组件

[copyText](/Users/spark/Development/FoxyTail/webui/src/components/LoginHero.tsx:38) 定义在 LoginHero 内，却被 Settings、Files、Logs、Diag、Account、Tunnel、Peers、Dashboard 使用。复制文本在概念上不应依赖登录展示组件。

[createQueuedRefresh](/Users/spark/Development/FoxyTail/webui/src/pages/tools-refresh.ts:8) 已跨 Account、Files、Serve、Routing 使用，但放在 pages 下。它的合并刷新和卸载语义有价值，不需要重写，只需在后续相关改动时移到非业务的共享位置。

调整这两处是依赖方向修正，不是抽象层扩张。不建议借机新建一套“通用前端基础设施”。不同页面的刷新语义也不必强制同构：全局 status 的变更后读取、会话长任务、轻量页面轮询不是同一个问题。

### 5.4 原生控件已经选对方向，但还残留旧接口负担

[Tabs/Tab](/Users/spark/Development/FoxyTail/webui/src/components/ui.tsx:250) 通过解析 `props.children` 的对象形状提取 label/icon，Tab 直接把 props 断言为 JSX.Element，最后伪造含 `activeTabIndex` 的 Event。当前实际调用只有 [Logs](/Users/spark/Development/FoxyTail/webui/src/pages/Logs.tsx:87) 的两个标签，没有必要维持复杂插槽兼容层。

最小接口可以是 `items`、`value`、`onChange(value)`；或直接在 Logs 使用两个原生 button。保留已有方向键、Home/End、focus 和 ARIA 行为。

[Switch](/Users/spark/Development/FoxyTail/webui/src/components/ui.tsx:187) 同时接受 selected/checked，并给 HTMLInputElement 动态写入 `.selected`。统一使用原生 checked 或显式 boolean 回调即可，避免让调用者认识一个并不存在于 DOM 标准中的属性。

保留原生 dialog/select/input、焦点恢复和无障碍基础；不需要重新引入 Material Web 或另一套组件库。

### 5.5 流量读取有重复聚合成本，但尚不足以支持数据库迁移

[stats_deltas](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.stats:184) 读取保留窗口内 JSONL，用 jq slurp、排序、计算 delta 并保留完整 rows。小时、日、TopN、UID 查询复用正确的 delta 算法，但各次调用会重新扫描。

[Traffic refresh](/Users/spark/Development/FoxyTail/webui/src/pages/Traffic.tsx:199) 同时发起图表、TopN 和 UID 请求，会重复执行窗口聚合。7 天每 60 秒采样约 10,080 条，每 10 秒约 60,480 条；每条还有 peer/UID 数组，实际体积取决于设备和节点规模。这里的数字是样本量估算，不是测得的峰值内存或延迟。

先测完整保留窗口、实际节点规模下的耗时/RSS。如果达到交互或内存瓶颈，优先一次读取同时返回该次刷新所需视图，或复用一个明确版本的聚合结果；控制缓存失效和窗口边界。没有证据时不引入 SQLite、后台索引器或多层缓存。

### 5.6 测试数量不少，关键缺口是跨层边界和故障注入

[ConfigApiTests 夹具](/Users/spark/Development/FoxyTail/tests/test_config_api.py:31) 从 `# --- Helpers` 到 `# --- dispatch` 提取函数，跳过真正入口处的 `load_conf`；这有利于函数测试，但自然看不到 F01。现有锁测试覆盖并发 stale-owner recovery，不等于覆盖回收者中断。

[smoke 桥接](/Users/spark/Development/FoxyTail/webui/scripts/smoke.mjs:120) 提供预设 JSON，[默认 cancel](/Users/spark/Development/FoxyTail/webui/scripts/smoke.mjs:186) 可以直接确认成功；它很好地验证了前端等待确认和替换逻辑，却不能证明每个 Shell 命令真的登记并终止子进程。已有 unreachable 测试保护 Dashboard/ServiceControls，但没有覆盖 ExitNodes 的独立判定。

最划算的补强是复用现有 unittest 和 jsdom：

1. 增加少量真实脚本分发测试，仍只重定位到临时目录，不使用 Android 真实网络。
2. 注入“回收者中断、helper 失败、慢任务取消、pending 未应用、状态不可达”等故障。
3. 给关键协议保存代表性上游载荷，检查 unknown、空值、失败和错误字段类型。
4. 将 smoke 按状态/任务/配置/工具场景逐步隔离共享可变状态；不另起测试框架，也不重复覆盖每个组件的纯展示细节。

## 6. Ponytail 简化清单

以下是复杂度审计，不与上面的正确性缺陷重复计数；排序优先考虑可去掉的机制与重复维护量，不把安全检查算作“冗余”。

- `shrink:` 三套近似锁/回收协议收敛为一个经过中断测试的实现，保留不同锁域与超时；位置：[settings](/Users/spark/Development/FoxyTail/tailscale/settings.sh:359)、[service](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.service:562)、[DNS](/Users/spark/Development/FoxyTail/tailscale/scripts/foxytail.dns-modern.sh:27)。
- `native:` 删除 Tabs 对 JSX 对象形状的猜测、伪 Event 和伪 Tab 元素，改为显式数据加原生按钮；统一 Switch 的 checked 语义；位置：[ui.tsx](/Users/spark/Development/FoxyTail/webui/src/components/ui.tsx:187)。
- `delete:` 删除未使用的 `@material/material-color-utilities` 直接依赖；全仓库搜索未发现调用，主题生成脚本现在只使用 Node fs 与静态色板；位置：[package.json](/Users/spark/Development/FoxyTail/webui/package.json:17)、[generate-theme.mjs](/Users/spark/Development/FoxyTail/webui/scripts/generate-theme.mjs:1)。它未进入当前业务 import 图，不能把删除依赖声明宣传成显著 bundle 瘦身。
- `delete:` 删除 Peers 中未使用的 Card import，并考虑将 unused 检查加入已有类型门禁；位置：[Peers.tsx](/Users/spark/Development/FoxyTail/webui/src/pages/Peers.tsx:16)。额外编译检查只发现这一项，不支持“仓库遍布死代码”的结论。
- `yagni:` 当前无需通用控制器框架、全局状态框架、规则 DSL、数据库化统计或每命令一个文件；先完成已确认故障的最小修复和验收。

`net: -2 lines, -1 deps possible.` 这是静态可明确定位的保守下界：1 行 unused import + 1 行直接依赖声明；未计算 lockfile 变化，也没有凭空估算锁和控件重构后的净行数。上述建议均未自动实施。

## 7. 本轮验证结果

| 检查 | 结果 | 边界/说明 |
|---|---|---|
| Python unittest discover | **135 项通过**，约 179.5 秒 | 使用临时目录与模拟平台命令，不等于真机网络验证 |
| ShellCheck，severity=warning | 通过 | 运行 Shell 与 `.github/tools` 脚本未报告 warning |
| WebUI typecheck | 通过 | 使用仓库现有 tsconfig |
| 额外 noUnusedLocals/noUnusedParameters | 1 项 TS6133 | Peers 的 Card import 未使用；不是现有 typecheck 门禁失败 |
| i18n | 通过 | zh/en 各 556 键，0 重复、0 空值 |
| 主题生成一致性 | 通过 | 静态 theme tokens 与生成源一致 |
| WebUI smoke | 通过，`SMOKE OK` | 13 路由、桥接、状态与任务等已有场景；后端为模拟 |
| 临时生产构建 | 通过 | JS 256.80 kB / gzip 77.99 kB；CSS 58.34 kB / gzip 10.98 kB |
| 重建产物与 webroot 比较 | 逐文件一致 | 未修改或更新 webroot |
| 版本元数据检查 | 通过 | `v1.3.0 / 10300` 一致 |
| 额外 Shell 故障探针 | 预期缺陷全部复现 | 私有 fixture、无设备网络修改；摘要见下一节 |
| 额外 ExitNodes 界面探针 | 错误状态复现 | 使用当前 smoke bundle 与 jsdom |
| Go test/race/vet、原生交叉构建 | **未执行** | 本机无 Go 可执行文件 |
| native-notices --check | 未完成 | 因缺少 Go 退出，不是已证实的仓库 notices 不一致 |
| 真实 Linux NFQUEUE/路由/socket 验证 | 未执行 | 本机 macOS；仓库已有对应 Linux 门禁不代表本轮运行过 |
| Android 安装/升级/停机/卸载、多管理器实测 | 未执行 | 需在授权测试设备验证 |

工具链限制：本机 Node 为 `v26.8.1`，而项目约束为 `>=22.12 <23`、固定工具链使用 Node 22.14；前端命令出现 engine warning。项目 pnpm 使用 `10.30.3`。因此应准确表述为“本机执行的上述前端检查通过”，不能表述为“已在指定 Node 版本完成全部门禁”。

[统一 verify 入口](/Users/spark/Development/FoxyTail/.github/tools/verify.sh:1) 包含 Go 检查等更多步骤。本轮由于环境限制分项运行可执行检查，**未声称整个 verify.sh 通过**，也未为审查擅自安装全局工具链。

## 8. 隔离复现摘要

所有 Shell 探针均在私有临时目录内运行：复用现有 ConfigApiTests 的路径重定位夹具，必要时提取当前函数或复制真实分发入口；平台服务、诊断和健康状态由小型替身提供。没有对 `/data/adb`、真实应用 cgroup、路由表或用户进程实施修改。

记录到的关键输出：

```text
invalid-config: webapi logs service / control stop / restore 均 rc=1
invalid-config: watchdog stop / context stop / stats stop 均 rc=1

stale-reaper rc=1
same-stale-lock-without-reaper recovers

failed-context-action attempts=1 recorded=cellular:-
context-final-line-without-newline attempts=0

failed-down-hook tun_stop-rc=0

pending-config-watchdog action=reconcile dns-mode=local magic-dns=on pending=yes

diag-cancel registered-children=0 runner-alive=True rc=1
error="operation has not stopped; replacement was not authorized"
```

ExitNodes 探针保留当前应用 bundle 和 smoke 桥接，只将响应改为 daemon 存活、backend unreachable、exitNode null，结果为：

```json
{
  "backend": "unreachable",
  "localSelected": true,
  "localDisabled": false,
  "localCurrentBadge": true,
  "unknownStatusPanel": false
}
```

这些探针目前验证“缺陷仍存在”，不是已修复后的通过测试；后续修复应将断言反转为正确行为，并选取必要场景纳入现有测试。临时探针路径为 `/tmp/foxytail-review-20260919.IOFnwV/reproduce.py` 与同目录 `probe-exitnodes.mjs`，供当前工作会话追溯；它们不是受版本管理或永久保存的交付依赖。

## 9. 建议整改顺序与验收门槛

| 顺序 | 范围 | 完成标准 |
|---|---|---|
| 1 | F01 救援入口 | 坏配置仍可日志、取消、完整 stop 与恢复；非法 start/apply 仍被拒绝 |
| 2 | F02 锁恢复、F03 取消、F07 停止失败 | 中断不遗留不可恢复锁；取消拥有真实退出确认；失败 stop 不继续 restart |
| 3 | F04 保存/生效、F08 unknown 状态 | 运行状态不由 desired 文件猜测；不可达不当作清除成功或空列表 |
| 4 | F05/F06 场景规则 | 合法 EOF 行执行，非法规则保存前拒绝，动作失败可重试且不误确认 |
| 5 | 小型组织与类型清理 | 去掉无用依赖/import、旧控件协议；先覆盖核心 API 类型和实际响应边界 |
| 6 | 性能与拆分决策 | 先测 7 天真实规模聚合成本，再决定共享读取；模块拆分同时通过打包验证 |

设备验收至少应覆盖：三种模式、daemon 不可达、坏配置、双会话保存/取消、前后台管理器切换、DNS companion 崩溃恢复、带失败 hook 的停机、网络场景动作首轮失败，以及升级/禁用/卸载后的资源归属。

**最终建议：先把“能恢复、能确认、能停止”做完整，再扩展功能。保留现有 Shell + Go + SolidJS 架构，以修复共享机制和真实入口测试为主；不要把一次可靠性整改扩张成全项目重构。**
