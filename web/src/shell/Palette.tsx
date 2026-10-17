import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import { ulid } from 'ulid';
import { highlightMatches } from '../library/query';
import { api } from '../api/client';
import type { Block, BlockInPage, Citation, HighlightRow, LibraryRow, PageView, PassageHit, PassagePage, SourceView } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import { BlockTree, type TreeRow } from '../outline/BlockTree';
import { cachedExactPage } from '../outline/completion';
import { createPageIcon } from '../outline/source';
import { Icon } from '../ui/Icon';
import { ResourceImage } from '../library/ResourceImage';
import { Picker } from '../ui/Picker';
import { Button } from '../ui/Button';
import { createVisualViewport } from '../ui/visual-viewport';
import type { Command, CommandRegistry, OpenTarget, PaneId } from './contract';
import { besideKey, opensBeside } from './beside';
import { findMatchSegments, paletteRows, type SearchEntry, type SearchHit } from './palette-rows';
import { citationRange, passageSegments } from '../reader/passages';
import { titleKey } from '../document/title-key';
import { pendingCaretInput } from './pending-caret';

type Entry = SearchEntry | { kind: 'command'; command: Command } | { kind: 'create'; title: string }
  | { kind: 'highlight'; row: HighlightRow } | { kind: 'passage'; hit: PassageHit };
type FindScope = 'Everything' | 'Highlights' | 'Books' | 'Pages';

