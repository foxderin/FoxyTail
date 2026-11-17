import { boot, assert, flush } from './smoke-fixture.mjs';

export async function runToastDedupSmoke() {
  const h = await boot();
  const { app, window, fixture } = h;
  const errors = () => [...window.document.querySelectorAll('.toast.err')];
  const message = 'Save failed\n/path/one: exact backend detail';
  try {
    let timers = 0;
    const setTimeout = window.setTimeout;
    window.setTimeout = (...args) => { timers++; return setTimeout(...args); };
    app.toast.showToast(message, 'err');
    const scheduled = timers;
    window.setTimeout = setTimeout;
    await flush();
    assert(scheduled === 0, 'persistent errors have no automatic dismissal timer');
    const original = errors()[0];
    const details = original.querySelector('.toast-details');
    assert(details && !details.open && details.querySelector('.toast-full-message').textContent === message, 'multiline error starts compact with exact full details available');
    details.open = true; await flush();
    assert(details.querySelector('.toast-full-message').tabIndex === 0, 'expanded full details are keyboard-scrollable');
    const copy = original.querySelector(`button[aria-label="${app.t('copy')}"]`);
    copy.focus();
    for (let i = 0; i < 8; i++) app.toast.showToast(message, 'err');
    await flush();
    assert(errors().length === 1 && errors()[0] === original, 'identical errors reuse the existing persistent toast');
    assert(window.document.activeElement === copy && details.open, 'duplicate errors preserve focused controls and expanded details');
    copy.click(); await flush();
    assert(fixture.log.findLast(row => row.action === 'app.copy')?.args.text === message, 'copy retains the exact multiline error details');
    app.toast.showToast('Save failed\n/path/two: different backend detail', 'err');
    for (let i = 0; i < 8; i++) app.toast.showToast(message, 'err');
    await flush();
    assert(errors().length === 2 && errors().some(node => node.textContent.includes('/path/two')), 'same summary with different details is not deduplicated or evicted by repeats');
    const action = () => {};
    app.toast.showToast(message, 'err', { label: 'Retry', run: action });
    app.toast.showToast(message, 'err', { label: 'Retry', run: action });
    await flush();
    assert(errors().length === 3, 'same action identity deduplicates but does not hide a different recovery action');
    original.querySelector(`button[aria-label="${app.t('close')}"]`).click(); await flush();
    app.toast.showToast(message, 'err'); await flush();
    assert(errors().length === 3 && !original.isConnected, 'dismissed errors can be reported again, not globally suppressed');
    assert(fixture.unsupported.length === 0, 'toast regression uses supported native actions');
  } finally { h.close(); }
}
