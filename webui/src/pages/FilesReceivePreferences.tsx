import { createEffect, createSignal, on, onCleanup, Show, useContext, type JSX } from 'solid-js';
import { api, createApiScope, nativeControl } from '../api';
import { record } from '../files';
import { t } from '../i18n';
import { onNativeEvent, requestNative, type NativeResult } from '../native';
import { appActive, RouteVisible } from '../schedule';
import { ErrorState } from '../components/Basics';
import { Switch } from '../components/ui';

type Notifications = { enabled: boolean; allowed: boolean };
const AUTO_RECEIVE = 'TAILDROP_AUTO_RECEIVE';

export default function FilesReceivePreferences(): JSX.Element {
  const scope = createApiScope();
  const routeVisible = useContext(RouteVisible);
  const [notifications, setNotifications] = createSignal<Notifications | null>(null);
  const [notificationBusy, setNotificationBusy] = createSignal(false);
  const [notificationError, setNotificationError] = createSignal('');
  const [automatic, setAutomatic] = createSignal<boolean | null>(null);
  const [automaticBusy, setAutomaticBusy] = createSignal(false);
  const [automaticError, setAutomaticError] = createSignal('');
  let disposed = false;
  const visible = () => routeVisible() && appActive() && !document.hidden;
  const canWrite = () => nativeControl().canWrite && !nativeControl().busy;
  function acceptNotifications(value: unknown): boolean {
    if (!record(value) || value.ok !== true || typeof value.enabled !== 'boolean' || typeof value.allowed !== 'boolean') return false;
    setNotifications({ enabled: value.enabled, allowed: value.allowed });
    setNotificationError('');
    return true;
  }
  async function notificationPreference(enabled?: boolean) {
    if (notificationBusy()) return;
    setNotificationBusy(true);
    const result = await requestNative('files.receiveNotifications', enabled === undefined ? {} : { enabled });
    if (disposed) return;
    setNotificationBusy(false);
    if (!acceptNotifications(result)) {
      setNotifications(null);
      setNotificationError(result.error || t('files_invalid_response'));
    }
  }
  function autoValue(result: NativeResult): boolean | null {
    const value = record(result.settings) ? result.settings[AUTO_RECEIVE] : undefined;
    return result.ok && (value === '0' || value === '1') ? value === '1' : null;
  }
  async function automaticPreference(enabled?: boolean) {
    if (automaticBusy() || enabled !== undefined && !canWrite()) return;
    setAutomaticBusy(true); setAutomaticError('');
    try {
      const fresh = await scope.api('settings-get');
      if (disposed || fresh.cancelled) return;
      const current = autoValue(fresh);
      if (current === null) { setAutomatic(null); setAutomaticError(fresh.error || t('files_invalid_response')); return; }
      setAutomatic(current);
      if (enabled === undefined || enabled === current || !canWrite()) return;
      const saved = await api('settings-set', AUTO_RECEIVE, enabled ? '1' : '0');
      if (disposed) return;
      if (!saved.ok || saved.unknown) {
        setAutomatic(null);
        setAutomaticError(saved.unknown ? t('ft_unknown') : saved.error || t('error'));
        return;
      }
      setAutomatic(null);
      const confirmed = await scope.api('settings-get');
      if (disposed) return;
      if (confirmed.cancelled) { setAutomaticError(t('ft_unknown')); return; }
      const value = autoValue(confirmed);
      setAutomatic(value);
      if (value === null) setAutomaticError(confirmed.error || t('files_invalid_response'));
    } finally { if (!disposed) setAutomaticBusy(false); }
  }
  const off = onNativeEvent('files', event => { if (event.receiveNotifications !== undefined) acceptNotifications(event.receiveNotifications); });
  const refresh = () => { if (visible()) { void notificationPreference(); void automaticPreference(); } };
  createEffect(on(() => routeVisible() && appActive(), refresh));
  document.addEventListener('visibilitychange', refresh);
  onCleanup(() => { disposed = true; off(); document.removeEventListener('visibilitychange', refresh); });
  return <div class="files-receive-preferences">
    <div class="tool-setting">
      <div class="tool-setting-copy"><span class="tool-setting-label">{t('ft_auto_receive')}</span><span class="tool-hint" id="files-auto-receive-hint">{t('ft_auto_receive_hint')}</span></div>
      <Switch aria-label={t('ft_auto_receive')} aria-describedby="files-auto-receive-hint" checked={automatic() === true} indeterminate={automatic() === null}
        disabled={automatic() === null || automaticBusy() || !canWrite()} onChange={event => {
          const input = event.currentTarget as HTMLInputElement, enabled = input.checked;
          input.checked = automatic() === true;
          void automaticPreference(enabled);
        }} />
    </div>
    <Show when={automaticError()}><ErrorState text={automaticError()} onRetry={() => void automaticPreference()} /></Show>
    <div class="tool-setting">
      <div class="tool-setting-copy"><span class="tool-setting-label">{t('ft_receive_notifications')}</span>
        <Show when={notifications()?.enabled && !notifications()?.allowed}><span class="tool-hint" id="files-notifications-hint">{t('ft_receive_notifications_blocked')}</span></Show>
      </div>
      <Switch aria-label={t('ft_receive_notifications')} aria-describedby={notifications()?.enabled && !notifications()?.allowed ? 'files-notifications-hint' : undefined}
        checked={notifications()?.enabled === true} indeterminate={!notifications()} disabled={!notifications() || notificationBusy()} onChange={event => {
          const input = event.currentTarget as HTMLInputElement, enabled = input.checked;
          input.checked = notifications()?.enabled === true;
          void notificationPreference(enabled);
        }} />
    </div>
    <Show when={notificationError()}><ErrorState text={notificationError()} onRetry={() => void notificationPreference()} /></Show>
  </div>;
}
