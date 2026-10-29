import { createSignal, For, Show, useContext, type JSX, type ParentProps } from 'solid-js';
import { createApiScope, type ApiResult } from '../api';
import { t, type I18nKey } from '../i18n';
import { Card, SkeletonRows, KvRow, ErrorState } from '../components/Basics';
import { MdIcon } from '../icons';
import ContextRules from './ContextRules';
import SettingsBackup from './SettingsBackup';
import { Button } from '../components/ui';
import { DNS_REASONS, type DnsInfo } from './tunnel-dns';
import { RouteVisible } from '../schedule';

const HOOKS: [string, 'set_hook_up' | 'set_hook_down'][] = [
  ['foxytail.tun.up', 'set_hook_up'],
  ['foxytail.tun.down', 'set_hook_down'],
];
const DNS_FACTS: [string, I18nKey][] = [
  ['mode', 'coexist_applied_mode'], ['configuredMode', 'tools_fact_configuredMode'], ['pendingMode', 'tools_fact_pendingMode'],
  ['enabled', 'tools_magicdns'], ['state', 'tools_fact_state'], ['reason', 'tools_fact_reason'],
  ['listenerReady', 'tools_fact_listenerReady'], ['port', 'tools_dns_port'], ['suffix', 'dns_suffix'],
  ...['interception4', 'interception6', 'repairNeeded', 'policyState', 'capabilityError', 'transparentAvailable',
    'transparentUnavailableReason', 'hijackAvailable', 'hijackUnavailableReason', 'upstreamNative', 'ipv6DnsInterception', 'ipv6ModuleStatus'].map(key => [key, 'tools_fact_' + key] as [string, I18nKey]),
];
const RUNTIME_FACTS: [string, I18nKey][] = [
  ['daemon', 'tools_fact_daemon'], ['backend', 'tools_fact_backend'], ['mode', 'coexist_applied_mode'],
  ['powerSave', 'tools_power_save'], ['magicDns', 'tools_magicdns'], ['hostname', 'tools_fact_hostname'],
];

export default function SettingsMaintenance(props: ParentProps<{
  locked: boolean;
  onPending: () => void;
}>): JSX.Element {
  const scope = createApiScope();
  const routeVisible = useContext(RouteVisible);
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  const [advancedLoaded, setAdvancedLoaded] = createSignal(false);
  const [advancedBusy, setAdvancedBusy] = createSignal(false);
  const [hooks, setHooks] = createSignal<Record<string, string>>({});
  const [dns, setDns] = createSignal<DnsInfo | null>(null);
  const [runtime, setRuntime] = createSignal<ApiResult | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = createSignal(false);
  async function loadDiagnostics(probe = false) {
    if (diagnosticsBusy()) return;
    setDiagnosticsBusy(true);
    if (probe) {
      const result = await scope.api('dns-probe');
      if (!result.ok && !result.cancelled) setDns(result as DnsInfo);
    }
    const [dnsResult, runtimeResult] = await Promise.all([scope.api('dns'), scope.api('status')]);
    if (!dnsResult.cancelled) setDns(dnsResult as DnsInfo);
    if (!runtimeResult.cancelled) setRuntime({ ...runtimeResult, hostname: (runtimeResult.self as { hostname?: string } | undefined)?.hostname });
    setDiagnosticsBusy(false);
  }
  function fact(value: unknown) {
    if (typeof value === 'boolean') return t(value ? 'tools_fact_on' : 'tools_fact_off');
    if (value === null || value === undefined || value === '') return t('net_unknown');
    if (typeof value === 'string' && DNS_REASONS[value]) return t(DNS_REASONS[value]);
    return String(value);
  }
  async function loadAdvanced() {
    if (advancedBusy()) return;
    setAdvancedBusy(true);
    const result = await scope.api('hooks-get');
    if (result.cancelled) { setAdvancedBusy(false); return; }
    const entries = Array.isArray(result.hooks) ? result.hooks as { name: string; missing?: boolean; content?: string }[] : [];
    setHooks(Object.fromEntries(HOOKS.map(([name, key]) => {
      const entry = entries.find(item => item && item.name === name);
      return [key, !result.ok || !Array.isArray(result.hooks) ? result.error || t('misc_unavailable') : !entry || entry.missing
        ? t('misc_missing') : typeof entry.content !== 'string' ? t('misc_unavailable') : entry.content || t('misc_empty')];
    })));
    setAdvancedBusy(false);
    setAdvancedLoaded(true);
  }
  return <>
    <details class="tool-disclosure" onToggle={e => { setAdvancedOpen(e.currentTarget.open); if (e.currentTarget.open) void loadAdvanced(); }}>
      <summary><MdIcon name="settings" size={18} /> {t('tools_advanced')}</summary>
      <div class="tool-disclosure-body">
        {props.children}
        <Show when={advancedLoaded()} fallback={<SkeletonRows rows={5} />}>
          <RouteVisible.Provider value={() => routeVisible() && advancedOpen()}>
            <ContextRules locked={props.locked} onPending={props.onPending} />
          </RouteVisible.Provider>
          <Card title={t('set_hooks')} icon="article" description={t('set_hooks_hint')}>
            <For each={HOOKS}>{([, key]) => <div class="tool-result"><p class="tool-hint">{t(key)}</p><pre class="mono">{hooks()[key] ?? t('loading')}</pre></div>}</For>
          </Card>
          <details class="tool-disclosure" onToggle={event => { if (event.currentTarget.open) void loadDiagnostics(); }}>
            <summary><MdIcon name="monitoring" size={18} />{t('diag_title')}</summary>
            <Card title={t('dns_title')} icon="dns">
              <Button disabled={props.locked || diagnosticsBusy()} busy={diagnosticsBusy()} onClick={() => void loadDiagnostics(true)}>{t('dns_check')}</Button>
              <Show when={dns()?.error}><ErrorState text={String(dns()?.error)} /></Show>
              <For each={DNS_FACTS}>{([key, label]) => <KvRow k={t(label)} v={fact(dns()?.ok ? dns()?.[key] : null)} />}</For>
            </Card>
            <Card title={t('tools_tunnel_overview')} icon="router">
              <Show when={runtime()?.error}><ErrorState text={String(runtime()?.error)} /></Show>
              <For each={RUNTIME_FACTS}>{([key, label]) => <KvRow k={t(label)} v={fact(runtime()?.ok ? runtime()?.[key] : null)} />}</For>
            </Card>
          </details>
        </Show>
      </div>
    </details>
    <SettingsBackup locked={props.locked} />
  </>;
}
