# 第一批优化：Android 实机功能验收

日期：2026-09-10  
设备：OnePlus PLR110，Android 16，KernelSU，FlClash 运行中  
模块运行代码：`792eb2596a7befa313ee00b6ad242a2abc894350`  
构建：`FoxyTail-quality-power-792eb25-full.zip`，模块内部版本仍为 v1.3.0

## 安装确认

用户通过 Taildrop 接收开发包后，手机已经安装该版本。本次用 USB ADB 确认 root，比较 settings、三个 CLI 入口、三个新增库及 arm64 foxydns 的 SHA-256，全部与开发 ZIP 一致，没有重复安装。

验证开始时配置为 bridge、MagicDNS 开启、DNS_MODE=local、IPV6=on、DNS_PORT=1053、STATS_INTERVAL=60、WATCHDOG_INTERVAL=30、LOG_MAX_KB=512。以摘要比较账户身份及三个配置文件，停启前后一致；原生 CorpDNS 在本地 DNS 管理状态下均为 false。

## 实测结果

| 检查 | 结果 |
|---|---|
| Android Shell / 事件工具 | `/system/bin/sh` 接受 `read -t 1` 和 `read -t 0.01`；系统 Toybox 0.8.12 的 inotifyd 支持标准输出模式 |
| 日志事件通道 | logd 重启后只有一个 inotifyd；FIFO 在 run/pids，0600；watcher 的 FD 3 是自身 inotify 描述符，没有继承 FIFO 读端 |
| 日志压力 | 单次写入 512 KiB + 1 字节，约 2.17 秒完成轮转；活动 inode 保持，备份不超过 512 KiB，原写 FD 可继续追加 |
| logd 停止和重启 | 约 0.29 秒退出；旧 watcher 与 FIFO 均清理，新代际重新建立事件监听 |
| 本地 DNS | IPv4 和 `::1` 两个端点的 UDP/TCP、A/AAAA 组合共 8 项均返回当前节点真实地址 |
| 公网名直接请求本地端点 | UDP/TCP 均为 REFUSED，无公网兜底回答 |
| 心跳 | 连续 16 秒、8 次重新读取均为完整 JSON，ready/local/IPv6 就绪，新鲜度满足 8 秒约束；替换后的文件均为 0600 |
| WebAPI 关闭服务 | 约 6.65 秒返回成功；manual-stop 存在，socket、tailscaled、foxydns 退出，自有 OUTPUT 跳转清理 |
| 停止窗口 | 70 秒内统计文件摘要与 153 行计数保持不变；watchdog 没有拉起服务；FlClash 的 tun0 保留 |
| WebAPI 启动服务 | 约 3.27 秒返回成功；同一账户恢复 Running/online，DNS local 监听正常，不要求重新登录 |
| 统计恢复 | 未注入 collect-once，常驻循环自行从 153 行增加至 154 行；新样本无 error，接口和 UID 数据存在，代际更新，0640/root:root |
| 启动后 DNS | IPv4/IPv6 的 UDP/TCP AAAA 再次通过，helper 为新 PID；FlClash 进程持续存在 |

这些时间是单次功能检查的墙钟耗时，不是稳定性能分位数。停止后专门重启 stats，使实际常驻循环进入暂停分支，再跨越一个完整 60 秒周期观察。先前息屏 ×5 sleep 的余量问题仍按第一批报告说明，不能用此次结果保证任意时刻即时恢复采样。

## 日志初始回退的边界

首次连接时 logd 驻留在 2 秒轮询回退路径，没有活动 FIFO。单独重启 logd 后，事件模式恢复，并通过压力、持续运行、停止回收和再次启动检查。没有捕获到首次回退的触发事件，因此不把此次操作描述成已修复开机问题；开机与 watch 失效后的长期恢复仍需后续验证。

## 采集工具的平台修正

新增有界采集器已经在此 Android 上执行，私有输出可离线汇总。首轮 12.34 秒、4 个样本的运行成功，但发现漏记 bridge 数据通路进程：内核 comm 实际为 15 字节的 `hev-socks5-tunn`，预筛选误写为 16 字节字符串。

该问题只在测量工具中，已将候选名按 Linux 的 15 字节限制生成；完整 argv 和安装路径的 maps 验证保留，不能仅凭截断名称把其他模块的同名进程归入 FoxyTail。新 fixture 在旧实现上复现漏采，修复后覆盖自有绝对路径/裸命令，以及异路径、伪造 argv、缺失 maps 的排除。

修正后重新上传采集器，在 Android 上运行 12.28 秒并得到 4 个样本，正常退出；logd、stats、watchdog、foxydns、tailscaled 和 hev-socks5-tunnel 六个组件均被识别，HEV 的 4 次观测全部存在。单轮扫描用时约 0.24–0.38 秒，说明观察工具本身的扰动不能忽略。主机针对性测试 7 项通过、1 项完整 Linux 驱动按平台跳过，lint 通过；手机上的完整驱动另已实际执行通过。

此修正位于不打包的 `tools/perf/`，不改变手机上的模块运行代码，也不需要重新安装模块 ZIP。

## 未证明的内容

- 测试期间 USB powered=true，电量 100%，约 35°C；ADB、查询和日志压力均带来诊断负载。本次不能证明实际省电、深睡比例或硬件唤醒减少。
- 手机没有可用 strace；统计文件不增长并不单独证明零 RPC。停止分支的零 RPC 由源码与已有调用回归保证，本次没有完整跟踪所有短命子进程。
- 没有重新修改 FlClash 的 DNS 配置、测试正式息屏 A/B、物理网络切换、重启手机或账户切换。当前机器的透明模式内核限制沿用此前报告；local IPv6 通过不代表透明 IPv6 拦截已支持。
- WebAPI 返回的既有待重启配置标记保留，未擅自清除。

## 收尾状态

服务恢复 Running，DNS 为 local/1053，IPv6 本地监听正常，stats/watchdog/logd 驻留，logd 使用事件通道。测试生成的临时压力日志已删除；原始诊断数据保存在私有目录，不进入模块包或 Git。后续实际能耗比较仍需独立、无 USB/无线调试干扰的交叉 A/B。
