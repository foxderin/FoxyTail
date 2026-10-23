import { createEffect, createMemo, createSignal, For, on, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot, nativeControl } from '../api';
import { t, type I18nKey } from '../i18n';
import { Card, SkeletonRows, StatusBadge } from '../components/Basics';
import { LoadGate } from '../components/LoadGate';
import { Button, Select, TextField } from '../components/ui';
import { showToast } from '../components/Toast';
import { confirmDialog } from '../components/ConfirmDialog';
import { bindNativeDraft } from '../settings';
import { savedConfigRevision } from '../config';
import { createGuardedLoad, createQueuedRefresh } from './tools-refresh';
import { pollWhileVisible } from '../schedule';

type Rule = { trigger: 'ssid' | 'cellular'; value: string; action: string; arg: string };
const ACTIONS: Record<string, I18nKey> = {
  up: 'context_up', down: 'context_down', 'exit-node': 'context_exit', 'no-exit-node': 'context_no_exit',
};

// Match the backend grammar. Raw lines remain the source of truth, including
// comments, CRLF, unsupported syntax and the presence of a final newline.
function parseRule(line: string): Rule | null {
  const text = line.replace(/\r$/, '').replace(/^[ \t]+|[ \t]+$/g, '');
  if (/[\x00-\x1f\x7f#]/.test(text)) return null;
  const match = /^(ssid|cellular):([^:]*):(up|down|exit-node|no-exit-node)(?::(.*))?$/.exec(text);
  if (!match) return null;
  const [, trigger, value, action, arg] = match;
  if (trigger === 'cellular' ? value !== '-' : /^ *$/.test(value) || value.includes('"') || ['unknown', '<unknown ssid>', '<none>'].includes(value)) return null;
  if (action === 'exit-node' ? !arg || !/^[A-Za-z0-9:][A-Za-z0-9_.:%-]*$/.test(arg) : arg !== undefined) return null;
  return { trigger: trigger as Rule['trigger'], value, action, arg: arg ?? '' };
}

type ContextStatus = {
  running: boolean;
  context: string;
  lastResult: { context: string; ok: boolean; at: number; error?: string } | null;
};

export default function ContextRules(props: { locked: boolean; onPending: () => void }): JSX.Element {
  const scope = createApiScope();
  const [rules, setRules] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal<string | null>(null);
  const [baseline, setBaseline] = createSignal<string | null>(null);
  const conflict = () => baseline() !== null && baseline() !== saved() && (rules() !== saved() || draft() !== null);
  const [status, setStatus] = createSignal<ContextStatus | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [rulesLoading, setRulesLoading] = createSignal(false);
  const [statusLoading, setStatusLoading] = createSignal(false);
  const [statusError, setStatusError] = createSignal('');
  const [error, setError] = createSignal('');
  const [textMode, setTextMode] = createSignal(false);
  const [draft, setDraft] = createSignal<Rule | null>(null);
  const [editing, setEditing] = createSignal<number | null>(null);
  const [draftError, setDraftError] = createSignal('');
  const draftReady = bindNativeDraft('context', () => ({ rules: rules(), baseline: baseline(), draft: draft(), editing: editing(), textMode: textMode() }), value => {
    if (typeof value.rules === 'string') setRules(value.rules);
    if (typeof value.baseline === 'string') setBaseline(value.baseline);
    if (value.draft && typeof value.draft === 'object') {
      const row = value.draft as Partial<Rule>;
      if (['ssid', 'cellular'].includes(row.trigger ?? '') && typeof row.value === 'string' && typeof row.action === 'string' && typeof row.arg === 'string') setDraft(row as Rule);
    }
    if (value.editing === null || typeof value.editing === 'number' && Number.isSafeInteger(value.editing)) setEditing(value.editing as number | null);
    if (typeof value.textMode === 'boolean') setTextMode(value.textMode);
  });
  const locked = () => props.locked || busy() || rulesLoading() || saved() === null || !hasRoot;
  const rows = createMemo(() => (rules() ?? '').split('\n')
    .map((line, index) => ({ line, index, rule: parseRule(line) }))
    .filter(row => !/^[ \t]*\r?$/.test(row.line) && !/^[ \t]*#/.test(row.line)));
  const lastResult = () => {
    const result = status()?.lastResult;
    return result && typeof result.ok === 'boolean' && typeof result.context === 'string' &&
      typeof result.at === 'number' && Number.isFinite(result.at) && result.at > 0 ? result : null;
  };

  let discardRequested = false;
  const loadRules = createQueuedRefresh(
    () => scope.api('context-get'),
    result => {
      if (result.ok && typeof result.rules === 'string') {
        if (discardRequested || !draft() && (rules() === null || rules() === baseline() || rules() === saved())) {
          setRules(result.rules); setBaseline(result.rules);
          if (discardRequested) { setDraft(null); setEditing(null); }
        }
        setSaved(result.rules);
        setError('');
      } else setError(result.error || t('tools_context_load_error'));
      discardRequested = false;
    },
    setRulesLoading,
  );
  const loadStatus = createGuardedLoad(
    () => scope.api('context-status'),
    result => {
      const value = result.ok ? result.status as ContextStatus | null : null;
      const valid = value && typeof value.running === 'boolean' && typeof value.context === 'string';
      setStatus(valid ? value : null);
      setStatusError(valid ? '' : result.error || t('context_unconfirmed'));
    },
    setStatusLoading,
  );
  function load(preserveDraft = true): Promise<void> {
    if (busy()) return Promise.resolve();
    if (!preserveDraft) discardRequested = true;
    void loadStatus();
    return loadRules();
  }
  onMount(() => { void draftReady.then(loadRules); });
  createEffect(on(savedConfigRevision, () => { void draftReady.then(() => load(true)); }, { defer: true }));
  createEffect(on(() => nativeControl().revision + ':' + nativeControl().accountRevision, () => { void loadStatus(); }, { defer: true }));
  pollWhileVisible(loadStatus, () => 10000);

  async function save() {
    if (locked() || rules() === null || draft()) return;
    const submitted = rules()!;
    if (new TextEncoder().encode(submitted).length > 48 * 1024) { setError(t('tools_context_limit')); return; }
    if (!await confirmDialog((conflict() ? t('tools_draft_conflict') + '\n\n' : '') + t('tools_network_warning'))) return;
    if (locked() || rules() !== submitted) return;
    setBusy(true);
    setError('');
    try {
      const result = await scope.api('context-set', btoa(unescape(encodeURIComponent(submitted))));
      if (!result.cancelled) {
        if (result.ok) {
          setSaved(submitted); setBaseline(submitted);
          props.onPending();
          showToast(t('tools_saved_pending'), 'info');
        } else setError(result.error || t('op_failed'));
      }
    } catch {
      setError(t('op_failed'));
    } finally {
      setBusy(false);
    }
  }

  function edit(index: number | null, rule?: Rule) {
    if (locked() || draft()) return;
    setEditing(index);
    setDraft(rule ? { ...rule } : { trigger: 'ssid', value: '', action: 'up', arg: '' });
    setDraftError('');
  }
  function updateDraft(change: Partial<Rule>) {
    setDraft(old => old ? { ...old, ...change } : null);
    setDraftError('');
  }
  function applyDraft(event: SubmitEvent) {
    event.preventDefault();
    if (locked() || !draft()) return;
    const rule = draft()!;
    const line = `${rule.trigger}:${rule.trigger === 'cellular' ? '-' : rule.value}:${rule.action}` + (rule.action === 'exit-node' ? ':' + rule.arg : '');
    if (!parseRule(line)) { setDraftError(t('context_invalid')); return; }
    const index = editing();
    if (index === null) {
      const current = rules() ?? '';
      const newline = current.includes('\r\n') ? '\r\n' : '\n';
      setRules(current + (current && !current.endsWith('\n') ? newline : '') + line + newline);
    } else {
      const lines = rules()!.split('\n');
      if (!Number.isSafeInteger(index) || index < 0 || index >= lines.length) { setDraftError(t('tools_draft_conflict')); return; }
      lines[index] = line + (lines[index].endsWith('\r') ? '\r' : '');
      setRules(lines.join('\n'));
    }
    setDraft(null);
  }
  function remove(index: number) {
    if (locked() || draft()) return;
    const lines = rules()!.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    lines.splice(index, 1);
    setRules(lines.join(''));
  }
  function move(position: number, offset: number) {
    if (locked() || draft()) return;
    const from = rows()[position]?.index, to = rows()[position + offset]?.index;
    if (from === undefined || to === undefined) return;
    const lines = rules()!.split('\n');
    const fromText = lines[from].replace(/\r$/, ''), toText = lines[to].replace(/\r$/, '');
    lines[from] = toText + (lines[from].endsWith('\r') ? '\r' : '');
    lines[to] = fromText + (lines[to].endsWith('\r') ? '\r' : '');
    setRules(lines.join('\n'));
  }

  return (
    <Card title={t('set_context')} icon="sync" description={t('context_description')}>
      <div data-testid="context-rules">
        <div class="tool-actions spread">
          <Button variant="text" disabled={busy() || rulesLoading() || !hasRoot} onClick={() => void load(true)}>{t('context_refresh')}</Button>
          <Button variant="text" disabled={Boolean(draft())} onClick={() => setTextMode(!textMode())}>{t(textMode() ? 'context_visual' : 'context_text')}</Button>
          <Show when={rules() !== saved() || draft()}>
            <Button variant="text" disabled={busy() || rulesLoading()} onClick={async () => {
              if (await confirmDialog(t('tools_draft_changed'))) await load(false);
            }}>{t('tools_retry')}</Button>
          </Show>
        </div>
        <Show when={rules() !== saved() || draft()}><p role="status">{t(conflict() ? 'tools_draft_conflict' : 'tools_draft_changed')}</p></Show>
        <div data-testid="context-status" role="status" aria-busy={statusLoading()}>
          <p>{t('context_current')}: {status()?.context || t('net_unknown')} · {status() ? t(status()!.running ? 'context_running' : 'context_stopped') : t('net_unknown')}</p>
          <Show when={statusError()}><p role="alert">{statusError()}</p></Show>
          <Show when={lastResult()} fallback={<p>{t('context_unconfirmed')}</p>}>
            {result => <p>
              {t('context_last')}: <StatusBadge tone={result().ok ? 'success' : 'warning'}>{t(result().ok ? 'context_success' : 'context_failed')}</StatusBadge>
              {' '}{result().context}
              {' '}{new Date(result().at * 1000).toLocaleString()}
              <Show when={result().error && result().error !== 'context-action-failed'}><span> · {result().error}</span></Show>
            </p>}
          </Show>
        </div>
        <LoadGate
          ready={rules() !== null}
          error={error()}
          skeleton={<SkeletonRows rows={3} />}
        >
          <Show when={textMode()} fallback={
            <>
              <Show when={!rows().length}><p class="tool-hint">{t('context_empty')}</p></Show>
              <For each={rows()}>{(row, position) => <div class="list-row" data-context-line={row.index}>
                <div class="main">
                  <Show when={row.rule} fallback={<><span role="alert">{t('context_unsupported')}</span><pre class="mono">{row.line}</pre></>}>
                    {rule => <span>{t(rule().trigger === 'ssid' ? 'context_wifi' : 'context_cellular')}{rule().trigger === 'ssid' ? ': ' + rule().value : ''} → {t(ACTIONS[rule().action])}{rule().arg ? ': ' + rule().arg : ''}</span>}
                  </Show>
                </div>
                <div class="tool-actions">
                  <Button variant="text" disabled={locked() || Boolean(draft()) || position() === 0} aria-label={t('context_move_up')} onClick={() => move(position(), -1)}>↑</Button>
                  <Button variant="text" disabled={locked() || Boolean(draft()) || position() === rows().length - 1} aria-label={t('context_move_down')} onClick={() => move(position(), 1)}>↓</Button>
                  <Button variant="text" disabled={locked() || Boolean(draft())} onClick={() => row.rule ? edit(row.index, row.rule) : setTextMode(true)}>{t('context_edit')}</Button>
                  <Button variant="text" disabled={locked() || Boolean(draft())} onClick={() => remove(row.index)}>{t('delete')}</Button>
                </div>
              </div>}</For>
              <Button variant="tonal" disabled={locked() || Boolean(draft())} onClick={() => edit(null)}>{t('context_add')}</Button>
            </>
          }>
            <p class="tool-hint">{t('set_context_hint')}</p>
            <textarea class="tool-editor" rows={8} aria-label={t('set_context')} value={rules()!} disabled={locked()} onInput={event => setRules(event.currentTarget.value)} />
          </Show>
          <Show when={draft()}>{rule => <form class="tool-form" data-testid="context-editor" onSubmit={applyDraft}>
            <Select label={t('context_network')} value={rule().trigger} disabled={locked()} onChange={event => updateDraft({ trigger: (event.target as HTMLSelectElement).value as Rule['trigger'] })}>
              <option value="ssid">{t('context_wifi')}</option><option value="cellular">{t('context_cellular')}</option>
            </Select>
            <Show when={rule().trigger === 'ssid'}><TextField label="SSID" value={rule().value} disabled={locked()} onInput={event => updateDraft({ value: (event.target as HTMLInputElement).value })} /></Show>
            <Select label={t('context_action')} value={rule().action} disabled={locked()} onChange={event => updateDraft({ action: (event.target as HTMLSelectElement).value })}>
              <For each={Object.entries(ACTIONS)}>{([action, label]) => <option value={action}>{t(label)}</option>}</For>
            </Select>
            <Show when={rule().action === 'exit-node'}><TextField label={t('context_target')} value={rule().arg} disabled={locked()} onInput={event => updateDraft({ arg: (event.target as HTMLInputElement).value })} /></Show>
            <Show when={draftError()}><p role="alert">{draftError()}</p></Show>
            <div class="tool-actions"><Button type="submit" disabled={locked()}>{t('context_apply_rule')}</Button><Button variant="text" disabled={locked()} onClick={() => setDraft(null)}>{t('cancel')}</Button></div>
          </form>}</Show>
          <div class="tool-actions"><Button busy={busy()} disabled={locked() || Boolean(draft())} onClick={() => void save()}>{t('save')}</Button></div>
        </LoadGate>
      </div>
    </Card>
  );
}
