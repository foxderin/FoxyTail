import { boot, assert, flush } from './smoke-fixture.mjs';
export async function runBackStateSmoke() {
  const h = await boot();
  const {fixture, window, nav, click} = h;
  const state = () => fixture.log.findLast(row => row.action === 'app.backState')?.args.canHandle;
  try {
    assert(state() === false, 'hydrated root delegates Back to Android');
    const rootReports = fixture.log.filter(row => row.action === 'app.backState').length;
    fixture.emit('navigate', {ok:true,page:'dashboard'}); await flush();
    assert(state() === false && fixture.log.filter(row => row.action === 'app.backState').length > rootReports, 'same-root native intent republishes system handoff');
    click(window.document.querySelector('.task-menu summary')); await flush();
    assert(state() === true, 'root menu intercepts Back before system exit');
    fixture.emit('back', {ok:true}); await flush();
    assert(state() === false && !window.document.querySelector('.task-menu').open, 'committed Back closes menu and restores root system behavior');
    const dialog = window.document.createElement('dialog'); window.document.body.append(dialog); dialog.showModal(); await flush();
    assert(state() === true, 'root dialog intercepts Back');
    dialog.close(); dialog.remove(); await flush();
    assert(state() === false, 'dialog close relinquishes native interception');
    await nav('settings');
    assert(state() === true, 'non-root route intercepts Back');
    await nav('dashboard');
    assert(state() === true, 'dashboard with app history still intercepts Back');
    fixture.emit('back', {ok:true}); await flush();
    assert(window.location.hash === '#/settings', 'commit preserves actual previous route');
    fixture.emit('back', {ok:true}); await flush();
    assert(window.location.hash === '#/dashboard' && state() === false, 'drained back stack restores system-owned root');
    assert(!fixture.log.some(row => row.action === 'app.close'), 'root handoff does not proactively finish Activity');
    assert(fixture.unsupported.length === 0, 'back-state commands are explicitly supported');
  } finally {h.close();}
}
