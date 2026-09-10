# 代码质量与后台工作量优化：第一批

日期：2026-09-10  
基线：v1.3.0，`5b1dbbca5e59a87609c7871174aba272ba3e8b11`  
分支：`codex/quality-power`  
运行代码与开发构建：`792eb2596a7befa313ee00b6ad242a2abc894350`

## 交付范围

执行计划中的 PR-01 至 PR-04：测量入口、手动停止后的无效采集、DNS 易失心跳快照、日志与统计维护；同时移除 watchdog 的重复状态写入。观测共享、WebAPI 分域、前端资源调度与原生数据通路优化留在后续批次。

这一批的证据支持“减少后台工作”，不支持 Android 省电百分比。代码交付时 ADB 无在线设备；随后用户连接 USB ADB，已完成 [Android 功能验收](2026-09-10-quality-power-device.zh-CN.md)，待机 A/B 和电量测量仍未完成。

## 实现与边界

### DNS 快照

`native/foxydns/config.go` 的唯一 JSON 写入入口改名为 `writeSnapshotJSON`，明确用于可重建的运行态，移除显式 `File.Sync`。保持临时文件加原子 Rename、0600、错误传播与临时文件清理。

2 秒心跳、8 秒新鲜度、监听器关闭、队列健康、PID/身份校验保持原约束。账户偏好恢复日志和持久配置不使用此接口，不随本次修改降低持久性。

### 统计与 watchdog

- 统计和 watchdog 的函数定义分别移入 `foxytail.stats-lib.sh`、`foxytail.watchdog-lib.sh`。原 CLI 继续负责配置、路径和命令分发；测试直接 source 库，不再依靠函数在文件中的排列截取这两个模块。
- 手动停止时 stats 不执行 status RPC，不写 `daemon-unreachable`，不做配置解析、dumpsys 或文件维护。只按已验证的 `STATS_INTERVAL` 检查停止标记；watchdog 不再每轮重复记录同一停止信息，context 自动化保留。
- 已进入暂停分支后，启动在下一个普通采样周期恢复。若停止/启动发生在先前息屏 ×5 的 sleep 中，仍可能等待该 sleep 的余量；本批不新增信号唤醒协议，也不声称即时采样。
- 保留期清理在首个采样、跨日时执行，失败后按一小时重试。每个日期文件首次使用时修正 0640，删除后重建同样修正；正常采样不重复 chmod。
- 只有完整的已应用路由快照能用于跳过不存在的 UID 统计 family，不以尚未应用的 IPV6 配置推断实际规则。接口计数读不到时记 null；预期 family 查询失败时整份 UID 统计记 null，避免单栈部分计数被误当成重置。
- 跨小时/跨日仍按区间结束样本归属，代际变化仍重置计数基线，缺失 UID 样本不覆盖此前基线，零流量继续是有效样本。
- watchdog 健康轮次不重写零计数，不重复写未变化的默认路由；非 Running 状态只在变化时诊断。默认 30 秒完整检查、三次无响应恢复、恢复限速和冷却规则不变。
- `screen_state` 明确输出 on/off/unknown，多显示器有任一个活动显示时按 on，未知格式采用普通周期。

### 日志维护

新增 `foxytail.log-lib.sh`，只在两个配置文件内容发生变化时，持公共锁重新验证并读取。无变化不重复解析，非法版本只诊断一次，后续修复可恢复。

可用事件路径由一个 `inotifyd` 输出事件给驻留 Shell，按 2 秒窗口合并，不按每次写日志执行一个回调脚本；静止时每 30 秒兜底扫描。缺少事件能力或 watcher 失效时保留原来的 2 秒容量检查。日志容量保护继续独立于 watchdog。

事件 FIFO 放在非递归监听的 pids 子目录，防止 watcher 写输出触发自身事件循环；退出关闭管道并有界终止、回收子进程。日志仍使用 copytruncate 保留活动写入描述符。并发轮转拿锁后重新读取文件大小，防止第二个轮转者覆盖刚产生的备份。

事件丢失或 watcher 失效到被发现之间，容量检查可能等待低频审计窗口。高写入速率时仍可能在两个检查之间短暂超出容量；本轮不将 LOG_MAX_KB 描述成同步写入硬上限。

### 测量工具与 CI

`tools/perf/` 提供手动、有界、私有输出的 Android `/proc` 采集与离线摘要，不进入模块 ZIP，不由服务启动。记录 PID 代际、可见 CPU/I/O、RSS、可选 PSS、主线程上下文切换和采样条件。完整命令参数、节点名、查询内容和配置内容不写入输出。

短命进程、RPC/exec/Sync 调用次数、硬件唤醒、深睡与能量无法由这套采样推导，明确标记缺失；观察不到不表示零开销。正式息屏实验按工具说明先启动本地采集，再断开无线 ADB。

`verify.sh` 新增 lint/native/backend/web/metadata 分阶段计时与可选局部入口；不传参数仍执行完整门禁。Verify 可取消同分支过时运行，Release 的不取消策略、真实 Linux 内核 strict no-skip 门禁保留。暂不改变依赖缓存策略。

