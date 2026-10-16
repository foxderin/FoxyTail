# Android 控制面重写为 Flutter

日期：2026-10-16。状态：**Flutter 重写及本地验证完成，实机发布验收未完成**。用户批准全部 UI 重写，并明确不要求完美还原旧外观：采用合适的 Flutter 最佳实践，不保留不合适的旧设计。尚未批准部署或发版；真实 root/Tailnet/OEM 与 Linux 内核集成未完成，不把本地验证等同于发布验收。

## 1. 推荐方案与范围

**全部应用界面改为 Flutter；保留必要的 Java 平台能力与现有 root 模块。** 这是 UI 与应用状态层重写，不是把网络栈、后台 worker 和系统文件访问一起重写为 Dart。

- 只交付 Android。保持包名、签名、模块协议、数据目录和独立 APK 发版方式；不扩展 iOS/Web/桌面。
- Flutter 负责全部页面、导航、主题、本地化、草稿、列表、图表及页面数据刷新；最终没有 Java View 页面或 WebView。
- Java 保留可信 su 执行、持久操作观察、SAF/URI 授权、文件二进制流、前台传输通知和只读 ContentProvider。
- `tailscale/scripts/`、`native/`、网络生命周期、配置/身份存储、Taildrop worker 不因框架迁移而改写。
- 在开发分支分阶段迁移，完整验收后一次切换发布；不发布缺页版本，不建立永久 add-to-app 双界面、运行时旧版开关或兼容别名。
- 使用 Flutter Material 3 与自适应布局；导航、组件和交互可按最佳实践调整，不逐像素复刻旧页面。完整功能、关键字段、数据与安全契约仍须保留，不借重新设计删能力或扩大常驻说明。

选择理由：文件授权、root 与后台任务是 Android 能力，不会因采用 Flutter 消失。重用这些已实现的边界，比同时重写 UI、权限模型和任务恢复风险更低。代价是仍需维护少量 Java，以及 Flutter 引擎带来的包体、启动与内存成本；不预先承诺更快或更小。

## 2. 现状与迁移基线

### 2.1 本轮核对结果

| 项目 | 当前事实 | 对计划的影响 |
|---|---|---|
| 源码基点 | 盘点开始时 HEAD 为 `9e6b5ef`；工作树已有 32 项 tracked 改动及新增 `FilesPage.java` | 不以 HEAD 单独作为 UI 基线，不覆盖或回退既有工作；实施前冻结完整审阅快照 |
| Android 规模 | 盘点时主代码 36 个 Java 文件、8,287 行 | 不是只迁首页；页面、状态、原生桥接与检查要一起覆盖 |
| 导航 | 16 个可路由目的地；手机五项为总览、节点、文件、流量、更多 | 保留独立工具路由及内嵌形态；不按 Java 文件数增加页面 |
| 出口入口 | 出口选择已并入节点详情；`ExitNodesPage` 无生产构造入口，但仍提供共用解释函数 | 迁移这些函数与实际节点操作，不恢复旧独立出口页 |
| 文案 | 当前中英各 847 个 string，键集合一致；未发布改动恢复了适用的 `bb7af04` 文案 | 不采用历史“779 条”或旧清理口径重新删文案 |
| 构建 | Java 17 源码级别；CI JDK 21；Gradle 9.7.1；AGP 9.3.2；compile SDK 37.0、target 36、min 26 | Flutter 模板不得默默改 SDK 下限、签名或版本来源 |
| 发布 | `module.prop` 为版本源；light/full 模块 ZIP＋一个独立 APK＋SHA256SUMS | 保持用户下载和覆盖安装路径，不把 APK 放回模块 |
| 本地工具 | 当前 PATH 未找到 `flutter`、`dart`；ADB 可用 | 工具链接入属于实施阶段，不把 Flutter 构建当成已经验证 |
| 现有 APK | 本地 release APK 元数据为 `dev.foxderin.tail`、1.7.0/10700、min 26/target 36，大小 6,153,390 字节 | 只是已有产物参考，不证明它对应当前工作树；冻结基线后重建再比较 |

主入口见 [ControlActivity.java](../../android/app/src/main/java/dev/foxderin/tail/ControlActivity.java)，原生边界见 [RootApi.java](../../android/app/src/main/java/dev/foxderin/tail/RootApi.java)、[ControlClient.java](../../android/app/src/main/java/dev/foxderin/tail/ControlClient.java)、[TransferService.java](../../android/app/src/main/java/dev/foxderin/tail/TransferService.java)。构建依据为 [app/build.gradle](../../android/app/build.gradle)、[build-android.sh](../../.github/tools/build-android.sh)、[release.yml](../../.github/workflows/release.yml)。

源码仍在其他会话中变化，以上统计是盘点时记录，不是永久门禁数字。

### 2.2 实施前冻结什么

1. 纳入当前文件页统一、布局修复及文案恢复；冻结代码提交、旧版 APK、截图、对应受控数据与完整功能清单。未提交工作先由其所有者确认归属，不自动清理。
2. 以冻结的当前应用为功能/工作流基线，历史 `bb7af04` 仅用于解释字段与协议，不作为视觉规格。源码已备份至 `/tmp/foxytail-before-flutter-20261016.tar.gz`，不清理既有未提交工作。
3. 使用 Material 3 的 NavigationBar/NavigationRail、标准输入/列表/对话框及语义控件；对中英、浅深色、手机/平板、大字号验证信息完整、布局溢出与可访问性，而非旧控件位置和像素一致性。
4. 记录同设备、同数据、同构建模式的冷启动、首个有效状态、页面往返、长列表滚动、空闲 PSS、APK 大小；制定可接受差异再比较 Flutter，不能拿 debug 模式与旧 release 比速度。

## 3. 目标工程与职责

### 3.1 目录和依赖

采用标准 Flutter 应用布局，继续使用现有 `android/` 宿主，不再嵌套第二份 Android 工程：

