/* Progressive routing editor: scope, optional app selection, destinations. */
import {
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from 'solid-js';
import { createApiScope, execRaw, hasRoot } from '../api';
import { DEFAULT_TIMEOUT_MS } from '../config';
import { t, type I18nKey } from '../i18n';
import { status } from '../state';
import { Card, SkeletonRows, EmptyState, ErrorState, StatusBadge } from '../components/Basics';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, IconButton, TextField } from '../components/ui';
import type { RoutesInfo } from '../types';
import { normalizeCidr } from '../cidr';
import SubnetRoutes from './SubnetRoutes';
import RoutingApps from './RoutingApps';
import { subnetRoutes, subnetRoutesError, ipv6Unavailable, ipv6Notice } from '../subnet-routes';
import './tools.css';
type Scope = 'all' | 'selected' | 'bypass';
export default function Routing(): JSX.Element {
  const scope = createApiScope();
  const subnetErrorId = createUniqueId();
  const [skippedIpv6, setSkippedIpv6] = createSignal<string[]>([]);
  const [applyError, setApplyError] = createSignal<string | null>(null);
  const [scope_, setScope] = createSignal<Scope>('all');
  const [uids, setUids] = createSignal<string[]>([]);
  const [subnets, setSubnets] = createSignal<string[]>([]);
  const [owner, setOwner] = createSignal<'checking' | 'yes' | 'no'>('checking');
  const perAppSupported = () => owner() === 'yes' && status()?.mode === 'bridge';
  const [loaded, setLoaded] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [snapshot, setSnapshot] = createSignal<RoutesInfo | null>(null);
  const [saveResult, setSaveResult] = createSignal<'applied' | 'pending' | null>(null);
  const [newSubnet, setNewSubnet] = createSignal('');
  const [subnetError, setSubnetError] = createSignal('');
  const [applyBusy, setApplyBusy] = createSignal(false);
  const current = (): RoutesInfo => ({ scope: scope_(), uids: uids(), subnets: subnets() });
  const dirty = () => loaded() && JSON.stringify(snapshot()) !== JSON.stringify(current());
  const unappliedIpv6 = () => {
    if (subnetRoutes()?.ipv6Enabled === true) return [];
    const saved = snapshot()?.subnets ?? [];
    return [...new Set([
      ...skippedIpv6().filter(cidr => saved.includes(cidr)),
      ...(subnetRoutes()?.ipv6Enabled === false ? saved.filter(cidr => cidr.includes(':')) : []),
    ])];
  };
  const savedPending = () => saveResult() === 'pending' || unappliedIpv6().length > 0 || Boolean(applyError());
  const locked = () => !hasRoot || applyBusy() || !loaded() || Boolean(loadError());
  const probeAbort = new AbortController();
  onCleanup(() => {
    probeAbort.abort();
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
  function importSubnet(cidr: string) {
    if (locked() || subnetRoutesError() || (cidr.includes(':') && ipv6Unavailable()) || subnets().includes(cidr)) return;
    setSubnets([...subnets(), cidr]);
    setSaveResult(null);
  }
  onMount(() => {
    void loadRoutes();
    void execRaw(
      'iptables -m owner --help >/dev/null 2>&1 && echo yes || echo no',
      DEFAULT_TIMEOUT_MS,
      probeAbort.signal,
    )
      .then((out) => {
        if (!probeAbort.signal.aborted) setOwner(String(out).includes('yes') ? 'yes' : 'no');
      })
      .catch(() => {
        if (!probeAbort.signal.aborted) setOwner('no');
      });
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
      <SubnetRoutes locked={locked()} subnets={subnets()} onImport={importSubnet} />
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
                  <label class="tool-policy">
                    <input type="radio" name="route-scope" value={value}
                      checked={scope_() === value}
                      data-testid={'route-scope-' + value}
                      disabled={locked() || (value !== 'all' && !perAppSupported())}
                      onChange={() => setScope(value)} />
                    <span class="tool-policy-copy">
                      <strong>{t(('route_scope_' + value) as I18nKey)}</strong>
                      <span class="tool-hint">{t(('route_scope_' + value + '_hint') as I18nKey)}</span>
                    </span>
                  </label>
                )}
              </For>
            </div>
          </Card>
          <RoutingApps visible={perAppSupported() && scope_() !== 'all'} uids={uids()}
            selected={scope_() === 'selected'} locked={locked()} onToggle={toggleUid} />
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
