# FoxyTail

**在 Android 上以 Magisk/KernelSU 模块运行的 Tailscale mesh VPN** —— 原生 `tailscaled`、三种运行模式、策略路由、流量分析、MagicDNS 分流、代理共存、看门狗与网络场景；普通 Android 应用负责完整控制面，root 模块独立负责网络生命周期。

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
| 流量分析（`foxytail.stats`） | ✅ | JSONL 环形存储，默认保留 7 天（`STATS_RETENTION_DAYS`），熄屏自动降频 |
| MagicDNS 分流（`foxytail.dns`） | ✅ | 内置通用 DNS 端点，可选透明共存；保留旧 dnsmasq 模式 |
| IPv6 双栈 | ✅ | `IPV6=on`，ip6tables 对称规则 |
| 共存探针（`foxytail.compat`） | ✅ | 识别 Clash/mihomo、AFWall+、NetGuard |
| 看门狗（`foxytail.watchdog`） | ✅ | 崩溃自动拉起 + 网络切换 rebind |
| 网络环境感知（`foxytail.context`） | ✅ | 按 Wi-Fi SSID / 蜂窝执行规则 |
| 一键诊断包（`foxytail.diag`） | ✅ | tar.gz 输出到 `/sdcard/Download` |
| 管理器开关联动 | ✅ | inotify 监听 disable 标志 |
| Android 控制应用 | 已实现 | 登录/账号、服务、设备、出口、路由、DNS、流量、Serve/Funnel、场景、试运行、诊断及备份恢复 |
| Taildrop 批量传输与持久历史 | 已实现 | 文件浏览、真实字节进度、取消与仅重试未成功项 |
| Android 应用 `dev.foxderin.tail` | 已实现 | Android 8.0+；中英界面、系统主题/语言、系统分享和 SAF |
| light/full 双 zip、`update.json` OTA | ✅ | |

## 安装

[Releases](../../releases) 页面发布两种包：

- **`FoxyTail-<version>.zip`（light 轻量包）** —— 安装时从固定的上游 release 下载 `tailscaled`、`jq`、`hev-socks5-tunnel`，并按 `checksums.txt` 逐个 SHA256 校验。安装过程需要联网。自研 `foxydns` 已随轻量包内置。
- **`FoxyTail-<version>-full.zip`（full 完整包）** —— 内置全部二进制，可离线安装。内置二进制同样做 SHA256 校验，被篡改的 zip 会被拒绝。

在 Magisk Manager、KernelSU Manager 或 MMRL 中刷入任一 zip，然后重启（重启前可使用安装器打印的绝对路径命令）。

要求：arm 或 arm64 设备，Magisk v20.4+ 或 KernelSU ≥ 10670。升级时保留你的状态、配置与钩子文件（见下文）。

两种包均内置 ARM/ARM64 的 `foxydns` 和 `foxyfiles`，按随包 native 清单校验。开机先由模块根目录的稳定代码恢复中断升级，再加载可替换的 settings/scripts；仅恢复与备份所有权一致的事务。记录无法证明或恢复失败时保留日志与备份、推迟启动，不猜测恢复对象。

签名 APK `dev.foxderin.tail` 作为独立发版产物（`FoxyTail-<版本>.apk`，纳入 `SHA256SUMS`），不再打进模块 ZIP。请在 Android 中自行安装或更新；模块不再触碰 App 安装。v1.6.0 起停用开机自动安装器：App 是 `/data/app` 下的普通用户应用，KernelSU 卸载模块永远不会影响它。首次使用请在 Magisk/KernelSU **单独允许 FoxyTail 的 root 权限**；ADB 获得 root 不等于 App 获得 root。应用不会自动改写 root 授权或全局隐藏设置。

已在 Android 16/OPlus + ReSukiSU 真机确认 v1.4.0 故障原因：桌面和 App 的挂载命名空间缺少 systemless APK，资源读取 ENOENT；ADB namespace 中权限正常并不能证明 App 可读。修复安装脚本已通过同签名 `pm install -r` 在该机更新，网络服务保持运行；不为此修改全局卸载模块策略。

**配套应用**：升级模块，并从同一发版页手动安装配套签名 APK，然后重启；不清除 Tailscale 身份、配置或文件。管理器 WebUI 及其任意命令 JS 桥保持停用；App 自带离线 Web 界面，从桌面 FoxyTail 打开，CLI 救援入口仍保留。App 最低 Android 8.0，并需要更新的 Android System WebView（Chromium 109+）；旧系统只保留模块 CLI。不同签名 debug App 需由用户先卸载，模块不会替用户删除数据绕过签名检查；不兼容协议会禁用 App 写操作。

## 卸载与重装

从 Magisk/KernelSU 移除模块时会执行 `uninstall.sh`：停止所有 FoxyTail 组件、拆除路由/DNS 链、删除 `/data/adb/foxytail`——**但 Tailscale 身份不会丢**。删除前 `tailscaled.state` 会先备份到 `/data/adb/foxytail-state.backup`；下次安装时若尚无状态文件，安装器会自动恢复该备份（并打印提示），重装后仍是原节点、保持登录。如需全新身份，手动删除 `/data/adb/foxytail-state.backup` 即可。

普通安装的附属 App 不随模块卸载自动删除，避免丢失 App 数据；移除模块后 App 会报告模块不可用，可由用户在系统设置中单独卸载。

## 快速上手

```sh
su -c 'tailscale login'            # 打印登录 URL，用浏览器打开完成登录
su -c 'foxytail.service status'    # 彩色摘要查看运行状态
```