| 位置 | 职责 |
|---|---|
| 根目录 `pubspec.yaml`、`pubspec.lock`、`l10n.yaml` | Flutter 应用、锁定依赖、页面本地化；产品版本仍由 `module.prop` 注入 |
| `lib/main.dart`、`lib/app/` | 启动、导航、主题、共享观察状态、平台通道客户端 |
| `lib/features/` | 按现有功能分组的页面与必要 controller；小页面不强制拆多层 |
| `lib/widgets/`、`lib/l10n/` | 真正共用的规格组件、英文/中文 ARB |
| `android/` | Flutter 宿主与保留的 Java 平台实现、Manifest、后台资源 |
| `test/`、`integration_test/` | Dart 规则/交互检查与 Flutter 设备集成场景；不替换现有 Python `tests/` |
| `.github/tools/` | 继续作为统一验证、构建和发布入口 |

技术选择：

- 状态管理先用 Flutter SDK 的 `ChangeNotifier`/`ValueNotifier` 与局部监听；页面状态按功能归属，禁止所有变化触发整页/全应用重建。
- 导航使用 SDK 的 `Navigator` 与现有目的地集合；文件页状态保留，其他页面按实际需求保存草稿。不要用全量 `IndexedStack` 提前创建所有重页面。
- 使用 SDK 本地化工具 `gen-l10n`、`flutter_localizations` 与其配套 `intl`；锁定实际版本。不要增加自行维护的翻译框架。
- 使用 Flutter SDK 的官方 Material 图标，保留动作语义并提供 tooltip 与无障碍标签；不手画图标、不为图标额外引入框架。
- 图表和拓扑按现有有限功能用 Flutter 绘图及语义控件实现，不引入完整图表框架；读屏、键盘和数据表不能因自绘丢失。
- 不预装 Riverpod/BLoC、依赖注入容器、通用 repository/use-case 层、数据库、HTTP 客户端或 headless Dart worker。需要跨边界的模型才定义类型，不逐份复制所有 JSON DTO。
- 沿用 Java 与现有 Gradle Groovy；迁 Flutter 不同时迁 Kotlin/Gradle DSL。

### 3.2 唯一状态所有者

| 状态/能力 | 唯一所有者 | Flutter 的职责 |
|---|---|---|
| 网络、配置、身份、实际操作回执、发送 job | root 模块与现有 worker | 显示实际结果，不模拟后端成功 |
| 控制操作 ID、提交、取消、unknown、结果缓存 | Java `ControlClient`＋原 SharedPreferences | 发起意图、订阅结构化快照；不生成第二份持久任务 ID，不另轮询 `operation-status` |
| URI 暂存、活动发送观察、接管、前台通知 | Java `TransferService`；实际传输属于 root worker | 显示进度/取消结果、刷新历史；不再对同一活动 job 重复轮询 |
| SAF 导入/导出、URI grant、取消/提交边界 | Java 无 View 平台操作与 `ExportProvider` | 呈现确认、选择结果、进度和可取消状态；不搬文件字节 |
| 页面读请求、共享 status/exit-routing、缓存有效性、草稿 | Dart controller | 整体迁移当前 Activity 的观察机制；Java 不保留第二套页面刷新定时器 |
| 主题/语言持久值 | 原 `interface` SharedPreferences，经平台桥读写 | 同步 Flutter 外观并保持原生通知/错误语言一致 |

保留的 Java 不是旧 UI 兼容层，而是最终应用的平台实现。`ControlActivity` 保持类名，改为 Flutter 宿主；不得为了一个 `localized()` 帮助函数留整套 Material View 实现。

### 3.3 最小平台桥接契约

一个应用内 `MethodChannel` 和一个 `EventChannel` 足够。先固定方法/字段，再让页面使用同一客户端；不发布独立通用插件，不同时维护 Pigeon 和手写通道。

| 能力组 | 桥接内容 | 必须保留的边界 |
|---|---|---|
| 普通读取 | 受限命令＋参数、读取关联 ID、取消读取 | 只映射现有查询，不提供任意 shell、任意 root 路径或绕过持久操作的写入口 |
| 控制操作 | 兼容性刷新、submit、reconnect、cancel、acknowledgeUnknown、当前快照 | 继续由 `ControlClient` 分配/落盘操作 ID，提交前落盘失败必须拒绝；取消/未知确认语义不变 |
| 浏览器登录 | 受门禁的短期登录请求、校验后打开 HTTP(S) URL | 不能因为现有代码用 `read()` 调用 login 就把它当普通只读；登录链接不入回执/恢复数据 |
| 文件与产物 | 选择文件/备份、解析授权元数据、发送/接管/取消、收件打开/分享/另存、产物导出 | 数量/大小/路径/URI 校验在原生仍执行；只传元数据、URI、令牌和进度 |
| 系统集成 | 外部分享、通知定位、选择器结果、通知权限、外观设置 | 冷启动及 `onNewIntent` 都能交付，Flutter 未就绪时保留待交付入口；消费后不重复导入或发送 |

快照至少保留现有 `busy/submitting/unknown/canWrite/canStop/canCancel/ownsMutation`、操作 ID/command、`observationRevision/accountRevision`、任务状态/取消状态及完整结果。失败不能压成一句字符串：保留 `RootApi.Failure.result` 和 `exitCode`，需要的终态随回执传递。`message/detail` 只用于展示，不可解析人话反推协议状态。

桥接生命周期约束：

