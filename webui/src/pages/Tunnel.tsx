/*
 * Tunnel — tailscale0 interface state (light 6s poll), SOCKS5 self-check
 * (button-triggered), DERP relay speed test as a cancellable session task.
 */
import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, execRaw, hasRoot, type ApiResult } from '../api';
import { t, type I18nKey } from '../i18n';
import { getTask } from '../tasks';
import { latClass } from '../format';
import { Card, KvRow, StatusDot, SkeletonCard, ErrorState } from '../components/Basics';
import { TaskButton, TaskProgress } from '../components/TaskProgress';
import { MdIcon } from '../icons';
import { Button, LinearProgress } from '../components/ui';
import type { DerpRelay } from '../types';

const TASK_KEY = 'derp-speedtest';

interface TunInfo {
  ifaceUp: boolean;
  gateway: string | null;
  hevPid: number | null;
  mode: string;
  socksPort: number;
}

interface DnsInfo extends ApiResult {
  enabled?: boolean;
  state?: string;
  reason?: string;
  suffix?: string;
  upstreamNative?: boolean;
}

const DNS_REASONS: Record<string, I18nKey> = {
  running: 'dns_running', disabled: 'dns_disabled', 'apply-pending': 'dns_apply_pending',
  'disable-pending': 'dns_disable_pending', 'tailnet-unavailable': 'dns_tailnet_unavailable',
  'missing-binary': 'dns_missing_binary', conflict: 'dns_conflict', 'redirect-failed': 'dns_redirect_failed',
  'cleanup-failed': 'dns_cleanup_failed', 'process-failed': 'dns_process_failed',
  'reconcile-needed': 'dns_reconcile_needed', 'private-dns': 'dns_private_dns',
  stopped: 'dns_stopped', degraded: 'dns_degraded',
};

