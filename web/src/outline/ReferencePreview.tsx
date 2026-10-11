import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { EditorView } from '@codemirror/view';
import type { PositionRow } from '../api/types';
import { ShapeGlyph } from '../compare/ShapeGlyph';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget, PaneId } from '../shell/contract';
import { textTokens } from '../document/text-tokens';
import { pageSigla } from '../library/sigla';
import { loadWorks } from '../library/PersonWorks';
import { fieldEntryId, matchFieldEntry } from '../table/query';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { BlockBreadcrumb, BlockText, isStableReference } from './BlockText';
import { glossEntry, glossText, isGistName, isGlossName } from './gloss';
import { positionFields, positionSource } from './perspectives';
import './reference-preview.css';

/** Resting on a reference this long opens its card; moving to another reference while one is open takes a third of it. */
const OPEN_DELAY = 350;
/** Grace period for crossing the gap between a reference and its card. */
const CLOSE_DELAY = 200;
const PAGE_ROWS = 3;
const BLOCK_ROWS = 6;
const WIDTH = 380;
/** Backlinks are counted up to this, then shown as "N+". */
const REFERENCE_LIMIT = 100;

interface Entry {
  key: number;
  id: string;
  /** The reference element, or null when the card was opened from an editor caret. */
  link: HTMLElement | null;
  anchor: () => DOMRect | null;
  pane: PaneId | null;
  keyboard: boolean;
  panel?: HTMLElement;
}

export interface ReferencePreviewsProps {
  notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean, pane: PaneId | null): void;
}

/** The block a rendered reference points to: `data-reference` on static text, the token under a widget in the editor. */
function referenceId(element: HTMLElement): string | null {
  if (element.dataset.reference) return element.dataset.reference;
  const editor = element.closest<HTMLElement>('.cm-editor');
  const view = editor && EditorView.findFromDOM(editor);
  if (!view) return null;
  const at = view.posAtDOM(element);
  const token = textTokens(view.state.doc.toString()).find(token => token.kind === 'reference' && token.start === at);
  return token && isStableReference(token) ? token.id! : null;
}

/** The line box under the pointer, so a wrapped reference anchors its card to the line being read. */
function lineAnchor(element: HTMLElement, y: number): () => DOMRect | null {
  const rects = [...element.getClientRects()];
  const index = Math.max(0, rects.findIndex(rect => rect.top <= y && y <= rect.bottom));
  return () => element.isConnected ? element.getClientRects()[index] ?? element.getBoundingClientRect() : null;
}

/**
 * Hover cards for `[[references]]` anywhere in the window. Resting on a reference opens a read-only preview of
 * its page or block; references inside a card open stacked cards. ⌘ pins the topmost card, Escape closes it,
 * and ⌥Space opens the card for the reference at the editor caret or the focused reference.
 */