- 耗时 root、流式 I/O 和解析使用现有执行器，不能阻塞 Android 主线程；通道回调与系统 UI 调度遵守 Flutter 线程要求。
- 订阅时返回当前快照，再连续观察；重连不依赖某个曾发出的“一次性完成事件”。快照与变化用现有 revision/关联 ID 排除旧结果。
- 退订/离页只解除观察或取消该页只读请求，**不能取消已经被模块接受的写操作/发送**。ControlClient 无监听者时停止观察轮询，重新监听时接管。
- 原生任务持有 application context，不长期持有旧 Activity/EventSink。Activity 重建后重新绑定，选择器结果不能只交给已销毁的 Dart Future。
- 选择器请求/待处理入口与恢复状态要关联；临时 URI grant 可能失效，恢复后重新检查，不凭保存的 URI 字符串宣称有权读取。
- 文件内容不得跨通道为 base64、整块字节数组或文件长度级缓存；保持 `ContentResolver ↔ su stdin/stdout` 二进制流。
- 原生导出操作拥有“准备中可取消、开始写目标后不可取消”的栅栏；Flutter 显示 `canCancel`，关闭弹窗不自行推断取消成功。

## 4. 全功能迁移与验收矩阵

下表源码名相对 `android/app/src/main/java/dev/foxderin/tail/`。每项必须覆盖正常、空、加载、失败/未知、陈旧数据及相关操作中状态；不是仅做静态布局。

| 功能 | 源码 | 保留内容与重点验收 |
|---|---|---|
| 外壳/导航/更多 | `ControlActivity`、`ControlUi`、`MorePage` | 总览、节点、文件、流量、更多五个主目的地；窄屏 NavigationBar、宽屏 NavigationRail；返回栈、服务/模式/重启/救援停止、任务列表及定位；无效路由回总览；文件在同一外壳内 |
| 总览 | `OverviewPage` | 连接状态、兼容/密钥到期警告、在线计数、运行时长、本机双栈地址、DNS/中继、出口选择与实际效果、快捷入口和登录；未知不显示为停止/健康 |
| 节点/出口 | `PeersPage`、`PeerTopologyView`、`ExitNodesPage` 共用函数 | 搜索/状态筛选、列表/拓扑、详情、复制、双栈探测、出口测速与选择/清除；图示限制不截断完整列表；回包匹配节点/地址/账号 |
| 隧道与 DNS | `TunnelPage` | tun/bridge/proxy 信息、接口/网关、进程、DNS/IPv6/透明拦截/降级、SOCKS 检查、DERP 测速；轻量状态不等深检查，失败不伪造可用 |
| 代理共存 | `CoexistPage`、`ToolsData` | 内嵌及独立路由；分步解锁、三种支持的配置片段、节点/端口/resolver、DNS UDP/TCP/目标 TCP 检查；不自动改第三方配置；参数/环境变化使旧结果失效 |
| 账号 | `AccountPage` | 当前/其他账号、浏览器/AuthKey/Headscale 登录、切换、注销；活动发送阻止账号变更，历史未知不能放行；AuthKey 不保存/不自动填充；退出/提交清理敏感输入 |
| Serve/Funnel | `ServePage`、`ToolsData` | 私有/公开、HTTPS/HTTP/TCP/TLS→TCP 合法组合、Funnel 端口和公开确认、精确删除 handler；提交后新输入不被旧回执清空 |
| 路由 | `RoutingPage` | 子网接收开关/通告列表、CIDR、IPv6 状态、all/selected/bypass、应用搜索/共享 UID 联动/分页、固定保存区；per-app 仅 bridge＋owner 支持可编辑；隐藏选择器不丢草稿 |
| 设置 | `SettingsPage`、`SettingsState` | 外观、DNS/IPv6/端口、省电/watchdog/probe/stats/context/自动刷新/间隔/日志大小；逐字段保存、冲突/重载、保存待生效、重启门禁；高级 table/mark/mask、只读 hooks 与诊断 |
| 场景 | `ContextPage`、`SettingsRules` | 设置内嵌及独立路由；可视/文本、SSID/蜂窝、增加/编辑/排序/删除、错误与冲突；原文、未知规则、注释、空行及 CRLF 保留；48 KiB 按 UTF-8 字节计 |
| 试用 | `TrialPage` | 内嵌/独立、候选模式、30–300 秒、开始/确认/回退、原因；单调时间从请求发出时计，慢响应不延长窗口；rollback-failed 仍活动，关闭自动刷新不关闭活动观察；回退由模块执行 |
| 备份恢复 | `BackupPage`、`BackupImport` | 内嵌/独立、生成、列表、SAF 导入、保存/分享、差异/hooks 预览、双 SHA256 确认、恢复结果；变更选中/配置/操作使预览失效；不包含身份，不恢复后自动重启 |
| 流量 | `TrafficPage`、`ToolsTrafficChart` | 小时/天、双线图选点、总计、展开数据表、节点/应用排行；缺采样不当成零；手势不抢纵向滚动，键盘/读屏可操作；数值/时间格式一致 |
| 日志 | `LogsPage` | 来源、100/200/500/1000 行、搜索/大小写/实时/跟随/换行、刷新/复制；显示控制字符转义，复制保留原始全文和空行；原行号/滚动/焦点保留 |
| 诊断 | `DiagnosticsPage` | pass/warn/fail/skip、详情、分享版/详细包、隐私确认、保存/分享；新任务的失败/未知不能复活旧“通过”和旧产物 |
| 文件收件 | `FilesPage`、`ExportProvider` | 导入、搜索/四种排序、跨筛选最多 32 项、打开/另存/分享/导出/删除/清空；超限全选整次拒绝、部分失败逐项反馈、原件不删除、导出不覆盖 |
| 文件发送/历史 | `FilesPage`、`FilesBrowser`、`TransferService` | `/sdcard` 浏览＋SAF 混合选择、目标、确认、清待发、真实字节进度、取消/接管、仅重试失败/取消项、删除终态历史；32 文件/每个 2 GiB、目录 1000 项、历史 100 条边界不退化 |
| 系统入口/权限 | Manifest、`ControlActivity`、`FilesPage` | launcher、SEND/SEND_MULTIPLE、通知历史、SAF 返回、选择器取消、权限拒绝；外部分享只准备待发，不接受 root path/目标 extras 自动发送；只读 grant、无多余存储权限 |

