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
export function primaryRoute(name: string): string {
  return PARENT[name as RouteName] ?? (PRIMARY.includes(name as RouteName) ? name : 'dashboard');
}
export function parentRoute(name: string): { route: string; labelKey: I18nKey } | null {
  const parent = PARENT[name as RouteName];
  return parent ? { route: parent, labelKey: ROUTE_META[parent].titleKey } : null;
}

const [nativeFilesSection, setNativeFilesSection] = createSignal<'inbox' | 'send' | 'history'>();
export { nativeFilesSection };
export function acceptNativeNavigation(event: Record<string, unknown>): void {
  if (event.section === 'inbox' || event.section === 'send' || event.section === 'history') setNativeFilesSection(event.section);
  const next = typeof event.page === 'string' && event.page in ROUTE_META ? '#/' + event.page : location.hash;
  const changed = next !== location.hash;
  lastBackState = undefined;
  if (changed) location.hash = next;
  else queueMicrotask(publishBackState); // Changed routes publish after recordNavigation.
}
onNativeEvent('navigate', acceptNativeNavigation);

const backStack: string[] = [];
let goingBack = false;
export function recordNavigation(previous: string, next: string): void {
  if (!goingBack && previous !== next) backStack.push(previous);
  goingBack = false;
  queueMicrotask(publishBackState);
}
/** A parent-link is a backwards transition, not a new visit to that hub. */
export function returnToParent(route: string): void {
  const index = backStack.lastIndexOf(route);
  if (index >= 0) backStack.splice(index);
  goingBack = true;
  location.hash = '#/' + route;
}

const menuSelector = 'details.menu-pop[open], details.task-menu[open], details.status-sheet[open]';
const menuOrder = new WeakMap<HTMLDetailsElement, number>();
let lastMenu = 0;
if (typeof document !== 'undefined') document.addEventListener('toggle', event => {
  const menu = event.target;
  if (!(menu instanceof HTMLDetailsElement) || !menu.matches('.menu-pop, .task-menu, .status-sheet')) return;
  if (menu.open) menuOrder.set(menu, ++lastMenu);
}, true);
function visible(element: Element): boolean {
  if (!element.isConnected || element.closest('[hidden]')) return false;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open) return false;
  }
  return true;
}
export function handleBack(): void {
  const dialogs = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter(visible);
  if (dialogs.length) {
    dialogs[dialogs.length - 1].dispatchEvent(new Event('cancel', { cancelable: true }));
    return;
  }
  const menu = [...document.querySelectorAll<HTMLDetailsElement>(menuSelector)].filter(visible)
    .sort((a, b) => (menuOrder.get(b) ?? 0) - (menuOrder.get(a) ?? 0))[0]
    ?? [...document.querySelectorAll<HTMLDetailsElement>('details[open]')].find(visible);
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

// Publish only after bootstrap/render. Unknown startup and document reloads
// retain native interception; no gesture progress changes navigation or forms.
let backStateInstalled = false;
let lastBackState: boolean | undefined;
function publishBackState(): void {
  if (!backStateInstalled || typeof document === 'undefined') return;
  const overlay = [...document.querySelectorAll('dialog[open], details[open]')].some(visible);
  const match = /^#\/([a-z-]+)/.exec(location.hash || '');
  const route = match && match[1] in ROUTE_META ? match[1] : 'dashboard';
  const canHandle = overlay || backStack.length > 0 || route !== 'dashboard';
  if (lastBackState === canHandle) return;
  lastBackState = canHandle;
  void requestNative('app.backState', { canHandle }).then(result => {
    if (!result.ok && lastBackState === canHandle) lastBackState = undefined;
  });
}
export function installBackState(): void {
  if (backStateInstalled) return;
  backStateInstalled = true;
  const relevant = (node: Node) => node instanceof Element &&
    (node.matches('dialog, details') || !!node.querySelector('dialog, details'));
  new MutationObserver(records => {
    if (records.some(record => record.type === 'attributes' ||
      [...record.addedNodes, ...record.removedNodes].some(relevant))) publishBackState();
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden'] });
  publishBackState();
}

onNativeEvent('lifecycle', event => {
  if (event.active === true) { lastBackState = undefined; publishBackState(); }
});
