/*
 * Dashboard — status cards fed by the shared 5s status store (no per-page
 * status calls), mode switch, start/stop/restart, key-expiry + coexistence
 * banners, and the dismissible LoginHero on top.
 */
import { createSignal, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot } from '../api';
import { t } from '../i18n';
import { status, statusError, statusLoading, refreshStatus } from '../state';
import { fmtUptime, fmtBytes } from '../format';
import { Card, KvRow, StatusDot, SkeletonCard } from '../components/Basics';
import { LoginHero } from '../components/LoginHero';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, Select } from '../components/ui';

export default function Dashboard(): JSX.Element {
  const scope = createApiScope();
  const keyExpiring = () => {
    const date = status()?.keyExpiry;
    return date && Date.parse(date) - Date.now() < 7 * 24 * 60 * 60 * 1000 ? date : null;
  };
  const [compatWarnings, setCompatWarnings] = createSignal<string[]>([]);
  const [ctlBusy, setCtlBusy] = createSignal(false);
  const [modeBusy, setModeBusy] = createSignal(false);

  onMount(() => {
    /* Key expiry is already present in the shared status snapshot. */
    void scope.api('compat').then((res) => {
      if (res.cancelled || !res.ok) return;
      const warns: string[] = [];
      if (Array.isArray(res.warnings)) warns.push(...(res.warnings as string[]));
      if (typeof res.alert === 'string' && res.alert) warns.push(res.alert);
      setCompatWarnings(warns);
    });
  });

  async function ctl(action: 'start' | 'stop' | 'restart') {
    if (ctlBusy()) return;
    setCtlBusy(true);
    const res = await scope.api('control', action);
    setCtlBusy(false);
    if (res.cancelled) return;
    if (res.ok) showToast(t('dash_action_done'), 'ok');
    else toastApiError(t('op_failed'), res);
    setTimeout(() => void refreshStatus(), 1500);
  }

  async function switchMode(mode: string) {
    if (modeBusy()) return;
    setModeBusy(true);
    const res = await scope.api('mode-set', mode);
    setModeBusy(false);
    if (res.cancelled) return;
    if (res.ok) showToast(t('dash_mode_switched'), 'ok');
    else toastApiError(t('op_failed'), res);
    setTimeout(() => void refreshStatus(), 1200);
  }

  const running = () => status()?.daemon === 'running';

  return (
    <>
      <Show when={statusError() && status()}>
        <div class="banner warn">
          <MdIcon name="warning" size={18} />
          <span>{t('dash_status_stale')}</span>
        </div>
      </Show>

      <LoginHero />

      <Show when={keyExpiring()}>
        <div class="banner warn">
          <MdIcon name="warning" size={18} />
          <span>{t('dash_key_expiring') + keyExpiring()}</span>
        </div>
      </Show>
      {compatWarnings().map((w) => (
        <div class="banner warn">
          <MdIcon name="warning" size={18} />
          <span>
            <strong>{t('dash_compat_warning') + ': '}</strong>
            {w}
          </span>
        </div>
      ))}

      <Show when={!statusLoading()} fallback={<SkeletonCard lines={4} />}>
        <Show when={status()} fallback={
          <Card title={t('dash_daemon')}>
            <div class="state-box">
              <MdIcon name="error" size={20} class="lat-bad" />
              <span class="grow">{t('error')}</span>
              <Button variant="text" onClick={() => void refreshStatus()}>{t('retry')}</Button>
            </div>
          </Card>
        }>
          {(s) => (
            <>
              <Card title={t('dash_daemon')} icon="wifi">
                <KvRow
                  k={
                    <>
                      <StatusDot state={running() ? 'on' : 'off'} />
                      <span>{running() ? t('dash_running') : t('dash_stopped')}</span>
                    </>
                  }
                  v={<span>{t('dash_backend') + ': ' + (s().backend || '-')}</span>}
                />
                <div class="kv">
                  <span class="k">{t('dash_mode')}</span>
                  <span class="v">
                    <Select
                      label={t('dash_mode')}
                      value={s().mode}
                      disabled={modeBusy() || !hasRoot}
                      onChange={(e: Event) => {
                        const v = (e.target as HTMLSelectElement).value;
                        if (v && v !== s().mode) void switchMode(v);
                      }}
                    >
                      {['bridge', 'tun', 'proxy'].map((m) => (
                        <option value={m} selected={s().mode === m}>{m}</option>
                      ))}
                    </Select>
                  </span>
                </div>
                <KvRow k={t('dash_uptime')} v={fmtUptime(s().uptime)} />
                <KvRow
                  k={t('dash_peers_online') + ' / ' + t('dash_peers_offline')}
                  v={s().peers ? s().peers!.online + ' / ' + s().peers!.offline : '-'}
                />
                <KvRow k={t('dash_magicdns')} v={s().magicDns ? '✓' : '✗'} />
              </Card>

              <Card>
                <div class="btn-row" style={{ 'margin-top': '0' }}>
                  <Button
                    variant="filled"
                    disabled={running() || ctlBusy() || !hasRoot}
                    onClick={() => void ctl('start')}
                  >
                    <MdIcon name="play_arrow" size={18} /> {t('dash_start')}
                  </Button>
                  <Button
                    variant="tonal"
                    disabled={!running() || ctlBusy() || !hasRoot}
                    onClick={() => void ctl('stop')}
                  >
                    <MdIcon name="stop" size={18} /> {t('dash_stop')}
                  </Button>
                  <Button
                    variant="outlined"
                    disabled={!running() || ctlBusy() || !hasRoot}
                    onClick={() => void ctl('restart')}
                  >
                    <MdIcon name="restart_alt" size={18} /> {t('dash_restart')}
                  </Button>
                </div>
              </Card>

              <Card title={t('dash_self')} icon="person">
                <Show when={s().self} fallback={<div class="dim">-</div>}>
                  {(self) => (
                    <>
                      <KvRow k={t('dash_hostname')} v={self().hostname} />
                      <KvRow k="IP" v={(self().ips || []).join(', ')} />
                      <KvRow k={t('dash_relay')} v={self().relay} />
                    </>
                  )}
                </Show>
              </Card>

              <Card title={t('dash_exitnode')} icon="logout">
                <Show when={s().exitNode} fallback={<div class="dim">{t('dash_no_exitnode')}</div>}>
                  {(en) => (
                    <>
                      <KvRow
                        k={
                          <>
                            <StatusDot state={en().online ? 'on' : 'off'} />
                            <span>{en().hostname}</span>
                          </>
                        }
                        v={<span class="mono">{en().ip}</span>}
                      />
                      <KvRow
                        k={t('dash_traffic')}
                        v={'↓ ' + fmtBytes(en().rx) + '  ↑ ' + fmtBytes(en().tx)}
                      />
                    </>
                  )}
                </Show>
              </Card>
            </>
          )}
        </Show>
      </Show>
    </>
  );
}