刷入后首次重启之前，命令还没挂上 `PATH`。请使用安装路径，并为 Tailscale 显式指定模块的私有 socket：

```sh
su -c '/data/adb/foxytail/bin/tailscale --socket=/data/adb/foxytail/run/tailscaled.sock login'
su -c '/data/adb/foxytail/scripts/foxytail.service status'
```

安装器不再在 `/dev` 创建命令快捷方式。成功升级和卸载时，仅清理仍精确指向 FoxyTail 目标的旧软链接，保留其他同名条目；重启后的 systemless `system/bin` 命令入口保持不变。

常用扩展：

```sh
su -c 'foxytail.exitnode set <节点ID或IP>' # 协调出口偏好与本地接管规则
su -c 'foxytail.service mode tun'          # 切换运行模式并重启
```

## CLI 参考

所有入口位于 `/data/adb/foxytail/scripts/`，重启后软链进 `system/bin`。

| 命令 | 子命令 | 用途 |
|---|---|---|
| `foxytail.service` | `start` `stop` `restart` `status [summary\|peer\|exit-node\|all]` `log [daemon\|service]` `mode [bridge\|tun\|proxy]` `help [all]` | tailscaled 生命周期、彩色状态、模式切换 |
| `foxytail.tun` | `start` `stop` `restart` `status` | hev-socks5-tunnel → `tailscale0` 接口（bridge 模式）；调用 `foxytail.tun.up` / `.tun.down` 用户钩子 |
| `foxytail.route` | `apply` `teardown` `reload` `status` | 幂等策略路由引擎（`FOXY_*` 链、表 1052、fwmark `0x40000000/0x40000000`） |
| `foxytail.exitnode` | `set <节点ID或IP>` `clear` `status` | 协调账户出口偏好与实际模式/UID 范围的路由 |
| `foxytail.dns` | `start` `stop` `status` | MagicDNS 本地端点、透明共存和旧 DNS 控制 |
| `foxytail.stats` | `start` `stop` `status` `collect-once` `query [summary [日期]\|hourly <日期>\|daily\|topn <n>\|uids <n>]` | 采样、按时间顺序流式聚合统计 |
| `foxytail.watchdog` | `start` `stop` `status` `check-once` | 崩溃重启、Android 默认网络变化后 rebind（有限频） |
| `foxytail.context` | `start` `stop` `status` `check-once` | SSID / 蜂窝变化时执行 `context.conf` 规则 |
| `foxytail.compat` | `probe` `check` `check-dns-hijack` `suggest` | 探测共存的代理/防火墙/VPN 工具；校验 `FOXY_*` 链是否被清 |
| `foxytail.diag` | `collect [输出目录]` | 一键诊断 tar.gz（默认 `/sdcard/Download`） |

另有原版 `tailscale` CLI（`tailscale` 是指向 `tailscaled` 的软链；裸用时带 socket：`tailscale --socket=/data/adb/foxytail/run/tailscaled.sock …`）。

## Android 控制面

从桌面打开 **FoxyTail**，在 Magisk/KernelSU 单独授予该 App root 权限；不需要管理器提供 WebUI。

- 离线 SolidJS/TypeScript 界面复用原 WebUI 的组件、中英文文案、分组顺序及二进制流量/时间格式。设置页内嵌配置试用、高级场景/钩子和备份恢复；隧道页内嵌逐步解锁的共存向导。
- 显式保存、SAF 和结果未确认反馈沿用当前契约，不恢复管理器打开方式或自动保存流程。Android 持有外观偏好、操作回执和二进制传输；非敏感表单草稿在 Activity 重建后恢复，登录密钥不保存。
- 单个 Android WebView 承载共享服务/任务顶栏、手机五项完整标签底栏和响应式侧栏，支持浅色/深色/跟随系统及系统字号。文件页复用同一外壳，按收件箱 → 发送文件 → 发送记录纵向排列，目录浏览在发送区展开；出口操作位于节点页。关闭 App 不停止模块网络，也不撤销已接受的任务。
- 桥仅向 `https://appassets.androidplatform.net/assets/` 下的 APK 内置页面主框架开放；原生侧校验具名操作与后端参数，不提供任意 shell、远程页面、root HTTP 服务或 App 内 VPN。外部登录链接交给系统浏览器；文件字节和已授权来源 URI 留在原生侧，不进入 JavaScript。
- 服务、配置和账号写操作使用模块持久回执。保存不等于应用；退出码非零仍保留实际状态字段。失联显示未知，不自动重放；提交期拒绝取消，确认未知只清除 App 观察记录，不终止或回滚后台操作。
- 账号切换前如存在活动发送，先在文件历史取消并等待终态；切换后重新读取设备、出口和共存快照。
- 配置备份不包含登录身份。SAF 导入由 App 自身读取授权 URI，私有归档令牌限制为 1 MiB；诊断产物最多 16 MiB，128 个产物保留 24 小时、按需清理，活动恢复源受锁保护。恢复预览必须同时匹配归档和保存配置摘要。
- 协议兼容时，未知服务状态及升级限制下仍保留独立停止入口；取消确认不改变快照显示。写操作结束后必须取得新状态，已有读取不会吞掉这次核验；浏览器与 Headscale 登录同样受兼容写入门禁约束。
- 模式选择、重启及按状态出现的停止按钮保持同一横行，窄屏和放大字号不拆开。轻量服务/设备状态不再等待出口路由深检查；切页返回保留已有行。只读探测及其未知回执不冻结独立读取，写操作仍保留写入门禁和写后核验。
- 设置只在字段修改或冲突时显示保存/重载；路由保存和草稿状态固定在主滚动区外，应用列表有界滚动，selected/bypass 只在 bridge + owner 支持时可编辑，隐藏选择器不丢草稿。试运行在前台按单调时钟估算倒计时，实际到期与回退仍由模块负责。
- 路由后台刷新不再禁用已确认的开关；高级场景规则不等待实时 SSID/网络状态，设置页与内嵌试运行控件共用一次试运行状态读取。
- 流量图支持时段选点与折叠数据表；设备提供内联地址复制、有限节点图及完整可访问列表。总览将出口选中/生效状态与 Tailnet 连接健康分开；日志保留原版紧凑控制区与独立正文卡，诊断新失败或未确认结果不会复用旧“通过”。

