/* Log filtering is local. Only one page-scoped read may run at a time. */
import { createMemo, createSignal, For, Index, Show, type JSX } from 'solid-js';
import { createApiScope } from '../api';
import { LOGS_POLL_MS } from '../config';
import { pollWhileVisible } from '../schedule';
import { status, viewPollInterval } from '../state';
import { t } from '../i18n';
import { EmptyState, ErrorState, SkeletonRows } from '../components/Basics';
import { copyWithToast } from '../clipboard';
import { MdIcon } from '../icons';
import { TextField } from '../components/ui';
import './tools.css';
import { bindNativeDraft } from '../settings';

type Src = 'daemon' | 'service';
type Level = 'all' | 'warn' | 'error';
type LineLevel = 'info' | 'warn' | 'error';

function levelOf(line: string): LineLevel {
  const head = line.slice(0, 160);
  if (/\b(?:fatal|panic|error|err|failed|failure|denied|refused|timed? ?out)\b/i.test(head)) return 'error';
  if (/\b(?:warn(?:ing)?|wrn|caution)\b/i.test(head)) return 'warn';
  return 'info';
}

export default function Logs(): JSX.Element {
  const scope = createApiScope();
  const [src, setSrc] = createSignal<Src>('daemon');
  const [limit, setLimit] = createSignal(200);
  const [level, setLevel] = createSignal<Level>('all');
  const [follow, setFollow] = createSignal(true);
  const [live, setLive] = createSignal(true);
  const [wrap, setWrap] = createSignal(true);
  const [matchCase, setMatchCase] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [lines, setLines] = createSignal<string[] | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [updated, setUpdated] = createSignal('');
  const draftReady = bindNativeDraft('logs', () => ({ source: src(), limit: limit(), level: level(), live: live(), follow: follow(), wrap: wrap(), matchCase: matchCase(), query: query() }), value => {
    if (value.source === 'daemon' || value.source === 'service') setSrc(value.source);
    if ([100, 200, 500, 1000].includes(Number(value.limit))) setLimit(Number(value.limit));
    if (value.level === 'all' || value.level === 'warn' || value.level === 'error') setLevel(value.level);
    if (typeof value.live === 'boolean') setLive(value.live);
    if (typeof value.follow === 'boolean') setFollow(value.follow);
    if (typeof value.wrap === 'boolean') setWrap(value.wrap);
    if (typeof value.matchCase === 'boolean') setMatchCase(value.matchCase);
    if (typeof value.query === 'string') setQuery(value.query);
  });
  const refreshing = () => live() && status()?.autoRefresh !== false;
  let logView: HTMLDivElement | undefined;
  let rerun = false;
  const rows = createMemo(() => (lines() ?? []).map((line, i) => ({ line, number: i + 1, level: levelOf(line) })));
  const counts = createMemo(() => ({
    all: rows().length,
    warn: rows().filter((row) => row.level !== 'info').length,
    error: rows().filter((row) => row.level === 'error').length,
  }));
  const filtered = createMemo(() => {
    const needle = matchCase() ? query() : query().toLocaleLowerCase();
    return rows()
      .filter((row) => level() === 'all' || (level() === 'warn' ? row.level !== 'info' : row.level === 'error'))
      .filter((row) => !needle || (matchCase() ? row.line : row.line.toLocaleLowerCase()).includes(needle));
  });
  async function load() {
    if (busy()) {
      rerun = true;
      return;
    }
    setBusy(true);
    const source = src();
    const count = limit();
    const res = await scope.api('logs', source, count);
    if (!res.cancelled && source === src() && count === limit()) {
      if (res.ok && Array.isArray(res.lines) && res.lines.every(line => typeof line === 'string')) {
        const next = res.lines as string[];
        const changed = next.length !== lines()?.length || next.some((line, index) => line !== lines()?.[index]);
        if (changed) setLines(next);
        setError(null);
        setUpdated(new Date().toLocaleTimeString());
        if (changed && follow() && logView && !document.hidden)
          requestAnimationFrame(() => {
            if (logView) logView.scrollTop = logView.scrollHeight;
          });
      } else setError(res.error || t('error'));
    }
    setBusy(false);
    if (rerun && !res.cancelled) {
      rerun = false;
      void load();
    }
  }
  pollWhileVisible(() => draftReady.then(() => busy() ? undefined : load()), () => live() ? viewPollInterval(LOGS_POLL_MS) : false);
  function copyResults() {
    copyWithToast(filtered().map((row) => row.line).join('\n'), 'info');
  }
  function closeMenu(e: Event) {
    const details = (e.currentTarget as HTMLElement).closest('details');
    if (details) details.open = false;
  }
  function setSource(next: Src) {
    if (next !== src()) {
      setSrc(next);
      setLines(null);
      setError(null);
      void load();
    }
  }
  return (
    <div class="tools-page logs-page">
      <div class="tool-log-controls">
        <TextField
          label={t('tools_logs_find')}
          aria-label={t('tools_logs_find')}
          value={query()}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          leading-icon={<MdIcon name="search" size={18} />}
        />
        <button
          type="button"
          class="icon-btn logs-live-toggle"
          aria-label={t('tools_logs_live')}
          aria-pressed={refreshing()}
          disabled={status()?.autoRefresh === false}
          onClick={() => setLive(!live())}
        >
          <MdIcon name={refreshing() ? 'pause' : 'play_arrow'} size={20} />
        </button>
        <details class="menu-pop">
          <summary aria-label={t('tools_logs_options')}><MdIcon name="more_horiz" size={20} /></summary>
          <div>
            <p class="menu-label">{t('tools_logs_source')}</p>
            <button type="button" aria-pressed={src() === 'daemon'} onClick={(e) => { setSource('daemon'); closeMenu(e); }}>{t('logs_daemon')}</button>
            <button type="button" aria-pressed={src() === 'service'} onClick={(e) => { setSource('service'); closeMenu(e); }}>{t('logs_service')}</button>
            <p class="menu-label">{t('tools_logs_rows')}</p>
            <For each={[100, 200, 500, 1000]}>
              {(n) => (
                <button type="button" aria-pressed={limit() === n} onClick={(e) => { setLimit(n); closeMenu(e); void load(); }}>{n}</button>
              )}
            </For>
            <p class="menu-label">{t('tools_logs_options')}</p>
            <button type="button" aria-pressed={follow()} onClick={() => setFollow(!follow())}>{t('logs_follow')}</button>
            <button type="button" aria-pressed={wrap()} onClick={() => setWrap(!wrap())}>{t('tools_logs_wrap')}</button>
            <button type="button" aria-pressed={matchCase()} onClick={() => setMatchCase(!matchCase())}>{t('tools_logs_match_case')}</button>
            <button type="button" disabled={busy()} onClick={(e) => { closeMenu(e); void load(); }}>{busy() ? t('loading') : t('tools_refresh')}</button>
            <button type="button" disabled={!filtered().length} onClick={(e) => { closeMenu(e); copyResults(); }}>{t('tools_logs_copy')}</button>
            <p class="menu-label logs-menu-note">{t('tools_logs_scope')}</p>
          </div>
        </details>
      </div>
      <div class="logs-filter-row filter-chips">
        <For each={(['all', 'warn', 'error'] as const)}>
          {(lv) => (
            <button
              type="button"
              class="filter-chip"
              aria-label={t(lv === 'all' ? 'tools_logs_level_all' : lv === 'warn' ? 'tools_logs_level_warn' : 'tools_logs_level_error')}
              aria-pressed={level() === lv}
              onClick={() => setLevel(lv)}
            >
              {t(lv === 'all' ? 'tools_logs_level_all' : lv === 'warn' ? 'tools_logs_level_warn' : 'tools_logs_level_error')}
              <span class="logs-chip-count" aria-hidden="true">{counts()[lv]}</span>
            </button>
          )}
        </For>
        <span class="logs-meta">
          {filtered().length} / {lines()?.length ?? '—'}
          <Show when={updated()}> · {updated()}</Show>
          <Show when={!refreshing()}> · {t('tools_logs_paused')}</Show>
        </span>
      </div>
      <Show when={status()?.autoRefresh === false}><p class="tool-hint">{t('tools_refresh_disabled')}</p></Show>
      <Show when={error()}>
        <ErrorState text={error()!} onRetry={() => void load()} />
      </Show>
      <Show
        when={lines() !== null}
        fallback={
          <Show when={!error()}>
            <SkeletonRows rows={8} />
          </Show>
        }
      >
        <Show
          when={filtered().length}
          fallback={
            <EmptyState text={query() || level() !== 'all' ? t('tools_logs_no_match') : t('logs_empty')} icon="article" />
          }
        >
          <div
            ref={logView}
            class={'tool-log' + (wrap() ? ' wrap' : '')}
            role="region"
            aria-label={t(src() === 'daemon' ? 'logs_daemon' : 'logs_service')}
            tabindex="0"
          >
            <Index each={filtered()}>
              {(row) => (
                <div class={'tool-log-line' + (row().level !== 'info' ? ' is-' + row().level : '')}>
                  <span aria-hidden="true">{row().number}</span>
                  <code>{row().line || ' '}</code>
                </div>
              )}
            </Index>
          </div>
        </Show>
      </Show>
    </div>
  );
}
