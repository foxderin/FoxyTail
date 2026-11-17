import {boot, assert, flush} from './smoke-fixture.mjs';
export async function runAccountIdentitySmoke() {
  const h = await boot(); const {fixture, window, nav, app, button, click, confirm} = h;
  const id = 'art-' + 'e'.repeat(32);
  const manifest = {ok:true,artifactId:id,sha256:'a'.repeat(64),baselineSha256:'b'.repeat(64),baselineExists:true,size:200,profileCount:2,currentProfileId:'profile-one',format:'tailscale-file-store-v1'};
  try {
    fixture.data.accounts.accounts[0].id = 'profile-personal';
    await nav('account');
    fixture.overrides.set('account-rename', {ok:true,renamed:true});
    h.input(window.document.querySelector('.tools-page .tool-form input'), 'New profile'); await flush();
    click(button('acc_rename')); await confirm(true); await flush();
    const rename = fixture.log.find(r => r.args.command === 'account-rename');
    assert(rename?.args.arguments.join('|') === 'profile-personal|New profile', 'nickname change is bound to the confirmed current profile');
    assert(!fixture.log.some(r => r.args.command === 'switch'), 'nickname edit never switches another account');

    assert(button('acc_identity_export').disabled && button('acc_identity_import').disabled, 'running service prevents identity maintenance');
    fixture.data.status.daemon = 'stopped'; fixture.data.status.backend = 'Stopped'; fixture.data.status.self = null;
    await app.state.refreshStatus(); await flush();
    fixture.overrides.set('identity-export',manifest);
    click(button('acc_identity_export')); await confirm(false);
    assert(!fixture.log.some(r => r.action === 'control.mutate' && r.args.command === 'identity-export'), 'declining secret backup warning does not snapshot');
    click(button('acc_identity_export')); await confirm(true); await flush();
    assert(fixture.log.some(r => r.action === 'control.mutate' && r.args.command === 'identity-export'), 'approved backup uses durable opaque export command');
    assert(!fixture.log.some(r => r.action === 'artifact.save'), 'creating private snapshot does not automatically export credentials');
    fixture.overrides.set('identity.import',{ok:true,token:id}); fixture.overrides.set('identity-preview',manifest);
    click(button('acc_identity_import')); await flush();
    assert(window.document.querySelector('[data-testid="identity-preview"]')?.textContent.includes('2'), 'identity preview uses nonsecret manifest only');
    fixture.holdNext.add('identity-preview');
    click(button('backup_preview')); await flush();
    fixture.publishControl({accountRevision: fixture.control.accountRevision + 1}); await flush();
    fixture.held.findLast(r => r.key === 'identity-preview').finish(); await flush();
    assert(!window.document.querySelector('[data-testid="identity-preview"]'), 'late preview cannot repopulate after account revision changes');
    click(button('backup_preview')); await flush();

    click(button('acc_identity_restore')); await confirm(false);
    assert(!fixture.log.some(r => r.args.command === 'identity-restore'), 'declined replacement never mutates identity');
    fixture.overrides.set('identity-restore',{ok:true,restored:true,restartRequired:true,rollbackArtifactId:'art-'+'f'.repeat(32)});
    click(button('acc_identity_restore')); await confirm(true); await flush();
    const restore = fixture.log.find(r => r.args.command === 'identity-restore');
    assert(restore?.args.arguments.join('|') === [id,manifest.sha256,manifest.baselineSha256].join('|'), 'replacement is fenced to selected artifact/source hash/current baseline');
    assert(!fixture.log.some(r => r.args.command === 'control'), 'identity UI never starts or stops service implicitly');
    assert(window.document.body.textContent.includes(window.__foxy.t('acc_identity_restored')), 'success explicitly tells user service stays stopped');
    const before = fixture.log.filter(r => r.args.command === 'identity-export').length;
    click(button('acc_identity_export')); await flush();
    await nav('settings'); await confirm(true); await flush();
    assert(fixture.log.filter(r => r.args.command === 'identity-export').length === before, 'navigation while confirming cannot start identity export from disposed page');
    assert(fixture.unsupported.length === 0, 'identity feature uses explicit fixture contracts');
  } finally {h.close();}
  const fresh = await boot();
  try {
    fresh.fixture.data.status.daemon = 'stopped'; fresh.fixture.data.status.backend = 'Stopped'; fresh.fixture.data.status.self = null;
    await fresh.app.state.refreshStatus(); await fresh.nav('account');
    fresh.fixture.overrides.set('identity.import', {ok:true,token:id});
    fresh.fixture.overrides.set('identity-preview', {...manifest,baselineExists:false});
    fresh.fixture.overrides.set('identity-restore', {ok:true,restored:true,restartRequired:true,rollbackArtifactId:''});
    fresh.click(fresh.button('acc_identity_import')); await flush();
    fresh.click(fresh.button('acc_identity_restore')); await flush();
    assert(fresh.window.document.querySelector('dialog[open]')?.textContent.includes(fresh.window.__foxy.t('acc_identity_no_previous')), 'fresh restore warns that no previous identity backup exists');
    await fresh.confirm(true); await flush();
    assert(fresh.window.document.body.textContent.includes(fresh.window.__foxy.t('acc_identity_restored')), 'fresh restore accepts successful result without rollback artifact');
    assert(!fresh.button('acc_identity_rollback_save'), 'fresh restore never offers a nonexistent rollback file');
  } finally {fresh.close();}
}
