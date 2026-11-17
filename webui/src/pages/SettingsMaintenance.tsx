import { createEffect, createSignal, For, Show, on, useContext, type JSX, type ParentProps } from 'solid-js';
import { createApiScope } from '../api';
import { t } from '../i18n';
import { Card, SkeletonRows } from '../components/Basics';
import { MdIcon } from '../icons';
import ContextRules from './ContextRules';
import SettingsBackup from './SettingsBackup';
import { RouteVisible } from '../schedule';
import { createGuardedLoad } from './tools-refresh';

const HOOKS: [string, 'set_hook_up' | 'set_hook_down'][] = [
  ['foxytail.tun.up', 'set_hook_up'],
  ['foxytail.tun.down', 'set_hook_down'],
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
        </RouteVisible.Provider></Show>
      </div>
    </details>
    <SettingsBackup locked={props.locked} />
  </>;
}
