import type { I18nKey } from './i18n';
import type { IconName } from './icons';

interface NavItem { name: string; icon: IconName; titleKey: I18nKey }
export interface RouteMeta extends NavItem { pageTitleKey: I18nKey }

/* Route metadata is the single source for the shell navigation, the page
 * headings and the more-page tool grid. */
export const ROUTE_NAMES = [
  'dashboard', 'peers', 'exitnodes', 'traffic', 'more',
  'tunnel', 'routing', 'serve', 'files',
  'account', 'logs', 'settings', 'diag',
] as const;
export type RouteName = (typeof ROUTE_NAMES)[number];

export const ROUTE_META: Record<RouteName, RouteMeta> = {
  dashboard: { name: 'dashboard', icon: 'dashboard', titleKey: 'nav_dashboard', pageTitleKey: 'nav_dashboard' },
  peers: { name: 'peers', icon: 'group', titleKey: 'nav_peers', pageTitleKey: 'peers_title' },
  exitnodes: { name: 'exitnodes', icon: 'logout', titleKey: 'nav_exitnodes', pageTitleKey: 'exit_title' },
  traffic: { name: 'traffic', icon: 'monitoring', titleKey: 'nav_traffic', pageTitleKey: 'traffic_title' },
  more: { name: 'more', icon: 'more_horiz', titleKey: 'nav_more', pageTitleKey: 'more_title' },
  tunnel: { name: 'tunnel', icon: 'router', titleKey: 'tun_title', pageTitleKey: 'tun_title' },
  routing: { name: 'routing', icon: 'alt_route', titleKey: 'route_title', pageTitleKey: 'route_title' },
  serve: { name: 'serve', icon: 'dns', titleKey: 'serve_title', pageTitleKey: 'serve_title' },
  files: { name: 'files', icon: 'folder', titleKey: 'files_title', pageTitleKey: 'files_title' },
  account: { name: 'account', icon: 'person', titleKey: 'acc_title', pageTitleKey: 'acc_title' },
  logs: { name: 'logs', icon: 'article', titleKey: 'logs_title', pageTitleKey: 'logs_title' },
  settings: { name: 'settings', icon: 'settings', titleKey: 'set_title', pageTitleKey: 'set_title' },
  diag: { name: 'diag', icon: 'bug_report', titleKey: 'diag_title', pageTitleKey: 'diag_title' },
};

const meta = (name: RouteName): NavItem => ROUTE_META[name];

/* Shell navigation groups, in display order. The first group plus the more
 * entry forms the bottom navigation. */
const GROUPS: { titleKey: I18nKey; names: RouteName[] }[] = [
  { titleKey: 'shell_network', names: ['dashboard', 'peers', 'exitnodes', 'traffic'] },
  { titleKey: 'shell_services', names: ['tunnel', 'routing', 'serve', 'files'] },
  { titleKey: 'shell_manage', names: ['account', 'logs', 'settings', 'diag', 'more'] },
];

export const PRIMARY_NAV: NavItem[] = GROUPS[0].names.map(meta).concat(meta('more'));
export const NAV_GROUPS: { titleKey: I18nKey; items: NavItem[] }[] =
  GROUPS.map((group) => ({ titleKey: group.titleKey, items: group.names.map(meta) }));
export function routeIcon(name: RouteName): IconName {
  return ROUTE_META[name].icon;
}
export function primaryRoute(name: string): string {
  return PRIMARY_NAV.some((item) => item.name === name) ? name : 'more';
}
