import { createEffect, createMemo, createResource, createSignal, For, onMount, Show, Switch, Match } from 'solid-js';
import { ulid } from 'ulid';
import type { KindIndex, NoteEntry, NoteIndex, NoteKind, NoteSummary, Operation } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { IndexViewState, OpenTarget } from '../shell/contract';
import { plainText } from '../outline/BlockText';
import { PageMergePicker } from '../outline/PageMerge';
import { documentReady } from '../outline/source-fields';
import { typeQuery } from '../table/query';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import { Picker } from '../ui/Picker';
import { Popup } from '../ui/Popup';
import { createSettledChanges, createSlowFlag } from '../ui/loading';
import { TypeModeTabs } from '../ui/TypeModeTabs';
import { indexKindTarget, noteKindIcon, tagOnly } from './kinds';
import { filingGroups, filingOperations, groupKindIndex } from './finding-aid';
import './notes.css';

interface IndexPaneProps {
  kindKey: string;
  kind: NoteKind | undefined;
  view: IndexViewState;
  notebook: NotebookClient;
  onActivate(): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onViewChange(view: IndexViewState): void;
  onDeletePages?(pages: { id: string; title: string }[]): Promise<void>;
}

type NotePopup = { kind: 'menu' | 'file' | 'rename' | 'merge' | 'delete'; note: NoteEntry; anchor: HTMLElement };
const cover = () => window.matchMedia('(max-width: 599px) and (pointer: coarse)').matches;
const beside = (event: MouseEvent) => event.shiftKey || window.matchMedia('(pointer: coarse) and (min-width: 900px)').matches;
const tally = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const apparatus = (summary: NoteSummary | undefined) => summary ? `${tally(summary.block_count, 'block')} · ${tally(summary.backlinks, 'backlink')}` : '';
// The last read of each index shows at once when the pane opens again, while a fresh read replaces it.
const directoryReads = new WeakMap<NotebookClient, NoteIndex>();
const kindReads = new WeakMap<NotebookClient, Map<string, KindIndex>>();

