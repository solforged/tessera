import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { EditorView } from '@codemirror/view';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget, PaneId } from '../shell/contract';
import { textTokens } from '../document/text-tokens';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { BlockBreadcrumb, BlockText, isStableReference } from './BlockText';
import { glossEntry, glossText, isGlossName } from './gloss';
import './reference-preview.css';

/** Resting on a reference this long opens its card; moving to another reference while one is open takes a third of it. */
const OPEN_DELAY = 350;
/** Grace period for crossing the gap between a reference and its card. */
const CLOSE_DELAY = 200;
const PAGE_ROWS = 10;
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
          onOpen={beside => go(entry, beside)} onNested={(target, beside) => { setStack([]); props.onOpen(target, beside, entry.pane); }} />
      </div>
    </Popup>
  }</For>;
}

interface Row { id: string; depth: number; role: 'context' | 'focus' | 'body' }

/** Live rows to show: a page's first visible blocks (its gloss shows in the header instead), or a block under its parent with its first descendants. */
function previewRows(doc: PageDocument, id: string, isPage: boolean, gloss: string | null): Row[] {
  doc.outline.version(); doc.archivedVersion();
  const outline = doc.outline;
  const rows: Row[] = [];
  const collect = (from: number, end: number, base: number, limit: number) => {
    for (let index = from; index < end && rows.length < limit;) {
      const row = outline.idAt(index);
      if (doc.isArchived(row) || row === gloss) { index = outline.subtreeEnd(index); continue; }
      rows.push({ id: row, depth: outline.depth(row) - base, role: 'body' });
      index++;
    }
  };
  if (isPage) { collect(0, outline.size(), 0, PAGE_ROWS); return rows; }
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

function ReferenceCard(props: {
  id: string;
  notebook: NotebookClient;
  pinned: boolean;
  keyboard: boolean;
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
  const rows = createMemo(() => { const value = doc(); return value?.status() === 'ready' ? previewRows(value, props.id, isPage(), gloss()) : []; });
  const [references] = createResource(() => props.id, id => props.notebook.api.backlinks(id, REFERENCE_LIMIT).then(list => list.length, () => null));
  const referenceCount = () => {
    const count = references();
    if (count === undefined || count === null) return '';
    if (count === 0) return 'No references';
    return `${count >= REFERENCE_LIMIT ? `${REFERENCE_LIMIT}+` : count} ${count === 1 ? 'reference' : 'references'}`;
  };
  const [clipped, setClipped] = createSignal(false);
  let body: HTMLDivElement | undefined;
  // The body's max-height pins its own box, so growth shows up only on its rows.
  const observer = new ResizeObserver(() => { if (body) setClipped(body.scrollHeight > body.clientHeight + 1); });
  onCleanup(() => observer.disconnect());

  return <Show when={target() !== undefined} fallback={<p class="reference-preview-message">Loading reference…</p>}>
    <Show when={target()} fallback={<p class="reference-preview-message">This reference points to a block that was deleted or never synced here.</p>}>{block => <>
      <header class="reference-preview-header">
        <div class="reference-preview-crumbs"><BlockBreadcrumb block={block()} notebook={props.notebook} /></div>
        <div class="reference-preview-title">
          <Show when={isPage()} fallback={<span class="reference-preview-kind">Block</span>}><h2>{block().text || 'Untitled'}</h2></Show>
          <span class="reference-preview-pin">{props.pinned ? 'Pinned' : 'Pin ⌘'}</span>
        </div>
        <Show when={gloss() && glossText(doc()!, gloss())}>{text => <p class="reference-preview-gloss"><BlockText text={text()} notebook={props.notebook} onOpen={props.onNested} /></p>}</Show>
        <Show when={(state()?.manual_types.length ?? 0) > 0 || state()?.source || state()?.task || state()?.project}>
          <div class="reference-preview-pills">
            <For each={state()?.manual_types}>{title => <span class="outline-tag">#{title}</span>}</For>
            <Show when={state()?.source}>{source => <span class="reference-preview-pill">{source().format} · {source().state}</span>}</Show>
            <Show when={state()?.task}>{task => <span class="reference-preview-pill">{task().status}</span>}</Show>
            <Show when={state()?.project}><span class="reference-preview-pill">Project</span></Show>
          </div>
        </Show>
      </header>
      <Show when={doc()?.status() === 'ready'} fallback={<p class="reference-preview-message">{doc()?.status() === 'loading' || !doc() ? 'Loading…' : doc()?.statusMessage()}</p>}>
        <Show when={rows().length} fallback={<p class="reference-preview-message">{isPage() ? 'Empty page.' : 'Block not found on its page.'}</p>}>
          <div ref={element => { body = element; observer.observe(element); }} class={`reference-preview-body${props.pinned ? ' scrollable' : clipped() ? ' clipped' : ''}`}>
            <For each={rows()}>{row => <div ref={element => observer.observe(element)} class={`reference-preview-row ${row.role}`} style={{ '--depth': row.depth }}>
              <span class="reference-preview-bullet" aria-hidden="true" />
              <div class="reference-preview-text"><BlockText text={doc()?.block(row.id)?.text ?? ''} notebook={props.notebook} onOpen={props.onNested} /></div>
            </div>}</For>
          </div>
        </Show>
      </Show>
      <footer class="reference-preview-footer">
        <span>{referenceCount()}</span>
        <span class="reference-preview-spacer" />
        <Button onClick={() => props.onOpen(true)}>Beside<Show when={props.keyboard}><kbd>⇧↵</kbd></Show></Button>
        <Button class="primary" onClick={() => props.onOpen(false)}>{isPage() ? 'Open' : 'Go to block'}<Show when={props.keyboard}><kbd>↵</kbd></Show></Button>
      </footer>
    </>}</Show>
  </Show>;
}
