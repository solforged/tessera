import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { highlightMatches } from '../library/query';
import { api } from '../api/client';
import type { Block, BlockInPage, Citation, FieldDefinition, HighlightRow, LibraryRow, NoteKind, PageView, PassageHit, PassagePage, SourceView } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import { BlockTree, type TreeRow } from '../outline/BlockTree';
import { cachedExactPage } from '../outline/completion';
import { createPageIcon, valueLabel } from '../outline/source';
import { Icon } from '../ui/Icon';
import { ResourceImage } from '../library/ResourceImage';
import { Picker } from '../ui/Picker';
import { Button } from '../ui/Button';
import { createVisualViewport } from '../ui/visual-viewport';
import type { Command, CommandRegistry, OpenTarget, PaneId } from './contract';
import { besideKey, opensBeside } from './beside';
import { findMatchSegments, paletteRows, type SearchEntry, type SearchHit } from './palette-rows';
import { citationRange, passageSegments } from '../reader/passages';
import { contentsTitle } from '../reader/openings';
import { titleKey } from '../document/title-key';
import { pendingCaretInput } from './pending-caret';
import { inferKind, type CreateRequest } from '../create/request';
import { createPageDraft } from '../create/draft';
import type { PopupAnchor } from '../ui/Popup';
import type { CreateNotice } from '../create/CreateSlip';
import { typeSpelling } from '../outline/type-completion';
import { textTokens } from '../document/text-tokens';
import { displayTitle } from '../outline/names';
import { noteKindIcon } from '../notes/kinds';
import { fieldEntryId, matchFieldEntry, typeQuery } from '../table/query';

type CreateEntry = { kind: 'create'; action: 'source' | 'question' | 'page' | 'choose' | 'tag'; title: string; text?: string };
type Entry = SearchEntry | { kind: 'command'; command: Command } | CreateEntry
  | { kind: 'highlight'; row: HighlightRow } | { kind: 'passage'; hit: PassageHit };
type FindScope = 'Everything' | 'Highlights' | 'Books' | 'Pages';

function createLabel(entry: CreateEntry): string {
  if (entry.action === 'source') return `Add “${entry.title}” to library`;
  if (entry.action === 'tag') return `Create an atom with ${entry.title}`;
  if (entry.action === 'choose') return 'Choose a type…';
  return `Create ${entry.action} “${entry.title}”`;
}

