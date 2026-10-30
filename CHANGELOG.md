# Changelog

## v1.11.0 — 2026-10-30 — 文件直存

- 文件机制改为直存：`files-inbox`/`file-read`/`file-delete`/`file-clear` 直接操作 `/sdcard/Download/Taildrop`，接收文件落盘即在列表中，不再经过私有收件箱与"导入/导出"步骤；WebUI 移除导入、导出、另存为与批量导出入口，收件卡片更名为"已接收"并 5 秒轮询自动刷新（遵循全局自动刷新开关）；Android 移除 `files.import`（TransferService IMPORT）与 `files.save`。
- foxyfiles `inbox-list`/`inbox-read` 改为直接以 Taildrop 目录为根（`/sdcard` 前缀逐级校验，拒绝符号链接），过滤传输中的 `*.partial`/`*.deleted`；`file-clear` 同样跳过传输中文件；`receive` 导入机制与 direct-mode 记录簿记整体移除。
- 安全性不变：目录边界校验、符号链接拒绝、非普通文件跳过、名称校验（Unicode 格式字符）、删除/清空二次确认与取消语义保留；`file-export`/`file-export-many`/`file-receive` 命令自 WebAPI、operation 白名单与 WebBridge 校验中移除。
- 全部下拉选择器（主题/语言/DNS/诊断/备份/场景等）统一为弹窗式菜单，触发器样式一致、当前项高亮，修复嵌套滚动容器中被裁切的问题——空间不足时向上弹出或脱离容器浮层定位。
- 实心主操作按钮（生成诊断包、应用、保存、发送、服务控制等）统一右对齐；高级设置、Serve 添加、账户页、authkey 表单等遗漏位置补齐。
- 首页连接卡拆出"本机"行（主机名、IP、运行时长、复制），卡片只保留状态与操作；出口节点行解析显示节点名称而非 ID；设备详情地址行改为同级 复制+测试 图标按钮，测试结果渲染为带延迟/路径/端点的面板。
- 文件页发送卡的设备列表与已选文件列表限高内部滚动，不再撑开页面；步骤标签与引导说明行移除。
- 验证：go test、shell `sh -n`、typecheck、834 组中英词条、主题 token、smoke 277 断言、生产构建全部通过。

## v1.10.0 — 2026-10-30 — WebUI 任务化重构

- 依据 `docs/reviews/2026-10-30-webui-ux-review.zh-CN.md` 完成界面重构：主导航改为首页·设备·文件·网络·设置五区，网络与设置拆为中心页+详情子页，诊断入口合一，出口节点为独立页并支持点选即切换；Android 页面白名单同步更新。
- 顶栏精简为标题与状态胶囊，服务开关/重启/运行模式移入底部状态页和首页连接卡；连接卡按状态机给出单一主操作，已停止/读取失败/无 root 时旧数据标注"上次数据"，登录态不再出现重复卡片。
- 设置与网络修改先进入全局待应用变更集，经逐项审阅面板一次应用，默认走配置试用自动回退；确认弹窗统一为动词按钮与危险样式，错误提示常驻可复制，禁用态改为中性灰并说明原因。
- 文件页改行点开+行尾溢出菜单、长按多选和三步发送流程；日志页改单行工具栏（搜索/播放暂停/溢出菜单）、错误/警告级别筛选与着色、视口填满剩余高度。
- 修复反馈行图标挤压、密钥到期哨兵值显示、网关 IP 折行、诊断标题不随状态变化、只读探测登记匿名任务等问题；停止按钮仅在只读状态下出现并带"紧急停止"文字。
- 验证：typecheck、851 组中英词条、主题 token 与 smoke 259 断言全部通过；手机/桌面/深色/英文视觉抽查通过。原生契约、操作身份、取消语义与陈旧响应防护不变。

## v1.9.0 — 2026-10-29 — MagicDNS 端口劫持模式

- 新增 `DNS_MODE=hijack`：mangle/OUTPUT 把 UDP/53 报文送入 NFQUEUE，foxydns 只读取查询名——命中 MagicDNS 完整名、已知短名或内部 PTR 时，以原解析器地址注入伪造源应答并丢弃原查询；其余报文一律 NF_ACCEPT 原样放行，保留原 socket、UID、路由与解析器路径，不使用公共兜底 DNS。
- 不占用 mark 位、不做 NAT 重定向、不依赖 conntrack 与策略路由，可在 GLUE_CT 缺失或 OEM mark 掩码冲突、透明模式不可用的设备上工作；TCP/53 本期透传。`--queue-bypass` 使辅助进程失效时自动回到原始 DNS 转发。
- `foxydns probe --hijack` 实测 NFQUEUE 绑定与伪造源注入路径（含 SELinux、rp_filter），探测失败或 OUTPUT 策略不兼容时退回本地端点，能力结论按 boot 缓存；状态接口新增 `hijackAvailable`/`hijackUnavailableReason`。
- 设置页新增劫持模式选项与能力置灰，隧道页区分劫持语义提示，诊断面板展示劫持可用性；`foxytail.dns probe-hijack` 暴露独立探测子命令，WebBridge/共存接口接受新模式。

## v1.8.0 — 2026-10-23 — Android WebView 界面

- 使用 APK 内置的 SolidJS/TypeScript 前端替换 Java/View + Material 页面，复用旧 WebUI 组件与视觉样式；保留文件一级导航、节点页出口操作及当前设置、试用、共存、备份和诊断流程。
- Android 仅承载受信任的本地页面及原生能力：具名操作桥校验来源、主框架和参数，禁止任意 shell 与远程页面；文件选择、URI 授权、二进制流、持久任务和后台传输仍由原生侧持有。
- 保留当前包名、偏好、签名与模块数据；恢复非敏感草稿和系统分享/通知入口，不保存登录密钥，不自动重放未知结果。
- Gradle 在 APK 打包前构建前端，CI 增加锁定的 Node/pnpm 工具链与前端验证；移除旧 View 页面、专属资源和失效的界面结构测试，不再依赖管理器 WebUI。
- 系统分享回自己（只读导出 URI）不再误报「仅接受可读内容 URI」：URI 判定统一改为 Models.readableUri，自有 provider 无需临时授权，外部 provider 仍要求 FLAG_GRANT_READ_URI_PERMISSION。
- 取消发送不再叠加两条相同提示：正在发送的任务沿用任务行的「已请求取消，正在等待后台任务确认」，暂存取消立即完成、不再显示误导的等待提示；原生重建后同一操作只保留一条后台任务记录。
- 本地迁移验证：前端 smoke 211 项通过，中英 772 组文案一致；后端 30 个模块通过，Android 构建与 `BridgeInstrumentation` 通过。界面与原生能力在隔离模拟器验证，未覆盖真实 Tailnet、OEM root 授权或生产设备。

