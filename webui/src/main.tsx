/*
 * FoxyTail WebUI entry: theme init, i18n, hash router, shell mount.
 *
 * Route switching is synchronous: hashchange flips a signal and Solid swaps
 * the page component in the same frame — pages render their skeleton first
 * and load data asynchronously. Teardown (timers, page-scoped calls) is
 * fire-and-forget; session tasks survive navigation by design.
 */
import { render } from 'solid-js/web';
import { createSignal, getOwner, onCleanup } from 'solid-js';
import './style.css';
import { initTheme } from './theme';
import { AppShell, type RouteDef } from './components/AppShell';
import { ROUTE_META, ROUTE_NAMES, type RouteName } from './navigation';

import Dashboard from './pages/Dashboard';
import Peers from './pages/Peers';
import ExitNodes from './pages/ExitNodes';
import Traffic from './pages/Traffic';
import More from './pages/More';
import Tunnel from './pages/Tunnel';
import Routing from './pages/Routing';
import Account from './pages/Account';
import Serve from './pages/Serve';
import Files from './pages/Files';
import Logs from './pages/Logs';
import Settings from './pages/Settings';
import Diag from './pages/Diag';

const PAGES: Record<RouteName, RouteDef['component']> = {
  dashboard: Dashboard,
  peers: Peers,
  exitnodes: ExitNodes,
  traffic: Traffic,
  more: More,
  tunnel: Tunnel,
  routing: Routing,
  account: Account,
  serve: Serve,
  files: Files,
  logs: Logs,
  settings: Settings,
  diag: Diag,
};

/* Titles and the route set come from navigation.ts; the components stay here. */
export const ROUTES: Record<string, RouteDef> = Object.fromEntries(
  ROUTE_NAMES.map((name): [string, RouteDef] => [
    name,
    { name, titleKey: ROUTE_META[name].pageTitleKey, component: PAGES[name] },
  ]),
);

function parseRoute(): string {
  const m = /^#\/([a-z-]+)/.exec(location.hash || '');
  return m && ROUTES[m[1]] ? m[1] : 'dashboard';
}

function createRouter() {
  const [route, setRoute] = createSignal(parseRoute());
  const onRouteChange = () => setRoute(parseRoute());
  window.addEventListener('hashchange', onRouteChange);
  if (getOwner()) onCleanup(() => window.removeEventListener('hashchange', onRouteChange));
  return route;
}

function mountApp(target: HTMLElement): void {
  initTheme();
  render(() => {
    const route = createRouter();
    return <AppShell route={route} routes={ROUTES} />;
  }, target);
  document.getElementById('boot-screen')?.remove();
}

/* Auto-boot on load — a real browser and the jsdom smoke harness (which
 * stubs globals and evaluates this bundle) both rely on this path. */
if (typeof document !== 'undefined' && document.getElementById('app')) {
  mountApp(document.getElementById('app')!);
}

/* Minimal test handle for the jsdom smoke harness (task adoption case). */
import { startTask, getTask, cancelTask } from './tasks';
import { refreshStatus } from './state';
if (import.meta.env.MODE === 'smoke' && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__foxy = { startTask, getTask, cancelTask, refreshStatus };
}
