/* Listener protocol and handler path remain intact across list/delete actions. */
import { batch, createEffect, createSignal, For, on, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot, nativeControl } from '../api';
import { t } from '../i18n';
import { Card, SkeletonRows, EmptyState, ErrorState, StatusBadge } from '../components/Basics';
import { confirmDialog } from '../components/ConfirmDialog';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, IconButton, Select, TextField } from '../components/ui';
import { serveMappings, serveDeleteArgs, type ServeMapping as Mapping } from '../serve';
import './tools.css';
import { createQueuedRefresh } from './tools-refresh';
import { bindNativeDraft } from '../settings';
type Kind = 'serve' | 'funnel';
const protocols: Record<Kind, string[]> = {
  serve: ['https', 'http', 'tcp', 'tls-terminated-tcp'],
  funnel: ['https', 'tcp', 'tls-terminated-tcp'],
};
const funnelPorts = ['443', '8443', '10000'];
export default function Serve(): JSX.Element {
  const scope = createApiScope();
  const [mappings, setMappings] = createSignal<Record<Kind, Mapping[] | null>>({
    serve: null,
    funnel: null,
  });
  const [errors, setErrors] = createSignal<Record<Kind, string | null>>({ serve: null, funnel: null });
  const [loading, setLoading] = createSignal<Record<Kind, boolean>>({ serve: false, funnel: false });
  const [kind, setKind] = createSignal<Kind>('serve');
  const [proto, setProto] = createSignal('https');
  const [port, setPort] = createSignal('');
  const [target, setTarget] = createSignal('');
  const [addBusy, setAddBusy] = createSignal(false);
  const [delBusy, setDelBusy] = createSignal<string | null>(null);
  const [formError, setFormError] = createSignal('');
  const mutationBusy = () => addBusy() || delBusy() !== null || !nativeControl().canWrite || nativeControl().busy;
  const draftReady = bindNativeDraft('serve', () => ({ kind: kind(), proto: proto(), port: port(), target: target() }), value => {
    if ((value.kind === 'serve' || value.kind === 'funnel') && typeof value.proto === 'string' &&
        protocols[value.kind].includes(value.proto) && typeof value.port === 'string' && typeof value.target === 'string') {
      setKind(value.kind); setProto(value.proto); setPort(value.port); setTarget(value.target);
    }
  });
  const mappingKey = (k: Kind, m: Mapping) => k + '/' + m.proto + '/' + m.port + (m.path ?? '');
  function changeKind(next: Kind) {
    batch(() => {
      if (next === 'funnel') {
        if (!protocols.funnel.includes(proto())) setProto('https');
        setPort(funnelPorts.includes(port().trim()) ? port().trim() : '443');
      }
      setKind(next);
      setFormError('');
    });
  }
  const refreshKinds = Object.fromEntries(
    (['serve', 'funnel'] as Kind[]).map((k) => [
      k,
      createQueuedRefresh(
        () => scope.api(k + '-list'),
        (res) => {
          if (!res.ok || !res.status || typeof res.status !== 'object' || Array.isArray(res.status)) {
            setErrors((old) => ({ ...old, [k]: res.error || t('serve_unavailable') }));
            setMappings((old) => ({ ...old, [k]: [] }));
            return;
          }
          setErrors((old) => ({ ...old, [k]: null }));
          setMappings((old) => ({
            ...old,
            [k]: serveMappings(res.status).filter((mapping) => mapping.funnel === (k === 'funnel')),
          }));
        },
        (busy) => setLoading((old) => ({ ...old, [k]: busy })),
      ),
    ]),
  ) as Record<Kind, () => Promise<void>>;
  function loadKind(k: Kind): Promise<void> {
    return refreshKinds[k]();
  }
  async function del(k: Kind, mapping: Mapping) {
    if (mutationBusy() || !(await confirmDialog(t('serve_del_confirm')))) return;
    if (mutationBusy()) return;
    setDelBusy(mappingKey(k, mapping));
    const res = await scope.api(k + '-del', ...serveDeleteArgs(mapping));
    setDelBusy(null);
    if (res.cancelled) return;
    if (res.ok) {
      void loadKind('serve');
      void loadKind('funnel');
    } else toastApiError(t('op_failed'), res);
  }
  async function add() {
    if (mutationBusy() || !target().trim()) return;
    if (!/^\d+$/.test(port().trim()) || Number(port()) < 1 || Number(port()) > 65535) {
      setFormError(t('tools_port_invalid'));
      return;
    }
    if (!protocols[kind()].includes(proto())) {
      setFormError(t('tools_serve_protocol_invalid'));
      return;
    }
    if (kind() === 'funnel' && !funnelPorts.includes(port().trim())) {
      setFormError(t('tools_funnel_port_invalid'));
      return;
    }
    const submitted = { kind: kind(), proto: proto(), port: port().trim(), target: target().trim() };
    if (submitted.kind === 'funnel' && !await confirmDialog(`${t('tools_serve_public_hint')}\n${submitted.proto}:${submitted.port} → ${submitted.target}`)) return;
    if (mutationBusy()) return;
    setFormError('');
    setAddBusy(true);
    const res = await scope.api(submitted.kind + '-set', submitted.proto, submitted.port, submitted.target);
    setAddBusy(false);
    if (res.cancelled) return;
    if (res.ok) {
      if (target().trim() === submitted.target && kind() === submitted.kind && proto() === submitted.proto && port().trim() === submitted.port) setTarget('');
      showToast(t('tools_serve_add_done'), 'ok');
      void loadKind('serve');
      void loadKind('funnel');
    } else {
      setFormError(res.error || t('error'));
    }
  }
  createEffect(on(() => nativeControl().accountRevision, () => {
    setMappings({ serve: null, funnel: null });
    void draftReady.then(() => { void loadKind('serve'); void loadKind('funnel'); });
  }));
  function section(k: Kind): JSX.Element {
    return (
      <Card
        title={t(k === 'serve' ? 'serve_serve' : 'serve_funnel')}
        icon={k === 'serve' ? 'vpn_key' : 'language'}
        description={t(k === 'serve' ? 'tools_serve_private' : 'tools_serve_public')}
        actions={
          <Button variant="text" busy={loading()[k]} onClick={() => void loadKind(k)}>
            <MdIcon name="refresh" size={18} />
            {t('tools_refresh')}
          </Button>
        }
      >
        <Show when={mappings()[k] !== null} fallback={<SkeletonRows rows={3} />}>
          <Show
            when={!errors()[k]}
            fallback={<ErrorState text={errors()[k]!} onRetry={() => void loadKind(k)} />}
          >
            <StatusBadge tone={k === 'funnel' && mappings()[k]!.length ? 'warning' : 'neutral'}>
              {mappings()[k]!.length} {t('tools_mapping_count')}
            </StatusBadge>
            <Show
              when={mappings()[k]!.length}
              fallback={<EmptyState text={t('serve_empty')} icon="dns" />}
            >
              <For each={mappings()[k]!}>
                {(mapping) => (
                  <div class="list-row tool-row-wrap">
                    <div class="main">
                      <div class="title mono">
                        {mapping.proto} {mapping.host}:{mapping.port}
                        {mapping.path ?? ''}
                      </div>
                      <Show when={mapping.target}>
                        <div class="sub mono">→ {mapping.target}</div>
                      </Show>
                    </div>
                    <IconButton
                      aria-label={
                        t('delete') + ' ' + mapping.proto + ':' + mapping.port + (mapping.path ?? '')
                      }
                      disabled={!hasRoot || mutationBusy() || !mapping.canDelete}
                      onClick={() => void del(k, mapping)}
                    >
                      <MdIcon
                        name={delBusy() === mappingKey(k, mapping) ? 'sync' : 'delete'}
                        size={20}
                      />
                    </IconButton>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </Card>
    );
  }
  return (
    <div class="tools-page">
      <div class="tools-grid two">
        {section('serve')}
        {section('funnel')}
      </div>
      <Card title={t('serve_add')} icon="add">
        <div class="tool-form" data-testid="serve-add-form">
          <Select
            id="serve-kind"
            label={t('serve_kind')}
            value={kind()}
            disabled={mutationBusy()}
            onChange={(e) => changeKind((e.target as HTMLSelectElement).value as Kind)}
          >
            <option value="serve">Serve · {t('tools_serve_private')}</option>
            <option value="funnel">Funnel · {t('tools_serve_public')}</option>
          </Select>
          <Show when={kind() === 'funnel'}>
            <div class="alert warn">
              <MdIcon name="language" size={18} />
              {t('tools_serve_public_hint')}
            </div>
          </Show>
          <div class="tool-form-row">
            <Select
              id="serve-protocol"
              label={t('tools_serve_listener_protocol')}
              value={proto()}
              disabled={mutationBusy()}
              onChange={(e) => {
                setProto((e.target as HTMLSelectElement).value);
                setFormError('');
              }}
            >
              <For each={protocols[kind()]}>
                {(protocol) => (
                  <option value={protocol}>
                    {protocol === 'tls-terminated-tcp' ? 'TLS → TCP' : protocol.toUpperCase()}
                  </option>
                )}
              </For>
            </Select>
            <Show
              when={kind() === 'funnel'}
              fallback={
                <TextField
                  id="serve-port"
                  label={t('tools_serve_listener_port')}
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  placeholder="443"
                  value={port()}
                  disabled={mutationBusy()}
                  onInput={(e) => {
                    setPort((e.target as HTMLInputElement).value);
                    setFormError('');
                  }}
                />
              }
            >
              <Select
                id="serve-port"
                label={t('tools_serve_listener_port')}
                value={port()}
                disabled={mutationBusy()}
                onChange={(e) => {
                  setPort((e.target as HTMLSelectElement).value);
                  setFormError('');
                }}
              >
                <For each={funnelPorts}>{(value) => <option value={value}>{value}</option>}</For>
              </Select>
            </Show>
          </div>
          <TextField
            id="serve-target"
            label={t('tools_serve_local_target')}
            placeholder={proto().includes('tcp') ? 'localhost:3000' : 'http://localhost:3000'}
            value={target()}
            disabled={mutationBusy()}
            onInput={(e) => {
              setTarget((e.target as HTMLInputElement).value);
              setFormError('');
            }}
          />
          <Show when={formError()}>
            <ErrorState text={formError()} />
          </Show>
          <div>
            <Button
              busy={addBusy()}
              disabled={!port().trim() || !target().trim() || mutationBusy() || !hasRoot}
              onClick={() => void add()}
            >
              <MdIcon name="add" size={18} />
              {t('serve_add')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
