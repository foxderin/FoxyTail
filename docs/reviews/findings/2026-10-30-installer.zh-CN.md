# 模块 F 审查：安装 / 升级 / 卸载生命周期 + 打包发布链

- 仓库：`/Users/spark/Development/FoxyTail`（module id `foxytail`，v1.9.0 / versionCode 10900）
- 审查员：rev-installer（只读审查，未修改任何仓库源码，结论为本次唯一写入文件）
- 环境：工作区含大量未提交改动；已先看 `git diff -- customize.sh uninstall.sh install-recovery.sh service.sh .github/tools`
- 使用的方法：逐行读码；`git diff`；`sh -n`；`shellcheck -s sh --severity=style`（0.11.0）；`unzip -l` 校验 dist zip 清单；在 `/tmp` 构建假 `MODPATH`/假 `/data/adb` + mock `iptables/ip/ip6tables/pm/magisk` 实跑 `uninstall.sh`（路径改写，绝不触碰真实 `/data`）；grep 版本号与持久化系统写；读 `tests/` 判定 CI 覆盖面。

## 结论摘要

| 级别 | 数量 | 主题 |
|---|---|---|
| **P0** | 0 | 见下方"为什么没有 P0" |
| **P1** | 3 | 卸载失败即放弃清理；conf 严格白名单阻塞升级；route 状态丢失后残留策略路由 |
| **P2** | 6 | 老控制器 stop 失败即整单失败；bin/scripts 全量继承；备份无保留；recovery 缺口；postinstall 失败不可见；CI 覆盖与 shellcheck 阈值 |
| **P3** | 3 | 误导性 abort 文案；`.new` 钩子提示缺失场景；卸载末行文案与实际不符 |

**为什么没有 P0**：本模块所有网络副作用都是**内核运行态**（iptables/ip6tables 链、`ip rule`、表 1052 路由、tailscale0 接口、`/dev` tmpfs 符号链接），未发现任何 `setprop persist.*`、`settings put`、`/system/etc/hosts`、`/data/adb/service.d` 之类跨重启持久化写入（`grep` 已实证）。因此最坏情形是"**直到下次重启前手机无 DNS/无网络**"，而不是"卸载后永久断网"。这不是免责说明：用户不会因为脚本的失败提示而重启手机，期间的体验就是断网，且模块已被管理器删除、没有任何重试入口（P1-1）。

---

## P1

#### [P1] 卸载时只要控制器返回非零，脚本就彻底放弃清理，而管理器仍会删除模块目录
- 位置：`uninstall.sh:12-20`

```sh
if [ -x "${SCRIPTS_DIR}/start.sh" ]; then
  if ! "${SCRIPTS_DIR}/start.sh" stop; then
    say "! FoxyTail cleanup failed; data retained for recovery"
    exit 1
  fi
elif [ -d "$TS_DIR" ]; then
  say "! FoxyTail control scripts are missing; data retained for recovery"
  exit 1
fi
```

