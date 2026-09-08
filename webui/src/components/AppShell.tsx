/* App shell: header with shared StatusDot, no-root banner, page outlet,
 * MD3 bottom navigation bar (hand-built with tokens + pill indicator). */
import { For, Show, type Accessor, type Component, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { hasRoot } from '../api';
import { t, type I18nKey } from '../i18n';
import { MdIcon, type IconName } from '../icons';
import { status, connState, startStatusPolling } from '../state';
import { StatusDot } from './Basics';
import { ToastRoot } from './Toast';
import { ConfirmHost } from './ConfirmDialog';

export interface RouteDef {
  name: string;
  titleKey: I18nKey;
  component: Component;
}

const NAV: { name: string; icon: IconName }[] = [
  { name: 'dashboard', icon: 'dashboard' },
  { name: 'peers', icon: 'group' },
  { name: 'exitnodes', icon: 'logout' },
  { name: 'traffic', icon: 'monitoring' },
  { name: 'more', icon: 'more_horiz' },
];

function HeaderDot(): JSX.Element {
  const st = () => connState(status());
  return (
    <StatusDot
      state={st() === 'running' ? 'on' : st() === 'needs-login' || st() === 'starting' ? 'warn' : 'off'}
    />
  );
}

export function AppShell(props: {
  route: Accessor<string>;
  routes: Record<string, RouteDef>;
}): JSX.Element {
  startStatusPolling(5000);

  const def = () => props.routes[props.route()] ?? props.routes.dashboard;

  return (
    <>
      <Show when={!hasRoot}>
        <div class="root-banner" role="alert">
          {t('no_root_banner')}
        </div>
      </Show>
      <header id="app-header">
        <h1 id="app-title">FoxyTail · {t(def().titleKey)}</h1>
        <HeaderDot />
      </header>
      <main id="view">
        {/* Dynamic remounts the page component on every route change, so
         * each page's onCleanup (timers, page-scoped calls) fires exactly
         * once; heavy tasks live in the session store and survive. */}
        <Dynamic component={def().component} />
      </main>
      <nav id="bottom-nav" aria-label="main">
        <For each={NAV}>
          {(item) => (
            <a
              class={'nav-item' + (item.name === props.route() ? ' active' : '')}
              href={'#/' + item.name}
            >
              <span class="nav-pill">
                <MdIcon name={item.icon} size={22} />
              </span>
              <span>{t(('nav_' + item.name) as I18nKey)}</span>
            </a>
          )}
        </For>
      </nav>
      <ToastRoot />
      <ConfirmHost />
    </>
  );
}