## v1.7.0 — 2026-10-16 — APK 原位更新

- 以迁移前 WebUI `bb7af04` 为唯一文案基线，补回 73 组缺失中英文资源，恢复 72 组被截短的原文；同步补齐设置、备份/试用、路由/DNS、共存、节点/流量、账号、文件、日志、诊断及“更多”入口的适用提示与显示条件，不新增自创说明。
- 修正“更多”页双列网格末尾单卡被占位格压成 1px 的高度，确保账号、Serve/Funnel 与设置副标题实际可见，保持原双列排列。
- 修正“连接路径”中接口与网关卡片顶部边框被裁切：共用指标卡片明确顶部对齐，避免底部间距与父行垂直居中叠加产生负偏移；保留原有双列等高、文案与间距。
- 连接路径布局验证：中文手机、英文深色 150% 字号和 975dp 平板下，桥接/TUN/代理三种模式及仪表盘、收件箱共 15 项 Android 模拟器布局检查通过；确认两张卡片等高、完整可见且文字未被纵向裁切，debug APK 与仪器 APK 编译通过（隔离数据）。
- 文件页改为同一 `ControlActivity` 内的保留页面，移除独立 Activity 切入切出；沿用其他页面的淡入/上移动画，保留在途读取、待发与收件选择、目录浏览和传输状态，统一分享、选择器结果与通知入口及返回导航。
- 分享冷启动遇到主题重建时一并保存尚未解析完成的 URI，避免待发列表丢失；清空选择仍会取消这些在途选择的回填。
- 传输进行中收到新的分享或文件选择结果时，显示已有忙碌原因，不再静默忽略；不排队、不自动重试，也不改变当前传输。
- 忙碌分享反馈验证：中文浅色与英文深色 150% 字号各 4 项原生场景通过，覆盖分享/选择器明确拒绝、空闲后用户重新分享及冷启动恢复；运行状态受控注入，未启动真实传输。
- 文件导航验收：中文手机、英文深色 150% 字号、975dp 平板各 15 项原生场景通过，覆盖同页过渡、快速切页、减少动画、草稿/在途读取保留、分享冷/热启动、选择器结果分发、通知返回及重建恢复；仓库仪器回归通过，正式签名 APK 覆盖安装和启动通过。验证使用隔离设备与数据，未覆盖真实 Tailnet 或 OEM root 授权。
- 保留原生显式保存、SAF 和未知结果反馈，不恢复已不适用的管理器打开方式、自动保存或浏览器下载说明；节点路由操作未确认时不提前声称状态已重新读取，共存检查失败优先展示后端原始错误。
- 仪器检查按现有图标无障碍名称查找拓扑、重试、高级设置和目录上级操作，删除检查沿用选择后的删除入口，不再依赖已移除的文字按钮。
- 验证：debug APK 与仪器 APK 编译通过，仓库 `BridgeInstrumentation` 通过；隔离 Android 15 实际页面在中文手机、英文深色 150% 字号和 975dp 平板各通过 21 项提示/条件场景。中英各 847 个 string 键一致、Java 主代码与测试无悬空引用；637 组旧 WebUI 资源与基线原文逐字一致，未确认操作文案保留明确的原生差异。界面使用受控数据，未覆盖真实 Tailnet 或 OEM root 授权。

## v1.7.0 — 2026-10-14 — 操作图标统一与出口合并