- 问题机理：整个网络/DNS/进程回收**完全委托给 `$TS_DIR/scripts/start.sh stop`**，而 `$TS_DIR` 正是本脚本下一步要 `rm -rf` 的对象。两个分支都是一击失败即 `exit 1`，之后**没有任何兜底**：不 flush `FOXY_DNS`/`FOXY_DNS_QUEUE`/`FOXY_DNS_CAPTURE`/`FOXY_MARK`/`FOXY_STAT`，不删 `ip rule pref 12510`，不删表 `1052` 里 `proto 186` 的路由，不删 `tailscale0`，不尝试 TERM/KILL 残留 PID。这些事实全是脚本内**已知常量**（`foxytail.route:10` `ROUTE_RULE_PREF=12510`、`ROUTE_PROTOCOL=186`、`safe_table` 限定 1052；`foxytail.dns-modern.sh` 的 `MODERN_QUEUE=1053`、`MODERN_QUEUE_CHAIN`/`MODERN_CAPTURE_CHAIN`），所以兜底不需要任何状态文件。
- 触发条件（任一）：`start.sh` 不存在/不可执行（半安装、`switch_install` 中途被打断把 `scripts/` 移进了 `backups/`、被用户手动删过、旧版本没有该文件）；`stop_residents` 里任一 resident 的 `stop` 非零（`tailscale/scripts/start.sh` 的 `stop)` 分支是 `stop_inotifyd || exit 1` → `stop_residents || exit 1` → service stop，任一环失败即非零）；`foxytail.service stop --internal` 因 DNS/route/tun 清理失败返回 1（`foxytail.service:270` 的 `stop_service` 汇总 `_st_failed`）。
- 用户可见影响：管理器删掉 `/data/adb/modules/foxytail` 之后，`FOXY_DNS*`/`FOXY_MARK`/`FOXY_STAT` 链、`pref 12510` 策略规则、表 1052 路由、`tailscale0` 全部留在内核里；DNS 被 REDIRECT/NFQUEUE 到已经不存在的监听者 → **解析全部超时，表现为"手机断网"**，且 watchdog 已被模块带走，不会自愈。直到重启才恢复。提示语 `data retained for recovery` 具有误导性：模块已被删除，**不存在任何"recovery"消费者**（`/data/adb/foxytail` 只会被下一次安装当作旧版本目录读取）。
- 证据：**已实证**。`/tmp` 沙箱（路径改写 + mock `iptables/ip6tables/ip/nft/pm`）结果：
  - 分支 A（`$TS_DIR` 存在、无 `scripts/start.sh`）：`exit=1`，mock 调用日志**为空**（零次 iptables/ip 调用），`$TS_DIR` 保持存在。
  - 分支 B（`start.sh` 存在且 `stop` 返回 1）：`exit=1`，mock 日志只有 `START_SH stop` 一行，同样零次网络清理。
  - 设计意图已被测试固化但只断言退出码：`tests/test_dns_journal_install.py:35-37` 用 `controller.write_text('#!/bin/sh\nexit "${STOP_RESULT:-0}"\n')` 桩化控制器，`uninstall(ok=False)` 只断言 `returncode != 0`，**没有任何断言检查网络规则是否被清理**。
- 修复建议：把"控制器成功"与"清扫完成"解耦。`start.sh stop` 失败后继续走确定性兜底（顺序：`-D OUTPUT -j` → `-F` → `-X` 四张自建链，`iptables`+`ip6tables`；`ip -4/-6 rule del` 精确匹配 `pref 12510`/`fwmark 0x40000000/0x40000000`/`table 1052`；`proto 186 dev tailscale0` 路由逐条删；最后才 `rm -rf`），仅在仍有残留时才 `exit 1`，并把残留清单打印成可直接复制执行的命令。同时把"上次清理未完成"写进 `/data/adb/foxytail.cleanup-pending`，让下一次安装/启动先重试。

#### [P1] 严格 conf 白名单 + "只缺失才拷贝" = 任何键改名/删除都会硬阻塞升级与降级
- 位置：`customize.sh:481-483`、`customize.sh:358-364`、`tailscale/scripts/foxytail.config.sh:172-174`

```sh
# customize.sh:481-483（用【新】settings.sh 校验【旧】用户 conf）
if ! sh -c 'DIR=$2; . "$1"; load_conf' sh "${STAGE}/root/settings.sh" "${STAGE}/scripts"; then
  abort "! Existing configuration is invalid; refusing to execute the old controller"
fi
```
```sh
# customize.sh:358-364（conf 只"不存在才拷"，没有 schema 版本、没有迁移）
for f in "${STAGE}/conf/"*; do
  [ -f "$f" ] || continue
  if [ ! -e "${CANDIDATE}/conf/${f##*/}" ]; then
    cp "$f" "${CANDIDATE}/conf/${f##*/}" || abort "! Failed to stage configuration"
  fi
done
```
```sh
# tailscale/scripts/foxytail.config.sh:172-174（未知键 = 解析失败）
if ! _conf_has_key "${_cpf_name}" "${_cpf_key}"; then
  echo "${_cpf_name}:${_cpf_n}: unknown key" >&2; return 1
fi
```

