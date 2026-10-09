import { createSignal, For, Show, type JSX } from 'solid-js';
import { createApiScope } from '../api';
import { TRIAL_POLL_MS, TRIAL_COUNTDOWN_MS } from '../config';
import { pollWhileVisible } from '../schedule';
import { t } from '../i18n';
import { Card, ErrorState } from '../components/Basics';
import { Button, Select } from '../components/ui';
import { toastApiError } from '../components/Toast';
import { refreshStatus } from '../state';

type Trial = {
  id: string;
  status: 'preparing' | 'running' | 'rolling-back' | 'confirmed' | 'rolled-back' | 'rollback-failed' | 'superseded';
  remaining: number;
  reason: string;
  previous: { mode: string; dnsMode: string; routeScope: string };
  candidate: { mode: string; dnsMode: string; routeScope: string };
};
const labels = {
  preparing: 'trial_preparing', running: 'trial_running', 'rolling-back': 'trial_reverting',
  confirmed: 'trial_confirmed', 'rolled-back': 'trial_reverted', 'rollback-failed': 'trial_failed', superseded: 'trial_superseded',
} as const;

function validTrial(value: unknown): value is Trial | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<Trial>;
  const summary = (v: unknown) => v && typeof v === 'object' &&
    ['mode', 'dnsMode', 'routeScope'].every(key => typeof (v as Record<string, unknown>)[key] === 'string');
  return typeof item.id === 'string' && /^[A-Za-z0-9_-]+$/.test(item.id) &&
    typeof item.status === 'string' && Object.keys(labels).includes(item.status) &&
    typeof item.remaining === 'number' && Number.isFinite(item.remaining) && item.remaining >= 0 &&
    typeof item.reason === 'string' && Boolean(summary(item.candidate) && summary(item.previous));
}

export default function SettingsTrial(props: {
  locked: boolean; onActive: (active: boolean) => void; onUpdate: () => Promise<unknown>;
}): JSX.Element {
  const scope = createApiScope();
  const [trial, setTrial] = createSignal<Trial | null>(null);
  const [error, setError] = createSignal('');
  const [known, setKnown] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [mode, setMode] = createSignal('saved');
  const [duration, setDuration] = createSignal('120');
  const [now, setNow] = createSignal(performance.now());
  const [receivedAt, setReceivedAt] = createSignal(performance.now());
  const active = () => ['preparing', 'running', 'rolling-back', 'rollback-failed'].includes(trial()?.status ?? '');
  let loading = false;
  async function load(refresh = true) {
    if (loading) return;
    loading = true;
    const res = await scope.api('trial-status');
    loading = false;
    if (res.cancelled) return;
    if (!res.ok || !validTrial(res.trial)) {
      setKnown(false);
      setError(res.error || t('trial_invalid_response'));
      return;
    }
    const previous = trial()?.status;
    setTrial(res.trial);
    const received = performance.now();
    setReceivedAt(received);
    setNow(received);
    setKnown(true);
    setError('');
    props.onActive(active());
    if (refresh && previous && previous !== trial()?.status) {
      await props.onUpdate();
      void refreshStatus({ afterCurrent: true });
    }
  }
  async function action(command: string) {
    if (busy() || props.locked || !known()) return;
    setBusy(true);
    const res = command === 'trial-start'
      ? await scope.api(command, duration(), mode())
      : await scope.api(command, trial()?.id ?? '');
    if (!res.cancelled) {
      if (!res.ok) toastApiError(t('op_failed'), res);
      await load(false);
      await props.onUpdate();
      void refreshStatus({ afterCurrent: true });
    }
    setBusy(false);
  }
  pollWhileVisible(() => busy() ? undefined : load(), () =>
    (!known() && !error()) || (active() && trial()?.status !== 'rollback-failed') ? TRIAL_POLL_MS : false);
  pollWhileVisible(() => setNow(performance.now()), () => trial()?.status === 'running' ? TRIAL_COUNTDOWN_MS : false);
  return <Card title={t('trial_title')} icon="sync" description={t('trial_description')}>
    <Show when={error()}><ErrorState text={error()} onRetry={() => void load()} /></Show>
    <div class="tool-setting wide-control">
      <span class="tool-setting-label">{t('trial_candidate')}</span>
      <Select aria-label={t('trial_candidate')} value={mode()} disabled={props.locked || busy() || active()}
        onChange={e => setMode((e.target as HTMLSelectElement).value)}>
        <option value="saved">{t('trial_saved')}</option>
        <For each={['bridge', 'tun', 'proxy']}>{value => <option value={value}>{value}</option>}</For>
      </Select>
    </div>
    <div class="tool-setting wide-control">
      <span class="tool-setting-label">{t('trial_duration')}</span>
      <Select aria-label={t('trial_duration')} value={duration()} disabled={props.locked || busy() || active()}
        onChange={e => setDuration((e.target as HTMLSelectElement).value)}>
        <For each={['30', '60', '120', '300']}>{value => <option value={value}>{value} s</option>}</For>
      </Select>
    </div>
    <Show when={trial()}>{value => <div class="tool-result" role="status" data-testid="trial-status">
      <strong>{t(labels[value().status])}</strong>
      <p>{t('trial_candidate')}: {value().candidate.mode} / {value().candidate.dnsMode} / {value().candidate.routeScope}</p>
      <p>{t('trial_previous')}: {value().previous.mode} / {value().previous.dnsMode} / {value().previous.routeScope}</p>
      <Show when={value().status === 'running'}>
        <p>{t('trial_remaining')}: {Math.max(0, Math.ceil(value().remaining - (now() - receivedAt()) / 1000))} s</p>
      </Show>
      <Show when={value().reason}><p class="tool-hint">{value().reason}</p></Show>
    </div>}</Show>
    <div class="tool-actions" data-testid="trial-controls">
      <Show when={!active()} fallback={<>
        <Button busy={busy()} disabled={props.locked || busy() || !known() || trial()?.status !== 'running'} onClick={() => void action('trial-confirm')}>{t('trial_confirm')}</Button>
        <Button variant="outlined" disabled={props.locked || busy() || !known()} onClick={() => void action('trial-revert')}>{t('trial_revert')}</Button>
      </>}>
        <Button busy={busy()} disabled={props.locked || busy() || !known()} onClick={() => void action('trial-start')}>{t('trial_start')}</Button>
      </Show>
    </div>
    <p class="tool-hint">{t('trial_health_hint')}</p>
  </Card>;
}
