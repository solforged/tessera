import { opensBeside, listOpensBeside } from '../shell/beside';
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show, Switch, Match, untrack } from 'solid-js';
import { ulid } from 'ulid';
import type { IndexKind, KindIndex, NoteEntry, NoteIndex, NoteKind, NoteSummary, Operation, Query, View } from '../api/types';
import { missingFilter } from '../fields/required';
import { RequiredGaps } from '../fields/RequiredGaps';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { IndexViewState, OpenTarget } from '../shell/contract';
import { displayTitle, plainText, readableText, referenceValue } from '../outline/names';
import { titleKey } from '../document/title-key';
import { builtInTagReason, PageMergePicker } from '../outline/PageMerge';
import { documentReady } from '../outline/source-fields';
import { addFilter, copyQuery, filterLabel, missingQueryFields, noteTableQuery, queriesEqual, removeFilter, removeQueryField, retainFieldNames, typeQuery } from '../table/query';
import { MissingFields } from '../table/MissingFields';
import { FilterPopup } from '../table/FilterPopup';
import { attributeDefinitions } from '../table/attributes';
import { NoteFind } from './NoteFind';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import { createSettledChanges, createSlowFlag } from '../ui/loading';
import { TypeModeTabs } from '../ui/TypeModeTabs';
import { indexKindTarget, kindLabel, noteKindIcon, tagOnly } from './kinds';
import { filingGroups, filingOperations, settleFindingAid, wholeKindIndex } from './finding-aid';
import type { FindingAidSnapshot } from './finding-aid';
import { CreateSlip } from '../create/CreateSlip';
import { kindNoun } from '../create/kinds';
import './notes.css';
import { QuestionLedger } from './QuestionLedger';

interface IndexPaneProps {
  kindKey: string;
  kind: NoteKind | IndexKind | undefined;
  view: IndexViewState;
  notebook: NotebookClient; neighbour?: boolean;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: IndexViewState): void;
  onDeletePages?(pages: { id: string; title: string }[]): Promise<void>;
  onSpread?: (noteIds: string[], beside: boolean) => void;
  onNewAction?(action: { label: string; run(anchor: HTMLElement): void } | undefined): void;
}

type NotePopup = { kind: 'menu' | 'file' | 'rename' | 'merge' | 'delete'; note: NoteEntry; notes?: NoteEntry[]; anchor: HTMLElement };
interface FiledNotes { count: number; undo(): Promise<void> }
const cover = () => window.matchMedia('(max-width: 599px) and (pointer: coarse)').matches;

const tally = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const apparatus = (summary: NoteSummary | undefined) => summary ? [summary.block_count ? tally(summary.block_count, 'prose atom') : '', summary.backlinks ? tally(summary.backlinks, 'backlink') : ''].filter(Boolean).join(' · ') : '';
// The last read of each index shows at once when the pane opens again, while a fresh read replaces it.
const directoryReads = new WeakMap<NotebookClient, NoteIndex>();
const kindReads = new WeakMap<NotebookClient, Map<string, KindIndex>>();
const noteAttributes = attributeDefinitions('notes');

export function IndexPane(props: IndexPaneProps) {
  return <Switch>
    <Match when={props.kindKey === 'all'}><IndexDirectory {...props} /></Match>
    <Match when={props.kindKey === 'question'}><QuestionLedger notebook={props.notebook} onActivate={props.onActivate} onOpen={props.onOpen} newQuestion={members => <NewKindAction {...props} members={members} />} /></Match>
    <Match when={true}><KindIndexPane {...props} /></Match>
  </Switch>;
}

/** A single register lists note kinds and tag-only types in the sidebar's order. */
export function IndexDirectory(props: IndexPaneProps) {
  const changes = createSettledChanges(props.notebook);
  const cached = directoryReads.get(props.notebook);
  const [index] = createResource(changes, () => props.notebook.api.noteIndex().then(result => { directoryReads.set(props.notebook, result); return result; }), cached ? { initialValue: cached } : {});
  const slow = createSlowFlag(() => !index.latest && !index.error);
  let scroll!: HTMLDivElement;
  const onFields = (event: MouseEvent) => props.onOpen({ kind: 'fields' }, opensBeside(event));
  onMount(() => { scroll.scrollTop = props.view.scroll; });
  return <div ref={scroll} class="index-pane index-directory" role="region" tabIndex={0} aria-label="Index" aria-busy={index.loading} data-pane-pending={!index.latest && !index.error ? '' : undefined} onFocusIn={props.onActivate} onScroll={() => props.onViewChange({ scroll: scroll.scrollTop })}>
    <div class="index-sheet">
      <p class="index-eyebrow">Index</p>
      <div class="index-head"><h1>Index</h1><Show when={index.latest}>{list => <span class="index-tally">{tally(list().notes, 'atom')} · {tally(list().kinds.length, 'type')}</span>}</Show></div>
      <Show when={index.error}><p class="error" role="alert">Couldn’t load the index · {String(index.error)}</p></Show>
      <Show when={index.latest} fallback={<Show when={slow()}><p class="empty-state" role="status">Loading types…</p></Show>}>{list =>
        <Show when={list().kinds.length} fallback={<p class="empty-state">No types yet.</p>}>
          <div class="index-directory-list"><For each={['notes', 'sources', 'work', 'tags', 'loose'] as const}>{shelf => <><For each={list().kinds.filter(kind => kind.shelf === shelf)}>{kind =>
            <div class="index-directory-row">
              <Icon name={noteKindIcon(kind)} />
              <Button class="index-directory-name" onClick={event => props.onOpen(indexKindTarget(kind), opensBeside(event))}>{kindLabel(kind)}</Button>
              <span class="index-directory-count">{tagOnly(kind) ? `${kind.tagged_block_count.toLocaleString()} tagged` : tally(kind.count, ['task', 'question', 'source', 'project'].includes(kind.key) ? kind.key : 'atom')}</span>
              <Button class="index-directory-open" label={`Open ${kindLabel(kind)} ${tagOnly(kind) ? 'table' : 'list'}`} onClick={event => props.onOpen(indexKindTarget(kind), opensBeside(event))}>Open {tagOnly(kind) ? 'table' : 'list'}<Icon name="right" /></Button>
            </div>
          }</For><Show when={shelf === 'notes'}>
            <div class="index-directory-row">
              <Icon name="field" />
              <Button class="index-directory-name" onClick={onFields}>Fields</Button>
              <span class="index-directory-count">{tally(list().fields, 'field')}</span>
              <Button class="index-directory-open" label="Open Fields register" onClick={onFields}>Open register<Icon name="right" /></Button>
            </div>
          </Show></>}</For><For each={list().spreads}>{spread =>
            <div class="index-directory-row">
              <Icon name="panes" />
              <Button class="index-directory-name" onClick={event => props.onOpen({ kind: 'page', pageId: spread.id }, opensBeside(event))}>{spread.title}</Button>
              <span class="index-directory-count">Spread</span>
              <Button class="index-directory-open" onClick={event => props.onOpen({ kind: 'page', pageId: spread.id }, opensBeside(event))}>Open spread<Icon name="right" /></Button>
            </div>
          }</For></div>
        </Show>
      }</Show>
    </div>
  </div>;
}