固定 Android CLI 直接收件至 `/sdcard/Download/Taildrop`。**导入已接收文件**只复制已完成普通文件到私有收件箱，不等待缓冲模式的 `tailscale file get`，共享原件保留。私有收据去重，排除 partial/deleted 和软链接。若开机共享存储未就绪导致记录缺失，导入前可用当前 daemon 的 LocalAPI 严格确认 direct mode，并在 PID/启动时间/boot ID 前后不变时恢复记录；不凭目录存在推断。daemon 未确认 direct mode 时，仍须解锁并重启 FoxyTail。发送使用稳定节点 ID 与其当前 IP（含 IPv6）。

自动与手动导出保留 Download 现有文件，依次尝试编号至 `-99`，耗尽时失败但不删除私有副本。清空包含受支持的隐藏普通文件，保留收据、目录和不兼容条目。文件名必须为有效 UTF-8、最多 255 字节，不含路径分隔符、ISO 控制字符及内部保留名；导入和列表报告跳过数量，不改名、不删除原件，单个异常条目不再阻断其他文件。App 使用二进制流打开、分享和另存，不再保留 WebUI 的 base64 内联下载接口。

### Taildrop 日常使用

- **共享目录浏览**：文件页可逐层浏览 `/sdcard`，勾选最多 32 个文件（每个 ≤2 GiB），选择实际支持 Taildrop 的节点后发送；单目录最多列出 1000 项并提示截断，不接受外部 Intent 指定 root 路径。
- **Android**：收件箱、发送、历史纵向分区共用一个保留的 Web 页面；各区独立刷新，失败不清除其他区数据或待发选择。系统文件选择器支持多选；文件管理器“分享 → FoxyTail”和传输通知定位到对应分区。分享只打开待发送列表，选择设备并确认后才开始读取与发送。
- **收件**：tailscaled 继续直接接收到 `Download/Taildrop`。导入已完成普通文件后可在私有收件箱搜索、打开、分享、另存、导出到 Download、删除或清空；不等待新文件、不删除共享原件。App 单文件限制为 2 GiB。
- **收件管理**：按最新、最早、名称或大小排序，可跨搜索筛选选择最多 32 个文件；筛选结果超限时不会悄悄只选部分。批量分享先准备全部文件，再以只读 URI 授权打开系统分享；取消或源读取失败会清理已准备副本。批量导出到 Download、删除均走持久回执，逐项报告失败，保留未选择文件；导出不覆盖已有文件。
- **另存为**先打开目标选择器，再读取源文件。选定目标后，私有暂存阶段显示字节进度并允许取消；源文件完整验证后才提交目标，提交阶段禁用取消。目标提供者写入失败会明确报告，但 Android 文档提供者无法保证回滚已写入的部分目标内容。
- **进度与历史**：模块同一时间接受一个批次，逐文件发送。进度取自 tailscaled LocalAPI `OutgoingFiles.Sent`，按唯一文件 ID 和节点 ID 关联；事件不可用时明确显示未知，不估算百分比。本地 URI 暂存进度与网络发送进度分开。仅真实上传 HTTP 成功响应标记完成；失败项保留错误，可以仅重试未成功文件。
- **历史管理**：确认后删除单条已结束记录或清空已结束历史，不删除排队/发送中的记录、原文件、对端副本及私有暂存；删除后不能再从这些记录重试。删除不存在的记录明确报错。待发列表可单独一键清空，不删除任何文件。
- 收件箱每页最多显示 100 项，所有结果均可翻页访问，跨页/筛选选择保留；进度更新保留历史展开详情。返回文件页复用分区未完成读取，不重复排队；切换浏览目录取消旧读取，不锁住导航。
- **后台与取消**：已接受的发送由模块工作进程持有，退出页面、关闭 App 不停止发送；重新打开历史可接管。应用仅工作时运行前台通知，拒绝通知权限仍可在应用内查看或取消。取消是请求，等待工作进程确认；已被对端接受的字节无法撤回。服务停止/升级会先等待工作进程释放所有权。
- **数据边界**：Android 以自身 `ContentResolver` 读取授权 `content://` URI，经 `su` 的二进制 stdin 写入私有暂存，不把大文件放入命令参数，不接受 root 读取外部 Intent 指定的任意路径，也不开放 root HTTP 服务。只读导出 URI 限时 24 小时。已发送暂存立即删除；未使用/失败副本超过 24 小时后在下次 Taildrop 操作时清理，活动任务除外；历史最多保留 100 条，暂存最多 256 项。不会删除原始文件。
- **权限**：不需要“所有文件访问”或相册权限。SAF 与系统分享只授权所选 `content://` 文件，共享目录浏览和接收由已获 root 授权的模块负责；另存使用系统目标授权，对外分享仅授予读取权限。通知权限不授予文件访问。提交收到明确后端失败时显示实际原因；传输失联仍提示结果未知，不自动重发。

