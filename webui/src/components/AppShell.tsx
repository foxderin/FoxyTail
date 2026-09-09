/* Responsive app shell. Navigation never waits for the native bridge. */
import { createEffect, For, on, onCleanup, onMount, Show, type Accessor, type Component, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { hasRoot } from '../api';
import { t, type I18nKey } from '../i18n';
import { MdIcon, type IconName } from '../icons';
import { status, statusError, statusLoading, connState, startStatusPolling } from '../state';
import { listTasks, type Task } from '../tasks';
import { NAV_GROUPS, PRIMARY_NAV, primaryRoute } from '../navigation';
import { PageHeader, StatusBadge } from './Basics';
import { ToastRoot } from './Toast';
import { ConfirmHost } from './ConfirmDialog';
import { ServiceControls } from './ServiceControls';

export interface RouteDef {
  name: string;
  titleKey: I18nKey;
  component: Component;
}

function ConnectionBadge(): JSX.Element {
  const st = () => connState(status());
  const label = (): I18nKey => statusError() ? 'dash_status_stale' : statusLoading() ? 'shell_starting' : st() === 'running' ? 'shell_connected' : st() === 'starting' ? 'shell_starting' : st() === 'needs-login' ? 'shell_login' : st() === 'stopped' ? 'shell_stopped' : 'shell_unknown';
  return <StatusBadge state={statusError() || statusLoading() ? 'warn' : st() === 'running' ? 'on' : st() === 'needs-login' || st() === 'starting' ? 'warn' : 'off'} label={t(label())} />;
}

function Brand(): JSX.Element {
  return <a class="brand" href="#/dashboard" aria-label="FoxyTail">
    <span class="brand-mark" aria-hidden="true"><MdIcon name="hub" size={26} /></span>
    <span class="brand-copy"><strong>FoxyTail</strong><span>{t('shell_workspace')}</span></span>
  </a>;
}

const TASK_DESTINATIONS: Record<string, { route: string; label: I18nKey; icon: IconName }> = {
  'speedtest-exitnodes': { route: 'exitnodes', label: 'exit_test', icon: 'speed' },
  'derp-speedtest': { route: 'tunnel', label: 'tun_derp', icon: 'network_check' },
  diag: { route: 'diag', label: 'diag_run', icon: 'bug_report' },
  'file-send': { route: 'files', label: 'files_send', icon: 'send' },
  'file-receive': { route: 'files', label: 'files_receive', icon: 'download' },
};

function TaskMenu(): JSX.Element {
  let menu!: HTMLDetailsElement;
  onMount(() => {
    const dismiss = (event: PointerEvent) => { if (menu.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false; };
    document.addEventListener('pointerdown', dismiss);
    onCleanup(() => document.removeEventListener('pointerdown', dismiss));
  });
  const tasks = () => [...listTasks()].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt).slice(0, 5);
  const running = () => tasks().filter((task) => task.status === 'running').length;
  const destination = (task: Task) => TASK_DESTINATIONS[task.key] ?? { route: 'more', label: 'shell_tasks' as I18nKey, icon: 'sync' as IconName };
  return <details class="task-menu" ref={menu} onKeyDown={(event) => {
    if (event.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary')?.focus(); }
  }}>
    <summary class="task-menu-toggle" aria-label={t('shell_tasks')}>
      <MdIcon name="sync" size={20} /><span class="task-menu-label">{t('shell_tasks')}</span>
      <Show when={running() > 0}><span class="task-count" aria-live="polite">{running()}</span></Show>
    </summary>
    <div class="task-menu-panel">
      <div class="task-menu-heading">{t('shell_tasks')}</div>
      <Show when={tasks().length} fallback={<p class="task-menu-empty">{t('shell_no_tasks')}</p>}>
        <For each={tasks()}>{(task) => <a class="task-menu-item" href={'#/' + destination(task).route} onClick={() => { menu.open = false; menu.querySelector('summary')?.focus(); }}>
          <span class="task-menu-icon"><MdIcon name={destination(task).icon} size={20} /></span>
          <span class="task-menu-item-copy"><strong>{t(destination(task).label)}</strong><span>{t(('shell_task_' + task.status) as I18nKey)}</span></span>
          <span class={'dot ' + (task.status === 'done' ? 'on' : task.status === 'running' ? 'warn' : 'off')} aria-hidden="true" />
        </a>}</For>
      </Show>
    </div>
  </details>;
}

export function AppShell(props: {
  route: Accessor<string>;
  routes: Record<string, RouteDef>;
}): JSX.Element {
  startStatusPolling(5000);

  const def = () => props.routes[props.route()] ?? props.routes.dashboard;
  let main!: HTMLElement;
  let bottomNav!: HTMLElement;
  let header!: HTMLElement;
  onMount(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.setProperty('--ft-bottom-nav-height', `${bottomNav.offsetHeight}px`);
      root.style.setProperty('--ft-header-height', `${header.offsetHeight}px`);
    });
    observer.observe(bottomNav);
    observer.observe(header);
    onCleanup(() => { observer.disconnect(); root.style.removeProperty('--ft-bottom-nav-height'); root.style.removeProperty('--ft-header-height'); });
  });
  createEffect(on(props.route, () => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    queueMicrotask(() => main?.focus({ preventScroll: true }));
  }, { defer: true }));

  return (
    <>
      <a class="skip-link" href="#view" onClick={(event) => { event.preventDefault(); main.focus(); }}>{t('shell_skip')}</a>
      <aside id="sidebar">
        <Brand />
        <nav class="side-nav" aria-label={t('shell_navigation')}>
          <For each={NAV_GROUPS}>{(group) => <div class="nav-group">
            <div class="nav-group-label">{t(group.titleKey)}</div>
            <For each={group.items}>{(item) => <a class={'side-nav-item' + (item.name === props.route() ? ' active' : '')} href={'#/' + item.name} aria-current={item.name === props.route() ? 'page' : undefined}>
              <MdIcon name={item.icon} size={20} filled={item.name === props.route()} /><span>{t(item.titleKey)}</span>
            </a>}</For>
          </div>}</For>
        </nav>
        <div class="sidebar-footer"><span class="sidebar-footer-icon"><MdIcon name="router" size={18} /></span><span>Tailscale <span class="dim">/ FoxyTail</span></span></div>
      </aside>
      <header id="app-header" ref={header}>
        <div class="header-primary">
        <div class="mobile-brand"><Brand /></div>
        <div class="desktop-context"><span>{t('shell_workspace')}</span><MdIcon name="chevron_right" size={16} /><strong>{t(def().titleKey)}</strong></div>
        <div class="header-actions"><TaskMenu /><ConnectionBadge /></div>
        </div>
        <ServiceControls />
      </header>
      <main id="view" ref={main} tabIndex={-1}>
        <Show when={!hasRoot}>
          <div class="root-banner" role="alert"><MdIcon name="info" size={20} /><span>{t('no_root_banner')}</span></div>
        </Show>
        {/* Dynamic remounts the page component on every route change, so
         * each page's onCleanup (timers, page-scoped calls) fires exactly
         * once; heavy tasks live in the session store and survive. */}
        <Show when={def()} keyed>{(routeDef) => <div class="page-transition">
          <Show when={primaryRoute(props.route()) === 'more' && props.route() !== 'more'}>
            <a class="back-link" href="#/more"><MdIcon name="chevron_right" size={18} />{t('shell_back_tools')}</a>
          </Show>
          <PageHeader id="app-title" title={t(routeDef.titleKey)} />
          <Dynamic component={routeDef.component} />
        </div>}</Show>
      </main>
      <nav id="bottom-nav" ref={bottomNav} aria-label={t('shell_navigation')}>
        <For each={PRIMARY_NAV}>
          {(item) => (
            <a
              class={'nav-item' + (item.name === primaryRoute(props.route()) ? ' active' : '')}
              href={'#/' + item.name}
              aria-current={item.name === primaryRoute(props.route()) ? 'page' : undefined}
            >
              <span class="nav-pill">
                <MdIcon name={item.icon} size={22} filled={item.name === primaryRoute(props.route())} />
              </span>
              <span>{t(item.titleKey)}</span>
            </a>
          )}
        </For>
      </nav>
      <ToastRoot />
      <ConfirmHost />
    </>
  );
}
