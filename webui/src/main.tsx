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
import Network from './pages/Network';
import ExitNodes from './pages/ExitNodes';
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
  network: Network,
  exit: ExitNodes,
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

async function mountApp(target: HTMLElement): Promise<void> {
  initTheme();
  const bootstrap = await requestNative('app.bootstrap');
  if (bootstrap.ok) {
    if (bootstrap.appearance && typeof bootstrap.appearance === 'object') {
      installTheme(bootstrap.appearance as Record<string, unknown>);
      installLanguage(bootstrap.appearance as Record<string, unknown>);
    }
    if (bootstrap.control) publishNativeControl(bootstrap.control as NativeResult);
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
  /* Overflow menus live inside scroll containers; flip them up when there is
     no room below but enough above, otherwise the container clips them. */
  document.addEventListener('toggle', event => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.open || !details.classList.contains('menu-pop')) return;
    const pop = details.querySelector(':scope > div');
    if (!(pop instanceof HTMLElement)) return;
    const needed = pop.offsetHeight + 8;
    let clipTop = 0, clipBottom = window.innerHeight;
    for (let el = details.parentElement; el; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden') {
        const bound = el.getBoundingClientRect();
        clipTop = Math.max(clipTop, bound.top);
        clipBottom = Math.min(clipBottom, bound.bottom);
        break;
      }
    }
    const rect = details.getBoundingClientRect();
    pop.style.bottom = '';
    pop.style.position = '';
    pop.style.left = '';
    pop.style.top = '';
    pop.style.right = '';
    if (clipBottom - rect.bottom >= needed) return;
    if (rect.top - clipTop > needed) {
      pop.style.bottom = '100%';
      return;
    }
    // The clipping ancestor cannot hold the menu either way; escape it.
    const viewBottom = document.getElementById('bottom-nav')?.getBoundingClientRect().top ?? window.innerHeight;
    pop.style.position = 'fixed';
    pop.style.right = 'auto';
    const left = Math.max(8, Math.min(rect.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8));
    const top = Math.max(8, Math.min(rect.bottom, viewBottom - needed));
    // A transformed or contained ancestor becomes the containing block for
    // fixed descendants; measuring the element at 0,0 gives its viewport origin.
    pop.style.left = '0px';
    pop.style.top = '0px';
    const origin = pop.getBoundingClientRect();
    pop.style.left = (left - origin.left) + 'px';
    pop.style.top = (top - origin.top) + 'px';
  }, true);
  render(() => {
    const route = createRouter();
    return <AppShell route={route} routes={ROUTES} />;
  }, target);
  document.getElementById('boot-screen')?.remove();
}
if (typeof document !== 'undefined' && document.getElementById('app')) {
  void mountApp(document.getElementById('app')!);
}