App 区分 root 启动失败、授权不足、模块不可读、协议不兼容和真实后端失败；读取设备失败不会显示为已确认的空设备列表。

### Android 构建与签名

`android/` 使用 JDK 21、Gradle 9.7.1（wrapper SHA256 固定）、AGP 9.3.2、SDK `platforms;android-37.0` / `build-tools;36.0.0`；最低 API 26、目标 API 36。版本号直接来自 `module.prop`。前端需要 Node.js 22.12+（CI 使用 Node 24）及 `webui/package.json` 固定的 pnpm 版本。Gradle 在打包前安装锁定的前端依赖，将 `webui/` 构建到 `android/app/build/generated/webAssets`；直接执行 `assembleDebug` 也会构建前端，生成资源不提交仓库。

设置 `JAVA_HOME` 与 `ANDROID_HOME` 后运行 `bash .github/tools/build-android.sh debug dist/FoxyTail-debug.apk`。正式构建把 `debug` 改为 `release`，必须提供 `FOXYTAIL_KEYSTORE_PATH`、`FOXYTAIL_KEYSTORE_PASSWORD`、`FOXYTAIL_KEY_ALIAS`、`FOXYTAIL_KEY_PASSWORD`；缺失即失败，不回退到临时签名。签名文件不入仓库，应离线备份；丢失后不能无损升级已安装应用。CI 仅可信打包任务读取签名 secrets，PR 只构建 debug。

仪器回归：先执行 `android/gradlew -p android :app:assembleDebugAndroidTest` 生成测试 APK，在隔离测试设备安装两者后运行 `adb -s <设备> shell am instrument -w dev.foxderin.tail.test/dev.foxderin.tail.BridgeInstrumentation`。原生侧检查 root 错误/回执、文件名与混合收件箱、二进制、取消、只读导出及内置 WebView 桥边界。前端状态/交互回归使用 `pnpm --dir webui smoke`，其中的原生响应是夹具而非真实网络。实际界面和 root 后端仍需设备 smoke；构建或主机测试不能替代 App UID 授权、OEM 后台限制和真实网络验收。

