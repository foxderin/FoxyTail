import { createSignal, For, onCleanup, Show, type JSX, type ParentProps } from 'solid-js';
import { createApiScope, execRaw, quote } from '../api';
import { DATA_DIR } from '../config';
import { t } from '../i18n';
import { getTask } from '../tasks';
import { BACKUP_TASK, backupPath, createBackup } from '../backup';
import { Card, SkeletonRows, ErrorState, StatusBadge } from '../components/Basics';
import { copyText } from '../components/LoginHero';
import { confirmDialog } from '../components/ConfirmDialog';
import { TaskProgress } from '../components/TaskProgress';
import { showToast, toastApiError } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, TextField } from '../components/ui';

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
  const scope = createApiScope();
  const hookAbort = new AbortController();
  onCleanup(() => hookAbort.abort());
  const [advancedLoaded, setAdvancedLoaded] = createSignal(false);
  const [advancedBusy, setAdvancedBusy] = createSignal(false);
  const [ctxRules, setCtxRules] = createSignal('');
  const [ctxError, setCtxError] = createSignal(false);
  const [ctxBusy, setCtxBusy] = createSignal(false);
  const [hooks, setHooks] = createSignal<Record<string, string>>({});
  const backupTask = () => getTask(BACKUP_TASK);
  const backupBusy = () => backupTask()?.status === 'running';
  const backupFailed = () => ['error', 'cancelled'].includes(backupTask()?.status || '');
  const [restorePath, setRestorePath] = createSignal('');
  const [restoreResult, setRestoreResult] = createSignal<{ previous: string; note: string } | null>(
    null,
  );
  async function loadAdvanced() {
    if (advancedBusy()) return;
    setAdvancedBusy(true);
    const res = await scope.api('context-get');
    if (!res.cancelled) {
      setCtxError(!res.ok);
      if (res.ok) setCtxRules((res.rules as string) || '');
    }
    await Promise.all(
      HOOKS.map(async ([file, key]) => {
        try {
          const out = await execRaw(
            'cat ' + quote(DATA_DIR + '/scripts/' + file) + ' 2>/dev/null || echo "(missing)"',
            15000,
            hookAbort.signal,
          );
          if (!hookAbort.signal.aborted)
            setHooks((h) => ({
              ...h,
              [key]: out === '(missing)' ? t('misc_missing') : out || t('misc_empty'),
            }));
        } catch {
          if (!hookAbort.signal.aborted) setHooks((h) => ({ ...h, [key]: t('misc_unavailable') }));
        }
      }),
    );
    setAdvancedBusy(false);
    setAdvancedLoaded(true);
  }
  async function saveContext() {
    if (ctxBusy() || ctxError() || props.locked) return;
    setCtxBusy(true);
    try {
      const res = await scope.api('context-set', btoa(unescape(encodeURIComponent(ctxRules()))));
      if (!res.cancelled) {
        if (res.ok) {
          props.onPending();
          showToast(t('tools_saved_pending'), 'info');
        } else toastApiError(t('op_failed'), res);
      }
    } catch {
      showToast(t('op_failed'), 'err');
    } finally {
      setCtxBusy(false);
    }
  }
  function doBackup() {
    if (props.locked) return;
    void createBackup();
  }
  async function doRestore() {
    const path = restorePath().trim();
    if (props.locked || !path) return;
    if (!path.startsWith('/sdcard/') || !path.endsWith('.tar.gz')) {
      showToast(t('tools_restore_path'), 'err');
      return;
    }
    if (!(await confirmDialog(t('set_restore_confirm')))) return;
    props.setBusy(true);
    const res = await scope.api('restore', path);
    if (!res.cancelled) {
      if (res.ok) {
        setRestoreResult({
          previous: typeof res.previous === 'string' ? res.previous : '',
          note: typeof res.note === 'string' ? res.note : '',
        });
        props.onPending();
        await props.onRestore();
        if (advancedLoaded()) void loadAdvanced();
        showToast(t('tools_saved_pending'), 'info');
      } else toastApiError(t('op_failed'), res);
    }
    props.setBusy(false);
  }
  return (
    <>
      <details
        class="tool-disclosure"
        onToggle={(e) => {
          if (e.currentTarget.open && !advancedLoaded()) void loadAdvanced();
        }}
      >
        <summary>
          <MdIcon name="settings" size={18} /> {t('tools_advanced')}
        </summary>
        <div class="tool-disclosure-body">
          {props.children}
          <Show when={advancedLoaded() && !advancedBusy()} fallback={<SkeletonRows rows={5} />}>
            <Card title={t('set_context')} icon="sync" description={t('set_context_hint')}>
              <Show
                when={!ctxError()}
                fallback={
                  <ErrorState text={t('tools_context_load_error')} onRetry={() => void loadAdvanced()} />
                }
              >
                <textarea
                  class="tool-editor"
                  aria-label={t('set_context')}
                  rows={7}
                  value={ctxRules()}
                  disabled={props.locked || ctxBusy()}
                  onInput={(e) => setCtxRules(e.currentTarget.value)}
                />
                <div class="tool-actions">
                  <Button busy={ctxBusy()} disabled={props.locked} onClick={() => void saveContext()}>
                    <MdIcon name="check_circle" size={18} />
                    {ctxBusy() ? t('loading') : t('save')}
                  </Button>
                </div>
              </Show>
            </Card>
            <Card title={t('set_hooks')} icon="article" description={t('set_hooks_hint')}>
              <For each={HOOKS}>
                {([, key]) => (
                  <div class="tool-result">
                    <p class="tool-hint">{t(key)}</p>
                    <pre class="mono">{hooks()[key] ?? t('loading')}</pre>
                  </div>
                )}
              </For>
            </Card>
          </Show>
        </div>
      </details>
      <Card title={t('set_backup')} icon="backup" description={t('tools_backup_desc')}>
        <TaskProgress taskKey={BACKUP_TASK} cancellable={false} />
        <Show when={backupFailed()}>
          <div data-testid="backup-error">
            <ErrorState text={backupTask()?.status === 'cancelled' ? t('tools_backup_cancelled') : backupTask()?.result?.error || t('tools_backup_failed')} />
          </div>
        </Show>
        <div class="tool-actions" data-testid="backup-controls">
          <Button variant="tonal" busy={backupBusy()} disabled={props.locked} onClick={doBackup}>
            <Show when={!backupBusy()}><MdIcon name={backupFailed() ? 'refresh' : 'backup'} size={18} /></Show>
            {backupBusy() ? t('tools_backup_running') : backupFailed() ? t('retry') : t('set_backup')}
          </Button>
        </div>
        <Show when={backupPath()}>
          <div class="tool-result" data-testid="backup-result" role="status">
            <strong>{t('tools_backup_latest')}</strong>
            <p class="mono" data-testid="backup-path">{backupPath()}</p>
            <p class="tool-hint">{t('tools_backup_file_hint')}</p>
            <Button
              variant="text"
              onClick={() => {
                const copied = copyText(backupPath());
                showToast(t(copied ? 'copied' : 'op_failed'), copied ? 'ok' : 'err');
              }}
            >
              <MdIcon name="content_copy" size={18} />
              {t('tools_copy_path')}
            </Button>
          </div>
        </Show>
      </Card>
      <section class="tool-danger">
        <h2>
          <MdIcon name="refresh" size={18} /> {t('set_restore')}
        </h2>
        <p class="tool-hint">{t('tools_restore_desc')}</p>
        <TextField
          label={t('set_restore')}
          placeholder={t('set_restore_hint')}
          value={restorePath()}
          disabled={props.busy}
          onInput={(e) => setRestorePath((e.target as HTMLInputElement).value)}
        />
        <div>
          <Button
            variant="outlined"
            class="danger"
            busy={props.busy}
            disabled={!restorePath().trim() || props.locked}
            onClick={() => void doRestore()}
          >
            {props.busy ? t('tools_restore_busy') : t('set_restore')}
          </Button>
        </div>
      </section>
      <Show when={restoreResult()}>
        {(result) => (
          <Card title={t('tools_restore_result')} icon="backup" class="tool-restore-result">
            <StatusBadge tone="success">{t('set_restore')}</StatusBadge>
            <Show when={result().previous}>
              <div class="tool-result">
                <strong>{t('tools_restore_previous')}</strong>
                <p class="mono" data-testid="restore-previous">
                  {result().previous}
                </p>
                <Button
                  variant="text"
                  onClick={() =>
                    showToast(t(copyText(result().previous) ? 'copied' : 'op_failed'), 'info')
                  }
                >
                  <MdIcon name="content_copy" size={18} />
                  {t('tools_copy_path')}
                </Button>
              </div>
            </Show>
            <Show when={result().note}>
              <div class="tool-result">
                <strong>{t('tools_restore_note')}</strong>
                <pre class="mono" data-testid="restore-note">
                  {result().note}
                </pre>
                <Button
                  variant="text"
                  onClick={() => showToast(t(copyText(result().note) ? 'copied' : 'op_failed'), 'info')}
                >
                  <MdIcon name="content_copy" size={18} />
                  {t('copy')}
                </Button>
              </div>
            </Show>
          </Card>
        )}
      </Show>
    </>
  );
}
