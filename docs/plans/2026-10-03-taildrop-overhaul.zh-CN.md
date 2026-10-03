# Taildrop 优化计划

**日期**: 2026-10-03  
**范围**: FoxyTail 文件收发能力全面升级  
**目标**: 消除手输路径、提供进度反馈、闭环收件体验、支持浏览器直传

---

## 现状盘点

### 当前实现

**后端** `tailscale/scripts/foxytail.webapi-tools.sh`:
- `cmd_files_inbox`：列 `${FILES_DIR}` 内容
- `cmd_file_send`：校验 `/sdcard/...` 路径 + `tailscale file cp <path> <peer>:`
- `cmd_file_receive`：`tailscale file get --wait=false <dir>/`

**前端** `webui/src/pages/Files.tsx`：
- inbox 列表（只读）
- 发送表单：手输路径 + peer 下拉
- "Fetch waiting files" 按钮：盲拉

### 用户痛点

| # | 痛点 | 影响 |
|---|---|---|
| P1 | 发送必须手输 `/sdcard/...` 完整路径 | 高（需记忆+易错） |
| P2 | 发送无进度反馈，大文件像死了 | 高（UX 关键） |
| P3 | 接收是盲拉，不知道什么时候有新文件 | 中 |
| P4 | 收到文件后无法打开/导出到 Download | 高（文件困在 data 分区） |
| P5 | inbox 不能删除/清空 | 中（空间累积） |
| P6 | peer 只支持 hostname | 低 |
| P7 | Android 系统分享列表里没有 FoxyTail | 高（需要 companion app） |

---

## 总体方案

按交付风险与依赖关系拆 4 个 PR，每个 PR 独立闭环。

### PR-1: 收件闭环 + peer 灵活化（最小可用）

**范围**:
- 后端 `file-send`：peer 参数接受 hostname **或** Tailscale IP
- 后端 `file-receive`：改 `--wait`（阻塞 30s 等新文件）+ 自动 `cp` 到 `/sdcard/Download/` + `content scan`（media scanner）
- 后端新增：
  - `file-delete <name>`：从 inbox 删除单个
  - `file-clear`：清空 inbox
  - `file-export <name>`：手动把 inbox 里某个文件复制到 `/sdcard/Download/`
  - `file-download <name>`：webapi 返回文件内容（WebUI 下载用）
- WebUI Files 页：
  - inbox 每行加操作按钮（下载/导出/删除）
  - 顶部"清空收件箱"按钮
  - 接收按钮改 `--wait` 语义提示（"等待新文件 30s"）
  - 发送 peer 输入允许 hostname 或 IP

**不做**：进度反馈、上传、Android app

**技术要点**:
- `tailscale file get --wait` 是阻塞调用，ts_cli 30s timeout
- 导出到 `/sdcard/Download/` 需要 `cp` + `content insert --uri content://media/external/file` 或 `am broadcast android.intent.action.MEDIA_SCANNER_SCAN_FILE`
- `file-download` 需要 webapi 支持二进制响应（当前只 JSON）—— **实现改为返回 base64** 或新增 `/files/<name>` raw endpoint

**风险**:
- `file get --wait` 如果 tailscaled 实现是阻塞整个调用，ts_cli 30s 可能不够 → 需要测试
- 导出需要 `/sdcard/Download` 可写（SELinux + scoped storage 限制） → 需要测试

**验收**:
- 后端 unittest 覆盖新命令
- 设备上：从 macOS `tailscale file cp` 发一个文件 → Android `file-receive` 30s 内拿到 + 出现在 `/sdcard/Download/` + 系统相册/文件管理器可见
- WebUI 能下载/删除收件

**预估代码量**: 后端 ~150 行 + WebUI ~120 行 + 测试 ~80 行

---

### PR-2: 发送进度反馈

**范围**:
- 后端 `file-send` 改异步：
  - 启动后台 `tailscale file cp`，写入 PID + 状态到 `${TS_RUN_DIR}/file-send.state`
  - 新命令 `file-send-status`：返回 `{running, pid, sentBytes, totalBytes, peer, path, startedAt, error?}`
  - 已发量怎么算：`tailscale file cp` 不报告，需要**包一层 `pv` 或 `dd`** → 但 `pv` 不一定有 → **fallback 用文件大小 + 进程运行时间估算**
  - 更准确方案：`tailscale file cp --verbose` 或 `strace -e write`（如果设备有）
  - 最准确方案：**自己起个 FIFO，写文件 → FIFO → tailscale file cp FIFO:...** → stat FIFO 读端
- WebUI：
  - 发送表单启动后轮询 `file-send-status`，显示进度条 + 速度 + 已发/总量
  - 允许取消（kill PID）

**技术要点**:
- `tailscale file cp` 从 stdin 读可能不支持（需确认）→ 若不支持则只能用 `pv <file> | tailscale file cp - peer:name`
- 或者启动 `tailscale file cp` 后**监控对端接收字节**（需要 tailscaled 支持）→ 更复杂
- **务实方案**：`pv -n <file> | tailscale file cp - "peer:${filename}"`，`pv -n` 输出字节数到 stderr → 重定向到 state file

