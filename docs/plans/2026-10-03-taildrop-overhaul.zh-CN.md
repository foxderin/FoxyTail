# Taildrop 日常化与 Android 附属应用

原始方案日期：2026-10-03。当前实现更新：2026-10-14。

本文替代早期的 PID 轮询、`pv`/文件大小估算进度和 HTTP/base64 上传建议；这些方案未采用。当前入口、使用方法与构建说明见根目录 README 的 Taildrop/Android 章节。

## 已实现范围

- 原生文件页共享存储浏览、最多 32 文件批量选择；收件导入、二进制打开/另存、导出和删除保留。
- 模块 `foxyfiles` 持久发送任务、真实 daemon 字节进度、逐项错误、取消、历史和仅重试未成功项。
- `dev.foxderin.tail` 原生 Android 附属应用：系统 SEND/SEND_MULTIPLE、SAF 多选、确认发送、收件浏览/导入/打开/分享/另存、历史及前台活动通知。
- 收件排序、最多 32 项跨筛选多选、批量分享/导出/删除；发送草稿一键清空，终态历史可单条删除或清空。图标操作保留长按提示、无障碍名称与删除确认。
- 控制面分离已在后续实现完成：登录、路由、DNS 与其余管理功能迁入 Android Material 3 应用，root 模块仍独立托管 tailscaled 网络栈与任务；WebUI 已移除。
- Android APK 以稳定私有密钥签名，作为同发版独立产物由用户手动安装/更新；不再打进模块 ZIP 或开机自动安装。保留 App 独立 root 授权，不使用系统特权、共享 UID 或公开签名密钥。

## 发送与权限契约

`foxytail.webapi.sh` 的 Taildrop 入口集中于 `foxytail.webapi-taildrop.sh`：

| 命令 | 行为 |
|---|---|
| `taildrop-targets` | 读取 LocalAPI 的真实可发送节点，保留稳定 ID 和当前 IP |
| `files-browse <相对目录或->` | rooted 浏览 `/sdcard`，不跟随子目录/文件软链接，最多 1000 项 |
| `file-send-start <节点ID> <IP> <路径JSON数组>` | 校验当前账户/目标及源文件，提交独立持久任务 |
| `file-send-status <任务ID>` / `file-send-history` | 读取实际状态；进程中断通过文件锁识别，不信任陈旧 PID |
| `file-send-cancel <任务ID>` | 请求取消，终态由工作进程确认 |
| `file-stage <名称> <长度或-1>` | stdin 二进制写入私有暂存；已知长度必须一致 |
| `file-stage-delete <私有路径>` | 仅删除非活动任务使用的自有暂存文件 |
| `file-read <收件名>` | rooted 只读二进制流供 Android 导出，不接受任意绝对路径 |
| `file-send-delete <任务ID>` / `file-send-clear` | 仅删除已结束发送记录及取消标记，保留活动任务、源文件和暂存；返回删除数与保留活动数 |
| `file-delete-many <名称JSON数组>` / `file-export-many <名称JSON数组>` | 完整验证 1–32 个名称后逐项操作，返回各项结果和成功/失败数；导出保留已有文件 |

普通发送源仅允许共享存储或模块私有暂存，单文件上限 2 GiB。Android 外部分享只接受有读取授权的 `content://`，由 App 本身的 `ContentResolver` 读取，再经已获 root 授权的 `su` stdin 暂存；不把 URI 当 root 文件路径，不暴露 root HTTP 服务。

每批文件顺序发送；不同文件失败可继续后续项，账户/身份变化则停止。任务与文件使用独立随机 ID。上传使用 pinned LocalAPI multipart manifest 中的 ID，监听 `OutgoingFiles` 并精确匹配 ID/PeerID；`Sent` 才是发送进度。无事件则未知，最终仅 HTTP 成功响应可标记完成，不能信任单独的 `Succeeded` 字段。

工作进程继承模块的活动文件锁，页面或 App 退出不取消已接受任务。取消通过私有标记触发上下文结束，停止/升级等待锁释放。取消不能撤回对端已接收的数据。历史最多 100 条，私有暂存最多 256 项；成功立即清理，超过 24 小时的未使用/失败副本在下次 Taildrop 操作时清理，活动任务始终排除，用户原件从不删除。

## 收件语义

固定 Android daemon 直接写入 `/sdcard/Download/Taildrop`。“导入已接收文件”仅导入已完成普通文件，保留共享原件，以私有收据去重，不等待 `tailscale file get`。`.taildrop` 与 `.outgoing` 为保留目录，partial/deleted 和链接不进入收件箱。

开机记录缺失时，模块请求当前 LocalAPI 打开一个随机保留探测名；仅接受固定 daemon 返回的精确 direct-mode 拒绝，且 PID/启动时间/boot ID 前后相同才恢复记录。不创建、下载或删除探测文件，不用空文件列表猜测模式。若 daemon 实际未进入 direct mode，仍保留错误要求解锁重启。

App 导出通过随机令牌、只读、非 exported 的 ContentProvider 授权单个文件，24 小时后失效；另存使用系统目的地选择器。文件内容使用二进制流，不放入命令参数；旧 base64 内联下载入口已移除。

App 不申请所有文件或媒体访问权限：系统选择器/外部分享授予所选 URI，root 模块处理共享目录。批量分享先准备全部只读副本；任一源失败或取消都不启动分享并清理已准备副本。另存先选择目标、完整暂存后才提交；提交后文档提供者失败可能留下部分目标，界面明确提示。

## 验证边界

本地 native race 与 Unix LocalAPI 夹具覆盖并发、精确进度关联、HTTP 失败优先、源文件替换、账号变化、取消/进程中断和 rooted 文件访问。原 WebUI smoke 随切换移除，其行为验收迁到 Android 逻辑回归及真实界面 smoke。

实际运行使用独立 Android 15 模拟器、真实 Magisk su 与两个固定版本 tailscaled，经隔离 upstream testcontrol/DERP 注册，完成真实批量传输、字节对比、系统多分享、SAF、收件导入/另存、旋转保持、任务接管、真实字节事件与取消。控制服务器为测试环境，但文件数据面是实际 daemon/peerAPI，不是回显假实现。未验证 OEM 真机、KernelSU 授权弹窗、SELinux enforcing 共存及全套后台限制。

浏览器跨设备上传仍不属于本阶段；共享目录浏览与 Android SAF/系统分享负责文件选择。当前完整原生控制面、持久回执、产物令牌及构建/设备验证边界以 README 为准。
