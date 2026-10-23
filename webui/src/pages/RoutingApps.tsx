import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { createApiScope } from '../api';
import { t } from '../i18n';
import type { AppInfo } from '../types';
import { Card, SkeletonRows, EmptyState } from '../components/Basics';
import { LoadGate } from '../components/LoadGate';
import { Button, Checkbox, TextField } from '../components/ui';
import { MdIcon } from '../icons';

export default function RoutingApps(props: {
  visible: boolean;
  uids: string[];
  selected: boolean;
  locked: boolean;
  onToggle: (uid: number, checked: boolean) => void;
}): JSX.Element {
  const scope = createApiScope();
  const [apps, setApps] = createSignal<AppInfo[] | null>(null);
  const [appsError, setAppsError] = createSignal<string | null>(null);
  const [searchText, setSearchText] = createSignal('');
  const [filter, setFilter] = createSignal('');
  const [showSelected, setShowSelected] = createSignal(false);
  const [visibleLimit, setVisibleLimit] = createSignal(100);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(searchTimer));
  let requested = false;
  createEffect(() => {
    if (props.visible && !requested) {
      requested = true;
      void loadApps();
    }
  });
  async function loadApps() {
    setAppsError(null);
    setApps(null);
    const res = await scope.api('apps');
    if (res.cancelled) return;
    if (res.ok && Array.isArray(res.apps) && res.apps.every(app => app && typeof app.label === 'string' &&
        typeof app.package === 'string' && Number.isSafeInteger(app.uid) && app.uid >= 0)) setApps(res.apps as AppInfo[]);
    else {
      setApps([]);
      setAppsError(res.error || t('error'));
    }
  }
  function onSearch(value: string) {
    setSearchText(value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      setFilter(value);
      setVisibleLimit(100);
    }, 200);
  }
  const matchingApps = createMemo(() => {
    const needle = filter().toLocaleLowerCase();
    return (apps() ?? [])
      .filter(
        (app) =>
          (!showSelected() || props.uids.includes(String(app.uid))) &&
          (!needle ||
            (app.label + ' ' + app.package + ' ' + app.uid).toLocaleLowerCase().includes(needle)),
      )
      .sort((a, b) => a.label.localeCompare(b.label));
  });
  return (
    <Show when={props.visible}>
      <Card title={t('route_apps')} icon="group" description={t('tools_route_apps_desc')}>
        <TextField
          label={t('tools_search_apps')}
          aria-label={t('tools_search_apps')}
          value={searchText()}
          onInput={(e) => onSearch((e.target as HTMLInputElement).value)}
          leading-icon={<MdIcon name="search" size={18} />}
        />
        <div class="tool-app-toolbar">
          <span>
            {t('tools_selected')} {props.uids.length} {t('tools_items')}
          </span>
          <button
            type="button"
            class={'filter-chip' + (showSelected() ? ' active' : '')}
            aria-pressed={showSelected()}
            onClick={() => setShowSelected(!showSelected())}
          >
            {t('tools_selected')}
          </button>
        </div>
        <Show when={props.selected && !props.uids.length}>
          <p class="tool-hint">{t('tools_route_empty_selection')}</p>
        </Show>
        <LoadGate
          ready={apps() !== null}
          error={appsError()}
          onRetry={() => void loadApps()}
          skeleton={<SkeletonRows rows={5} />}
          hasContent={matchingApps().length > 0}
          empty={<EmptyState text={t('empty')} icon="search" />}
        >
              <div class="tool-app-list">
                <For each={matchingApps().slice(0, visibleLimit())}>
                  {(app) => (
                    <div class="list-row tool-app-row" data-uid={app.uid}>
                      <Checkbox
                        id={'route-app-' + app.uid + '-' + app.package}
                        aria-label={app.label}
                        checked={props.uids.includes(String(app.uid))}
                        disabled={props.locked}
                        onChange={(e) =>
                          props.onToggle(app.uid, (e.target as HTMLInputElement).checked)
                        }
                      />
                      <label
                        class="main tool-app-label"
                        for={'route-app-' + app.uid + '-' + app.package}
                      >
                        <span class="title">{app.label}</span>
                        <span class="sub">
                          {app.package} · UID {app.uid}
                        </span>
                      </label>
                    </div>
                  )}
                </For>
              </div>
              <Show when={matchingApps().length > visibleLimit()}>
                <Button variant="text" onClick={() => setVisibleLimit((value) => value + 100)}>
                  {t('tools_route_show_all')} ({matchingApps().length - visibleLimit()})
                </Button>
              </Show>
        </LoadGate>
      </Card>
    </Show>
  );
}