export function IndexPane(props: IndexPaneProps) {
  return <Switch>
    <Match when={props.kindKey === 'all'}><IndexDirectory {...props} /></Match>
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
  onMount(() => { scroll.scrollTop = props.view.scroll; });
  return <div ref={scroll} class="index-pane index-directory" role="region" tabIndex={0} aria-label="Index" onFocusIn={props.onActivate} onScroll={() => props.onViewChange({ scroll: scroll.scrollTop })}>
    <div class="index-sheet">
      <p class="index-eyebrow">Index</p>
      <div class="index-head"><h1>Index</h1><Show when={index.latest}>{list => <span class="index-tally">{tally(list().kinds.length, 'kind')}</span>}</Show></div>
      <Show when={index.error}><p class="error" role="alert">Couldn’t load the index · {String(index.error)}</p></Show>
      <Show when={index.latest} fallback={<Show when={slow()}><p class="empty-state" role="status">Loading kinds…</p></Show>}>{list =>
        <Show when={list().kinds.length} fallback={<p class="empty-state">No kinds yet.</p>}>
          <div class="index-directory-list"><For each={list().kinds}>{kind =>
            <div class="index-directory-row">
              <Icon name={noteKindIcon(kind)} />
              <Button class="index-directory-name" onClick={event => props.onOpen(indexKindTarget(kind), event.shiftKey)}>{kind.plural}</Button>
              <span class="index-directory-count">{tagOnly(kind) ? `${kind.tagged_block_count.toLocaleString()} tagged` : tally(kind.count, kind.key === 'source' ? 'source' : 'note')}</span>
              <Button class="index-directory-open" label={`Open ${kind.plural} ${tagOnly(kind) ? 'table' : 'index'}`} onClick={event => props.onOpen(indexKindTarget(kind), event.shiftKey)}>Open {tagOnly(kind) ? 'table' : 'index'}<Icon name="right" /></Button>
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
  const [popup, setPopup] = createSignal<NotePopup>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  createEffect(() => { props.kindKey; setFilter('all'); setSelected(undefined); setLetter(''); setPopup(undefined); });
  const reads = kindReads.get(props.notebook) ?? new Map<string, KindIndex>();
  kindReads.set(props.notebook, reads);
  const cached = reads.get(props.kindKey);
  const [index] = createResource(() => [props.kindKey, changes(), version()] as const, ([key]) => props.notebook.api.kindNotes(key).then(result => { reads.set(key, result); return result; }), cached ? { initialValue: cached } : {});
  const slow = createSlowFlag(() => !index.latest && !index.error);
  const typeId = () => props.kind?.type_id ?? (props.kindKey.startsWith('type:') ? props.kindKey.slice(5) : undefined);
  const [type] = createResource(() => typeId() ? [typeId()!, changes(), version()] as const : false, ([id]) => props.notebook.api.type(id));
  const title = createMemo(() => props.kind?.plural ?? type()?.page.text ?? (props.kindKey === 'unfiled' ? 'Unfiled' : props.kindKey === 'source' ? 'Sources' : 'Index'));
  const groups = createMemo(() => groupKindIndex(index.latest));
  const summary = (note: NoteEntry) => index.latest?.summaries[note.id];
  const lookup = (id: string) => props.notebook.lookup(id);
  const preview = (note: NoteEntry) => plainText(summary(note)?.preview ?? '', lookup);
  const queue = createMemo(() => filingGroups(index.latest?.notes ?? [], index.latest?.summaries ?? {}));
  const selectedNote = createMemo(() => index.latest?.notes.find(note => note.id === selected()) ?? queue().find(group => filter() === 'all' || group.key === filter())?.notes[0]);
  const openNote = (note: NoteEntry, event: MouseEvent) => props.onOpen({ kind: 'page', pageId: note.id }, beside(event));
  const showPopup = (kind: NotePopup['kind'], note: NoteEntry, anchor: HTMLElement) => { setSelected(note.id); setError(''); setPopup({ kind, note, anchor }); };
  let scroll!: HTMLDivElement;
  onMount(() => { scroll.scrollTop = props.view.scroll; });
  const jump = (value: string) => { setLetter(value); scroll.querySelector(`[data-letter="${value}"]`)?.scrollIntoView({ block: 'start' }); };
  const scrollChanged = () => {
    props.onViewChange({ scroll: scroll.scrollTop });
    const top = scroll.getBoundingClientRect().top;
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

  return <div ref={scroll} class={`index-pane ${props.kindKey === 'unfiled' ? 'index-unfiled' : props.kindKey === 'source' ? 'index-sources' : ''}`} role="region" tabIndex={0} aria-label={`${title()} index`} onFocusIn={props.onActivate} onScroll={scrollChanged}>
    <div class="index-sheet">
      <p class="index-eyebrow">{props.kindKey === 'unfiled' ? 'Filing queue' : props.kindKey === 'source' ? 'Index · Bibliography' : 'Index'}</p>
      <div class="index-head"><h1><Icon name={noteKindIcon(props.kind ?? props.kindKey)} />{title()}</h1>
        <Show when={index.latest}>{list => <span class="index-tally">{tally(list().notes.length, props.kindKey === 'source' ? 'source' : 'note')}</span>}</Show>
        <Show when={groups().length}><NewKindAction kindKey={props.kindKey} kind={props.kind} notebook={props.notebook} onOpen={props.onOpen} members={index.latest?.notes} /></Show>
      </div>
      <Show when={typeId()}>{id => <TypeModeTabs active="index" indexCount={index.latest?.notes.length ?? 0} tableCount={type()?.members ?? index.latest?.notes.length ?? 0} fieldsCount={type()?.fields.length ?? 0}
        cardsCount={type()?.card_templates ?? 0} onCards={event => props.onOpen({ kind: 'cards', typeId: id() }, event.shiftKey)}
        onIndex={() => { scroll.scrollTop = 0; }} onTable={event => props.onOpen({ kind: 'table', typeId: id(), viewId: null, query: typeQuery(id()) }, event.shiftKey)}
        onFields={event => props.onOpen({ kind: 'fields', typeId: id() }, event.shiftKey)} />}</Show>
      <Show when={index.error}><p class="error" role="alert">Couldn’t load this index · {String(index.error)}</p></Show>
      <Show when={index.latest} fallback={<Show when={slow()}><p class="empty-state" role="status">Loading notes…</p></Show>}>
        <Switch>
          <Match when={props.kindKey === 'unfiled'}>
            <div class="index-queue-tabs mode-tabs tab-strip" data-mode-panel=".index-queue-layout" role="group" aria-label="Filing queue">
              <Button aria-pressed={filter() === 'all'} onClick={() => { setFilter('all'); setSelected(undefined); }}>All <span class="faint">{index.latest!.notes.length}</span></Button>
              <For each={queue()}>{group => <Button aria-pressed={filter() === group.key} onClick={() => { setFilter(group.key); setSelected(undefined); }}>{group.label} <span class="faint">{group.notes.length}</span></Button>}</For>
            </div>
            <Show when={index.latest!.notes.length} fallback={<p class="empty-state">No unfiled notes.</p>}>
              <div class="index-queue-layout"><div class="index-queue-list">
                <For each={queue().filter(group => group.notes.length && (filter() === 'all' || group.key === filter()))}>{group => <section class="index-queue-group" aria-label={group.label}>
                  <h2>{group.label}<span class="section-rule" /><span class="faint">{group.notes.length}</span></h2>
                  <For each={group.notes}>{note => <div class="index-queue-row" classList={{ selected: selectedNote()?.id === note.id }}>
                    <button class="index-queue-note" type="button" aria-pressed={selectedNote()?.id === note.id} onClick={event => { setSelected(note.id); if (cover()) openNote(note, event); }}>
                      <span class="index-entry-title">{note.title}</span>
                      <Show when={preview(note)} fallback={<span class="index-preview index-blank-preview">{summary(note)?.referenced_from.length ? `Referenced by ${summary(note)!.referenced_from.map(page => page.title).join(' · ')}` : 'No text yet'}</span>}><span class="index-preview">{preview(note)}</span></Show>
                      <span class="index-apparatus">{apparatus(summary(note))}</span>
                    </button>
                    <div class="index-queue-actions"><Button class="index-file bordered" onClick={event => showPopup('file', note, event.currentTarget)}>File</Button><Button class="bordered" icon="more" label={`Actions for ${note.title}`} onClick={event => showPopup('menu', note, event.currentTarget)} /></div>
                  </div>}</For>
                </section>}</For>
              </div><Show when={selectedNote()}>{note => <aside class="index-inspector" aria-label="Selected note">
                <p class="index-eyebrow">Selected note</p><h2>{note().title}</h2><p class="index-apparatus">{apparatus(summary(note()))}</p>
                <Show when={preview(note())}><p class="index-inspector-preview">{preview(note())}</p></Show>
                <div class="index-inspector-actions"><Button class="bordered" onClick={event => showPopup('file', note(), event.currentTarget)}>File under a type…</Button><Button onClick={event => openNote(note(), event)}>Open note</Button>
                  <Button onClick={event => showPopup('merge', note(), event.currentTarget)}>Merge into…</Button><Button class="danger" onClick={event => showPopup('delete', note(), event.currentTarget)}>Delete…</Button></div>
                <Show when={summary(note())?.referenced_from.length}><div class="index-incoming"><p class="index-apparatus">Referenced from</p><For each={summary(note())?.referenced_from}>{page => <Button onClick={event => props.onOpen({ kind: 'page', pageId: page.id }, beside(event))}>{page.title}</Button>}</For></div></Show>
              </aside>}</Show></div>
            </Show>
          </Match>
          <Match when={props.kindKey === 'source'}>
            <div class="index-source-tabs mode-tabs tab-strip" role="group" aria-label="Sources view"><Button aria-pressed="true">Bibliography <span class="faint">{index.latest!.notes.length}</span></Button><Button onClick={event => props.onOpen({ kind: 'library', tab: 'all' }, beside(event))}>Open Library <Icon name="right" /></Button></div>
            <Show when={index.latest!.notes.length} fallback={<div class="index-empty"><p class="index-empty-title">No sources yet.</p><p class="index-empty-hint">Books and articles you add in the Library are listed here with their sigla and citation keys.</p></div>}><For each={index.latest!.notes}>{note => <article class="index-source-row">
              <span class="index-source-siglum">{summary(note)?.source?.siglum}</span><div class="index-source-main"><button type="button" class="index-source-title" onClick={event => openNote(note, event)}>{note.title}</button>
                <Show when={summary(note)?.source}>{source => <><Show when={source().authors.length}><p class="index-source-byline">{source().authors.join(' · ')}</p></Show>
                  <p class="index-apparatus">{[source().format.toUpperCase(), source().publisher, source().published?.match(/^\d{4}/)?.[0]].filter(Boolean).join(' · ')}</p>
                  <Show when={source().citation_key}><p class="index-apparatus">Citation key {source().citation_key}</p></Show>
                  <p class="index-apparatus">{tally(source().highlights, 'highlight')} · {tally(summary(note)!.backlinks, 'page backlink')}</p></>}</Show>
                <div class="index-source-actions"><Button class="bordered" onClick={event => openNote(note, event)}>Open source notes</Button><Button onClick={event => props.onOpen({ kind: 'reader', sourceId: note.id }, beside(event))}>Read <Icon name="right" /></Button></div>
              </div></article>}</For></Show>
          </Match>
          <Match when={true}>
            <Show when={groups().length} fallback={<EmptyKind kindKey={props.kindKey} kind={props.kind} notebook={props.notebook} onOpen={props.onOpen} />}>
              <nav class="index-letters mode-tabs tab-strip" aria-label="Jump to letter"><span class="index-jump-label">Jump</span><For each={groups()}>{group => <Button aria-pressed={(letter() || groups()[0]?.letter) === group.letter} onClick={() => jump(group.letter)}>{group.letter}</Button>}</For></nav>
              <div class="index-columns"><For each={groups()}>{group => <section class="index-group" data-letter={group.letter} aria-label={group.letter}>
                <h2><span>{group.letter}</span><span class="section-rule" /><span class="index-group-count">{group.noteCount || ''}</span></h2>
                <For each={group.entries}>{entry => entry.kind === 'note' ? <button type="button" class="index-entry" onClick={event => openNote(entry.note, event)}>
                  <span class="index-entry-title">{entry.note.title}</span><Show when={preview(entry.note)}><span class="index-preview">{preview(entry.note)}</span></Show>
                  <Show when={summary(entry.note)}>{value => <span class="index-apparatus"><Show when={value().field}>{field => <span title={field().name}>{plainText(field().value, lookup)} · </span>}</Show>{tally(value().block_count, 'block')}</span>}</Show>
                </button> : <div class="index-entry index-cross-reference"><span class="index-alias">{entry.reference.alias}</span>{', '}<span class="index-see">see</span>{' '}<For each={entry.reference.targets}>{(target, at) => <>{at() ? '; ' : ''}<button type="button" class="index-see-target" onClick={event => props.onOpen({ kind: 'page', pageId: target.id }, beside(event))}>{target.title}</button></>}</For></div>}</For>
              </section>}</For></div>
            </Show>
          </Match>
        </Switch>
      </Show>
    </div>
    <Show keyed when={popup()}>{state => <Switch>
      <Match when={state.kind === 'menu'}><Menu anchor={state.anchor} label={`Actions for ${state.note.title}`} onDismiss={() => setPopup(undefined)} header={<div class="index-action-header"><p class="index-eyebrow">Note actions</p><h2>{state.note.title}</h2><p class="index-apparatus">{apparatus(summary(state.note))}</p><Show when={!summary(state.note)?.text_blocks}><p class="muted">{summary(state.note)?.referenced_from.length ? `Referenced by ${summary(state.note)!.referenced_from.map(page => page.title).join(' · ')}` : 'No text yet'}</p></Show></div>} items={[
        { label: 'Open', action: () => props.onOpen({ kind: 'page', pageId: state.note.id }, window.matchMedia('(pointer: coarse) and (min-width: 900px)').matches) },
        { label: 'File under a type…', action: () => showPopup('file', state.note, state.anchor) },
        { label: 'Rename…', action: () => showPopup('rename', state.note, state.anchor) },
        { label: 'Merge into…', action: () => showPopup('merge', state.note, state.anchor) },
        { label: 'Delete…', danger: true, action: () => showPopup('delete', state.note, state.anchor) },
        { label: 'Cancel', action: () => setPopup(undefined) },
      ]} /></Match>
      <Match when={state.kind === 'file'}><FilingPicker notebook={props.notebook} note={state.note} anchor={state.anchor} onDismiss={() => setPopup(undefined)} onFiled={() => { setPopup(undefined); setVersion(value => value + 1); }} /></Match>
      <Match when={state.kind === 'rename'}><RenameNote notebook={props.notebook} note={state.note} anchor={state.anchor} onDismiss={() => setPopup(undefined)} /></Match>
      <Match when={state.kind === 'merge'}><PageMergePicker notebook={props.notebook} from={{ id: state.note.id, text: state.note.title }} anchor={state.anchor} onDismiss={() => setPopup(undefined)} onMerged={() => { setPopup(undefined); setVersion(value => value + 1); }} /></Match>
      <Match when={state.kind === 'delete'}><Popup anchor={state.anchor} placement={cover() ? 'sheet' : 'anchor'} class="index-note-popup" label="Delete page" onDismiss={() => { if (!busy()) setPopup(undefined); }}>
        <p>Delete “{state.note.title}” and all its blocks?</p><p class="muted">You can undo this deletion.</p><Show when={error()}><p class="error" role="alert">{error()}</p></Show><div class="popup-actions"><Button disabled={busy()} onClick={() => setPopup(undefined)}>Cancel</Button><Button class="danger bordered" disabled={busy() || !props.onDeletePages} onClick={() => void deleteNote(state.note)}>Delete page</Button></div>
      </Popup></Match>
    </Switch>}</Show>
  </div>;
}

/** Built-in kinds a page can start under from their finding aid. Sources come from the Library instead. */
const startable: Record<string, 'type' | 'question' | 'project'> = { person: 'type', group: 'type', concept: 'type', thesis: 'type', question: 'question', project: 'project' };

/** An empty kind says how pages arrive in it and, for built-in kinds, starts one. */
function EmptyKind(props: { kindKey: string; kind: NoteKind | undefined; notebook: NotebookClient; onOpen(target: OpenTarget, beside: boolean): void }) {
  const mode = () => props.kind ? startable[props.kindKey] : undefined;
  const hint = () => {
    const name = props.kind?.name ?? '';
    switch (mode()) {
      case 'type': return `File a page under ${name} from Unfiled, or start one here.`;
      case 'question': return 'Make a page a question from its page menu, or start one here.';
      case 'project': return 'Make a page a project from its page menu, or start one here.';
      default: return undefined;
    }
  };
  return <div class="index-empty">
    <p class="index-empty-title">{props.kind ? `No ${props.kind.plural.toLocaleLowerCase()} yet.` : 'No notes of this kind yet.'}</p>
    <Show when={hint()}>{text => <p class="index-empty-hint">{text()}</p>}</Show>
    <NewKindAction {...props} />
  </div>;
}

function NewKindAction(props: Pick<IndexPaneProps, 'kindKey' | 'kind' | 'notebook' | 'onOpen'> & { members?: NoteEntry[] }) {
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const mode = () => props.kind ? startable[props.kindKey] : undefined;
  const members = createMemo(() => new Set(props.members?.map(note => note.id)));
  return <>
    <Show when={mode()}><Button class="bordered" icon="plus" aria-haspopup="dialog" onClick={event => setAnchor(event.currentTarget)}>New {props.kind!.name.toLocaleLowerCase()}…</Button></Show>
    <Show when={anchor()}>{target => <NewKindNote kind={props.kind!} mode={mode()!} anchor={target()} notebook={props.notebook} members={members()} onDismiss={() => setAnchor(undefined)} onOpen={(pageId, beside) => { setAnchor(undefined); props.onOpen({ kind: 'page', pageId }, beside); }} />}</Show>
  </>;
}

/** What the gist line asks for; it becomes the page's first block, which the finding aid shows under the title. */
const gistPrompt: Record<'type' | 'question' | 'project', (noun: string) => string> = {
  type: noun => noun === 'person' ? 'Who they are, in a line' : noun === 'group' ? 'What the group is, in a line' : noun === 'thesis' ? 'The claim, in a sentence' : `What the ${noun} is, in a sentence`,
  question: () => 'Why it matters, in a sentence',
  project: () => 'The outcome, in a sentence',
};

/** Names a page, optionally with its gist, and files it under the kind in one acknowledged batch. Pages with a similar title are offered first, so an existing page is filed or opened instead of duplicated. */
function NewKindNote(props: { kind: NoteKind; mode: 'type' | 'question' | 'project'; anchor: HTMLElement; notebook: NotebookClient; members: ReadonlySet<string>; onDismiss(): void; onOpen(pageId: string, beside: boolean): void }) {
  const [title, setTitle] = createSignal('');
  const [gist, setGist] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const noun = props.kind.name.toLocaleLowerCase();
  const query = () => title().trim();
  // Titles are unique without case, as the notebook keys them; the cached roots can miss pages made by other commands.
  const [existing] = createResource(() => query() || false, async text => ({ title: text, id: await props.notebook.pageByTitle(text, false).catch(() => null) }));
  const [similar] = createResource(() => query() || false, text => props.notebook.api.complete(text, 8).then(rows => rows.filter(row => row.kind === 'page')).catch(() => []));
  const [type] = createResource(() => props.kind.type_id || false, id => props.notebook.api.type(id).catch(() => null));
  const template = () => (type.latest?.fields ?? []).map(id => props.notebook.lookup(id)()?.text).filter((name): name is string => !!name);
  const typePage = () => props.mode === 'type' && query().toLocaleLowerCase() === props.kind.name.toLocaleLowerCase();
  // A resource retains its last result while resolving; only the current title may use it.
  const found = () => existing.latest?.title === query() ? existing.latest.id ?? undefined : undefined;
  const member = () => !!found() && props.members.has(found()!);
  const matches = createMemo(() => query() ? (similar.latest ?? []).filter(row => row.id !== found()).slice(0, 4) : []);
  const submit = async (beside: boolean, chosen?: { id: string; text: string }) => {
    const text = chosen?.text ?? query();
    if (!text || busy() || (!chosen && typePage())) return;
    setBusy(true); setError('');
    let doc: PageDocument | undefined;
    try {
      const pageId = chosen?.id ?? await props.notebook.pageByTitle(text, false);
      if (pageId && props.members.has(pageId)) { props.onOpen(pageId, beside); return; }
      const id = pageId ?? ulid();
      let revision = 1;
      if (pageId) { doc = props.notebook.open(pageId); await documentReady(doc); await doc.flush(); revision = (await props.notebook.api.block(id)).revision; }
      const kindPage = props.mode === 'type' ? await props.notebook.pageByTitle(props.kind.name, false) : null;
      const line = gist().trim();
      const operations: Operation[] = [
        ...(pageId ? [] : [{ op: 'create_page' as const, id, title: text }]),
        ...(pageId || !line ? [] : [{ op: 'insert' as const, id: ulid(), parent_id: id, after: null, text: line, heading: null }]),
        ...(props.mode === 'type' ? filingOperations(id, revision, props.kind.name, kindPage ? undefined : ulid())
          : props.mode === 'question' ? [{ op: 'set_question' as const, id, base_revision: revision, question: { unsettled: false, parked: false, review_on: null, accepted: null } }]
            : [{ op: 'set_project' as const, id, base_revision: revision, project: { status: 'active' as const, outcome: '', deadline: null } }]),
      ];
      await props.notebook.commit(operations, `New ${noun}`);
      props.onOpen(id, beside);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { doc?.release(); setBusy(false); }
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    void submit(event.shiftKey);
  };
  const action = () => busy() ? 'Saving…' : member() ? `Open ${noun}` : found() ? `File as ${noun}` : `Create ${noun}`;
  return <Popup anchor={props.anchor} placement={cover() ? 'sheet' : 'anchor'} class="index-note-popup new-kind-popup" label={`New ${noun}`} width={400} onDismiss={() => { if (!busy()) props.onDismiss(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(false); }}>
      <p class="index-eyebrow new-kind-eyebrow"><Icon name={noteKindIcon(props.kind)} />New {noun}</p>
      <label class="visually-hidden" for="new-kind-title">Title</label>
      <input id="new-kind-title" class="new-kind-title" value={title()} disabled={busy()} autocomplete="off" placeholder={`Name the ${noun}`} onInput={event => { setTitle(event.currentTarget.value); setError(''); }} onKeyDown={keyDown} />
      <Show when={!typePage() && found()} fallback={<Show when={!typePage()}>
        <label class="visually-hidden" for="new-kind-gist">Gist</label>
        <input id="new-kind-gist" class="new-kind-gist" value={gist()} disabled={busy()} autocomplete="off" placeholder={gistPrompt[props.mode](noun)} onInput={event => setGist(event.currentTarget.value)} onKeyDown={keyDown} />
      </Show>}>{id => <p class="new-kind-note">“{props.notebook.lookup(id())()?.text ?? query()}” {member() ? `is already a ${noun}.` : `already exists; it will be ${props.mode === 'type' ? `filed under ${props.kind.name}` : `made a ${noun}`}.`}</p>}</Show>
      <Show when={typePage()}><p class="new-kind-note">“{props.kind.name}” names the type itself.</p></Show>
      <Show when={template().length}><p class="new-kind-template"><span>Template</span>{template().join(' · ')}</p></Show>
      <Show when={matches().length}>
        <div class="new-kind-matches" role="group" aria-label="Similar pages">
          <p class="new-kind-matches-label">Similar pages</p>
          <For each={matches()}>{row => <button type="button" class="new-kind-match" disabled={busy()} onClick={event => void submit(event.shiftKey, row)}>
            <span class="new-kind-match-title">{row.text}<Show when={row.alias}>{alias => <span class="reference-via"> via {alias()}</span>}</Show></span>
            <span class="new-kind-match-action">{props.members.has(row.id) ? 'Open' : props.mode === 'type' ? `File as ${noun}` : `Make ${noun}`}</span>
          </button>}</For>
        </div>
      </Show>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
      <div class="popup-actions new-kind-actions">
        <span class="new-kind-keys"><kbd>↵</kbd> {member() ? 'Open' : found() ? 'File' : 'Create'} <kbd>⇧↵</kbd> Beside</span>
        <Button disabled={busy()} onClick={props.onDismiss}>Cancel</Button><Button type="submit" class="bordered" disabled={!query() || busy() || typePage()}>{action()}</Button>
      </div>
    </form>
  </Popup>;
}

interface FilingChoice { id: string; title: string; create: boolean }
function FilingPicker(props: { notebook: NotebookClient; note: NoteEntry; anchor: HTMLElement; onDismiss(): void; onFiled(): void }) {
  const [query, setQuery] = createSignal('');
  const [chosen, setChosen] = createSignal<FilingChoice>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [types] = createResource(() => props.notebook.api.types());
  const choices = createMemo(() => {
    const text = query().trim();
    const key = text.toLocaleLowerCase();
    const result: FilingChoice[] = (types() ?? []).filter(type => type.page.id !== props.note.id && type.page.text.toLocaleLowerCase().includes(key)).map(type => ({ id: type.page.id, title: type.page.text, create: false }));
    if (text && !result.some(type => type.title.toLocaleLowerCase() === key)) {
      const existing = props.notebook.roots().find(page => page.kind === 'page' && page.text.toLocaleLowerCase() === key);
      if ((!existing || existing.id !== props.note.id) && key !== 'fields') result.push({ id: existing?.id ?? 'create', title: existing?.text ?? text, create: !existing });
    }
    return result;
  });
  const file = async () => {
    const choice = chosen(); if (!choice || busy()) return;
    setBusy(true); setError('');
    const doc = props.notebook.open(props.note.id);
    try {
      await documentReady(doc); await doc.flush();
      const block = await props.notebook.api.block(props.note.id);
      await props.notebook.commit(filingOperations(props.note.id, block.revision, choice.title, choice.create ? ulid() : undefined), 'File note under a type');
      props.onFiled();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { doc.release(); setBusy(false); }
  };
  return <Picker<FilingChoice> anchor={props.anchor} placement={cover() ? 'sheet' : 'anchor'} class="index-note-popup index-filing-popup" label={`File ${props.note.title}`} onDismiss={() => { if (!busy()) props.onDismiss(); }}
    query={query()} onQuery={value => { setQuery(value); setChosen(undefined); }} placeholder="Find or create a type" items={choices()} key={choice => choice.id}
    onPick={choice => { if (!busy()) setChosen(choice); }} disabledReason={() => busy() ? 'Filing…' : undefined} busy={types.loading} error={error() || (types.error ? String(types.error) : undefined)} empty="No matching types."
    status={<div class="index-filing-head"><p class="index-eyebrow">File a note</p><h2>{props.note.title}</h2></div>}
    row={choice => <><Icon name={choice.create ? 'plus' : 'tag'} /><span class="picker-text">{choice.create ? `Create type “${choice.title}” and file` : choice.title}</span><Show when={chosen()?.id === choice.id}><Icon name="check" /></Show></>}
    preview={<div class="popup-actions"><Button disabled={busy()} onClick={props.onDismiss}>Cancel</Button><Button class="bordered" disabled={!chosen() || busy() || !!types.error} onClick={() => void file()}>{busy() ? 'Filing…' : chosen()?.create ? 'Create and file' : 'File note'}</Button></div>} />;
}

function RenameNote(props: { notebook: NotebookClient; note: NoteEntry; anchor: HTMLElement; onDismiss(): void }) {
  const [title, setTitle] = createSignal(props.note.title);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const collision = () => props.notebook.roots().find(page => page.id !== props.note.id && page.text.toLocaleLowerCase() === title().trim().toLocaleLowerCase());
  const [merge, setMerge] = createSignal(false);
  const rename = async () => {
    if (!title().trim() || busy()) return;
    setBusy(true); setError(''); const doc = props.notebook.open(props.note.id);
    try { await documentReady(doc); const result = doc.edit({ kind: 'text', id: props.note.id, text: title().trim() }); if (!result.ok) throw new Error(result.reason); await doc.flush(); props.onDismiss(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { doc.release(); setBusy(false); }
  };
  return <Show when={!merge()} fallback={<PageMergePicker notebook={props.notebook} from={{ id: props.note.id, text: props.note.title }} anchor={props.anchor} onDismiss={props.onDismiss} onMerged={props.onDismiss} />}>
    <Popup anchor={props.anchor} placement={cover() ? 'sheet' : 'anchor'} class="index-note-popup" label="Rename note" onDismiss={() => { if (!busy()) props.onDismiss(); }}>
      <label>Title<input class="input" value={title()} disabled={busy()} onInput={event => setTitle(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.isComposing && !collision()) void rename(); }} /></label>
      <Show when={error()}><p class="error" role="alert">{error()}</p></Show><div class="popup-actions"><Button disabled={busy()} onClick={props.onDismiss}>Cancel</Button><Show when={collision()} fallback={<Button class="bordered" disabled={busy() || !title().trim()} onClick={() => void rename()}>Save title</Button>}>{page => <Button class="bordered" onClick={() => setMerge(true)}>Merge into “{page().text}”…</Button>}</Show></div>
    </Popup>
  </Show>;
}
