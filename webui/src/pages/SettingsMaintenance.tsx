import { createSignal, For, onCleanup, Show, type JSX, type ParentProps } from 'solid-js';
import { execRaw, quote } from '../api';
import { DATA_DIR, DEFAULT_TIMEOUT_MS } from '../config';
import { t } from '../i18n';
import { Card, SkeletonRows } from '../components/Basics';
import { MdIcon } from '../icons';
import ContextRules from './ContextRules';
import SettingsBackup from './SettingsBackup';

const HOOKS: [string, 'set_hook_up' | 'set_hook_down'][] = [
  ['foxytail.tun.up', 'set_hook_up'],
  ['foxytail.tun.down', 'set_hook_down'],
];

export default function SettingsMaintenance(props: ParentProps<{
  locked: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onPending: () => void;
  onRestore: () => Promise<unknown>;
}>): JSX.Element {
  const hookAbort = new AbortController();
  onCleanup(() => hookAbort.abort());
  const [advancedLoaded, setAdvancedLoaded] = createSignal(false);
  const [advancedBusy, setAdvancedBusy] = createSignal(false);
  const [revision, setRevision] = createSignal(1);
  const [hooks, setHooks] = createSignal<Record<string, string>>({});
  async function loadAdvanced() {
    if (advancedBusy()) return;
    setAdvancedBusy(true);
    await Promise.all(HOOKS.map(async ([file, key]) => {
      try {
        const out = await execRaw('cat ' + quote(DATA_DIR + '/scripts/' + file) + ' 2>/dev/null || echo "(missing)"', DEFAULT_TIMEOUT_MS, hookAbort.signal);
        if (!hookAbort.signal.aborted) setHooks(h => ({ ...h, [key]: out === '(missing)' ? t('misc_missing') : out || t('misc_empty') }));
      } catch {
        if (!hookAbort.signal.aborted) setHooks(h => ({ ...h, [key]: t('misc_unavailable') }));
      }
    }));
    setAdvancedBusy(false);
    setAdvancedLoaded(true);
  }
  async function restored() {
    await props.onRestore();
    setRevision(value => value + 1);
    if (advancedLoaded()) void loadAdvanced();
  }
  return <>
    <details class="tool-disclosure" onToggle={e => { if (e.currentTarget.open && !advancedLoaded()) void loadAdvanced(); }}>
      <summary><MdIcon name="settings" size={18} /> {t('tools_advanced')}</summary>
      <div class="tool-disclosure-body">
        {props.children}
        <Show when={advancedLoaded() && !advancedBusy()} fallback={<SkeletonRows rows={5} />}>
          <Show when={revision()} keyed>{(_revision) => <ContextRules locked={props.locked} onPending={props.onPending} />}</Show>
          <Card title={t('set_hooks')} icon="article" description={t('set_hooks_hint')}>
            <For each={HOOKS}>{([, key]) => <div class="tool-result"><p class="tool-hint">{t(key)}</p><pre class="mono">{hooks()[key] ?? t('loading')}</pre></div>}</For>
          </Card>
        </Show>
      </div>
    </details>
    <SettingsBackup locked={props.locked} busy={props.busy} setBusy={props.setBusy} onPending={props.onPending} onRestore={restored} />
  </>;
}