/** Find or create pages, search blocks, or prefix commands with `>`. Tab drills into a result's children. */
export function Palette(props: { anchor: HTMLElement; pane: PaneId; mode: 'search' | 'commands'; commands: CommandRegistry; notebook: NotebookClient; noteKinds?: readonly NoteKind[]; onDismiss(): void; onRestoreFocus(): void; onOpen(target: OpenTarget, beside: boolean): void; onCreate(request: CreateRequest, anchor?: PopupAnchor): void; onNotice?(notice: CreateNotice): void }) {
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
  // The frame keeps the size it opened with, so typing or deleting `>` swaps the list without moving or resizing the panel.
  const frame: 'search' | 'commands' = props.mode;
  const text = () => mode() === 'commands' ? query().slice(1).trim() : query().trim();
  const [findScope, setFindScope] = createSignal<FindScope>('Everything');
  const [selectedEntry, setSelectedEntry] = createSignal<Entry>();
  const [pendingPick, setPendingPick] = createSignal<{ query: string; scope: BlockInPage | undefined; filter: FindScope; beside: boolean; shift: boolean }>();
  const initialRequests = new AbortController();
  onCleanup(() => initialRequests.abort());
  const live = createMemo(() => props.notebook.connection() === 'live');
  const [library] = createResource(() => mode() === 'search' && live(), () => props.notebook.api.library({ limit: 500 }, initialRequests.signal));
  const [highlights] = createResource(() => mode() === 'search' && live(), () => props.notebook.api.highlights({ limit: 500 }, initialRequests.signal));
  const books = createMemo(() => new Map((library.error ? [] : library()?.rows ?? []).map(row => [row.page.id, row])));
  const [fields] = createResource(() => mode() === 'search' && live() ? props.notebook.changeSequence() : false, () => props.notebook.api.fields(initialRequests.signal));
  // One registry projection supplies every result's identity, rather than a kinds request per row.
  const [identities] = createResource(() => mode() === 'search' && live() ? props.notebook.changeSequence() : false, () => props.notebook.api.query({ ...typeQuery(null), source: 'notes', columns: [{ key: '@kind' }] }, initialRequests.signal));
  const pageKinds = createMemo(() => new Map((identities.error ? [] : identities()?.rows ?? []).map(row => [row.block.page.id, row.attributes?.['@kind']?.map(value => value.text) ?? []])));
  const kindsByKey = createMemo(() => new Map((props.noteKinds ?? []).map(kind => [kind.key, kind])));
  const definitions = createMemo(() => new Set([
    ...(props.noteKinds ?? []).flatMap(kind => kind.type_id ? [kind.type_id] : []),
    ...(!fields.error && fields() ? [fields()!.page_id, ...fields()!.fields.map(field => field.id)] : []),
  ]));
  const isDefinition = (entry: Entry) => entry.kind === 'hit' && definitions().has(entry.hit.page.id) || entry.kind === 'more' && definitions().has(entry.page.id);
  const resultKind = (pageId: string) => {
    const definition = props.noteKinds?.find(kind => kind.type_id === pageId);
    if (definition) return definition;
    for (const key of pageKinds().get(pageId) ?? []) {
      const kind = kindsByKey().get(key);
      if (kind && kind.key !== 'unfiled') return kind;
    }
  };
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
    const q = text(), ready = mode() === 'search' && live() && q === debounced() && q.length >= 3
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
      ...(highlights.error ? [] : highlights()?.rows ?? []).filter(row => !!text() && highlightMatches(row, text())).map(row => row.citation.source_id),
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
    return [books().get(sourceId)?.source.siglum ?? source?.source.siglum, section ? contentsTitle(section) : null, `¶${ordinal + 1}`].filter(Boolean).join(' · ');
  };
  createEffect(() => {
    const value = text();
    const timer = setTimeout(() => { setDebounced(value); setScopes([]); }, 100);
    onCleanup(() => clearTimeout(timer));
  });
  const [hits] = createResource(() => mode() === 'search' ? [debounced(), props.notebook.changeSequence(), live()] as const : false, async ([q]): Promise<SearchHit[]> => {
    if (!q) return props.notebook.roots().map(root => ({ block: root, page: root }));
    const [pages, blocks] = await Promise.all([api.complete(q, 40), api.search(q)]);
    const roots = pages.filter(page => page.kind !== 'block').map(page => ({ block: page, page, alias: page.alias }));
    const ids = new Set(roots.map(hit => hit.block.id));
    return [...roots, ...blocks.filter(hit => !ids.has(hit.block.id))];
  });
  const scope = () => scopes().at(-1);
  const [scopedPage] = createResource(() => {
    const id = scope()?.matching ? undefined : scope()?.page.id;
    return live() && id && props.notebook.lookup(id)()?.revision !== 0 ? id : undefined;
  }, id => api.page(id));
  const commands = createMemo(() => {
    if (mode() !== 'commands') return [];
    const search = text().toLocaleLowerCase();
    return orderedCommands.filter(command => (search || command.section !== 'Page' || !command.disabledReason?.())
      && [command.title, command.section === 'Page' ? 'This atom' : command.section, ...command.keywords ?? []].some(value => value.toLocaleLowerCase().includes(search)));
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
      result.push(...(highlights.error ? [] : highlights()?.rows ?? []).filter(row => highlightMatches(row, title)).map((row): Entry => ({ kind: 'highlight', row })));
    }
    const shownHighlightBlocks = new Set(result.filter((entry): entry is Extract<Entry, { kind: 'highlight' }> => entry.kind === 'highlight').map(entry => entry.row.block.block.id));
    const allowed = (hit: BlockInPage) => parent || findScope() === 'Everything'
      || findScope() === 'Books' && books().has(hit.page.id)
      || findScope() === 'Pages' && !books().has(hit.page.id);
    if (exact && allowed({ block: exact, page: exact })) result.push({ kind: 'hit', hit: { block: exact, page: exact } });
    const remaining = rows.filter(hit => hit.block.id !== exact?.id && !shownHighlightBlocks.has(hit.block.id) && allowed(hit));
    result.push(...(parent ? remaining.map((hit): Entry => ({ kind: 'hit', hit })) : paletteRows(remaining, title, undefined, definitions())));
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
    if (!parent) result.sort((a, b) => Number(isDefinition(a)) - Number(isDefinition(b)));
    if (!parent && title && !exact && (findScope() === 'Everything' || findScope() === 'Pages')) {
      const tag = textTokens(title);
      if (tag.length === 1 && tag[0]?.kind === 'tag') {
        const token = tag[0];
        const page = token.id ? props.notebook.lookup(token.id)() : cachedExactPage(props.notebook, token.value);
        result.push({ kind: 'create', action: 'tag', title: `#${page?.text || token.value || token.id}`, text: typeSpelling(page?.text || token.value, page?.id || token.id) });
      }
      const inferred = inferKind(title);
      if (inferred === 'source' || inferred === 'question') result.push({ kind: 'create', action: inferred, title });
      result.push({ kind: 'create', action: 'page', title }, { kind: 'create', action: 'choose', title });
    }
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
  const create = async (title: string, kind: 'note' | 'question', beside: boolean) => {
    if (creating()) return;
    setCreating(true); setCreateError('');
    queryInput?.blur();
    const pending = pendingCaretInput.prepare();
    try {
      const { pageId, caretId, caretOffset } = await createPageDraft(props.notebook, { kind, text: title });
      if (disposed) {
        // Dismissed while the service was working: the atom exists, so say so and offer it rather than leave it orphaned.
        pending();
        props.onNotice?.({ message: `Created ${kind === 'question' ? 'question' : 'atom'} “${title}”`, actions: [{ label: 'Open', run: () => props.onOpen({ kind: 'page', pageId }, false) }] });
        return;
      }
      if (!caretId) pending();
      props.onDismiss(); props.onOpen({ kind: 'page', pageId, ...(caretId ? { caretId, caretOffset } : {}) }, beside);
    } catch (reason) {
      pending();
      const message = reason instanceof Error ? reason.message : String(reason);
      if (disposed) props.onNotice?.({ message: `Couldn’t create “${title}” · ${message}` });
      else setCreateError(message);
    } finally { setCreating(false); }
  };
  const busy = () => mode() === 'search' && (text() !== debounced() || hits.loading || scopedPage.loading || passagesLoading() || highlights.loading || library.loading);
  const error = () => {
    if (createError()) return createError();
    const reason = mode() === 'search' ? hits.error ?? scopedPage.error ?? highlights.error ?? library.error ?? fields.error ?? identities.error : undefined;
    return reason ? `Couldn't search · ${String(reason?.message ?? reason)}` : passagesError() ? `Couldn't search book text · ${passagesError()}` : undefined;
  };
  const pick = (entry: Entry, beside: boolean) => {
    setPendingPick(undefined);
    if (entry.kind === 'hit') open(entry.hit, beside);
    else if (entry.kind === 'highlight' || entry.kind === 'passage') openBook(entry, beside);
    else if (entry.kind === 'more') more(entry.page);
    else if (entry.kind === 'command') run(entry.command, beside);
    else if (entry.action === 'tag') {
      props.onCreate({ kind: 'note', text: entry.text!, into: { kind: 'journal' }, lockKind: true }, queryInput?.getBoundingClientRect() ?? props.anchor.getBoundingClientRect());
    }
    else if (entry.action === 'source' || entry.action === 'choose') {
      const anchor = queryInput?.getBoundingClientRect() ?? props.anchor.getBoundingClientRect();
      props.onCreate(entry.action === 'source' ? { kind: 'source', text: entry.title }
        : { kind: inferKind(entry.title) ?? 'note', text: entry.title, into: { kind: 'page' }, focus: 'kind' }, anchor);
    } else void create(entry.title, entry.action === 'question' ? 'question' : 'note', beside);
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
    if (!error() && entry) pick(entry, pending.beside || entry.kind === 'create' && pending.shift);
  });
  const pageGroupLabel = createMemo(() => {
    const pageResults = entries().filter(entry => (entry.kind === 'hit' || entry.kind === 'more') && !isDefinition(entry));
    return pageResults.length && pageResults.every(entry => entry.kind === 'hit' && entry.hit.block.id === entry.hit.page.id && books().has(entry.hit.page.id)) ? 'Books' : 'Atoms';
  });
  const noMatches = createMemo(() => !entries().some(entry => entry.kind !== 'create'));
  const group = (entry: Entry) => {
    if (entry.kind === 'highlight') return 'Highlights';
    if (entry.kind === 'passage') return 'In your books';
    if (entry.kind === 'create') return !busy() && !error() && noMatches() ? 'No matching atoms' : undefined;
    return isDefinition(entry) ? 'Definitions' : pageGroupLabel();
  };
  const groupCounts = createMemo(() => {
    const counts: Record<string, number> = {};
    for (const entry of entries()) {
      const label = group(entry);
      if (label) counts[label] = (counts[label] ?? 0) + 1;
    }
    return counts;
  });
  const sectionsWithCounts = (entry: Entry) => {
    if (entry.kind === 'command') return entry.command.section === 'Page' ? 'This atom' : entry.command.section;
    const label = group(entry);
    return label === 'No matching atoms' ? label : label ? `${label} · ${groupCounts()[label]}${entry.kind === 'passage' ? ' passages' : ''}` : undefined;
  };
  return <><Portal><div class="find-backdrop" aria-hidden="true" /></Portal><Picker<Entry> anchor={props.anchor} placement="top" width={frame === 'search' ? 1060 : 560} label={mode() === 'search' ? 'Find or create' : 'Find command'} class={`palette ${frame === 'search' ? 'palette-search' : ''}`} onDismiss={props.onDismiss}
    style={{ '--visual-viewport-height': `${viewportSize().height}px`, '--visual-viewport-top': `${viewportSize().top}px` }}
    query={query()} onQuery={value => { setCreateError(''); setQuery(value); }} placeholder={mode() === 'search' ? 'Find or create an atom' : 'Find a command'}
    inputRef={input => { queryInput = input; }}
    prefix={<Icon name={mode() === 'search' ? 'search' : 'command'} class="picker-prefix" />}
    queryActions={<Button class="find-cancel" onClick={props.onDismiss}>Cancel</Button>}
    preview={<Show when={frame === 'search' && wide()}><FindPreview entry={selectedEntry()} query={text()} notebook={props.notebook} fields={fields.error ? [] : fields()?.fields ?? []} book={selectedEntry()?.kind === 'hit' ? books().get((selectedEntry() as Extract<Entry, { kind: 'hit' }>).hit.page.id) : undefined} /></Show>}
    onSelect={setSelectedEntry}
    status={<><h2 class="find-title">{mode() === 'search' ? 'Find' : 'Commands'}</h2><Show when={mode() === 'search'}><div class="find-scopes mode-tabs tab-strip" role="group" aria-label="Search scope"><For each={['Everything', 'Highlights', 'Books', 'Pages'] as FindScope[]}>{value => <Button aria-pressed={findScope() === value} onClick={() => { setFindScope(value); setScopes([]); queryInput?.focus({ preventScroll: true }); }}>{value === 'Pages' ? 'Atoms' : value}</Button>}</For></div></Show><Show when={scope()}>{parent => <div class="scope-bar"><Icon name="up" /><BlockText text={parent().block.text} notebook={props.notebook} interactive={false} /><kbd>⇧Tab</kbd></div>}</Show></>}
    items={entries()} key={entry => entry.kind === 'hit' ? entry.hit.block.id : entry.kind === 'more' ? `more:${entry.page.id}` : entry.kind === 'command' ? entry.command.id : entry.kind === 'highlight' ? entry.row.citation.id : entry.kind === 'passage' ? entry.hit.passage.id : `create:${entry.action}`}
    section={sectionsWithCounts}
    disabledReason={entry => creating() ? 'Creating atom…' : entry.kind === 'command' ? entry.command.disabledReason?.() : undefined}
    onPick={(entry, event) => pick(entry, opensBeside(event) || entry.kind === 'create' && event.shiftKey)}
    onPendingPick={event => { if (mode() === 'search' && busy()) setPendingPick({ query: query(), scope: scope(), filter: findScope(), beside: opensBeside(event), shift: event.shiftKey }); }}
    onKey={(event, entry) => {
      if (event.key !== 'Tab' || mode() !== 'search' || event.ctrlKey || event.metaKey || event.altKey) return false;
      if (event.shiftKey) { if (!scopes().length) return false; up(); return true; }
      if (entry?.kind === 'hit') void drill(entry.hit);
      else if (entry?.kind === 'more') more(entry.page);
      return true;
    }}
    busy={busy()} error={error()} empty={mode() === 'search' ? 'No matching atoms' : 'No matching commands.'}
    row={(entry, selected) => entry.kind === 'hit'
      ? <HitRow hit={entry.hit} query={text()} notebook={props.notebook} selected={selected} book={books().get(entry.hit.page.id)} noteKind={resultKind(entry.hit.page.id)} />
      : entry.kind === 'more' ? <><Icon name="page" /><span class="picker-text">+{entry.count} more in {displayTitle(entry.page.text, id => props.notebook.lookup(id))}</span></>
      : entry.kind === 'highlight' ? <><span class={`find-color highlight-color-${entry.row.color ?? 'none'}`} style={{ background: entry.row.color ? `var(--highlight-${entry.row.color})` : 'transparent', 'box-shadow': entry.row.color ? undefined : 'inset 0 0 0 1px var(--faint)' }} /><span class="find-result"><span class="find-quote"><MatchText text={entry.row.citation.quote} query={text()} /></span><small>Highlight · {location(entry.row.citation.source_id, entry.row.citation.ordinal, entry.row.citation.chapter_title)}</small></span></>
      : entry.kind === 'passage' ? <><span class="find-paragraph" aria-hidden="true">¶</span><span class="find-result"><span class="find-quote"><For each={entry.hit.snippet_parts}>{part => <Show when={part.match} fallback={part.text}><mark>{part.text}</mark></Show>}</For></span><small>{location(entry.hit.source_id, entry.hit.passage.ordinal)}</small></span></>
      : entry.kind === 'command' ? <CommandRow command={entry.command} selected={selected} />
        : <><Icon name="plus" /><span class="picker-text">{createLabel(entry)}</span><Show when={selected && (entry.action === 'page' || entry.action === 'question')}><kbd class="picker-hint picker-create-hint">⇧↵ beside</kbd></Show></>} /></>;
}