- 问题机理：安装器在**执行旧控制器之前**用新版本的解析器读用户现有 conf。解析器对未知键、重复键、非法值一律 `return 1`（`_conf_parse_file` → `load_conf` 在 `foxytail.config.sh:283` 传播），于是新版本只要**删除或重命名任何一个 conf 键**，现有用户的升级就会在 `customize.sh:481` 直接 abort。反向（降级/回滚到旧模块版本）同理：v1.9 的 conf 里的新键会让 v1.8 安装器 abort。全仓唯一的迁移逻辑是单键硬编码：`foxytail.config.sh:184` 的 `FWMARK:0xF7 → 0x40000000`。
- 触发条件：未来任一版本删除/改名 conf 键；用户先升级后回滚模块版本；用户按文档"conf 只在缺失时安装、你的编辑会保留"手动加了已废弃键。
- 用户可见影响：升级被拒（`Existing configuration is invalid`），用户不知道是哪个文件哪一行哪个键，也没有"保留旧键继续安装"的路径；同时因为 abort 发生在 `begin_install` 之前，模块安全停在旧版本——但**用户的升级动机（拿修复）拿不到**，只能进 root shell 手改 conf。这与 README:186 "Three files ... installed **only if missing** — your edits survive module upgrades" 的承诺在语义上冲突：编辑"能存活"的同时也会**永久阻塞**未来任何 schema 演进。
- 证据：**已实证**（代码路径闭合：`load_conf` 的返回值经 `sh -c` 的退出码传给 `if !`，且 `_conf_parse_file` 在未知键上明确 `return 1`）。未见任何 schema 版本号或迁移表：`grep -rni "migrat" tailscale/scripts` 只命中一条注释。
- 修复建议：在 `conf/` 引入 schema 版本（例如 `foxytail.conf` 顶行 `# schema=3` 或独立 `conf/SCHEMA`），安装器按版本执行迁移函数表；迁移期把未知键降级为**告警 + 原行保留**（`log Warning` 后跳过该行而不是 `return 1`）；abort 文案必须带上 `_cpf_name`/`_cpf_n`/`_cpf_key`（解析器已经算好了，只是被 `>/dev/null` 丢掉）；在 README 增补"如何回滚模块版本"的 conf 处理说明。

#### [P1] `route.state` 丢失时"清理成功"地留下策略规则与表路由
- 位置：`tailscale/scripts/foxytail.route:217-240`（由 `uninstall.sh` 间接调用）

```sh
  _cl_table=$(state_table)
  if [ -n "${_cl_table}" ]; then
    ...删 rule / proto 186 路由 / 校验 12510 残留...
  fi
  if [ "${_cl_failed}" != 0 ]; then
    log Error "network cleanup incomplete; retained ownership state for retry"
    return 1
  fi
  rm -f "${ROUTE_STATE_FILE}"
```

