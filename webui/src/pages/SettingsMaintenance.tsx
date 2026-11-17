import { createEffect, createSignal, For, Show, on, useContext, type JSX, type ParentProps } from 'solid-js';
import { createApiScope, type ApiResult } from '../api';
import { t, type I18nKey } from '../i18n';
import { Card, SkeletonRows, KvRow, ErrorState } from '../components/Basics';
import { MdIcon } from '../icons';
import ContextRules from './ContextRules';
import SettingsBackup from './SettingsBackup';
import { Button } from '../components/ui';
import { DNS_REASONS, type DnsInfo } from './tunnel-dns';
import { RouteVisible } from '../schedule';
import { createGuardedLoad } from './tools-refresh';

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

function HookDetails(): JSX.Element {
  const scope = createApiScope();
  const [loaded, setLoaded] = createSignal(false);
  const [hooks, setHooks] = createSignal<Record<string, string>>({});
  const load = createGuardedLoad(() => scope.api('hooks-get'), result => {
    const entries = Array.isArray(result.hooks) ? result.hooks as { name: string; missing?: boolean; content?: string }[] : [];
    setHooks(Object.fromEntries(HOOKS.map(([name, key]) => {
      const entry = entries.find(item => item && item.name === name);
      return [key, !result.ok || !Array.isArray(result.hooks) ? result.error || t('misc_unavailable') : !entry || entry.missing
        ? t('misc_missing') : typeof entry.content !== 'string' ? t('misc_unavailable') : entry.content || t('misc_empty')];
    })));
    setLoaded(true);
  }, () => {});
  const visible = useContext(RouteVisible);
  createEffect(on(visible, shown => { if (shown) void load(); }));
  return <Card title={t('set_hooks')} icon="article" description={t('set_hooks_hint')}>
    <Show when={loaded()} fallback={<SkeletonRows rows={2} />}>
      <For each={HOOKS}>{([, key]) => <div class="tool-result"><p class="tool-hint">{t(key)}</p><pre class="mono">{hooks()[key] ?? t('loading')}</pre></div>}</For>
    </Show>
  </Card>;
}

function DiagnosticDetails(props: { locked: boolean }): JSX.Element {
  const scope = createApiScope();
  const [dns, setDns] = createSignal<DnsInfo | null>(null);
  const [runtime, setRuntime] = createSignal<ApiResult | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [probing, setProbing] = createSignal(false);
  const [probeError, setProbeError] = createSignal('');
  const load = createGuardedLoad(async () => {
    const [dns, runtime] = await Promise.all([scope.api('dns'), scope.api('status')]);
    return { ok: true, cancelled: dns.cancelled || runtime.cancelled, dns, runtime };
  }, result => {
    setDns(result.dns as DnsInfo);
    const runtime = result.runtime as ApiResult;
    setRuntime({ ...runtime, hostname: (runtime.self as { hostname?: string } | undefined)?.hostname });
  }, setLoading);
  const visible = useContext(RouteVisible);
  createEffect(on(visible, shown => { if (shown) void load(); }));
  async function probe() {
    if (props.locked || loading() || probing()) return;
    setProbing(true); setProbeError('');
    const result = await scope.api('dns-probe');
    setProbeError(result.cancelled ? t('cancelled') : result.ok ? '' : result.error || t('op_failed'));
    setProbing(false);
    void load();
  }
  function fact(value: unknown) {
    if (typeof value === 'boolean') return t(value ? 'tools_fact_on' : 'tools_fact_off');
    if (value === null || value === undefined || value === '') return t('net_unknown');
    if (typeof value === 'string' && DNS_REASONS[value]) return t(DNS_REASONS[value]);
    return String(value);
  }
  return <>
    <Card title={t('dns_title')} icon="dns">
      <div class="tool-actions"><Button disabled={props.locked || loading() || probing()} busy={loading() || probing()} onClick={() => void probe()}>{t('dns_check')}</Button></div>
      <Show when={probeError()}><ErrorState text={probeError()} /></Show>
      <Show when={dns()?.error}><ErrorState text={String(dns()?.error)} /></Show>
      <For each={DNS_FACTS}>{([key, label]) => <KvRow k={t(label)} v={fact(dns()?.ok ? dns()?.[key] : null)} />}</For>
    </Card>
    <Card title={t('tools_tunnel_overview')} icon="router">
      <Show when={runtime()?.error}><ErrorState text={String(runtime()?.error)} /></Show>
      <For each={RUNTIME_FACTS}>{([key, label]) => <KvRow k={t(label)} v={fact(runtime()?.ok ? runtime()?.[key] : null)} />}</For>
    </Card>
  </>;
}

function Diagnostics(props: { locked: boolean }): JSX.Element {
  const routeVisible = useContext(RouteVisible);
  const [open, setOpen] = createSignal(false);
  const [opened, setOpened] = createSignal(false);
  return <details class="tool-disclosure" onToggle={event => {
    setOpen(event.currentTarget.open);
    if (event.currentTarget.open) setOpened(true);
  }}>
    <summary><MdIcon name="monitoring" size={18} />{t('diag_title')}</summary>
    <Show when={opened()}><RouteVisible.Provider value={() => routeVisible() && open()}>
      <DiagnosticDetails locked={props.locked} />
    </RouteVisible.Provider></Show>
  </details>;
}

export default function SettingsMaintenance(props: ParentProps<{
  locked: boolean;
  onPending: () => void;
}>): JSX.Element {
  const routeVisible = useContext(RouteVisible);
  const [open, setOpen] = createSignal(false);
  const [opened, setOpened] = createSignal(false);
  return <>
    <details class="tool-disclosure" onToggle={event => {
      setOpen(event.currentTarget.open);
      if (event.currentTarget.open) setOpened(true);
    }}>
      <summary><MdIcon name="settings" size={18} /> {t('tools_advanced')}</summary>
      <div class="tool-disclosure-body">
        {props.children}
        <Show when={opened()}><RouteVisible.Provider value={() => routeVisible() && open()}>
          <ContextRules locked={props.locked} onPending={props.onPending} />
          <HookDetails />
          <Diagnostics locked={props.locked} />
        </RouteVisible.Provider></Show>
      </div>
    </details>
    <SettingsBackup locked={props.locked} />
  </>;
}