- 统一全界面操作图标：刷新/重试/取消/确认等黄色文字按钮全部替换为 Material Symbols 图标，按语义分组（刷新在标题行，保存/分享/复制相邻，删除单独靠右），保留长按提示与无障碍名称。服务开关与连接模式合并到同一行，收件箱查找框右侧图标垂直居中。新增 `ic_edit`/`ic_close`/`ic_save`/`ic_upload_file`/`ic_expand_more`/`ic_expand_less`/`ic_file_open` 官方图标资源，不引入新依赖。
- 出口功能合并到节点页：删除独立出口子页面，节点详情内直接设置/取消出口；文件功能提升为一级导航，替代出口位置。
- 修正顶栏模式选择与重启、停止按钮的错位：窄屏只将服务开关移到上一行，模式和操作按钮始终共行、垂直居中，不缩小按钮触摸尺寸。
- 切换到流量、日志、更多等页面不再无故使已核验顶栏状态过期；真实读取失败、离开前台、账号变化与写后核验仍保留失效保护。
- 区分只读探测和写操作，只读任务或未知探测回执不再冻结独立读取。服务状态与出口路由深检查分离，设备/出口/隧道复用快照，旧身份与旧修订结果不合并；保留写后核验及不安全写入门禁。
- 收件箱使用有界复用列表，搜索不再全量重建；传输历史按任务增量更新，保留展开详情。文件页返回复用未完成读取，目录跳转取消旧请求且保持可操作；收件列表改为原生批量枚举，保留文件名、软链接和路径安全边界。
- 路由后台刷新保留已确认开关的操作能力；出口选择及相同刷新复用现有选项。场景规则与实时网络状态分别加载，设置与试运行组件共享状态读取；无配置依赖查询不再等待配置写锁，兼容性应用清单批量分类。
- 流量改为原生流式聚合并缓存未变化的摘要，保留稳定排序、计数重置、输入身份与失效校验；单任务进度/取消查询不再扫描整份传输历史，保留任务归属与崩溃恢复。
- 另存先选目标，再显示可取消的源文件暂存进度；完整验证后才进入不可取消的目标提交。读取失败或暂存取消不打开目标，目标提供者写入失败不伪装成功。
- 补齐 Taildrop 收件排序、跨筛选多选及批量分享/导出/删除、清空待发列表、删除单条/清空已结束历史。批量结果逐项报告，保留活动任务、未选择文件与原件；分享失败或取消清理已准备副本，授权仅限只读所选文件。
- 新增文件操作沿用 Material Symbols 图标与现有紧凑按钮，提供长按提示和无障碍名称；排序移入图标菜单，常驻文字只保留计数，危险操作仍明确确认。不增加全盘/相册权限。
- 明确后端提交失败直接显示原因，不再一律冒充结果未知；连接中断仍保持未知警告和源文件保留，不自动重发。
- 清理界面冗余与防御性提示（两轮）：删除文件页导入说明（`/sdcard/Download/Taildrop`、保留原件、解锁重启）、发送/选择/进度与「提交不等于送达」提示、备份路径查找提示、诊断与试运行常驻说明、共存向导整段操作说明、日志与流量图表说明、隧道模式与出口范围说明、「更多」页 8 条行副标题等，共删 65 条；把设置项说明、root 与传输错误、诊断结果、root 授权与导出确认等压成一句事实，共改写 74 条（中英双语同步，无引用的死键不计）。破坏性确认、错误原因、隐私与安全警告保留。
- 控制协议仍为 2，新增必需的 `exit-routing`、`context-status` 能力；需配套升级模块与 APK，旧模块不会被当作可兼容写入后端。
- 验证：后端原有 30 模块门禁及修正夹具后的针对性回归通过（本机缺少 mksh 的可选项仍跳过）；Taildrop 原生 race/vet、25 项文件 API、15 项控制回执、10 项入口回归通过，真实 Android mksh/native 核验活动记录、暂存与原件保护。仓库 debug APK 仪器回归通过；Taildrop 中文、英文深色、150% 字号、975dp 平板各通过 10 项真实 View/Provider 交互，原页面四形态各 38 项检查通过；顶栏另验 320dp + 150% 字号。受控数据不代表 OEM root 授权或真实 Tailnet 验收。

## v1.6.3 — 2026-10-13 — 响应与加载状态修复

- 状态读取在单次请求内复用 Tailscale 快照，bridge 查询从 13 次 CLI 调用降至 8 次；保留前后身份、配置和内核规则一致性校验，不以缓存猜测路由生效状态。
- 顶栏与页面合并并发状态查询，冷启动不再重复读取；写操作后的新状态不会被旧响应覆盖。排队读取可在启动前取消，离页取消已登记读取并丢弃过期回调，已接受的写操作不会被本地取消误杀。
- 状态、DNS、试运行及场景读取的子进程纳入取消边界，取消不再等待未登记的出口/路由子进程后继续返回成功；保留配置事务锁与写入保护。
- 日志使用有界复用列表，保留原行号、完整筛选结果复制、换行/横向滚动、跟随末行和文本选择；相同日志刷新不重建行。节点与应用筛选复用现有行，保留详情、共享 UID 选择和分页行为。
- 节点和出口首读即时显示加载状态，失败保留未知状态、禁用不安全写入并提供重试；高级设置与场景编辑器首次展开时才构建，折叠重开保留草稿和编辑器实例。
- 验证：完整本地门禁 30 个后端模块零失败（本机缺少 mksh 的 1 项可选用例跳过），未替换后端的仓库 debug APK 仪器回归通过；隔离 Android 15 真实页面在中文手机、英文深色、150% 字号及 975dp 宽屏各通过 38 项交互检查，另验证慢读取、旧响应隔离、日志滑动与失败重试。Android mksh 取消实测使用隔离路径及可控 CLI；固定数据页面与惰性内核夹具不代表 OEM root 授权或真实 Tailnet 验收。


## v1.6.2 — 2026-10-10 — WebUI 字段与格式复刻、原生迁移审查修复

- 恢复独立救援停止、未知模式显示及确认取消后的快照一致性；写后状态读取排队并排除旧快照，浏览器/Headscale 登录遵守兼容门禁，Serve 旧请求不清除新草稿。
- 统一 Go、shell、Android 收件箱文件名边界；控制字符、无效 UTF-8 与内部保留名按条目隔离，导入/列表/清空报告保留数量，正常文件仍可操作，不改名或删除异常原件。操作查询不再触发容量淘汰；安装器明确要求手动安装同发版独立 APK。
- 恢复手机完整底栏标签、宽屏侧栏及总览分栏、独立出口摘要/离线告警、紧凑设备行与图形拓扑；流量恢复选点读数、无障碍操作和默认折叠数据表，日志首屏可见正文。
- 设置仅为修改/冲突字段显示紧凑操作；路由固定保存区、有界嵌套应用列表及 bridge/owner 能力门控；共存步骤按前提解锁，场景错误留在编辑处，试运行采用本地单调时钟倒计时。诊断失败与未确认新任务不再冒充旧成功。
- 增加文件边界、回执容量、草稿、诊断、路由选项、倒计时与图表交互回归；Android 15 隔离模拟器实际界面核验使用固定 JSON，不代表 OEM root 授权或真实网络验收。
- 以原 WebUI `bb7af04` 为字段、文案与布局基准，恢复 687 组中英文资源、各页分组/披露顺序及 KiB/MiB/GiB、运行时长和文件时间格式，不再以近似 Material 默认样式替代原布局。
- 统一服务/状态/后台任务外壳与 960dp 侧栏；文件页复用外壳并纵向排列收件、发送和历史，目录浏览内联，分区刷新互不覆盖，新回执不被旧历史读取覆盖，分享/通知返回保留文件选择。
- 恢复自定义开关的触摸/无障碍状态、静态字段标签、原版卡片标题操作与响应式指标/节点列表；空兼容告警不再显示 `null`，移除或隐藏骨架后停止无限绘制，日志输入不再依赖已移除的浮动标签父布局。
- 文件页复用实例在主题/语言变化后按新外观重建，仍保留待发选择；实际失败前/修复后场景已核验。13 页使用与原版相同 JSON 对照，手机、975dp/1219dp 宽屏、150% 字号及英文深色各通过 36 项交互检查；夹具仅存在于隔离构建，不进入发布源码。
- 对照原 CSS 修正折叠区图标前景色、18dp 子项间距与末尾留白、危险区透明底色、44dp 按钮及 48dp 服务模式选择器；保留大字号自动增高和取消确认语义。补齐 native helper 前提后，完整后端 30 个模块验证通过（本机缺少 mksh 的可选用例跳过）。
- 高级设置行自带底边线，掩码末行不再漏线且不重复计算折叠区间距；连接徽章的中性底色、警告与离线圆点分别使用原版色值。

