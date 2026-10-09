# Taildrop 日常化与 Android 附属应用

原始方案日期：2026-10-03。当前实现更新：2026-10-09。

本文替代早期的 PID 轮询、`pv`/文件大小估算进度和 HTTP/base64 上传建议；这些方案未采用。当前入口、使用方法与构建说明见根目录 README 的 Taildrop/Android 章节。

## 已实现范围

- WebUI 共享存储目录浏览、最多 32 文件批量选择；现有收件导入、下载、导出和删除保留。
- 模块 `foxyfiles` 持久发送任务、真实 daemon 字节进度、逐项错误、取消、历史和仅重试未成功项。
- `dev.foxderin.tail` 原生 Android 附属应用：系统 SEND/SEND_MULTIPLE、SAF 多选、确认发送、收件浏览/导入/打开/分享/另存、历史及前台活动通知。
- App 与 WebUI 共用模块能力，不复制 tailscaled 网络栈，不迁移登录、路由、DNS 等其余控制面。
- Android APK 以稳定私有密钥签名，随两个模块 ZIP 挂载于 `system/app/FoxyTail/FoxyTail.apk`；不使用系统特权、共享 UID 或公开签名密钥。

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

普通发送源仅允许共享存储或模块私有暂存，单文件上限 2 GiB。Android 外部分享只接受有读取授权的 `content://`，由 App 本身的 `ContentResolver` 读取，再经已获 root 授权的 `su` stdin 暂存；不把 URI 当 root 文件路径，不暴露 root HTTP 服务。

每批文件顺序发送；不同文件失败可继续后续项，账户/身份变化则停止。任务与文件使用独立随机 ID。上传使用 pinned LocalAPI multipart manifest 中的 ID，监听 `OutgoingFiles` 并精确匹配 ID/PeerID；`Sent` 才是发送进度。无事件则未知，最终仅 HTTP 成功响应可标记完成，不能信任单独的 `Succeeded` 字段。

工作进程继承模块的活动文件锁，页面或 App 退出不取消已接受任务。取消通过私有标记触发上下文结束，停止/升级等待锁释放。取消不能撤回对端已接收的数据。历史最多 100 条，私有暂存最多 256 项；成功立即清理，超过 24 小时的未使用/失败副本在下次 Taildrop 操作时清理，活动任务始终排除，用户原件从不删除。

## 收件语义

固定 Android daemon 直接写入 `/sdcard/Download/Taildrop`。“导入已接收文件”仅导入已完成普通文件，保留共享原件，以私有收据去重，不等待 `tailscale file get`。`.taildrop` 与 `.outgoing` 为保留目录，partial/deleted 和链接不进入收件箱。

App 导出通过随机令牌、只读、非 exported 的 ContentProvider 授权单个文件，24 小时后失效；另存使用系统目的地选择器。WebUI 的 base64 内联下载仍限制 8 MiB，Android 使用二进制流，不把大文件装进命令参数。

## 验证边界

本地 native race 与 Unix LocalAPI 夹具覆盖并发、精确进度关联、HTTP 失败优先、源文件替换、账号变化、取消/进程中断和 rooted 文件访问；WebUI smoke 覆盖浏览、批次、后台观察与失败项重试。

实际运行使用独立 Android 15 模拟器、真实 Magisk su 与两个固定版本 tailscaled，经隔离 upstream testcontrol/DERP 注册，完成真实批量传输、字节对比、系统多分享、SAF、收件导入/另存、旋转保持、任务接管、真实字节事件与取消。控制服务器为测试环境，但文件数据面是实际 daemon/peerAPI，不是回显假实现。未验证 OEM 真机、KernelSU 授权弹窗、SELinux enforcing 共存及全套后台限制。

浏览器跨设备上传和整个 WebUI 控制面迁移不属于本阶段；文件选择已由共享目录浏览及 Android SAF/系统分享完成。
