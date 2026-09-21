# FoxyTail 耗电审查（2026-09-21）

审查基线：`389b9f9967287fed84db9967d48bbcc06ef9d66c`，v1.3.3。覆盖启动/停止、后台脚本、路由与 DNS、原生 foxydns、WebUI 自动刷新。审查阶段仅增加报告，未修改运行代码或设备配置；下文记录修复前的发现。

后续已按用户要求修复四项：日志大小不变时恢复 30/60 秒检查；UDP 空闲读超时延长至 1 小时并保留主动关闭；失败回滚停止轮询但保留手动重试；等待审批采用普通/省电刷新周期。首次发现或大小变化的半满日志最多额外快速检查一轮。新增回归已确认旧行为失败、新行为通过；实际续航收益仍需真机测量。

修复后使用 Node 22.14.0、pnpm 10.30.3、Go 1.27.1 完成 `bash .github/tools/verify.sh`：245 项后端测试、571 条 WebUI 断言、ShellCheck、Go race/vet、ARM/ARM64 静态构建、版本元数据和 WebUI 产物一致性检查全部通过。本地环境为 macOS，Linux 内核专项与 Android 真机功耗不包含在该结果中。修复计划随 v1.3.4 发布。

**结论：确认两个空闲时仍持续工作的缺陷，以及两个只影响可见 WebUI 的轮询缺陷。默认看门狗还有可量化的后台成本。但目前无法据此确认“严重掉电”的实际主因或电量损失。** ADB 没有连接设备；验证使用隔离 shell、假内核、真实本机 UDP listener 和 jsdom，不是 Android 电流/深睡测试。P2 表示应修复的效率问题，不代表已测得严重续航下降。

## 1. [P2] 静止的半满日志使监控永久进入 2 秒周期

位置：`tailscale/scripts/foxytail.logd:19–22`，循环入口 `:31–33`。

`rotate_all()` 仅根据文件大小判断是否加速：大于上限一半就设置 `_la_interval=2`，超过整个上限才轮转。默认上限 512 KiB，因此任一日志停在 **大于 256 KiB、至多 512 KiB** 时，即使之后完全没有输出，每轮都会继续扫描全部日志，无法回到普通 30 秒或省电 60 秒周期。

隔离复现使用真实 `rotate_all()`、7 个临时日志；仅 `tailscaled.log` 为固定 307200 字节，其余为空。普通、省电模式各连续执行 5 轮：

```text
POWER_SAVE=off intervals=2,2,2,2,2  size_probes=35
POWER_SAVE=on  intervals=2,2,2,2,2  size_probes=35
```

按进程持续运行、忽略每轮执行时间估算，约 1800 轮/小时，比正常和省电空闲周期分别高 **15 倍、30 倍**。7 个日志对应约 12600 次 `wc` 调用/小时，还不包括配置元数据查询与 `sleep`。

修复方向：快速周期需要同时满足“接近上限”和“仍在增长”，连续静止后恢复正常周期；实际超过上限仍立即轮转。现有 `tests/test_power.py` 只验证半满日志进入快速周期，缺少“半满但停止增长”的测试。

这是本次优先级最高的修复点。上述是调度与进程开销；普通 `sleep` 不是唤醒型 alarm，不能把次数直接当作 Android 深睡唤醒次数。

## 2. [P2] 新 DNS 服务没有请求时仍每 5 秒处理 UDP 读超时

位置：`native/foxydns/server.go:219`。

UDP `dns.Server` 设置了 `ReadTimeout: 5 * time.Second`。锁定依赖 `github.com/miekg/dns v1.1.73` 的 `serveUDP()` 把超时视作暂时错误并重新读取，每次 `readUDP()` 又设置一个 deadline。因此启用新 DNS 本地或透明模式后，每个 UDP listener 在零请求下仍会周期性执行超时处理，与 `POWER_SAVE` 无关。

隔离复现直接调用现有 `service.bind()` 创建真实 IPv4 loopback listener，仅用 Reader 包装计数，不发送 DNS 包。5.3 秒内观察到 **2 次 ReadUDP 调用**：初次等待和 5 秒超时后的再次等待。关闭仍正常完成。

单 listener 每运行小时约 720 次逻辑超时，启用双栈约 1440 次；这不是实测硬件唤醒数。默认 `MAGIC_DNS=off` 或旧 `legacy` 模式不走此路径。

修复方向：消除 UDP 的短周期空闲 deadline。最小缓解是只延长 UDP 的 deadline，保留 TCP 请求限时；依赖的 `ShutdownContext()` 会主动设置过期 deadline 中断阻塞读取，不需要靠每 5 秒醒来才能退出。**不能简单删除字段或置 0**，依赖会退回 2 秒默认值；负值也会立即超时。

依赖核对位置：`miekg/dns@v1.1.73/server.go` 的 `ShutdownContext`（418–421）、`getReadTimeout`（455–459）、`serveUDP`（523–542）、`readUDP`（710–722）。

## 3. [P2] 配置试用回滚失败后仍永久每 3 秒查询

位置：`webui/src/pages/SettingsTrial.tsx:46`、`:83`。

`rollback-failed` 与正在执行的试用共用 `active()`，因此失败态仍每 3 秒查询 `trial-status`，即使已开启省电、关闭自动刷新。后端 `tailscale/scripts/foxytail.trial:202–209` 每次先获取配置锁，随后发现失败态并退出；这个状态本身不会自动继续执行 worker。

jsdom 虚拟时间复现：`powerSave=true`、`autoRefresh=false`、`rollback-failed` 时，首轮之后仍 **20 次 trial-status/分钟**；隐藏页面后为 0。

