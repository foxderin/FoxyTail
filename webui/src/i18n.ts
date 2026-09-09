/*
 * FoxyTail WebUI — i18n dictionaries (zh / en), reactive t().
 * Keys migrated 1:1 from the hand-written webroot/i18n.js, plus the
 * login-hero keys. scripts/check-i18n.mjs enforces key parity.
 */
import { createSignal } from 'solid-js';

export type Lang = 'zh' | 'en';

const zh = {
  no_root_banner: '请在 KernelSU 管理器或 MMRL 中打开本页面（未检测到 root 执行环境，功能已禁用）',
  nav_dashboard: '仪表盘', nav_peers: '节点', nav_exitnodes: '出口', nav_traffic: '流量', nav_more: '更多',
  loading: '加载中…', empty: '暂无数据', error: '出错了',
  save: '保存', cancel: '取消', confirm: '确认', delete: '删除', add: '添加',
  copy: '复制', copied: '已复制', open_browser: '浏览器打开', apply: '应用',
  offline: '离线', close: '关闭', cancelled: '已取消', retry: '重试',
  op_failed: '操作失败', confirm_title: '请确认',
  misc_missing: '（缺失）', misc_empty: '（空）', misc_unavailable: '（不可用）',

  dash_daemon: '守护进程', dash_backend: '后端状态', dash_mode: '运行模式', dash_uptime: '运行时长',
  dash_running: '运行中', dash_stopped: '已停止',
  dash_start: '启动', dash_stop: '停止', dash_restart: '重启',
  dash_self: '本机', dash_hostname: '主机名', dash_relay: '中继', dash_magicdns: 'Tailnet MagicDNS',
  dash_exitnode: '出口节点', dash_no_exitnode: '未使用出口节点', dash_traffic: '流量',
  dash_peers_online: '在线节点', dash_peers_offline: '离线节点',
  dash_key_expiring: '节点密钥即将到期：', dash_compat_warning: '共存告警',
  dash_action_done: '操作完成', dash_mode_switched: '模式已切换，服务重启中',
  dash_status_stale: '数据可能过期',

  hero_login_title: '登录到 Tailscale', hero_login_desc: '设备尚未接入 tailnet，完成登录后即可使用全部功能',
  hero_stopped_title: '服务未运行', hero_stopped_desc: 'tailscaled 守护进程已停止，启动后可继续使用',
  hero_start_service: '启动服务', hero_get_link: '获取登录链接',
  hero_minimize: '收起', hero_expand: '登录 / 启动',
  hero_banner_login: '尚未登录 tailnet', hero_banner_stopped: '服务已停止',

  peers_title: '节点', peers_list: '列表', peers_topology: '拓扑',
  peers_empty: '没有发现其他节点', peers_detail: '节点详情',
  peers_rx: '接收', peers_tx: '发送', peers_tap_hint: '点击节点查看详情',

  exit_title: '出口节点', exit_test: '测速', exit_testing: '测速中…',
  exit_use: '使用此节点', exit_clear: '取消出口节点', exit_current: '当前',
  exit_empty: '没有可用的出口节点', exit_set_done: '出口节点已切换', exit_cleared: '已取消出口节点',

  acc_title: '账号', acc_login: '登录', acc_login_url_hint: '复制下面的链接并在浏览器中完成授权：',
  acc_already: '当前已登录，无需再次授权', acc_waiting: '正在获取登录链接…',
  acc_authkey: 'Auth Key 登录', acc_authkey_hint: '粘贴 tskey-auth- 开头的密钥',
  acc_login_authkey: '使用 Auth Key 登录',
  acc_headscale: 'Headscale / 自建控制服务器', acc_headscale_hint: 'https://headscale.example.com',
  acc_login_server: '登录到该服务器',
  acc_accounts: '多账号切换', acc_current_badge: '当前', acc_switch: '切换',
  acc_logout: '退出登录', acc_logout_confirm: '确定退出登录？需要重新授权才能使用。',
  acc_switched: '已切换账号', acc_logged_out: '已退出登录', acc_logged_in: '登录成功',
  acc_not_logged_in: '未登录',

  tun_title: '隧道', tun_iface: 'tailscale0 接口', tun_up: '已启用', tun_down: '未启用',
  tun_gateway: '网关', tun_hev: 'hev-socks5-tunnel', tun_pid: 'PID',
  tun_not_running: '未运行', tun_socks_check: 'SOCKS5 自检', tun_socks_checking: '自检中…',
  tun_socks_ok: '代理可用', tun_socks_fail: '代理不可用',
  tun_derp: 'DERP 中继测速', tun_derp_testing: '测速中…', tun_preferred: '当前最优',
  dns_title: 'MagicDNS 状态', dns_hint: 'Tailnet 开关、本机短名解析和原生 TUN 完整域名解析分别检查。',
  dns_check: '检查 DNS 状态', dns_local: '本机短名解析', dns_native: '原生 DNS 规则已安装', dns_suffix: '域名后缀',
  dns_running: '运行中', dns_disabled: '已关闭（不代表 Tailnet MagicDNS 关闭）',
  dns_apply_pending: '设置已保存，待应用', dns_disable_pending: '等待关闭',
  dns_tailnet_unavailable: 'Tailnet 不可用，请检查登录状态', dns_missing_binary: '找不到 dnsmasq',
  dns_conflict: '与其他 DNS 代理冲突', dns_redirect_failed: 'DNS 转发规则应用失败',
  dns_cleanup_failed: '旧 DNS 规则清理失败', dns_process_failed: 'DNS 进程启动失败',
  dns_reconcile_needed: '节点或配置变化，等待更新', dns_private_dns: '系统严格私人 DNS 可能绕过本机解析',
  dns_stopped: '已停止', dns_degraded: '状态异常，请查看服务日志',

  route_title: '路由', route_scope: '路由范围',
  route_scope_all: '全局', route_scope_selected: '仅选中应用', route_scope_bypass: '绕过选中应用',
  route_scope_all_hint: '所有应用流量都经过隧道（受子网列表约束）',
  route_scope_selected_hint: '只有勾选的应用经过隧道',
  route_scope_bypass_hint: '勾选的应用不走隧道，其余全部走隧道',
  route_no_owner: '内核不支持 xt_owner，按应用路由不可用。请选择全局范围。',
  route_native_scope: '原生 TUN 模式由 Tailscale 管理路由，仅支持全局范围。按应用路由需切换为 bridge 模式。',
  route_apps: '应用列表', route_apps_search: '搜索应用…', route_apps_loading: '正在枚举已安装应用（可能需要数十秒）…',
  route_subnets: '路由子网', route_subnets_add_hint: 'CIDR，例如 100.64.0.0/10',
  route_subnets_invalid: '无效的 CIDR 格式', route_apply_done: '路由配置已应用',

  traffic_title: '流量', traffic_hourly: '按小时（今日）', traffic_daily: '按天（近 7 天）',
  traffic_app_tx_hint: '显示已配置子网的应用发送量（IPv4 + IPv6），不含接收量。',
  traffic_topn: '节点排行', traffic_by_app: '按应用', traffic_no_data: '暂无采集数据（采集器需运行一段时间）',
  traffic_rx: '下载', traffic_tx: '上传', traffic_touch_hint: '触摸图表查看数值',
  traffic_uid: 'UID ',

  serve_title: 'Serve / Funnel', serve_serve: 'Serve（tailnet 内）', serve_funnel: 'Funnel（公网）',
  serve_kind: '类型', serve_proto: '协议', serve_port: '端口', serve_target: '目标（如 http://localhost:3000）',
  serve_add: '添加映射', serve_empty: '暂无映射', serve_del_confirm: '删除该映射？',
  serve_unavailable: '当前 tailscale 版本不支持此命令',

  files_title: '文件', files_inbox: '收件箱', files_empty: '收件箱为空',
  files_send: '发送文件', files_path: '/sdcard 下的文件路径', files_path_hint: '/sdcard/Download/example.zip',
  files_peer: '目标节点', files_send_btn: '发送', files_receive: '拉取待接收文件',
  files_sent: '发送完成', files_received: '拉取完成',

  logs_title: '日志', logs_daemon: '守护进程', logs_service: '服务脚本',
  logs_follow: '跟随滚动', logs_empty: '日志为空',

  set_ipv6_hint: '启用前请先在路由子网添加 IPv6 CIDR，例如 fd7a:115c:a1e0::/48，否则无法应用。',
  set_restart_required: '配置已保存，重启服务后生效', set_apply_restart: '重启并应用', set_applied: '配置已应用',
  set_title: '设置', set_general: '常规', set_saved: '已保存',
  set_context: '网络环境感知规则', set_context_hint: '每行一条：<触发>:<值>:<动作>[:<参数>]，如 ssid:HomeWifi:down、cellular:-:no-exit-node',
  set_hooks: 'tun 钩子（只读）', set_hooks_hint: '请通过终端编辑：/data/adb/foxytail/scripts/foxytail.tun.up / .down',
  set_hook_up: 'tun.up', set_hook_down: 'tun.down',
  set_backup: '备份配置', set_restore: '恢复配置', set_backup_done: '备份已生成：',
  set_restore_hint: '/sdcard 下的备份文件路径', set_restore_done: '已恢复（原配置备份于 ',
  set_restore_confirm: '恢复会覆盖当前配置，继续？',
  set_theme: '主题', set_theme_dark: '深色', set_theme_light: '浅色', set_theme_auto: '跟随系统',
  set_language: '语言', set_ui: '界面',

  diag_title: '诊断', diag_run: '生成诊断包', diag_running: '正在收集（可能需要半分钟）…',
  diag_done: '诊断包已生成：', diag_hint: '包含日志尾部、状态快照、iptables 自检与配置（密钥已脱敏），用于反馈问题。',

  more_title: '更多', more_tunnel: '隧道', more_routing: '路由', more_account: '账号',
  more_serve: 'Serve/Funnel', more_files: '文件', more_logs: '日志',
  more_settings: '设置', more_diag: '诊断',
} as const;

