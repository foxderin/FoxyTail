/* Progressive routing editor: scope, optional app selection, destinations. */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from 'solid-js';
import { createApiScope, execRaw, hasRoot } from '../api';
import { t, type I18nKey } from '../i18n';
import { status } from '../state';
import { Card, SkeletonRows, EmptyState, ErrorState, StatusBadge } from '../components/Basics';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, Checkbox, IconButton, TextField } from '../components/ui';
import type { AppInfo, RoutesInfo } from '../types';
import './tools.css';
type Scope = 'all' | 'selected' | 'bypass';
function validCidr(value: string): boolean {
  const pair = value.split('/');
  if (pair.length !== 2 || !/^\d+$/.test(pair[1]!)) return false;
  const [address, prefix] = pair as [string, string];
  if (address.includes(':')) {
    if (Number(prefix) > 128 || !/^[0-9a-fA-F:]+$/.test(address)) return false;
    try {
      return new URL('http://[' + address + ']/').hostname.length > 0;
    } catch {
      return false;
    }
  }
  const octets = address.split('.');
  return (
    Number(prefix) <= 32 &&
    octets.length === 4 &&
    octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
  );
}
export default function Routing(): JSX.Element {
  const scope = createApiScope();
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
  const locked = () => !hasRoot || applyBusy() || !loaded() || Boolean(loadError());
  const probeAbort = new AbortController();
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
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
    setSubnets(info.subnets || []);
    setSnapshot(current());
    setLoaded(true);
  }
  onMount(() => {
    void loadRoutes();
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
    const value = newSubnet().trim();
    if (!validCidr(value)) {
      setSubnetError(t('route_subnets_invalid'));
      return;
    }
    if (subnets().includes(value)) {
      setSubnetError(t('tools_route_duplicate'));
      return;
    }
    setSubnets([...subnets(), value]);
    setNewSubnet('');
    setSubnetError('');
  }
  async function apply() {
    if (locked() || (scope_() !== 'all' && !perAppSupported())) return;
    const saved = current();
    setApplyBusy(true);
    const res = await scope.api(
      'routes-set',
      scope_(),
      uids().join(',') || '-',
      subnets().join(',') || '-',
    );
    setApplyBusy(false);
    if (res.cancelled) return;
    if (res.ok) {
      const pending = res.applied === false || res.restartRequired === true;
      setSnapshot(saved);
      setSaveResult(pending ? 'pending' : 'applied');
      showToast(t(pending ? 'set_restart_required' : 'route_apply_done'), pending ? 'info' : 'ok');
    } else toastApiError(t('op_failed'), res);
  }
  return (
    <div class="tools-page">
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
          <Card
            title={t('tools_route_targets')}
            icon="router"
            description={t('tools_route_subnets_desc')}
          >
            <Show
              when={subnets().length}
              fallback={<EmptyState text={t('tools_route_empty_subnets')} icon="router" />}
            >
              <For each={subnets()}>
                {(cidr) => (
                  <div class="list-row">
                    <div class="main">
                      <code>{cidr}</code>
                    </div>
                    <IconButton
                      aria-label={t('delete') + ' ' + cidr}
                      disabled={locked()}
                      onClick={() => setSubnets((old) => old.filter((value) => value !== cidr))}
                    >
                      <MdIcon name="delete" size={18} />
                    </IconButton>
                  </div>
                )}
              </For>
            </Show>
            <div class="tool-actions">
              <TextField
                label={t('route_subnets')}
                placeholder={t('route_subnets_add_hint')}
                value={newSubnet()}
                disabled={locked()}
                onInput={(e) => {
                  setNewSubnet((e.target as HTMLInputElement).value);
                  setSubnetError('');
                }}
              />
              <Button variant="tonal" disabled={!newSubnet().trim() || locked()} onClick={addSubnet}>
                <MdIcon name="add" size={18} />
                {t('add')}
              </Button>
            </div>
            <Show when={subnetError()}>
              <p class="tool-hint lat-bad" role="alert">
                {subnetError()}
              </p>
            </Show>
          </Card>
          <div class="tool-sticky-actions">
            <span>
              <Show
                when={dirty()}
                fallback={
                  <StatusBadge tone={saveResult() === 'pending' ? 'warning' : 'success'}>
                    {t(saveResult() === 'pending' ? 'tools_saved_pending' : 'tools_route_saved')}
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
