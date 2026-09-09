/*
 * Serve / Funnel — list both mappings (light reads), add / delete with
 * confirm. ServeConfig is adapted without losing listener protocol or handler paths.
 */
import { createSignal, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot } from '../api';
import { t } from '../i18n';
import { Card, SkeletonRows, EmptyState } from '../components/Basics';
import { confirmDialog } from '../components/ConfirmDialog';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, IconButton, Select, TextField } from '../components/ui';

import { serveMappings, serveDeleteArgs, type ServeMapping as Mapping } from '../serve';

type Kind = 'serve' | 'funnel';

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
  const [delBusy, setDelBusy] = createSignal<string | null>(null);

  async function loadKind(k: Kind) {
    const res = await scope.api(k + '-list');
    if (res.cancelled) return;
    if (!res.ok) {
      setUnavailable((u) => ({ ...u, [k]: true }));
      setMappings((m) => ({ ...m, [k]: [] }));
      return;
    }
    setUnavailable((u) => ({ ...u, [k]: false }));
    setMappings((m) => ({ ...m, [k]: serveMappings(res.status).filter((mapping) => mapping.funnel === (k === 'funnel')) }));
  }

  async function del(k: Kind, m: Mapping) {
    if (delBusy() !== null) return;
    if (!(await confirmDialog(t('serve_del_confirm')))) return;
    setDelBusy(k + '/' + m.proto + '/' + m.port + (m.path ?? ''));
    const res = await scope.api(k + '-del', ...serveDeleteArgs(m));
    setDelBusy(null);
    if (res.cancelled) return;
    if (res.ok) { void loadKind('serve'); void loadKind('funnel'); }
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
                  <div class="title mono">{m.proto + ' ' + m.host + ':' + m.port + (m.path ?? '')}</div>
                  <Show when={m.target}>
                    <div class="sub mono">{m.target}</div>
                  </Show>
                </div>
                <IconButton
                  aria-label={t('delete')}
                  disabled={!hasRoot || delBusy() !== null || !m.canDelete}
                  onClick={() => void del(k, m)}
                >
                  <MdIcon name="delete" size={20} />
                </IconButton>
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
        <Select
          label={t('serve_kind')}
          value={kind()}
          onChange={(e: Event) => setKind((e.target as HTMLSelectElement).value as Kind || 'serve')}
        >
          <option value="serve" selected={kind() === 'serve'}>serve</option>
          <option value="funnel" selected={kind() === 'funnel'}>funnel</option>
        </Select>
        <Select
          label={t('serve_proto')}
          value={proto()}
          onChange={(e: Event) => setProto((e.target as HTMLSelectElement).value || 'https')}
        >
          {['https', 'http', 'tcp', 'tls-terminated-tcp'].map((p) => (
            <option value={p} selected={p === proto()}>{p}</option>
          ))}
        </Select>
        <TextField
          label={t('serve_port')}
          type="number"
          placeholder="443"
          value={port()}
          onInput={(e: InputEvent) => setPort((e.target as HTMLInputElement).value)}
        />
        <TextField
          label={t('serve_target')}
          placeholder="http://localhost:3000"
          value={target()}
          onInput={(e: InputEvent) => setTarget((e.target as HTMLInputElement).value)}
        />
        <Button
          disabled={!port().trim() || !target().trim() || addBusy() || !hasRoot}
          onClick={() => void add()}
        >
          <MdIcon name="add" size={18} /> {t('serve_add')}
        </Button>
      </Card>
    </>
  );
}