/** Finding aids share one batched read; Unfiled is a queue, Sources a bibliography. */
function KindIndexPane(props: IndexPaneProps) {
  const changes = createSettledChanges(props.notebook);
  // Filing and merging refresh at once rather than after the settle delay.
  const [version, setVersion] = createSignal(0);
  const [letter, setLetter] = createSignal('');
  const [filter, setFilter] = createSignal<'all' | 'text' | 'blank'>('all');
  const [selected, setSelected] = createSignal<string>();
  const [filingSelection, setFilingSelection] = createSignal<ReadonlySet<string>>(new Set());
  let selectionAnchor: string | undefined;
  const [filed, setFiled] = createSignal<FiledNotes>();
  const [focusAfterFiling, setFocusAfterFiling] = createSignal<string>();
  const [popup, setPopup] = createSignal<NotePopup>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  createEffect(() => { props.kindKey; setFilter('all'); setSelected(undefined); setLetter(''); setPopup(undefined); setFilingSelection(new Set<string>()); selectionAnchor = undefined; setFiled(undefined); });
  const reads = kindReads.get(props.notebook) ?? new Map<string, KindIndex>();
  kindReads.set(props.notebook, reads);
  const cached = reads.get(props.kindKey);
  const [index] = createResource(() => [props.kindKey, changes(), version()] as const, ([key]) => props.notebook.api.kindNotes(key).then(result => { reads.set(key, result); return result; }), cached ? { initialValue: cached } : {});
  const typeId = () => props.kind?.type_id ?? (props.kindKey.startsWith('type:') ? props.kindKey.slice(5) : undefined);
  const [type] = createResource(() => typeId() ? [typeId()!, changes(), version()] as const : false, ([id]) => props.notebook.api.type(id));
  const isCollection = createMemo(() => titleKey(props.kind?.name ?? type()?.page.text ?? '') === 'collection');
  // The bibliography uses the same current-snapshot predicate as Library source menus.
  const [readableSources] = createResource(() => props.kindKey === 'source' ? [changes(), version()] as const : false, async () => {
    const result = await props.notebook.api.library({ limit: null });
    return new Set(result.rows.filter(row => row.source.current_snapshot_id).map(row => row.page.id));
  });
  const [collectionCounts] = createResource(() => isCollection() && index.latest ? [index.latest.notes, changes(), version()] as const : false, async ([notes]) =>
    new Map(await Promise.all(notes.map(async note => {
      const result = await props.notebook.api.library({ collection_id: note.id, limit: 0 });
      return [note.id, result.total] as const;
    }))));
  const [query, setQuery] = createSignal<Query>(copyQuery(props.view.noteQuery ?? { ...typeQuery(typeId() ?? null), note_kind: props.kindKey, note_view: { layout: 'index', grouping: 'letter' } }));
  const [groupMenu, setGroupMenu] = createSignal<HTMLElement>();
  const [filterMenu, setFilterMenu] = createSignal<HTMLElement>();
  const [saveAnchor, setSaveAnchor] = createSignal<HTMLElement>();
  const [optionsAnchor, setOptionsAnchor] = createSignal<HTMLElement>();
  const [selecting, setSelecting] = createSignal(false);
  const [viewName, setViewName] = createSignal('');
  const [picked, setPicked] = createSignal<string[]>([]);
  let pickAnchor: string | undefined;
  const noteMode = () => props.kindKey !== 'unfiled';
  const grouping = () => query().note_view?.grouping ?? 'letter';
  const wholeKind = createMemo(() => wholeKindIndex(query(), props.kindKey, typeId() ?? null));
  const report = (next = query()) => props.onViewChange({ scroll: scroll?.scrollTop ?? 0, noteQuery: copyQuery(next), viewId: props.view.viewId });
  const updateQuery = (next: Query) => { const value = copyQuery(retainFieldNames(next)); setQuery(value); setPicked([]); report(value); };
  const [definitions] = createResource(() => noteMode() ? [changes()] : false, () => props.notebook.api.fields());
  // Notes lacking a required field: the type counts tagged blocks too, which this index does not list.
  const [incomplete] = createResource(() => type.latest?.required?.some(field => field.missing > 0) && index.latest ? [type.latest, index.latest] as const : false, async ([value, kind]) => {
    const notes = new Set(kind.notes.map(note => note.id));
    return Promise.all(value.required.filter(field => field.missing > 0).map(async required => {
      const result = await props.notebook.api.query({ type: value.page.id, text: null, filters: [missingFilter(required.field_id)], sort: [], limit: null });
      return { field_id: required.field_id, owners: new Set(result.rows.map(row => row.block.block.id).filter(id => notes.has(id))) };
    }));
  });
  const fieldName = (id: string) => definitions.latest?.fields.find(field => field.id === id)?.name;
  const needs = (note: string) => incomplete.latest?.filter(field => field.owners.has(note)).map(field => fieldName(field.field_id)).filter(Boolean).join(', ');
  const showMissing = (field: string) => updateQuery({ ...query(), filters: [...query().filters.filter(filter => !(filter.field === field && filter.op === 'empty')), missingFilter(field)] });
  const missingFields = createMemo(() => definitions() ? missingQueryFields(query(), definitions()!.fields) : []);
  const [matches] = createResource(() => noteMode() && !wholeKind() && definitions() && !definitions.loading && !missingFields().length ? [query(), changes(), version()] as const : false, async ([value]) => {
    const result = await props.notebook.api.query({ ...value, offset: 0, limit: 2000 });
    while (result.rows.length < result.total) {
      const next = await props.notebook.api.query({ ...value, offset: result.rows.length, limit: 2000 });
      if (!next.rows.length) break;
      result.rows.push(...next.rows);
    }
    return { query: value, result };
  });
  const [kindFields] = createResource(() => noteMode() && (groupMenu() || filterMenu()) ? [props.kindKey, changes()] as const : false, async ([key]) => (await props.notebook.api.query({ ...typeQuery(typeId() ?? null), note_kind: key, limit: 0 })).fields);
  const savedViewId = createMemo(() => props.view.viewId);
  const [saved, { mutate: setSaved }] = createResource(() => savedViewId() ? [savedViewId()!, changes()] as const : false, ([id]) => props.notebook.api.view(id));
  let observedSaved: View | undefined;
  createEffect(() => {
    const next = saved(); if (!next) return;
    untrack(() => {
      const previous = observedSaved?.query ?? props.view.noteQuery;
      if ((!previous || queriesEqual(query(), previous)) && !queriesEqual(query(), next.query)) updateQuery(next.query);
      observedSaved = next;
    });
  });
  const removeMissingField = async (id: string) => {
    if (busy()) return;
    setBusy(true); setError('');
    try {
      const next = removeQueryField(query(), id); const current = saved();
      if (current) {
        await props.notebook.commit([{ op: 'save_view', id: current.id, base_revision: current.revision, name: current.name, query: next }], 'Remove missing field from view');
        setSaved({ ...current, query: next, revision: current.revision + 1 });
      }
      updateQuery(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const display = createMemo<FindingAidSnapshot | undefined>(previous => settleFindingAid(previous,
    index.error ? undefined : index.latest, query(), !noteMode() || wholeKind(), matches.error ? undefined : matches.latest));
  const shown = () => display()?.index;
  const groups = () => display()?.groups ?? [];
  const displayedGrouping = () => display()?.grouping;
  const pending = () => !display() && !index.error && !definitions.error && !matches.error && !missingFields().length;
  const slow = createSlowFlag(pending);
  const toggleSelection = (id: string, extend: boolean) => {
    const order = [...new Set(groups().flatMap(group => group.entries.flatMap(entry => entry.kind === 'note' ? [entry.note.id] : [])))];
    if (extend && pickAnchor && order.includes(pickAnchor)) {
      const from = order.indexOf(pickAnchor); const to = order.indexOf(id);
      setPicked(values => [...new Set([...values, ...order.slice(Math.min(from, to), Math.max(from, to) + 1)])]);
    } else { setPicked(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id]); pickAnchor = id; }
  };
  const selectOrOpen = (note: NoteEntry, event: MouseEvent) => {
    if ((cover() && selecting()) || event.metaKey || event.ctrlKey || event.shiftKey) toggleSelection(note.id, event.shiftKey);
    else openNote(note, event);
  };
  const openTable = (event: MouseEvent) => props.onOpen({ kind: 'table', typeId: query().type, viewId: props.view.viewId ?? null, query: noteTableQuery(query()) }, opensBeside(event));
  const saveView = async () => {
    if (!viewName().trim() || busy()) return;
    setBusy(true); setError('');
    try {
      const id = ulid();
      await props.notebook.api.submit({ idempotency_key: ulid(), actor: { kind: 'client', name: 'tessera-web-index' }, operations: [{ op: 'save_view', id, base_revision: null, name: viewName().trim(), query: copyQuery(query()) }] });
      setSaveAnchor(undefined);
      props.onOpen({ kind: 'index', key: props.kindKey, viewId: id, query: copyQuery(query()) }, false);
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const title = createMemo(() => { const kind = props.kind; return kind ? 'tagged_block_count' in kind ? kindLabel(kind) : kind.plural : type()?.page.text ?? (props.kindKey === 'unfiled' ? 'Unfiled' : props.kindKey === 'source' ? 'Sources' : 'Index'); });
  const count = () => display()?.count;
  const summary = (note: NoteEntry) => shown()?.summaries[note.id];
  const lookup = (id: string) => props.notebook.lookup(id);
  const preview = (note: NoteEntry) => readableText(summary(note)?.preview ?? '', lookup);
  // A page entry is titled as its page is; a tagged block entry keeps its tags as words.
  const entryTitle = (note: NoteEntry) => note.id === note.page_id ? displayTitle(note.title, lookup) : readableText(note.title, lookup);
  // The inspector's opening prose continues from the preview rather than repeating it.
  const excerpt = (note: NoteEntry) => (summary(note)?.prose_excerpt ?? []).map(text => readableText(text, lookup)).filter(text => text.trim() && text.trim() !== preview(note).trim());
  const queue = createMemo(() => filingGroups(index.latest?.notes ?? [], index.latest?.summaries ?? {}));
  const visibleQueue = createMemo(() => queue().filter(group => filter() === 'all' || group.key === filter()).flatMap(group => group.notes));
  const selectedForFiling = createMemo(() => visibleQueue().filter(note => filingSelection().has(note.id)));
  const clearFilingSelection = () => { setFilingSelection(new Set<string>()); selectionAnchor = undefined; };
  const changeFilter = (value: 'all' | 'text' | 'blank') => { setFilter(value); setSelected(undefined); clearFilingSelection(); };
  const selectForFiling = (note: NoteEntry, range: boolean) => {
    const notes = visibleQueue();
    const start = notes.findIndex(row => row.id === selectionAnchor);
    const end = notes.findIndex(row => row.id === note.id);
    setFilingSelection(previous => {
      const next = new Set(previous);
      if (range && start >= 0) for (const row of notes.slice(Math.min(start, end), Math.max(start, end) + 1)) next.add(row.id);
      else if (next.has(note.id)) next.delete(note.id);
      else next.add(note.id);
      return next;
    });
    if (!range || start < 0) selectionAnchor = note.id;
  };
  const selectedNote = createMemo(() => index.latest?.notes.find(note => note.id === selected()) ?? queue().find(group => filter() === 'all' || group.key === filter())?.notes[0]);
  const [actionCapabilities] = createResource(() => {
    const ids = [...new Set([selectedNote()?.id, popup()?.note.id].filter((id): id is string => !!id))];
    return [ids, changes()] as const;
  }, async ([ids]) => new Map(await Promise.all(ids.map(async id => [id, await props.notebook.api.capabilities(id)] as const))));
  const actionReason = (note: NoteEntry, action: 'delete' | 'merge') => {
    const capabilities = actionCapabilities()?.get(note.id);
    return actionCapabilities.error ? String(actionCapabilities.error) : !capabilities ? 'Atom is still loading.' : builtInTagReason(note.title, capabilities, action);
  };
  const openNote = (note: NoteEntry, event: MouseEvent) => props.onOpen({ kind: 'page', pageId: note.page_id, blockId: note.id !== note.page_id ? note.id : undefined }, listOpensBeside(event, !!props.neighbour));
  const showPopup = (kind: NotePopup['kind'], note: NoteEntry, anchor: HTMLElement) => { setSelected(note.id); setError(''); setPopup({ kind, note, anchor }); };
  let scroll!: HTMLDivElement;
  createEffect(() => {
    const id = focusAfterFiling();
    if (!id || index.loading) return;
    const button = scroll?.querySelector<HTMLButtonElement>(`[data-note-id="${id}"] .index-file`);
    if (button) { button.focus(); setFocusAfterFiling(undefined); }
  });
  const didFile = (notes: NoteEntry[], change: FiledNotes) => {
    const ids = new Set(notes.map(note => note.id));
    const rows = visibleQueue();
    const at = rows.findIndex(note => ids.has(note.id));
    const next = rows.slice(at + 1).find(note => !ids.has(note.id)) ?? rows.slice(0, at).reverse().find(note => !ids.has(note.id));
    setPopup(undefined); clearFilingSelection(); setFiled(change);
    setSelected(next?.id); setVersion(value => value + 1);
    if (next) setFocusAfterFiling(next.id);
    else scroll.focus();
  };
  const undoFiling = async () => {
    const change = filed();
    if (!change || busy()) return;
    setBusy(true); setError('');
    try { await change.undo(); setFiled(undefined); setVersion(value => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  onMount(() => { if (props.view.scroll) scroll.scrollTop = props.view.scroll; });
  const jump = (value: string) => { setLetter(value); scroll.querySelector(`[data-letter="${value}"]`)?.scrollIntoView({ block: 'start' }); };
  const scrollChanged = () => {
    report();
    const top = scroll.getBoundingClientRect().top + parseFloat(getComputedStyle(scroll).getPropertyValue('--page-top-space'));
    const visible = Array.from(scroll.querySelectorAll<HTMLElement>('[data-letter]')).find(group => group.getBoundingClientRect().bottom > top);
    if (visible) setLetter(visible.dataset.letter ?? '');
  };
  const deleteNote = async (note: NoteEntry) => {
    if (!props.onDeletePages || busy()) return;
    setBusy(true); setError('');
    try { await props.onDeletePages([{ id: note.id, title: note.title }]); setPopup(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <div ref={scroll} class={`index-pane ${props.kindKey === 'unfiled' ? 'index-unfiled' : props.kindKey === 'source' ? 'index-sources' : ''}`} classList={{ 'index-selecting': selecting() }} role="region" tabIndex={0} aria-label={`${title()} list`} aria-busy={index.loading || definitions.loading || matches.loading} data-pane-pending={pending() ? '' : undefined} onFocusIn={props.onActivate} onScroll={scrollChanged}>
    <div class="index-sheet">
      <Show when={props.kindKey === 'unfiled' || props.kindKey === 'source'}><p class="index-eyebrow index-kind-eyebrow">{props.kindKey === 'unfiled' ? 'Filing queue' : 'Bibliography'}</p></Show>
      <div class="index-head"><h1><Icon name={noteKindIcon(props.kind ?? props.kindKey)} />{saved()?.name ?? title()}</h1>
        <Show when={count() != null && !missingFields().length}><span class="index-tally">{tally(count()!, ['task', 'question', 'source', 'project'].includes(props.kindKey) ? props.kindKey : 'atom')}</span></Show>
        <Show when={noteMode() && !missingFields().length}><RequiredGaps gaps={incomplete.latest?.map(field => ({ field_id: field.field_id, missing: field.owners.size }))} name={fieldName} onShow={showMissing} /></Show>
        <NewKindAction kindKey={props.kindKey} kind={props.kind} notebook={props.notebook} onOpen={props.onOpen} onNewAction={props.onNewAction} members={index.latest?.notes} visible={!!groups().length} />
      </div>
      <Show when={typeId()}>{id => <TypeModeTabs active="index" indexCount={missingFields().length ? undefined : count()} tableCount={missingFields().length ? undefined : count()} fieldsCount={type()?.fields.length}
        cardsCount={type()?.card_templates} onCards={event => props.onOpen({ kind: 'cards', typeId: id() }, opensBeside(event))}
        onIndex={() => { scroll.scrollTop = 0; }} onTable={openTable}
        onFields={event => props.onOpen({ kind: 'fields', typeId: id() }, opensBeside(event))} />}</Show>
      <Show when={noteMode()}>
        <Show when={!typeId()}><div class="type-mode-tabs mode-tabs tab-strip" role="group" aria-label="Atom view"><Button aria-pressed="true">List <span class="faint">{missingFields().length ? undefined : count()}</span></Button><Button onClick={openTable}>Table <span class="faint">{missingFields().length ? undefined : count()}</span></Button></div></Show>
        <NoteFind query={query()} plural={title()} notebook={props.notebook} onChange={updateQuery}>
          <Button class="bordered index-desktop-control" aria-haspopup="menu" onClick={event => setGroupMenu(event.currentTarget)}>Group <Icon name="down" /></Button>
          <Button class="bordered index-desktop-control" onClick={event => setFilterMenu(event.currentTarget)}>Filters</Button>
          <Button class="index-desktop-control" onClick={event => { setViewName(''); setSaveAnchor(event.currentTarget); }}>Save as view…</Button>
          <Button class="bordered index-phone-control" icon="query" label="List options" aria-haspopup="dialog" aria-expanded={!!optionsAnchor()} onClick={event => setOptionsAnchor(event.currentTarget)} />
        </NoteFind>
        <Show when={definitions() && query().filters.length}><div class="table-query-chips"><For each={query().filters}>{(filter, at) => <span class="table-chip">{filterLabel(filter, [...noteAttributes, ...definitions()?.fields ?? []], props.notebook, query().field_names)}<Button label="Remove filter" onClick={() => updateQuery(removeFilter(query(), at()))}>×</Button></span>}</For></div></Show>
        <Show when={missingFields().length}><MissingFields fields={missingFields()} busy={busy()} onRemove={id => { void removeMissingField(id); }} /><p class="faint">Results paused; remove the missing field or undo its deletion.</p></Show>
        <Show when={error() || definitions.error}><p class="error" role="alert">{error() || String(definitions.error)}</p></Show>
        <Show when={picked().length || selecting()}><div class="index-selection" role="status"><span>{picked().length} selected</span><Show when={props.onSpread}><Button disabled={picked().length < 2 || picked().length > 5} title={picked().length < 2 || picked().length > 5 ? 'Select two to five atoms' : undefined} onClick={event => props.onSpread?.(picked(), opensBeside(event))}>Spread</Button></Show><Button onClick={() => setPicked([])}>Clear</Button><Show when={selecting()}><Button onClick={() => { setSelecting(false); setPicked([]); }}>Done</Button></Show></div></Show>
        <Show when={matches.error}><p class="error" role="alert">{String(matches.error)}</p></Show>
      </Show>
      <Show when={index.error}><p class="error" role="alert">Couldn’t load this index · {String(index.error)}</p></Show>
      <Show when={readableSources.error || collectionCounts.error}><p class="error" role="alert">Couldn’t load source details · {String(readableSources.error || collectionCounts.error)}</p></Show>
      <Show when={!missingFields().length}><Show when={shown()} fallback={<Show when={slow()}><p class="empty-state" role="status">Loading atoms…</p></Show>}>
        <Switch>
          <Match when={props.kindKey === 'unfiled'}>
            <div class="index-queue-tabs mode-tabs tab-strip" data-mode-panel=".index-queue-layout" role="group" aria-label="Filing queue">
              <Button aria-pressed={filter() === 'all'} onClick={() => changeFilter('all')}>All <span class="faint">{index.latest!.notes.length}</span></Button>
              <For each={queue()}>{group => <Button aria-pressed={filter() === group.key} onClick={() => changeFilter(group.key)}>{group.label} <span class="faint">{group.notes.length}</span></Button>}</For>
            </div>
            <Show when={filed()}>{change => <div class="index-filing-status" role="status"><span>Filed {tally(change().count, 'atom')}.</span><Button disabled={busy()} onClick={() => void undoFiling()}>Undo</Button></div>}</Show>
            <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
            <Show when={index.latest!.notes.length} fallback={<p class="empty-state">No unfiled atoms.</p>}>
              <div class="index-queue-layout"><div class="index-queue-list">
                <Show when={selectedForFiling().length}><div class="index-filing-selection" role="group" aria-label="Selected atoms">
                  <span>{selectedForFiling().length} selected</span>
                  <Button class="bordered" onClick={event => { const notes = selectedForFiling(); setError(''); setPopup({ kind: 'file', note: notes[0]!, notes, anchor: event.currentTarget }); }}>File…</Button>
                  <Button onClick={clearFilingSelection}>Clear</Button>
                </div></Show>
                <For each={queue().filter(group => group.notes.length && (filter() === 'all' || group.key === filter()))}>{group => <section class="index-queue-group" aria-label={group.label}>
                  <h2>{group.label}<span class="section-rule" /><span class="faint">{group.notes.length}</span></h2>
                  <For each={group.notes}>{note => <div class="index-queue-row" data-note-id={note.id} classList={{ selected: selectedNote()?.id === note.id, 'filing-selected': filingSelection().has(note.id) }} onClick={event => {
                    if (!(event.metaKey || event.ctrlKey || event.shiftKey) || (event.target instanceof Element && event.target.closest('.index-queue-actions, .index-queue-check'))) return;
                    event.preventDefault(); selectForFiling(note, event.shiftKey);
                  }}>
                    <input class="index-queue-check" type="checkbox" aria-label={`Select ${note.title}`} checked={filingSelection().has(note.id)} onClick={event => { event.stopPropagation(); selectForFiling(note, event.shiftKey); event.currentTarget.checked = filingSelection().has(note.id); }} />
                    <button class="index-queue-note" type="button" data-open-page={note.id} data-open-label={note.title} aria-pressed={selectedNote()?.id === note.id} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey) return; setSelected(note.id); if (cover()) openNote(note, event); }}>
                      <span class="index-entry-title" title={note.title}>{note.title}</span>
                      <Show when={preview(note)} fallback={<span class="index-preview index-blank-preview">{summary(note)?.referenced_from.length ? `Referenced by ${summary(note)!.referenced_from.map(page => page.title).join(' · ')}` : 'No text yet'}</span>}><span class="index-preview">{preview(note)}</span></Show>
                      <span class="index-apparatus">{apparatus(summary(note))}</span>
                    </button>
                    <div class="index-queue-actions"><Button class="index-file bordered" onClick={event => showPopup('file', note, event.currentTarget)}>File</Button><Button class="bordered" icon="more" label={`Actions for ${note.title}`} onClick={event => showPopup('menu', note, event.currentTarget)} /></div>
                  </div>}</For>
                </section>}</For>
              </div><Show when={selectedNote()}>{note => <aside class="index-inspector" aria-label="Selected atom">
                <p class="index-eyebrow">Selected atom</p><h2>{note().title}</h2><p class="index-apparatus">{apparatus(summary(note()))}</p>
                <Show when={preview(note())}><p class="index-inspector-preview">{preview(note())}</p></Show>
                <Show when={excerpt(note()).length}><div class="index-inspector-excerpt" aria-label="Opening prose"><For each={excerpt(note())}>{text => <p>{text}</p>}</For></div></Show>
                <div class="index-inspector-actions"><Button class="bordered" onClick={event => showPopup('file', note(), event.currentTarget)}>File under a tag…</Button><Button onClick={event => openNote(note(), event)}>Open atom</Button>
                  <Button disabled={!!actionReason(note(), 'merge')} title={actionReason(note(), 'merge')} onClick={event => showPopup('merge', note(), event.currentTarget)}>Merge into…</Button><Button class="danger" disabled={!!actionReason(note(), 'delete')} title={actionReason(note(), 'delete')} onClick={event => showPopup('delete', note(), event.currentTarget)}>Delete…</Button></div>
                <Show when={summary(note())?.referenced_from.length}><div class="index-incoming"><p class="index-apparatus">Referenced from</p><For each={summary(note())?.referenced_from}>{page => <Button onClick={event => props.onOpen({ kind: 'page', pageId: page.id }, listOpensBeside(event, !!props.neighbour))}>{page.title}</Button>}</For></div></Show>
              </aside>}</Show></div>
            </Show>
          </Match>
          <Match when={props.kindKey === 'source' && displayedGrouping() === 'letter'}>
            <div class="index-source-tabs mode-tabs tab-strip" role="group" aria-label="Sources view"><Button aria-pressed="true">Bibliography <span class="faint">{index.latest!.notes.length}</span></Button><Button onClick={event => props.onOpen({ kind: 'library', tab: 'all' }, opensBeside(event))}>Open Library <Icon name="right" /></Button></div>
            <Show when={shown()?.notes.length} fallback={<div class="index-empty"><p class="index-empty-title">No sources found.</p><p class="index-empty-hint">Books and articles you add in the Library are listed here with their sigla and citation keys.</p></div>}><For each={shown()?.notes}>{note => <article class="index-source-row index-selectable" classList={{ selected: picked().includes(note.id) }}>
              <label class="index-select-target"><input type="checkbox" class="index-select" aria-label={`Select ${note.title}`} checked={picked().includes(note.id)} onClick={event => toggleSelection(note.id, event.shiftKey)} /></label>
              <span class="index-source-siglum">{summary(note)?.source?.siglum}</span><div class="index-source-main"><button type="button" class="index-source-title" onClick={event => selectOrOpen(note, event)}>{entryTitle(note)}</button>
                <Show when={summary(note)?.source}>{source => <><Show when={source().authors.length}><p class="index-source-byline"><For each={source().authors}>{(text, at) => {
                  const author = referenceValue(text);
                  return <>{at() ? ' · ' : ''}<Show when={author.id} fallback={author.name}>{id => <Button onClick={event => props.onOpen({ kind: 'page', pageId: id() }, listOpensBeside(event, !!props.neighbour))}>{plainText(text, lookup)}</Button>}</Show></>;
                }}</For></p></Show>
                  <div class="index-source-footer"><p class="index-apparatus">{[source().format.toUpperCase(), source().publisher, source().published?.match(/^\d{4}/)?.[0], source().citation_key, source().highlights ? tally(source().highlights, 'highlight') : '', summary(note)!.backlinks ? tally(summary(note)!.backlinks, 'atom backlink') : ''].filter(Boolean).join(' · ')}</p>
                    <div class="index-source-actions"><Button onClick={event => openNote(note, event)}>Open source atoms</Button><Show when={readableSources.latest?.has(note.id)}><Button onClick={event => props.onOpen({ kind: 'reader', sourceId: note.id }, listOpensBeside(event, !!props.neighbour))}>Read <Icon name="right" /></Button></Show></div>
                  </div></>}</Show>
              </div></article>}</For></Show>
          </Match>
          <Match when={true}>
            <Show when={groups().length} fallback={<Show when={index.latest?.notes.length} fallback={<EmptyKind kindKey={props.kindKey} kind={props.kind} notebook={props.notebook} onOpen={props.onOpen} />}><p class="empty-state">No atoms found.</p></Show>}>
              <Show when={displayedGrouping() === 'letter'}><nav class="index-letters mode-tabs tab-strip" aria-label="Jump to letter"><span class="index-jump-label">Jump</span><For each={groups()}>{group => <Button aria-pressed={(letter() || groups()[0]?.letter) === group.letter} onClick={() => jump(group.letter)}>{group.letter}</Button>}</For></nav></Show>
              <div class="index-columns" classList={{ 'index-by-heading': displayedGrouping() !== 'letter' }}><For each={groups()}>{group => <section class="index-group" data-letter={displayedGrouping() === 'letter' ? group.letter : undefined} aria-label={group.letter}>
                <h2><Show when={group.siglum}><span>{group.siglum}</span></Show><Show when={group.target} fallback={<span>{group.letter}</span>}>{target => <Button onClick={event => props.onOpen({ kind: 'page', pageId: target() }, listOpensBeside(event, !!props.neighbour))}>{group.letter}</Button>}</Show><span class="section-rule" /><span class="index-group-count">{group.noteCount || ''}</span></h2>
                <For each={group.entries}>{entry => entry.kind === 'note' ? <div class="index-selectable" classList={{ selected: picked().includes(entry.note.id) }}>
                  <label class="index-select-target"><input type="checkbox" class="index-select" aria-label={`Select ${entry.note.title}`} checked={picked().includes(entry.note.id)} onClick={event => toggleSelection(entry.note.id, event.shiftKey)} /></label>
                  <button type="button" class="index-entry" data-open-page={entry.note.page_id} data-open-block={entry.note.id !== entry.note.page_id ? entry.note.id : undefined} data-open-label={entry.note.title} onClick={event => selectOrOpen(entry.note, event)}>
                    <span class="index-entry-title" title={entryTitle(entry.note)}>{entryTitle(entry.note)}</span><Show when={needs(entry.note.id)}>{names => <span class="index-needs">needs {names()}</span>}</Show><Show when={preview(entry.note)}><span class="index-preview">{preview(entry.note)}</span></Show>
                    <Show when={isCollection()} fallback={<Show when={summary(entry.note)}>{value => <Show when={value().field || value().block_count || value().backlinks}><span class="index-apparatus">{[value().field ? plainText(value().field!.value, lookup) : '', value().block_count ? tally(value().block_count, 'prose atom') : value().backlinks ? tally(value().backlinks, 'backlink') : ''].filter(Boolean).join(' · ')}</span></Show>}</Show>}>
                      <Show when={collectionCounts.latest?.get(entry.note.id) != null}><span class="index-apparatus">{tally(collectionCounts.latest!.get(entry.note.id)!, 'source')}</span></Show>
                    </Show>
                  </button>
                </div> : <div class="index-entry index-cross-reference"><span class="index-alias">{entry.reference.alias}</span>{', '}<span class="index-see">see</span>{' '}<For each={entry.reference.targets}>{(target, at) => <>{at() ? '; ' : ''}<button type="button" class="index-see-target" onClick={event => props.onOpen({ kind: 'page', pageId: target.id }, listOpensBeside(event, !!props.neighbour))}>{target.title}</button></>}</For></div>}</For>
              </section>}</For></div>
            </Show>
          </Match>
        </Switch>
      </Show></Show>
    </div>
    <Show when={optionsAnchor()}>{anchor => <Popup anchor={anchor()} placement="sheet" class="index-options-sheet" label="List options" onDismiss={() => setOptionsAnchor(undefined)}>
      <h2 class="table-popup-heading">List options</h2>
      <Button aria-haspopup="menu" onClick={event => setGroupMenu(event.currentTarget)}>Group <Icon name="down" /></Button>
      <Button aria-haspopup="dialog" onClick={event => setFilterMenu(event.currentTarget)}>Filters <span class="faint">{query().filters.length || ''}</span></Button>
      <Button onClick={event => { setViewName(''); setSaveAnchor(event.currentTarget); }}>Save as view…</Button>
      <Button onClick={() => { setSelecting(true); setOptionsAnchor(undefined); }}>Select atoms</Button>
      <div class="popup-actions"><Button class="bordered" onClick={() => setOptionsAnchor(undefined)}>Done</Button></div>
    </Popup>}</Show>
    <Show when={groupMenu()}>{anchor => <Menu anchor={anchor()} label="Group" onDismiss={() => setGroupMenu(undefined)} items={[
      ...Object.entries({ letter: 'Letter', source: 'Source cited', link: 'Atom linked', created: 'Created month' }).map(([key, label]) => ({ label, checked: grouping() === key, action: () => updateQuery({ ...query(), note_view: { layout: 'index', grouping: key } }) })),
      ...(kindFields() ?? []).map(field => ({ label: field.name, checked: grouping() === `field:${field.id}`, action: () => updateQuery({ ...query(), note_view: { layout: 'index', grouping: `field:${field.id}` } }) })),
    ]} />}</Show>
    <Show when={filterMenu()}>{anchor => <FilterPopup anchor={anchor()} initialField="" fields={kindFields() ?? []} notebook={props.notebook} sheet={cover()} onDismiss={() => setFilterMenu(undefined)} onAdd={filter => { updateQuery(addFilter(query(), filter)); setFilterMenu(undefined); }} />}</Show>
    <Show when={saveAnchor()}>{anchor => <Popup anchor={anchor()} placement={cover() ? 'sheet' : 'anchor'} label="Save as view…" onDismiss={() => setSaveAnchor(undefined)}>
      <form onSubmit={event => { event.preventDefault(); void saveView(); }}><input class="input" aria-label="View name" placeholder="View name" value={viewName()} onInput={event => setViewName(event.currentTarget.value)} maxlength={120} />
        <Show when={error()}><p class="error" role="alert">{error()}</p></Show><div class="popup-actions"><Button onClick={() => setSaveAnchor(undefined)}>Cancel</Button><Button type="submit" class="bordered" disabled={busy() || !viewName().trim()}>Save</Button></div>
      </form>
    </Popup>}</Show>
    <Show keyed when={popup()}>{state => <Switch>
      <Match when={state.kind === 'menu'}><Menu anchor={state.anchor} label={`Actions for ${state.note.title}`} title="Atom actions" onDismiss={() => setPopup(undefined)} header={<div class="index-action-header"><p class="index-eyebrow">Atom actions</p><h2>{state.note.title}</h2><p class="index-apparatus">{apparatus(summary(state.note))}</p><Show when={!summary(state.note)?.text_blocks}><p class="muted">{summary(state.note)?.referenced_from.length ? `Referenced by ${summary(state.note)!.referenced_from.map(page => page.title).join(' · ')}` : 'No text yet'}</p></Show></div>} items={[
        { label: 'Open', action: () => props.onOpen({ kind: 'page', pageId: state.note.id }, window.matchMedia('(pointer: coarse) and (min-width: 900px)').matches) },
        { label: 'File under…', action: () => showPopup('file', state.note, state.anchor) },
        { label: 'Rename…', action: () => showPopup('rename', state.note, state.anchor) },
        { label: 'Delete…', danger: true, disabledReason: actionReason(state.note, 'delete'), action: () => showPopup('delete', state.note, state.anchor) },
        { label: 'More…', divider: true, submenu: () => ({ title: 'More', items: [
          { label: 'Merge into…', icon: 'merge', disabledReason: actionReason(state.note, 'merge'), action: () => showPopup('merge', state.note, state.anchor) },
          { label: 'Copy reference', icon: 'link', action: () => { void navigator.clipboard.writeText(`[[${state.note.id}]]`).catch(reason => setError(`Couldn't copy: ${String(reason)}`)); } },
        ] }) },
      ]} /></Match>
      <Match when={state.kind === 'file'}><FilingPicker notebook={props.notebook} notes={state.notes ?? [state.note]} anchor={state.anchor} onDismiss={() => setPopup(undefined)} onFiled={change => didFile(state.notes ?? [state.note], change)} /></Match>
      <Match when={state.kind === 'rename'}><RenameNote notebook={props.notebook} note={state.note} anchor={state.anchor} onDismiss={() => setPopup(undefined)} /></Match>
      <Match when={state.kind === 'merge'}><PageMergePicker notebook={props.notebook} from={{ id: state.note.id, text: state.note.title }} anchor={state.anchor} onDismiss={() => setPopup(undefined)} onMerged={() => { setPopup(undefined); setVersion(value => value + 1); }} /></Match>
      <Match when={state.kind === 'delete'}><Popup anchor={state.anchor} placement={cover() ? 'sheet' : 'anchor'} class="index-note-popup" label="Delete atom" onDismiss={() => { if (!busy()) setPopup(undefined); }}>
        <p>Delete “{state.note.title}” and all its atoms?</p><p class="muted">You can undo this deletion.</p><Show when={error()}><p class="error" role="alert">{error()}</p></Show><div class="popup-actions"><Button disabled={busy()} onClick={() => setPopup(undefined)}>Cancel</Button><Button class="danger bordered" disabled={busy() || !props.onDeletePages || !!actionReason(state.note, 'delete')} title={actionReason(state.note, 'delete')} onClick={() => void deleteNote(state.note)}>Delete atom</Button></div>
      </Popup></Match>
    </Switch>}</Show>
    <Show when={error() && !popup()}><p class="error" role="alert">{error()}</p></Show>
  </div>;
}

/** Built-in kinds that can start from their finding aid. Sources come from the Library instead. */
const startable: Record<string, 'type' | 'task' | 'question' | 'project'> = { person: 'type', group: 'type', concept: 'type', thesis: 'type', task: 'task', question: 'question', project: 'project' };

/** An empty kind says how pages arrive in it and, for built-in kinds, starts one. */
function EmptyKind(props: Pick<IndexPaneProps, 'kindKey' | 'kind' | 'notebook' | 'onOpen'>) {
  const mode = () => props.kind ? startable[props.kindKey] : undefined;
  // A type that only tags blocks has members, just none of them notes; its table lists them.
  const tagged = () => props.kind && 'tagged_block_count' in props.kind && tagOnly(props.kind) ? props.kind : undefined;
  // Built-in kinds read as common nouns; a type's own name keeps the capitals it was given.
  const plural = () => props.kind ? props.kindKey in startable || props.kindKey === 'source' ? props.kind.plural.toLocaleLowerCase() : props.kind.plural : '';
  const hint = () => {
    const name = props.kind?.name ?? '';
    switch (mode()) {
      case 'type': return `File an atom under ${name} from Unfiled, or start one here.`;
      case 'task': return 'Add task behavior to any atom with #task, or start one here.';
      case 'question': return 'Make an atom a question from its atom menu, or start one here.';
      case 'project': return 'Make an atom a project from its atom menu, or start one here.';
      default: return undefined;
    }
  };
  return <div class="index-empty">
    <Show when={tagged()} fallback={<>
      <p class="index-empty-title">{props.kind ? `No ${plural()} yet.` : 'No atoms of this tag yet.'}</p>
      <Show when={hint()}>{text => <p class="index-empty-hint">{text()}</p>}</Show>
      <NewKindAction {...props} />
    </>}>{kind => <>
      <p class="index-empty-title">No atoms filed as {kind().name}.</p>
      <p class="index-empty-hint">{kindLabel(kind())} tags {kind().tagged_block_count === 1 ? 'one atom' : `${kind().tagged_block_count.toLocaleString()} atoms`}, listed in its table.</p>
      <Button class="bordered" icon="table" onClick={event => props.onOpen(indexKindTarget(kind()), opensBeside(event))}>Open table</Button>
    </>}</Show>
  </div>;
}

function NewKindAction(props: Pick<IndexPaneProps, 'kindKey' | 'kind' | 'notebook' | 'onOpen' | 'onNewAction'> & { members?: { id: string }[]; visible?: boolean }) {
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const mode = () => props.kind ? startable[props.kindKey] ?? (props.kind.type_id ? 'type' : undefined) : undefined;
  createEffect(() => props.onNewAction?.(mode() ? { label: `New ${kindNoun(props.kind!)}`, run: setAnchor } : undefined));
  onCleanup(() => props.onNewAction?.(undefined));
  return <>
    <Show when={mode() && props.visible !== false}><Button class="bordered index-new-kind" icon="plus" aria-haspopup="dialog" onClick={event => setAnchor(event.currentTarget)}>New {kindNoun(props.kind!)}…</Button></Show>
    <Show when={anchor()}>{target => <CreateSlip request={{ kind: mode() === 'task' ? 'task' : mode() === 'question' ? 'question' : mode() === 'project' ? 'project' : `type:${props.kindKey}`, text: '', lockKind: true }} anchor={target()} notebook={props.notebook} onDismiss={() => setAnchor(undefined)} defaultBeside={window.matchMedia('(pointer: coarse)').matches && document.querySelectorAll('.panes > .pane:not(.folded)').length > 1} onOpen={props.onOpen} />}</Show>
  </>;
}


interface FilingChoice { id: string; title: string; create: boolean }
function FilingPicker(props: { notebook: NotebookClient; notes: NoteEntry[]; anchor: HTMLElement; onDismiss(): void; onFiled(change: FiledNotes): void }) {
  const [query, setQuery] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [types] = createResource(() => props.notebook.api.types());
  const noteIds = new Set(props.notes.map(note => note.id));
  const heading = () => `${props.notes.slice(0, 3).map(note => note.title).join(', ')}${props.notes.length > 3 ? ` and ${props.notes.length - 3} more` : ''}`;
  const choices = createMemo(() => {
    const text = query().trim();
    const key = titleKey(text);
    const result: FilingChoice[] = (types() ?? []).filter(type => !noteIds.has(type.page.id) && titleKey(type.page.text).includes(key)).map(type => ({ id: type.page.id, title: type.page.text, create: false }));
    if (text && !result.some(type => titleKey(type.title) === key)) {
      const existing = props.notebook.roots().find(page => page.kind === 'page' && titleKey(page.text) === key);
      if ((!existing || !noteIds.has(existing.id)) && key !== 'fields') result.push({ id: existing?.id ?? 'create', title: existing?.text ?? text, create: !existing });
    }
    return result;
  });
  const file = async (choice: FilingChoice) => {
    if (busy() || types.error) return;
    setBusy(true); setError('');
    const docs = props.notes.map(note => props.notebook.open(note.id));
    try {
      await Promise.all(docs.map(async doc => { await documentReady(doc); await doc.flush(); }));
      const pages = await Promise.all(props.notes.map(note => props.notebook.api.page(note.id)));
      const key = titleKey(choice.title);
      const targets = pages.filter(page => !page.root_manual_types?.some(title => titleKey(title) === key));
      const operations = targets.flatMap((page, index) => filingOperations(page.root.id, page.root.revision, choice.title, choice.create && index === 0 ? ulid() : undefined));
      if (!operations.length) { props.onDismiss(); return; }
      const receipt = await props.notebook.commit(operations, targets.length === 1 ? 'File atom under a tag' : 'File atoms under a tag');
      const revisions = new Map(receipt.revisions.map(block => [block.id, block.revision]));
      const inverse: Operation[] = targets.map(page => ({ op: 'remove_type', id: page.root.id, base_revision: revisions.get(page.root.id)!, title: choice.title }));
      props.onFiled({ count: targets.length, undo: async () => { await props.notebook.commit(inverse, 'Undo filing atoms'); } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { for (const doc of docs) doc.release(); setBusy(false); }
  };
  return <Picker<FilingChoice> anchor={props.anchor} placement={cover() ? 'sheet' : 'anchor'} fitContent autofocus={!cover()} class="index-note-popup index-filing-popup" style={{ '--filing-visible-rows': Math.min(3, choices().length) }} label={`File ${heading()}`} onDismiss={() => { if (!busy()) props.onDismiss(); }}
    query={query()} onQuery={setQuery} placeholder="Find or create a tag" items={choices()} key={choice => choice.id}
    onPick={choice => void file(choice)} disabledReason={() => busy() ? 'Filing…' : undefined} busy={types.loading} error={error() || (types.error ? String(types.error) : undefined)} empty="No matching tags."
    status={<div class="index-filing-head"><p class="index-eyebrow">{props.notes.length === 1 ? 'File an atom' : `File ${props.notes.length} atoms`}</p><h2>{heading()}</h2></div>}
    row={choice => <><Icon name={choice.create ? 'plus' : 'tag'} /><span class="picker-text">{choice.create ? `Create tag “${choice.title}” and file` : choice.title}</span></>} />;
}

function RenameNote(props: { notebook: NotebookClient; note: NoteEntry; anchor: HTMLElement; onDismiss(): void }) {
  const [title, setTitle] = createSignal(props.note.title);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const collision = () => props.notebook.roots().find(page => page.kind === 'page' && page.id !== props.note.id && titleKey(page.text) === titleKey(title().trim()));
  const [merge, setMerge] = createSignal(false);
  const rename = async () => {
    if (!title().trim() || busy()) return;
    setBusy(true); setError(''); const doc = props.notebook.open(props.note.id);
    try { await documentReady(doc); const result = doc.edit({ kind: 'text', id: props.note.id, text: title().trim() }); if (!result.ok) throw new Error(result.reason); await doc.flush(); props.onDismiss(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { doc.release(); setBusy(false); }
  };
  return <Show when={!merge()} fallback={<PageMergePicker notebook={props.notebook} from={{ id: props.note.id, text: props.note.title }} anchor={props.anchor} onDismiss={props.onDismiss} onMerged={props.onDismiss} />}>
    <Popup anchor={props.anchor} placement={cover() ? 'sheet' : 'anchor'} class="index-note-popup" label="Rename atom" onDismiss={() => { if (!busy()) props.onDismiss(); }}>
      <label>Title<input class="input" value={title()} disabled={busy()} onInput={event => setTitle(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.isComposing && !collision()) void rename(); }} /></label>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show><div class="popup-actions"><Button disabled={busy()} onClick={props.onDismiss}>Cancel</Button><Show when={collision()} fallback={<Button class="bordered" disabled={busy() || !title().trim()} onClick={() => void rename()}>Save title</Button>}>{page => <Button class="bordered" onClick={() => setMerge(true)}>Merge into “{page().text}”…</Button>}</Show></div>
    </Popup>
  </Show>;
}
