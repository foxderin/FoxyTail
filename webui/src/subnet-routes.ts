/** Session-owned preference writes survive navigation; page reads remain scoped. */
import { createSignal } from 'solid-js';
import { api, nativeControl, type ApiResult } from './api';
import { startTask } from './tasks';
import type { SubnetRoutesInfo } from './types';
import { showToast, toastApiError } from './components/Toast';
import { t } from './i18n';

export const SUBNET_ROUTES_TASK = 'subnet-routes';
const [subnetRoutes, setSubnetRoutes] = createSignal<SubnetRoutesInfo | null>(null);
const [subnetRoutesError, setSubnetRoutesError] = createSignal<string | null>(null);
const [acceptRoutesBusy, setAcceptRoutesBusy] = createSignal(false);
const [acceptRoutesPhase, setAcceptRoutesPhase] = createSignal<'run' | 'verify' | null>(null);
const [acceptRoutesFeedback, setAcceptRoutesFeedback] = createSignal<'unconfirmed' | 'mismatch' | null>(null);
let revision = 0;
let requestedTarget: boolean | null = null;

export { subnetRoutes, subnetRoutesError, acceptRoutesBusy, acceptRoutesPhase, acceptRoutesFeedback };
export const subnetRoutesRevision = (): number => revision;
export const ipv6Unavailable = () => subnetRoutes()?.ipv6Enabled !== true;
export const ipv6Notice = () => t(subnetRoutes()?.ipv6Enabled === false ? 'tools_subnet_ipv6_disabled' : 'tools_subnet_ipv6_unknown');

function publish(result: ApiResult): void {
  const valid = result.ok && typeof result.acceptRoutes === 'boolean' && typeof result.mode === 'string' &&
    typeof result.ipv6Enabled === 'boolean' && Array.isArray(result.peers);
  setSubnetRoutes({
      acceptRoutes: valid ? result.acceptRoutes as boolean : null,
      mode: valid ? result.mode as string : '',
      ipv6Enabled: valid ? result.ipv6Enabled as boolean : undefined,
      peers: valid ? result.peers as SubnetRoutesInfo['peers'] : [],
  });
  if (valid) {
    setSubnetRoutesError(null);
  } else setSubnetRoutesError(result.error || t('tools_subnet_load_error'));
}

/** An older page read cannot overwrite a write's verified preference. */
export function publishSubnetRoutes(result: ApiResult, readRevision: number): void {
  if (readRevision !== revision || acceptRoutesBusy() || result.cancelled) return;
  publish(result);
  if (acceptRoutesFeedback() && requestedTarget !== null) {
    if (typeof result.acceptRoutes !== 'boolean') setAcceptRoutesFeedback('unconfirmed');
    else if (result.acceptRoutes === requestedTarget) {
      setAcceptRoutesFeedback(null);
      requestedTarget = null;
    } else setAcceptRoutesFeedback('mismatch');
  }
}

export async function changeAcceptRoutes(next: boolean): Promise<void> {
  if (acceptRoutesBusy() || !nativeControl().canWrite || nativeControl().busy) return;
  const account = nativeControl().accountRevision;
  revision++;
  requestedTarget = next;
  setAcceptRoutesBusy(true);
  setAcceptRoutesPhase('run');
  setAcceptRoutesFeedback(null);
  try {
    const result = await startTask(SUBNET_ROUTES_TASK, 'subnet-routes-set', next ? 'on' : 'off').promise;
    setAcceptRoutesPhase('verify');
    // This is verification of a user write, so it also survives page disposal.
    const observed = await api('subnet-routes-get');
    if (nativeControl().accountRevision !== account) {
      publish({ ok: false, error: t('tools_result_stale') }); setAcceptRoutesFeedback('unconfirmed'); return;
    }
    publish(observed);
    const known = typeof observed.acceptRoutes === 'boolean';
    if (result.ok && result.applied === true && result.acceptRoutes === next && known && observed.acceptRoutes === next) {
      requestedTarget = null;
      showToast(t('tools_subnet_updated'), 'ok');
    } else {
      setAcceptRoutesFeedback(known && observed.acceptRoutes !== next ? 'mismatch' : 'unconfirmed');
      if (!result.ok && !result.cancelled) toastApiError(t('op_failed'), result);
    }
  } finally {
    revision++;
    setAcceptRoutesPhase(null);
    setAcceptRoutesBusy(false);
  }
}
