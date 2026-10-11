import { Show, createEffect, createMemo, createRoot, createSignal, createUniqueId, onCleanup } from 'solid-js';
import type { Surfacing, SurfacingAction } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { highlightSections } from '../library/highlights';
import type { HighlightSection } from '../library/highlights';
import { highlightLocation } from '../library/query';
import { shortSourceTitle } from '../outline/source';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import './agenda.css';

export interface JournalResurfaceProps {
  date: string;
  notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean): void;
}

const collapsedKey = 'tessera.journal-resurface.collapsed';
const [collapsed, setCollapsedSignal, revision, setRevision] = createRoot(() => {
  const [collapsed, setCollapsed] = createSignal((() => { try { return localStorage.getItem(collapsedKey) === '1'; } catch { return false; } })());
  const [revision, setRevision] = createSignal(0);
  return [collapsed, setCollapsed, revision, setRevision] as const;
});
const setCollapsed = (value: boolean) => {
  setCollapsedSignal(value);
  try { if (value) localStorage.setItem(collapsedKey, '1'); else localStorage.removeItem(collapsedKey); } catch { /* The preference lasts for this tab. */ }
};

export function JournalResurface(props: JournalResurfaceProps) {
  const id = createUniqueId();
  const [items, setItems] = createSignal<Surfacing[]>([]);
  const [index, setIndex] = createSignal(0);
  const currentItem = createMemo(() => items()[Math.min(index(), items().length - 1)]);
  const [sections, setSections] = createSignal(new Map<string, HighlightSection[]>());
  const cache = new Map<string, HighlightSection[]>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [refresh, setRefresh] = createSignal(0);
  const [pending, setPending] = createSignal(false);
  const [failed, setFailed] = createSignal<{ row: Surfacing; action: SurfacingAction }>();
  let generation = 0;
  let loadedDate: string | undefined;
  createEffect(() => {
    const date = props.date;
    props.notebook.changeSequence(); revision(); refresh();
    const current = ++generation;
    const controller = new AbortController();
    setLoading(true); setError(''); setFailed(undefined); setPending(false);
    if (loadedDate !== date) { setItems([]); setIndex(0); loadedDate = date; }
    void props.notebook.api.resurfacing(date, 3, controller.signal).then(async rows => {
      const snapshots = [...new Set(rows.map(row => row.citation.snapshot_id))];
      const entries = await Promise.all(snapshots.map(async snapshot => {
        const value = cache.get(snapshot) ?? await highlightSections(props.notebook.api, snapshot, controller.signal);
        cache.set(snapshot, value);
        return [snapshot, value] as const;
      }));
      if (!controller.signal.aborted && current === generation) {
        setSections(new Map(entries)); setItems(rows); setLoading(false);
        setIndex(value => Math.min(value, Math.max(0, rows.length - 1)));
      }
    }).catch(reason => {
      if (!controller.signal.aborted && current === generation) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
    });
    onCleanup(() => controller.abort());
  });
  onCleanup(() => { generation++; });
  const formatter = createMemo(() => new Intl.DateTimeFormat('en-GB', {
    timeZone: props.notebook.settings()?.time_zone, month: 'short', day: 'numeric',
  }));
  async function act(row: Surfacing, action: SurfacingAction) {
    if (pending() || loading()) return;
    const date = props.date, current = generation;
    setPending(true); setError(''); setFailed(undefined);
    try {
      await props.notebook.api.recordSurfacing(row.citation.id, date, action);
      if (current !== generation) return;
      if (action === 'opened') props.onOpen({ kind: 'reader', sourceId: row.citation.source_id, snapshotId: row.citation.snapshot_id, citationId: row.citation.id }, true);
      setRevision(value => value + 1);
    } catch (reason) {
      if (current === generation) { setError(reason instanceof Error ? reason.message : String(reason)); setFailed({ row, action }); }
    } finally { if (current === generation) setPending(false); }
  }
  const retry = () => {
    const action = failed();
    if (action) void act(action.row, action.action);
    else setRefresh(value => value + 1);
  };
  return <section class="journal-agenda journal-resurface" aria-label="Resurfaced">
    <div class="resurface-heading">
      <Button class="journal-agenda-toggle" aria-expanded={!collapsed()} aria-controls={id} onClick={() => setCollapsed(!collapsed())}>
        <span class="journal-section-name">From your highlights</span>
        <span class="agenda-summary">{loading() ? 'Loading…' : items().length ? `${Math.min(index() + 1, items().length)} of ${items().length}` : 'Nothing yet'}</span><span class="section-rule" /><Icon name="down" />
      </Button>
      <Show when={!collapsed() && items().length > 1}><nav class="resurface-navigation" aria-label="Resurfaced highlights">
        <Button icon="left" label="Previous highlight" disabled={pending() || loading() || index() === 0} onClick={() => setIndex(value => value - 1)} />
        <Button icon="right" label="Next highlight" disabled={pending() || loading() || index() >= items().length - 1} onClick={() => setIndex(value => value + 1)} />
      </nav></Show>
    </div>
    <Show when={!collapsed()}><div id={id} class="journal-agenda-body" aria-busy={loading() || pending()}>
      <Show when={error()}><div class="agenda-error" role="alert"><span>{error()}</span><Button disabled={pending()} onClick={retry}>Retry</Button></div></Show>
      <Show when={!loading() && !error() && !items().length}><p class="agenda-message">Highlights you make appear here on later days.</p></Show>
      <Show keyed when={currentItem()}>{row => {
        const location = createMemo(() => highlightLocation(row.citation, sections().get(row.citation.snapshot_id) ?? []));
        return <article class="resurface-card" data-citation-id={row.citation.id}>
          <span class={`resurface-color highlight-color-${row.citation.color ?? 'none'}`} aria-hidden="true" />
          <p class="resurface-quote">{row.citation.quote}</p>
          <div class="resurface-footer">
            <p class="resurface-meta" title={row.source_title}>{shortSourceTitle(row.source_title)} · {location()}{location().startsWith('¶') ? '' : ` · ¶${row.citation.ordinal + 1}`} · {formatter().format(row.created_at)}</p>
            <div class="resurface-actions">
              <Button disabled={pending() || loading()} onClick={() => void act(row, 'opened')}>Open</Button><span aria-hidden="true">·</span>
              <Button disabled={pending() || loading()} aria-pressed={row.action === 'kept'} onClick={() => void act(row, 'kept')}><Show when={row.action === 'kept'}><Icon name="check" /></Show>Keep</Button><span aria-hidden="true">·</span>
              <Button disabled={pending() || loading()} onClick={() => void act(row, 'muted')}>Mute</Button>
            </div>
          </div>
        </article>;
      }}</Show>
    </div></Show>
  </section>;
}