## 前后证据

| 场景与口径 | v1.3.0 | 本批 |
|---|---:|---:|
| macOS arm64，同机 Go 1.27.1，健康快照完整文件写入，5 次基准中位耗时 | 3.822 ms/op | 0.128 ms/op |
| 同基准内存分配 | 51 allocs/op | 51 allocs/op |
| 健康快照显式 Sync 调用路径 | 每次 1 次 | 0 次 |
| 同日 60 次正常采样的 status RPC | 60 | 60 |
| 同日 60 次正常采样的保留期清理 / chmod | 各 60 | 各 1 |
| 手动停止后的连续 3 次 collect 调用：RPC / 错误样本 | 各 3 | 各 0 |
| 60 秒、8 个静止日志、虚拟时钟：配置解析 | 30 | 1 |
| 同上，有事件能力路径：日志文件检查 | 240 | 16 |

快照基准是在 macOS 文件系统上的同步等待耗时，约减少 96.6%；不代表 Android 写放大、硬件唤醒或电量降低。日志用量是基线脚本与候选实际循环在确定性时钟 fixture 中的调用计数。统计对照使用原版 collect 函数与候选库、相同假后端和 60 个样本，核对真实维护调用位置，不把测试耗时当设备 CPU。

复现入口：

```sh
cd native/foxydns
go test -run '^$' -bench '^BenchmarkServiceHealthSnapshot$' -benchmem -count=5
cd ../..
python3 -m unittest discover -s tests -p 'test_logd.py' -v
python3 -m unittest discover -s tests -p 'test_resident_power.py' -v
python3 -m unittest discover -s tests -p 'test_stats.py' -v
bash .github/tools/verify.sh
```

## 验证与后续

本地验证：Go 1.27.1 race/vet、arm/arm64 静态构建通过。最终 Shell/后端/Web/metadata 验证共 231 秒：lint 6 秒、backend 215 秒、web 10 秒、metadata 不足 1 秒。Python 共 177 项，175 通过、两个 Linux 专项在 macOS 按平台跳过；WebUI 26 组 smoke、556 对中英文键、类型/主题校验和产物一致性检查通过。未变化的 native 阶段此前单独通过，耗时 15 秒。

运行代码提交 `792eb25` 的 [GitHub Verify](https://github.com/foxderin/FoxyTail/actions/runs/34381937481) 全部通过：Linux 177 项后端测试无跳过，包含真实 inotify 自反馈回归和完整 `/proc` 采集驱动；26 组 WebUI smoke 通过。独立 strict 内核门禁的 UDP/TCP DNS、原 DNS 转发、socket UID/tuple 与资源清理三项全部执行并通过。CI 验证脚本总耗时 317 秒：lint 14 秒、native 108 秒、backend 177 秒、web 18 秒。这轮冷缓存数据仅用于定位阶段成本，不据此宣称 CI 已显著提速。

验证覆盖快照并发读取/私有权限/编码与替换失败/启动失败释放监听器/运行期心跳错误；统计暂停/恢复/跨日/代际/双栈缺失；日志事件合并与回收；真实 packager 包含新库、完整安装器新装/升级/失败回滚。

开发包从上述提交的独立 git archive 构建，未包含未提交文件。上游摘要、两架构静态 ELF、新库内容、包内 native 摘要和 shipping allowlist 均已检查。模块内部版本仍为 v1.3.0，包名带提交号区分开发快照；没有替换已发布的正式版本或更新 master 的升级地址。

- [完整开发包](/Users/spark/Development/FoxyTail/dist/quality-power-792eb25/FoxyTail-quality-power-792eb25-full.zip)
- [轻量开发包](/Users/spark/Development/FoxyTail/dist/quality-power-792eb25/FoxyTail-quality-power-792eb25.zip)
- [SHA256SUMS](/Users/spark/Development/FoxyTail/dist/quality-power-792eb25/SHA256SUMS)
- [构建说明](/Users/spark/Development/FoxyTail/dist/quality-power-792eb25/BUILD-INFO.txt)

完整包 SHA-256：`ad0aba59fd73d255d6aeb42b4f331fdde314ccb557bf13837b94f493088e0ef2`。

提交拆分：`14b2e5f` 为 DNS 快照；`b3bf5ee` 为测量工具与 CI；`792eb25` 为日志/统计/watchdog 和库及安装回归。后续文档补记不改变开发包运行代码。

下一批优先整理公共配置和状态观测的修订、身份与新鲜度契约，再推进共享读取和 WebAPI 分域。暂不延长 DNS 故障检测窗口，不自动关闭 IPv6、不更换用户模式。Android 设备恢复连接后，先运行服务停止、亮屏/息屏、日志压力、VPN 并存和故障恢复验证，再开展至少三轮交叉 A/B。

## 回滚

DNS 快照优化和测量/CI 分别独立提交，可单独 revert。日志/统计/watcher 库与兼容入口应一并回退，避免入口和库版本混装。安装器升级失败继续使用已有事务恢复旧目录；回退正式 v1.3.0 安装包保留原有用户数据策略。