- 问题机理：`state_table()`（`foxytail.route:90`）从 `${TS_RUN_DIR}/route.state` 读 `ROUTE_TABLE=`。该文件不存在/为空/被截断时，整段 `ip rule`/`proto 186` 删除被 `if [ -n ... ]` 跳过，而 `_cl_failed` 仍为 0 → 函数返回 0 → 调用方认为清理完成 → **留下 `pref 12510 fwmark 0x40000000/0x40000000 table 1052` 与表 1052 里的标记路由**。表号其实是固定契约（README 明写 `ROUTE_TABLE | 1052 | fixed dedicated policy routing table`，`safe_table` 也只放行 1052），并不需要从状态文件得知。
- 触发条件：`run/` 被清空（`start.sh reload` 前的清理、用户或清理类工具删 `run/`、`run` 因 `/data` 临时不可写而未建）、断电时 `route.state` 写入未落盘、旧版本根本不写这个文件（升级后第一次卸载）。
- 用户可见影响：卸载或 `mode` 切换后，命中 `fwmark 0x40000000` 的流量仍被 `lookup 1052` 送进已不存在的 `tailscale0` → 连接超时/无路由，直到重启；并且日志说清理完成，用户无法察觉。
- 证据：**已实证**（代码路径）。`route_cleanup` 仅在 `_cl_failed != 0` 时才 `return 1`，而 `_cl_table` 为空的分支既不打日志也不置位。
- 修复建议：`_cl_table` 为空时回落到固定契约值 1052（`safe_table` 已经限定了它），再走同一套删除与残留校验；把"状态文件缺失，按固定表 1052 清理"记为 `log Warning`。

---

## P2

#### [P2] 任一 resident 的 `stop` 返回非零 → 整单升级失败，且无 TERM 升级兜底、提示误导
- 位置：`customize.sh:452-475`、`customize.sh:486-488`
- 机理：`quiesce_installed` 先做 owner 门禁（`[ "$(cat "${TS_DIR}/.installing")" = "$_INSTALL_OWNER" ] || return 1`），然后 `"${TS_SCRIPTS_DIR}/${_qi_name}" stop || return 1`（四个 resident 逐个）+ `foxytail.service stop --internal || return 1`；只要有一个返回非零就立即返回，**不会**走到 467-474 的 `kill -TERM` 升级与 20×0.2s 等待。调用方 `install_abort "old processes did not stop; old files remain in place"`。
- 触发条件：resident `stop` 因陈旧锁文件/pid 记录不一致/瞬时 iptables 争用返回非零（进程其实已死）。
- 用户可见影响：升级被拒且提示"进程没停"，实际可能是"进程停了但 stop 报错"；用户没有任何自助手段（提示不含哪个 resident 失败、不含错误输出）。
- 证据：已实证（代码路径）；只 `return 1` 无诊断输出。
- 修复建议：失败时记录 `_qi_name` 与子命令输出；对"进程已不存在"的失败不要升级为 abortion（`installed_pids` 已能判定）；把 TERM/KILL 升级作为兜底放在门禁之后而不是成功路径之后。

#### [P2] 升级把旧 `bin/`+`scripts/` 全量继承进新目录，残留文件继续被软链进 `/system/bin`
- 位置：`customize.sh:336-347`、`customize.sh:555-562`
- 机理：`cp -a "${TS_DIR}/${_part}/." "${CANDIDATE}/${_part}/"` 只做**并集**（新文件覆盖同名旧文件），从不删除"新版 zip 里已不存在"的条目；随后 `switch_install` 用 CANDIDATE 覆盖 `TS_DIR`。于是历史上被改名/下线、或用户放进 `scripts/` 的脚本永久驻留。552-562 的软链循环遍历的是 `$TS_SCRIPTS_DIR/foxytail.*`（继承后的目录），只跳过 `*.sh`、`*.yaml`、`*.new` 与硬编码的 `foxytail.webapi.sh`，**其余残留的 `foxytail.<name>` 一律 `ln -sf` 进 `$MODPATH/system/bin`**。
- 触发条件：任一版本重命名/下线一个无扩展名的 `foxytail.*` 入口；用户自己往 `scripts/` 放过同名文件。
- 用户可见影响：`PATH` 上出现指向旧实现的 root 命令（可执行面扩大、行为与当前版本不一致、`foxytail.*` 命名空间冲突）；当前 `git log --diff-filter=D/R -- tailscale/scripts` 为空，说明**尚未真正发生过**，属机制性缺口而非现网故障。
- 证据：已实证（`cp -a` 并集语义 + 软链循环读 `$TS_SCRIPTS_DIR`）。`customize.sh:558` 的 `foxytail.webapi.sh) ;;` 特例正说明这类清理目前靠人肉例外清单。
- 修复建议：维护显式"退休清单"（`VERSIONS` 旁边放 `RETIRED` 列表），`switch_install` 后逐个 `rm -f` 并 `rm -f "$MODPATH/system/bin/<name>"`；或反向改为白名单：软链只对"本次 zip 内实际存在的入口"建链（用 `STAGE/scripts` 的名单，而不是 `TS_SCRIPTS_DIR` 的目录扫描）。