## v1.6.1 — 2026-10-10 — 交互修复与 WebUI 规格组件

- 全仓清扫界面"说明书"文案：流量/日志/共存/诊断/备份/试运行/路由/出口/Taildrop 各页的常驻说明压成一句行为事实（中英双语），11 个页面首卡不再重复页面大标题。
- 修复整行/整卡点击失效：默认可选中文本吞掉父容器触摸，仅图标边距可点；卡片标题在状态刷新后被误清空。服务状态改为共享快照（WebUI state.ts 模式），顶栏与首页同源渲染，操作后统一重读，首页不再要等手动重启才同步。
- 设计令牌下沉 dimens.xml（字级/圆角/间距），新增 WebUI 规格组件：色调健康卡、填充式 banner、带单位的指标卡、筛选 chips、骨架屏与 160ms 页面过渡（遵循减弱动画设置）、48×30 底栏指示器。
- 卡片标题移出内容容器：11 个页面重渲染不再误清标题；未知占位改回短词，Tunnel 读取失败不再留空卡。

## v1.6.0 — 2026-10-10 — Android 界面回迁 WebUI 设计体系，APK 独立发版

- 从 v1.4.1 WebUI 构建产物逐项回迁设计语言：狐狸橙 MD3 双主题调色板（浅色 `#B84521`/`#F5F6F8` 灰底白卡，深色 `#15181E` 石墨底）、面板 16dp 描边卡片、11dp 按钮、状态徽章与横幅、Material Symbols 图标全集；品牌标记沿用 WebUI 的橙色 hub 方块。
- 导航改为 WebUI 移动端结构：底部五项（总览/设备/出口/流量/更多）实心选中图标加暖橙 pill，"更多"页按服务/管理分组列出全部入口；删除抽屉。
- 服务开关、模式下拉和重启迁入固定顶栏（对齐 WebUI 顶栏服务控制），状态未知时开关禁用居中、恢复重启保留可达；总览 hero 改为中性状态面板（环形状态图标 + 标题 + 重试），新增设备在线数/运行时长指标卡和 2×2 快捷入口网格，本机卡改为内嵌地址框加复制钮。
- 修复：Material 1.14 按钮/输入框形状需覆写 widget 样式（组件级 shapeAppearance 对按钮无效）；描边按钮禁用态恢复 38% 透明度且图标与文字同色；长错误文本默认折叠三行且不再把页面内容挤出视口；控制通道与页面同文错误去重；关闭 MD3 elevation 叠色。
- **配套 APK 不再打进模块 ZIP，也不再开机自动安装**：`FoxyTail-v1.6.0.apk` 作为独立产物与模块 ZIP 并列发布，纳入同一 SHA256SUMS；请在 Android 中自行安装或更新。模块升级时会清掉旧版残留的 companion 目录与安装器，已安装 App 及其数据不受影响。
- 发版流程合并为单条 Release 工作流：tag 推送后验证、打包、发布一次完成，删除跨 workflow 工件复用与轮询机制；验证门砍掉从不运行的 Android 仪器组装和 lint（保留 shell 检查、后端回归、native race/vet、debug 构建、设置纯逻辑与元数据校验）。

### 升级说明

- 模块 ZIP 照常刷入并重启；App 请从同一发版页下载 `FoxyTail-v1.6.0.apk` 手动安装或覆盖更新（同签名保留数据）。v1.5.x 及以前由模块自动安装的 App 保持已安装状态，此后不再随模块自动更新。

## v1.5.0 — 2026-10-09 — 原生 Material 3 控制面

- Android 应用接管总览、登录/多账号、服务/模式、设备/出口、路由/DNS、设置/场景/试运行、流量/日志、Serve/Funnel、代理共存、诊断及备份恢复；保持 root 模块独立托管网络、身份和配置。
- 使用 Material Components 1.14.0 与 Material 3 中英/深浅色界面，保留系统分享/SAF，并补齐原生共享目录浏览与收件管理。
- 新增协议能力握手、受限持久控制操作及原子结果回执；保留退出码和实际状态，失联不重放，提交阶段拒绝取消。
- 备份/诊断使用私有有界产物令牌和二进制导出，SAF 导入保留双摘要预览和恢复事务；修复 Android mksh 持久 FD 的 CLOEXEC 导致恢复锁无法继承。
- 旋转后重新接管控制回执和 SAF 导入结果；写后读取排队核验，未修改草稿随恢复配置更新，编辑冲突明确提示；未知运行状态与升级期间仍保留确认停止入口。
- 修复场景 down 与配置试运行健康检查交错时误回退：失败后再次检查停止持有状态；试运行安装恢复回归等待真实 worker 退出而非固定休眠。
- 移除 WebUI 源码/静态产物、管理器 JavaScript 桥、Node/pnpm 验证和 base64 内联下载；CLI 与既有配置/身份目录保留，旧自动刷新磁盘键供原生界面继续使用。
- SOCKS 自检改用随包原生 `foxydns`，移除设备 curl 依赖；固定 HTTPS HEAD、Android APEX/系统 CA 校验、10 秒截止、不跟随重定向，真实代理拒绝/超时和取消保持失败。Android 15 无 curl 环境已通过实际 SOCKS→HTTPS 返回 HTTP 301，并验证已应用端口优先。
- 验证包含原生 race/vet、ARM/ARM64 静态构建、Android debug/release 构建与 lint、仪器检查，以及真实 Magisk 下启停/归档/Taildrop 字节核验；MD3 中英、深浅色、字体放大和旋转已实际检查。主机无 mksh 时相关回归显式跳过，CI 安装 mksh；实际 Android mksh 恢复已验证，OEM/KernelSU 全组合仍需实机验收。