/** Find or create pages, search blocks, or prefix commands with `>`. Tab drills into a result's children. */
export function Palette(props: { anchor: HTMLElement; pane: PaneId; mode: 'search' | 'commands'; commands: CommandRegistry; notebook: NotebookClient; onDismiss(): void; onRestoreFocus(): void; onOpen(target: OpenTarget, beside: boolean): void }) {
  const capturedCommands = props.commands.list().map(command => command.capture?.() ?? command);
  const sections = new Map<Command['section'], Command[]>();
  for (const command of capturedCommands) {
    if (command.id === 'shell.commands' || command.id.startsWith('outline.') && !command.id.startsWith(`outline.${props.pane}.`)) continue;
    const section = sections.get(command.section);
    if (section) section.push(command);
    else sections.set(command.section, [command]);
  }
  const orderedCommands = [...sections.get('Go to') ?? [], ...[...sections].filter(([section]) => section !== 'Go to').flatMap(([, commands]) => commands)];
  const [query, setQuery] = createSignal(props.mode === 'commands' ? '>' : '');
  const [debounced, setDebounced] = createSignal('');
  const [scopes, setScopes] = createSignal<(BlockInPage & { matching?: boolean })[]>([]);
  const [creating, setCreating] = createSignal(false);
  const [createError, setCreateError] = createSignal('');
  let disposed = false;
  let queryInput: HTMLInputElement | undefined;
  onCleanup(() => { disposed = true; });
  const mode = () => query().startsWith('>') ? 'commands' : 'search';
  const text = () => mode() === 'commands' ? query().slice(1).trim() : query().trim();
  const [findScope, setFindScope] = createSignal<FindScope>('Everything');
  const [selectedEntry, setSelectedEntry] = createSignal<Entry>();
  const [pendingPick, setPendingPick] = createSignal<{ query: string; scope: BlockInPage | undefined; filter: FindScope; beside: boolean }>();
  const initialRequests = new AbortController();
  onCleanup(() => initialRequests.abort());
  const [library] = createResource(async () => props.notebook.api.library({ limit: 500 }, initialRequests.signal));
  const [highlights] = createResource(async () => props.notebook.api.highlights({ limit: 500 }, initialRequests.signal));
  const books = createMemo(() => new Map((library()?.rows ?? []).map(row => [row.page.id, row])));
  const previewMedia = window.matchMedia('(min-width: 840px)');
  const [wide, setWide] = createSignal(previewMedia.matches);
  const updateWidth = () => setWide(previewMedia.matches);
  previewMedia.addEventListener('change', updateWidth);
  onCleanup(() => previewMedia.removeEventListener('change', updateWidth));
  const viewportSize = createVisualViewport();
  const [passageHits, setPassageHits] = createSignal<PassageHit[]>([]);
  const [passagesLoading, setPassagesLoading] = createSignal(false);
  const [passagesError, setPassagesError] = createSignal('');
  createEffect(() => {
    const q = text(), ready = mode() === 'search' && q === debounced() && q.length >= 3
      && (findScope() === 'Everything' || findScope() === 'Books') && !scopes().length;
    setPassageHits([]); setPassagesError(''); setPassagesLoading(ready);
    if (!ready) return;
    const controller = new AbortController();
    void props.notebook.api.searchPassages(q, undefined, 40, 0, controller.signal).then(rows => {
      if (!controller.signal.aborted) { setPassageHits(rows); setPassagesLoading(false); }
    }, reason => {
      if (!controller.signal.aborted) { setPassagesError(String(reason?.message ?? reason)); setPassagesLoading(false); }
    });
    onCleanup(() => controller.abort());
  });
  const [sources, setSources] = createSignal<Map<string, SourceView>>(new Map());
  const sourceCache = new Map<string, SourceView>();
  createEffect(() => {
    const ids = [...new Set([
      ...passageHits().map(hit => hit.source_id),
      ...(highlights()?.rows ?? []).filter(row => !!text() && highlightMatches(row, text())).map(row => row.citation.source_id),
    ])].filter(id => !sourceCache.has(id));
    if (!ids.length) return;
    const controller = new AbortController();
    void Promise.all(ids.map(async id => {
      try {
        const source = await props.notebook.api.source(id, controller.signal);
        if (!controller.signal.aborted) { sourceCache.set(id, source); setSources(new Map(sourceCache)); }
      } catch { /* The result still opens; omit unavailable chapter apparatus. */ }
    }));
    onCleanup(() => controller.abort());
  });
  const location = (sourceId: string, ordinal: number, chapter?: string | null) => {
    const source = sources().get(sourceId);
    const section = chapter ?? source?.toc.filter(entry => entry.ordinal !== null && entry.ordinal <= ordinal).at(-1)?.title;
    return [books().get(sourceId)?.source.siglum ?? source?.source.siglum, section, `¶${ordinal + 1}`].filter(Boolean).join(' · ');
  };
  createEffect(() => {
    const value = text();
    const timer = setTimeout(() => { setDebounced(value); setScopes([]); }, 100);
    onCleanup(() => clearTimeout(timer));
  });
  const [hits] = createResource(() => mode() === 'search' ? [debounced(), props.notebook.changeSequence()] as const : false, async ([q]): Promise<SearchHit[]> => {
    if (!q) return props.notebook.roots().map(root => ({ block: root, page: root }));
    const [pages, blocks] = await Promise.all([api.complete(q, 40), api.search(q)]);
    const roots = pages.filter(page => page.kind !== 'block').map(page => ({ block: page, page, alias: page.alias }));
    const ids = new Set(roots.map(hit => hit.block.id));
    return [...roots, ...blocks.filter(hit => !ids.has(hit.block.id))];
  });
  const scope = () => scopes().at(-1);
  const [scopedPage] = createResource(() => {
    const id = scope()?.matching ? undefined : scope()?.page.id;
    return id && props.notebook.lookup(id)()?.revision !== 0 ? id : undefined;
  }, id => api.page(id));
  const commands = createMemo(() => {
    const search = text().toLocaleLowerCase();
    return orderedCommands.filter(command => (search || command.section !== 'Page' || !command.disabledReason?.())
      && `${command.title} ${command.section}`.toLocaleLowerCase().includes(search));
  });
  const entries = createMemo((): Entry[] => {
    if (mode() === 'commands') return commands().map(command => ({ kind: 'command', command }));
    if (text() !== debounced() || hits.loading) return [];
    const parent = scope();
    if (parent?.matching) return paletteRows(hits.error ? [] : hits() ?? [], text(), parent.page.id);
    const rows = !parent ? (hits.error ? [] : hits() ?? [])
      : scopedPage.error ? []
        : (scopedPage()?.rows ?? []).filter(row => row.block.parent_id === parent.block.id).map(row => ({ block: row.block, page: parent.page }));
    const title = text();
    const exact = !parent && title ? cachedExactPage(props.notebook, title)
      ?? rows.find(hit => hit.block.kind === 'page' && titleKey(hit.block.text) === titleKey(title))?.block : null;
    const result: Entry[] = [];
    if (!parent && (findScope() === 'Everything' || findScope() === 'Highlights') && title) {
      result.push(...(highlights()?.rows ?? []).filter(row => highlightMatches(row, title)).map((row): Entry => ({ kind: 'highlight', row })));
    }
    const shownHighlightBlocks = new Set(result.filter((entry): entry is Extract<Entry, { kind: 'highlight' }> => entry.kind === 'highlight').map(entry => entry.row.block.block.id));
    const allowed = (hit: BlockInPage) => parent || findScope() === 'Everything'
      || findScope() === 'Books' && books().has(hit.page.id)
      || findScope() === 'Pages' && !books().has(hit.page.id);
    if (exact && allowed({ block: exact, page: exact })) result.push({ kind: 'hit', hit: { block: exact, page: exact } });
    const remaining = rows.filter(hit => hit.block.id !== exact?.id && !shownHighlightBlocks.has(hit.block.id) && allowed(hit));
    result.push(...(parent ? remaining.map((hit): Entry => ({ kind: 'hit', hit })) : paletteRows(remaining, title)));
    if (!parent && (findScope() === 'Everything' || findScope() === 'Books')) {
      const shown = new Set(result.filter((entry): entry is Extract<Entry, { kind: 'hit' }> => entry.kind === 'hit' && entry.hit.block.id === entry.hit.page.id).map(entry => entry.hit.page.id));
      for (const hit of passageHits()) {
        const book = books().get(hit.source_id);
        if (book && !shown.has(hit.source_id)) {
          result.push({ kind: 'hit', hit: { block: book.page, page: book.page } });
          shown.add(hit.source_id);
        }
      }
    }
    if (!parent && title && !exact && (findScope() === 'Everything' || findScope() === 'Pages')) result.push({ kind: 'create', title });
    if (!parent) result.push(...passageHits().map((hit): Entry => ({ kind: 'passage', hit })));
    return result;
  });
  const drill = async (hit: BlockInPage): Promise<boolean> => {
    if (props.notebook.lookup(hit.page.id)()?.revision === 0) return false;
    const page = await api.page(hit.page.id);
    if (!page.rows.some(row => row.block.parent_id === hit.block.id)) return false;
    setScopes(previous => [...previous, hit]);
    return true;
  };
  const up = () => setScopes(previous => previous.slice(0, -1));
  const more = (page: Block) => setScopes(previous => [...previous, { block: page, page, matching: true }]);
  const open = (hit: BlockInPage, beside: boolean) => {
    props.onDismiss(); props.onOpen({ kind: 'page', pageId: hit.page.id, ...(hit.block.id !== hit.page.id ? { blockId: hit.block.id } : {}) }, beside);
  };
  const openBook = (entry: Extract<Entry, { kind: 'passage' | 'highlight' }>, beside: boolean) => {
    const target: OpenTarget = entry.kind === 'passage'
      ? { kind: 'reader', sourceId: entry.hit.source_id, snapshotId: entry.hit.snapshot_id, at: entry.hit.passage.id }
      : { kind: 'reader', sourceId: entry.row.citation.source_id, snapshotId: entry.row.citation.snapshot_id, at: entry.row.citation.start.passage_id, citationId: entry.row.citation.id };
    props.onDismiss(); props.onOpen(target, beside);
  };
  const run = (command: Command, beside: boolean) => {
    if (command.disabledReason?.()) return;
    props.onDismiss(); command.run(beside);
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) props.onRestoreFocus();
    });
  };
  const create = async (title: string, beside: boolean) => {
    if (creating()) return;
    setCreating(true); setCreateError('');
    queryInput?.blur();
    const pending = pendingCaretInput.prepare();
    try {
      const pageId = ulid(), caretId = ulid();
      await props.notebook.commit([
        { op: 'create_page', id: pageId, title },
        { op: 'insert', id: caretId, parent_id: pageId, after: null, text: '', heading: null },
      ], 'Create page');
      if (disposed) { pending(); return; }
      props.onDismiss(); props.onOpen({ kind: 'page', pageId, caretId }, beside);
    } catch (reason) {
      pending();
      if (!disposed) setCreateError(reason instanceof Error ? reason.message : String(reason));
    } finally { setCreating(false); }
  };
  const busy = () => mode() === 'search' && (text() !== debounced() || hits.loading || scopedPage.loading || passagesLoading() || highlights.loading || library.loading);
  const error = () => {
    if (createError()) return createError();
    const reason = mode() === 'search' ? hits.error ?? scopedPage.error ?? highlights.error ?? library.error : undefined;
    return reason ? `Couldn't search · ${String(reason?.message ?? reason)}` : passagesError() ? `Couldn't search book text · ${passagesError()}` : undefined;
  };
  const pick = (entry: Entry, beside: boolean) => {
    setPendingPick(undefined);
    if (entry.kind === 'hit') open(entry.hit, beside);
    else if (entry.kind === 'highlight' || entry.kind === 'passage') openBook(entry, beside);
    else if (entry.kind === 'more') more(entry.page);
    else if (entry.kind === 'command') run(entry.command, beside);
    else void create(entry.title, beside);
  };
  createEffect(() => {
    const pending = pendingPick();
    if (!pending) return;
    if (pending.query !== query() || pending.scope !== scope() || pending.filter !== findScope()) {
      setPendingPick(undefined);
      return;
    }
    if (busy()) return;
    setPendingPick(undefined);
    const entry = entries()[0];
    if (!error() && entry) pick(entry, pending.beside);
  });
  const pageGroupLabel = createMemo(() => {
    const pageResults = entries().filter(entry => entry.kind === 'hit' || entry.kind === 'more');
    return pageResults.length && pageResults.every(entry => entry.kind === 'hit' && entry.hit.block.id === entry.hit.page.id && books().has(entry.hit.page.id)) ? 'Books' : 'Pages and notes';
  });
  const group = (entry: Entry) => entry.kind === 'highlight' ? 'Highlights' : entry.kind === 'passage' ? 'In your books' : entry.kind === 'create' ? undefined : pageGroupLabel();
  const groupCounts = createMemo(() => {
    const counts: Record<string, number> = {};
    for (const entry of entries()) {
      const label = group(entry);
      if (label) counts[label] = (counts[label] ?? 0) + 1;
    }
    return counts;
  });
  const sectionsWithCounts = (entry: Entry) => {
    if (entry.kind === 'command') return entry.command.section;
    const label = group(entry);
    return label ? `${label} · ${groupCounts()[label]}${entry.kind === 'passage' ? ' passages' : ''}` : undefined;
  };
  return <Picker<Entry> anchor={props.anchor} placement="top" width={mode() === 'search' ? 1060 : 560} label={mode() === 'search' ? 'Find or create' : 'Find command'} class={`palette ${mode() === 'search' ? 'palette-search' : ''}`} onDismiss={props.onDismiss}
    style={{ '--visual-viewport-height': `${viewportSize().height}px`, '--visual-viewport-top': `${viewportSize().top}px` }}
    query={query()} onQuery={value => { setCreateError(''); setQuery(value); }} placeholder={mode() === 'search' ? 'Find or create a page' : 'Find a command'}
    inputRef={input => { queryInput = input; }}
    prefix={<Icon name={mode() === 'search' ? 'search' : 'command'} class="picker-prefix" />}
    queryActions={<Button class="find-cancel" onClick={props.onDismiss}>Cancel</Button>}
    preview={<Show when={mode() === 'search' && wide()}><FindPreview entry={selectedEntry()} query={text()} notebook={props.notebook} book={selectedEntry()?.kind === 'hit' ? books().get((selectedEntry() as Extract<Entry, { kind: 'hit' }>).hit.page.id) : undefined} /></Show>}
    onSelect={setSelectedEntry}
    status={<><Show when={mode() === 'search'}><div class="find-scopes" aria-label="Search scope"><For each={['Everything', 'Highlights', 'Books', 'Pages'] as FindScope[]}>{value => <Button aria-pressed={findScope() === value} onClick={() => { setFindScope(value); setScopes([]); queryInput?.focus({ preventScroll: true }); }}>{value}</Button>}</For></div></Show><Show when={scope()}>{parent => <div class="scope-bar"><Icon name="up" /><BlockText text={parent().block.text} notebook={props.notebook} interactive={false} /><kbd>⇧Tab</kbd></div>}</Show></>}
    items={entries()} key={entry => entry.kind === 'hit' ? entry.hit.block.id : entry.kind === 'more' ? `more:${entry.page.id}` : entry.kind === 'command' ? entry.command.id : entry.kind === 'highlight' ? entry.row.citation.id : entry.kind === 'passage' ? entry.hit.passage.id : 'create'}
    section={sectionsWithCounts}
    disabledReason={entry => creating() ? 'Creating page…' : entry.kind === 'command' ? entry.command.disabledReason?.() : undefined}
    onPick={(entry, event) => pick(entry, opensBeside(event))}
    onPendingPick={event => { if (mode() === 'search' && busy()) setPendingPick({ query: query(), scope: scope(), filter: findScope(), beside: opensBeside(event) }); }}
    onKey={(event, entry) => {
      if (event.key !== 'Tab' || mode() !== 'search' || event.ctrlKey || event.metaKey || event.altKey) return false;
      if (event.shiftKey) { if (!scopes().length) return false; up(); return true; }
      if (entry?.kind === 'hit') void drill(entry.hit);
      else if (entry?.kind === 'more') more(entry.page);
      return true;
    }}
    busy={busy()} error={error()} empty={mode() === 'search' ? 'No results.' : 'No matching commands.'}
    row={(entry, selected) => entry.kind === 'hit'
      ? <HitRow hit={entry.hit} query={text()} notebook={props.notebook} selected={selected} book={books().get(entry.hit.page.id)} />
      : entry.kind === 'more' ? <><Icon name="page" /><span class="picker-text">+{entry.count} more in {entry.page.text}</span></>
      : entry.kind === 'highlight' ? <><span class={`find-color highlight-color-${entry.row.color ?? 'none'}`} style={{ background: entry.row.color ? `var(--highlight-${entry.row.color})` : 'transparent', 'box-shadow': entry.row.color ? undefined : 'inset 0 0 0 1px var(--faint)' }} /><span class="find-result"><span class="find-quote"><MatchText text={entry.row.citation.quote} query={text()} /></span><small>Highlight · {location(entry.row.citation.source_id, entry.row.citation.ordinal, entry.row.citation.chapter_title)}</small></span></>
      : entry.kind === 'passage' ? <><span class="find-paragraph" aria-hidden="true">¶</span><span class="find-result"><span class="find-quote"><For each={entry.hit.snippet_parts}>{part => <Show when={part.match} fallback={part.text}><mark>{part.text}</mark></Show>}</For></span><small>{location(entry.hit.source_id, entry.hit.passage.ordinal)}</small></span></>
      : entry.kind === 'command' ? <CommandRow command={entry.command} selected={selected} />
        : <><Icon name="plus" /><span class="picker-text">Create page “{entry.title}”</span><Show when={selected}><kbd class="picker-hint">{besideKey}↵ beside</kbd></Show></>} />;
}

