/*
 * Serve / Funnel — list both mappings (light reads), add / delete with
 * confirm. Status JSON flattened best-effort (TCP + Web handlers).
 */
import { createSignal, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot } from '../api';
import { t } from '../i18n';
import { Card, SkeletonRows, EmptyState } from '../components/Basics';
import { confirmDialog } from '../components/ConfirmDialog';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';

interface Mapping {
  proto: string;
  port: string;
  target: string;
}

type Kind = 'serve' | 'funnel';

/* Flatten `serve status --json` into [{proto,port,target}] best effort. */
function flatten(status: unknown): Mapping[] {
  const out: Mapping[] = [];
  if (!status || typeof status !== 'object') return out;
  const st = status as Record<string, unknown>;
  if (st.TCP && typeof st.TCP === 'object') {
    Object.keys(st.TCP as object).forEach((port) => {
      out.push({ proto: 'tcp', port, target: '' });
    });
  }
  if (st.Web && typeof st.Web === 'object') {
    Object.entries(st.Web as Record<string, unknown>).forEach(([hp, web]) => {
      const port = (hp.match(/:(\d+)$/) || [])[1] || '443';
      const handlers = (web as { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> })
        ?.Handlers;
      let target = '';
      if (handlers) {
        Object.entries(handlers).forEach(([path, hd]) => {
          const tg = hd.Proxy || hd.Path || hd.Text || '';
          if (tg) target = path + ' → ' + tg;
        });
      }
      out.push({ proto: hp.includes(':443') ? 'https' : 'http', port, target });
    });
  }
  return out;
}

export default function Serve(): JSX.Element {
  const scope = createApiScope();
  const [mappings, setMappings] = createSignal<Record<Kind, Mapping[] | null>>({
    serve: null,
    funnel: null,
  });
  const [unavailable, setUnavailable] = createSignal<Record<Kind, boolean>>({
    serve: false,
    funnel: false,
  });
  const [kind, setKind] = createSignal<Kind>('serve');
  const [proto, setProto] = createSignal('https');
  const [port, setPort] = createSignal('');
  const [target, setTarget] = createSignal('');
  const [addBusy, setAddBusy] = createSignal(false);

  async function loadKind(k: Kind) {
    const res = await scope.api(k + '-list');
    if (res.cancelled) return;
    if (!res.ok) {
      setUnavailable((u) => ({ ...u, [k]: true }));
      setMappings((m) => ({ ...m, [k]: [] }));
      return;
    }
    setUnavailable((u) => ({ ...u, [k]: false }));
    setMappings((m) => ({ ...m, [k]: flatten(res.status) }));
  }

  async function del(k: Kind, m: Mapping) {
    if (!(await confirmDialog(t('serve_del_confirm')))) return;
    const res = await scope.api(k + '-del', m.proto, m.port);
    if (res.cancelled) return;
    if (res.ok) void loadKind(k);
    else toastApiError(t('op_failed'), res);
  }

  async function add() {
    if (!port().trim() || !target().trim() || addBusy()) return;
    setAddBusy(true);
    const res = await scope.api(kind() + '-set', proto(), port().trim(), target().trim());
    setAddBusy(false);
    if (res.cancelled) return;
    if (res.ok) {
      setTarget('');
      void loadKind('serve');
      void loadKind('funnel');
    } else toastApiError(t('op_failed'), res);
  }

  onMount(() => {
    void loadKind('serve');
    void loadKind('funnel');
  });

  const section = (k: Kind, titleKey: 'serve_serve' | 'serve_funnel'): JSX.Element => (
    <Card title={t(titleKey)} icon="dns">
      <Show when={mappings()[k] !== null} fallback={<SkeletonRows rows={2} />}>
        <Show
          when={!unavailable()[k]}
          fallback={<EmptyState text={t('serve_unavailable')} icon="warning" />}
        >
          <Show
            when={mappings()[k]!.length > 0}
            fallback={<EmptyState text={t('serve_empty')} icon="dns" />}
          >
            {mappings()[k]!.map((m) => (
              <div class="list-row">
                <div class="main">
                  <div class="title mono">{m.proto + ' :' + m.port}</div>
                  <Show when={m.target}>
                    <div class="sub mono">{m.target}</div>
                  </Show>
                </div>
                <md-icon-button
                  aria-label={t('delete')}
                  disabled={!hasRoot || undefined}
                  onClick={() => void del(k, m)}
                >
                  <MdIcon name="delete" size={20} />
                </md-icon-button>
              </div>
            ))}
          </Show>
        </Show>
      </Show>
    </Card>
  );

  return (
    <>
      {section('serve', 'serve_serve')}
      {section('funnel', 'serve_funnel')}

      <Card title={t('serve_add')} icon="add">
        <label class="field">
          <md-outlined-select
            label={t('serve_kind')}
            value={kind()}
            on:change={(e: Event) =>
              setKind((e.target as unknown as { value: Kind }).value || 'serve')
            }
          >
            <md-select-option value="serve" selected>
              <div slot="headline">serve</div>
            </md-select-option>
            <md-select-option value="funnel">
              <div slot="headline">funnel</div>
            </md-select-option>
          </md-outlined-select>
        </label>
        <label class="field">
          <md-outlined-select
            label={t('serve_proto')}
            value={proto()}
            on:change={(e: Event) =>
              setProto((e.target as unknown as { value: string }).value || 'https')
            }
          >
            {['https', 'http', 'tcp', 'tls-terminated-tcp'].map((p) => (
              <md-select-option value={p} selected={p === 'https' || undefined}>
                <div slot="headline">{p}</div>
              </md-select-option>
            ))}
          </md-outlined-select>
        </label>
        <label class="field">
          <md-outlined-text-field
            label={t('serve_port')}
            type="number"
            placeholder="443"
            value={port()}
            onInput={(e: InputEvent) => setPort((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <md-outlined-text-field
            label={t('serve_target')}
            placeholder="http://localhost:3000"
            value={target()}
            onInput={(e: InputEvent) => setTarget((e.target as HTMLInputElement).value)}
          />
        </label>
        <md-filled-button
          disabled={!port().trim() || !target().trim() || addBusy() || !hasRoot || undefined}
          onClick={() => void add()}
        >
          <MdIcon name="add" size={18} /> {t('serve_add')}
        </md-filled-button>
      </Card>
    </>
  );
}