export function ReferencePreviews(props: ReferencePreviewsProps) {
  const [stack, setStack] = createSignal<Entry[]>([]);
  const [pinned, setPinned] = createSignal<ReadonlySet<number>>(new Set());
  let serial = 0;
  let pending = 0;
  let closing = 0;
  let pointer = { x: 0, y: 0 };

  const truncate = (depth: number) => { if (stack().length > depth) setStack(entries => entries.slice(0, depth)); };
  const open = (entry: Omit<Entry, 'key'>, depth: number) => {
    clearTimeout(closing);
    setStack(entries => [...entries.slice(0, depth), { ...entry, key: ++serial }]);
  };
  const scheduleClose = () => {
    clearTimeout(closing);
    closing = window.setTimeout(() => {
      // Keep every card up to the deepest one under the pointer or pinned.
      let keep = 0;
      stack().forEach((entry, index) => { if (pinned().has(entry.key) || entry.keyboard || entry.panel?.matches(':hover') || entry.link?.matches(':hover')) keep = index + 1; });
      truncate(keep);
    }, CLOSE_DELAY);
  };
  const togglePin = (entry: Entry) => {
    setPinned(keys => {
      const next = new Set(keys);
      if (next.has(entry.key)) next.delete(entry.key);
      else next.add(entry.key);
      return next;
    });
    scheduleClose();
  };
  const go = (entry: Entry, beside: boolean) => {
    const block = props.notebook.lookup(entry.id)();
    if (!block) return;
    setStack([]);
    props.onOpen({ kind: 'page', pageId: block.page_id, blockId: block.kind === 'block' ? block.id : undefined }, beside, entry.pane);
  };

  const over = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    const link = (event.target as Element).closest?.<HTMLElement>('.outline-reference');
    if (!link) return;
    clearTimeout(closing);
    if (stack().some(entry => entry.link === link)) return;
    const id = referenceId(link);
    if (!id) return;
    clearTimeout(pending);
    pending = window.setTimeout(() => {
      if (!link.isConnected || !link.matches(':hover')) return;
      const depth = stack().findIndex(entry => entry.panel?.contains(link)) + 1;
      const pane = (link.closest<HTMLElement>('[data-pane]')?.dataset.pane as PaneId | undefined) ?? stack()[depth - 1]?.pane ?? null;
      open({ id, link, anchor: lineAnchor(link, pointer.y), pane, keyboard: false }, depth);
    }, stack().length ? OPEN_DELAY / 3 : OPEN_DELAY);
  };
  const out = (event: PointerEvent) => {
    const link = (event.target as Element).closest?.('.outline-reference');
    if (!link || link.contains(event.relatedTarget as Node | null)) return;
    clearTimeout(pending);
    if (stack().length) scheduleClose();
  };
  const move = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY }; };

  /** ⌥Space at a reference: the editor caret's token, or a focused reference button. */
  const keyboardEntry = (): Omit<Entry, 'key'> | null => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return null;
    const pane = (active.closest<HTMLElement>('[data-pane]')?.dataset.pane as PaneId | undefined) ?? null;
    if (active.matches('.outline-reference')) {
      const id = referenceId(active);
      return id ? { id, link: active, anchor: () => active.isConnected ? active.getBoundingClientRect() : null, pane, keyboard: true } : null;
    }
    const editor = active.closest<HTMLElement>('.cm-editor');
    const view = editor && EditorView.findFromDOM(editor);
    if (!view) return null;
    const head = view.state.selection.main.head;
    const token = textTokens(view.state.doc.toString()).find(token => token.kind === 'reference' && token.start <= head && head <= token.end);
    if (!token || !isStableReference(token)) return null;
    // A collapsed reference is a widget; anchor to it. A reference showing its source anchors to the text.
    const widget = [...view.contentDOM.querySelectorAll<HTMLElement>('.outline-reference')].find(element => view.posAtDOM(element) === token.start);
    if (widget) return { id: token.id!, link: widget, anchor: () => widget.isConnected ? widget.getBoundingClientRect() : null, pane, keyboard: true };
    const anchor = () => {
      const start = view.coordsAtPos(token.start, 1);
      return start ? new DOMRect(start.left, start.top, 1, start.bottom - start.top) : null;
    };
    return { id: token.id!, link: null, anchor, pane, keyboard: true };
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const top = stack().at(-1);
    if (event.code === 'Space' && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      if (top?.keyboard) { event.preventDefault(); event.stopPropagation(); truncate(stack().length - 1); return; }
      const entry = keyboardEntry();
      if (!entry) return;
      event.preventDefault(); event.stopPropagation();
      open(entry, 0);
      return;
    }
    if (!top) return;
    if (event.key === 'Meta') { setPinned(keys => new Set([...keys, top.key])); return; }
    // Controls in a keyboard-opened card keep their native Enter, Space and Tab behaviour.
    if (top.panel?.contains(document.activeElement)) return;
    if (!top.keyboard || event.key === 'Escape' || ['Shift', 'Alt', 'Control'].includes(event.key)) return;
    if (event.key === 'Enter' && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault(); event.stopPropagation();
      go(top, event.shiftKey);
      return;
    }
    // Typing carries on; the card made from the caret steps aside.
    truncate(0);
  };

  onMount(() => {
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('keydown', keydown, true);
  });
  onCleanup(() => {
    clearTimeout(pending); clearTimeout(closing);
    document.removeEventListener('pointerover', over);
    document.removeEventListener('pointerout', out);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('keydown', keydown, true);
  });

  return <For each={stack()}>{(entry, index) =>
    <Popup anchor={entry.anchor} label="Reference preview" class={`reference-preview${pinned().has(entry.key) ? ' pinned' : ''}`} width={WIDTH} autofocus={false} onDismiss={() => truncate(index())}>
      <div class="reference-preview-card" ref={element => { entry.panel = element; }}
        onPointerEnter={() => clearTimeout(closing)} onPointerLeave={scheduleClose}>
        <ReferenceCard id={entry.id} notebook={props.notebook} pinned={pinned().has(entry.key)} keyboard={entry.keyboard}
          onTogglePin={() => togglePin(entry)} onOpen={beside => go(entry, beside)}
          onNested={(target, beside) => { setStack([]); props.onOpen(target, beside, entry.pane); }} />
      </div>
    </Popup>
  }</For>;
}