### 升级说明

- 从 v1.4.x 升级模块并重启，桌面 FoxyTail 接管控制界面；原 WebUI 入口移除，不清除模块身份、配置或文件。
- APK 随模块同签名更新到 `/data/app`；App 需要单独 root 授权。Android 8.0 以下仍可使用模块 CLI，不提供原生图形界面。
- App 与模块控制协议需配套；仅更新 APK 到旧模块时会禁用不兼容写操作。不要卸载模块来解决 debug/正式签名冲突。

## v1.4.1 — 2026-10-09

- 修复 KernelSU 默认卸载模块导致 systemless APK 在桌面/App 命名空间不可见：附属应用改为随模块携带，由开机包管理器安装/更新至 `/data/app`，保留同签名数据；不关闭隐藏策略或自动授予 root。
- App root 调用使用可信绝对 su 路径、确认 UID 0 并区分启动/授权/模块/后端错误；设备读取失败不再误显示“无设备”，失败时禁用发送并支持刷新。
- 修复早期共享存储不可用遗留的 Taildrop 模式记录：通过当前 daemon 的精确 LocalAPI direct-mode 响应及前后进程身份验证恢复，不猜测模式、不强制重启网络服务。
- Android 16/OPlus + ReSukiSU 真机定位到桌面/App namespace 缺少 APK，而非资源打包错误；同签名包管理器更新与 daemon direct-mode 查询/记录恢复已实测，未关闭 SELinux 或更改 root 授权。
- CI 保留全部回归，独立后端模块最多四路并行，合并 Gradle debug/lint 调用、缓存 Go/Gradle 依赖，并移除非 PR CI 重复的 ARM 编译；构建产物权限不再受签名步骤 `umask 077` 污染。

## v1.4.0 — 2026-10-09

- 隧道页新增只读代理共存向导：基于已应用模式、当前 Tailnet、实际 DNS/SOCKS 端口生成 mihomo/Clash.Meta 合并片段，区分 fake-IP 黑名单、规则模式与 redir-host，拒绝未经审阅的白名单转换；不覆盖外部配置。
- 新增按需 UDP/TCP DNS 精确地址验证与节点 TCP/SOCKS 连接探针，错误逐项保留；当前节点身份、配置快照和前后状态校验防止旧预览或账号切换后误报成功。新 helper 随原有 native 构建打包，无新增依赖版本。
- 稳定原生探针回归的测试夹具：成对分配 TCP/UDP 监听端口，仅对临时端口占用重新分配，并等待 DNS 服务退出；TCP 夹具等待实际连接关闭后再拆除监听，避免并发验证出现假失败。
- Taildrop 文件页改为共享存储浏览与批量选择，最多 32 文件/2 GiB 每文件；新增模块持久发送队列、实际 daemon 字节进度、历史、取消与仅重试未成功项，删除旧同步 file-send 入口。
- 新增原生 Android 附属应用 `dev.foxderin.tail`：系统单/多文件分享、SAF 文件选择、确认发送、收件导入/浏览/打开/分享/另存与历史；前台服务只负责活动任务，保留 WebUI 的其余控制面。
- 使用私有 rooted 文件访问、stdin 二进制暂存和精确传输 ID 关联；成功仅以实际上传响应为准，未知进度不估算。发送任务跨 App/页面退出保留，停止/升级等待取消确认，私有暂存按需过期清理。
- Android APK 使用稳定私有签名并随 light/full 包挂载为普通 system/app 应用，不授予特权；加入 Android 构建/lint、签名和版本校验、原生传输与文件边界回归。
- 发布流水线显式选择 Android `platform-tools`，不再依赖 setup-android 默认安装的已下架 `tools` 包；验证与正式打包使用同一 SDK 配置。

### 升级与验证边界

- 从 v1.3.x 直接刷入 light/full 包并重启；两者均内置 Android 8.0+ 附属应用。首次使用在 Magisk/KernelSU 授予 root；登录、路由、DNS 等控制面仍留在 WebUI。
- 应用使用稳定正式签名；已有不同签名的 debug 应用需先移除该 debug 应用，再安装正式版本，勿卸载模块来处理签名冲突。
- 已覆盖 378 项隔离后端回归、658 项 WebUI smoke 断言、原生 race/vet、Android 构建/lint/仪器检查，以及独立 Android 15 模拟器上真实 Magisk 与两个 tailscaled 的系统分享、字节核验、收件导出、进度、取消和任务接管。
- 模拟器数据面验证不等同于 OEM 真机或 KernelSU 授权弹窗、SELinux enforcing 与后台限制验证；这些组合仍需实机确认。

## v1.3.12

- `v1.3.11` 因账户切换回归的临时目录清理竞争未通过发布门禁，未发布安装包；修正测试等待后台 DNS 重启结束，本版本包含下列实机验证的启动修复。
- 修复 Android 系统 `connmark_mangle_*` 链名被误判为 connmark 保留位冲突：仅解析规则中的 `-j CONNMARK` / `-m connmark`，保留真实位掩码冲突检查，避免关闭 MagicDNS 后旧 DNS 清理仍阻断启动。

## v1.3.10

