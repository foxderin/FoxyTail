import {boot, assert, flush} from './smoke-fixture.mjs';
export async function runBackupPickerSmoke() {
  for (const list of [{ok:true,backups:[]}, {ok:false,error:'List unavailable'}]) {
    const h = await boot();
    try {
      h.fixture.overrides.set('backup-list', list);
      h.fixture.overrides.set('backup.import', {ok:true,token:h.fixture.token});
      await h.nav('settings');
      const local = h.button('backup_choose_local');
      assert(local && !local.disabled && !local.closest('details'), 'local file picker is visible and usable independently of backup list');
      const select = h.window.document.querySelector('#restore-backup');
      assert(Boolean(local.compareDocumentPosition(select) & h.window.Node.DOCUMENT_POSITION_FOLLOWING), 'local picker precedes discovered-backup dropdown');
      h.click(local); await flush();
      assert(h.fixture.log.some(r => r.action === 'backup.import'), 'explicit local action reaches native document picker');
      assert(h.window.document.querySelector('[data-testid="restore-diff"]'), 'selected local artifact is previewed even when list is empty or failed');
      assert(!h.fixture.log.some(r => r.action === 'control.mutate' && r.args.command === 'restore'), 'choosing local file never restores without confirmation');
      assert(h.fixture.unsupported.length === 0, 'local picker regression uses supported native actions');
    } finally {h.close();}
  }
  const h = await boot();
  try {
    await h.nav('settings'); await h.app.backup.createBackup(); await flush();
    h.fixture.overrides.set('artifact.save', {ok:true});
    h.click(h.button('save', h.window.document.querySelector('[data-testid="backup-result"]'))); await flush();
    const name = h.fixture.log.findLast(r => r.action === 'artifact.save')?.args.name;
    assert(/^foxytail-backup-[A-Za-z0-9._-]+\.tar\.gz$/.test(name), 'new save filename matches discovered-backup policy');
    const legacy = '/sdcard/Download/foxytail-backup.tar.gz';
    assert(h.app.backup.validBackups([{path:legacy,name:'foxytail-backup.tar.gz',size:10,mtime:1}]), 'legacy exported default filename remains selectable');
    assert(h.app.backup.validRestorePreview({...h.fixture.command('restore-preview',[h.fixture.token]),path:legacy}), 'legacy filename passes frontend preview boundary');
  } finally {h.close();}
}
