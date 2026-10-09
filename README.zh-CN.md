# FoxyTail

**在 Android 上以 Magisk/KernelSU 模块运行的 Tailscale mesh VPN** —— 原生 `tailscaled`、三种运行模式、策略路由、流量分析、MagicDNS 分流、代理共存向导、看门狗与网络场景，以及 WebUI 控制面和原生 Android Taildrop 附属应用。

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
| WebUI（12 页） | ✅ | 仅 KernelSU/MMRL（Magisk 官方管理器不支持 WebUI），见下文 |
| Taildrop 批量传输与持久历史 | 已实现 | 文件浏览、真实字节进度、取消与仅重试未成功项 |
| Android 附属应用 `dev.foxderin.tail` | 已实现 | Android 8.0+；系统分享、SAF、收件箱/发送/历史 |
| light/full 双 zip、`update.json` OTA | ✅ | |

## 安装

[Releases](../../releases) 页面发布两种包：

- **`FoxyTail-<version>.zip`（light 轻量包）** —— 安装时从固定的上游 release 下载 `tailscaled`、`jq`、`hev-socks5-tunnel`，并按 `checksums.txt` 逐个 SHA256 校验。安装过程需要联网。自研 `foxydns` 已随轻量包内置。
- **`FoxyTail-<version>-full.zip`（full 完整包）** —— 内置全部二进制，可离线安装。内置二进制同样做 SHA256 校验，被篡改的 zip 会被拒绝。

在 Magisk Manager、KernelSU Manager 或 MMRL 中刷入任一 zip，然后重启（重启前可使用安装器打印的绝对路径命令）。

要求：arm 或 arm64 设备，Magisk v20.4+ 或 KernelSU ≥ 10670。升级时保留你的状态、配置与钩子文件（见下文）。

两种包均内置 ARM/ARM64 的 `foxydns` 和 `foxyfiles`，按随包 native 清单校验。开机先由模块根目录的稳定代码恢复中断升级，再加载可替换的 settings/scripts；仅恢复与备份所有权一致的事务。记录无法证明或恢复失败时保留日志与备份、推迟启动，不猜测恢复对象。

两种包也包含 `system/app/FoxyTail/FoxyTail.apk`，重启后在桌面出现 **FoxyTail** 附属应用（Android 8.0+，包名 `dev.foxderin.tail`）。它是普通非特权应用，首次使用需在 Magisk/KernelSU 授予 root，不占用 VPN 槽位。APK 必须签名才能安装/升级；正式包使用稳定的私有签名，不使用公开 debug key。手动安装 debug APK 后不能直接覆盖成不同签名的正式 APK。

**v1.4.0 升级**：从 v1.3.x 直接刷入并重启，不需要清除 Tailscale 身份或配置。若已手动安装不同签名的 debug 附属应用，应先卸载该 debug 应用，再使用正式包；不要为此卸载 FoxyTail 模块。附属 App 暂不迁移登录、路由、DNS 等管理功能。

## 卸载与重装

从 Magisk/KernelSU 移除模块时会执行 `uninstall.sh`：停止所有 FoxyTail 组件、拆除路由/DNS 链、删除 `/data/adb/foxytail`——**但 Tailscale 身份不会丢**。删除前 `tailscaled.state` 会先备份到 `/data/adb/foxytail-state.backup`；下次安装时若尚无状态文件，安装器会自动恢复该备份（并打印提示），重装后仍是原节点、保持登录。如需全新身份，手动删除 `/data/adb/foxytail-state.backup` 即可。

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

## WebUI

WebUI 已内置：位于 `webroot/`（纯静态零构建，后端为 `foxytail.webapi.sh` JSON 接口）。使用须知：

