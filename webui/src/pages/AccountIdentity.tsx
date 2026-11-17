/* Identity bytes stay in native private artifacts; only a bounded manifest
 * crosses the bridge. Import/restore never starts the service automatically. */
import { createEffect, createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { createApiScope, hasRoot, nativeControl } from '../api';
import { requestNative, onNativeEvent, type NativeResult } from '../native';
import { getTask, startValidatedTask } from '../tasks';
import { status, statusError, invalidateAccountState, refreshStatus } from '../state';
import { Card, ErrorState } from '../components/Basics';
import { Button } from '../components/ui';
import { TaskProgress } from '../components/TaskProgress';
import { confirmDialog } from '../components/ConfirmDialog';
import { toastApiError } from '../components/Toast';
import { t } from '../i18n';
import { artifactExport } from '../backup';

interface IdentityPreview { artifactId: string; sha256: string; baselineSha256: string; baselineExists: boolean; size: number; profileCount: number; currentProfileId: string; format: string }
const token = (value: unknown): value is string => typeof value === 'string' && /^art-[a-f0-9]{32}$/.test(value);
function validPreview(value: unknown): value is IdentityPreview {
  if (!value || typeof value !== 'object') return false;
  const p = value as IdentityPreview;
  return typeof p.baselineExists === 'boolean' && token(p.artifactId) && /^[a-f0-9]{64}$/.test(p.sha256) && /^[a-f0-9]{64}$/.test(p.baselineSha256) &&
    Number.isSafeInteger(p.size) && p.size > 0 && p.size <= 4 * 1024 * 1024 &&
    Number.isSafeInteger(p.profileCount) && p.profileCount >= 0 && typeof p.currentProfileId === 'string' && p.currentProfileId.length <= 128 && p.format === 'tailscale-file-store-v1';
}
export default function AccountIdentity(): JSX.Element {
  const scope = createApiScope();
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const [selected, setSelected] = createSignal('');
  const [preview, setPreview] = createSignal<IdentityPreview | null>(null);
  const [error, setError] = createSignal('');
  const [reading, setReading] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const writable = () => !disposed && hasRoot && nativeControl().canWrite && !nativeControl().busy;
  const stopped = () => !statusError() && status()?.daemon === 'stopped';
  const locked = () => !writable() || !stopped() || importing() || reading() || saving() || artifactExport()?.busy;
  const exported = () => { const result = getTask('identity-export')?.result; return result?.ok && validPreview(result) ? result : null; };
  const restored = () => { const result = getTask('identity-restore')?.result; return result?.ok && result.restored === true ? result : null; };
  const failed = () => ['identity-export', 'identity-restore'].map(key => getTask(key)).find(task => task?.status === 'error')?.result?.error;
  createEffect(() => { nativeControl().revision; nativeControl().accountRevision; setPreview(null); });
  function recoverImport(result: NativeResult) {
    const info = result.identity as {busy?: boolean; token?: string; error?: string} | undefined;
    if (!info) return;
    setImporting(info.busy === true);
    if (info.error) setError(info.error);
    if (token(info.token) && info.token !== selected()) { setSelected(info.token); setPreview(null); }
  }
  onMount(() => { void requestNative('files.snapshot').then(recoverImport); });
  onCleanup(onNativeEvent('files', recoverImport));
  async function inspect() {
    if (locked() || !selected()) return;
    const choice = selected(), revision = nativeControl().revision, accountRevision = nativeControl().accountRevision;
    setReading(true); setPreview(null); setError('');
    const result = await scope.api('identity-preview', choice);
    setReading(false);
    if (disposed || result.cancelled || selected() !== choice || revision !== nativeControl().revision || accountRevision !== nativeControl().accountRevision) return;
    if (result.ok && validPreview(result) && result.artifactId === choice) setPreview(result);
    else setError(result.error || t('backup_invalid_response'));
  }
  async function importState() {
    if (locked()) return;
    setImporting(true); setPreview(null); setError('');
    const result = await requestNative('identity.import');
    setImporting(false);
    if (result.ok && token(result.token)) { setSelected(result.token); await inspect(); }
    else if (!result.cancelled) setError(result.error || t('backup_invalid_response'));
  }
  async function snapshot() {
    if (locked() || !await confirmDialog({title:t('acc_identity_export'), body:t('acc_identity_secret_warning'), confirmLabel:t('acc_identity_export')})) return;
    if (locked()) return;
    setError('');
    const result = await startValidatedTask('identity-export', 'identity-export', result => validPreview(result) ? result : {ok:false,error:t('backup_invalid_response')}).promise;
    if (!result.ok && !result.cancelled) setError(result.error || t('op_failed'));
  }
  async function save(artifactId: string) {
    if (disposed || saving() || artifactExport()?.busy || !token(artifactId)) return;
    if (!await confirmDialog({title:t('save'), body:t('acc_identity_secret_warning'), confirmLabel:t('save')})) return;
    if (disposed || saving() || artifactExport()?.busy) return;
    setSaving(true);
    const result = await requestNative('artifact.save', {token:artifactId,name:'foxytail-identity.state'});
    setSaving(false);
    if (!result.ok && !result.cancelled) toastApiError(t('op_failed'),result);
  }
  async function restore() {
    const choice = preview();
    if (locked() || !choice || choice.artifactId !== selected()) return;
    if (!await confirmDialog({title:t('acc_identity_restore'), body:t('acc_identity_replace_warning') + (!choice.baselineExists ? '\n' + t('acc_identity_no_previous') : '') + '\nSHA-256: ' + choice.sha256, confirmLabel:t('acc_identity_restore'),tone:'danger'})) return;
    if (locked() || choice !== preview() || choice.artifactId !== selected()) return;
    setPreview(null); setError('');
    const result = await startValidatedTask('identity-restore','identity-restore', result =>
      result.restored === true && result.restartRequired === true && (result.rollbackArtifactId === '' || token(result.rollbackArtifactId)) ? result : {ok:false,error:t('backup_invalid_response')},
      choice.artifactId,choice.sha256,choice.baselineSha256).promise;
    invalidateAccountState(); void refreshStatus({afterCurrent:true});
    if (!result.ok && !result.cancelled) setError(result.error || t('op_failed'));
  }
  return <Card title={t('acc_identity_title')} icon="vpn_key" description={t('acc_identity_hint')}>
    <p class="tool-hint">{t('acc_identity_stopped_hint')} <a href="#/dashboard">{t('nav_dashboard')}</a></p>
    <p class="tool-hint">{t('acc_identity_secret_warning')}</p>
    <TaskProgress taskKey="identity-export" cancellable={false} /><TaskProgress taskKey="identity-restore" cancellable={false} />
    <Show when={error() || failed()}><ErrorState text={error() || failed()!} /></Show>
    <div class="tool-actions">
      <Button disabled={locked()} onClick={() => void snapshot()}>{t('acc_identity_export')}</Button>
      <Button variant="outlined" disabled={locked()} onClick={() => void importState()}>{t('acc_identity_import')}</Button>
      <Show when={selected()}><Button variant="text" disabled={locked()} onClick={() => void inspect()}>{t('backup_preview')}</Button></Show>
    </div>
    <Show when={reading() || importing()}><p role="status">{t('loading')}</p></Show>
    <Show when={exported()}>{result => <div class="tool-result"><p>{t('acc_identity_ready')}</p>
      <Button disabled={saving() || artifactExport()?.busy} onClick={() => void save(result().artifactId as string)}>{t('save')}</Button></div>}</Show>
    <Show when={preview()}>{p => <div class="tool-result" data-testid="identity-preview">
      <p>{t('acc_identity_profiles')}: {p().profileCount} · {p().size} B</p><p class="mono">SHA-256: {p().sha256}</p>
      <Button class="danger" disabled={locked()} onClick={() => void restore()}>{t('acc_identity_restore')}</Button>
    </div>}</Show>
    <Show when={restored()}>{result => <div class="tool-result" role="status"><p>{t('acc_identity_restored')}</p>
      <Show when={token(result().rollbackArtifactId)}><Button variant="outlined" disabled={saving() || artifactExport()?.busy} onClick={() => void save(result().rollbackArtifactId as string)}>{t('acc_identity_rollback_save')}</Button></Show>
    </div>}</Show>
  </Card>;
}