interface Row { id: string; depth: number; role: 'context' | 'focus' | 'body' }

/** A block keeps its parent and descendants so the focused passage remains in context. */
function previewRows(doc: PageDocument, id: string): Row[] {
  doc.outline.version(); doc.archivedVersion();
  const outline = doc.outline;
  const rows: Row[] = [];
  const collect = (from: number, end: number, base: number, limit: number) => {
    for (let index = from; index < end && rows.length < limit;) {
      const row = outline.idAt(index);
      if (doc.isArchived(row)) { index = outline.subtreeEnd(index); continue; }
      rows.push({ id: row, depth: outline.depth(row) - base, role: 'body' });
      index++;
    }
  };
  const index = outline.indexOf(id);
  if (index < 0) return rows;
  const depth = outline.depth(id);
  const parent = outline.parentOf(id);
  const offset = parent === doc.pageId ? 0 : 1;
  if (offset) rows.push({ id: parent, depth: 0, role: 'context' });
  rows.push({ id, depth: offset, role: 'focus' });
  collect(index + 1, outline.subtreeEnd(index), depth - offset, BLOCK_ROWS + rows.length);
  return rows;
}

/** Read authored prose, not field labels; only a field-only page falls back to its actual values. */
function proseRows(doc: PageDocument, parent: string, excluded: string | null, fieldName: (id: string) => string | undefined, limit: number): Row[] {
  doc.outline.version(); doc.archivedVersion();
  const outline = doc.outline;
  const start = parent === doc.pageId ? 0 : outline.indexOf(parent) + 1;
  if (parent !== doc.pageId && start === 0) return [];
  const end = parent === doc.pageId ? outline.size() : outline.subtreeEnd(start - 1);
  const rows: Row[] = [];
  const fallback: Row[] = [];
  const addFallback = (id: string) => { if (fallback.length < limit) fallback.push({ id, depth: 0, role: 'body' }); };
  for (let index = start; index < end && rows.length < limit;) {
    const id = outline.idAt(index);
    if (doc.isArchived(id) || id === excluded) { index = outline.subtreeEnd(index); continue; }
    const block = doc.block(id);
    const text = block?.text.trim() ?? '';
    const field = fieldEntryId(text);
    const shorthand = matchFieldEntry(text);
    if ((field && fieldName(field)) || shorthand) {
      if (parent === doc.pageId) {
        const value = outline.children(id).find(child => !doc.isArchived(child) && doc.block(child)?.text.trim());
        if (value) addFallback(value);
        else if (shorthand?.value.trim()) addFallback(id);
      }
      index = outline.subtreeEnd(index);
      continue;
    }
    if (text) {
      if (block?.heading || block?.position) addFallback(id);
      else rows.push({ id, depth: 0, role: 'body' });
    }
    index++;
  }
  return rows.length ? rows : fallback;
}

