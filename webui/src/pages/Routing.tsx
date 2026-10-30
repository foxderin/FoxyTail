/* Progressive routing editor: scope, optional app selection, destinations. */
import {
  createSignal,
  createUniqueId,
  For,
  onMount,
  Show,
  type JSX,
} from 'solid-js';
import { createApiScope, hasRoot, nativeControl } from '../api';
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
import { bindNativeDraft } from '../settings';
import { confirmDialog } from '../components/ConfirmDialog';
import { pollWhileVisible } from '../schedule';
import { viewPollInterval } from '../state';
export default function Routing(): JSX.Element {
  const scope = createApiScope();
  const subnetErrorId = createUniqueId();
  const [skippedIpv6, setSkippedIpv6] = createSignal<string[]>([]);
  const [applyError, setApplyError] = createSignal<string | null>(null);
  const [scope_, setScope] = createSignal<Scope>('all');
  const [uids, setUids] = createSignal<string[]>([]);
  const [subnets, setSubnets] = createSignal<string[]>([]);
  const [owner, setOwner] = createSignal<'checking' | 'yes' | 'no' | 'unknown'>('checking');
  const [ownerError, setOwnerError] = createSignal('');
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
  const [baseline, setBaseline] = createSignal<RoutesInfo | null>(null);
  const conflict = () => baseline() !== null && JSON.stringify(baseline()) !== JSON.stringify(snapshot()) && dirty();
  const draftReady = bindNativeDraft('routes', () => ({ baseline: baseline(), current: current(), newSubnet: newSubnet() }), value => {
    const draft = value.current as RoutesInfo | undefined;
    if (draft && ['all', 'selected', 'bypass'].includes(draft.scope) &&
        Array.isArray(draft.uids) && draft.uids.every(uid => typeof uid === 'string' && /^\d+$/.test(uid)) &&
        Array.isArray(draft.subnets) && draft.subnets.every(cidr => typeof cidr === 'string')) {
      setScope(draft.scope as Scope); setUids(draft.uids); setSubnets(draft.subnets);
      setBaseline(value.baseline as RoutesInfo | null);
    }
    if (typeof value.newSubnet === 'string') setNewSubnet(value.newSubnet);
  });
  const unappliedIpv6 = () => {
    if (subnetRoutes()?.ipv6Enabled === true) return [];
    const saved = snapshot()?.subnets ?? [];
    return [...new Set([
      ...skippedIpv6().filter(cidr => saved.includes(cidr)),
      ...(subnetRoutes()?.ipv6Enabled === false ? saved.filter(cidr => cidr.includes(':')) : []),
    ])];
  };
  const savedPending = () => saveResult() === 'pending' || unappliedIpv6().length > 0 || Boolean(applyError());
  const locked = () => !hasRoot || !nativeControl().canWrite || nativeControl().busy || applyBusy() || !loaded() || Boolean(loadError());
  let readRevision = 0;
  async function loadRoutes(discard = false) {
    if (applyBusy()) return;
    const ticket = ++readRevision, observation = nativeControl().revision;
    setLoadError(null);
    const res = await scope.api('routes-get');
    if (res.cancelled || ticket !== readRevision || observation !== nativeControl().revision || applyBusy()) return;
    if (!res.ok) {
      setLoadError(res.error || t('tools_route_load_error'));
      return;
    }
    const info = res as unknown as RoutesInfo;
    if (!['all', 'selected', 'bypass'].includes(info.scope) || !Array.isArray(info.uids) ||
        !info.uids.every(uid => typeof uid === 'string' && /^\d+$/.test(uid)) ||
        !Array.isArray(info.subnets) || !info.subnets.every(cidr => typeof cidr === 'string' && normalizeCidr(cidr))) {
      setLoadError(t('tools_route_load_error')); return;
    }
    const saved = { scope: info.scope, uids: info.uids, subnets: [...new Set(info.subnets.map(cidr => normalizeCidr(cidr)!))] };
    if (discard || baseline() === null || JSON.stringify(current()) === JSON.stringify(baseline())) {
      setScope(saved.scope as Scope); setUids(saved.uids); setSubnets(saved.subnets); setBaseline(saved);
    }
    setSnapshot(saved);
    setLoaded(true);
  }
  function importSubnet(cidr: string) {
    if (locked() || subnetRoutesError() || (cidr.includes(':') && ipv6Unavailable()) || subnets().includes(cidr)) return;
    setSubnets([...subnets(), cidr]);
    setSaveResult(null);
  }
  async function loadOwner() {
    setOwner('checking'); setOwnerError('');
    const result = await scope.api('owner-capability');
    if (result.cancelled) return;
    if (result.ok && typeof result.available === 'boolean') setOwner(result.available ? 'yes' : 'no');
    else { setOwner('unknown'); setOwnerError(result.error || t('net_unknown')); }
  }
  onMount(() => { void loadOwner(); });
  pollWhileVisible(() => draftReady.then(() => loadRoutes()), () => viewPollInterval(10000));
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
    if (!await confirmDialog((conflict() ? t('tools_draft_conflict') + '\n\n' : '') + t('tools_network_warning'))) return;
    if (locked() || JSON.stringify(saved) !== JSON.stringify(current())) return;
    readRevision++;
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
      const pending = res.applied !== true || res.restartRequired === true || Boolean(actualApplyError);
      setSkippedIpv6(Array.isArray(res.ipv6Skipped) ? res.ipv6Skipped.filter((value): value is string => typeof value === 'string') : []);
      if (Array.isArray(res.subnets) && res.subnets.every(value => typeof value === 'string' && normalizeCidr(value))) {
        setSubnets([...new Set(res.subnets.map(value => normalizeCidr(value as string)!))]);
        setSnapshot(current());
      } else setSnapshot(saved);
      setBaseline(snapshot());
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
            <Show when={owner() === 'unknown'}><ErrorState text={ownerError()} onRetry={() => void loadOwner()} /></Show>
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
            <div data-testid="route-apply-error"><ErrorState text={applyError()!} /></div>
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
                {t(conflict() ? 'tools_draft_conflict' : 'tools_route_pending')}
              </Show>
            </span>
            <Button variant="text" disabled={applyBusy()} onClick={async () => {
              if (!dirty() || await confirmDialog(t('tools_discard_confirm'))) await loadRoutes(true);
            }}>{t(dirty() ? 'tools_discard' : 'tools_refresh')}</Button>
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
