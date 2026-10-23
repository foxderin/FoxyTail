/* Only dev/index.html imports this fixture; the APK entry never does. */
import { installFixture } from './native-fixture.mjs';
const params = new URLSearchParams(location.search);
installFixture(window, {
  state: params.get('state') || 'ready',
  lang: params.get('lang') || 'zh',
  theme: params.get('theme') || 'light',
  page: location.hash.slice(2) || 'dashboard',
  delay: 120,
});
// Deliberate module-loading boundary: hasNativeBridge is captured at app import.
await import('../src/main');
const notice = document.createElement('div');
notice.textContent = params.get('lang') === 'en' ? 'Preview · simulated data · no device I/O' : '设计预览 · 模拟数据 · 无设备操作';
notice.setAttribute('role', 'note');
notice.style.cssText = 'position:fixed;bottom:calc(var(--ft-bottom-nav-height,74px) + 8px);right:12px;z-index:45;padding:4px 9px;border:1px solid var(--ft-border);border-radius:6px;background:var(--ft-surface);color:var(--ft-muted);font:10px system-ui;pointer-events:none';
document.body.append(notice);