### 4.1 页面状态不能简化的部分

- 共享 `status` 是服务条、总览、节点的同一轻量快照；`exit-routing` 独立更新，必须匹配身份和 revision。写操作前发出的旧读取不能吞掉写后核验。
- `canWrite` 继续要求协议 2 及 `exit-routing`、`context-status` 等现有能力；兼容时独立停止入口不能因未知普通状态而消失。
- 普通页离开停止轮询、取消读取并忽略迟到响应；文件页保留分区在途读取和选择，返回不重复排队。隐藏页不常驻轮询，已接受后台任务继续。
- 保持现有自动刷新/省电/日志实时与试用活动观察的关系，不统一改成一个更激进的全局定时器。
- 账号改变即失效相关快照、目标和结果，确认新的身份后再允许写。特别验收“账号变化时 Files 旧目标/历史迟到”；当前保留页面与账号失效边界的覆盖仍需实测，不能直接宣称现状已完全正确。
- 草稿采用原来的 baseline/draft/saved 三方合并；保存完成只合并本次提交版本，不覆盖用户随后输入。未改草稿跟随外部更新，脏草稿保留并标冲突。
- unknown、stale、failed、confirmed-empty 是不同状态；非零退出仍保留实际结果字段；`completed` 不能绕过 `ok/exitCode/applied` 判断。

### 4.2 视觉与文字

- 采用 Material 3 色彩、排版与组件规格，保持 FoxyTail 品牌辨识；不继承旧界面不合适的密度、双层导航或自绘控件。内容宽度受限，支持窄屏、平板和大字号。
- 中英页面文案迁入 ARB，保持字段、占位符、原文及显示条件。原生后台所需 `R.string` 留在 Android；原生返回错误不在 Dart 复制另一份状态文案，更不从文字推状态。
- `WebFormat` 的 B/KiB/MiB/GiB、精度、时长与本地时间格式逐项迁移。通知仍需要原生字节格式化；不能因删 Java 页面而删除这条依赖。
- 紧凑图标操作保留 tooltip、无障碍名称、危险操作分组和取消优先焦点；不扩成整排说明按钮。
- 系统字体缩放、TalkBack、键盘/焦点、文本选择、RTL 布局支持、安全区、键盘遮挡、返回和减少动效一起验收；不得通过全局限制 textScale 掩盖布局问题。

### 4.3 中英资源无损迁移

在 P2 用一次性 XML→ARB 转换工具机械迁移已冻结的页面资源，不手录、不重译；转换工具和全量比对夹具验收后移除，不建立长期 XML/ARB 双向同步。当前实查中英各 847 个 `<string>`、1 个四项 `<string-array>`，无 `<plurals>`、无 string 内嵌样式元素；实施时按冻结快照重新枚举，不把这些数量写死。

1. 按调用归属区分 Flutter 页面资源和仍供原生后台使用的资源；保留原资源名到 ARB 消息 ID 的映射。共享标签逐项确定归属，不能因为转换完成就删除全部 Android XML。
2. 用 XML 解析器处理实体，再按 Android 资源规则处理转义、引号和空白；已有 `\n` 必须成为同一处实际换行。ARB/ICU 的字面花括号和单引号独立转义，不用通用字符串替换或 `unicode_escape` 解码整份中文。
3. 现有 `%1$s`、`%2$d` 等按参数编号转成稳定的命名占位符，例如 `{arg1}`/`{arg2}`，生成 String/int 类型元数据；保留每种语言的参数顺序、重复引用和原文字面。格式语义同时核对调用方，不能仅凭 `formatted="false"` 判断不替换：`repair_files_ignored_inbox` 带此属性，但页面实际传入计数。冻结快照若出现其他格式，先列出人工核对，不静默丢弃或改格式。
4. `taildrop_sort_orders` 的四个 item 按原下标生成消息键，并在调用处组成同顺序列表；保留“最新、最早、名称、大小”的下标语义，不能按翻译文字重新排序。当前没有 plurals，不趁迁移重写单复数文案。
5. 将中英 parity 核对扩展为：ARB 消息键集合一致、占位符编号/类型一致、数组项完整且顺序一致；保留原生 XML 的中英 parity。用一次性样例参数核对旧 Android 实际格式化结果与新 Dart 渲染结果，包括换行、百分号、引号、Unicode 和参数换序；再核对实际页面。完成迁移后不保留硬编码整篇文案的永久测试。

ARB 与必要原生 XML 各自成为所负责表面的唯一文案来源；生成的 Dart 本地化文件不手改、不在发布构建中回写受控源文件。

## 5. 数据、升级与安全契约

### 5.1 不迁移存储格式，先保持原数据

| 数据 | 当前位置/所有者 | Flutter 版处理 |
|---|---|---|
| 模块身份、配置、文件、回执/worker | `/data/adb/foxytail` 及现有共享收件目录 | 保持目录、协议和保留策略；不迁进 Dart sandbox，不卸载模块 |
| 外观 | SharedPreferences `interface`：theme/language | 原生桥继续读写原文件，不另用 Flutter 插件默认存储生成第二套值 |
| 控制观察 | `control-operation`：id/command/label、accountRevision、result.*、resultTime.* | 原 `ControlClient` 直接读取与接管；不初始化覆盖、不中断后重复提交 |
| 传输准备/接管 | `transfer`：request/preparing/staged/job/snapshot/message/busy | 原服务沿用，区分准备中断与模块已接受；未知提交保留来源，不自动重发 |
| 备份导入 | `backup-import`：pending/token | 保持中断反馈与令牌消费语义；不把 pending 当成功或自动重读来源 |
| 导出 | `exports` 元数据＋`cache/exports`，authority `dev.foxderin.tail.files` | 不主动清除现有有效副本；缓存仍存在且未到期时旧 URI 可读，仍只读且最多 24 小时，不承诺缓存永不被系统清理 |
| 页面草稿/导航/待保存选择 | Activity Bundle，文件页单独 saved state | 用 Flutter restoration 与宿主 saved state 保持系统重建恢复；不新增永久草稿数据库 |
| AuthKey/登录 URL | 临时内存 | 不进入 restoration、日志、分析、SharedPreferences 或通用错误上报 |

