export const DATA_DIR = '/data/adb/foxytail';
export const WEBAPI = DATA_DIR + '/scripts/foxytail.webapi.sh';

/* Per-command timeout budget (ms). Heavy probes get a wider budget. */
export const DEFAULT_TIMEOUT_MS = 15000;
export const CLEANUP_TIMEOUT_MS = 8000;

export const COMMAND_TIMEOUTS: Record<string, number> = {
  'speedtest-exitnodes': 90000,
  'derp-speedtest': 60000,
  // Profile DNS restoration precedes teardown; keep the asynchronous request
  // alive through its bounded CLI calls instead of reporting a false timeout.
  control: 120000,
  'mode-set': 120000,
  'exitnode-set': 25000,
  'exitnode-clear': 25000,
  login: 95000,
  'login-authkey': 130000,
  logout: 95000,
  accounts: 20000,
  switch: 95000,
  'serve-list': 20000,
  'serve-set': 30000,
  'serve-del': 30000,
  'funnel-list': 20000,
  'funnel-set': 30000,
  'funnel-del': 30000,
  apps: 90000,
  compat: 35000,
  'routes-set': 45000,
  'subnet-routes-get': 20000,
  'subnet-routes-set': 35000,
  'context-set': 45000,
  'file-send': 320000,
  'file-receive': 70000,
  diag: 130000,
  backup: 60000,
};
