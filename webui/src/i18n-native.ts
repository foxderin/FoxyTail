export const nativeZh = {
  native_unavailable: '应用连接不可用。请重新打开 FoxyTail。',
  native_checking: '正在检查服务权限…',
  native_incompatible: '模块需要更新。',
  native_unknown: '结果未确认，请勿重复提交。',
  native_acknowledge: '确认并关闭',
  native_recheck: '重新检查',
  native_stop: '停止服务',
  native_exit_confirm: '更改出口可能中断现有连接。继续？',
  native_exit_changed: '连接或所选出口已更改，请重新确认。',
  shell_task_unknown: '结果未确认',
};
export const nativeEn: Record<keyof typeof nativeZh, string> = {
  native_unavailable: 'App connection unavailable. Reopen FoxyTail.',
  native_checking: 'Checking service access…',
  native_incompatible: 'Update the module to continue.',
  native_unknown: 'Result unconfirmed. Do not submit again.',
  native_acknowledge: 'Acknowledge',
  native_recheck: 'Check again',
  native_stop: 'Stop service',
  native_exit_confirm: 'Changing the exit may interrupt active connections. Continue?',
  native_exit_changed: 'The connection or selected exit changed. Review your selection.',
  shell_task_unknown: 'Result unconfirmed',
};