#### [P2] 升级备份无保留策略、无空间预检
- 位置：`customize.sh:272`、`customize.sh:300`
- 机理：每次升级新建 `$TS_DIR/backups/<OLD_CODE>-<ts>-<pid>/`，并把 `bin`（约 22 MB：tailscaled+jq+hev+foxydns+foxyfiles）整体 `mv` 进去；从不 prune，从不在 `mkdir` 前检查 `/data` 余量。
- 触发条件：多次升级/反复重试同一版本（`BACKUP` 含时间戳与 pid，永不碰撞，所以每次重试都留一份）。
- 用户可见影响：`/data/adb/foxytail/backups` 无界增长，挤占用户数据分区；空间耗尽发生在 `begin_install` 之后的 `mv` 阶段，会走 rollback（安全）但用户只看到"安装失败"。
- 证据：已实证（无 prune 调用；`grep -n "backups" customize.sh` 只见创建与路径校验）。
- 修复建议：保留最近 N（建议 2）个备份，`begin_install` 前 `df` 校验剩余空间 ≥ 2×候选体积，超限先删最旧备份再 `install_abort` 并给出清空间指引。

#### [P2] `.installing` 存在但 `.install-transaction` 缺失时，recovery 只删标记、不校验 live 树完整性
- 位置：`install-recovery.sh:172-179`、`customize.sh:305-308`
- 机理：`install_recover_locked` 在无 `.install-transaction` 时走 `rm -f "$TS_DIR/.installing"` 并返回 0（"恢复成功"）。该窗口对应 `customize.sh:305-308` 两条 `mv` 之间（`.installing` 已发布、`.install-transaction` 未发布）。命中时若 `switch_install` 已经开始过（下次启动时 `scripts/`/`bin/` 可能已被 `mv` 进 `backups/`），`service.sh:13` 会认为无需恢复，随后 `service.sh:16` 的 `. "$TS_DIR/settings.sh"` 或 `start.sh` 缺失而失败。
- 触发条件：窄窗口内的硬掉电/被管理器杀进程。
- 用户可见影响：开机 FoxyTail 不启动，用户只看到"模块似乎装了但没网/没状态"，无自愈。
- 证据：待核实（窗口极窄，代码路径成立但未构造复现）。
- 修复建议：`.installing` 存在而无 transaction 时，若 `backups/` 存在任一目录、或 7 个受管部件中有缺失，则视为不可判定并 `return 1`（defer 启动 + 明确提示），而不是删标记后宣告成功。

#### [P2] postinstall 后台启动失败完全不可见，安装仍报告成功
- 位置：`customize.sh:601-602`
- 机理：`"${TS_SCRIPTS_DIR}/start.sh" postinstall >/dev/null 2>&1 &` —— 后台 + stdout/stderr 全丢 + 不检查结果，紧接着打印 quickstart 并结束（退出码 0）。若 postinstall 因 SELinux/端口占用/配置非法失败，用户看到的是"安装成功"。
- 触发条件：`start.sh postinstall` 任一步失败（DNS 端口 1053 被占、`/dev/net/tun` 缺失走 tun 模式失败、conf 值触发运行期校验）。
- 用户可见影响：装完没有服务，需重启才可能恢复；用户没有失败线索（README 只说"或使用安装器打印的绝对路径命令"）。
- 证据：已实证（代码路径）。
- 修复建议：把 postinstall 的前台阶段加超时前台执行并检查退出码（`ui_print "! Service did not start; see /data/adb/foxytail/logs"`），或在后台任务里把失败写入 `$TS_RUN_DIR/last-start-failure` 并在下一次 `status` 显示。

