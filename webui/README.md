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

主题采用中性浅色／石墨深色表面与狐狸橙强调色，默认跟随系统。`scripts/generate-theme.mjs` 是语义色值源，`src/theme.generated.ts` 保存生成后的两套 token，手机启动时直接应用。修改色值后运行 `pnpm theme:generate`，再用 `pnpm check:theme` 验证一致性；手机端不运行调色算法，也不加载外部字体。

开发时运行 `pnpm dev --host 127.0.0.1`，打开 `/dev/index.html?lang=zh&theme=light` 即可使用带模拟数据的设计预览。可选参数为 `lang=zh|en`、`theme=auto|light|dark`、`state=ready|empty|error|slow|login|no-root`。预览带有明确标记，模拟桥仅存在于 `dev/preview.ts`，生产构建只使用根 `index.html`，不会包含模拟数据或命令替身。

`src/config.ts` 集中数据目录和 API 超时，`src/settings.ts` 定义设置字段与范围；`SettingsMaintenance`、`SubnetRoutes`、`RoutingApps` 分别负责维护、子网发现和应用选择。

页面结构由 `navigation.ts` 和 `AppShell` 统一组织，页面各自负责业务交互；`components/Basics.tsx` 提供状态卡、指标卡、骨架与错误重试，`components/ui.tsx` 提供原生按钮、输入与弹窗。`style.css` 管理通用 token、布局和控件，`pages/network.css` 汇总公共网络、设备、流量样式及响应式覆盖，`pages/tools.css` 负责工具页布局。新增文案按领域存放在 `i18n-*.ts`，中心词典统一导入；词条检查会递归验证对象展开、重复键、空值及中英文对应关系。

视觉验收覆盖手机与桌面、深浅色、首次加载／空数据／失败重试以及减少运动偏好。交互测试检查单一页面标题、当前导航、搜索不调用 root、出口先选择后应用、后台任务恢复、日志本地筛选与暂停、确认框默认取消。原生 TUN 的应用范围限制、Serve/Funnel 协议和路径、配置修订号与任务取消协议仍是必须保留的回归项。

可取消请求使用 `--request-id <id> <command>`，取消通过 `cancel <id>` 确认。任务替换需等待前一个请求取消成功；取消失败保持错误状态，避免立即启动可能重叠的任务。处于提交阶段的服务控制或恢复事务可能无法取消，应以实际状态刷新结果为准。

顶部服务控件仅使用已确认的实际状态。控制响应失败后仍重新读取状态，提供持续反馈与核验入口；读取失败时开关居中并禁用。`daemon: running, backend: unreachable` 表示进程存活但 LocalAPI 不可用，仍允许停止／重启；不能误显示为已停止。操作与随后的状态核验跨页保留，重启失败不会因进程仍在运行而误报成功。