**草稿承诺边界：**当前支持页面往返与 Android 提供 saved-instance-state 时的重建恢复，不保证未提交草稿跨 APK 升级、强停、清任务或设备重启可靠保存。Flutter 迁移不伪造这项保证。升级前需结束依赖 App 的准备/导出操作并保存编辑；模块已接受任务和持久记录按原语义接管。

### 5.2 必须保留的 Android 入口

- `applicationId/namespace = dev.foxderin.tail`，沿用正式签名，保持 `ControlActivity` 类名与 `singleTop` 分享入口；不更换包名规避升级问题。
- `TransferService` 仍非 exported，`ExportProvider` 仍非 exported＋单 URI 只读授权，内部签名权限不削弱；通知 PendingIntent 指向新的同名宿主。
- 继续 `allowBackup=false` 与现有 data-extraction exclusions，不让引擎模板或插件重开自动云备份。
- 发布 Manifest 不增加所有文件/媒体权限、VPN service、root HTTP 服务或无需求的 INTERNET 权限；Flutter debug/profile 调试权限与 release 分开核对。
- 保留 App UID 自己获 root 授权的模型。相同包名/签名用于无损覆盖安装，但不据此保证所有 OEM/root 管理器都不再询问授权。
- SAF 输入在 App UID 内读取；外部传入 file URI、任意 root path、无读取授权 URI 均拒绝。后台不依赖 FlutterEngine 存活。

### 5.3 原生依赖的收敛顺序

- `RootApi`、`ControlClient`、`TransferService`、`ExportProvider`、`BackupImport` 及其实际用到的 `Models` 校验留下。
- 从 `ControlActivity/FilesPage` 提取 SAF、外部入口与导出操作的无 View 部分，不顺便创建新的持久任务系统。
- 将 `ControlUi.localized` 移入保留的平台代码；将 `Models.bytes/state` 所依赖的后台格式/资源保留。错误处理、文件名/URI/大小验证不能跟 View 一起删掉。
- `SettingsRules/SettingsState/ToolsData` 的页面规则与对应行为检查迁 Dart；先迁所有调用，再删 Java 版本。`ToolsData` 对 CIDR 的依赖、`ExitNodesPage` 共用函数必须一起覆盖。
- 最终删除全部 Java 页面、View 控件、仅 UI 的资源与 Material Components 依赖；只保留宿主/启动主题/图标/平台层实际资源。不保留 deprecated 页面、重导出或隐藏备用入口。

## 6. 分阶段实施

阶段间按真实依赖推进。每阶段先完成该批代码、调用方、检查迁移和文档，再统一验证；不每个小改动重跑全仓。只有完整通过阶段出口，才扩展下一批页面。

| 阶段 | 交付内容 | 出口条件 |
|---|---|---|
| P0：冻结基线 | 保存现有源码快照、旧 APK 和功能清单；确定隔离验收环境，记录现有性能参考 | 用户已批准新设计方向；保留既有工作，不从脏树直接 `flutter create .` |
| P1：工具链＋原生纵向闭环 | 根 Flutter 工程、固定 SDK、同名宿主、最小平台桥；真实后台握手/读取、一个受控持久操作、断开重接；提前证明 SAF 输入/只读导出这条高风险通路；接通第 7.1 节两路设备检查 | 隔离设备能运行，不是空壳；主线程不卡，事件重连有当前快照，进程重启不重复提交，Android 构建/签名/ABI 可用；原生 runner 与 Flutter CLI 检查各自执行成功 |
| P2：外壳＋只读页面 | 主题/中英、按第 4.3 节机械转换页面文案、手机/平板导航、任务展示、共享 status；更多、日志、流量、总览只读区域 | 资源映射/占位符/数组/中英 parity 与真实屏幕对照通过；日志全文复制、图表缺口/选点/语义和长列表成立；状态不重复拉取 |
| P3：网络与控制 | 完整总览/登录、服务控制、节点/拓扑/详情出口、隧道/DNS/共存、账号、Serve/Funnel、诊断 | 写入门禁、未知/取消、活动传输阻断、身份/旧响应隔离、实际工具结果与产物路径全通 |
| P4：配置与恢复 | 路由、设置、内嵌及独立 Context/Trial/Backup、只读 hooks；纯规则迁移 | 草稿冲突/提交后新输入不丢、UID/CIDR/48 KiB 边界、单调倒计时、试用回退、双摘要恢复和 SAF 导入通过 |
| P5：文件完整闭环 | 收件/浏览/混选/发送/历史、系统分享/通知、批量动作、导出准备/提交取消边界、服务接管 | 真实字节比对、后台发送/取消、部分失败、未知不重发、返回/旋转/外观变更不丢选择；不是只完成收件列表 |
| P6：完整切换与发布验收 | 迁移剩余行为检查、删除已替代的 Java UI；更新构建/CI/双语 README/CHANGELOG；同签名覆盖升级与回退方案验收 | 第 7 节全部完成；最终 APK 无旧页面/试验入口，安全与数据契约保留；获发布许可后走现有 Release 流程 |

P1 先贯通文件平台能力，避免把权限/生命周期可行性拖到最后；P5 才完成文件页全部 UI 与业务组合。中间开发版本仅用于隔离验收，不作为可交付成品。

桥接契约与外壳固定后，可并行迁移“日志/流量”“网络/账号”“配置”“文件”四个功能组；每组独占功能目录和对应检查。宿主、通道、Manifest、共享状态、依赖及发布脚本由一个集成负责人维护，避免多方同时改核心文件。

## 7. 验证与完成标准

### 7.1 检查如何迁移

