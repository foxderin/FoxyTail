/* Pending settings edits are process-wide: the shell bar surfaces them on any
 * page, while the settings page owns reviewing, saving and applying them. */
import { createSignal } from 'solid-js';

const [settingsDrafts, setSettingsDrafts] = createSignal<Record<string, { baseline: string; value: string }>>({});
const [restartRequired, setRestartRequired] = createSignal(false);
/* Raised by the shell bar and consumed by the settings page so the review
 * dialog can open even when it mounts after the intent was raised. */
const [applyRequested, setApplyRequested] = createSignal(false);

export {
  settingsDrafts,
  setSettingsDrafts,
  restartRequired,
  setRestartRequired,
  applyRequested,
  setApplyRequested,
};

export const settingsDraftCount = () => Object.keys(settingsDrafts()).length;
