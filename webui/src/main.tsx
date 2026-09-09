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

export const ROUTES: Record<string, RouteDef> = {
  dashboard: { name: 'dashboard', titleKey: 'nav_dashboard', component: Dashboard },
  peers: { name: 'peers', titleKey: 'peers_title', component: Peers },
  exitnodes: { name: 'exitnodes', titleKey: 'exit_title', component: ExitNodes },
  traffic: { name: 'traffic', titleKey: 'traffic_title', component: Traffic },
  more: { name: 'more', titleKey: 'more_title', component: More },
  tunnel: { name: 'tunnel', titleKey: 'tun_title', component: Tunnel },
  routing: { name: 'routing', titleKey: 'route_title', component: Routing },
  account: { name: 'account', titleKey: 'acc_title', component: Account },
  serve: { name: 'serve', titleKey: 'serve_title', component: Serve },
  files: { name: 'files', titleKey: 'files_title', component: Files },
  logs: { name: 'logs', titleKey: 'logs_title', component: Logs },
  settings: { name: 'settings', titleKey: 'set_title', component: Settings },
  diag: { name: 'diag', titleKey: 'diag_title', component: Diag },
};

function parseRoute(): string {
  const m = /^#\/([a-z-]+)/.exec(location.hash || '');
  return m && ROUTES[m[1]] ? m[1] : 'dashboard';
}

export function createRouter() {
  const [route, setRoute] = createSignal(parseRoute());
  const onRouteChange = () => setRoute(parseRoute());
  window.addEventListener('hashchange', onRouteChange);
  if (getOwner()) onCleanup(() => window.removeEventListener('hashchange', onRouteChange));
  return route;
}

export function mountApp(target: HTMLElement): void {
  initTheme();
  render(() => {
    const route = createRouter();
    return <AppShell route={route} routes={ROUTES} />;
  }, target);
  document.getElementById('boot-screen')?.remove();
}

/* Auto-boot in a real browser; the jsdom smoke harness calls mountApp
 * itself after stubbing globals. */
if (typeof document !== 'undefined' && document.getElementById('app')) {
  mountApp(document.getElementById('app')!);
}

/* Minimal test handle for the jsdom smoke harness (task adoption case). */
import { startTask, getTask, cancelTask } from './tasks';
import { refreshStatus } from './state';
if (import.meta.env.MODE === 'smoke' && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__foxy = { startTask, getTask, cancelTask, refreshStatus };
}
