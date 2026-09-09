import type { I18nKey } from './i18n';
import type { IconName } from './icons';

export interface NavItem { name: string; icon: IconName; titleKey: I18nKey }
export const PRIMARY_NAV: NavItem[] = [
  { name: 'dashboard', icon: 'dashboard', titleKey: 'nav_dashboard' },
  { name: 'peers', icon: 'group', titleKey: 'nav_peers' },
  { name: 'exitnodes', icon: 'logout', titleKey: 'nav_exitnodes' },
  { name: 'traffic', icon: 'monitoring', titleKey: 'nav_traffic' },
  { name: 'more', icon: 'more_horiz', titleKey: 'nav_more' },
];
export const NAV_GROUPS: { titleKey: I18nKey; items: NavItem[] }[] = [
  { titleKey: 'shell_network', items: PRIMARY_NAV.slice(0, 4) },
  { titleKey: 'shell_services', items: [
    { name: 'tunnel', icon: 'router', titleKey: 'tun_title' },
    { name: 'routing', icon: 'alt_route', titleKey: 'route_title' },
    { name: 'serve', icon: 'dns', titleKey: 'serve_title' },
    { name: 'files', icon: 'folder', titleKey: 'files_title' },
  ] },
  { titleKey: 'shell_manage', items: [
    { name: 'account', icon: 'person', titleKey: 'acc_title' },
    { name: 'logs', icon: 'article', titleKey: 'logs_title' },
    { name: 'settings', icon: 'settings', titleKey: 'set_title' },
    { name: 'diag', icon: 'bug_report', titleKey: 'diag_title' },
    PRIMARY_NAV[4],
  ] },
];
export function primaryRoute(name: string): string {
  return PRIMARY_NAV.some((item) => item.name === name) ? name : 'more';
}