- `v1.3.9` 标签未通过发布门禁，未发布安装包；本版本包含该批修复及下列监控启动竞争修复。
- 修复 Taildrop 接收时重复导出旧文件及覆盖 Download 内容：只统计新增文件，自动/手动导出共用排他创建，保留带空格等特殊字符的文件名，编号耗尽时安全失败；清空收件箱包含隐藏文件。
- 下载通过私有临时文件与 `jq --rawfile` 传递 base64，避免 Android 单参数长度限制及外部 `printf` 导致的空响应；保留 8 MiB 上限、明确的读取错误和退出清理。
- legacy DNS 撤规则失败时保留解析器，成功重试后才停止；短名和完整名改用精确 hosts 记录，不再接管同后缀公网域名。兼容系统 dnsmasq 2.51，映射位于 `/dev/foxytail-dns/hosts`，不放宽 `/data/adb` 权限。
- 服务启动验证所属 daemon 和 LocalAPI 就绪，残留 socket 不再误报成功；内部重启停止不写用户停止标记，失败后看门狗仍可恢复，显式停止保持优先。
- 启动就绪探测沿用可选 `timeout` 策略：命令缺失时通过现有 `tmo` 记录警告并直接查询 LocalAPI，不再将正常响应的 daemon 误判为启动失败；缺失时单次查询不设时限。
- 配置恢复在目录切换前发布持久事务记录，后续配置读写先恢复中断事务；未提交恢复回滚旧配置，已提交恢复保留候选与原备份，不再静默应用默认值。
- 安装先准备回滚目录再原子发布日志，兼容清理旧版切换前中断；身份与 DNS 偏好恢复使用私有暂存和原子发布，失败或中断后可重试，不把截断文件当成有效身份。
- 移除安装器的 `/dev/tailscale`、`/dev/tailscaled`、`/dev/foxytail.service` 命令快捷方式，首次重启前改用绝对路径并显式指定模块 socket；成功升级和卸载仅清理精确匹配目标的旧自有软链接（含悬挂链接），保留其他同名条目。升级清理失败会警告并继续，卸载清理失败保留运行目录供重试；重启后的 systemless 命令入口不变。
- 出口选择改用稳定节点 ID，协调 profile 偏好与 bridge 公网默认目标；UI 分开显示选中与实际生效，明确 UID/root/IPv6、proxy 和原生 TUN 边界，路由失败可重试且不误报保护。
- 模块根目录在加载运行文件前恢复中断升级，校验事务/备份所有权；试用使用 boot ID 与单调计时，回滚后跨重启保留已接受基线，并比较恢复自有出口偏好副作用。
- 区分用户停止、场景停止和内部关闭；场景 up 不清除用户停止。驻留进程与锁统一验证 PID、启动时间、boot ID 和精确 argv，防止误认及误杀。
- 默认网络、接口、传输类型与 DNS 统一读取 Android ConnectivityService；legacy 上游随网络刷新，未知时降级且不再硬编码公共兜底。DNS 冲突扫描覆盖全端口、范围、多端口、否定与解析失败。
- 透明 DNS 故障保留 repair-needed，按持久自有元组与 conntrack ID 选择性清理 DNAT；legacy 使用独立 connmark 声明。失败保留监听器与恢复记录，升级前无标记流等待过期/重连，不清空外部连接。
- 任务取消失败可重试且保留稍后真实结果；保存、服务控制和恢复跨页面保留所有权，阻止重复操作。恢复预览绑定归档与当前配置双重 SHA256，暂存可取消、提交原子拒绝取消。
- 新增随 light/full 打包的 `foxyfiles`：恢复解包限制压缩/展开/成员大小与数量，拒绝链接及元数据扩展；固定 Android Taildrop 改为导入共享目录已完成文件，保留原件并通过私有收据去重，发送校验节点 ID/IP（含 IPv6）。
- 流量历史改用 1 MiB 分块稳定外排序与流式聚合，保留时钟跳变时的顺序语义；页面一次 summary 覆盖图表/peer/UID，超时和取消监督全部自有后代进程。
- 流量页切换小时/天视图不再先清空已挂载图表；复用同一 summary，保持图表可见。回归实际点击完整周期按钮并校验双向切换、日期桶及数值，避免匹配失败导致假通过。
- 命令超时监控先发布信号处理器就绪状态，再允许父进程终止监控，避免快速失败的备份仍等待完整超时；PID 复用回归改用真实子进程 PID，消除空文件发布竞争。

## v1.3.8

- 修复透明 DNS 状态在内核重刷后的自相矛盾：`transparentAvailable` 与 `capabilityError` 现共用同一份按 boot_id 过滤的缓存，旧内核的失败原因不会再漏到新内核的状态输出。
- Taildrop 收件闭环：拉取改为阻塞等待新文件，收到后自动复制到 `/sdcard/Download` 并触发媒体扫描；收件箱新增下载/导出/删除单个与清空全部操作；发送接受 Tailscale IP 作为目标。发送进度、浏览器直传、Android 分享接入延后到后续版本（见 `docs/plans/2026-10-03-taildrop-overhaul.zh-CN.md`）。


## v1.3.7

- 修复 MagicDNS 在 tailscaled 停止时无法清理的死锁：服务 stop 阶段 daemon 已退出时，accept-dns 恢复会被推迟到下次 reconcile，cleanup 不再因此卡死并阻断服务重启；daemon 存活判断改用进程本身，避免异常退出留下的 stale socket 再次阻断 stop。
- 透明 DNS 模式在内核能力不足或规则冲突时在设置页置灰，不再允许选中一个必失败的配置；能力判定扩展到完整启动门槛（helper probe + capture mark 冲突 + OUTPUT 策略），判定结果按内核 boot_id 缓存，内核重刷后自动失效重判；已运行的 transparent 实例跳过探测直报支持。


## v1.3.6 — 2026-09-21

- 设备页拓扑图改为按实际连接路径绘制：实线表示已建立的直连（提示含对端地址），虚线经对应 DERP 区域中继节点，点线为离线成员；当前使用的出口节点高亮描边。
- 拓扑排序改为直连优先、按中继区域分组、离线靠后；无中继设备时保持原有紧凑布局；旧版后端缺少路径字段时按中继显示，不误报直连。
- 设备列表数据附带当前路径字段（CurAddr/Active）；拓扑标签页纳入 WebUI 冒烟回归覆盖。

## v1.3.5 — 2026-09-21

