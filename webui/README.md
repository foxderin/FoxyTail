# Android Web 界面开发与验证

前端使用 SolidJS、TypeScript 和 Vite，构建需要 Node.js 22.12+（CI 使用 Node 24）和 `package.json` 固定的 pnpm 12.11.2。运行要求 Android System WebView / Chromium 109+；生产和 smoke 构建均使用 `chrome109` 目标。界面只由 APK 承载，不依赖 KernelSU/MMRL 的管理器 JS 桥。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm check:i18n
pnpm check:theme
pnpm smoke
pnpm build
```

在本目录执行以上命令。`smoke` 先构建独立测试 bundle，再运行 jsdom 回归；`build` 输出到 `../android/app/build/generated/webAssets`，由 Gradle 打入 APK。直接构建 Android 也会安装锁定依赖并生成这些资源；不提交生成产物，不向模块打包 `webroot/`。

smoke 使用当前 `FoxyTailNative` 请求/事件协议的隔离夹具，检查真实前端代码的状态和交互边界；它不证明 Android 文件授权、二进制传输、root 或网络可用。原生边界通过 `BridgeInstrumentation` 和隔离设备实际操作验证。

`src/native.ts` 只负责关联请求、回复和事件；`src/api.ts` 区分读取与持久操作。Android 只向 APK 本地页面主框架开放桥，并校验具名动作和参数，不开放任意 shell、远程页面、网络或文件字节通道。页面离开或进入后台可取消读取，但不取消已接受的写操作。

主题采用中性浅色／石墨深色表面与狐狸橙强调色，默认跟随系统。`scripts/generate-theme.mjs` 是语义色值源，`src/theme.generated.ts` 保存生成后的两套 token，手机启动时直接应用。修改色值后运行 `pnpm theme:generate`，再用 `pnpm check:theme` 验证一致性；手机端不运行调色算法，也不加载外部字体。

开发时运行 `pnpm dev --host 127.0.0.1`，打开 `/dev/index.html?lang=zh&theme=light` 使用模拟数据预览。参数为 `lang=zh|en`、`theme=auto|light|dark`、`state=ready|empty|error|slow|login|starting|stopped|proxy|no-root|no-bridge|unknown`。入口 `dev/preview.ts` 与 smoke 共用 `dev/native-fixture.mjs`；预览明确标注模拟数据，系统选择器、真实文件、外链及账号写入不可用。生产只构建根 `index.html`，不包含模拟桥或数据。

主题和语言由原生偏好决定，在 bootstrap 后绘制；不使用 Web 存储覆盖原生设置。服务/任务状态以原生快照为准，设备与出口读取按账号和修订号隔离。普通设置显式保存，保存与应用分开；非敏感表单通过 `app.drafts` 保留，密钥和来源 URI 不进入草稿。

文件页的收件、发送和历史共享保留页面并独立刷新。原生 `files.browse` 发放来源句柄，SAF 和外部分享仅保存原生 URI 授权；`files.send`/`files.retry` 由前台服务接管模块任务。JavaScript 不传递文件字节，不伪造进度。离页不停止传输；取消、接管、未知确认和历史删除是独立操作。

`src/config.ts` 集中数据目录与轮询间隔，`src/settings.ts` 定义设置字段与范围；`SettingsMaintenance`、`SubnetRoutes`、`RoutingApps` 分别负责维护、子网发现和应用选择。

页面由 `navigation.ts` 和 `AppShell` 统一组织；文件为一级导航，出口操作并入节点。`components/Basics.tsx` 提供状态卡、指标卡、骨架与错误重试，`components/ui.tsx` 提供按钮、输入与弹窗。`style.css` 管理通用布局和控件，`pages/network.css`、`tools.css`、`files.css` 维护各领域样式。新增文案按领域存放在 `i18n-*.ts`，中心词典统一导入；词条检查验证对象展开、重复键、空值及中英文对应关系。

视觉验收覆盖手机与宽屏、中文浅色／英文深色、150% 字号、首次加载／空数据／失败重试及减少运动偏好。设备验收还需检查返回键、Activity 重建、分享/通知定位、SAF、来源校验、只读导出和任务恢复；模拟数据不替代 OEM root 授权与真实 Tailnet 验收。

读取取消由原生请求所有权处理；持久操作取消必须携带当前 durable ID，等待模块确认。提交阶段拒绝取消，未知结果不重放；显式确认仅清除对应观察状态，不删除、撤销或回滚底层操作。

顶部服务控件仅使用已确认的实际状态。控制响应失败后仍重新读取状态，提供持续反馈与核验入口；读取失败时开关居中并禁用。`daemon: running, backend: unreachable` 表示进程存活但 LocalAPI 不可用，仍允许停止／重启；不能误显示为已停止。操作与随后的状态核验跨页保留，重启失败不会因进程仍在运行而误报成功。