**依赖**: 设备需 `pv`。若无，apt 装 busybox 版 or 用 named pipe + 后台 stat

**验收**:
- 发送 100MB 文件，前端进度条平滑增长，速度合理
- 中途取消，后端进程被 kill，状态清理

**预估代码量**: 后端 ~200 行 + WebUI ~100 行 + 测试 ~60 行

---

### PR-3: 浏览器直传

**范围**:
- 后端 webapi 支持 `multipart/form-data` 上传：
  - 新 endpoint `POST /files/upload`：接收文件流 → 写到 `${FILES_DIR}/.upload-<uuid>`
  - 上传完成后可选直接触发 `file-send`（参数 `peer=<hostname>`）
- WebUI：
  - 发送表单加文件选择器 `<input type="file">`
  - 选中后先上传 → 拿到临时路径 → 调用 `file-send <tmp-path> <peer>`
  - 或直接 `POST /files/upload?peer=...` 一步到位
- 上传进度用 XMLHttpRequest `upload.onprogress`

**技术要点**:
- 当前 webapi 是 `GET /?cmd=...` query-string 风格，需要加 POST + multipart 解析
- 可以用 `busybox httpd` 的 CGI 上传支持，或**前端先把文件 base64 编码后用现有 JSON API**（简单但内存开销 4/3 倍）
- **务实方案**：base64 JSON 上传（小文件 OK，大文件不行）+ 明确限制（如 50MB）
- **进阶方案**：webapi 加 raw POST endpoint，接收 binary stream → 写临时文件（需改 webapi 主循环）

**验收**:
- WebUI 选择 10MB 文件 → 上传 → 发送成功
- 上传中显示进度
- 临时文件发送后自动清理

**预估代码量**: 后端 ~250 行（含 multipart 或 base64 处理）+ WebUI ~150 行 + 测试 ~80 行

---

### PR-4: Android Companion App（独立工程）

**范围**:
- 新建 Android 项目（Kotlin + Gradle）
- 功能：
  - **SAF 文件选择器**：`Intent.ACTION_OPEN_DOCUMENT` → 读 ContentResolver → 写到 app cache → 调用 FoxyTail webapi 上传+发送
  - **Share intent 接收**：`Intent.ACTION_SEND` / `ACTION_SEND_MULTIPLE` 注册到系统分享列表 → 同上流程
  - **通知**：`file-receive` 完成后发系统通知，点击打开 Download 目录
  - **可选**：前台 Service 监听 tailscaled 的 file waiting 状态，自动拉取

**技术要点**:
- 需要 READ/WRITE_EXTERNAL_STORAGE（或 SAF 授权）
- 需要访问 FoxyTail webapi（localhost:port + root auth token 或 unix socket）
- 需要调用 `tailscale` CLI 或 FoxyTail webapi（需要 root 或 Shizuku）
- **最大风险**：权限模型。Magisk 模块的 webapi 只对 root 开放 → companion app 也需要 root 或通过 Magisk 模块暴露的 LocalSocket

**预估代码量**: 新工程 ~2000 行 Kotlin + Gradle 配置 + CI 打包 APK

---

## 建议执行顺序

1. **PR-1**（本次会话）：收件闭环 + peer 灵活化 —— 价值/成本最高
2. **PR-2**（下次会话）：发送进度 —— UX 关键
3. **PR-3**（再次）：浏览器直传 —— 消除手输路径
4. **PR-4**（独立项目）：Android app —— 需要你自己做或找人做

---

## 技术风险汇总

| 风险 | 影响 | 缓解 |
|---|---|---|
| `tailscale file get --wait` 超时不够 | PR-1 收件不可靠 | 设备实测 30s 是否够；不够则前端轮询 |
| `/sdcard/Download` SELinux 不可写 | PR-1 导出失败 | 先设备验证；失败则 fallback 到 `/sdcard/Android/data/<package>/files` |
| webapi 不支持二进制响应 | PR-1 file-download 受限 | base64 编码 JSON 响应（小文件 OK） |
| `tailscale file cp` 无进度输出 | PR-2 进度不准 | 用 `pv` 或 named pipe + stat |
| webapi 无 multipart | PR-3 需改 webapi 架构 | 先 base64 JSON（限 50MB），后续改 raw POST |
| Android app 权限 | PR-4 无法访问 FoxyTail | 需要 Magisk 模块暴露 LocalSocket + app 通过 native lib 连接 |

---

## 本次会话目标

**完成 PR-1**：
- [ ] 后端：peer IP 支持 + receive 阻塞+导出 + inbox 操作 API
- [ ] WebUI：inbox 操作按钮 + 清空 + peer 输入提示
- [ ] 测试：后端 unittest + 设备端到端
- [ ] 文档：CHANGELOG + 本计划文件归档到 `docs/reviews/`

**预估工时**: 2-3 小时（含设备验证）

**后续 PR 单独会话**，避免单次交付过大难以 review。