- 清理无调用方的 WebAPI 命令（key-expiry、mode-get）、service reconcile 子命令、stats recent-files 入口，以及 v1.0.5 之前的 dnsmasq 残留（PID 文件、hosts 清理与旧格式校验）。
- 拆分过大的脚本与前端模块：备份恢复、账号生命周期、DNS 偏好日志各自独立成库；隧道页 DNS 判断逻辑与工具页文案按特性拆分。
- 路径常量、守护状态查询、DNS 健康判断与常驻脚本停止逻辑集中到公共库；合并 DNS 拦截的 IPv4/IPv6 重复实现。
- 看门狗重启限额、窗口、冷却与后端异常阈值、场景检查间隔、流量保留天数可在 foxytail.conf 调整（高级项，不出现在 WebUI 设置页）。
- WebUI 删除 84 个未使用文案键与失效样式，统一加载门控、刷新按钮、防重入读取与复制提示；路由元数据改为单一来源。
- 删除冗余与琐碎测试，修复一个偶发失败的诊断超时回归；功能行为不变。

## v1.3.4 — 2026-09-21

- 修复半满日志停止增长后仍每 2 秒扫描的问题；静止后恢复普通 30 秒、省电 60 秒周期，保留超限轮转。
- 新 DNS 服务的 UDP 空闲读超时由 5 秒延长至 1 小时，减少零请求时的周期性处理；保留 TCP 请求限时和及时关闭。
- WebUI 配置试用回滚失败后停止自动查询，保留错误提示与手动重试；重试执行期间恢复进度跟踪。
- 等待管理员审批时按普通 15 秒、省电 30 秒刷新；保留启动阶段快速刷新及隐藏页面暂停。
- 补充后台日志、DNS 响应与关闭、前端轮询回归，并更新内置 WebUI。实际续航收益仍需设备测量。

## v1.3.3 — 2026-09-19

- 设置新增节能模式，以及看门狗、网络切换主动探测、流量采集、场景自动化和 WebUI 自动刷新的独立开关；保存后重启应用生效，关闭采集或场景功能保留历史与规则。
- 节能模式按亮屏/熄屏降低后台检查频率，暂停网络切换主动探测；保留 Tailscale 主连接和独立 DNS 故障保护。
- DNS 健康监测改用现有本机监听器的内存响应，移除每 2 秒状态落盘、fsync 和守护脚本子进程；仍检测卡死、队列故障及实例更替，故障时撤除透明接管规则。
- 缓存已校验的运行配置，合并流量样本解析，按需读取 UID 计数；看门狗常规查询省略设备列表，避免重复写状态与日志，低流量日志降低轮转检查频率。
- WebUI 隐藏时停止刷新定时器，稳定状态降低刷新频率，空闲配置试用不再每秒唤醒；手动操作和活动试用确认仍可使用。

## v1.3.2 — 2026-09-19

- 设备详情新增按需 IPv4/IPv6 连通性测试，显示实际直连或中继路径；详情随设备列表刷新。
- 诊断页展示本机服务、隧道、路由和 DNS 检查摘要；导出默认统一匿名化账户、设备名、SSID 和地址，可显式选择本机详细包。
- 设置新增限时配置试用、确认与回退；后台计时独立于 WebUI，保留之后保存的设置。
- 场景规则支持可视编辑、排序和高级原文编辑，展示最近一次实际执行结果；备份恢复增加文件选择、差异预览及预览后内容校验。
- 发布复用同一提交通过源码和 Linux 内核检查后的安装包；缺少产物时请求一次验证构建，避免分支、标签和发布重复跑完整检查。

## v1.3.1 — 2026-09-19

- 修复设备页丢失 IPv6 地址：保留节点完整地址列表，列表、详情、拓扑提示、搜索和复制均支持 IPv6；保留旧版单地址字段兼容。
- 拆分 WebAPI、配置事务、共享锁、设置与路由页面、网络样式及测试，集中设置元数据、API 路径与超时；删除废弃 UI 兼容层、未用依赖和重复测试。
- 安装暂存阶段加载同批次共享库，内部库不再注册为系统命令；保留配置校验、安装回滚、身份与用户 hook。
- 固化已保存与已应用配置的隔离，损坏配置下仍可停止、查看日志和恢复；统一锁恢复与长任务取消，保留场景和隧道失败后的重试与清理。
- 更新内置 WebUI；上游二进制版本与已审核 SHA256 清单保持不变。

## v1.3.0

- 新增不依赖特定 VPN 应用的 DNS 模式：内置 `foxydns` 本地端点，以及按内核能力启用的透明共存；升级保留旧模式与端口。
- 新模式支持当前 Tailnet 的完整名、短名、A/AAAA/PTR；透明模式的公网查询保留原 DNS 与 VPN 选路上下文，本地端点对公网名返回 REFUSED，无公共兜底 DNS。
- 原生 DNS 偏好修改增加账户身份校验、持久恢复日志和账户切换保护；透明故障由独立轻量守护撤规则。
- 设置页增加 DNS 模式选择，隧道页显示实际端点、IPv4/IPv6 拦截与可操作的故障状态。
- 固定 Go 1.27.1；arm/arm64 静态 helper 随 light/full 包内置并校验，新增并发、解析、生命周期与 UI 回归。
- 真实 Linux NFQUEUE/conntrack 门禁通过；Android 16 + FlClash 实测本地解析、IPv6、偏好恢复及服务开关。该测试机缺少 conntrack 队列元数据支持，透明模式安全降级，不声称免配置共存已实现。
- 明确报告缺少 `CONFIG_NETFILTER_NETLINK_GLUE_CT` 的能力错误；修复安装器误扫 OEM 非 PID 的 procfs 条目。不接管 DoH/DoT，不自动复制 Tailscale 公司分域 DNS 配置。


## v1.2.1 — 2026-09-09

- Keep the login card hidden while Tailscale reports startup `NoState` or awaits administrator approval (`NeedsMachineAuth`); only an explicit `NeedsLogin` prompts reauthentication.
- Hide stale login/start prompts when status reads fail, and recheck current state before submitting login actions.
- Preserve immediate login access for actual authentication failures without adding polling or a fixed restart delay.
- Fix configuration backups on Android toybox tar by staging the archive layout and using a single working directory; verify archive integrity and return the saved file path and size.
- Keep backups running across page navigation, show persistent errors with retry, retain the latest successful path, and reject incomplete success responses.

## v1.2.0 — 2026-09-09