function HitRow(props: { hit: SearchHit; query: string; notebook: NotebookClient; selected: boolean; book?: LibraryRow }) {
  const isPage = () => props.hit.block.id === props.hit.page.id;
  const icon = createPageIcon(props.notebook, () => props.hit.block);
  return <>
    <Icon name={icon()} />
    <span class="picker-text find-result"><span classList={{ 'find-snippet': !isPage() }}><BlockText text={props.notebook.lookup(props.hit.block.id)()?.text ?? props.hit.block.text} notebook={props.notebook} interactive={false} highlight={props.query} /></span><Show when={!isPage()}><small>{props.notebook.lookup(props.hit.page.id)()?.text ?? props.hit.page.text}</small></Show><Show when={isPage() && props.book}>{book => <small>Book · {Math.round(book().progress * 100)}% · {book().highlights} highlights</small>}</Show></span>
    <Show when={isPage() && props.hit.alias}>{alias => <span class="reference-via">via {alias()}</span>}</Show>
    <Show when={props.selected}><kbd class="picker-hint">{besideKey}↵ beside</kbd></Show>
  </>;
}

function CommandRow(props: { command: Command; selected: boolean }) {
  return <>
    <span class="picker-text">{props.command.title}<Show when={props.command.disabledReason?.() || props.command.description}>{text => <small class="picker-disabled-reason">{text()}</small>}</Show></span>
    <Show when={props.command.keys?.length}><kbd>{props.command.keys!.join(' / ')}</kbd></Show>
  </>;
}

