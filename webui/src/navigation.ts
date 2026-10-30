import { createSignal } from 'solid-js';
import { onNativeEvent, requestNative } from './native';
import type { I18nKey } from './i18n';
import type { IconName } from './icons';

interface NavItem { name: string; icon: IconName; titleKey: I18nKey }
export interface RouteMeta extends NavItem { pageTitleKey: I18nKey }

/* Route metadata is the single source for the shell navigation, the page
 * headings and sub-page back links. Route names are part of the native
 * contract — ControlActivity whitelists the same set. */
export const ROUTE_NAMES = [
  'dashboard', 'peers', 'files', 'traffic', 'network',
  'exit', 'tunnel', 'routing', 'serve',
  'account', 'logs', 'settings', 'diag',
] as const;
export type RouteName = (typeof ROUTE_NAMES)[number];

export const ROUTE_META: Record<RouteName, RouteMeta> = {
  dashboard: { name: 'dashboard', icon: 'dashboard', titleKey: 'nav_dashboard', pageTitleKey: 'nav_dashboard' },
  peers: { name: 'peers', icon: 'group', titleKey: 'nav_peers', pageTitleKey: 'peers_title' },
  traffic: { name: 'traffic', icon: 'monitoring', titleKey: 'nav_traffic', pageTitleKey: 'traffic_title' },
  network: { name: 'network', icon: 'hub', titleKey: 'nav_network', pageTitleKey: 'nav_network' },
  exit: { name: 'exit', icon: 'logout', titleKey: 'exit_title', pageTitleKey: 'exit_title' },
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

/* Bottom navigation is exactly the first group; the remaining groups only
 * render in the desktop sidebar. Detail pages map back to their hub via
 * PARENT. */
const GROUPS: { titleKey: I18nKey; names: RouteName[] }[] = [
  { titleKey: 'shell_nav_main', names: ['dashboard', 'peers', 'files', 'network', 'settings'] },
  { titleKey: 'shell_network', names: ['exit', 'tunnel', 'routing', 'serve', 'traffic'] },
  { titleKey: 'shell_manage', names: ['account', 'logs', 'diag'] },
];
const PRIMARY: RouteName[] = GROUPS[0].names;
const PARENT: Partial<Record<RouteName, RouteName>> = {
  exit: 'network', traffic: 'network', tunnel: 'network', routing: 'network', serve: 'network',
  account: 'settings', logs: 'settings', diag: 'settings',
};

export const PRIMARY_NAV: NavItem[] = PRIMARY.map(meta);
export const NAV_GROUPS: { titleKey: I18nKey; items: NavItem[] }[] =
  GROUPS.map((group) => ({ titleKey: group.titleKey, items: group.names.map(meta) }));
export function routeIcon(name: RouteName): IconName {
  return ROUTE_META[name].icon;
}
export function primaryRoute(name: string): string {
  return PARENT[name as RouteName] ?? (PRIMARY.includes(name as RouteName) ? name : 'dashboard');
}
export function parentRoute(name: string): { route: string; labelKey: I18nKey } | null {
  const parent = PARENT[name as RouteName];
  return parent ? { route: parent, labelKey: ROUTE_META[parent].titleKey } : null;
}

const [nativeFilesSection, setNativeFilesSection] = createSignal<'send' | 'history'>();
export { nativeFilesSection };
export function acceptNativeNavigation(event: Record<string, unknown>): void {
  if (event.section === 'send' || event.section === 'history') setNativeFilesSection(event.section);
  if (typeof event.page === 'string' && event.page in ROUTE_META) location.hash = '#/' + event.page;
}
onNativeEvent('navigate', acceptNativeNavigation);

const backStack: string[] = [];
let goingBack = false;
export function recordNavigation(previous: string, next: string): void {
  if (!goingBack && previous !== next) backStack.push(previous);
  goingBack = false;
}
export function handleBack(): void {
  const dialogs = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter(dialog => !dialog.closest('[hidden]'));
  if (dialogs.length) {
    dialogs[dialogs.length - 1].dispatchEvent(new Event('cancel', { cancelable: true }));
    return;
  }
  const menu = [...document.querySelectorAll<HTMLDetailsElement>('details[open]')].find(details => !details.closest('[hidden]'));
  if (menu) { menu.open = false; menu.querySelector('summary')?.focus(); return; }
  const route = location.hash.slice(2);
  const previous = backStack.pop();
  if (previous) { goingBack = true; location.hash = '#/' + previous; }
  else if (route && route !== 'dashboard') {
    goingBack = true;
    location.hash = '#/' + (parentRoute(route)?.route ?? 'dashboard');
  } else void requestNative('app.close');
}
onNativeEvent('back', handleBack);
