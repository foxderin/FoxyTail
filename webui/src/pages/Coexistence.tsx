import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot, nativeControl } from '../api';
import { copyWithToast } from '../clipboard';
import { coexistSnippet, type CheckId, type CoexistCheck, type CoexistInfo, type FilterMode } from '../coexistence';
import { t, type I18nKey } from '../i18n';
import { Card, EmptyState, ErrorState, KvRow, SkeletonRows, StatusBadge } from '../components/Basics';
import { Button, Select, TextField } from '../components/ui';
import { dnsStatusLabel, dnsStatusTone } from './tunnel-dns';
import { status, statusError } from '../state';
import { savedConfigRevision } from '../config';
import { bindSessionDraft } from '../session-drafts';

const CHECK_LABELS: Record<CheckId, I18nKey> = {
  'dns-udp': 'coexist_dns_udp',
  'dns-tcp': 'coexist_dns_tcp',
  'resolver-udp': 'coexist_resolver_udp',
  'resolver-tcp': 'coexist_resolver_tcp',
  tcp: 'coexist_tcp',
};
const CHECK_IDS: CheckId[] = ['dns-udp', 'dns-tcp', 'resolver-udp', 'resolver-tcp', 'tcp'];
const portValid = (value: string) => /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;

export default function Coexistence(): JSX.Element {
  const scope = createApiScope();
  const [info, setInfo] = createSignal<CoexistInfo | null>(null);
  const [readBusy, setReadBusy] = createSignal(false);
  const [checkBusy, setCheckBusy] = createSignal(false);
  const [readError, setReadError] = createSignal<string | null>(null);
  const [checkError, setCheckError] = createSignal<string | null>(null);
  const [filterMode, setFilterMode] = createSignal('');
  const [peerId, setPeerId] = createSignal('');
  const [address, setAddress] = createSignal('');
  const [targetPort, setTargetPort] = createSignal('');
  const [resolverPort, setResolverPort] = createSignal('');
  const [result, setResult] = createSignal<CoexistCheck | null>(null);
  bindSessionDraft('coexist', () => ({ filterMode: filterMode(), targetPort: targetPort(), resolverPort: resolverPort() }), value => {
    if (typeof value.filterMode === 'string' && ['', 'blacklist', 'rule', 'redir-host', 'whitelist'].includes(value.filterMode)) setFilterMode(value.filterMode);
    if (typeof value.targetPort === 'string') setTargetPort(value.targetPort);
    if (typeof value.resolverPort === 'string') setResolverPort(value.resolverPort);
  });
  const busy = () => readBusy() || checkBusy() || nativeControl().busy || !nativeControl().canWrite;
  const viewContext = () => [nativeControl().accountRevision, savedConfigRevision(), statusError() || '', status()?.daemon, status()?.backend,
    status()?.mode, ...(status()?.self?.ips || [])].join('|');
  createEffect(on(viewContext, () => {
    if (!info()) return;
    setInfo(null);
    invalidateCheck();
    setReadError(t('coexist_context_changed'));
  }, { defer: true }));
  const peer = () => info()?.peers.find(item => item.id === peerId());
  const resolverValid = () => !resolverPort() || (portValid(resolverPort()) && Number(resolverPort()) !== info()?.dns.port);
  const canCheck = () => hasRoot && !busy() && info()?.dnsReady === true && !!peer()?.ips.includes(address()) &&
    portValid(targetPort()) && resolverValid();
  const preview = createMemo(() => {
    if (!info()?.dnsReady || !filterMode() || filterMode() === 'whitelist') return { text: '', error: false };
    try { return { text: coexistSnippet(info()!, filterMode() as FilterMode), error: false }; }
    catch { return { text: '', error: true }; }
  });
  function invalidateCheck() {
    setResult(null);
    setCheckError(null);
  }
  async function copySnippet() {
    const current = info(), text = preview().text, context = viewContext();
    if (busy() || !current || !text) return;
    setReadBusy(true);
    const latest = await scope.api('coexist-info');
    setReadBusy(false);
    if (latest.cancelled) return;
    if (!latest.ok || latest.snapshot !== current.snapshot || latest.dnsReady !== true ||
        info() !== current || preview().text !== text || viewContext() !== context) {
      invalidateCheck(); setInfo(null); setReadError(latest.error || t('coexist_context_changed')); return;
    }
    copyWithToast(text);
  }
  async function detect() {
    if (busy() || !hasRoot) return;
    invalidateCheck();
    setInfo(null);
    setReadError(null);
    setPeerId('');
    setAddress('');
    setReadBusy(true);
    const startedContext = viewContext();
    try {
      const response = await scope.api('coexist-info');
      if (response.cancelled) return;
      if (viewContext() !== startedContext) { setReadError(t('coexist_context_changed')); return; }
      if (response.ok && typeof response.snapshot === 'string' && Array.isArray(response.peers) &&
          response.peers.every(peer => peer && typeof peer.id === 'string' && typeof peer.dnsName === 'string' && Array.isArray(peer.ips)) &&
          response.environment && typeof response.environment === 'object' &&
          Array.isArray((response.environment as CoexistInfo['environment']).modules) &&
          Array.isArray((response.environment as CoexistInfo['environment']).apps) &&
          Array.isArray((response.environment as CoexistInfo['environment']).warnings) && response.dns && typeof response.dns === 'object') setInfo(response as CoexistInfo);
      else setReadError(response.error || t('error'));
    } finally { setReadBusy(false); }
  }
  async function check() {
    if (!canCheck()) return;
    invalidateCheck();
    setCheckBusy(true);
    const current = info()!;
    try {
      const response = await scope.api('coexist-check', current.snapshot, peerId(), address(), targetPort(), resolverPort() || '-');
      if (response.cancelled) return;
      if (response.ok && info() === current && response.snapshot === current.snapshot && response.name === peer()?.dnsName &&
          response.address === address() && response.targetPort === Number(targetPort()) &&
          response.path === (current.mode === 'tun' ? 'system' : 'socks5') && Array.isArray(response.checks) &&
          response.checks.every(row => row && CHECK_IDS.includes(row.id) && typeof row.ok === 'boolean' &&
            typeof row.elapsedMs === 'number' && Number.isFinite(row.elapsedMs) &&
            (row.addresses === undefined || Array.isArray(row.addresses) && row.addresses.every((value: unknown) => typeof value === 'string')))) setResult(response as CoexistCheck);
      else {
        setCheckError(response.error || t('coexist_context_changed'));
        setInfo(null);
      }
    } finally { setCheckBusy(false); }
  }
  return (
    <Card title={t('coexist_title')} icon="alt_route" description={t('coexist_intro')}>
      <div class="tool-form" data-testid="coexist-wizard">
        <div class="tool-actions">
          <Button variant="tonal" busy={readBusy()} disabled={!hasRoot || busy()} onClick={() => void detect()}>
            {info() ? t('coexist_refresh') : t('coexist_detect')}
          </Button>
        </div>
        <Show when={!hasRoot}><p class="tool-hint">{t('no_root_banner')}</p></Show>
        <Show when={readBusy()}><SkeletonRows rows={3} /></Show>
        <Show when={readError()}>{error => <ErrorState text={error()} onRetry={() => void detect()} />}</Show>
        <Show when={checkError()}>{error => <ErrorState text={error()} />}</Show>
        <Show when={!info() && !readBusy() && !readError()}><EmptyState text={t('coexist_unchecked')} /></Show>
        <Show when={info()}>{current => <>
          <div class="tool-group" aria-live="polite">
            <h3>{t('coexist_environment')}</h3>
            <p class="tool-hint">{t('coexist_inventory_hint')}</p>
            <Show when={current().environment.modules.length || current().environment.apps.length}
              fallback={<p class="tool-hint">{t('coexist_inventory_empty')}</p>}>
              <ul>
                <For each={current().environment.modules}>{item => <li>{item.name} · {item.kind}</li>}</For>
                <For each={current().environment.apps}>{item => <li>{item.package} · {item.kind}</li>}</For>
              </ul>
            </Show>
            <Show when={current().environment.alert}>{alert => <p class="tool-hint">{alert()}</p>}</Show>
            <For each={current().environment.warnings}>{warning => <p class="tool-hint">{warning}</p>}</For>
            <KvRow k={t('coexist_applied_mode')} v={<code>{current().mode}</code>} />
            <KvRow k={t('dns_suffix')} v={<code>{current().suffix}</code>} />
            <KvRow k={t('dns_title')} v={<StatusBadge tone={dnsStatusTone(current().dns)}>{dnsStatusLabel(current().dns)}</StatusBadge>} />
            <Show when={current().dnsReady} fallback={<>
              <p class="tool-hint">{t('coexist_prerequisite')}</p>
              <a class="tool-text-link" href="#/settings">{t('tools_dns_settings')}</a>
            </>}>
              <KvRow k={t('tools_dns_endpoint')} v={<code>127.0.0.1:{current().dns.port}</code>} />
              <KvRow k={t('coexist_target_path')} v={<code>{current().mode === 'tun' ? 'tailscale0' : 'SOCKS5 127.0.0.1:' + current().socksPort}</code>} />
            </Show>
          </div>
          <Show when={current().dnsReady}>
            <div class="tool-group">
              <h3>{t('coexist_filter_step')}</h3>
              <p class="tool-hint">{t('coexist_core_hint')}</p>
              <Select label={t('coexist_filter_label')} value={filterMode()} disabled={busy()} onChange={event => {
                invalidateCheck(); setFilterMode((event.currentTarget as HTMLSelectElement).value);
              }}>
                <option value="">{t('coexist_filter_choose')}</option>
                <option value="blacklist">fake-ip · blacklist</option>
                <option value="rule">fake-ip · rule</option>
                <option value="redir-host">redir-host</option>
                <option value="whitelist">{t('coexist_filter_whitelist')}</option>
              </Select>
              <Show when={filterMode() === 'whitelist'}><p class="tool-hint" role="alert">{t('coexist_whitelist_hint')}</p></Show>
              <Show when={preview().error}><ErrorState text={t('coexist_invalid_snapshot')} /></Show>
            </div>
            <Show when={preview().text}>
              <div class="tool-group">
                <h3>{t('coexist_snippet_step')}</h3>
                <p class="tool-hint">{t('coexist_merge_hint')}</p>
                <p class="tool-hint">{t('coexist_scope_hint')}</p>
                <p class="tool-hint">{t('coexist_name_hint')}</p>
                <p class="tool-hint">{t(current().mode === 'tun' ? 'coexist_tun_hint' : 'coexist_socks_hint')}</p>
                <p class="tool-hint">{t('coexist_ipv6_hint')}</p>
                <TextField label={t('coexist_yaml')} rows={14} readonly value={preview().text} class="mono" />
                <div class="tool-actions"><Button variant="outlined" disabled={busy()} onClick={() => void copySnippet()}>{t('copy')}</Button></div>
              </div>
            </Show>
            <div class="tool-group">
              <h3>{t('coexist_check_step')}</h3>
              <p class="tool-hint">{t('coexist_check_hint')}</p>
              <Show when={current().peers.length} fallback={<EmptyState text={t('coexist_no_peers')} />}>
                <Select label={t('coexist_peer')} value={peerId()} disabled={busy()} onChange={event => {
                  invalidateCheck(); setPeerId((event.currentTarget as HTMLSelectElement).value); setAddress('');
                }}>
                  <option value="">{t('coexist_peer_choose')}</option>
                  <For each={current().peers}>{item => <option value={item.id}>{item.dnsName}{item.online ? '' : ' · ' + t('offline')}</option>}</For>
                </Select>
                <Select label={t('coexist_address')} value={address()} disabled={busy() || !peer()} onChange={event => {
                  invalidateCheck(); setAddress((event.currentTarget as HTMLSelectElement).value);
                }}>
                  <option value="">{t('coexist_address_choose')}</option>
                  <For each={peer()?.ips || []}>{ip => <option value={ip}>{ip}</option>}</For>
                </Select>
                <div class="tool-form-row">
                  <TextField label={t('coexist_port')} value={targetPort()} inputmode="numeric" required disabled={busy()}
                    aria-invalid={!!targetPort() && !portValid(targetPort())} onInput={event => {
                      invalidateCheck(); setTargetPort((event.currentTarget as HTMLInputElement).value);
                    }} />
                  <TextField label={t('coexist_resolver_port')} value={resolverPort()} inputmode="numeric" disabled={busy()}
                    aria-invalid={!resolverValid()} onInput={event => {
                      invalidateCheck(); setResolverPort((event.currentTarget as HTMLInputElement).value);
                    }} />
                </div>
                <p class="tool-hint">{t('coexist_ports_hint')}</p>
                <Show when={(!!targetPort() && !portValid(targetPort())) || !resolverValid()}><p class="tool-hint" role="alert">{t('coexist_invalid_port')}</p></Show>
                <div class="tool-actions"><Button busy={checkBusy()} disabled={!canCheck()} onClick={() => void check()}>{t('coexist_check')}</Button></div>
                <Show when={checkBusy()}><p role="status">{t('coexist_checking')}</p></Show>
                <Show when={result()}>{checked => <div class="tool-result" aria-live="polite" data-testid="coexist-check-results">
                  <KvRow k={t('coexist_peer')} v={checked().name} />
                  <KvRow k={t('coexist_target')} v={<code>{checked().address.includes(':') ? '[' + checked().address + ']' : checked().address}:{checked().targetPort}</code>} />
                  <KvRow k={t('coexist_target_path')} v={t(checked().path === 'socks5' ? 'coexist_path_socks' : 'coexist_path_system')} />
                  <For each={CHECK_IDS}>{id => {
                    const row = () => checked().checks.find(item => item.id === id);
                    return <div data-check={id}>
                      <KvRow k={t(CHECK_LABELS[id])} v={<StatusBadge tone={row() ? row()!.ok ? 'success' : 'danger' : 'neutral'}>
                        {row() ? t(row()!.ok ? 'coexist_pass' : 'coexist_fail') : t(id.startsWith('resolver-') && !resolverPort() ? 'coexist_skipped' : 'coexist_not_checked')}
                      </StatusBadge>} />
                      <Show when={row()}>{item => <>
                        <span class="tool-hint">{item().elapsedMs} ms</span>
                        <Show when={item().error}>{error => <p class="tool-hint">{error()}</p>}</Show>
                        <Show when={item().addresses?.length}><p class="tool-hint">{t('coexist_observed')}: {item().addresses?.join(', ')}</p></Show>
                      </>}</Show>
                    </div>;
                  }}</For>
                  <p class="tool-hint">{t('coexist_result_boundary')}</p>
                </div>}</Show>
              </Show>
            </div>
          </Show>
        </>}</Show>
      </div>
    </Card>
  );
}