- Add a Routing control for accepting subnet routes from other Tailscale nodes, backed by the current profile's actual preference and verified after changes.
- List node subnet announcements separately from local routing rules, with one-click CIDR import into the unsaved draft; refreshing announcements preserves local edits.
- Add individual custom IPv4/IPv6 CIDR editing, network-address normalization and deduplication; explicitly report IPv6 routes saved while IPv6 is disabled.
- Keep receive-route changes active across page navigation, distinguish unknown state and failures, and preserve native TUN and bridge routing constraints.
- Restyle the dashboard Tailnet status card after KernelSU's working-state card, with a full tonal surface, official outlined status icons and generous spacing.
- Separate Serve and Funnel protocol validation: Funnel uses supported HTTPS/TCP listeners and public ports, while local HTTP targets and private Serve HTTP listeners remain supported.

## v1.1.0 — 2026-09-09

- Redesign all 13 WebUI pages with a shared component system, neutral light/dark surfaces, semantic status cards, platform icons, skeletons and reduced-motion-aware feedback.
- Add responsive grouped desktop navigation, official Material Symbols icons, accessible controls and a global activity menu for ongoing tasks.
- Keep service, mode and restart controls in the fixed page header; remove duplicate mode and running-state indicators from the dashboard.
- Bound Android process-command reads to prevent stale procfs descriptors from holding service locks; verify actual daemon state after control failures and distinguish unavailable state from a stopped service.
- Detect native IPv6 DNS interception, try existing matching system modules within a bounded budget, and retain IPv6 connectivity and dual-stack DNS mappings when falling back; expose the detected path in Tunnel.
- Preserve full-name AAAA records, normalize Android route ownership output, and wait briefly for xtables write locks to avoid repeated service recovery.
- Make device search/filtering instant, require explicit exit selection application, and show responsive SVG traffic charts with keyboard controls and data tables.
- Group settings by purpose with a persistent pending-application card and lazy advanced reads; add log filtering, line numbers and pause controls.
- Improve account, tunnel/DNS, routing, service mapping, Taildrop and diagnostic workflows with useful loading, empty, error and completion states.
- Distinguish missing interface samples from recorded zero traffic; keep mutation results pending until a fresh status snapshot is available.
- Preserve asynchronous native spawn, first-paint scheduling, exact request cancellation and page teardown behavior from v1.0.5.
- Add isolated populated/empty/error/slow development previews and regression coverage for the redesigned workflows.

## v1.0.5 — 2026-09-09

- Use asynchronous KernelSU/MMRL spawn instead of the blocking exec bridge; defer root calls until after painting and discard reads from pages already left.
- Detach each WebAPI process from the manager app freezer before acquiring configuration locks, preventing frozen requests from blocking the module.
- Reduce shell/jq process launches, avoid redundant status/app queries, and precompute theme tokens to reduce startup JavaScript.
- Use system/vendor dnsmasq when available; resolve Tailnet short names with inline mappings compatible with Android privilege dropping.
- Coexist with the pinned native DNS redirect, route resolver upstream traffic correctly, and refresh negative DNS caches through verified Android resolver interfaces.
- Distinguish local DNS readiness from native Tailnet DNS, and only warn about proxy DNS conflicts when active interception is detected.
- Validate on a rooted Android 16 device with KernelSU 3.3.0, including WebView timing, background freezing and actual short-name resolution.

## v1.0.4 — 2026-09-09

- Treat runtime configuration as validated data with a fixed schema; serialize writes and make backup/restore transactional.
- Isolate policy routing with a masked mark, reserved-table protection, explicit resource ownership, complete drift detection and recoverable apply/cleanup.
- Restrict native TUN to `all`; per-app selected/bypass routing requires bridge mode, and root UID 0 bypasses the bridge tunnel. IPv6 requires explicitly configured IPv6 subnets.
- Stop and verify old components before an upgrade, preserve user files and supplied dnsmasq, and recover interrupted software switches from a rollback journal.
- Reconcile partial service failures and DNS readiness; preserve degraded status and rebuild the resolver after an account or Tailnet change.
- Apply saved settings through a full service/helper reload, keeping a newer concurrent configuration revision marked as pending.
- Correct UID traffic direction and dual-stack counters; aggregate adjacent deltas across counter resets and time-bucket boundaries.
- Replace global process-name cancellation with request IDs and verified child identities; wait for cancellation acknowledgement before replacing tasks.
- Fix first-load error recovery, SOCKS5 probes, account listing, and Serve/Funnel protocol, path and deletion handling in the WebUI.
- Bound runtime logs continuously while preserving open writer descriptors and retaining a capped backup.
- Add 46 isolated backend regressions and expanded WebUI smoke coverage, pin Node/pnpm and WebView targets, and verify committed production assets in CI.
- Build releases from existing version tags; verify reviewed upstream checksums and publish light/full packages with SHA256SUMS.

Android device routing, module-manager installation and coexistence tests remain pending; host regression checks do not replace device validation.

## v1.0.3

- Replace @material/web (Lit) with hand-built native components: no shadow-DOM overhead, lighter bundle
- Fix icon alignment and reduce layout jank across the WebUI
- Watchdog now respects manual stop: it no longer resurrects tailscaled after the user taps Stop
- Improve login error feedback when the daemon cannot reach the Tailscale control plane
- WebUI bundle: 190 KB JS / 14.6 KB CSS (was ~460 KB JS / ~8 KB CSS)

## v1.0.2

- Rebuild WebUI with SolidJS + Material Web (MD3 theme, fox-orange palette)
- Login hero on Dashboard (non-blocking, dismissible), global status indicator in top bar
- API timeouts everywhere; heavy operations are cancellable session tasks that survive page switches
- Instant page switching with skeletons; fast apps listing (single pm call)


## v1.0.1

- Fix KSU/MMRL WebUI exec bridge signature (string options + string callback name)
- Fix watchdog restart loop while backend state is NeedsLogin
- Fix compat probe false positives on sandbox/searchbox packages
- Fix WebUI tunnel gateway parsing
- Silence duplicate route apply on service start
- Tighten stats sample file permissions

## v1.0.0

- Initial release.