<!-- 截图占位：docs/screenshots/*.png（待补充，见 Roadmap） -->

## 控制接口与开发

`android/` 是唯一图形控制面。`ControlActivity` 承载内置 SolidJS WebView 页面；`ControlClient` 负责操作身份和结果接管；`RootApi` 负责可信 su、JSON 与二进制管道；`FoxyTailNative` 具名桥校验来源、框架和参数。`TransferService` 仅负责文件准备及观察，不托管网络服务。

所有标签页（包括文件页）都在同一个 `ControlActivity` 内切换到内置 WebView 文档；在途读取、文件选择和非敏感草稿在切页与 Activity 重建时保留；系统分享、文件选择器结果与传输通知统一由该 Activity 接收，非敏感草稿经 `app.drafts` 下发。

模块入口仍为 `/data/adb/foxytail/scripts/foxytail.webapi.sh`：`backend-info` 返回协议与能力；`operation-start <id> <命令> [参数]` 接受受限后台操作；`operation-status <id>` 查询真实终态；`cancel <id>` 请求取消。参数不写回执，认证链接不进入持久任务。回执私有保存，最多 128 项/24 小时，每项结果最多 1 MiB；过期/中断绝不推断成功。

协议仍为 `2`，App 同时要求 `exit-routing` 与 `context-status` 能力，请配套升级模块和 APK。`status` 返回轻量服务状态及 `peerList`；`exit-routing` 独立返回经核验的路由及 `selfId`，旧身份或旧修订响应不合并。`context-get` 返回可编辑规则，不等待 `context-status`。无配置依赖的列表/探测读取不等待配置写锁；依赖配置的读取和写操作保留原有锁与校验。

`artifact-stage/read/delete` 只接受私有 `art-<32位hex>` 令牌和二进制管道，不能读取任意 root 文件；hook 查看只允许两份固定脚本。恢复仍校验双 SHA256，试运行由模块单调时钟负责回退，出口偏好与实际路由分开。场景文本保留原文并明确限制为 48 KiB UTF-8，不静默截断。

隧道页的 SOCKS 检查使用两种模块包均携带的 `foxydns socks-check`，不依赖设备安装 curl，也不要求 App 网络权限。它通过已应用 SOCKS 端口对固定 `https://1.1.1.1/` 发起 HEAD，使用 Android APEX/系统 CA 校验证书，10 秒截止且不跟随重定向。HTTP 2xx/3xx 表示该 HTTPS 路径可达；拒绝、TLS 错误和超时明确失败，不代表 Tailnet、DNS 或其他目标全部连通。

## 验证与发布

开发工具链为 Go 1.27.1、Python、ShellCheck 及上述 Android/Node/pnpm 工具链。运行 `bash .github/tools/verify.sh`，检查 shell、隔离后端回归、native race/vet、Android debug APK 构建、前端类型/文案/主题/smoke、原生校验规则、原生二进制和版本元数据。

CI 对独立 Python 测试模块最多四路并行，保留全部测试及失败状态。Go 与 Gradle 依赖缓存不含签名密钥/发布产物。发版工作流在一次运行内完成验证、打包与发布：模块 ZIP 加独立 APK 产物，全部纳入 SHA256SUMS；native race 与独立 Linux 内核门禁不跳过。

发布前运行 `.github/tools/version-bump.sh`，提交版本元数据后创建版本标签。推送标签触发一条 Release 工作流：验证门禁（shell、后端回归、native race/vet、Android debug 构建）与独立 Linux 内核门禁通过后，同一运行按已审阅的 `tailscale/checksums.txt` 构建并签名模块 ZIP 与配套 APK，连同 SHA256SUMS 一并发布。门禁失败即停止发布，不存在跨运行的产物复用；对现有标签手动触发 Release 走同一路径。

更新依赖时显式运行 `bash .github/tools/build.sh --update-checksums` 生成候选文件，核对上游来源后再审阅、替换并提交；该模式不打包。

设置保存后以 App 的“重启并应用”或 `/data/adb/foxytail/scripts/start.sh reload` 刷新主服务和驻留组件。`foxytail.service restart` 仅重启网络服务层。升级保留接收文件、自备 dnsmasq、配置和身份；切换前停止旧组件，失败保留回滚记录。

服务启动同时验证所属 daemon 与 LocalAPI，残留 socket 不算就绪，`NeedsLogin` 是有效状态。驻留记录和控制锁校验 PID、启动时间、boot ID 与精确命令参数。用户停止与场景 down 各自持有停止状态，场景 up 不能覆盖用户停止，内部重启不创建用户停止记录。身份与 DNS 偏好文件先私有暂存，再完整发布。

**限时试用配置**以保存设置为候选，可选模式覆盖；启动检查通过后在 30–300 单调秒内确认，否则恢复已接受的运行基线。重启使未确认试用过期，以后开机不会重新启用被拒绝但仍保存的候选。出口偏好副作用仅对原账户及仍匹配预期的完整偏好回退，后来的手动选择优先。检查仅覆盖本机就绪，不代表实际目标连通。

恢复预览绑定归档内容及当前保存配置。原生读取器仅允许三个配置文件和两个待审阅钩子，限制为压缩 1 MiB、展开 2 MiB、单成员 512 KiB、16 个物理头；拒绝链接、元数据扩展与尾随归档。暂存受超时监督且可取消；提交阶段通过原子门拒绝取消。恢复、保存与服务控制任务跨页面保留，取消失败不丢失稍后真实结果，可以重试取消但不重复启动破坏性操作。

配置恢复在切换目录前记录事务。进程中断后，下次获取配置锁时先恢复：未提交的事务恢复旧配置，已提交的事务保留完整候选。恢复失败时阻止配置读写并保留记录供重试，不会把配置目录缺失当成默认设置；已应用运行快照保持独立。

## 配置

`/data/adb/foxytail/conf/` 下三个文件，**仅在不存在时安装**——你的修改在模块升级后保留。

### `foxytail.conf`（主配置）

| 键 | 默认值 | 含义 |
|---|---|---|
| `TS_MODE` | `bridge` | `bridge`（userspace + socks5 + hev → tailscale0）· `tun`（原生 TUN，需 `/dev/net/tun`）· `proxy`（仅 socks5） |
| `SOCKS_PORT` | `1099` | tailscaled 本地 socks5 端口 |
| `DNS_PORT` | `1053` | 本地 DNS 端口；必须与其他解析器错开 |
| `DNS_MODE` | `legacy` | `legacy` 旧模式 / `local` 本地端点 / `hijack` 端口劫持 / `transparent` 透明共存 |
| `MAGIC_DNS` | `off` | 启用所选模式的 Tailnet 域名解析 |
| `IPV6` | `off` | tailscale0 双栈 + ip6tables 对称规则 |
| `ROUTE_TABLE` | `1052` | 固定独立策略路由表，外部资源冲突时拒绝应用 |
| `FWMARK` / `FWMARK_MASK` | `0x40000000` | 固定共享标记位；旧 0xF7 配置读取时迁移 |
| `WATCHDOG` / `WATCHDOG_INTERVAL` | `on` / `30` | 崩溃重启 + rebind，检查间隔秒数 |
| `WATCHDOG_RESTART_LIMIT` / `WATCHDOG_RESTART_WINDOW` | `5` / `600` | 窗口（秒）内允许的重启次数，达到上限后进入冷却 |
| `WATCHDOG_COOLDOWN` / `WATCHDOG_BACKEND_BAD_LIMIT` | `300` / `3` | 冷却秒数；连续无应答轮次达到该值后触发重启 |
| `WATCHDOG_PROBE` | `on` | 网络切换后的主动连通性探测；节能模式下暂停 |
| `POWER_SAVE` | `off` | 节能模式，降低可选后台功能与 App 的刷新频率 |
| `STATS` / `CONTEXT` | `on` / `on` | 独立控制流量采集与场景自动化；关闭保留数据和规则 |
| `WEBUI_AUTO_REFRESH` | `on` | 保留已有磁盘键；控制 App 普通页面自动刷新，关闭后仍可首次加载与手动刷新 |
| `STATS_INTERVAL` | `60` | 流量采集间隔（熄屏自动降频） |
| `STATS_RETENTION_DAYS` | `7` | 流量样本保留天数（JSONL 环形） |
| `CONTEXT_INTERVAL` | `20` | 场景检测间隔（熄屏自动降频） |
| `LOG_MAX_KB` | `512` | 日志轮转阈值（保留一个 `.bak`） |

`CONTEXT_INTERVAL`、`STATS_RETENTION_DAYS` 与 `WATCHDOG_*` 恢复限额属于高级文件级选项：编辑 `foxytail.conf` 后重启生效；App 设置页不暴露这些选项。

### 功耗控制

在 App **设置 → 节能与后台** 中选择节能模式或独立开关，保存后点击 **重启并应用** 生效。升级保留现有功能默认启用；节能模式不会打开已关闭的功能。关闭看门狗会停止自动故障恢复，关闭场景自动化会停止执行 SSID/蜂窝规则。

| 功能 | 普通模式：亮屏 / 熄屏 | 节能模式：亮屏 / 熄屏 |
|---|---|---|
| 看门狗 | 配置间隔 / 配置间隔（默认 30 秒） | 至少 60 / 180 秒 |
| 流量采集 | 配置间隔 / 配置间隔 × 5（默认 60 / 300 秒） | 至少 300 / 900 秒 |
| 场景检测 | 20 / 100 秒 | 60 / 180 秒 |
| 日志大小检查 | 空闲 30 秒；接近上限且大小变化时 2 秒 | 空闲 60 秒；接近上限且大小变化时 2 秒 |
| App 状态、设备和隧道 | 可见时稳定状态 15 秒 | 可见时稳定状态至少 30 秒 |
| App 日志 | 可见时 5 秒 | 可见时至少 30 秒 |

更长的自定义间隔会保留。App 隐藏时停止普通页面轮询；活动操作、文件及配置试运行保留各自观察语义。关闭自动刷新仍能操作和确认试运行。采集与场景关闭后对应驻留进程退出，历史流量和规则不会删除；手动 `collect-once` 仍可采样。

节能模式暂停网络切换后的主动 ping，不停止 Tailscale 主连接，也不降低 DNS 故障保护的 2 秒监测频率。DNS 健康状态改为本机内存查询，空闲时不再每 2 秒写盘。实际续航收益取决于设备、流量和网络，需要真机测量。

### `routes.conf`（路由范围）

| 键 | 默认值 | 含义 |
|---|---|---|
| `ROUTE_SCOPE` | `all` | `all` · `selected`（仅 `UID_LIST`）· `bypass`（除 `UID_LIST` 外全部） |
| `UID_LIST` | 空 | 空格分隔的 App UID 列表 |
| `ROUTE_SUBNETS` | `100.64.0.0/10` | 走隧道的 CIDR 列表 |

Bridge 公网默认目标需要选中偏好与实际出口身份一致，且仍受 all/selected/bypass 范围限制。UID 0 与 Tailscale 标记流量绕行；关闭 IPv6 时不保护 IPv6。proxy 仅处理显式代理客户端；原生 TUN 由 daemon 管理，不宣称已独立验证。出口页区分已选择、未生效和未知状态；需要立即协调 bridge 时使用 `foxytail.exitnode` 而非裸 `tailscale set`。

### `context.conf`（网络环境感知）

每行一条规则：`<触发>:<值>:<动作>[:<参数>]`

```
ssid:HomeWifi:down            # 连上该 Wi-Fi 时关闭隧道
ssid:Office:exit-node:myserver
cellular:-:no-exit-node       # 切到蜂窝时清除出口节点
```

动作：`up`、`down`、`exit-node <参数>`、`no-exit-node`。

默认网络、传输类型、接口与 DNS 来自 ConnectivityService 的 active default network 及对应 LinkProperties，不从 main 表推断。未知、VPN、Ethernet 不会冒充蜂窝；场景与看门狗使用同一快照。

App 的“网络场景”支持可视化增删、编辑与排序，也可切换原文编辑；保留注释和未识别行，非法规则仍由后端拒绝。最近执行结果来自实际整组动作，保存成功不等于动作已执行成功。

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
- 策略路由固定使用独立表 **1052** 与 mark/mask **`0x40000000/0x40000000`**；冲突时拒绝应用，保留其他标记位，不清空整张路由表
- `check` 比较完整配置、双栈规则、OUTPUT 跳转及路由快照；`apply` 在失配时修复，`teardown` 只移除精确策略规则和协议 186、设备 tailscale0 的路由
- 旧 DNS 模式额外使用 `FOXY_DNS`（nat）做 53 重定向；检测到其他模块已劫持 53 端口时自动跳过

## 共存指南

FoxyTail 从不动其他模块的链，开机时自动探测邻居（`foxytail.compat probe` → `/data/adb/foxytail/run/compat.json`）。

- **Clash / mihomo / box-for-magisk**：这类工具通常劫持 DNS（redirect 或 TPROXY UDP/53）。旧 DNS 模式安装重定向前先跑 `foxytail.compat check-dns-hijack`；冲突时跳过重定向（dnsmasq 仍在 1053 端口运行，状态记为 `degraded`）。只有检测到实际 DNS 重定向冲突时才需要协调两者；仅安装代理应用不会禁用 MagicDNS。
- **AFWall+**：防火墙重载可能清掉我们在内置链上的跳转。FoxyTail 的规则隔离在 `FOXY_*` 链中；用 `foxytail.compat check` 检测、`foxytail.route apply` 恢复。
- **NetGuard / 其他 VPN 应用**：FoxyTail **不占用** Android VpnService，零 VPN 槽位冲突——但开启「始终在线」的 VpnService 应用仍可能在我们的路由之前截获流量。

### App 代理共存向导

在 **导航 → 代理共存** 点击“检测环境”。读取已应用配置、当前 Tailnet 和实际 DNS 状态，不自动改动 FoxyTail 或其他模块配置。需要已就绪且归 FoxyTail 管理的 `local` / `hijack` / `transparent` 本地 DNS；MagicDNS 关闭、旧模式或状态待修复时，只显示前提和设置入口，不生成不可用片段。模块/应用清单不代表代理正在运行。

1. 确认目标为支持相关字段的 **mihomo / Clash.Meta**，选择现有 `fake-ip` 黑名单、规则模式或 `redir-host`。白名单语义不同，向导不会未经审阅自动转换。
2. 预览、复制并**合并**片段到原有 `dns.nameserver-policy`、`proxies`、`rules` 和适用的 `fake-ip-filter` 中；保留其他条目，新路由及规则模式过滤项应置于兜底规则前。不要整段覆盖原配置，也不要将本地端点用作全局 DNS。
3. 域名分流仅覆盖当前完整 Tailnet 后缀；IP 规则仅覆盖当前本机/节点的精确 `/32`、`/128`，不接管整个 CGNAT 地址段或所有 `ts.net`。不导入短名、公司 DNS、子网或出口路由；节点地址变化后重新生成。`FoxyTail-Tailnet` 出站名称必须唯一。
4. `bridge` / `proxy` 使用实际本机 SOCKS5 端口；`tun` 使用绑定 `tailscale0` 的 direct 出站，要求目标核心支持且具备接口访问权限。保留目标配置的全局 IPv6 设置，需要 AAAA 时单独确认支持情况。
5. 选择当前节点及地址，填写实际 TCP 服务端口，可选填另一个 `127.0.0.1` 代理 DNS 监听端口，再点击验证。独立显示 FoxyTail DNS 与可选代理 DNS 的 UDP/TCP 精确地址核验，以及数字地址的 TCP 连接结果。留空代理 DNS 端口明确跳过；检测到账号、地址或已应用端点变化时要求重新检测。

验证由 root 发起，TCP 经本机 tailscaled SOCKS5（bridge/proxy）或系统路由（tun），不发送应用数据。结果**不证明**第三方 App 的选路、代理接口绑定、UDP 业务或应用健康，也不证明片段已合并。进程/服务状态和各项探测不能互相替代。

配置语义参考 [mihomo DNS](https://wiki.metacubex.one/en/config/dns/) 与 [DIRECT 出站](https://wiki.metacubex.one/en/config/proxies/direct/)。已用 mihomo 1.19.32 校验九种模式组合，隔离运行验证实际 DNS 分流和 HTTP 经 SOCKS 转发；Android 真机验证独立本地 DNS 及现有 tailscaled SOCKS 的 TCP 成功/拒绝结果，未改动现有代理配置或验证第三方 App 的实际数据路径。


## MagicDNS 说明

在设置页打开 MagicDNS，选择 DNS 模式和空闲端口，再重启应用。升级沿用 `legacy`，不自动更改现有端口。新模式使用随两种安装包内置的 `foxydns`，无需自备 dnsmasq，也不依赖某个 VPN 应用的名称或私有接口。

| 模式 | 行为 | 适用条件 |
|---|---|---|
| `legacy` | 保留 dnsmasq 分流及原有 DNS 冲突检测 | 沿用现有配置 |
| `local` | 提供 `127.0.0.1:DNS_PORT` 的 UDP/TCP DNS；启用 IPv6 时同时监听 `[::1]:DNS_PORT` | 在支持分域 DNS 的任意解析器中，把当前 Tailnet 后缀交给此端点 |
| `transparent` | 内核和原请求选路信息都可验证时，接管普通 UDP/TCP 53 查询；无法启用时保留本地端点 | root、NFQUEUE、conntrack、INET_DIAG、严格路由查询及 socket 上下文能力可用；需验证实际设备/VPN组合 |
| `hijack` | UDP/53 按查询名裁决：仅 MagicDNS 完整名/短名（及内部 PTR）以原解析器地址注入应答，其余报文原样放行 | root、NFQUEUE 与伪造源注入路径可用（`probe --hijack` 实测）；不依赖 conntrack、mark 位或 NAT |

本地端点只回答当前节点表中的完整名、已知短名、A/AAAA/PTR。未知 Tailnet 名返回 NXDOMAIN，公网名返回 REFUSED，不能把它设为唯一的全局 DNS。后缀与实际端口可在隧道页查看并复制；需要短名时，在使用端配置该 Tailnet 搜索域或相应短名规则。某些 VPN 不提供分域 DNS 配置，此时本地模式不能自动接管它的解析。

透明模式先保留原请求的目标地址、UID、mark、源地址与出口信息，再验证内核路由。只有完整且一致的上下文才允许重定向；公网查询按原上下文访问原 DNS，不添加公共兜底 DNS。端口占用、能力缺失、规则丢失及策略恢复失败分别报告，只有实际 IPv4/IPv6 拦截就绪才显示对应能力。内核没有 IPv6 NAT 时保留 IPv6 隧道、AAAA 和本地 IPv6 监听，透明接管仅覆盖可用的 IPv4 路径。

劫持模式把 UDP/53 报文送入 NFQUEUE，只读取查询名：命中 MagicDNS 完整名、已知短名或受支持的内部 PTR 时，以原解析器地址注入一条伪造源应答并丢弃原查询；其余报文一律 NF_ACCEPT 原样放行——保留原 socket、UID、路由与解析器路径，不存在公共兜底 DNS。不占用 mark 位、不做 NAT 重定向、不依赖 conntrack 与策略路由，因此可在 GLUE_CT 缺失或 OEM mark 掩码冲突、透明模式不可用的设备上工作。TCP/53 本期不拦截。`--queue-bypass` 使辅助进程失效时自动回到原始 DNS 转发；伪造源注入路径（含 SELinux、rp_filter 限制）由 `probe --hijack` 实测，不可用时保留本地端点。

新模式会暂时关闭当前 Tailscale 账户的 `accept-dns`，避免 Android tailscaled 的全局 DNS 重定向与 VPN 争抢。原值在修改前记录到私有持久日志；停止或 App 切换账户前，仅对匹配的 profile 和节点身份恢复。用户从外部更改该偏好后，模块停止争抢，不反复覆盖。无法确认身份或恢复结果时保留日志并报告，账户切换也会中止。卸载将未解决的记录随原身份备份保留。**Tailscale 配置的公司分域 DNS、全局上游和搜索域不会自动复制到新模式**，需要使用端保留相应策略。

透明模式仍有明确边界：不接管 DoH/DoT，不重建 SELinux/cgroup 等任意应用身份；无法精确确认 socket UID 的流及不受支持的报文保持原路径。检测到其他 root 模块已劫持 DNS，或相关 OUTPUT 默认策略不兼容时，保留本地端点。保留位 `0x20000000` 必须不被其他程序使用；检测到冲突时停止透明拦截。辅助进程故障与规则移除之间存在短暂窗口，不能把能力探测成功等同于所有 VPN 已验证。完整设计、故障行为及验证范围见 [通用 DNS 共存实现说明](docs/reviews/2026-09-09-generic-dns.zh-CN.md)。

Android 16 + FlClash 测试机已通过本地 UDP/TCP 与 IPv6 DNS 验证，但缺少 `CONFIG_NETFILTER_NETLINK_GLUE_CT`，现有 OEM mark 规则也阻止透明接管；单独支持 NFQUEUE 和 conntrack 并不足够。这台设备使用本地模式，仍需使用端配置 Tailnet 分域 DNS，未实现免配置的透明共存。完整透明路径通过的是独立的严格 Linux 内核测试。

旧模式依次使用 `/data/adb/foxytail/bin/dnsmasq`、`/system/bin/dnsmasq`、`/vendor/bin/dnsmasq`；不存在时需自备可信二进制。公网 DNS 仅取当前 Android 默认网络快照，并在变化时刷新；上游未知时取消接管、报告降级，不再使用硬编码公网兜底。

旧模式的短名与完整名使用精确 hosts 记录，名为 `dev` 的节点不会接管无关的 `*.dev` 域名。为兼容系统 dnsmasq 2.51 降权后的读取，只将节点名称/IP 映射放在 `/dev/foxytail-dns/hosts`：目录由 root 持有、权限 `0755`，映射文件 `0644`、本机其他用户可读；不放宽 `/data/adb` 权限。成功停止后删除映射，目录为空时一并删除。任一地址族的重定向规则清理失败时保留解析器和映射，报告降级，等待重试清理。

撤重定向规则不会清除已存在的 DNAT。透明接管在标记 verdict 前持久记录精确流，先停队列，再按原/回复元组、conntrack ID 与 zone 0 删除自有连接。legacy 在检查外部掩码及已有使用后保留独立 connmark 位 `0x20000000`，清理须匹配 boot/端口声明及精确 DNS 重定向元组；两条路径都不全表 flush。失败保留所有权和旧监听器供重试，升级前无标记连接报告 `reconnect-needed`，直到过期或客户端重连。队列故障在撤规则后仍需要修复。冲突扫描保守覆盖全端口、范围、多端口、否定、模糊条件与读取失败。

本次隔离 Android 验证覆盖真实 journal/connmark 清理、同源 UDP 跨端口和停止后复用、错误 ID 拒绝、外部流保留及旧无标记流保留。该模拟器缺少 `CONFIG_NETFILTER_NETLINK_GLUE_CT`，更新后的完整 NFQUEUE 转发仍需独立 Linux 内核门禁；能力拒绝不计作透明转发通过。

## IPv6

`IPV6=on` 为 `tailscale0` 配置双栈地址（bridge 模式下为 `fd7a:115c:a1e0::1`），添加对称的 ip6tables 策略规则，并路由 `fd7a:115c:a1e0::/48`（请加入 `ROUTE_SUBNETS`）。默认关闭。开启前必须在路由子网中添加 IPv6 CIDR，否则路由应用会明确失败。

## 流量分析与诊断包

- `foxytail.stats` 每 `STATS_INTERVAL` 秒采样一次 per-peer Rx/Tx 与双栈隧道 OUTPUT 的 UID 发送计数，写入 `/data/adb/foxytail/run/stats/YYYY-MM-DD.jsonl`（默认 7 天环形，由 `STATS_RETENTION_DAYS` 控制，熄屏降频）。查询：`foxytail.stats query hourly <日期> | daily | topn <n>`。
- 流量页每次刷新只取一份 summary，共享给图表、节点和 UID。原生流式聚合保留私有 1 MiB 分块稳定外排序和单行 512 KiB 限制；有界私有摘要缓存复用未变化的输入身份，追加、截断、替换、日期、时区或保留期变化均使缓存失效。失败/取消不替换已完成缓存，超时/取消仍覆盖整棵自有子进程树。
- 诊断页可按需查看服务、隧道、路由和 DNS 摘要，并跳转到对应处理页面；设备详情可分别测试 IPv4/IPv6，显示实际 Ping 的延迟及直连/中继路径。
- `foxytail.diag collect` 把日志尾部、状态、netcheck、路由与配置打包到 `/sdcard/Download/foxytail-diag-<时间戳>.tar.gz`，默认用一致代号替换采集到的账户、设备名、SSID 和地址。分享前仍应检查自定义日志内容。`foxytail.diag collect /sdcard/Download local` 保留详细信息，仅供本机排查；App 也可显式选择此模式。

## 限制（如实说明）

- **仅 arm / arm64**——其他架构安装器直接中止。
- 默认 `bridge` 模式为 userspace 网络栈：吞吐低于内核 TUN（有条件请用 `tun` 模式）。
- App 不内嵌登录二维码，使用外部浏览器登录链接；CLI 可用 `tailscale login` 打印 URL。
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

- 补全 `docs/screenshots/` 下的原生 Material 3 界面截图并嵌入本文档
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
