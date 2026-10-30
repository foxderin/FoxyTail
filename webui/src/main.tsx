/* APK-bundled shell; native bootstrap installs preferences before rendering. */
import { render } from 'solid-js/web';
import { createSignal, getOwner, onCleanup } from 'solid-js';
import './style.css';
import { initTheme, installTheme } from './theme';
import { installLanguage } from './i18n';
import { publishNativeControl, reportNativeConnectionError } from './api';
import { requestNative, type NativeResult } from './native';
import { toastApiError } from './components/Toast';
import { t } from './i18n';
import { AppShell, type RouteDef } from './components/AppShell';
import { initServiceControl } from './service';
import { ROUTE_META, ROUTE_NAMES, acceptNativeNavigation, recordNavigation, type RouteName } from './navigation';

import Dashboard from './pages/Dashboard';
import Peers from './pages/Peers';
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
  const onRouteChange = () => {
    const next = parseRoute();
    recordNavigation(route(), next);
    setRoute(next);
    void requestNative('app.navigate', { page: next });
  };
  window.addEventListener('hashchange', onRouteChange);
  if (getOwner()) onCleanup(() => window.removeEventListener('hashchange', onRouteChange));
  return route;
}

export let bootstrapDrafts: Record<string, unknown> = {};
async function mountApp(target: HTMLElement): Promise<void> {
  initTheme();
  const bootstrap = await requestNative('app.bootstrap');
  if (bootstrap.ok) {
    if (bootstrap.appearance && typeof bootstrap.appearance === 'object') {
      installTheme(bootstrap.appearance as Record<string, unknown>);
      installLanguage(bootstrap.appearance as Record<string, unknown>);
    }
    if (bootstrap.control) publishNativeControl(bootstrap.control as NativeResult);
    if (bootstrap.drafts && typeof bootstrap.drafts === 'object') bootstrapDrafts = bootstrap.drafts as Record<string, unknown>;
    if (typeof bootstrap.page === 'string' && ROUTES[bootstrap.page]) history.replaceState(null, '', '#/' + bootstrap.page);
    if (bootstrap.section) acceptNativeNavigation({ section: bootstrap.section });
  } else {
    reportNativeConnectionError(bootstrap.error || 'App connection unavailable');
  }
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!link || link.getAttribute('href')?.startsWith('#')) return;
    event.preventDefault();
    void requestNative('app.openUrl', { url: link.href }).then(result => {
      if (!result.ok) toastApiError(t('op_failed'), result);
    });
  });
  initServiceControl();
  render(() => {
    const route = createRouter();
    return <AppShell route={route} routes={ROUTES} />;
  }, target);
  document.getElementById('boot-screen')?.remove();
}
if (typeof document !== 'undefined' && document.getElementById('app')) {
  void mountApp(document.getElementById('app')!);
}
