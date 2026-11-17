/* Responsive app shell. Navigation never waits for the native bridge. */
import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type Accessor, type Component, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { hasRoot, nativeControl } from '../api';
import { RouteVisible } from '../schedule';
import { t, tf, type I18nKey } from '../i18n';
import { MdIcon, type IconName } from '../icons';
import { startStatusPolling } from '../state';
import { listTasks, type Task } from '../tasks';
import { NAV_GROUPS, PRIMARY_NAV, parentRoute, primaryRoute } from '../navigation';
import { settingsDraftCount, restartRequired, setSettingsDrafts, setApplyRequested } from '../pending';
import { PageHeader } from './Basics';
import { ToastRoot } from './Toast';
import { ConfirmHost, confirmDialog } from './ConfirmDialog';
import { NativeIssueActions, ServiceActions } from './ServiceControls';
import { connectionChip, connectionCopy, nativeIssue, serviceBusy, serviceModeLabel, serviceOperationRunning } from '../service';
import { CircularProgress, IconButton } from './ui';
export interface RouteDef {
  name: string;
  titleKey: I18nKey;
  component: Component;
}

function Brand(): JSX.Element {
  return <a class="brand" href="#/dashboard" aria-label="FoxyTail">
    <span class="brand-mark" aria-hidden="true"><MdIcon name="hub" size={26} /></span>
    <span class="brand-copy"><strong>FoxyTail</strong><span>{t('shell_workspace')}</span></span>
  </a>;
}

const TASK_DESTINATIONS: Record<string, { route: string; label: I18nKey; icon: IconName }> = {
  'speedtest-exitnodes': { route: 'exit', label: 'exit_test', icon: 'speed' },
  'derp-speedtest': { route: 'tunnel', label: 'tun_derp', icon: 'network_check' },
  diag: { route: 'diag', label: 'diag_run', icon: 'bug_report' },
  'diag-check': { route: 'diag', label: 'diag_check', icon: 'network_check' },
  backup: { route: 'settings', label: 'set_backup', icon: 'backup' },
  restore: { route: 'settings', label: 'set_restore', icon: 'backup' },
  'settings-save': { route: 'settings', label: 'set_title', icon: 'settings' },
  'service-control': { route: 'dashboard', label: 'shell_services', icon: 'sync' },
  'subnet-routes': { route: 'routing', label: 'tools_subnet_accept', icon: 'alt_route' },
  'dns-probe': { route: 'settings', label: 'task_dns_probe', icon: 'dns' },
  'coexist-info': { route: 'tunnel', label: 'task_coexist_info', icon: 'network_check' },
  'coexist-check': { route: 'tunnel', label: 'task_coexist_check', icon: 'network_check' },
  'socks-check': { route: 'tunnel', label: 'task_socks_check', icon: 'network_check' },
  'trial-start': { route: 'settings', label: 'task_trial', icon: 'sync' },
  'trial-confirm': { route: 'settings', label: 'task_trial', icon: 'sync' },
  'trial-revert': { route: 'settings', label: 'task_trial', icon: 'sync' },
  'routes-set': { route: 'routing', label: 'task_routes', icon: 'alt_route' },
  'context-set': { route: 'settings', label: 'set_context', icon: 'sync' },
  'exitnode-set': { route: 'exit', label: 'task_exit', icon: 'logout' },
  'exitnode-clear': { route: 'exit', label: 'task_exit', icon: 'logout' },
  'serve-set': { route: 'serve', label: 'serve_title', icon: 'dns' },
  'serve-del': { route: 'serve', label: 'serve_title', icon: 'dns' },
  'funnel-set': { route: 'serve', label: 'serve_title', icon: 'dns' },
  'funnel-del': { route: 'serve', label: 'serve_title', icon: 'dns' },
  switch: { route: 'account', label: 'task_account', icon: 'person' },
  logout: { route: 'account', label: 'task_account', icon: 'person' },
  'login-authkey': { route: 'account', label: 'task_account', icon: 'person' },
};
const SILENT_TASKS = new Set(['dns-probe', 'coexist-info']);

