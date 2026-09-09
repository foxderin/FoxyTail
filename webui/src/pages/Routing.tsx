/* Progressive routing editor: scope, optional app selection, destinations. */
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from 'solid-js';
import { createApiScope, execRaw, hasRoot } from '../api';
import { t, type I18nKey } from '../i18n';
import { status } from '../state';
import { Card, SkeletonRows, EmptyState, ErrorState, StatusBadge, StatusDot } from '../components/Basics';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, Checkbox, CircularProgress, IconButton, Switch, TextField } from '../components/ui';
import { confirmDialog } from '../components/ConfirmDialog';
import type { AppInfo, RoutesInfo } from '../types';
import { normalizeCidr } from '../cidr';
import { createQueuedRefresh } from './tools-refresh';
import {
  subnetRoutes, subnetRoutesError, subnetRoutesRevision, publishSubnetRoutes,
  acceptRoutesBusy, acceptRoutesPhase, acceptRoutesFeedback, changeAcceptRoutes,
} from '../subnet-routes';
import './tools.css';
type Scope = 'all' | 'selected' | 'bypass';
export default function Routing(): JSX.Element {
  const scope = createApiScope();
  const acceptFeedbackId = createUniqueId();
  const subnetErrorId = createUniqueId();
  const [subnetReadBusy, setSubnetReadBusy] = createSignal(false);
  const [acceptConfirming, setAcceptConfirming] = createSignal(false);
  const [skippedIpv6, setSkippedIpv6] = createSignal<string[]>([]);
  const [applyError, setApplyError] = createSignal<string | null>(null);
  let disposed = false;
  const [scope_, setScope] = createSignal<Scope>('all');
  const [uids, setUids] = createSignal<string[]>([]);
  const [subnets, setSubnets] = createSignal<string[]>([]);
  const [owner, setOwner] = createSignal<'checking' | 'yes' | 'no'>('checking');
  const perAppSupported = () => owner() === 'yes' && status()?.mode === 'bridge';
  const [loaded, setLoaded] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [snapshot, setSnapshot] = createSignal('');
  const [saveResult, setSaveResult] = createSignal<'applied' | 'pending' | null>(null);
  const [apps, setApps] = createSignal<AppInfo[] | null>(null);
  const [appsError, setAppsError] = createSignal<string | null>(null);
  const [searchText, setSearchText] = createSignal('');
  const [filter, setFilter] = createSignal('');
  const [showSelected, setShowSelected] = createSignal(false);
  const [visibleLimit, setVisibleLimit] = createSignal(100);
  const [newSubnet, setNewSubnet] = createSignal('');
  const [subnetError, setSubnetError] = createSignal('');
  const [applyBusy, setApplyBusy] = createSignal(false);
  const current = () => JSON.stringify([scope_(), uids(), subnets()]);
  const dirty = () => loaded() && snapshot() !== current();
  const savedSubnetList = createMemo(() => {
    if (!snapshot()) return [] as string[];
    const parsed: unknown = JSON.parse(snapshot());
    return Array.isArray(parsed) && Array.isArray(parsed[2])
      ? parsed[2].filter((value): value is string => typeof value === 'string')
      : [];
  });
  const unappliedIpv6 = createMemo(() => {
    if (subnetRoutes()?.ipv6Enabled === true) return [];
    const saved = savedSubnetList();
    return [...new Set([
      ...skippedIpv6().filter(cidr => saved.includes(cidr)),
      ...(subnetRoutes()?.ipv6Enabled === false ? saved.filter(cidr => cidr.includes(':')) : []),
    ])];
  });
  const savedPending = () => saveResult() === 'pending' || unappliedIpv6().length > 0 || Boolean(applyError());
  const locked = () => !hasRoot || applyBusy() || !loaded() || Boolean(loadError());
  const probeAbort = new AbortController();
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    disposed = true;
    probeAbort.abort();
    clearTimeout(searchTimer);
  });
  async function loadRoutes() {
    setLoadError(null);
    const res = await scope.api('routes-get');
    if (res.cancelled) return;
    if (!res.ok) {
      setLoadError(res.error || t('tools_route_load_error'));
      return;
    }
    const info = res as unknown as RoutesInfo;
    setScope((info.scope as Scope) || 'all');
    setUids(info.uids || []);
    setSubnets([...new Set((info.subnets || []).map(cidr => normalizeCidr(cidr) || cidr))]);
    setSnapshot(current());
    setLoaded(true);
  }
  const refreshSubnetRoutes = createQueuedRefresh(
    async () => {
      const readRevision = subnetRoutesRevision();
      return { ...await scope.api('subnet-routes-get'), readRevision };
    },
    result => publishSubnetRoutes(result, Number(result.readRevision)),
    setSubnetReadBusy,
  );
  const acceptanceKnown = () => typeof subnetRoutes()?.acceptRoutes === 'boolean';
  const acceptanceOn = () => subnetRoutes()?.acceptRoutes === true;
  const acceptanceLocked = () => !hasRoot || !acceptanceKnown() || subnetReadBusy() || acceptRoutesBusy() || acceptConfirming();
  const acceptanceMessage = () => acceptConfirming()
    ? t('net_controls_awaiting_confirm')
    : acceptRoutesPhase() === 'verify'
      ? t('net_controls_verifying')
      : acceptRoutesBusy()
        ? t('net_working')
        : !acceptanceKnown()
          ? t('tools_subnet_unknown')
          : acceptRoutesFeedback()
            ? t(acceptRoutesFeedback() === 'mismatch' ? 'tools_subnet_mismatch' : 'tools_subnet_unconfirmed')
            : '';
  async function toggleAcceptance(input: HTMLInputElement) {
    const next = input.checked;
    input.checked = acceptanceOn();
    if (acceptanceLocked() || next === acceptanceOn()) return;
    setAcceptConfirming(true);
    try {
      const approved = await confirmDialog(t(next ? 'tools_subnet_enable_confirm' : 'tools_subnet_disable_confirm'));
      if (!approved || disposed || !hasRoot || !acceptanceKnown() || acceptRoutesBusy()) return;
      void changeAcceptRoutes(next);
    } finally {
      setAcceptConfirming(false);
      if (input.isConnected) input.checked = acceptanceOn();
    }
  }
  const routeMode = () => status()?.mode || subnetRoutes()?.mode || '';
  const subnetModeHint = () => t(routeMode() === 'bridge' ? 'tools_subnet_bridge_hint' : routeMode() === 'proxy' ? 'tools_subnet_proxy_hint' : 'tools_subnet_native_hint');
  const announcedPeers = createMemo(() => (subnetRoutes()?.peers || []).flatMap(peer => {
    if (!peer || typeof peer.id !== 'string' || !Array.isArray(peer.routes)) return [];
    const routes = new Map<string, { cidr: string; primary: boolean }>();
    for (const route of peer.routes) {
      const cidr = typeof route?.cidr === 'string' ? normalizeCidr(route.cidr) : null;
      if (!cidr || cidr === '0.0.0.0/0' || cidr === '::/0') continue;
      routes.set(cidr, { cidr, primary: Boolean(route.primary) || Boolean(routes.get(cidr)?.primary) });
    }
    return routes.size ? [{ ...peer, routes: [...routes.values()] }] : [];
  }));
  const ipv6Unavailable = () => subnetRoutes()?.ipv6Enabled !== true;
  const ipv6Notice = () => t(subnetRoutes()?.ipv6Enabled === false ? 'tools_subnet_ipv6_disabled' : 'tools_subnet_ipv6_unknown');
  function importSubnet(cidr: string) {
    if (locked() || subnetRoutesError() || (cidr.includes(':') && ipv6Unavailable()) || subnets().includes(cidr)) return;
    setSubnets([...subnets(), cidr]);
    setSaveResult(null);
  }
  onMount(() => {
    void loadRoutes();
    void refreshSubnetRoutes();
    void execRaw(
      'iptables -m owner --help >/dev/null 2>&1 && echo yes || echo no',
      15000,
      probeAbort.signal,
    )
      .then((out) => {
        if (!probeAbort.signal.aborted) setOwner(String(out).includes('yes') ? 'yes' : 'no');
      })
      .catch(() => {
        if (!probeAbort.signal.aborted) setOwner('no');
      });
  });
  let appsRequested = false;
  createEffect(() => {
    if (loaded() && perAppSupported() && scope_() !== 'all' && !appsRequested) {
      appsRequested = true;
      void loadApps();
    }
  });
  async function loadApps() {
    setAppsError(null);
    setApps(null);
    const res = await scope.api('apps');
    if (res.cancelled) return;
    if (res.ok) setApps((res.apps as AppInfo[]) || []);
    else {
      setApps([]);
      setAppsError(res.error || t('error'));
    }
  }
  function onSearch(value: string) {
    setSearchText(value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      setFilter(value);
      setVisibleLimit(100);
    }, 200);
  }
  const matchingApps = createMemo(() => {
    const needle = filter().toLocaleLowerCase();
    return (apps() ?? [])
      .filter(
        (app) =>
          (!showSelected() || uids().includes(String(app.uid))) &&
          (!needle ||
            (app.label + ' ' + app.package + ' ' + app.uid).toLocaleLowerCase().includes(needle)),
      )
      .sort((a, b) => a.label.localeCompare(b.label));
  });
  function toggleUid(uid: number, checked: boolean) {
    const value = String(uid);
    setUids((old) => (checked ? [...new Set([...old, value])] : old.filter((x) => x !== value)));
  }
  function addSubnet() {
    if (locked()) return;
    const value = normalizeCidr(newSubnet());
    if (!value) {
      setSubnetError(t('route_subnets_invalid'));
      return;
    }
    if (subnets().includes(value)) {
      setSubnetError(t('tools_route_duplicate'));
      return;
    }
    setSubnets([...subnets(), value]);
    setSaveResult(null);
    setNewSubnet('');
    setSubnetError('');
  }
  async function apply() {
    if (locked() || (scope_() !== 'all' && !perAppSupported())) return;
    const saved = current();
    setApplyBusy(true);
    setApplyError(null);
    const res = await scope.api(
      'routes-set',
      scope_(),
      uids().join(',') || '-',
      subnets().join(',') || '-',
    );
    setApplyBusy(false);
    if (res.cancelled) return;
    if (res.ok) {
      const actualApplyError = typeof res.applyError === 'string' && res.applyError ? res.applyError : null;
      setApplyError(actualApplyError);
      const pending = res.applied === false || res.restartRequired === true || Boolean(actualApplyError);
      setSkippedIpv6(Array.isArray(res.ipv6Skipped) ? res.ipv6Skipped.filter((value): value is string => typeof value === 'string') : []);
      if (Array.isArray(res.subnets) && res.subnets.every(value => typeof value === 'string' && normalizeCidr(value))) {
        setSubnets([...new Set(res.subnets.map(value => normalizeCidr(value as string)!))]);
        setSnapshot(current());
      } else setSnapshot(saved);
      setSaveResult(pending || res.requiresIpv6 === true ? 'pending' : 'applied');
      if (actualApplyError) toastApiError(t('tools_saved_pending'), { error: actualApplyError });
      else showToast(t(res.requiresIpv6 === true ? 'tools_subnet_ipv6_saved' : pending ? 'set_restart_required' : 'route_apply_done'), pending || res.requiresIpv6 === true ? 'info' : 'ok');
    } else {
      setApplyError(typeof res.applyError === 'string' && res.applyError ? res.applyError : res.error || t('op_failed'));
      toastApiError(t('op_failed'), res);
    }
  }
  return (
    <div class="tools-page">
      <section class="panel subnet-route-controls" data-testid="subnet-routes-controls">
        <div class="subnet-route-controls-row">
          <div class="subnet-route-controls-label"><MdIcon name="alt_route" size={20} /><span>{t('tools_subnet_accept')}</span></div>
          <Switch
            aria-label={t('tools_subnet_accept')}
            aria-describedby={acceptanceMessage() ? acceptFeedbackId : undefined}
            selected={acceptanceOn()}
            indeterminate={!acceptanceKnown()}
            disabled={acceptanceLocked()}
            onChange={event => void toggleAcceptance(event.target as HTMLInputElement)}
          />
          <IconButton aria-label={t('tools_subnet_refresh')} disabled={!hasRoot || subnetReadBusy() || acceptRoutesBusy() || acceptConfirming()} onClick={() => void refreshSubnetRoutes()}>
            <Show when={subnetReadBusy()} fallback={<MdIcon name="refresh" size={20} />}><CircularProgress size={20} /></Show>
          </IconButton>
        </div>
        <p class="tool-hint">{subnetModeHint()}</p>
        <Show when={acceptanceMessage()}>
          <div id={acceptFeedbackId} class="subnet-route-feedback" role="status">
            <Show when={acceptRoutesBusy() || acceptConfirming()} fallback={<MdIcon name="info" size={16} />}><CircularProgress size={16} /></Show>
            <span>{acceptanceMessage()}</span>
          </div>
        </Show>
      </section>
      <Card title={t('tools_subnet_title')} icon="router">
        <div data-testid="subnet-route-peers" aria-busy={subnetReadBusy()}>
          <Show when={subnetRoutes() || subnetRoutesError()} fallback={<SkeletonRows rows={3} />}>
            <Show when={!subnetRoutesError()} fallback={<ErrorState text={subnetRoutesError()!} onRetry={() => void refreshSubnetRoutes()} />}>
              <Show when={announcedPeers().length} fallback={<EmptyState text={t('tools_subnet_empty')} icon="router" />}>
                <For each={announcedPeers()}>{peer => (
                  <section class="subnet-route-peer" data-route-peer={peer.id}>
                    <div class="subnet-route-peer-heading"><MdIcon name="router" size={18} /><h3>{peer.hostname || peer.id}</h3><span title={t(peer.online ? 'tools_subnet_online' : 'offline')} aria-label={t(peer.online ? 'tools_subnet_online' : 'offline')}><StatusDot state={peer.online ? 'on' : 'off'} /></span></div>
                    <For each={peer.routes}>{route => (
                      <div class="list-row subnet-route-row" data-route-cidr={route.cidr}>
                        <div class="main"><code>{route.cidr}</code><Show when={route.primary}><span class="subnet-route-primary">{t('tools_subnet_primary')}</span></Show></div>
                        <Button
                          variant="text"
                          aria-label={t('tools_subnet_add_network') + ' ' + route.cidr}
                          disabled={locked() || Boolean(subnetRoutesError()) || subnets().includes(route.cidr) || (route.cidr.includes(':') && ipv6Unavailable())}
                          title={route.cidr.includes(':') && ipv6Unavailable() ? ipv6Notice() : undefined}
                          onClick={() => importSubnet(route.cidr)}
                        ><MdIcon name={subnets().includes(route.cidr) ? 'check_circle' : 'add'} size={17} />{t(subnets().includes(route.cidr) ? 'tools_subnet_added' : 'add')}</Button>
                      </div>
                    )}</For>
                  </section>
                )}</For>
                <Show when={ipv6Unavailable() && announcedPeers().some(peer => peer.routes.some(route => route.cidr.includes(':')))}><p class="tool-hint subnet-route-note">{ipv6Notice()}<a href="#/settings">{t('set_title')}</a></p></Show>
              </Show>
            </Show>
          </Show>
        </div>
      </Card>
      <Show
        when={loaded() || loadError()}
        fallback={
          <Card title={t('tools_route_policy')} icon="alt_route">
            <SkeletonRows rows={5} />
          </Card>
        }
      >
        <Show
          when={!loadError()}
          fallback={
            <Card>
              <ErrorState text={loadError()!} onRetry={() => void loadRoutes()} />
            </Card>
          }
        >
          <Card title={t('tools_route_targets')} icon="router" description={t('tools_route_subnets_desc')}>
            <form class="tool-actions subnet-route-add" data-testid="route-add-subnet" onSubmit={event => { event.preventDefault(); addSubnet(); }}>
              <TextField
                id="custom-route-cidr"
                label={t('route_subnets')}
                aria-label={t('route_subnets')}
                aria-invalid={Boolean(subnetError())}
                aria-describedby={subnetError() ? subnetErrorId : undefined}
                placeholder={t('route_subnets_add_hint')}
                value={newSubnet()}
                disabled={locked()}
                onInput={event => { setNewSubnet((event.target as HTMLInputElement).value); setSubnetError(''); }}
              />
              <Button type="submit" variant="tonal" disabled={!newSubnet().trim() || locked()}><MdIcon name="add" size={18} />{t('add')}</Button>
            </form>
            <Show when={subnetError()}><p id={subnetErrorId} class="tool-hint lat-bad" role="alert">{subnetError()}</p></Show>
            <Show when={subnets().length} fallback={<EmptyState text={t('tools_route_empty_subnets')} icon="router" />}>
              <For each={subnets()}>{cidr => (
                <div class="list-row" data-custom-cidr={cidr}>
                  <div class="main"><code>{cidr}</code></div>
                  <IconButton aria-label={t('delete') + ' ' + cidr} disabled={locked()} onClick={() => setSubnets(old => old.filter(value => value !== cidr))}><MdIcon name="delete" size={18} /></IconButton>
                </div>
              )}</For>
            </Show>
            <Show when={ipv6Unavailable() && subnets().some(cidr => cidr.includes(':'))}><p class="tool-hint subnet-route-note">{ipv6Notice()}<a href="#/settings">{t('set_title')}</a></p></Show>
          </Card>
          <Card title={t('tools_route_policy')} icon="alt_route">
            <Show when={status()?.mode === 'tun'}>
              <div class="alert warn">{t('route_native_scope')}</div>
            </Show>
            <Show when={owner() === 'checking'}>
              <p class="tool-hint">{t('tools_route_probe')}</p>
            </Show>
            <Show when={owner() === 'no'}>
              <div class="alert warn">{t('route_no_owner')}</div>
            </Show>
            <div class="tool-policy-list" role="radiogroup" aria-label={t('route_scope')}>
              <For each={['all', 'selected', 'bypass'] as Scope[]}>
                {(value) => (
                  <button
                    type="button"
                    class="tool-policy"
                    role="radio"
                    aria-checked={scope_() === value}
                    data-testid={'route-scope-' + value}
                    disabled={locked() || (value !== 'all' && !perAppSupported())}
                    onClick={() => setScope(value)}
                    onKeyDown={(e) => {
                      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
                      e.preventDefault();
                      const choices: Scope[] = perAppSupported()
                        ? ['all', 'selected', 'bypass']
                        : ['all'];
                      const direction = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
                      const next =
                        choices[(choices.indexOf(value) + direction + choices.length) % choices.length]!;
                      setScope(next);
                      e.currentTarget.parentElement
                        ?.querySelector<HTMLButtonElement>('[data-testid=route-scope-' + next + ']')
                        ?.focus();
                    }}
                  >
                    <span class="tool-policy-dot" aria-hidden="true" />
                    <span class="tool-policy-copy">
                      <strong>{t(('route_scope_' + value) as I18nKey)}</strong>
                      <span class="tool-hint">{t(('route_scope_' + value + '_hint') as I18nKey)}</span>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Card>
          <Show when={perAppSupported() && scope_() !== 'all'}>
            <Card title={t('route_apps')} icon="group" description={t('tools_route_apps_desc')}>
              <TextField
                label={t('tools_search_apps')}
                aria-label={t('tools_search_apps')}
                value={searchText()}
                onInput={(e) => onSearch((e.target as HTMLInputElement).value)}
                leading-icon={<MdIcon name="search" size={18} />}
              />
              <div class="tool-app-toolbar">
                <span>
                  {t('tools_selected')} {uids().length} {t('tools_items')}
                </span>
                <button
                  type="button"
                  class={'filter-chip' + (showSelected() ? ' active' : '')}
                  aria-pressed={showSelected()}
                  onClick={() => setShowSelected(!showSelected())}
                >
                  {t('tools_selected')}
                </button>
              </div>
              <Show when={scope_() === 'selected' && !uids().length}>
                <p class="tool-hint">{t('tools_route_empty_selection')}</p>
              </Show>
              <Show when={apps() !== null} fallback={<SkeletonRows rows={5} />}>
                <Show
                  when={!appsError()}
                  fallback={<ErrorState text={appsError()!} onRetry={() => void loadApps()} />}
                >
                  <Show
                    when={matchingApps().length}
                    fallback={<EmptyState text={t('empty')} icon="search" />}
                  >
                    <div class="tool-app-list">
                      <For each={matchingApps().slice(0, visibleLimit())}>
                        {(app) => (
                          <div class="list-row tool-app-row" data-uid={app.uid}>
                            <Checkbox
                              id={'route-app-' + app.uid + '-' + app.package}
                              aria-label={app.label}
                              checked={uids().includes(String(app.uid))}
                              disabled={locked()}
                              onChange={(e) =>
                                toggleUid(app.uid, (e.target as HTMLInputElement).checked)
                              }
                            />
                            <label
                              class="main tool-app-label"
                              for={'route-app-' + app.uid + '-' + app.package}
                            >
                              <span class="title">{app.label}</span>
                              <span class="sub">
                                {app.package} · UID {app.uid}
                              </span>
                            </label>
                          </div>
                        )}
                      </For>
                    </div>
                    <Show when={matchingApps().length > visibleLimit()}>
                      <Button variant="text" onClick={() => setVisibleLimit((value) => value + 100)}>
                        {t('tools_route_show_all')} ({matchingApps().length - visibleLimit()})
                      </Button>
                    </Show>
                  </Show>
                </Show>
              </Show>
            </Card>
          </Show>
          <Show when={applyError()}>
            <div data-testid="route-apply-error"><ErrorState text={applyError()!} onRetry={() => void apply()} /></div>
          </Show>
          <Show when={!dirty() && unappliedIpv6().length > 0}>
            <div class="alert warn subnet-route-skipped" data-testid="route-ipv6-skipped" role="status"><span>{t('tools_subnet_ipv6_saved')}</span><For each={unappliedIpv6()}>{cidr => <code>{cidr}</code>}</For><a href="#/settings">{t('set_title')}</a></div>
          </Show>
          <div class="tool-sticky-actions">
            <span>
              <Show
                when={dirty()}
                fallback={
                  <StatusBadge tone={savedPending() ? 'warning' : 'success'}>
                    {t(savedPending() ? 'tools_saved_pending' : 'tools_route_saved')}
                  </StatusBadge>
                }
              >
                {t('tools_route_pending')}
              </Show>
            </span>
            <Button
              busy={applyBusy()}
              disabled={locked() || !dirty() || (scope_() !== 'all' && !perAppSupported())}
              onClick={() => void apply()}
            >
              <MdIcon name="check_circle" size={18} />
              {applyBusy() ? t('loading') : t('tools_apply_rules')}
            </Button>
          </div>
        </Show>
      </Show>
    </div>
  );
}