- 从 **KernelSU 管理器** 或 **MMRL** 打开。**Magisk 官方管理器不支持模块 WebUI**——那里不会出现入口按钮。
- 共 12 页（底部导航 +「更多」分组）：Dashboard · Peers（列表 + 拓扑图：直连/中继路径）· Exit Nodes · Account · Tunnel · Routing · Traffic · Serve · Files（Taildrop）· Logs · Settings · Diagnostics。
- 构建产物自包含；中/英 i18n 与深浅色主题。

固定的 Android CLI 直接收件至 `/sdcard/Download/Taildrop`。**导入已接收文件**只复制已完成的普通文件到私有收件箱，不等待缓冲模式的 `tailscale file get`，共享存储原件保留。私有收据防止重复导入，排除 partial/deleted 文件和软链接；模式记录绑定启动时所属 daemon 的身份。若启动时共享存储不可用，请解锁后重启 FoxyTail。发送使用稳定节点 ID 与其当前 IP（含 IPv6），不会把重名主机当成目标身份。

自动与手动导出保留 Download 现有文件，依次尝试编号至 `-99`，耗尽时失败但不删除私有副本。清空包含隐藏普通文件，保留收据和目录。内联下载支持不超过 8 MiB 的文件，更大文件请导出；编码使用退出时清理的私有临时文件，不把文件内容放进命令行参数。

### Taildrop 日常使用与 Android 附属应用

- **WebUI**：文件页可逐层浏览 `/sdcard`，勾选最多 32 个文件（每个 ≤2 GiB），选择实际支持 Taildrop 的节点后发送；单目录最多列出 1000 项并提示截断，不再要求手输路径。
- **Android**：提供收件箱、发送、历史三个原生页面。系统文件选择器支持多选；文件管理器“分享 → FoxyTail”支持单文件/多文件。分享只打开待发送列表，选择设备并确认后才开始读取与发送。
- **收件**：tailscaled 继续直接接收到 `Download/Taildrop`。点击“导入已接收文件”后可在私有收件箱浏览、打开、分享或用系统“保存副本”选择目的地；导入不等待新文件，不删除共享存储原件。Android 二进制读取不受 WebUI 内联下载的 8 MiB 限制，应用单文件限制为 2 GiB。
- **进度与历史**：模块同一时间接受一个批次，逐文件发送。进度取自 tailscaled LocalAPI `OutgoingFiles.Sent`，按唯一文件 ID 和节点 ID 关联；事件不可用时明确显示未知，不估算百分比。本地 URI 暂存进度与网络发送进度分开。仅真实上传 HTTP 成功响应标记完成；失败项保留错误，可以仅重试未成功文件。
- **后台与取消**：已接受的发送由模块工作进程持有，退出页面、关闭 App 不停止发送；重新打开历史可接管。应用仅工作时运行前台通知，拒绝通知权限仍可在应用内查看或取消。取消是请求，等待工作进程确认；已被对端接受的字节无法撤回。服务停止/升级会先等待工作进程释放所有权。
- **数据边界**：Android 以自身 `ContentResolver` 读取授权 `content://` URI，经 `su` 的二进制 stdin 写入私有暂存，不把大文件放入命令参数，不接受 root 读取外部 Intent 指定的任意路径，也不开放 root HTTP 服务。只读导出 URI 限时 24 小时。已发送暂存立即删除；未使用/失败副本超过 24 小时后在下次 Taildrop 操作时清理，活动任务除外；历史最多保留 100 条，暂存最多 256 项。不会删除原始文件。

这一阶段保留 WebUI 处理登录、路由、DNS 等控制功能，不在 App 中重复实现。接收导入仍绑定启动时的 daemon 身份；首次开机存储未解锁时须解锁并重启模块。

### Android 构建与签名

`android/` 使用 JDK 21、Gradle 9.7.1（wrapper SHA256 固定）、AGP 9.3.2、SDK `platforms;android-37.0` / `build-tools;36.0.0`；最低 API 26、目标 API 36。版本号直接来自 `module.prop`。