export type I18nKey = keyof typeof zh;

const en: Record<I18nKey, string> = {
  no_root_banner: 'Open this page in KernelSU manager or MMRL (no root exec bridge detected; features disabled)',
  nav_dashboard: 'Dashboard', nav_peers: 'Peers', nav_exitnodes: 'Exit', nav_traffic: 'Traffic', nav_more: 'More',
  loading: 'Loading…', empty: 'No data', error: 'Something went wrong',
  save: 'Save', cancel: 'Cancel', confirm: 'Confirm', delete: 'Delete', add: 'Add',
  copy: 'Copy', copied: 'Copied', open_browser: 'Open in browser', apply: 'Apply',
  offline: 'Offline', close: 'Close', cancelled: 'Cancelled', retry: 'Retry',
  op_failed: 'Operation failed', confirm_title: 'Please confirm',
  misc_missing: '(missing)', misc_empty: '(empty)', misc_unavailable: '(unavailable)',

  dash_daemon: 'Daemon', dash_backend: 'Backend', dash_mode: 'Mode', dash_uptime: 'Uptime',
  dash_running: 'Running', dash_stopped: 'Stopped',
  dash_start: 'Start', dash_stop: 'Stop', dash_restart: 'Restart',
  dash_self: 'Self', dash_hostname: 'Hostname', dash_relay: 'Relay', dash_magicdns: 'Tailnet MagicDNS',
  dash_exitnode: 'Exit node', dash_no_exitnode: 'No exit node in use', dash_traffic: 'Traffic',
  dash_peers_online: 'Online peers', dash_peers_offline: 'Offline peers',
  dash_key_expiring: 'Node key expires soon: ', dash_compat_warning: 'Coexistence warnings',
  dash_action_done: 'Done', dash_mode_switched: 'Mode switched, restarting service',
  dash_status_stale: 'Data may be out of date',

  hero_login_title: 'Log in to Tailscale', hero_login_desc: 'This device is not connected to the tailnet yet; log in to unlock everything',
  hero_stopped_title: 'Service stopped', hero_stopped_desc: 'The tailscaled daemon is stopped; start it to continue',
  hero_start_service: 'Start service', hero_get_link: 'Get login link',
  hero_minimize: 'Minimize', hero_expand: 'Log in / start',
  hero_banner_login: 'Not logged in to the tailnet', hero_banner_stopped: 'Service stopped',

  peers_title: 'Peers', peers_list: 'List', peers_topology: 'Topology',
  peers_empty: 'No peers found', peers_detail: 'Peer details',
  peers_rx: 'RX', peers_tx: 'TX', peers_tap_hint: 'Tap a node for details',

  exit_title: 'Exit Nodes', exit_test: 'Speed test', exit_testing: 'Testing…',
  exit_use: 'Use this node', exit_clear: 'Clear exit node', exit_current: 'Current',
  exit_empty: 'No exit nodes available', exit_set_done: 'Exit node switched', exit_cleared: 'Exit node cleared',

  acc_title: 'Account', acc_login: 'Log in', acc_login_url_hint: 'Copy the link below and finish authorization in a browser:',
  acc_already: 'Already logged in', acc_waiting: 'Fetching login URL…',
  acc_authkey: 'Auth key login', acc_authkey_hint: 'Paste a tskey-auth- key',
  acc_login_authkey: 'Log in with auth key',
  acc_headscale: 'Headscale / custom control server', acc_headscale_hint: 'https://headscale.example.com',
  acc_login_server: 'Log in to this server',
  acc_accounts: 'Accounts', acc_current_badge: 'Current', acc_switch: 'Switch',
  acc_logout: 'Log out', acc_logout_confirm: 'Log out? You will need to authorize again.',
  acc_switched: 'Account switched', acc_logged_out: 'Logged out', acc_logged_in: 'Logged in',
  acc_not_logged_in: 'Not logged in',

  tun_title: 'Tunnel', tun_iface: 'tailscale0 interface', tun_up: 'Up', tun_down: 'Down',
  tun_gateway: 'Gateway', tun_hev: 'hev-socks5-tunnel', tun_pid: 'PID',
  tun_not_running: 'not running', tun_socks_check: 'SOCKS5 self-check', tun_socks_checking: 'Checking…',
  tun_socks_ok: 'proxy works', tun_socks_fail: 'proxy failed',
  tun_derp: 'DERP relay speed test', tun_derp_testing: 'Testing…', tun_preferred: 'Preferred',
  dns_title: 'MagicDNS status', dns_hint: 'Tailnet settings, local short names and native TUN full domain names have separate DNS paths.',
  dns_check: 'Check DNS status', dns_local: 'Local short names', dns_native: 'Native DNS rules installed', dns_suffix: 'Domain suffix',
  dns_running: 'Running', dns_disabled: 'Disabled (Tailnet MagicDNS may still be enabled)',
  dns_apply_pending: 'Saved; waiting to apply', dns_disable_pending: 'Waiting to disable',
  dns_tailnet_unavailable: 'Tailnet unavailable; check login status', dns_missing_binary: 'dnsmasq not found',
  dns_conflict: 'Another DNS proxy conflicts', dns_redirect_failed: 'DNS redirect rules failed',
  dns_cleanup_failed: 'Previous DNS rules could not be removed', dns_process_failed: 'DNS process failed to start',
  dns_reconcile_needed: 'Node or configuration changed; update pending', dns_private_dns: 'Strict Android Private DNS may bypass local resolution',
  dns_stopped: 'Stopped', dns_degraded: 'Degraded; check the service logs',

  route_title: 'Routing', route_scope: 'Route scope',
  route_scope_all: 'All', route_scope_selected: 'Selected apps', route_scope_bypass: 'Bypass selected',
  route_scope_all_hint: 'All traffic goes through the tunnel (bounded by the subnet list)',
  route_scope_selected_hint: 'Only checked apps go through the tunnel',
  route_scope_bypass_hint: 'Checked apps bypass the tunnel; everything else uses it',
  route_no_owner: 'Kernel lacks xt_owner; per-app routing is unavailable. Select All.',
  route_native_scope: 'Native TUN routing is managed by Tailscale and supports All only. Switch to bridge for per-app routing.',
  route_apps: 'Apps', route_apps_search: 'Search apps…', route_apps_loading: 'Enumerating installed apps (may take tens of seconds)…',
  route_subnets: 'Routed subnets', route_subnets_add_hint: 'CIDR, e.g. 100.64.0.0/10',
  route_subnets_invalid: 'Invalid CIDR', route_apply_done: 'Routing configuration applied',

  traffic_title: 'Traffic', traffic_hourly: 'Hourly (today)', traffic_daily: 'Daily (7 days)',
  traffic_app_tx_hint: 'Application bytes sent to configured subnets (IPv4 + IPv6); received bytes are not measured.',
  traffic_topn: 'Top peers', traffic_by_app: 'By app', traffic_no_data: 'No samples yet (the collector needs some runtime)',
  traffic_rx: 'RX', traffic_tx: 'TX', traffic_touch_hint: 'Touch the chart for values',
  traffic_uid: 'UID ',

  serve_title: 'Serve / Funnel', serve_serve: 'Serve (tailnet)', serve_funnel: 'Funnel (public)',
  serve_kind: 'Kind', serve_proto: 'Protocol', serve_port: 'Port', serve_target: 'Target (e.g. http://localhost:3000)',
  serve_add: 'Add mapping', serve_empty: 'No mappings', serve_del_confirm: 'Delete this mapping?',
  serve_unavailable: 'Not supported by this tailscale build',

  files_title: 'Files', files_inbox: 'Inbox', files_empty: 'Inbox is empty',
  files_send: 'Send file', files_path: 'File path under /sdcard', files_path_hint: '/sdcard/Download/example.zip',
  files_peer: 'Target peer', files_send_btn: 'Send', files_receive: 'Fetch waiting files',
  files_sent: 'File sent', files_received: 'Fetch done',

  logs_title: 'Logs', logs_daemon: 'Daemon', logs_service: 'Service',
  logs_follow: 'Follow', logs_empty: 'Log is empty',

  set_ipv6_hint: 'Add an IPv6 CIDR under routed subnets first, e.g. fd7a:115c:a1e0::/48, or this setting cannot be applied.',
  set_restart_required: 'Configuration saved; restart the service to apply', set_apply_restart: 'Restart and apply', set_applied: 'Configuration applied',
  set_title: 'Settings', set_general: 'General', set_saved: 'Saved',
  set_context: 'Network context rules', set_context_hint: 'One rule per line: <trigger>:<value>:<action>[:<arg>], e.g. ssid:HomeWifi:down, cellular:-:no-exit-node',
  set_hooks: 'tun hooks (read-only)', set_hooks_hint: 'Edit in a terminal: /data/adb/foxytail/scripts/foxytail.tun.up / .down',
  set_hook_up: 'tun.up', set_hook_down: 'tun.down',
  set_backup: 'Backup config', set_restore: 'Restore config', set_backup_done: 'Backup written: ',
  set_restore_hint: 'Backup file path under /sdcard', set_restore_done: 'Restored (previous config saved to ',
  set_restore_confirm: 'Restore will overwrite current config. Continue?',
  set_theme: 'Theme', set_theme_dark: 'Dark', set_theme_light: 'Light', set_theme_auto: 'Auto',
  set_language: 'Language', set_ui: 'UI',

  diag_title: 'Diagnostics', diag_run: 'Generate diagnostics bundle', diag_running: 'Collecting (may take ~30s)…',
  diag_done: 'Bundle written: ', diag_hint: 'Contains log tails, status snapshot, iptables self-check and config (keys redacted), for bug reports.',

  more_title: 'More', more_tunnel: 'Tunnel', more_routing: 'Routing', more_account: 'Account',
  more_serve: 'Serve/Funnel', more_files: 'Files', more_logs: 'Logs',
  more_settings: 'Settings', more_diag: 'Diagnostics',
};

const DICT: Record<Lang, Record<I18nKey, string>> = { zh, en };

function detect(): Lang {
  try {
    const saved = localStorage.getItem('foxy.lang');
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    /* storage unavailable */
  }
  const nav = (navigator.language || 'en').toLowerCase();
  return nav.startsWith('zh') ? 'zh' : 'en';
}

const [lang, setLangSignal] = createSignal<Lang>(detect());

export { lang };

export function t(key: I18nKey): string {
  return DICT[lang()][key] ?? key;
}

export function setLang(code: Lang): void {
  if (code !== 'zh' && code !== 'en') return;
  setLangSignal(code);
  document.documentElement.setAttribute('lang', code === 'zh' ? 'zh-CN' : 'en');
  try {
    localStorage.setItem('foxy.lang', code);
  } catch {
    /* ignore */
  }
}

/* Sync <html lang> for the initially detected language. */
document.documentElement.setAttribute('lang', lang() === 'zh' ? 'zh-CN' : 'en');
