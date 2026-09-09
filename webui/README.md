# WebUI 开发与验证

构建环境使用 Node.js 22.14.0 和 pnpm 10.30.3。运行界面要求 Android System WebView / Chromium 109 或更新版本；生产构建和 smoke 构建均使用 `chrome109` 编译目标。管理器仍需提供 KernelSU 或 MMRL root exec bridge。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm check:i18n
pnpm check:theme
pnpm smoke
pnpm build
```

在本目录执行以上命令。`smoke` 会先构建测试 bundle，再运行 jsdom 回归；`build` 更新仓库内的 `webroot/`。提交界面代码时应同时更新生产产物。

smoke 覆盖页面切换、无 root 桥、首屏加载失败与重试、请求级取消及替换等待、SOCKS5 探测命令、原生 TUN 能力限制、Serve/Funnel 协议与路径删除、设置保存与应用状态。桥与 Android 命令由替身提供；它不能替代 Android 真机上的进程、路由、流量和 WebView 交互验证。

优先使用 KernelSU/MMRL 的异步 `spawn`。带回调的 `exec` 仍会在 Java 接口中同步执行整个命令，只用于没有 `spawn` 的旧管理器。所有 root 桥调用在界面绘制后启动；页面销毁会立即取消排队中的读取，避免快速导航产生无用请求和取消命令。smoke 同时检查异步流输出与失败处理、shell 参数引用、首屏先于桥调用、连续导航无旧页面请求、空流量跳过应用枚举，以及 DNS 状态检查只由用户手动触发。

主题色固定为 `#E0632F`，`src/theme.generated.ts` 保存 Material 算法生成的两套色值，手机启动时直接应用。修改种子或升级色彩库后运行 `pnpm theme:generate`，再用 `pnpm check:theme` 验证色值与生成器一致。

可取消请求使用 `--request-id <id> <command>`，取消通过 `cancel <id>` 确认。任务替换需等待前一个请求取消成功；取消失败保持错误状态，避免立即启动可能重叠的任务。处于提交阶段的服务控制或恢复事务可能无法取消，应以实际状态刷新结果为准。