/** Ordinary passages mark each typed search term. */
function MatchText(props: { text: string; query: string }) {
  const segments = createMemo(() => findMatchSegments(props.text, props.query));
  return <For each={segments()}>{segment => <Show when={segment.match} fallback={segment.text}><mark>{segment.text}</mark></Show>}</For>;
}

function FindPreview(props: { entry?: Entry; query: string; notebook: NotebookClient; book?: LibraryRow }) {
  const [content, setContent] = createSignal<{
    title: string; location?: string; cover?: { snapshotId: string; href: string }; lines?: string[];
    page?: PageView; targetId?: string; passages?: PassagePage; citation?: Citation;
  }>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  let body: HTMLDivElement | undefined;
  const previewBlocks = createMemo(() => new Map(content()?.page?.rows.map(row => [row.block.id, row.block]) ?? []));
  const outlineRows = createMemo<TreeRow[]>(() => {
    const value = content();
    if (!value?.page || !value.targetId) return [];
    const ancestors = new Set<string>();
    let parent = previewBlocks().get(value.targetId)?.parent_id;
    while (parent && parent !== value.page.root.id && !ancestors.has(parent)) {
      ancestors.add(parent);
      parent = previewBlocks().get(parent)?.parent_id;
    }
    return value.page.rows.map(row => ({
      id: row.block.id, depth: row.depth,
      role: row.block.id === value.targetId ? 'focus' : ancestors.has(row.block.id) ? 'context' : 'body',
    }));
  });
  createEffect(() => {
    if (!content()?.targetId) return;
    const frame = requestAnimationFrame(() => {
      const target = body?.querySelector<HTMLElement>('.block-tree-row.focus');
      if (!body || !target) return;
      const rect = target.getBoundingClientRect();
      body.scrollTop += rect.top - body.getBoundingClientRect().top - Math.max(0, (body.clientHeight - rect.height) / 2);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  createEffect(() => {
    const entry = props.entry;
    setContent(undefined); setError(''); setLoading(false);
    if (!entry || entry.kind === 'command' || entry.kind === 'create') return;
    if (entry.kind === 'hit' || entry.kind === 'more') {
      const id = entry.kind === 'hit' ? entry.hit.page.id : entry.page.id;
      // Optimistic roots can enter the results while the create picker closes.
      // Track their acknowledgement before asking the service for a preview.
      if (props.notebook.lookup(id)()?.revision === 0) { setLoading(true); return; }
    }
    const controller = new AbortController();
    setLoading(true);
    const load = async () => {
      if (entry.kind === 'hit' || entry.kind === 'more') {
        const page = await props.notebook.api.page(entry.kind === 'hit' ? entry.hit.page.id : entry.page.id, controller.signal);
        const targetId = entry.kind === 'hit' && entry.hit.block.id !== page.root.id ? entry.hit.block.id : undefined;
        return {
          title: page.root.text, cover: props.book?.cover ? { snapshotId: props.book.source.current_snapshot_id ?? '', href: props.book.cover } : undefined,
          ...(targetId ? { page, targetId } : { lines: page.rows.slice(0, 8).map(row => row.block.text) }),
        };
      }
      const sourceId = entry.kind === 'passage' ? entry.hit.source_id : entry.row.citation.source_id;
      const snapshotId = entry.kind === 'passage' ? entry.hit.snapshot_id : entry.row.citation.snapshot_id;
      const ordinal = entry.kind === 'passage' ? entry.hit.passage.ordinal : entry.row.citation.ordinal;
      const citation = entry.kind === 'highlight' ? entry.row.citation : undefined;
      const end = citation ? await props.notebook.api.locate(snapshotId, citation.end.passage_id, controller.signal) : ordinal;
      const [source, passages] = await Promise.all([
        props.notebook.api.source(sourceId, controller.signal),
        props.notebook.api.passages(snapshotId, Math.max(0, ordinal - 1), Math.max(3, (end ?? ordinal) - ordinal + 3), controller.signal),
      ]);
      const chapter = source.toc.filter(entry => entry.ordinal !== null && entry.ordinal <= ordinal).at(-1)?.title;
      return {
        title: source.page.text, location: [source.source.siglum, chapter, `¶${ordinal + 1}`].filter(Boolean).join(' · '),
        cover: (href => href ? { snapshotId, href } : undefined)(source.snapshots.find(snapshot => snapshot.id === snapshotId)?.metadata.cover),
        passages, citation,
      };
    };
    void load().then(value => {
      if (!controller.signal.aborted) { setContent(value); setLoading(false); }
    }, reason => {
      if (!controller.signal.aborted) { setError(String(reason?.message ?? reason)); setLoading(false); }
    });
    onCleanup(() => controller.abort());
  });
  return <aside class="find-preview" classList={{ 'find-preview-block': !!content()?.targetId }} aria-label="Selected result preview">
    <Show when={loading()}><p class="empty-state">Loading preview…</p></Show>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <Show when={content()}>{value => <>
      <header class="find-preview-header">{/* Covers are paths inside a book, served through its snapshot. */}<Show when={value().cover}>{cover => <ResourceImage snapshotId={cover().snapshotId} href={cover().href} alt="" />}</Show><div><h2>{value().title}</h2><Show when={value().location}><small>{value().location}</small></Show></div></header>
      <div ref={body} class="find-preview-prose">
        <Show when={value().page}>
          <BlockTree rows={outlineRows()} block={id => previewBlocks().get(id)} notebook={props.notebook} interactive={false} highlight={props.query} />
        </Show>
        <For each={value().lines}>{line => <p><BlockText text={line} notebook={props.notebook} interactive={false} highlight={props.query} /></p>}</For>
        <Show when={value().passages}>{page => {
          const ordinals = new Map(page().passages.map(passage => [passage.id, passage.ordinal]));
          const citations = value().citation ? [value().citation!] : page().citations;
          return <For each={page().passages}>{passage => {
            const ranges = citations.map(citation => citationRange(passage, citation, ordinals)).filter((range): range is NonNullable<typeof range> => range !== null);
            return <p class="find-passage"><For each={passageSegments(passage, ranges, null)}>{segment => <span classList={{ 'find-highlight': !!segment.citations.length }} style={segment.citations.length ? { background: segment.citations[0]!.color ? `color-mix(in srgb, var(--highlight-${segment.citations[0]!.color}) 24%, transparent)` : 'var(--selection)' } : undefined}><MatchText text={segment.text} query={props.query} /></span>}</For></p>;
          }}</For>;
        }}</Show>
      </div>
      <footer class="find-preview-keys"><kbd>↵ {value().passages ? 'Open in the book' : 'Open page'}</kbd><kbd>{besideKey}↵ Beside</kbd></footer>
    </>}</Show>
    <Show when={!content() && !loading() && !error()}><p class="empty-state">{props.entry?.kind === 'create' ? `Create page “${props.entry.title}”` : 'Select a result to preview it.'}</p></Show>
  </aside>;
}
