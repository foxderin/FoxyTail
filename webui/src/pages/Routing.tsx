/*
 * Routing — scope (all/selected/bypass), per-app checklist (apps list loads
 * on entry with skeleton + timeout; droppable on page switch), subnet editor,
 * apply. xt_owner probe hides per-app scope when unsupported.
 */
import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, execRaw, hasRoot } from '../api';
import { t } from '../i18n';
import { Card, KvRow, SkeletonRows, EmptyState, ErrorState } from '../components/Basics';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, Checkbox, IconButton, TextField } from '../components/ui';
import type { AppInfo } from '../types';

type Scope = 'all' | 'selected' | 'bypass';

function validCidr(s: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(s) || /^[0-9a-fA-F:]+\/\d{1,3}$/.test(s);
}

export default function Routing(): JSX.Element {
  const scope = createApiScope();
  const [scope_, setScope] = createSignal<Scope>('all');
  const [uids, setUids] = createSignal<number[]>([]);
  const [subnets, setSubnets] = createSignal<string[]>([]);
  const [ownerOk, setOwnerOk] = createSignal(true);
  const [apps, setApps] = createSignal<AppInfo[] | null>(null);
  const [appsError, setAppsError] = createSignal<string | null>(null);
  const [filter, setFilter] = createSignal('');
  const [newSubnet, setNewSubnet] = createSignal('');
  const [applyBusy, setApplyBusy] = createSignal(false);

  /* xt_owner probe: hide per-app scope when unsupported */
  onMount(() => {
    execRaw('iptables -m owner --help >/dev/null 2>&1 && echo yes || echo no')
      .then((out) => {
        if (String(out).indexOf('yes') === -1) setOwnerOk(false);
      })
      .catch(() => undefined);

    void scope.api('routes-get').then((res) => {
      if (res.cancelled) return;
      if (!res.ok) {
        toastApiError(t('op_failed'), res);
        return;
      }
      setScope((res.scope as Scope) || 'all');
      setUids((res.uids as number[]) || []);
      setSubnets((res.subnets as string[]) || []);
    });

    void loadApps();
  });

  async function loadApps() {
    setAppsError(null);
    const res = await scope.api('apps');
    if (res.cancelled) return;
    if (res.ok) {
      setApps((res.apps as AppInfo[]) || []);
    } else {
      setApps([]);
      setAppsError(res.error || t('error'));
    }
  }

  /* debounce: re-rendering up to 300 rows per keystroke janks the WebView */
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => {
    if (searchTimer) clearTimeout(searchTimer);
  });
  function onSearch(v: string) {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setFilter(v), 300);
  }

  const selStrings = () => uids().map(String);

  const visibleApps = () => {
    const list = apps();
    if (!list) return [];
    const f = filter().toLowerCase();
    const sel = selStrings();
    const rows = list.filter(
      (a) => !f || a.label.toLowerCase().includes(f) || a.package.toLowerCase().includes(f),
    );
    rows.sort((a, b) => {
      const as = sel.includes(String(a.uid)) ? 0 : 1;
      const bs = sel.includes(String(b.uid)) ? 0 : 1;
      return as - bs || a.label.localeCompare(b.label);
    });
    return rows.slice(0, 300);
  };

  function toggleUid(uid: number, on: boolean) {
    const s = String(uid);
    const i = selStrings().indexOf(s);
    if (on && i < 0) setUids([...uids(), uid]);
    if (!on && i >= 0) setUids(uids().filter((u) => String(u) !== s));
  }

  function addSubnet() {
    const v = newSubnet().trim();
    if (!validCidr(v)) {
      showToast(t('route_subnets_invalid'), 'err');
      return;
    }
    setSubnets([...subnets(), v]);
    setNewSubnet('');
  }

  async function apply() {
    if (applyBusy()) return;
    setApplyBusy(true);
    const u = uids().length ? uids().join(',') : '-';
    const s = subnets().length ? subnets().join(',') : '-';
    const res = await scope.api('routes-set', scope_(), u, s);
    setApplyBusy(false);
    if (res.cancelled) return;
    if (res.ok) {
      showToast(t('route_apply_done') + (res.note ? ' (' + String(res.note) + ')' : ''), 'ok');
    } else toastApiError(t('op_failed'), res);
  }

  return (
    <>
      <Card title={t('route_scope')} icon="alt_route">
        <Show when={ownerOk()} fallback={
          <>
            <div class="banner warn">
              <MdIcon name="warning" size={18} />
              <span>{t('route_no_owner')}</span>
            </div>
            <KvRow k={t('route_scope')} v={scope_()} />
          </>
        }>
          <div class="radio-cards">
            {(['all', 'selected', 'bypass'] as Scope[]).map((s) => (
              <div
                class={'radio-card' + (scope_() === s ? ' selected' : '')}
                onClick={() => setScope(s)}
              >
                {t(('route_scope_' + s) as 'route_scope_all')}
              </div>
            ))}
          </div>
          <div class="dim mt">{t(('route_scope_' + scope_() + '_hint') as 'route_scope_all_hint')}</div>
        </Show>
      </Card>

      <Show when={ownerOk()}>
        <Card title={t('route_apps')} icon="group">
          <TextField
            label={t('route_apps_search')}
            value={filter()}
            onInput={(e: InputEvent) => onSearch((e.target as HTMLInputElement).value)}
            leading-icon={<MdIcon name="search" size={20} />}
          />
          <Show when={apps() !== null} fallback={
            <>
              <SkeletonRows rows={5} />
              <div class="dim">{t('route_apps_loading')}</div>
            </>
          }>
            <Show
              when={!appsError()}
              fallback={<ErrorState text={appsError()!} onRetry={() => void loadApps()} />}
            >
              <Show
                when={visibleApps().length > 0}
                fallback={<EmptyState text={t('empty')} icon="search" />}
              >
                {visibleApps().map((a) => (
                  <label class="list-row" style={{ cursor: 'pointer' }}>
                    <Checkbox
                      checked={selStrings().includes(String(a.uid))}
                      onChange={(e: Event) =>
                        toggleUid(a.uid, (e.target as HTMLInputElement).checked)
                      }
                    />
                    <div class="main">
                      <div class="title">{a.label}</div>
                      <div class="sub">{a.package + ' · ' + t('traffic_uid') + a.uid}</div>
                    </div>
                  </label>
                ))}
              </Show>
            </Show>
          </Show>
        </Card>
      </Show>

      <Card title={t('route_subnets')} icon="router">
        {subnets().map((cidr, i) => (
          <div class="list-row">
            <div class="main">
              <div class="title mono">{cidr}</div>
            </div>
            <IconButton
              aria-label={t('delete')}
              onClick={() => setSubnets(subnets().filter((_, j) => j !== i))}
            >
              <MdIcon name="delete" size={20} />
            </IconButton>
          </div>
        ))}
        <div class="list-row">
          <div class="main">
            <TextField
              style={{ width: '100%' }}
              placeholder={t('route_subnets_add_hint')}
              value={newSubnet()}
              onInput={(e: InputEvent) => setNewSubnet((e.target as HTMLInputElement).value)}
            />
          </div>
          <IconButton aria-label={t('add')} onClick={addSubnet}>
            <MdIcon name="add" size={20} />
          </IconButton>
        </div>
      </Card>

      <Button
        style={{ width: '100%' }}
        disabled={applyBusy() || !hasRoot || false}
        onClick={() => void apply()}
      >
        <MdIcon name="check_circle" size={18} /> {t('apply')}
      </Button>
    </>
  );
}