#### [P2] 发布/CI 覆盖面：`--severity=warning` 的盲区 + 卸载/安装行为测试只到"退出码"粒度
- 位置：`.github/tools/verify.sh`（shellcheck 调用与测试编排）、`customize.sh:585`
- 机理与证据（已实证）：
  - `shellcheck -s sh --severity=warning` 会漏掉 **info** 级别问题。本仓实测 `shellcheck -s sh --severity=style customize.sh uninstall.sh install-recovery.sh service.sh` 只报 1 条：`customize.sh:585` **SC2015**，指向 `rm -f "${TS_DIR}/.install-transaction" && rm -f "${TS_DIR}/.installing" || install_abort "cannot commit installation journal"`。该写法在"第一条 rm 失败、第二条成功"时不会 abort（`install_recovery.sh:159` 的 `rollback_install` 末尾同样是这个写法）——即"journal 删了一半"的场景会被当成提交成功。CI 用 `--severity=warning` 看不到。
  - `tests/test_dns_journal_install.py:47-57` 确实**执行**了路径改写后的 `uninstall.sh`，但 `ok=False` 只断言 `returncode != 0`；`tests/test_lifecycle*.py` 对 `customize.sh` 大量使用 `source.index(...)`/`assertIn` 的**文本断言**，无法覆盖"失败分支留下什么副作用"。发布链因此不覆盖"卸载后规则残留"这一最高风险面。
  - `verify.sh` 硬依赖 `sha256sum`（macOS 默认无），而 README:168 让开发者"Run `bash .github/tools/verify.sh`"——本地无法照做。
- 修复建议：`verify.sh` 改 `--severity=info`（或对 sh 脚本用 `--severity=style`）；把 `A && B || C` 改成 `if`/`A; if ! B; then ...`；给 `uninstall.sh` 增加**行为级**测试：mock `iptables/ip/ip6tables` 断言"stop 失败后仍执行了确定性的链/规则删除"；`sha256sum` 缺失时回落 `shasum -a 256`。

---

## P3

#### [P3] 不支持的 ABI 上给出误导性 abort 文案
- 位置：`customize.sh:258-259`
```sh
unzip -qqjo "$ZIPFILE" "tailscale/bin/*-${ARCH}" -d "${STAGE}/bin" ||
  abort "! Failed to extract bundled binaries"
```
- 机理/触发：x86/x86_64（部分平板、Waydroid、模拟器）或未来新 ABI 下 zip 里没有 `*-${ARCH}`，`unzip` 返回 11（no matching files），文案变成"解包失败"，用户会以为是包损坏。
- 影响：用户误判原因（重下 zip 而非"设备不支持"）。证据：已实证（`unzip` 清单只含 `arm`/`arm64` 两个 arch）。
- 修复建议：`case "$ARCH" in arm|arm64) ;; *) abort "! Unsupported ABI: ${ARCH} (arm/arm64 only)" ;; esac`，并把 `unzip` 失败文案拆成"缺本包二进制"与"zip 损坏"两种。

#### [P3] 钩子保留提示只在"模板被改过"时出现，`.new` 文件不会提示用户合并
- 位置：`customize.sh:348-357`
- 机理：用户自定义的 `foxytail.tun.up/.down` 被保留且新版模板写成 `<hook>.new`（软链循环又跳过 `*.new`，正确）；但升级完成后的 quickstart（604-624）从不提及 `.new` 的存在，用户可能永远不知道模板已变。
- 触发：用户改过 tun 钩子 + 新版修改了模板。
- 影响：钩子与新版脚本契约漂移（字段/环境变量变化）而无提示。证据：已实证（代码路径）。
- 修复建议：在 quickstart 段打印 `ui_print "- ${hook}.new saved: review and merge"`（安装期已经算过 `cmp`，顺手记个变量即可）。

