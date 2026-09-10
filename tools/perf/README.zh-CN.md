# Android 工作量采集

此目录提供手动诊断工具，不进入模块安装包，也不由服务启动。已在 OnePlus PLR110 / Android 16 上完成有界采集和离线摘要的 [功能验证](../../docs/reviews/2026-09-10-quality-power-device.zh-CN.md)，**尚无实际能耗 A/B 结果**。

`collect-android.sh` 在指定时间内读取 `/proc`，输出私有 TSV；`summarize.py` 在电脑离线汇总。采集器不导入生产 settings，不读取账户状态、VPN 配置、DNS 查询或日志，不修改路由、VPN、root 权限、休眠和充电参数。命令参数只在内存管道中用于识别进程，不保存完整 cmdline、节点名或密钥。

## 测量范围

| 数据 | 实际口径 |
|---|---|
| 进程身份 | 固定运行目录内的 native 可执行映射、控制脚本及采样时仍存活的子进程；使用 PID + 启动 ticks 区分 PID 复用 |
| CPU | 同一 PID 代际两次观测的 user/system ticks 增量；有 `CLK_TCK` 才换算为秒 |
| I/O | `/proc/PID/io` 的逻辑字符量与内核读写字节计数，不能等同物理闪存写入 |
| 内存 | 单个进程的观测 RSS 峰值；PSS 需显式 `--pss`，不可用记 missing；不是同时刻组件总内存 |
| 上下文切换 | `/proc/PID/status` 的**主线程**计数，不是全线程总量 |
| 实验信息 | 操作者声明的源码构建、场景标签、Android 构建、型号、内核、周期、实际扫描时间；配置条件在实验笔记记录 |

短命 exec、每类外部命令调用次数、status RPC 次数、Sync 次数、全线程上下文切换、硬件唤醒、深睡和能量均明确为 **missing**。两次采样之间出生并退出的进程会遗漏；进程退出前最后一段 CPU/I/O 也会遗漏；没有捕获到进程不能解释为零开销。权限限制会降低覆盖范围。

工具每轮扫描进程；对少数候选进程启动 `tr` 解码 NUL 参数，以兼容 Android BusyBox awk。采集本身的 CPU/I/O 未扣除，`samples.tsv` 只记录扫描耗时。PSS 读取和较短周期会增加测量扰动。报告应先称为“观测到的后台工作量变化”，不能据此声称省电百分比。

## 运行一次离线实验

需要设备 root、`awk` 或 `busybox awk`，以及 Android 的 `getprop`。工具不会自动安装依赖。缺少依赖、未给时长/场景/构建或目标目录已存在都会拒绝启动。持续时间为 1–43,200 秒，采样周期为 5–300 秒，默认 15 秒；默认不开 PSS。

先确认 `adb devices -l` 中的目标序列号。下面所有命令的 `SERIAL`、提交号和场景标签均需替换为本次实验值。输出选择新的目录，避免覆盖基线。场景标签只用字母、数字、点、下划线、连字符，不填私人设备名或域名。

```sh
adb -s SERIAL shell su -c 'mkdir -p /data/local/tmp/foxytail-perf'
adb -s SERIAL push tools/perf/collect-android.sh tools/perf/snapshot.awk /data/local/tmp/foxytail-perf/
adb -s SERIAL shell su -c 'mkdir -p /data/adb/foxytail-perf'
adb -s SERIAL shell su -c 'umask 077; nohup sh /data/local/tmp/foxytail-perf/collect-android.sh --duration 1800 --interval 15 --label baseline-local-screen-off-r1 --build COMMIT_SHA --output /data/adb/foxytail-perf/baseline-r1 > /data/adb/foxytail-perf/baseline-r1.collector.log 2>&1 < /dev/null &'
adb -s SERIAL shell su -c 'cat /data/adb/foxytail-perf/baseline-r1/metadata.tsv'
adb disconnect SERIAL
```

启动后确认 metadata 已生成且日志没有错误，正式息屏窗口断开无线 ADB。`adb disconnect` 只断开该调试连接，不保证系统关闭无线调试广告；A/B 两边保持相同调试设置。如果可以手动关闭无线调试再在结束后打开，需在笔记中记录，并让两组条件一致。

定时按 `/proc/uptime` 检查到期，包含系统休眠时间；深睡期间不会为采集持有 wakelock，因此采样间隔可能拉长、最终退出可能延迟到设备再次被调度。没有硬件准时唤醒保证，不得用采样间隔推断深睡。TERM/INT 会结束采集并记录退出码。若未正常结束，保留不完整文件并如实标记。

实验结束后重新连接，直接通过 root 标准输出拉取文件；不把包含设备构建信息的原始文件放到公共 Download 目录：

```sh
mkdir -m 700 baseline-r1
adb -s SERIAL exec-out su -c 'cat /data/adb/foxytail-perf/baseline-r1/metadata.tsv' > baseline-r1/metadata.tsv
adb -s SERIAL exec-out su -c 'cat /data/adb/foxytail-perf/baseline-r1/processes.tsv' > baseline-r1/processes.tsv
adb -s SERIAL exec-out su -c 'cat /data/adb/foxytail-perf/baseline-r1/samples.tsv' > baseline-r1/samples.tsv
python3 tools/perf/summarize.py baseline-r1 > baseline-r1/summary.json
```

检查 `exit_status=0`、时间覆盖、样本数和缺失字段。基线与候选至少各三轮，交叉顺序运行，相同场景保持相同采集周期、PSS 开关、网络信号范围、VPN 模式/配置、亮屏/息屏、充电状态、电量和温度区间。单独记录服务停止、local 亮屏/息屏、各 WebUI 页面、DNS 固定负载与固定吞吐场景，不能混成一个总平均值。

真正的 mWh/h、唤醒与深睡验证需要另选设备确实支持的电量计/Perfetto 等数据源，并评估精度及诊断扰动。本工具不将缺少这些数据的实验称为已完成能耗验收。透明模式需要兼容设备，local 模式结果不能替代。

## 主机验证入口

```sh
python3 -m unittest discover -s tests -p 'test_perf_collector.py' -v
bash .github/tools/verify.sh lint backend
```

`verify.sh` 支持 `lint`、`native`、`backend`、`web`、`metadata`，可组合运行；每阶段输出耗时、通过/失败和总退出码。不传参数或传 `all` 仍执行全部原有检查，发布必须跑完整门禁。真实 Linux 内核验证仍在独立 CI job，以 strict no-skip 执行；本地按其原入口 `.github/tools/verify-native-linux.sh` 运行。

Verify 允许同仓库同分支的过时运行取消；fork、tag 和不同分支使用独立并发组。Release 未修改。当前 Go 缓存维持关闭，也未引入路径过滤或移除任何检查；先根据阶段计时决定是否需要进一步的可验证缓存。