- 保留 Android 原生的可信 su、失败分类、二进制完整性、源/目标边界、URI/provider、取消提交栅栏、任务恢复检查。
- `SettingsRulesTest` 及页面工具规则迁为 Dart 行为检查；迁完才移除 `verify.sh` 里的旧 javac/java 入口，不能用“构建成功”替代规则覆盖。
- `ShellStateChecks`、`NetworkListChecks`、`SettingsViewChecks`、`FilesViewChecks`、`TrafficChecks`、`LogsChecks` 中有价值的交互行为迁 widget/integration checks；旧 Java 控件构造、反射字段与固定文案断言删除，不按新源码形状重新写一遍。
- `BridgeInstrumentation` 收敛为保留的平台契约检查，Flutter 集成单独运行；不能拿旧 runner PASS 宣称 Flutter 页面已测。
- 不增加只验证通道转发、资源文本、mock 回显或“非空/不抛错”的测试；新检查集中在实际状态转换、错误、权限、边界与数据损坏风险。

**设备检查共存决策：保留自定义 runner，Flutter 集成使用 CLI 运行模式，不引入第二个 instrumentation runner。**

| 检查路径 | 构建/执行方式 | 证明范围 |
|---|---|---|
| 原生平台契约 | 保持 `testInstrumentationRunner 'dev.foxderin.tail.BridgeInstrumentation'`；构建普通 debug 应用与 `assembleDebugAndroidTest`，确认安装的是本次两份 APK 后运行 `adb -s <设备> shell am instrument -w dev.foxderin.tail.test/dev.foxderin.tail.BridgeInstrumentation` | 保留的 root、文件、provider、原生生命周期边界；不等于 Flutter UI 已验收 |
| Flutter 集成 | 在仓库根使用固定 SDK 的 `flutter test integration_test/app_test.dart -d <设备>`，入口使用 `IntegrationTestWidgetsFlutterBinding`；只加入 SDK 自带 `integration_test/flutter_test` 开发依赖 | 通过设备上的 Dart VM service 执行 Flutter 交互并调用真实平台桥，不构建/运行 AndroidJUnitRunner 测试 APK |

官方另有 `@RunWith(FlutterTestRunner.class)`＋`AndroidJUnitRunner` 的 instrumentation/Test Lab 运行方式，本计划**不采用**该路径，因此不需要额外 `<instrumentation>`、测试 flavor 或将现有 runner 全部改写为 JUnit。SDK 固定后在 P1 实际跑通上述两路；不能只依据文档宣布共存验证通过。

两路在独占的验收设备串行执行，明确区分普通应用入口与 Dart 测试入口，不能把 Flutter 集成临时 APK 当作发布或升级验收包。Flutter 工具可能安装、停止或清理测试应用；不能指向生产设备或他人模拟器，升级数据验收使用单独隔离设备/快照。Flutter finder 不能操作原生 SAF/权限弹窗；这些跨应用步骤由原生检查或实际设备操作补足，不能改成 mock 选择器冒充端到端。

### 7.2 必须留下的实测证据

1. **实际 UI**：中文浅色手机、英文深色手机、150% 字号、975dp 平板；另核对 320dp 窄屏大字、自适应导航断点两侧、横屏/分屏、键盘/安全区、减少动效、TalkBack。验证字段和操作完整、无溢出/遮挡、焦点与可访问性，不以旧像素布局为门禁。
2. **状态并发**：慢读取后切页/切账号/写操作完成；旧回包不覆盖新状态、深探测不阻塞基本状态、重复进入不重复排队，Files 保留读取不绑定错误账号。
3. **数据恢复**：编辑中旋转/重建/改主题语言、选择器返回、浏览器登录返回；控制回执未知后重连；发送准备前/后杀进程与覆盖升级。区分内存草稿、持久观察、模块任务，分别记录结果。
4. **真实 root**：隔离环境实际通过 App UID 的 su 完成握手、启停/模式/配置、账号操作、回执和取消；不将 ADB root 或 mock backend 当成 App 授权成功。
5. **真实文件**：系统单/多分享、SAF 多选/拒绝/撤权、未知长度、空文件、合法复杂文件名、32 项及 2 GiB 边界；实际 tailscaled 双端发送并做字节/哈希比对。准备中取消、提交后拒绝取消、提供者写失败、批量部分失败与源文件保护都要覆盖。
6. **真实后台**：离页/关闭 Flutter UI 不停网络或已接受发送；回前台/通知正确接管；拒绝通知权限仍能在 App 查看/取消；Magisk/KernelSU 及目标 OEM 后台限制列出实际覆盖设备，不外推模拟器结果。
7. **规模与性能**：同基线数据的百节点、数百应用、1000 收件项、100×32 历史文件、1000 日志行；虚拟列表、增量更新、滚动/焦点与图表检查；量化包体、冷启动、首状态、PSS/帧时间，不因换 Flutter 宣称优化。
8. **安装兼容**：同签名旧正式版→Flutter 新版，不卸载、不清数据；确认 prefs、原生组件/URI、身份/配置/文件、活动 job 观察。错误签名拒装是预期，不自动卸载绕过。
9. **发布产物**：debug 与真实 release 均运行；检查包名/版本/签名/不可调试/Manifest 权限/ABI/16 KiB 页兼容/许可证；模块 ZIP 不混入 Flutter 源码、缓存或 APK，SHA256SUMS 覆盖全部产物。
10. **完整门禁**：保留现有 shell/Python 后端、native race/vet、Linux 内核门禁及元数据检查；增加固定 Flutter 工具链的分析/必要行为检查/构建；设备场景在隔离设备统一执行，给出实际通过数与未覆盖项。

所有测试数据、账号和网络使用本地或独立验收环境，不连接生产 Tailnet、不更改生产 root 配置、不使用真实密钥或付费生成额度。当前多个模拟器存在其他会话安装，不能仅凭 serial/versionCode 判断空闲；先确认占用并使用隔离设备，不覆盖他人的夹具。