#### [P3] 无控制器时卸载仍打印"- FoxyTail data removed"
- 位置：`uninstall.sh:76-80`
- 机理：`$TS_DIR` 完全不存在时，脚本跳过 12-20 的两个分支，直接走到 `rm -rf` 与收尾文案，语义是"已删除"。
- 影响：二次卸载（幂等）时输出与实际略有出入，日志误导排查。证据：已实证（沙箱重复执行 exit 0，文案固定）。
- 修复建议：`$TS_DIR` 不存在时输出"- Nothing to remove"。

---

## 功能闭环缺口

1. **文档承诺 > 脚本实现**：`README.md:55` 写 "every FoxyTail component is stopped, the routing/DNS chains are torn down, and `/data/adb/foxytail` is deleted"，但 `uninstall.sh:12-20` 在控制器失败时三者都不做。README 没有"卸载/清理失败怎么办"的章节，也没有任何自查命令（用户无法确认规则是否残留）。建议补一节 `/dev`+`iptables -S`+`ip rule` 的自查与手动清理命令。
2. **conf schema 没有版本与迁移通道**，而 README:186 承诺"只在缺失时安装，你的编辑会保留"。这两条在"未来删键"时互斥（见 P1-2）。
3. **companion APK 的生命周期只在文档里闭环**：模块永不安装/卸载 APK（`customize.sh:606-608`、README:47/57 一致），但 `uninstall.sh` 完全不知道它存在，卸载时也不提示"APK 仍在，可自行移除"。属可接受设计，但缺口是**卸载提示缺失**。
4. **"保留数据以便恢复"没有恢复方**：`uninstall.sh` 的三种失败提示都以 `data retained for recovery` 结尾，而模块已被管理器删除，恢复脚本（`install-recovery.sh`）也随之消失。要么提供 `/data/adb/foxytail/scripts/...` 之外的自恢复入口，要么改文案为"请重启手机以清除剩余规则"。
5. **CI 不覆盖安装/卸载的副作用**：见 P2 末条。发布链能证明"脚本语法对、元数据一致、原生二进制静态且哈希匹配"，但不能证明"卸载/升级失败后手机还能上网"。
6. **`version-bump.sh` 的一致性面已收窄到 3 个文件**（`module.prop`、`update.json`、`CHANGELOG`），`check-metadata.py` 新增了 CHANGELOG 顶部校验——这一点是好的；剩余风险是 README 里 `FoxyTail-<version>.zip` 之类的示例版本号无人校验（当前 grep 未见硬编码，属低风险）。

## 已检查无问题（含"看起来可疑但实证成立"的项）

