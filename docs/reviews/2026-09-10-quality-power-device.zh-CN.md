# 第一批优化：Android 实机功能验收

日期：2026-09-10  
设备：OnePlus PLR110，Android 16，KernelSU，FlClash 运行中  
初始安装：`792eb2596a7befa313ee00b6ad242a2abc894350`；本次修复后运行代码：`9c6365b`

更新构建：`FoxyTail-quality-power-9c6365b-full.zip`，模块内部版本仍为 v1.3.0

## 安装确认

用户通过 Taildrop 接收 `792eb25` 开发包后，手机已经安装该版本。本次用 USB ADB 确认 root，比较 settings、三个 CLI 入口、三个新增库及 arm64 foxydns 的 SHA-256，全部与开发 ZIP 一致，没有重复安装。

验收期间发现日志事件解析缺陷，修复后保留原库的私有备份，只原子替换 `foxytail.log-lib.sh` 并重启 logd。设备上的库 SHA-256 为 `1729b0761a21cbc53830012b4e8637e4f32081dfa0414679fca410faff6d9e02`，与新开发 ZIP 完全一致。对两个完整 ZIP 逐文件比较，运行内容仅此库不同；没有重装整个模块或重启手机。

验证开始时配置为 bridge、MagicDNS 开启、DNS_MODE=local、IPV6=on、DNS_PORT=1053、STATS_INTERVAL=60、WATCHDOG_INTERVAL=30、LOG_MAX_KB=512。以摘要比较账户身份及三个配置文件，停启前后一致；原生 CorpDNS 在本地 DNS 管理状态下均为 false。

## 实测结果

| 检查 | 结果 |
|---|---|
| Android Shell / 事件工具 | `/system/bin/sh` 接受 `read -t 1` 和 `read -t 0.01`；系统 Toybox 0.8.12 的 inotifyd 支持标准输出模式 |
| 日志事件通道 | logd 重启后只有一个 inotifyd；FIFO 在 run/pids，0600；watcher 的 FD 3 是自身 inotify 描述符，没有继承 FIFO 读端 |
| 日志压力 | 单次写入 512 KiB + 1 字节，约 2.17 秒完成轮转；活动 inode 保持，备份不超过 512 KiB，原写 FD 可继续追加 |
| logd 停止和重启 | 约 0.29 秒退出；旧 watcher 与 FIFO 均清理，新代际重新建立事件监听 |
| 日志解析修复后复测 | 同等压力约 2.08 秒完成轮转，inode/写 FD/备份上限通过；停止约 0.27 秒，旧 watcher 与 FIFO 清理，新事件通道建立 |
| 本地 DNS | IPv4 和 `::1` 两个端点的 UDP/TCP、A/AAAA 组合共 8 项均返回当前节点真实地址 |
| 公网名直接请求本地端点 | UDP/TCP 均为 REFUSED，无公网兜底回答 |
| 心跳 | 连续 16 秒、8 次重新读取均为完整 JSON，ready/local/IPv6 就绪，新鲜度满足 8 秒约束；替换后的文件均为 0600 |
| WebAPI 关闭服务 | 约 6.65 秒返回成功；manual-stop 存在，socket、tailscaled、foxydns 退出，自有 OUTPUT 跳转清理 |
| 停止窗口 | 70 秒内统计文件摘要与 153 行计数保持不变；watchdog 没有拉起服务；FlClash 的 tun0 保留 |
| WebAPI 启动服务 | 约 3.27 秒返回成功；同一账户恢复 Running/online，DNS local 监听正常，不要求重新登录 |
| 统计恢复 | 未注入 collect-once，常驻循环自行从 153 行增加至 154 行；新样本无 error，接口和 UID 数据存在，代际更新，0640/root:root |
| 启动后 DNS | IPv4/IPv6 的 UDP/TCP AAAA 再次通过，helper 为新 PID；FlClash 进程持续存在 |

这些时间是单次功能检查的墙钟耗时，不是稳定性能分位数。停止后专门重启 stats，使实际常驻循环进入暂停分支，再跨越一个完整 60 秒周期观察。先前息屏 ×5 sleep 的余量问题仍按第一批报告说明，不能用此次结果保证任意时刻即时恢复采样。

## 已修复：半行事件被误判为监听失效

首次连接时 logd 驻留在 2 秒轮询回退路径，没有活动 FIFO。重启后短期恢复，但后续收尾检查再次出现回退，因此继续用临时诊断脚本追踪。

Android mksh 的超时读取可能消耗半行：先写入 `c<TAB>`，`read -t .05` 返回 142；再写入目录和文件名，下一次成功读取的事件字段变成 `/data/adb/foxytail/run`。原实现直接搜索事件字段中的 `x`，把路径中的字母误认为监听移除，主动关闭 FIFO 并杀掉 watcher。

已在该手机用原库确定性复现；又暂停实际 watcher，在真实 logd 主循环的合并窗口注入同样的分段事件，诊断记录确认 `_LD_EVENT_FAULT=1` 导致停止监听。这证明了一个能造成同样回退的代码缺陷；两次未追踪的自然回退没有原始触发记录，不能声称已逐次证明其原因。