**完成定义：**第 4 节所有能力与第 5 节所有兼容契约有对应实现/证据；不存在暂时返回空列表、假成功、无操作按钮、仅 mock 的平台实现、缺页、旧 UI 回退或“后续补齐”的发布版本。未验证的 OEM/root 组合明确列出，不冒充全平台验收。

## 8. 构建、CI 与回退

### 8.1 工具链接入

- 实施固定 Flutter 3.47.7 stable / `abaf9c523780a608bd46686fd5e53740a07077f8`、Dart 3.13.5，应用依赖锁文件已提交到工程；本地和 CI 使用同一 pin。
- 保留 Java 源码与 Gradle Groovy。固定 Flutter plugin 实际会在 `android.builtInKotlin=false` 时应用 `kotlin-android`；AGP 9.3.2 自带的 KGP 2.2.10 低于其校验下限，故在 settings 插件范围固定模板 KGP 2.4.0，不跳过校验。Flutter loader 与应用插件共享构件，AGP 同样在 settings 声明以保证 API classloader 可见；不修改 SDK、不降级 AGP。
- 工程保持 JDK 21＋AGP 9.3.2＋Gradle 9.7.1＋compile SDK 37.0/target 36/min 26；已实际通过 Flutter plugin 构建、两路设备检查及 debug/正式签名 release。没有降级 Android 支持范围或绕过依赖校验；本地通过不代表 Flutter 官方对该完整组合提供测试背书。
- 本轮所读 Flutter `master` 的模板为 Gradle 9.5.0/AGP 9.3.1，`maxKnownAndSupportedGradleVersion=9.5.0`，AGP 兼容建议上界为 9.4，默认 compile/min/target 为 36/24/36。**这些不是所选 stable 版本的完整支持矩阵**：源码注明部分上界只服务于兼容性建议，Kotlin 上界也不适用于本项目的纯 Java 决策；compile SDK 37 不同于模板默认值不等于不支持。Gradle 9.7.1 超出这份源码标注的 CI 已知范围，是需记录的验证风险；实施时改查固定 SDK revision 的同一源码与 release notes，不把移动的 master 数字直接写进工程。自有 smoke 通过也不宣称获得官方全组合测试背书。
- 有需要再固定 Flutter 引擎要求的 NDK；新增 `.so` 后检查 ZIP 与 ELF 的 16 KiB 对齐并实际启动，不能只看 Java 编译成功。
- 初次安装 SDK/引擎/Pub/Gradle/NDK 需要准备依赖；缓存完整前不承诺全离线构建。之后记录离线可复现条件，签名材料与产物不进入依赖缓存。

### 8.2 具体触达文件

| 文件/目录 | 实施时修改 |
|---|---|
| 根 Flutter 清单、`.gitignore` | 新 Dart 工程/锁文件；忽略 SDK 本地路径、`.dart_tool`、build 和私密材料，不覆盖原忽略规则 |
| `android/settings.gradle`、`android/build.gradle`、`android/app/build.gradle` | Flutter plugin 接入与仓库解析；保留版本来源、正式签名缺失即失败、SDK 边界；核对 release shrink/资源行为 |
| Manifest、Android 资源与 Java | 宿主生命周期/入口、平台桥、无 View 系统操作；删除替代页面，保留原生必要资源与备份限制 |
| `.github/tools/build-android.sh` | 保持唯一正式 APK 构建入口及 `debug/release + output.apk` 调用契约；Flutter 调用只放在该脚本内部，不内联进 `build.sh`；版本参数和输出路径按下节处理；继续 apksigner/aapt 检查 |
| `.github/tools/verify.sh` | 加 Flutter 分析、相关行为与构建；替换已迁移的 Java 规则入口，保留其他门禁 |
| `.github/workflows/shellcheck.yml`、`release.yml` | 固定 Flutter SDK revision 与安装动作版本、SDK/引擎/Pub 缓存；依赖锁文件强校验、生成物与干净工作树门禁；同一次运行验证后签名发布；PR 不读取正式签名 secrets |
| `.github/tools/build.sh`、`tests/test_release.py` | 保留脚本参数与三份被校验产物约定；现有夹具在临时根替换 `build-android.sh`、要求 `$1=release` 并写 `$2`，不得绕开它。若以后改变外部契约，必须同改夹具；本迁移无需改变 |
| `README.md`、`README.zh-CN.md`、`CHANGELOG.md` | 在实施后更新工具链、目录、平台职责、验收命令、升级与已知限制；本计划不把未来行为写成当前事实 |
| `module.prop`、`update.json`、许可证清单 | 仅正式发版阶段按现有脚本更新版本；补 Flutter/图标/新增依赖的许可证，不重签或泄露密钥 |

正式 APK 继续一个文件，覆盖目前模块支持的 ARM32/ARM64；模拟器所需架构纳入对应测试构建。是否额外发布按 ABI 拆分 APK 不属于本轮默认范围。不能为了包体直接丢弃 ARM32 或提高 minSdk。

**版本与输出路径固定规则：**

- Flutter 根目录就是仓库根。`build-android.sh` 从 `module.prop` 读取去掉开头 `v` 的 versionName 与整数 versionCode，传给 `flutter build apk` 的 `--build-name`、`--build-number`；继续保留 Gradle 从同一 `module.prop` 读取版本的现有覆盖，防止直接 Gradle 构建走另一来源。不以 pubspec/local.properties 的值发布，也不为注入版本改写 pubspec 或锁文件。
- 正式构建显式 `--release --target-platform android-arm,android-arm64`，使用普通 `lib/main.dart` 入口，**不加 `--split-per-abi`**；debug 使用 `--debug` 及工具默认支持的调试架构。固定 SDK 的 `--no-pub` 还会跳过按模式生成插件注册，实测会使 release 引入 `integration_test` 后编译失败，因此 APK 构建不传该参数；不手改生成文件或将测试插件塞进发布依赖。
- 同步将 Flutter/Gradle 的构建目录接为仓库根 `build/`，构建脚本读取 `build/app/outputs/flutter-apk/app-<variant>.apk`，不再读取旧 `android/app/build/outputs/apk/...`。P1 核对实际产物后固定该路径，不用 glob 猜测最近 APK。
- `apksigner` 及 `aapt dump badging` 继续对实际输出校验签名、`dev.foxderin.tail`、与 `module.prop` 完全一致的版本及 release 不可调试，再复制到调用方 `$2`。正式命名仍为 `FoxyTail-<module.prop version>.apk`，SHA256SUMS 仍恰好覆盖 light ZIP、full ZIP、一个 APK。