- **版本一致性**：全仓排除 `dist/docs/CHANGELOG/node_modules/build` 后，`v1.9.0` 只出现在 `module.prop:3`、`update.json:2`、`update.json:4`；`10900` 只在 `update.json:3`。无漏同步点。
- **Android 侧 versionCode/versionName 不是硬编码**：`android/app/build.gradle:45-46` 是 `versionCode moduleVersion.getProperty('versionCode')`、`versionName moduleVersion.getProperty('version').replaceFirst('^v','')`，`moduleVersion` 从 `../module.prop` 读（`rootProject.file('../module.prop')`）。`android/app/build/**` 里的 `10800` 是**陈旧构建产物**，不是源码缺陷——这一条曾被怀疑为漏同步，实证否决。
- **取消（逆向怀疑已排除）**：`customize.sh:117-120` 提取 `tailscale/scripts/*` 时 `-x 'tailscale/scripts/foxytail.tun.up' 'tailscale/scripts/foxytail.tun.down'`，所以 `customize.sh:347` 的整目录覆盖**不会**踩掉用户钩子；348-357 的 `cmp` 比较对象是"继承自 `TS_DIR` 的用户副本"与"`STAGE/hooks` 模板"，逻辑正确。zip 清单已核对（`tailscale/scripts/foxytail.tun.up` 确实在 zip 内）。
- **zip 解包安全**：全部 `unzip -j`（扁平化，丢弃路径）+ 固定模式白名单（`tailscale/scripts/*`、`tailscale/conf/*`、`tailscale/bin/*-${ARCH}`），未把 zip 内文件名拼进命令；无 `eval`；无 `chmod 777`；无明文密钥；`tailscaled.state` 备份走 `cp → chmod 0600 → mv` 原子发布。
- **二次卸载幂等**：沙箱重复执行 `uninstall.sh`，第二次 `exit 0`（`$TS_DIR` 不存在时各分支自然跳过）。
- **`/dev` 遗留软链清理**：`customize.sh:588-597` 与 `uninstall.sh:63-75` 都用 `[ -L ]` + `readlink` 精确匹配目标才删，不误删无关条目（与 README:73 一致）。
- **`install-recovery.sh` 的 Magisk 语义正确**：它不是对既有文件做 patch，而是在升级时用 `.tmp-$$` + 原子 `mv` 把 `install-recovery.sh` 与 `service.sh` **成对**写入线上模块目录（`customize.sh:96-109`），使"切换中途掉电"仍能在下次开机由稳定引导对恢复；恢复只信任 owner 匹配（pid:starttime:boot_id）的 journal，`install_lock` 是 Lamport ticket + `kill -0` + `/proc/PID/stat` starttime 校验，fo 掉 pid 复用。非数字 ticket 分支（diff 新增）先复核 owner 存活再回收，逻辑正确。
- **权限/SELinux**：`/data/adb` 下用 `set_perm_recursive` 不带 context（有意，避免 relabel 数据分区），`$MODPATH/{service.sh,install-recovery.sh,uninstall.sh}` 与 `$MODPATH/system/bin` 用 `u:object_r:system_file:s0`；conf 目录 0700/0600，二进制 0755。
- **`update-binary` 是标准 stub**（611 B，`MAGISK_VER_CODE < 20400 → require_new_magisk`，`updater-script` 为 `#MAGISK`），与 `customize.sh:25-35` 的版本门禁一致（KSU 分支单独判定，不会因 KSU 无 `MAGISK_VER_CODE` 而误 abort）。
- **上游二进制获取**：light 包缺 `tailscaled/jq/hev-socks5-tunnel` 时走 `install_bin` 下载，失败**必然 abort**（`Unable to obtain …`），不存在"静默继续装一半"；zip 内置的二进制同样过 `verify_bin`/`verify_native_bin` 的 SHA256（tampered zip 被拒），`native-checksums.txt` 要求每个名字**恰好一条**条目。
- **`build-native.sh` ABI 齐全**：`foxydns`/`foxyfiles` × `arm`(GOARM=7)/`arm64` 四个产物，`CGO_ENABLED=0` 静态编译，并用内嵌 Python 直接解析 ELF 头断言无 `PT_INTERP`/`PT_DYNAMIC`（不依赖 `file`），权限 0755。cross 产物齐全，无动态链接器依赖。
- **`verify-backend.py` 确实跑全部 Python 测试**：`tests/test_*.py` 全量并发（≤4 workers，单模块 300s 超时，失败即非零），不是抽样。
- **`release.yml` 的 `--untracked-files=no` 是有意为之**：`dist/`、`tailscale/bin/`、`*.zip` 都在 `.gitignore` 里（`git ls-files dist` 为 0 条），`git status --porcelain --untracked-files=no` 因此只校验"已跟踪文件没被构建过程改动"，符合意图，不是漏洞。
- **`update.json` 可解析且与 tag 校验规则匹配**：`release.yml` 要求 `git show refs/tags/$TAG:module.prop` 的 `version` 等于 tag，`zipUrl` 后缀 `FoxyTail-<version>.zip` 与 `build.sh` 产物命名一致。
