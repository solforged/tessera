import { For, Show, createEffect, createMemo, createResource, createSignal } from 'solid-js';
import type { LibraryRow } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { SourceCover } from '../library/SourceCover';
import { BlockText } from '../outline/BlockText';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Picker } from '../ui/Picker';
import { readingRowText } from '../tasks/today-template';
import { readingSources, recentCaptures, todayJournal } from './today-journal';

/** A source a Reading note can go under, with why it is offered. */
export interface UnderChoice { id: string; title: string; reason: string; row?: LibraryRow }

/** A source's short title, by the citation-chip rule: the title before any subtitle. */
export const shortTitle = (title: string) => title.split(/:\s/)[0]!.trim() || title;

/** The Reading row a note under `choice` is filed beneath, with the reader's section when the row is first written. */
export const underText = (choice: UnderChoice) => readingRowText(choice.id, shortTitle(choice.title), choice.row?.section);

/**
 * Reading's Under row: the source last open in the reader, those already under today's Reading, then the rest of the
 * Library's Reading shelf, and a search of all sources.
 */
export function ReadingUnder(props: { notebook: NotebookClient; value?: UnderChoice; onChange(choice: UnderChoice): void }) {
  const [options] = createResource(async (): Promise<UnderChoice[]> => {
    const template = props.notebook.todayTemplate();
    const [recent, reading, page] = await Promise.all([
      props.notebook.api.library({ states: [], sort: 'last_read', direction: 'desc', limit: 1 }),
      props.notebook.api.library({ states: ['reading'], sort: 'last_read', direction: 'desc', limit: 6 }),
      todayJournal(props.notebook),
    ]);
    const result: UnderChoice[] = [];
    const add = (choice: UnderChoice) => { if (!result.some(value => value.id === choice.id)) result.push(choice); };
    const opened = recent.rows.find(row => row.source.last_read_at !== null);
    if (opened) add({ id: opened.page.id, title: opened.page.text, reason: 'Open in the reader', row: opened });
    for (const id of page ? readingSources(page, template) : []) {
      const row = reading.rows.find(value => value.page.id === id);
      add({ id, title: row?.page.text ?? props.notebook.lookup(id)()?.text ?? 'Source', reason: 'In Reading today', row });
    }
    for (const row of reading.rows) add({ id: row.page.id, title: row.page.text, reason: 'Reading', row });
    return result.slice(0, 5);
  });
  // The first offer is chosen until another is, so a Reading note always has a source when one exists.
  createEffect(() => { const first = options()?.[0]; if (first && !props.value) props.onChange(first); });
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [query, setQuery] = createSignal('');
  const [found] = createResource(() => anchor() ? query() : false, async text => (await props.notebook.api.library({ states: [], text: text.trim() || null, sort: 'last_read', direction: 'desc', limit: 20 })).rows);
  const shown = createMemo(() => {
    const value = props.value, list = options() ?? [];
    return value && !list.some(choice => choice.id === value.id) ? [...list, value] : list;
  });
  return <div class="create-under" role="group" aria-label="Under"><span>Under</span>
    <div class="create-under-options">
      <For each={shown()}>{choice => <Button class="create-under-option" aria-pressed={props.value?.id === choice.id} onClick={() => props.onChange(choice)}>
        <span class="create-under-cover"><Show when={choice.row} fallback={<Icon name="library" />}>{row => <SourceCover row={row()} siglum={row().source.siglum} />}</Show></span>
        <span class="create-under-text"><span class="create-under-title">{shortTitle(choice.title)}</span><span class="create-under-reason">{choice.reason}</span></span>
      </Button>}</For>
      <Button class="create-under-other" aria-haspopup="listbox" onClick={event => { setQuery(''); setAnchor(event.currentTarget); }}>Another source…</Button>
    </div>
    <Show when={anchor()}>{at => <Picker<LibraryRow> anchor={at()} label="Under a source" query={query()} onQuery={setQuery} placeholder="Find a source" items={found() ?? []} key={row => row.page.id}
      busy={found.loading} error={found.error ? String(found.error) : undefined} empty="No matching sources." onDismiss={() => setAnchor(undefined)}
      onPick={row => { props.onChange({ id: row.page.id, title: row.page.text, reason: 'Chosen', row }); setAnchor(undefined); }}
      row={row => <><Icon name="library" /><span class="picker-text">{row.page.text}</span><Show when={row.creators.length}><span class="picker-meta">{row.creators.join(', ')}</span></Show></>} />}</Show>
  </div>;
}

/** The last three lines captured into today's sections, newest first; choosing one opens it in Today. */
export function CapturedToday(props: { notebook: NotebookClient; refresh: number; onOpen(pageId: string, blockId: string): void }) {
  const [lines] = createResource(() => [props.notebook.todayDate(), props.notebook.changeSequence(), props.refresh] as const, async () => {
    const page = await todayJournal(props.notebook);
    return page ? { pageId: page.root.id, blocks: recentCaptures(page, props.notebook.todayTemplate()) } : null;
  });
  const clock = createMemo(() => new Intl.DateTimeFormat('en-GB', { timeZone: props.notebook.settings()?.time_zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  return <Show when={lines.latest?.blocks.length}><section class="create-recent" aria-label="Captured today">
    <h3>Captured today</h3>
    <ul><For each={lines.latest!.blocks}>{block => <li><button type="button" onClick={() => props.onOpen(lines.latest!.pageId, block.id)}>
      <span class="create-recent-time">{clock().format(block.created_at)}</span>
      <span class="create-recent-text"><BlockText text={block.text} notebook={props.notebook} interactive={false} /></span>
    </button></li>}</For></ul>
  </section></Show>;
}

/** A Link's page title and site once the service has read them, and whether it also goes to the Library. */
export function LinkPreview(props: { notebook: NotebookClient; url: string; library: boolean; onLibrary(value: boolean): void; onTitle(title: string | null): void }) {
  const [preview] = createResource(() => props.url, async url => {
    try { return await props.notebook.api.linkPreview(url); } catch { return null; }
  });
  const site = () => { try { return preview()?.site || new URL(props.url).hostname.replace(/^www\./, ''); } catch { return ''; } };
  createEffect(() => props.onTitle(preview.loading ? null : preview()?.title?.trim() || null));
  return <div class="create-link">
    <div class="create-link-preview" aria-busy={preview.loading}>
      <Show when={preview()?.title} fallback={<span class="create-link-title create-link-pending">{preview.loading ? 'Reading the page…' : 'No title found; the address is saved as written.'}</span>}>{title => <span class="create-link-title">{title()}</span>}</Show>
      <span class="create-link-site">{site()}</span>
    </div>
    <label class="create-link-library"><input type="checkbox" checked={props.library} onChange={event => props.onLibrary(event.currentTarget.checked)} />Also add to the Library</label>
  </div>;
}
