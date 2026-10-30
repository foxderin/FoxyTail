/** Views over the shared service store; no surface owns lifecycle state. */
import { For, Show, type JSX } from 'solid-js';
import { nativeControl } from '../api';
import { getTask } from '../tasks';
import { t, type I18nKey } from '../i18n';
import { MdIcon } from '../icons';
import {
  MODE_LABELS, RUN_MODES, type RunMode,
  acknowledgeNative, cancelNativeOperation, emergencyStop, emergencyStopAvailable, recheckNative,
  runService, serviceBusy, serviceFeedback, serviceKnown, serviceLocked, serviceMessage, serviceMode,
  serviceOperationRunning, servicePending, serviceRunning, serviceWarning, verifyService,
} from '../service';
import { Button, CircularProgress } from './ui';

const MODE_HINTS: Record<RunMode, I18nKey> = { tun: 'tools_tun_desc', bridge: 'tools_bridge_desc', proxy: 'tools_proxy_desc' };

export function ServiceActions(): JSX.Element {
  const taskAction = () => {
    const task = getTask('service-control');
    return serviceOperationRunning() && task ? (task.cmd === 'mode-set' ? 'mode' : String(task.args[0] ?? '')) : '';
  };
  const working = (action: string) => serviceBusy() === action || taskAction() === action;
  const message = () => !serviceKnown() && !serviceFeedback() && !serviceBusy() && !serviceOperationRunning() ? '' : serviceMessage();
  const verify = () => serviceKnown() && !serviceBusy() && !serviceOperationRunning() && Boolean(servicePending() || serviceFeedback()?.unconfirmed);
  return (
    <div class="service-actions" role="group" aria-label={t('net_controls_label')} aria-busy={Boolean(serviceBusy()) || serviceOperationRunning()}>
      <div class="service-actions-row">
        <Show
          when={serviceKnown()}
          fallback={
            <Button variant="outlined" busy={serviceBusy() === 'refresh'} onClick={() => void verifyService()}>
              <MdIcon name="refresh" size={18} />{t('native_recheck')}
            </Button>
          }
        >
          <Show
            when={serviceRunning()}
            fallback={
              <Button busy={working('start')} disabled={serviceLocked()} onClick={() => void runService('start')}>
                <MdIcon name="play_arrow" size={18} />{t('dash_start_service')}
              </Button>
            }
          >
            <Button variant="outlined" class="danger" busy={working('stop')} disabled={serviceLocked()} onClick={() => void runService('stop')}>
              <MdIcon name="stop" size={18} />{t('native_stop')}
            </Button>
            <Button variant="outlined" busy={working('restart')} disabled={serviceLocked()} onClick={() => void runService('restart')}>
              <MdIcon name="restart_alt" size={18} />{t('dash_restart')}
            </Button>
          </Show>
        </Show>
        <Show when={emergencyStopAvailable()}>
          <Button variant="outlined" class="danger" onClick={() => void emergencyStop()}>
            <MdIcon name="stop" size={18} />{t('native_emergency_stop')}
          </Button>
        </Show>
      </div>
      <Show when={message()}>
        <div class="service-controls-feedback" classList={{ warning: serviceWarning() }} role="status">
          <Show when={serviceBusy() || serviceOperationRunning()} fallback={<MdIcon name={serviceWarning() ? 'warning' : 'info'} size={16} />}>
            <CircularProgress size={16} />
          </Show>
          <span>{message()}</span>
          <Show when={verify()}>
            <Button variant="text" class="service-controls-retry" onClick={() => void verifyService()}>{t('retry')}</Button>
          </Show>
          <Show when={!serviceBusy() && serviceFeedback()?.settings}>
            <a href="#/settings">{t('set_title')}</a>
          </Show>
        </div>
      </Show>
    </div>
  );
}

export function NativeIssueActions(): JSX.Element {
  return (
    <div class="root-banner-actions">
      <Button variant="text" onClick={recheckNative}><MdIcon name="refresh" size={18} />{t('native_recheck')}</Button>
      <Show when={nativeControl().canCancel}>
        <Button variant="text" onClick={cancelNativeOperation}><MdIcon name="close" size={18} />{t('native_cancel_operation')}</Button>
      </Show>
      <Show when={nativeControl().unknown}>
        <Button variant="tonal" onClick={acknowledgeNative}><MdIcon name="check" size={18} />{t('native_unlock')}</Button>
      </Show>
    </div>
  );
}

export function ModePicker(): JSX.Element {
  let group!: HTMLDivElement;
  const reset = () => group.querySelectorAll<HTMLInputElement>('input[name="run-mode"]').forEach(input => { input.checked = input.value === serviceMode(); });
  return (
    <div class="tool-policy-list" role="radiogroup" aria-label={t('dash_mode')} ref={group} data-testid="mode-picker">
      <For each={RUN_MODES}>
        {(mode) => (
          <label class="tool-policy">
            <input
              type="radio"
              name="run-mode"
              value={mode}
              checked={serviceMode() === mode}
              disabled={serviceLocked()}
              onChange={() => { reset(); void runService('mode', mode).finally(reset); }}
            />
            <span class="tool-policy-copy">
              <strong>
                {t(MODE_LABELS[mode])}
                <Show when={serviceKnown() && serviceMode() === mode}><span class="network-small-badge">{t('exit_current')}</span></Show>
              </strong>
              <span class="tool-hint">{t(MODE_HINTS[mode])}</span>
            </span>
          </label>
        )}
      </For>
    </div>
  );
}
