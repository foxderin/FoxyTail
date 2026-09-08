/*
 * Logs — daemon / service tails, follow-scroll, 3s page-scoped poll.
 * The view is only rewritten when content actually changed so reading
 * scroll position survives refreshes.
 */
import { createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { createApiScope } from '../api';
import { t } from '../i18n';

type Src = 'daemon' | 'service';

export default function Logs(): JSX.Element {
  const scope = createApiScope();
  const [src, setSrc] = createSignal<Src>('daemon');
  const [lines, setLines] = createSignal(200);
  const [follow, setFollow] = createSignal(true);
  const [text, setText] = createSignal(t('loading'));

  let logView!: HTMLDivElement;
  let lastText: string | null = null;

  async function load() {
    const res = await scope.api('logs', src(), lines());
    if (res.cancelled) return;
    const next = !res.ok
      ? res.error || t('error')
      : !(res.lines as string[]).length
        ? t('logs_empty')
        : (res.lines as string[]).join('\n');
    /* skip the rewrite when nothing changed: clobbering textContent every
     * 3s resets the scroll position while the user is reading */
    if (next === lastText) return;
    lastText = next;
    setText(next);
    if (follow()) logView.scrollTop = logView.scrollHeight;
  }

  onMount(() => {
    void load();
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, 3000);
    onCleanup(() => clearInterval(id));
  });

  return (
    <>
      <md-tabs
        active-tab-index={src() === 'daemon' ? 0 : 1}
        on:change={(e: Event) => {
          const idx = (e.target as unknown as { activeTabIndex: number }).activeTabIndex;
          const s = idx === 0 ? 'daemon' : 'service';
          if (s !== src()) {
            setSrc(s);
            lastText = null;
            void load();
          }
        }}
      >
        <md-primary-tab>{t('logs_daemon')}</md-primary-tab>
        <md-primary-tab>{t('logs_service')}</md-primary-tab>
      </md-tabs>

      <div class="btn-row" style={{ 'margin-top': '0', 'justify-content': 'space-between' }}>
        <md-outlined-select
          style={{ width: '120px' }}
          value={String(lines())}
          on:change={(e: Event) => {
            setLines(Number((e.target as unknown as { value: string }).value));
            lastText = null;
            void load();
          }}
        >
          {['100', '200', '500'].map((n) => (
            <md-select-option value={n} selected={n === '200' || undefined}>
              <div slot="headline">{n}</div>
            </md-select-option>
          ))}
        </md-outlined-select>
        <label class="setting-row" style={{ border: '0', padding: '0', gap: '8px' }}>
          <span>{t('logs_follow')}</span>
          <md-switch
            selected={follow() || undefined}
            on:change={(e: Event) =>
              setFollow((e.target as unknown as { selected: boolean }).selected)
            }
          />
        </label>
      </div>

      <div class="mt">
        <div ref={logView} class="log-view">
          {text()}
        </div>
      </div>
    </>
  );
}
