export const foundationZh = {
  shell_navigation: '主导航', shell_workspace: '网络控制台', shell_network: '网络', shell_services: '连接与服务', shell_manage: '管理',
  shell_back_tools: '返回工具', shell_skip: '跳到主要内容',
  shell_connected: '已连接', shell_starting: '连接中', shell_login: '等待登录', shell_stopped: '未连接', shell_unknown: '状态未知',
  shell_tasks: '后台任务', shell_task_running: '进行中', shell_task_done: '已完成', shell_task_error: '未完成', shell_task_cancelled: '已取消', shell_no_tasks: '暂无后台任务',
  shell_task_keep_running: '可切换页面，任务会继续运行。',
} as const;

export const foundationEn: Record<keyof typeof foundationZh, string> = {
  shell_navigation: 'Main navigation', shell_workspace: 'Network console', shell_network: 'Network', shell_services: 'Connections & services', shell_manage: 'Management',
  shell_back_tools: 'Back to tools', shell_skip: 'Skip to content',
  shell_connected: 'Connected', shell_starting: 'Connecting', shell_login: 'Login required', shell_stopped: 'Disconnected', shell_unknown: 'Status unknown',
  shell_tasks: 'Background tasks', shell_task_running: 'Running', shell_task_done: 'Completed', shell_task_error: 'Failed', shell_task_cancelled: 'Cancelled', shell_no_tasks: 'No background tasks',
  shell_task_keep_running: 'You can switch pages while this task continues.',
};