**发布构建不能改写受控文件：**

- 固定 SDK 下先执行 `flutter pub get --enforce-lockfile`，锁文件缺失、与清单不符或内容哈希变化即失败；分析/测试使用 `--no-pub`，APK 构建使用已准备的锁定依赖并正常生成对应模式的插件注册，不在发布期间运行 upgrade。Pub/引擎缓存键包含 SDK revision、宿主平台和 lockfile 摘要，缓存不包含签名与产物。
- `gen-l10n` 输出到明确忽略的生成目录（如 `lib/l10n/generated/`），在干净 checkout 中由已提交 ARB 确定性生成；SDK 本地路径、`.dart_tool/`、构建产物和插件生成元数据同样不纳入受控源码。
- 现有 `release.yml` 的 `test -z "$(git status --porcelain --untracked-files=no)"` 保留。SDK 自动迁移或构建改写 Gradle、Manifest、pubspec.lock 等受控文件时直接阻止发布；在开发分支审阅并提交所需变更后重新验证，不能靠忽略/还原变更绕过门禁。未跟踪生成物不由这条命令覆盖，仍按 `.gitignore` 与模块打包 allowlist 单独管理。

### 8.3 升级与回退

- 开发保留旧版源码/签名产物作为基线，不在最终 APK 保留旧 UI。全功能和覆盖升级验收通过后再正式切换。
- Android 通常拒绝低 versionCode 覆盖安装；回退不能依赖让用户卸载、清数据或强制降级。
- 回退预案为：用冻结的旧 UI 源码、相同正式签名及**更高 versionCode**构建修复版本，通过现有版本/模块元数据发布流程交付；前提是本次保持存储/模块协议不变，且在隔离设备验证能读取新版留下的持久状态。
- 发布前记录 APK 证书指纹和 SHA256；只使用已有签名材料，不读取或输出密钥内容，不生成替代正式密钥。

## 9. 已批准决策与实施闸门

用户已批准实施，最终决策：

1. **全部 UI 用 Flutter，保留必要 Java 平台层和现有 Go/shell 后端。** 不追求“零 Java”。
2. **Material 3 最佳实践，不逐像素还原。** 当前工作树作为功能基线，可改善旧设计，但不删功能与必要反馈。
3. **Android-only、同包名/签名、一个 APK。** 完整验收后一次切换，不发布长期混合界面。

实施从 P0/P1 推进。下列情况才需要重新裁决：框架组合要求改变 Android 支持范围、包体/启动/内存出现显著不可接受退化，或需要不兼容的数据/协议变更。不能以赶进度为由自行缩减功能或验证。

## 10. 依据与本轮验证边界

官方依据：

- [Flutter 平台通道与线程模型](https://docs.flutter.dev/platform-integration/platform-channels)
- [Flutter Android 嵌入与 Activity 生命周期](https://docs.flutter.dev/add-to-app/android/add-flutter-screen)——仅作为宿主能力依据，不代表采用永久 add-to-app 产品架构。
- [Flutter AGP 9 / built-in Kotlin 迁移说明](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin)
- [Flutter 支持的平台/架构](https://docs.flutter.dev/reference/supported-platforms)
- [Flutter 本地化](https://docs.flutter.dev/ui/internationalization)
- [Flutter Android 构建发布](https://docs.flutter.dev/deployment/android)
- [Android 16 KiB 页支持](https://developer.android.com/guide/practices/page-sizes)
- [Flutter 设备集成的 CLI 运行方式](https://docs.flutter.dev/testing/integration-tests#test-on-an-android-device) 与 [integration_test 的原生 instrumentation 备选方式](https://github.com/flutter/flutter/blob/master/packages/integration_test/README.md)
- [Flutter 集成测试设备实现](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/lib/src/test/integration_test_device.dart)——CLI 路径启动应用并连接 VM service，不要求替换 Android runner。
- [Flutter Gradle 默认值/兼容建议](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/lib/src/android/gradle_utils.dart) 与 [构建依赖检查器](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt)——master 仅作本轮研究依据，实施改用固定 SDK revision。
- [Android 字符串、格式与数组资源](https://developer.android.com/guide/topics/resources/string-resource) 与 [Pub 锁文件强校验](https://dart.dev/tools/pub/cmd/pub-get#enforce-lockfile)

规划阶段只执行了源码/文档/CI 盘点、资源核对、旧 APK 元数据和只读设备查询。用户随后批准实施，并放弃逐像素还原；旧 Java 页面已由 Flutter 功能组替换，必要平台类保留。

实际构建、行为测试、设备与签名验收结果记录在 CHANGELOG 的未发布条目：105 项 Dart 检查、真实平台桥中英页面往返、132 张有数据 UI 场景截图、原生仪器、系统 SAF/分享、同签名受控数据覆盖升级，以及既有后端/native 门禁均有本地证据。临时 UI 夹具已删除，普通 debug 与正式签名 release 从 `lib/main.dart` 重新构建。本计划的历史盘点数据不当作新实现已经通过的证明，未覆盖的真实 Tailnet/OEM 环境、Linux 内核、16 KiB 实机页大小与同数据性能基准不得外推。