function ReferenceCard(props: {
  id: string;
  notebook: NotebookClient;
  pinned: boolean;
  keyboard: boolean;
  onTogglePin(): void;
  onOpen(beside: boolean): void;
  onNested(target: OpenTarget, beside: boolean): void;
}) {
  const target = createMemo(() => props.notebook.lookup(props.id)());
  const pageId = createMemo(() => target()?.page_id);
  const doc = createMemo(() => {
    const id = pageId();
    if (!id) return undefined;
    const value = props.notebook.open(id);
    onCleanup(() => value.release());
    return value;
  });
  const isPage = () => target()?.kind !== 'block';
  const state = () => doc()?.block(props.id);
  // A gloss entry references a Gloss field definition, an ordinary block on the Fields page.
  const gloss = createMemo(() => { const value = doc(); return value?.status() === 'ready' && isPage() ? glossEntry(value, id => { const field = props.notebook.lookup(id)(); return field?.kind === 'block' && isGlossName(field.text); }) : null; });
  const summary = createMemo(() => { const value = doc(); return value && gloss() ? glossText(value, gloss()) : ''; });
  // A passing gloss needs no other documents. Field definitions are needed only for prose fallback or pinned readings.
  const [fieldList] = createResource(() => isPage() && doc()?.status() === 'ready' && (props.pinned || !summary()), () => props.notebook.api.fields());
  const fieldNames = createMemo(() => new Map((fieldList.error ? [] : fieldList()?.fields ?? []).map(field => [field.id, field.name])));
  const fieldName = (id: string) => fieldNames().get(id);
  const rows = createMemo(() => {
    const value = doc();
    if (value?.status() !== 'ready' || (isPage() && !props.pinned && summary())) return [];
    return isPage() ? proseRows(value, value.pageId, gloss(), fieldName, props.pinned ? BLOCK_ROWS : PAGE_ROWS) : previewRows(value, props.id);
  });
  // One subject query provides the count; the referenced pages are opened only after pinning.
  const [positions] = createResource(() => target() && isPage() ? props.id : false, subject => props.notebook.api.positions({ subject }));
  const positionRows = () => positions.error ? [] : positions() ?? [];
  const [references] = createResource(() => props.id, async id => {
    const list = await props.notebook.api.backlinks(id, REFERENCE_LIMIT);
    const works = await loadWorks(props.notebook.api, id, list);
    return { works: works.rows.length, references: list.length - works.creatorLinks.size, capped: list.length >= REFERENCE_LIMIT };
  });
  const referenceCount = () => {
    if (references.error) return 'References unavailable';
    const value = references();
    if (value === undefined) return '';
    if (value.references === 0) return value.works ? '' : 'No references';
    return `${value.capped ? `${value.references}+` : value.references} ${value.references === 1 ? 'reference' : 'references'}`;
  };
  const counts = createMemo(() => [
    !references.error && references()?.works ? `${references()!.works} ${references()!.works === 1 ? 'work' : 'works'}` : '',
    positions.error ? 'Readings unavailable' : positionRows().length ? `${positionRows().length} ${positionRows().length === 1 ? 'reading' : 'readings'}` : '',
    referenceCount(),
  ].filter(Boolean).join(' · '));
  const [clipped, setClipped] = createSignal(false);
  let body: HTMLDivElement | undefined;
  // The body's max-height pins its own box, so growth shows up only on its rows.
  const observer = new ResizeObserver(() => { if (body) setClipped(body.scrollHeight > body.clientHeight + 1); });
  onCleanup(() => observer.disconnect());
  return <Show when={target() !== undefined} fallback={<p class="reference-preview-message">Loading reference…</p>}>
    <Show when={target()} fallback={<p class="reference-preview-message">This reference points to a block that was deleted or never synced here.</p>}>{block => <>
      <header class="reference-preview-header">
        <div class="reference-preview-topline">
          <div class="reference-preview-crumbs"><BlockBreadcrumb block={block()} notebook={props.notebook} /></div>
          <Button class="reference-preview-pin" aria-pressed={props.pinned} title={props.pinned ? 'Unpin reference preview' : 'Pin reference preview · ⌘'} onClick={props.onTogglePin}>
            {props.pinned ? 'Unpin' : 'Pin'}<Show when={!props.pinned}><kbd>⌘</kbd></Show>
          </Button>
        </div>
        <div class="reference-preview-title">
          <Show when={isPage()} fallback={<span class="reference-preview-kind">Block</span>}><h2>{block().text || 'Untitled'}</h2></Show>
        </div>
        <Show when={summary()}>{text => <p class="reference-preview-gloss"><BlockText text={text()} notebook={props.notebook} onOpen={props.onNested} /></p>}</Show>
        <Show when={(state()?.manual_types.length ?? 0) > 0 || state()?.source || state()?.task || state()?.project}>
          <div class="reference-preview-pills">
            <For each={state()?.manual_types}>{title => <span class="outline-tag">#{title}</span>}</For>
            <Show when={state()?.source}>{source => <span class="reference-preview-pill">{source().format} · {source().state}</span>}</Show>
            <Show when={state()?.task}>{task => <span class="reference-preview-pill">{task().status}</span>}</Show>
            <Show when={state()?.project}>{project => <span class="reference-preview-pill">Project · {project().status}</span>}</Show>
          </div>
        </Show>
      </header>
      <Show when={doc()?.status() === 'ready'} fallback={<p class="reference-preview-message">{doc()?.status() === 'loading' || !doc() ? 'Loading…' : doc()?.statusMessage()}</p>}>
        <Show when={props.pinned && isPage() && positionRows().length} fallback={
          <Show when={!isPage() || props.pinned || !summary()}>
            <Show when={props.pinned && positions.loading}><p class="reference-preview-message" role="status">Loading readings…</p></Show>
            <Show when={props.pinned && positions.error}><p class="reference-preview-message" role="alert">Couldn’t load readings. The page preview is still available.</p></Show>
            <Show when={fieldList.error}><p class="reference-preview-message" role="alert">Couldn’t load field definitions.</p></Show>
            <Show when={!isPage() || !fieldList.loading} fallback={<p class="reference-preview-message" role="status">Loading preview…</p>}>
              <Show when={rows().length} fallback={<p class="reference-preview-message">{isPage() ? summary() ? 'No further text on this page.' : 'Empty page.' : 'Block not found on its page.'}</p>}>
                <div ref={element => { body = element; observer.observe(element); }} class={`reference-preview-body${isPage() ? ' prose' : ''}${props.pinned ? ' scrollable' : clipped() ? ' clipped' : ''}`}>
                  <For each={rows()}>{row => <div ref={element => observer.observe(element)} class={`reference-preview-row ${row.role}`} style={{ '--depth': row.depth }}>
                    <Show when={!isPage()}><span class="reference-preview-bullet" aria-hidden="true" /></Show>
                    <div class="reference-preview-text"><BlockText text={doc()?.block(row.id)?.text ?? ''} notebook={props.notebook} onOpen={props.onNested} /></div>
                  </div>}</For>
                </div>
              </Show>
            </Show>
          </Show>
        }>
          <Show when={fieldList.error}><p class="reference-preview-message" role="alert">Couldn’t load reading fields.</p></Show>
          <PinnedReadings rows={positionRows()} notebook={props.notebook} fieldName={fieldName} onOpen={props.onNested} />
          <Show when={positionRows().length >= 2}>
            <Button class="reference-preview-compare" onClick={event => props.onNested({ kind: 'compare', subjectId: props.id }, event.shiftKey)}>Compare readings →</Button>
          </Show>
        </Show>
      </Show>
      <footer class="reference-preview-footer">
        <span class="reference-preview-counts">{counts()}</span>
        <span class="reference-preview-spacer" />
        <Button onClick={() => props.onOpen(true)}>Beside<Show when={props.keyboard}><kbd>⇧↵</kbd></Show></Button>
        <Button class="primary" onClick={() => props.onOpen(false)}>{isPage() ? 'Open' : 'Go to block'}<Show when={props.keyboard}><kbd>↵</kbd></Show></Button>
      </footer>
    </>}</Show>
  </Show>;
}

/** Only a pinned slip holds other pages open; summaries and expanded readings follow their live documents. */
function PinnedReadings(props: {
  rows: readonly PositionRow[];
  notebook: NotebookClient;
  fieldName(id: string): string | undefined;
  onOpen(target: OpenTarget, beside: boolean): void;
}) {
  const [selected, setSelected] = createSignal<string | null>(null);
  const docs = createMemo(() => {
    const pages = new Set(props.rows.map(row => row.block.page.id));
    const opened = new Map([...pages].map(id => [id, props.notebook.open(id)]));
    onCleanup(() => { for (const doc of opened.values()) doc.release(); });
    return opened;
  });
  const readings = createMemo(() => props.rows.map(row => {
    const doc = docs().get(row.block.page.id)!;
    const ready = doc.status() === 'ready';
    if (ready) { doc.outline.version(); doc.archivedVersion(); }
    const fields = ready ? positionFields(doc, row.block.block.id, props.fieldName) : [];
    return {
      row, doc,
      gist: fields.find(field => isGistName(field.name))?.value,
      source: ready ? positionSource(doc, row.block.block.id, props.fieldName) : null,
      shape: fields.find(field => field.name.trim().toLowerCase() === 'shape')?.value,
      prose: ready ? proseRows(doc, row.block.block.id, null, props.fieldName, BLOCK_ROWS) : [],
    };
  }));
  const [siglumRecords] = createResource(() => {
    const ids = [...new Set(readings().map(reading => reading.source).filter(id => id !== null))];
    return ids.length ? ids : false;
  }, ids => Promise.all(ids.map(id => props.notebook.api.source(id).then(
    view => ({ id, siglum: view.source.siglum, basis: view.source.siglum_basis, authored: view.source.siglum_authored }),
    () => null,
  ))));
  const sigla = createMemo(() => pageSigla((siglumRecords.error ? [] : siglumRecords() ?? []).filter(record => record !== null)));

  return <section class="reference-preview-readings" aria-label="Readings">
    <div class="reference-preview-section-heading"><span>Readings</span><span class="reference-preview-rule" /><span>{props.rows.length}</span></div>
    <For each={readings()}>{reading => {
      const id = reading.row.block.block.id;
      const holderName = createMemo(() => {
        const holderId = reading.doc.status() === 'ready' ? reading.doc.block(id)?.position?.holder_id ?? null : reading.row.holder_id;
        if (!holderId) return 'No holder';
        const holder = props.notebook.lookup(holderId)();
        return holder === undefined ? 'Loading holder…' : holder?.text || 'Unavailable holder';
      });
      const summary = createMemo(() => reading.gist || (reading.prose[0] ? reading.doc.block(reading.prose[0].id)?.text : '') || reading.doc.block(id)?.text || reading.row.block.block.text);
      const open = (beside: boolean) => props.onOpen({ kind: 'page', pageId: reading.row.block.page.id, blockId: id }, beside);
      return <article class="reference-preview-reading" classList={{ selected: selected() === id }} data-reading={id}>
        <div class="reference-preview-reading-heading">
          <Show when={reading.source && sigla().get(reading.source)}>{mark => <span class="reference-preview-siglum" title={props.notebook.lookup(reading.source!)()?.text}>{mark()}</span>}</Show>
          <Button class="reference-preview-holder" aria-expanded={reading.prose.length ? selected() === id : undefined}
            title={reading.prose.length ? 'Expand this reading · Shift to open beside' : 'Open this reading · Shift to open beside'}
            onClick={event => event.shiftKey || !reading.prose.length ? open(event.shiftKey) : setSelected(value => value === id ? null : id)}>
            <span>{holderName()}</span>
            <Show when={reading.shape}>{shape => <ShapeGlyph value={shape()} />}</Show>
            <Show when={reading.prose.length}><span class="reference-preview-expand" aria-hidden="true">{selected() === id ? '−' : '+'}</span></Show>
          </Button>
        </div>
        <Show when={reading.doc.status() === 'ready'} fallback={
          <p class="reference-preview-reading-message" role={reading.doc.status() === 'loading' ? 'status' : 'alert'}>{reading.doc.status() === 'loading' ? 'Loading reading…' : reading.doc.statusMessage()}</p>
        }>
          <Show when={summary()}>{text => <p class="reference-preview-gist"><BlockText text={text()} notebook={props.notebook} onOpen={props.onOpen} /></p>}</Show>
        </Show>
        <Show when={selected() === id}>
          <div class="reference-preview-reading-detail">
            <Show when={reading.doc.status() === 'ready'}>
              <Show when={reading.source}>{source =>
                <Button class="reference-preview-reading-source" title="Open source · Shift to open beside" disabled={!props.notebook.lookup(source())()}
                  onClick={event => {
                    const block = props.notebook.lookup(source())();
                    if (block) props.onOpen({ kind: 'page', pageId: block.page_id, blockId: block.kind === 'block' ? block.id : undefined }, event.shiftKey);
                  }}>
                  <Show when={props.notebook.lookup(source())() !== undefined} fallback="Loading source…">{props.notebook.lookup(source())()?.text || 'Unavailable source'}</Show>
                </Button>
              }</Show>
              <For each={reading.prose}>{row => <p class="reference-preview-reading-prose"><BlockText text={reading.doc.block(row.id)?.text ?? ''} notebook={props.notebook} onOpen={props.onOpen} /></p>}</For>
              <Show when={!reading.prose.length}><p class="reference-preview-reading-message">No further text in this reading.</p></Show>
            </Show>
            <Button class="reference-preview-open-reading" onClick={event => open(event.shiftKey)}>Open reading →</Button>
          </div>
        </Show>
      </article>;
    }}</For>
  </section>;
}