修复方向：区分“阻止开始新试用”的状态与“有工作正在推进、需要轮询”的状态。回滚失败保留错误提示及手动重试，停止周期查询。该项只能解释可见设置页的额外耗电。

## 4. [P2] 等待管理员审批永久沿用启动时的高频刷新

位置：`webui/src/state.ts:95–97`、`:108–113`。

`NeedsMachineAuth` 被归为 `starting`，共享状态轮询因而固定为 5 秒。等待管理员审批可能持续很久，开启省电也不会恢复稳定状态的 30 秒周期。

jsdom 虚拟时间复现：开启省电时，等待审批仍 **12 次 status/分钟**，稳定 `Running` 为 **2 次/分钟**，隐藏后为 0。每次请求会进入实际 shell 状态查询路径，而不是只更新前端显示。

修复方向：等待外部审批采用普通/省电周期；仅真正短暂的启动过程保留快速刷新。该项同样不能解释关闭或隐藏 WebUI 后的耗电。

## 默认后台成本及需进一步测量的路径

### 看门狗每轮执行完整路由检查

`tailscale/scripts/foxytail.watchdog:153–157` 在健康的 bridge 模式每轮查找 HEV 进程，并启动完整 `foxytail.route check`。`POWER_SAVE=off` 时默认亮屏、熄屏都为 30 秒。

复用 `tests/test_network.py` 的假内核，先成功 apply，再清空命令记录后运行真实 route check，结果：

| 条件 | ip | iptables | ip6tables | 合计 |
|---|---:|---:|---:|---:|
| 默认 bridge、all、IPv4、MagicDNS 关闭 | 11 | 6 | 2 | 19 |
| 相同条件、启用双栈 | 11 | 6 | 6 | 23 |

两种情况均未执行网络规则修改。按默认周期，IPv4 仅此部分约 **2280 次命令/小时**，另有 shell 启动、配置加载、锁文件操作、JSON 解析与状态查询。此结果证明工作量，不证明 CPU 时间或电流；假内核命令的运行耗时不代表 Android。

这是功能性的完整性检查，暂不作为逻辑错误。适合把轻量存活检查与完整规则检查分开调度，并用真机验证恢复时延与续航的取舍。现有“quiet watchdog”测试使用 `TS_MODE=proxy; MAGIC_DNS=off`，避开了默认 bridge 的这部分成本。

### 其他次级成本

- **手动停止服务后仍尝试采样：** `foxytail.stats:179–184` 没有像 watchdog 一样检查 `manual-stop`。真实循环隔离运行 3 轮，停止标记存在时仍调用 CLI 3 次、屏幕探测 3 次，默认熄屏间隔 300 秒。可以在手动停止期间跳过采集。场景监控用于随后自动启停，不能同样直接停掉。
- **关闭采样仍保留逐包统计链：** `foxytail.route:243–248` 不读取 `STATS`。假内核确认 `STATS=off` 时仍挂载 `FOXY_STAT` 和 UID 计数规则。大量 UID、高包率时仍有线性遍历开销；现有开关文案只承诺停止采样，因此列作优化机会。
- **透明 DNS 验证成本：** 成功公网 UDP 转发的静态路径累计 7 次 INET_DIAG dump、9 次 route 查询、6 次 `InterfaceByIndex`。应先用 Linux/Android profile 确认占比，再合并可证明冗余的相邻验证；不能直接去掉防止错误选路和身份漂移的校验。本次未执行 NFQUEUE 性能测试。
- **第三方网络进程：** 默认 bridge 经过 HEV 和 tailscaled userspace 网络栈。实际流量、DERP/直连状态、网络不稳定和上游二进制行为仍可能占主导；本仓代码审查无法排除它们。

## 已验证有效的措施

- WebUI 的 `pollWhileVisible()` 在隐藏后清理计时器，并等待请求结束再调度下一次；正常页面没有持续动画循环。
- 新 DNS 健康检查使用本机 loopback 内存响应；未发现健康路径每 2 秒写盘。透明模式的 2 秒故障监控负责撤回拦截规则，不应为了节能直接删除。
- native 未发现明显 busy loop、无界连接积累或无限上游重试；请求和连接有并发及超时限制。
- 原生测试、WebUI 测试不包含真实 Android 锁屏耗电测试；逻辑测试通过不代表功耗已经达标。

## 验证记录与下一步

后端执行 `PYTHONPATH=tests python3 -m unittest test_power test_context test_stats test_dns_modern test_network test_lifecycle`，**100 项全部通过**（182.808 秒）。分别为 power 7、context 26、stats 14、modern DNS 28、network 14、lifecycle 11。通过说明已有功能回归未暴露错误，不能替代新增的空闲效率检查。

审查中的所有复现均在临时目录运行。WebUI 根据当前源码重新构建后执行 `smoke-power`，普通 status/peers/tun 各 4 次/分钟、日志 12 次/分钟；省电各 2 次/分钟；隐藏/关闭自动刷新时普通页面没有定时器。现有 native 非 Linux 测试全部通过，另行完成上述零流量 UDP 复现。

获得设备后，先记录实际版本、已应用配置、各进程 CPU 增量、日志大小与增长情况、网络流量及深睡时间；再在相同网络和使用条件下比较修复前后。若锁屏待机掉电明显，优先检查第 1、2 项及默认看门狗成本；若仅打开管理页面时明显，再检查第 3、4 项；若随传输量增长，重点测量 bridge/透明 DNS 和第三方进程。
