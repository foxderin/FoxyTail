import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot } from '../api';
import { t } from '../i18n';
import { status } from '../state';
import { normalizeCidr } from '../cidr';
import { Card, SkeletonRows, EmptyState, ErrorState, StatusDot } from '../components/Basics';
import { confirmDialog } from '../components/ConfirmDialog';
import { Button, CircularProgress, IconButton, Switch } from '../components/ui';
import { MdIcon } from '../icons';
import { createQueuedRefresh } from './tools-refresh';
import {
  subnetRoutes, subnetRoutesError, subnetRoutesRevision, publishSubnetRoutes,
  acceptRoutesBusy, acceptRoutesPhase, acceptRoutesFeedback, changeAcceptRoutes,
  ipv6Unavailable, ipv6Notice,
} from '../subnet-routes';

export default function SubnetRoutes(props: {
  locked: boolean;
  subnets: string[];
  onImport: (cidr: string) => void;
}): JSX.Element {
  const scope = createApiScope();
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const acceptFeedbackId = createUniqueId();
  const [subnetReadBusy, setSubnetReadBusy] = createSignal(false);
  const [acceptConfirming, setAcceptConfirming] = createSignal(false);
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
  onMount(() => void refreshSubnetRoutes());
  return (
    <>
      <section class="panel subnet-route-controls" data-testid="subnet-routes-controls">
        <div class="subnet-route-controls-row">
          <div class="subnet-route-controls-label"><MdIcon name="alt_route" size={20} /><span>{t('tools_subnet_accept')}</span></div>
          <Switch
            aria-label={t('tools_subnet_accept')}
            aria-describedby={acceptanceMessage() ? acceptFeedbackId : undefined}
            checked={acceptanceOn()}
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
                          disabled={props.locked || Boolean(subnetRoutesError()) || props.subnets.includes(route.cidr) || (route.cidr.includes(':') && ipv6Unavailable())}
                          title={route.cidr.includes(':') && ipv6Unavailable() ? ipv6Notice() : undefined}
                          onClick={() => props.onImport(route.cidr)}
                        ><MdIcon name={props.subnets.includes(route.cidr) ? 'check_circle' : 'add'} size={17} />{t(props.subnets.includes(route.cidr) ? 'tools_subnet_added' : 'add')}</Button>
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
    </>
  );
}