设置 `JAVA_HOME` 与 `ANDROID_HOME` 后运行 `bash .github/tools/build-android.sh debug dist/FoxyTail-debug.apk`。正式构建把 `debug` 改为 `release`，必须提供 `FOXYTAIL_KEYSTORE_PATH`、`FOXYTAIL_KEYSTORE_PASSWORD`、`FOXYTAIL_KEY_ALIAS`、`FOXYTAIL_KEY_PASSWORD`；缺失即失败，不回退到临时签名。签名文件不入仓库，应离线备份；丢失后不能无损升级已安装应用。CI 仅可信打包任务读取签名 secrets，PR 只构建 debug。

原生 App 仪器回归：`android/gradlew -p android :app:assembleDebugAndroidTest`，安装应用与测试 APK 后执行 `adb -s <设备> shell am instrument -w dev.foxderin.tail.test/dev.foxderin.tail.BridgeInstrumentation`。本轮实际验证使用独立 Android 15 模拟器、真实 Magisk su 和两个固定版本 tailscaled，覆盖二进制/空文件批量传输、系统多文件分享、SAF、收件导入/另存、旋转保持、任务接管、真实字节事件与取消；这不是 OEM 真机或 KernelSU 授权/后台限制验证。

<!-- 截图占位：docs/screenshots/*.png（待补充，见 Roadmap） -->

## WebUI 开发

WebUI 源码位于 `webui/`（Vite + SolidJS、原生控件及 Material Design 3 样式、`kernelsu` npm 桥接）。构建产物已提交进 `webroot/`，模块自包含，使用者无需安装 Node 工具链。

- `pnpm --dir webui install --frozen-lockfile` —— 安装依赖（一次性）
- `pnpm --dir webui dev` —— Vite 开发服务器（无 root 桥环境，界面显示 no-root 横幅）
- `pnpm --dir webui build` —— 生产构建输出到 `../webroot/`（构建结果需提交）
- `pnpm --dir webui typecheck` / `check:i18n` / `smoke` —— 类型检查、中英键值对齐校验、jsdom 冒烟（13 条路由 + 任务接管 + no-root 横幅）

前后端 JSON 契约随模块同步发布：恢复同时校验归档 SHA256 与已保存配置基线 SHA256，旧预览必须重做；试用状态使用单调剩余秒数；出口状态区分选中偏好与实际路由。

## 验证与发布

开发工具链固定为 Node 22.14.0、pnpm 10.30.3、Go 1.27.1，以及上述 Android 工具链；WebUI 要求 Android WebView 109+。安装依赖后执行 `bash .github/tools/verify.sh`，统一检查 ShellCheck、隔离后端回归、Android debug 构建/lint、类型、国际化、smoke、版本元数据和生产产物一致性；前端改动后先执行 `pnpm --dir webui build` 更新 `webroot/`。

发布前运行 `.github/tools/version-bump.sh`，提交版本元数据与前端产物后创建版本标签。分支推送执行 Verify 和 Linux 内核测试，通过后按已审阅的 `tailscale/checksums.txt` 构建两种 ZIP 并保存 30 天。Release 仅复用同仓库、标签对应完整提交 SHA 的成功 Verify 产物，排除 PR 产物；验证进行中则等待，没有可复用产物则对现有标签触发一次 Verify。同一提交的并发请求复用成功产物，失败门禁阻止发布，上传前再次核对下载包的校验和与版本。手动 Release 走同一路径。

更新依赖时显式运行 `bash .github/tools/build.sh --update-checksums` 生成候选文件，核对上游来源后再审阅、替换并提交；该模式不打包。

设置保存后以 WebUI 的“重启应用”或 `/data/adb/foxytail/scripts/start.sh reload` 刷新主服务和驻留组件。`foxytail.service restart` 仅重启网络服务层。升级保留接收文件、自备 dnsmasq、配置和身份；切换前停止旧组件，失败保留回滚记录。

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
| `DNS_MODE` | `legacy` | `legacy` 旧模式 / `local` 本地端点 / `transparent` 透明共存 |
| `MAGIC_DNS` | `off` | 启用所选模式的 Tailnet 域名解析 |
| `IPV6` | `off` | tailscale0 双栈 + ip6tables 对称规则 |
| `ROUTE_TABLE` | `1052` | 固定独立策略路由表，外部资源冲突时拒绝应用 |
| `FWMARK` / `FWMARK_MASK` | `0x40000000` | 固定共享标记位；旧 0xF7 配置读取时迁移 |
| `WATCHDOG` / `WATCHDOG_INTERVAL` | `on` / `30` | 崩溃重启 + rebind，检查间隔秒数 |
| `WATCHDOG_RESTART_LIMIT` / `WATCHDOG_RESTART_WINDOW` | `5` / `600` | 窗口（秒）内允许的重启次数，达到上限后进入冷却 |
| `WATCHDOG_COOLDOWN` / `WATCHDOG_BACKEND_BAD_LIMIT` | `300` / `3` | 冷却秒数；连续无应答轮次达到该值后触发重启 |
| `WATCHDOG_PROBE` | `on` | 网络切换后的主动连通性探测；节能模式下暂停 |
| `POWER_SAVE` | `off` | 节能模式，降低可选后台功能与 WebUI 的刷新频率 |
| `STATS` / `CONTEXT` | `on` / `on` | 独立控制流量采集与场景自动化；关闭保留数据和规则 |
| `WEBUI_AUTO_REFRESH` | `on` | 页面自动刷新；关闭后仍可首次加载与手动刷新 |
| `STATS_INTERVAL` | `60` | 流量采集间隔（熄屏自动降频） |
| `STATS_RETENTION_DAYS` | `7` | 流量样本保留天数（JSONL 环形） |
| `CONTEXT_INTERVAL` | `20` | 场景检测间隔（熄屏自动降频） |
| `LOG_MAX_KB` | `512` | 日志轮转阈值（保留一个 `.bak`） |

`CONTEXT_INTERVAL`、`STATS_RETENTION_DAYS` 与 `WATCHDOG_*` 恢复限额属于高级文件级选项：编辑 `foxytail.conf` 后重启生效。WebUI 设置接口既不返回也不写入这些键。

### 功耗控制

在 WebUI **设置 → 节能与后台** 中选择节能模式或独立开关，保存后点击 **重启并应用** 生效。升级保留现有功能默认启用；节能模式不会打开已关闭的功能。关闭看门狗会停止自动故障恢复，关闭场景自动化会停止执行 SSID/蜂窝规则。

| 功能 | 普通模式：亮屏 / 熄屏 | 节能模式：亮屏 / 熄屏 |
|---|---|---|
| 看门狗 | 配置间隔 / 配置间隔（默认 30 秒） | 至少 60 / 180 秒 |
| 流量采集 | 配置间隔 / 配置间隔 × 5（默认 60 / 300 秒） | 至少 300 / 900 秒 |
| 场景检测 | 20 / 100 秒 | 60 / 180 秒 |
| 日志大小检查 | 空闲 30 秒；接近上限且大小变化时 2 秒 | 空闲 60 秒；接近上限且大小变化时 2 秒 |
| WebUI 状态、设备和隧道 | 可见时稳定状态 15 秒 | 可见时稳定状态 30 秒 |
| WebUI 日志 | 可见时 5 秒 | 可见时 30 秒 |

更长的自定义间隔会保留。WebUI 隐藏时停止轮询；启动状态和活动配置试用保留及时更新。关闭自动刷新仍能操作和确认试用。采集与场景关闭后对应驻留进程退出，历史流量和规则不会删除；手动 `collect-once` 仍可采样。

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
- 策略路由固定使用独立表 **1052** 与 mark/mask **`0x40000000/0x40000000`**；冲突时拒绝应用，保留其他标记位，不清空整张路由表
- `check` 比较完整配置、双栈规则、OUTPUT 跳转及路由快照；`apply` 在失配时修复，`teardown` 只移除精确策略规则和协议 186、设备 tailscale0 的路由
- 旧 DNS 模式额外使用 `FOXY_DNS`（nat）做 53 重定向；检测到其他模块已劫持 53 端口时自动跳过

## 共存指南

FoxyTail 从不动其他模块的链，开机时自动探测邻居（`foxytail.compat probe` → `/data/adb/foxytail/run/compat.json`）。

- **Clash / mihomo / box-for-magisk**：这类工具通常劫持 DNS（redirect 或 TPROXY UDP/53）。旧 DNS 模式安装重定向前先跑 `foxytail.compat check-dns-hijack`；冲突时跳过重定向（dnsmasq 仍在 1053 端口运行，状态记为 `degraded`）。只有检测到实际 DNS 重定向冲突时才需要协调两者；仅安装代理应用不会禁用 MagicDNS。
- **AFWall+**：防火墙重载可能清掉我们在内置链上的跳转。FoxyTail 的规则隔离在 `FOXY_*` 链中；用 `foxytail.compat check` 检测、`foxytail.route apply` 恢复。
- **NetGuard / 其他 VPN 应用**：FoxyTail **不占用** Android VpnService，零 VPN 槽位冲突——但开启「始终在线」的 VpnService 应用仍可能在我们的路由之前截获流量。

### WebUI 代理共存向导

在 **隧道 → 代理共存向导** 点击“检测环境”。读取已应用配置、当前 Tailnet 和实际 DNS 状态，不自动改动 FoxyTail 或其他模块配置。需要已就绪且归 FoxyTail 管理的 `local` / `transparent` 本地 DNS；MagicDNS 关闭、旧模式或状态待修复时，只显示前提和设置入口，不生成不可用片段。模块/应用清单不代表代理正在运行。

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

本地端点只回答当前节点表中的完整名、已知短名、A/AAAA/PTR。未知 Tailnet 名返回 NXDOMAIN，公网名返回 REFUSED，不能把它设为唯一的全局 DNS。后缀与实际端口可在隧道页查看并复制；需要短名时，在使用端配置该 Tailnet 搜索域或相应短名规则。某些 VPN 不提供分域 DNS 配置，此时本地模式不能自动接管它的解析。

透明模式先保留原请求的目标地址、UID、mark、源地址与出口信息，再验证内核路由。只有完整且一致的上下文才允许重定向；公网查询按原上下文访问原 DNS，不添加公共兜底 DNS。端口占用、能力缺失、规则丢失及策略恢复失败分别报告，只有实际 IPv4/IPv6 拦截就绪才显示对应能力。内核没有 IPv6 NAT 时保留 IPv6 隧道、AAAA 和本地 IPv6 监听，透明接管仅覆盖可用的 IPv4 路径。

新模式会暂时关闭当前 Tailscale 账户的 `accept-dns`，避免 Android tailscaled 的全局 DNS 重定向与 VPN 争抢。原值在修改前记录到私有持久日志；停止或 WebUI 切换账户前，仅对匹配的 profile 和节点身份恢复。用户从外部更改该偏好后，模块停止争抢，不反复覆盖。无法确认身份或恢复结果时保留日志并报告，账户切换也会中止。卸载将未解决的记录随原身份备份保留。**Tailscale 配置的公司分域 DNS、全局上游和搜索域不会自动复制到新模式**，需要使用端保留相应策略。

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
- 流量页每次刷新只取一份 summary，共享给图表、节点和 UID。私有 1 MiB 分块稳定外排序保留时钟跳变后的时间顺序，流式聚合仅保留最近计数与统计桶；单行超过 512 KiB 明确失败，超时/取消覆盖整棵自有子进程树。
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