修复先校验事件字母表和目录是否精确属于两个监听目录。格式不完整或字段错位时，补做配置与日志检查，不终止存活的 watcher；合法 `x/D/M/u` 仍触发故障回退，`o` 仍触发补查。超时、合并窗口、审计周期和退出回收方式保持原语义。

在正式脚本上重复同一分段注入，logd 与 watcher 的 PID 均未变化，FIFO 保留；直接解析得到 `fault=0/reload=1/scan=1`。新增回归覆盖真实管道超时、主循环持续事件模式、非法字段和真实监听失效。旧实现上新回归失败，修复后主机 logd 测试 19 项通过、1 项 Linux 专项按平台跳过；完整 Shell 语法与 ShellCheck 通过，独立复核的 6 项针对性检查通过。

完成压力与停止回收复测后，从新的正式 logd 代际开始，每 15 秒观察一次，连续 300 秒的 21 次检查均为同一 logd、同一 watcher 和活动 FIFO，没有再次降为轮询。这是有界功能验证，不代表已证明跨重启或长期运行稳定性。修复后的最终 DNS 复测再次覆盖全部 8 种组合，账户及三个配置文件摘要仍与初始状态一致。

## 本地门禁与更新产物

修复提交 `9c6365b` 的完整 `verify.sh` 在主机通过，总耗时 270 秒：Shell 语法与 ShellCheck、Go race/vet、arm/arm64 构建、182 项 Python 测试（180 通过、2 项 Linux 专项按平台跳过）、WebUI 类型/翻译/主题检查及 26 组 smoke、构建一致性和版本元数据检查均完成。

同一运行代码提交的 [Linux CI](https://github.com/foxderin/FoxyTail/actions/runs/34433464699) 已成功：完整 Verify 通过，182 项 Python 测试全部运行，主机跳过的 Linux 测试在 CI 覆盖；独立 strict 内核门禁的三个真实 DNS 检查也全部通过。

按固定 Go 1.27.1 与已审核的上游二进制摘要重新构建轻量包、完整包，分别检查打包内容与修复库一致。完整开发包 SHA-256 为 `1aa20f59bac7fcc87ad38a77ee45ccab87e97d904034f64740f55dbbc45259db`；已通过 ADB 放入手机 `/sdcard/Download/FoxyTail-quality-power-9c6365b-full.zip`，手机端摘要匹配。稳定版 v1.3.0 未重新发布。

## 采集工具的平台修正

新增有界采集器已经在此 Android 上执行，私有输出可离线汇总。首轮 12.34 秒、4 个样本的运行成功，但发现漏记 bridge 数据通路进程：内核 comm 实际为 15 字节的 `hev-socks5-tunn`，预筛选误写为 16 字节字符串。

该问题只在测量工具中，已将候选名按 Linux 的 15 字节限制生成；完整 argv 和安装路径的 maps 验证保留，不能仅凭截断名称把其他模块的同名进程归入 FoxyTail。新 fixture 在旧实现上复现漏采，修复后覆盖自有绝对路径/裸命令，以及异路径、伪造 argv、缺失 maps 的排除。

修正后重新上传采集器，在 Android 上运行 12.28 秒并得到 4 个样本，正常退出；logd、stats、watchdog、foxydns、tailscaled 和 hev-socks5-tunnel 六个组件均被识别，HEV 的 4 次观测全部存在。单轮扫描用时约 0.24–0.38 秒，说明观察工具本身的扰动不能忽略。主机针对性测试 7 项通过、1 项完整 Linux 驱动按平台跳过，lint 通过；手机上的完整驱动另已实际执行通过。

采集器修正位于不打包的 `tools/perf/`，本身不改变模块运行代码；本次更新 ZIP 的运行内容来自前述 logd 修复。

## 未证明的内容

- 测试期间 USB powered=true，电量 100%，约 35°C；ADB、查询和日志压力均带来诊断负载。本次不能证明实际省电、深睡比例或硬件唤醒减少。
- 手机没有可用 strace；统计文件不增长并不单独证明零 RPC。停止分支的零 RPC 由源码与已有调用回归保证，本次没有完整跟踪所有短命子进程。
- 没有重新修改 FlClash 的 DNS 配置、测试正式息屏 A/B、物理网络切换、重启手机或账户切换。当前机器的透明模式内核限制沿用此前报告；local IPv6 通过不代表透明 IPv6 拦截已支持。
- WebAPI 返回的既有待重启配置标记保留，未擅自清除。

## 收尾状态

服务恢复 Running，DNS 为 local/1053，IPv6 本地监听正常，stats/watchdog/logd 驻留。临时诊断 logd 已退出，现使用安装路径下的正式脚本及修复后的库。测试生成的临时压力日志已删除；原始诊断数据保存在私有目录，不进入模块包或 Git。后续实际能耗比较仍需独立、无 USB/无线调试干扰的交叉 A/B。
