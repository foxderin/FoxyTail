import { readFileSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { installFixture } from '../dev/native-fixture.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = process.argv[2] || join(root, '.smoke/app.js');
const bundleMtime = statSync(bundlePath).mtimeMs;
for (const directory of ['src', 'dev']) {
  for (const entry of readdirSync(join(root, directory), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && statSync(join(entry.parentPath, entry.name)).mtimeMs > bundleMtime)
      throw new Error('Smoke bundle is stale; run pnpm smoke');
  }
}
const bundle = readFileSync(bundlePath, 'utf8');
export const failures = [];
export let checks = 0;
export function assert(value, label) { checks++; if (!value) failures.push(label); }
export const copy = value => JSON.parse(JSON.stringify(value));
export async function flush(rounds = 12) { for (let i = 0; i < rounds; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
export async function boot(options = {}) {
  const console = new VirtualConsole();
  console.on('error', (...args) => failures.push('console.error: ' + args.join(' ')));
  console.on('jsdomError', error => { if (!/Not implemented: (?:navigation|HTMLCanvasElement)/i.test(error.message)) failures.push(error.message); });
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'https://appassets.androidplatform.net/assets/index.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console,
  });
  const { window } = dom;
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
  window.requestAnimationFrame = fn => window.setTimeout(() => fn(window.performance.now()), 0);
  window.cancelAnimationFrame = id => window.clearTimeout(id);
  window.matchMedia = query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  window.Element.prototype.scrollTo = function () {};
  window.Element.prototype.scrollIntoView = function () {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const fixture = installFixture(window, options);
  window.eval(bundle);
  await flush();
  const nav = async route => { window.location.hash = '#/' + route; await flush(); };
  const input = (element, value) => {
    assert(!!element, 'input exists');
    if (!element) return;
    element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const button = (key, within = window.document) => [...within.querySelectorAll('button')].find(b => !b.closest('[hidden]') && (b.textContent.trim() === window.__foxy.t(key) || b.getAttribute('aria-label') === window.__foxy.t(key)));
  const click = element => { assert(!!element && !element.disabled, 'enabled interaction target exists'); element?.click(); };
  const confirm = async accepted => {
    await flush();
    const dialog = [...window.document.querySelectorAll('[role="dialog"], dialog[open]')].at(-1);
    assert(!!dialog, 'destructive/conflict action requires confirmation');
    click((dialog || window.document).querySelector(`[data-dialog-action="${accepted ? 'confirm' : 'cancel'}"]`));
    await flush();
  };
  return { window, fixture, app: window.__foxy, nav, input, button, click, confirm, close: () => window.close() };
}
