/*
 * Logs — daemon / service tails, follow-scroll, 3s page-scoped poll.
 * The view is only rewritten when content actually changed so reading
 * scroll position survives refreshes.
 */
import { createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { createApiScope } from '../api';
import { t } from '../i18n';
import { Select, Switch, Tab, Tabs } from '../components/ui';

type Src = 'daemon' | 'service';

let seq = 0;

export default function Logs(): JSX.Element {
  const scope = createApiScope();
  const [src, setSrc] = createSignal<Src>('daemon');
  const [lines, setLines] = createSignal(200);
  const [follow, setFollow] = createSignal(true);
  const [text, setText] = createSignal(t('loading'));

  let logView!: HTMLDivElement;
  let lastText: string | null = null;

  async function load() {
    const my = ++seq;
    const res = await scope.api('logs', src(), lines());
    if (res.cancelled || my !== seq) return;
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
      <Tabs
        activeTabIndex={src() === 'daemon' ? 0 : 1}
        onChange={(e: Event) => {
          const idx = (e.target as unknown as { activeTabIndex: number }).activeTabIndex;
          const s = idx === 0 ? 'daemon' : 'service';
          if (s !== src()) {
            setSrc(s);
            lastText = null;
            void load();
          }
        }}
      >
        <Tab label={t('logs_daemon')} />
        <Tab label={t('logs_service')} />
      </Tabs>

      <div class="btn-row" style={{ 'margin-top': '0', 'justify-content': 'space-between' }}>
        <Select
          style={{ width: '120px' }}
          value={String(lines())}
          onChange={(e: Event) => {
            setLines(Number((e.target as HTMLSelectElement).value));
            lastText = null;
            void load();
          }}
        >
          {['100', '200', '500'].map((n) => (
            <option value={n} selected={n === String(lines())}>{n}</option>
          ))}
        </Select>
        <label class="setting-row" style={{ border: '0', padding: '0', gap: '8px' }}>
          <span>{t('logs_follow')}</span>
          <Switch
            selected={follow()}
            onChange={(e: Event) => setFollow((e.target as unknown as { selected: boolean }).selected)}
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