function TaskMenu(): JSX.Element {
  let menu!: HTMLDetailsElement;
  onMount(() => {
    const dismiss = (event: PointerEvent) => { if (menu.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false; };
    document.addEventListener('pointerdown', dismiss);
    onCleanup(() => document.removeEventListener('pointerdown', dismiss));
  });
  const tasks = () => listTasks().filter(task => !SILENT_TASKS.has(task.cmd))
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt).slice(0, 5);
  const running = () => tasks().filter((task) => task.status === 'running').length;
  const destination = (task: Task) => task.cmd === 'peer-ping'
    ? { route: 'peers', label: 'net_peer_probe' as I18nKey, icon: 'network_check' as IconName }
    : TASK_DESTINATIONS[task.key] ?? TASK_DESTINATIONS[task.cmd] ?? { route: task.cmd.startsWith('file') ? 'files' : 'dashboard', label: (task.cmd.startsWith('file') ? 'task_files' : 'task_generic') as I18nKey, icon: 'sync' as IconName };
  return <details class="task-menu" ref={menu} onKeyDown={(event) => {
    if (event.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary')?.focus(); }
  }}>
    <summary class="task-menu-toggle" aria-label={t('shell_tasks')}>
      <MdIcon name="pending" size={20} /><span class="task-menu-label">{t('shell_tasks')}</span>
      <Show when={running() > 0}><span class="task-count" aria-live="polite">{running()}</span></Show>
    </summary>
    <div class="task-menu-panel">
      <div class="task-menu-heading">{t('shell_tasks')}</div>
      <Show when={tasks().length} fallback={<p class="task-menu-empty">{t('shell_no_tasks')}</p>}>
        <For each={tasks()}>{(task) => <a class="task-menu-item" href={'#/' + destination(task).route} onClick={() => { menu.open = false; menu.querySelector('summary')?.focus(); }}>
          <span class="task-menu-icon"><MdIcon name={destination(task).icon} size={20} /></span>
          <span class="task-menu-item-copy"><strong>{t(destination(task).label)}</strong><span>{t(task.status === 'running'
            ? task.call.cancellation === 'requested' ? 'task_cancel_pending'
              : task.call.cancellation === 'failed' ? 'task_cancel_failed' : 'shell_task_running'
            : ('shell_task_' + task.status) as I18nKey)}</span>
          </span>
          <span class={'dot ' + (task.status === 'done' ? 'on' : task.status === 'running' ? 'warn' : 'off')} aria-hidden="true" />
        </a>}</For>
      </Show>
    </div>
  </details>;
}

/* The header chip mirrors the shared connection state machine; the sheet it
 * opens exposes the same actions as the dashboard connection card. */
function StatusSheet(): JSX.Element {
  let sheet!: HTMLDetailsElement;
  onMount(() => {
    const dismiss = (event: PointerEvent) => { if (sheet.open && event.target instanceof Node && !sheet.contains(event.target)) sheet.open = false; };
    document.addEventListener('pointerdown', dismiss);
    onCleanup(() => document.removeEventListener('pointerdown', dismiss));
  });
  const close = () => { sheet.open = false; sheet.querySelector('summary')?.focus(); };
  const working = () => serviceBusy() !== null || serviceOperationRunning() || nativeControl().busy;
  return <details class="status-sheet" ref={sheet} data-testid="status-sheet" onKeyDown={(event) => {
    if (event.key === 'Escape' && sheet.open) close();
  }}>
    <summary class={'status-chip tone-' + connectionChip().tone} aria-label={t('shell_open_status')}>
      <Show when={working()} fallback={<span class={'dot ' + (connectionChip().tone === 'ok' ? 'on' : connectionChip().tone === 'warn' ? 'warn' : 'off')} aria-hidden="true" />}>
        <CircularProgress size={14} />
      </Show>
      <span class="status-chip-label">{t(connectionChip().label)}</span>
    </summary>
    <button type="button" class="status-sheet-scrim" aria-label={t('close')} onClick={close} tabIndex={-1} />
    <section class="status-sheet-panel" aria-label={t('shell_status_title')}>
      <header class="status-sheet-head">
        <strong>{t('shell_status_title')}</strong>
        <IconButton aria-label={t('close')} onClick={close}><MdIcon name="close" size={18} /></IconButton>
      </header>
      <div class="status-sheet-state">
        <MdIcon name={connectionCopy().icon} size={22} />
        <div><strong>{connectionCopy().title}</strong><span>{connectionCopy().hint}</span></div>
      </div>
      <ServiceActions />
      <Show when={nativeIssue()}><NativeIssueActions /></Show>
      <a class="status-sheet-row" href="#/network" onClick={close}>
        <span>{t('dash_mode')}</span>
        <strong>{serviceModeLabel() ? t(serviceModeLabel()!) : '—'}</strong>
        <MdIcon name="chevron_right" size={18} />
      </a>
    </section>
  </details>;
}

export function AppShell(props: {
  route: Accessor<string>;
  routes: Record<string, RouteDef>;
}): JSX.Element {
  startStatusPolling();
  const [visited, setVisited] = createSignal<string[]>([props.route()]);
  createEffect(() => {
    const route = props.route();
    setVisited(previous => [...previous.filter(name => ['peers', 'files', 'settings', 'routing', 'serve'].includes(name) && name !== route), route]);
  });

  const def = () => props.routes[props.route()] ?? props.routes.dashboard;
  /* Transient backend-busy states live in the status chip/sheet; only issues
   * that block the app warrant a page banner. */
  const blockingIssue = () => { const issue = nativeIssue(); return issue && issue.kind !== 'busy' ? issue : null; };
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
        <div class="mobile-brand"><Brand /></div>
        <div class="desktop-context"><span>{t('shell_workspace')}</span><MdIcon name="chevron_right" size={16} /><strong>{t(def().titleKey)}</strong></div>
        <div class="header-actions"><TaskMenu /><StatusSheet /></div>
      </header>
      <main id="view" ref={main} tabIndex={-1}>
        <Show when={!hasRoot}>
          <div class="root-banner" role="alert"><MdIcon name="info" size={20} /><span>{t('no_root_banner')}</span></div>
        </Show>
        <Show when={hasRoot && props.route() !== 'dashboard' && blockingIssue()}>
          {(issue) => (
            <div class="root-banner" role={issue().kind === 'busy' ? 'status' : 'alert'}>
              <MdIcon name={issue().kind === 'busy' ? 'info' : 'warning'} size={20} />
              <span>{issue().message}</span>
              <NativeIssueActions />
            </div>
          )}
        </Show>
        <For each={visited()}>{name => {
          const routeDef = props.routes[name] ?? props.routes.dashboard;
          const visible = () => props.route() === name;
          return <div class="page-transition" hidden={!visible()}>
            <RouteVisible.Provider value={visible}>
              <Show when={parentRoute(name)}>
                {(parent) => (
                  <a class="back-link" href={'#/' + parent().route}><MdIcon name="chevron_right" size={18} />{t('shell_back')} · {t(parent().labelKey)}</a>
                )}
              </Show>
              <PageHeader id={'app-title-' + name} title={t(routeDef.titleKey)} />
              <Dynamic component={routeDef.component} />
            </RouteVisible.Provider>
          </div>;
        }}</For>
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
      <PendingBar route={props.route} />
      <ToastRoot />
      <ConfirmHost />
    </>
  );
}

/* Staged settings edits surface on every page; applying still happens inside
 * the settings page's review dialog. */
function PendingBar(props: { route: () => string }): JSX.Element {
  const count = settingsDraftCount;
  async function discardAll() {
    if (await confirmDialog({
      title: t('set_discard_all'),
      body: t('set_discard_all_confirm'),
      confirmLabel: t('set_discard_all'),
      tone: 'danger',
    })) setSettingsDrafts({});
  }
  return (
    <Show when={(count() > 0 || restartRequired()) && props.route() !== 'settings'}>
      <div class="pending-bar" role="status">
        <MdIcon name="sync" size={18} />
        <span class="pending-bar-text">
          {count() > 0 ? tf('pending_changes', { count: count() }) : t('tools_saved_pending')}
        </span>
        <a class="pending-bar-link" href="#/settings">{t('pending_view')}</a>
        <Show when={count() > 0}>
          <button type="button" class="pending-bar-btn" onClick={() => void discardAll()}>
            {t('set_discard_all')}
          </button>
          <button
            type="button"
            class="pending-bar-btn primary"
            onClick={() => { setApplyRequested(true); location.hash = '#/settings'; }}
          >
            {t('set_apply_all')}
          </button>
        </Show>
      </div>
    </Show>
  );
}