function HitRow(props: { hit: SearchHit; query: string; notebook: NotebookClient; selected: boolean; book?: LibraryRow; noteKind?: NoteKind }) {
  const isPage = () => props.hit.block.id === props.hit.page.id;
  const icon = createPageIcon(props.notebook, () => props.hit.block);
  return <>
    <Icon name={isPage() && props.noteKind ? noteKindIcon(props.noteKind) : icon()} />
    <span class="picker-text find-result"><span classList={{ 'find-snippet': !isPage() }}><BlockText text={props.notebook.lookup(props.hit.block.id)()?.text ?? props.hit.block.text} notebook={props.notebook} interactive={false} highlight={props.query} /></span><Show when={!isPage()}><small>{displayTitle(props.notebook.lookup(props.hit.page.id)()?.text ?? props.hit.page.text, id => props.notebook.lookup(id))}</small></Show><Show when={isPage() && props.book}>{book => <small>Book · {Math.round(book().progress * 100)}% · {book().highlights} highlights</small>}</Show></span>
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

function FindPreview(props: { entry?: Entry; query: string; notebook: NotebookClient; fields: readonly FieldDefinition[]; book?: LibraryRow }) {
  const [content, setContent] = createSignal<{
    title: string; location?: string; cover?: { snapshotId: string; href: string };
    page?: PageView; targetId?: string; passages?: PassagePage; citation?: Citation;
  }>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  let body: HTMLDivElement | undefined;
  const previewBlocks = createMemo(() => new Map(content()?.page?.rows.map(row => [row.block.id, row.block]) ?? []));
  const previewLines = createMemo(() => {
    const page = content()?.page;
    if (!page || content()?.targetId) return [];
    const definitions = new Map(props.fields.map(field => [field.id, field]));
    const lines: ({ kind: 'field'; name: string; values: string[] } | { kind: 'prose'; text: string })[] = [];
    for (let index = 0; index < page.rows.length && lines.length < 8; index++) {
      const row = page.rows[index]!;
      if (row.block.archived) continue;
      const definition = definitions.get(fieldEntryId(row.block.text) ?? '');
      const inline = definition ? null : matchFieldEntry(row.block.text);
      if (!definition && !inline) { lines.push({ kind: 'prose', text: row.block.text }); continue; }
      const values = inline?.value ? [valueLabel(inline.value, id => props.notebook.lookup(id))] : [];
      while (index + 1 < page.rows.length && page.rows[index + 1]!.depth > row.depth) {
        const value = page.rows[++index]!;
        if (!value.block.archived && value.block.text.trim()) values.push(valueLabel(value.block.text, id => props.notebook.lookup(id)));
      }
      const name = definition ? definition.built_in ? definition.name.toLowerCase() : definition.name : inline!.name;
      lines.push({ kind: 'field', name, values });
    }
    return lines;
  });
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
    setError(''); setLoading(false);
    // The last preview stays up while the next loads; only an entry with nothing to preview clears it.
    if (!entry || entry.kind === 'command' || entry.kind === 'create') { setContent(undefined); return; }
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
          title: displayTitle(page.root.text, id => props.notebook.lookup(id)), cover: props.book?.cover ? { snapshotId: props.book.source.current_snapshot_id ?? '', href: props.book.cover } : undefined,
          page, targetId,
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
        title: displayTitle(source.page.text, id => props.notebook.lookup(id)), location: [source.source.siglum, chapter ? contentsTitle(chapter) : null, `¶${ordinal + 1}`].filter(Boolean).join(' · '),
        cover: (href => href ? { snapshotId, href } : undefined)(source.snapshots.find(snapshot => snapshot.id === snapshotId)?.metadata.cover),
        passages, citation,
      };
    };
    void load().then(value => {
      if (!controller.signal.aborted) { setContent(value); setLoading(false); }
    }, reason => {
      if (!controller.signal.aborted) { setContent(undefined); setError(String(reason?.message ?? reason)); setLoading(false); }
    });
    onCleanup(() => controller.abort());
  });
  return <aside class="find-preview" classList={{ 'find-preview-block': !!content()?.targetId }} aria-label="Selected result preview" aria-busy={loading()}>
    <Show when={loading() && !content()}><p class="empty-state">Loading preview…</p></Show>
    <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
    <Show when={content()}>{value => <>
      <header class="find-preview-header">{/* Covers are paths inside a book, served through its snapshot. */}<Show when={value().cover}>{cover => <ResourceImage snapshotId={cover().snapshotId} href={cover().href} alt="" />}</Show><div><h2>{value().title}</h2><Show when={value().location}><small>{value().location}</small></Show></div></header>
      <div ref={body} class="find-preview-prose">
        <Show when={value().targetId}>
          <BlockTree rows={outlineRows()} block={id => previewBlocks().get(id)} notebook={props.notebook} interactive={false} highlight={props.query} />
        </Show>
        <For each={previewLines()}>{line => line.kind === 'field'
          ? <div class="find-preview-field"><span class="find-preview-field-name">{line.name}</span><span><For each={line.values}>{(value, index) => <>{index() > 0 ? ' · ' : ''}<MatchText text={value} query={props.query} /></>}</For></span></div>
          : <p><BlockText text={line.text} notebook={props.notebook} interactive={false} highlight={props.query} /></p>}</For>
        <Show when={value().passages}>{page => {
          const ordinals = new Map(page().passages.map(passage => [passage.id, passage.ordinal]));
          const citations = value().citation ? [value().citation!] : page().citations;
          return <For each={page().passages}>{passage => {
            const ranges = citations.map(citation => citationRange(passage, citation, ordinals)).filter((range): range is NonNullable<typeof range> => range !== null);
            return <p class="find-passage"><For each={passageSegments(passage, ranges, null)}>{segment => <span classList={{ 'find-highlight': !!segment.citations.length }} style={segment.citations.length ? { background: segment.citations[0]!.color ? `color-mix(in srgb, var(--highlight-${segment.citations[0]!.color}) 24%, transparent)` : 'var(--selection)' } : undefined}><MatchText text={segment.text} query={props.query} /></span>}</For></p>;
          }}</For>;
        }}</Show>
      </div>
      <footer class="find-preview-keys"><kbd>↵ {value().passages ? 'Open in the book' : 'Open atom'}</kbd><kbd>{besideKey}↵ Beside</kbd></footer>
    </>}</Show>
    <Show when={!content() && !loading() && !error()}>
      <Show when={props.entry?.kind === 'command' ? props.entry.command : undefined} fallback={<p class="empty-state">{props.entry?.kind === 'create' ? props.entry.action === 'choose' ? 'Choose a type for the new atom' : createLabel(props.entry) : 'Select a result to preview it.'}</p>}>{command => <>
        <header class="find-preview-header"><div><h2>{command().title}</h2><small>{command().section === 'Page' ? 'This atom' : command().section}</small></div></header>
        <Show when={command().disabledReason?.() || command().description}>{text => <div class="find-preview-prose"><p>{text()}</p></div>}</Show>
        <footer class="find-preview-keys"><Show when={!command().disabledReason?.()}><kbd>↵ Run</kbd></Show><Show when={command().keys?.length}><kbd>{command().keys!.join(' / ')}</kbd></Show></footer>
      </>}</Show>
    </Show>
  </aside>;
}