export default function Tunnel(): JSX.Element {
  const scope = createApiScope();
  let seq = 0;
  let loading = false;
  const [tun, setTun] = createSignal<TunInfo | null>(null);
  const [tunError, setTunError] = createSignal<string | null>(null);
  const [socksResult, setSocksResult] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [socksBusy, setSocksBusy] = createSignal(false);
  const [dns, setDns] = createSignal<DnsInfo | null>(null);
  const [dnsBusy, setDnsBusy] = createSignal(false);

  async function checkDns() {
    if (dnsBusy()) return;
    setDnsBusy(true);
    const res = await scope.api('dns');
    if (!res.cancelled) setDns(res as DnsInfo);
    setDnsBusy(false);
  }

  const task = () => getTask(TASK_KEY);
  const relays = (): DerpRelay[] =>
    task()?.result?.ok ? ((task()!.result!.relays as DerpRelay[]) || []) : [];
  const preferred = (): string | null =>
    task()?.result?.ok ? ((task()!.result!.preferred as string) ?? null) : null;

  async function loadTun() {
    if (loading) return;
    loading = true;
    const my = ++seq;
    const res = await scope.api('tun');
    loading = false;
    if (res.cancelled || my !== seq) return;
    if (res.ok) {
      setTun(res as unknown as TunInfo);
      setTunError(null);
    } else {
      setTunError(res.error || t('error'));
    }
  }

  /* SOCKS5 self check via curl through the local proxy (user-triggered). */
  async function checkSocks() {
    if (socksBusy() || !tun() || !['bridge', 'proxy'].includes(tun()!.mode)) return;
    setSocksBusy(true);
    setSocksResult(null);
    const port = Number(tun()?.socksPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setSocksResult({ ok: false, text: t('tun_socks_fail') });
      setSocksBusy(false);
      return;
    }
    const started = Date.now();
    try {
      const out = await execRaw(
        'curl --proxy socks5h://127.0.0.1:' + port +
          ' -sI --max-time 10 -o /dev/null -w "%{http_code}" https://1.1.1.1',
        15000,
      );
      const ms = Date.now() - started;
      const code = String(out).trim();
      const ok = /^[23]/.test(code);
      setSocksResult({
        ok,
        text:
          (ok ? t('tun_socks_ok') : t('tun_socks_fail')) +
          ' · HTTP ' + (code || '???') + ' · ' + ms + 'ms',
      });
    } catch (err) {
      setSocksResult({ ok: false, text: t('tun_socks_fail') + ': ' + String(err) });
    } finally {
      setSocksBusy(false);
    }
  }

  onMount(() => {
    void loadTun();
    const id = setInterval(() => {
      if (!document.hidden) void loadTun();
    }, 6000);
    onCleanup(() => clearInterval(id));
  });

  return (
    <>
      <Show when={tun() !== null || tunError() !== null} fallback={<SkeletonCard lines={3} />}>
        <Card title={t('tun_iface')} icon="router">
          <Show
            when={!tunError()}
            fallback={<ErrorState text={tunError()!} onRetry={() => void loadTun()} />}
          >
            <KvRow
              k={
                <>
                  <StatusDot state={tun()!.ifaceUp ? 'on' : 'off'} />
                  <span>{tun()!.ifaceUp ? t('tun_up') : t('tun_down')}</span>
                </>
              }
              v={<span>{t('dash_mode') + ': ' + tun()!.mode}</span>}
            />
            <KvRow k={t('tun_gateway')} v={tun()!.gateway || '-'} />
            <KvRow
              k={t('tun_hev')}
              v={tun()!.hevPid ? t('tun_pid') + ': ' + tun()!.hevPid : t('tun_not_running')}
            />
          </Show>
        </Card>
      </Show>

      <Card title={t('dns_title')} icon="dns">
        <p class="dim">{t('dns_hint')}</p>
        <Show when={dns()}>
          {(info) => <Show when={info().ok} fallback={<ErrorState text={info().error || t('error')} />}>
            <KvRow k={t('dns_local')} v={info().reason && DNS_REASONS[info().reason!]
              ? t(DNS_REASONS[info().reason!]) : info().reason || info().state || '-'} />
            <KvRow k={t('dns_native')} v={info().upstreamNative ? '✓' : '✗'} />
            <Show when={info().suffix}><KvRow k={t('dns_suffix')} v={info().suffix || '-'} /></Show>
          </Show>}
        </Show>
        <div class="btn-row">
          <Button variant="tonal" disabled={dnsBusy() || !hasRoot} onClick={() => void checkDns()}>
            <MdIcon name="network_check" size={18} /> {dnsBusy() ? t('loading') : t('dns_check')}
          </Button>
        </div>
      </Card>

      <Show when={tun() && ['bridge', 'proxy'].includes(tun()!.mode)}>
        <Card title={t('tun_socks_check')} icon="network_check">
          <Show when={socksBusy()}>
            <div class="progress-row">
              <LinearProgress indeterminate />
              <span class="dim">{t('tun_socks_checking')}</span>
            </div>
          </Show>
          <Show when={socksResult()}>
            {(r) => <div class={r().ok ? 'lat-good' : 'lat-bad'}>{r().text}</div>}
          </Show>
          <div class="btn-row">
            <Button
              variant="tonal"
              disabled={socksBusy() || !hasRoot}
              onClick={() => void checkSocks()}
            >
              <MdIcon name="network_check" size={18} /> {t('tun_socks_check')}
            </Button>
          </div>
        </Card>
      </Show>

      <Card title={t('tun_derp')} icon="speed">
        <TaskProgress taskKey={TASK_KEY} />
        <Show when={task()?.status === 'error'}>
          <ErrorState text={task()?.result?.error || t('error')} />
        </Show>
        <Show when={relays().length > 0}>
          {relays().map((r) => (
            <div class="list-row">
              <div class="main">
                <div class="title mono">
                  {r.code}
                  <Show when={r.code === preferred()}>
                    <span class="badge">{t('tun_preferred')}</span>
                  </Show>
                </div>
              </div>
              <span class={latClass(r.latencyMs)}>{r.latencyMs}ms</span>
            </div>
          ))}
        </Show>
        <div class="btn-row">
          <TaskButton
            taskKey={TASK_KEY}
            cmd="derp-speedtest"
            label={task()?.status === 'running' ? t('tun_derp_testing') : t('tun_derp')}
            icon={<MdIcon name="speed" size={18} />}
          />
        </div>
      </Card>
    </>
  );
}
