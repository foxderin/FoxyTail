/* Listener protocol and handler path remain intact across list/delete actions. */
import { createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot } from '../api';
import { t } from '../i18n';
import { Card, SkeletonRows, EmptyState, ErrorState, StatusBadge } from '../components/Basics';
import { confirmDialog } from '../components/ConfirmDialog';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, IconButton, Select, TextField } from '../components/ui';
import { serveMappings, serveDeleteArgs, type ServeMapping as Mapping } from '../serve';
import './tools.css';
import { createQueuedRefresh } from './tools-refresh';
type Kind = 'serve' | 'funnel';
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
  const mutationBusy = () => addBusy() || delBusy() !== null;
  const mappingKey = (k: Kind, m: Mapping) => k + '/' + m.proto + '/' + m.port + (m.path ?? '');
  const refreshKinds = Object.fromEntries(
    (['serve', 'funnel'] as Kind[]).map((k) => [
      k,
      createQueuedRefresh(
        () => scope.api(k + '-list'),
        (res) => {
          if (!res.ok) {
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
    setFormError('');
    setAddBusy(true);
    const res = await scope.api(kind() + '-set', proto(), port().trim(), target().trim());
    setAddBusy(false);
    if (res.cancelled) return;
    if (res.ok) {
      setTarget('');
      showToast(t('tools_serve_add_done'), 'ok');
      void loadKind('serve');
      void loadKind('funnel');
    } else {
      setFormError(res.error || t('error'));
    }
  }
  onMount(() => {
    void loadKind('serve');
    void loadKind('funnel');
  });
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
        <div class="tool-form">
          <Select
            label={t('serve_kind')}
            value={kind()}
            disabled={mutationBusy()}
            onChange={(e) => setKind((e.target as HTMLSelectElement).value as Kind)}
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
              label={t('serve_proto')}
              value={proto()}
              disabled={mutationBusy()}
              onChange={(e) => setProto((e.target as HTMLSelectElement).value)}
            >
              <For each={['https', 'http', 'tcp', 'tls-terminated-tcp']}>
                {(protocol) => <option value={protocol}>{protocol}</option>}
              </For>
            </Select>
            <TextField
              label={t('serve_port')}
              type="number"
              placeholder="443"
              value={port()}
              disabled={mutationBusy()}
              onInput={(e) => {
                setPort((e.target as HTMLInputElement).value);
                setFormError('');
              }}
            />
          </div>
          <TextField
            label={t('serve_target')}
            placeholder={proto().includes('tcp') ? 'localhost:3000' : 'http://localhost:3000'}
            value={target()}
            disabled={mutationBusy()}
            onInput={(e) => setTarget((e.target as HTMLInputElement).value)}
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
