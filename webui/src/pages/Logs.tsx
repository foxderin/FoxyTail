/* Log filtering is local. Only one page-scoped read may run at a time. */
import { createMemo, createSignal, For, Index, Show, type JSX } from 'solid-js';
import { createApiScope } from '../api';
import { pollWhileVisible } from '../schedule';
import { status, viewPollInterval } from '../state';
import { t } from '../i18n';
import { Card, EmptyState, ErrorState, SkeletonRows, StatusBadge } from '../components/Basics';
import { copyText } from '../components/LoginHero';
import { showToast } from '../components/Toast';
import { MdIcon } from '../icons';
import { Button, Select, Switch, Tabs, TextField } from '../components/ui';
import './tools.css';

type Src = 'daemon' | 'service';
export default function Logs(): JSX.Element {
  const scope = createApiScope();
  const [src, setSrc] = createSignal<Src>('daemon');
  const [limit, setLimit] = createSignal(200);
  const [follow, setFollow] = createSignal(true);
  const [live, setLive] = createSignal(true);
  const [wrap, setWrap] = createSignal(true);
  const [matchCase, setMatchCase] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [lines, setLines] = createSignal<string[] | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [updated, setUpdated] = createSignal('');
  const refreshing = () => live() && status()?.autoRefresh !== false;
  let logView: HTMLDivElement | undefined;
  let rerun = false;
  const filtered = createMemo(() => {
    const needle = matchCase() ? query() : query().toLocaleLowerCase();
    return (lines() ?? [])
      .map((line, i) => ({ line, number: i + 1 }))
      .filter(({ line }) => !needle || (matchCase() ? line : line.toLocaleLowerCase()).includes(needle));
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
      if (res.ok) {
        const next = (res.lines as string[]) || [];
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
  pollWhileVisible(() => busy() ? undefined : load(), () => live() ? viewPollInterval(5000) : false);
  function copyResults() {
    showToast(
      t(
        copyText(
          filtered()
            .map((row) => row.line)
            .join('\n'),
        )
          ? 'copied'
          : 'op_failed',
      ),
      'info',
    );
  }
  return (
    <div class="tools-page">
      <Card>
        <p class="tool-hint">{t('tools_logs_scope')}</p>
        <div class="tool-form">
          <Tabs
            labels={[t('logs_daemon'), t('logs_service')]}
            active={src() === 'daemon' ? 0 : 1}
            onChange={(index) => {
              const next = index === 0 ? 'daemon' : 'service';
              if (next !== src()) {
                setSrc(next);
                setLines(null);
                setError(null);
                void load();
              }
            }}
          />
          <div class="tool-log-controls">
            <TextField
              label={t('tools_logs_find')}
              aria-label={t('tools_logs_find')}
              value={query()}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              leading-icon={<MdIcon name="search" size={18} />}
            />
            <Select
              label={t('tools_logs_rows')}
              value={String(limit())}
              onChange={(e) => {
                setLimit(Number((e.target as HTMLSelectElement).value));
                void load();
              }}
            >
              <For each={[100, 200, 500, 1000]}>{(n) => <option value={n}>{n}</option>}</For>
            </Select>
          </div>
          <div class="tool-toggle-list">
            <div class="tool-toggle">
              <Switch
                aria-label={t('tools_logs_live')}
                checked={refreshing()}
                disabled={status()?.autoRefresh === false}
                onChange={(e) => setLive((e.target as HTMLInputElement).checked)}
              />
              <span>{t('tools_logs_live')}</span>
            </div>
            <div class="tool-toggle">
              <Switch
                aria-label={t('logs_follow')}
                checked={follow()}
                onChange={(e) => setFollow((e.target as HTMLInputElement).checked)}
              />
              <span>{t('logs_follow')}</span>
            </div>
            <div class="tool-toggle">
              <Switch
                aria-label={t('tools_logs_wrap')}
                checked={wrap()}
                onChange={(e) => setWrap((e.target as HTMLInputElement).checked)}
              />
              <span>{t('tools_logs_wrap')}</span>
            </div>
            <div class="tool-toggle">
              <Switch
                aria-label={t('tools_logs_match_case')}
                checked={matchCase()}
                onChange={(e) => setMatchCase((e.target as HTMLInputElement).checked)}
              />
              <span>{t('tools_logs_match_case')}</span>
            </div>
          </div>
        </div>
        <div class="tool-actions spread">
          <StatusBadge tone={refreshing() ? 'success' : 'neutral'}>
            {refreshing() ? t('tools_logs_live') : t('tools_logs_paused')}
          </StatusBadge>
          <div class="toolbar">
            <Button variant="text" busy={busy()} onClick={() => void load()}>
              <MdIcon name="refresh" size={18} />
              {busy() ? t('loading') : t('tools_refresh')}
            </Button>
            <Button variant="tonal" disabled={!filtered().length} onClick={copyResults}>
              <MdIcon name="content_copy" size={18} />
              {t('tools_logs_copy')}
            </Button>
          </div>
        </div>
        <Show when={status()?.autoRefresh === false}><p class="tool-hint">{t('tools_refresh_disabled')}</p></Show>
      </Card>
      <Card>
        <div class="tool-form">
          <div class="tool-log-meta">
            <span>
              {t('tools_logs_count')} · {filtered().length} / {lines()?.length ?? '—'}
            </span>
            <Show when={updated()}>
              <span>
                {t('tools_logs_updated')} {updated()}
              </span>
            </Show>
          </div>
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
                <EmptyState text={query() ? t('tools_logs_no_match') : t('logs_empty')} icon="article" />
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
                    <div class="tool-log-line">
                      <span aria-hidden="true">{row().number}</span>
                      <code>{row().line || ' '}</code>
                    </div>
                  )}
                </Index>
              </div>
            </Show>
          </Show>
        </div>
      </Card>
    </div>
  );
}
