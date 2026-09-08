/*
 * Tunnel — tailscale0 interface state (light 6s poll), SOCKS5 self-check
 * (button-triggered), DERP relay speed test as a cancellable session task.
 */
import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, execRaw, hasRoot } from '../api';
import { t } from '../i18n';
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

export default function Tunnel(): JSX.Element {
  const scope = createApiScope();
  const [tun, setTun] = createSignal<TunInfo | null>(null);
  const [tunError, setTunError] = createSignal<string | null>(null);
  const [socksResult, setSocksResult] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [socksBusy, setSocksBusy] = createSignal(false);

  const task = () => getTask(TASK_KEY);
  const relays = (): DerpRelay[] =>
    task()?.result?.ok ? ((task()!.result!.relays as DerpRelay[]) || []) : [];
  const preferred = (): string | null =>
    task()?.result?.ok ? ((task()!.result!.preferred as string) ?? null) : null;

  async function loadTun() {
    const res = await scope.api('tun');
    if (res.cancelled) return;
    if (res.ok) {
      setTun(res as unknown as TunInfo);
      setTunError(null);
    } else {
      setTunError(res.error || t('error'));
    }
  }

  /* SOCKS5 self check via curl through the local proxy (user-triggered). */
  async function checkSocks() {
    if (socksBusy()) return;
    setSocksBusy(true);
    setSocksResult(null);
    const port = tun()?.socksPort || 1099;
    const started = Date.now();
    try {
      const out = await execRaw(
        'curl -x 127.0.0.1:' + port +
          ' -sI --max-time 10 -o /dev/null -w "%{http_code}" https://1.1.1.1',
        15000,
      );
      const ms = Date.now() - started;
      const code = String(out).trim();
      const ok = /^[23]/.test(code) || code === '301' || code === '302' || code.length === 3;
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
            disabled={socksBusy() || !hasRoot || false}
            onClick={() => void checkSocks()}
          >
            <MdIcon name="network_check" size={18} /> {t('tun_socks_check')}
          </Button>
        </div>
      </Card>

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
