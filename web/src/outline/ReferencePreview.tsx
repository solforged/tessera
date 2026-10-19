import { opensBeside, besideHint, besideKey } from '../shell/beside';
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { EditorView } from '@codemirror/view';
import type { PositionRow } from '../api/types';
import { ShapeGlyph } from '../compare/ShapeGlyph';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget, PaneId } from '../shell/contract';
import { isStableReference, textTokens } from '../document/text-tokens';
import { displayTitle } from './names';
import { citedSigla } from '../library/sigla';
import { createCitedSources } from './source-reads';
import { loadWorks } from '../library/PersonWorks';
import { fieldEntryId, matchFieldEntry } from '../table/query';
import { Button } from '../ui/Button';
import { Popup } from '../ui/Popup';
import { BlockBreadcrumb, BlockText } from './BlockText';
import { BlockTree, blockContextRows } from './BlockTree';
import type { TreeRow } from './BlockTree';
import { glossEntry, glossText } from './gloss';
import { fieldRole } from '../fields/roles';
import { positionFields, positionRelations, positionSource, readingPassages } from './perspectives';
import { OutgoingRelations } from './RelationLines';
import './reference-preview.css';
import { hasCitationDetail, referenceSource, sourceReadsVersion } from './source-reads';

/** Resting on a reference this long opens its card; moving to another reference while one is open takes a third of it. */
const OPEN_DELAY = 350;
/** Grace period for crossing the gap between a reference and its card. */
const CLOSE_DELAY = 200;
/** A deliberate touch hold opens the same slip without activating the link. */
const HOLD_DELAY = 650;
const HOLD_SLOP = 10;
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
  currentLink?: () => HTMLElement | null;
  anchor: () => DOMRect | null;
  pane: PaneId | null;
  keyboard: boolean;
  touch?: boolean;
  citation?: boolean;
  locator?: string;
  panel?: HTMLElement;
}

export interface ReferencePreviewsProps {
  notebook: NotebookClient;
  /** Pane navigation retires slips whose source view has gone away. */
  navigationKey: string;
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

/** Keep the same occurrence and line box when loading its target replaces the rendered label. */
function lineAnchor(element: HTMLElement, y: number): Pick<Entry, 'link' | 'currentLink' | 'anchor'> {
  const host = element.parentElement;
  const id = referenceId(element);
  const sourceStart = element.dataset.sourceStart;
  const occurrence = host ? [...host.querySelectorAll('.outline-reference')].indexOf(element) : -1;
  const rects = [...element.getClientRects()];
  const index = Math.max(0, rects.findIndex(rect => rect.top <= y && y <= rect.bottom));
  const currentLink = () => {
    if (element.isConnected) return element;
    const candidates = host ? [...host.querySelectorAll<HTMLElement>('.outline-reference')] : [];
    if (sourceStart !== undefined) return candidates.find(candidate => referenceId(candidate) === id && candidate.dataset.sourceStart === sourceStart) ?? null;
    return candidates[occurrence] && referenceId(candidates[occurrence]) === id ? candidates[occurrence] : null;
  };
  return { link: element, currentLink, anchor: () => {
    const current = currentLink();
    return current ? current.getClientRects()[index] ?? current.getBoundingClientRect() : null;
  } };
}

/**
 * Hover cards for `[[references]]` anywhere in the window. Resting on a reference opens a read-only preview of
 * its page or block; references inside a card open stacked cards. ⌘ pins the topmost card, Escape closes it,
 * and ⌥Space opens the card for the reference at the editor caret or the focused reference.
 */
export function ReferencePreviews(props: ReferencePreviewsProps) {
  const [stack, setStack] = createSignal<Entry[]>([]);
  const [pinned, setPinned] = createSignal<ReadonlySet<number>>(new Set());
  const [fontsReady, setFontsReady] = createSignal(false);
  createEffect<string | undefined>(previous => {
    const key = props.navigationKey;
    if (previous !== undefined && key !== previous) setStack([]);
    return key;
  });
  let serial = 0;
  let pending = 0;
  let closing = 0;
  let pointer = { x: 0, y: 0 };
  let holding: { pointerId: number; link: HTMLElement; x: number; y: number } | null = null;
  let holdTimer = 0;
  let heldLink: HTMLElement | null = null;

  const truncate = (depth: number) => { if (stack().length > depth) setStack(entries => entries.slice(0, depth)); };
  const open = (entry: Omit<Entry, 'key'>, depth: number) => {
    clearTimeout(closing);
    setStack(entries => [...entries.slice(0, depth), { ...entry, citation: entry.citation ?? entry.link?.hasAttribute('data-citation'), locator: entry.locator ?? entry.link?.dataset.locator, key: ++serial }]);
  };
  const scheduleClose = () => {
    clearTimeout(closing);
    closing = window.setTimeout(() => {
      // Keep every card up to the deepest one under the pointer or pinned.
      let keep = 0;
      stack().forEach((entry, index) => { if (pinned().has(entry.key) || entry.keyboard || entry.touch || entry.panel?.matches(':hover') || (entry.currentLink?.() ?? entry.link)?.matches(':hover')) keep = index + 1; });
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
    if (stack().some(entry => (entry.currentLink?.() ?? entry.link) === link)) return;
    const id = referenceId(link);
    if (!id) return;
    clearTimeout(pending);
    pending = window.setTimeout(() => {
      if (!link.isConnected || !link.matches(':hover')) return;
      const depth = stack().findIndex(entry => entry.panel?.contains(link)) + 1;
      const pane = (link.closest<HTMLElement>('[data-pane]')?.dataset.pane as PaneId | undefined) ?? stack()[depth - 1]?.pane ?? null;
      open({ id, ...lineAnchor(link, pointer.y), pane, keyboard: false }, depth);
    }, stack().length ? OPEN_DELAY / 3 : OPEN_DELAY);
  };
  const out = (event: PointerEvent) => {
    const link = (event.target as Element).closest?.('.outline-reference');
    if (!link || link.contains(event.relatedTarget as Node | null)) return;
    clearTimeout(pending);
    if (stack().length) scheduleClose();
  };
  const move = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY }; };

  const cancelHold = () => { clearTimeout(holdTimer); holding = null; };
  const touchOpen = (link: HTMLElement, y: number) => {
    const id = referenceId(link);
    if (!id || !link.isConnected || heldLink?.dataset.reference === id) return;
    clearTimeout(pending);
    heldLink = link;
    const depth = stack().findIndex(entry => entry.panel?.contains(link)) + 1;
    const pane = (link.closest<HTMLElement>('[data-pane]')?.dataset.pane as PaneId | undefined) ?? stack()[depth - 1]?.pane ?? null;
    open({ id, ...lineAnchor(link, y), pane, keyboard: false, touch: true }, depth);
  };
  const touchStart = (event: PointerEvent) => {
    cancelHold();
    heldLink = null;
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    // Leave the editor's reference widgets and ambiguous-name picker alone.
    const link = (event.target as Element).closest?.<HTMLElement>('.outline-reference[role="button"][data-reference]');
    if (!link) return;
    holding = { pointerId: event.pointerId, link, x: event.clientX, y: event.clientY };
    holdTimer = window.setTimeout(() => { if (holding) touchOpen(holding.link, holding.y); }, HOLD_DELAY);
  };
  const touchMove = (event: PointerEvent) => {
    if (holding?.pointerId === event.pointerId && Math.hypot(event.clientX - holding.x, event.clientY - holding.y) > HOLD_SLOP) cancelHold();
  };
  const touchEnd = (event: PointerEvent) => {
    if (holding?.pointerId === event.pointerId) cancelHold();
  };
  const touchContext = (event: MouseEvent) => {
    const link = (event.target as Element).closest?.<HTMLElement>('.outline-reference[role="button"][data-reference]');
    if (!link || holding?.link !== link && heldLink?.dataset.reference !== link.dataset.reference) return;
    event.preventDefault(); event.stopImmediatePropagation();
    touchOpen(link, holding?.y ?? event.clientY);
  };
  const touchClick = (event: MouseEvent) => {
    const link = (event.target as Element).closest?.<HTMLElement>('.outline-reference[role="button"][data-reference]');
    if (!heldLink || link?.dataset.reference !== heldLink.dataset.reference) return;
    // Loading the preview can replace the reference before the compatibility click.
    event.preventDefault(); event.stopImmediatePropagation();
    heldLink = null;
  };

  /** ⌥Space at a reference: the editor caret's token, or a focused reference button. */
  const keyboardEntry = (): Omit<Entry, 'key'> | null => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return null;
    const pane = (active.closest<HTMLElement>('[data-pane]')?.dataset.pane as PaneId | undefined) ?? null;
    if (active.matches('.outline-reference')) {
      const id = referenceId(active);
      return id ? { id, ...lineAnchor(active, active.getBoundingClientRect().top), pane, keyboard: true } : null;
    }
    const editor = active.closest<HTMLElement>('.cm-editor');
    const view = editor && EditorView.findFromDOM(editor);
    if (!view) return null;
    const head = view.state.selection.main.head;
    const token = textTokens(view.state.doc.toString()).find(token => token.kind === 'reference' && token.start <= head && head <= token.end);
    if (!token || !isStableReference(token)) return null;
    // A collapsed reference is a widget; anchor to it. A reference showing its source anchors to the text.
    const widget = [...view.contentDOM.querySelectorAll<HTMLElement>('.outline-reference')].find(element => view.posAtDOM(element) === token.start);
    if (widget) return { id: token.id!, ...lineAnchor(widget, widget.getBoundingClientRect().top), pane, keyboard: true };
    const anchor = () => {
      const start = view.coordsAtPos(token.start, 1);
      return start ? new DOMRect(start.left, start.top, 1, start.bottom - start.top) : null;
    };
    return { id: token.id!, link: null, anchor, pane, keyboard: true, citation: hasCitationDetail(token), locator: token.locator };
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
    if (event.key === 'Enter' && !event.altKey && (!event.metaKey && !event.ctrlKey || opensBeside(event) && !document.activeElement?.closest('.cm-editor'))) {
      event.preventDefault(); event.stopPropagation();
      go(top, opensBeside(event));
      return;
    }
    // Typing carries on; the card made from the caret steps aside.
    truncate(0);
  };

  onMount(() => {
    void document.fonts.ready.then(() => setFontsReady(true));
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerdown', touchStart, true);
    document.addEventListener('pointermove', touchMove, { passive: true });
    document.addEventListener('pointerup', touchEnd, true);
    document.addEventListener('pointercancel', touchEnd, true);
    document.addEventListener('contextmenu', touchContext, true);
    document.addEventListener('click', touchClick, true);
    document.addEventListener('keydown', keydown, true);
  });
  onCleanup(() => {
    clearTimeout(pending); clearTimeout(closing);
    cancelHold();
    document.removeEventListener('pointerover', over);
    document.removeEventListener('pointerout', out);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('keydown', keydown, true);
    document.removeEventListener('pointerdown', touchStart, true);
    document.removeEventListener('pointermove', touchMove);
    document.removeEventListener('pointerup', touchEnd, true);
    document.removeEventListener('pointercancel', touchEnd, true);
    document.removeEventListener('contextmenu', touchContext, true);
    document.removeEventListener('click', touchClick, true);
  });

  return <For each={stack()}>{(entry, index) => {
    const [ready, setReady] = createSignal(false);
    const pane = entry.link?.closest<HTMLElement>('.pane[data-pane]') ?? (entry.pane ? document.querySelector<HTMLElement>(`.pane[data-pane="${entry.pane}"]`) : null);
    return <Popup anchor={entry.anchor} bounds={() => pane?.isConnected ? pane.getBoundingClientRect() : null} ready={ready() && fontsReady()} fixedSize={!pinned().has(entry.key)}
      label="Reference preview" class={`reference-preview${pinned().has(entry.key) ? ' pinned' : ''}`} width={WIDTH} autofocus={false} onDismiss={() => truncate(index())}>
      <div class="reference-preview-card" ref={element => { entry.panel = element; }}
        onPointerEnter={() => clearTimeout(closing)} onPointerLeave={scheduleClose}>
        <ReferenceCard id={entry.id} citation={entry.citation} locator={entry.locator} notebook={props.notebook} pinned={pinned().has(entry.key)} keyboard={entry.keyboard}
          onReady={() => setReady(true)} onTogglePin={() => togglePin(entry)} onOpen={beside => go(entry, beside)}
          onNested={(target, beside) => { setStack([]); props.onOpen(target, beside, entry.pane); }} />
      </div>
    </Popup>;
  }}</For>;
}

/** Read authored prose, not field labels; only a field-only page falls back to its actual values. */
function proseRows(doc: PageDocument, parent: string, excluded: string | null, fieldName: (id: string) => string | undefined, limit: number): TreeRow[] {
  doc.outline.version(); doc.archivedVersion();
  const outline = doc.outline;
  const start = parent === doc.pageId ? 0 : outline.indexOf(parent) + 1;
  if (parent !== doc.pageId && start === 0) return [];
  const end = parent === doc.pageId ? outline.size() : outline.subtreeEnd(start - 1);
  const rows: TreeRow[] = [];
  const fallback: TreeRow[] = [];
  const addFallback = (id: string) => { if (fallback.length < limit) fallback.push({ id, depth: 0, role: 'body' }); };
  for (let index = start; index < end && rows.length < limit;) {
    const id = outline.idAt(index);
    if (doc.isArchived(id) || id === excluded) { index = outline.subtreeEnd(index); continue; }
    const block = doc.block(id);
    if (block?.relation) { index = outline.subtreeEnd(index); continue; }
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
  citation?: boolean;
  locator?: string;
  notebook: NotebookClient;
  pinned: boolean;
  keyboard: boolean;
  onReady(): void;
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
  const [citationSource] = createResource(() => target()?.revision !== 0 && props.citation && state()?.source ? [props.id, sourceReadsVersion(props.notebook)] as const : false, ([id]) => referenceSource(props.notebook, id));
  const [fieldList] = createResource(() => doc()?.status() === 'ready' ? props.notebook.changeSequence() : false, () => props.notebook.api.fields());
  const gloss = createMemo(() => { const value = doc(); return value?.status() === 'ready' && isPage() ? glossEntry(value, id => fieldRole(fieldList()?.fields.find(field => field.id === id)) === 'standfirst') : null; });
  const summary = createMemo(() => { const value = doc(); return value && gloss() ? glossText(value, gloss()) : ''; });
  const summaryId = createMemo(() => { const entry = gloss(); return entry ? doc()?.outline.children(entry)[0] : undefined; });
  const fieldNames = createMemo(() => new Map((fieldList.error ? [] : fieldList()?.fields ?? []).map(field => [field.id, field.name])));
  const fieldName = (id: string) => fieldNames().get(id);
  const readingFields = createMemo(() => state()?.position && doc()?.status() === 'ready' ? positionFields(doc()!, props.id, fieldName) : []);
  const rows = createMemo(() => {
    const value = doc();
    if (value?.status() !== 'ready' || (isPage() && !props.pinned && summary())) return [];
    if (state()?.position) {
      const gist = readingFields().find(field => fieldRole(fieldList()?.fields.find(definition => definition.id === field.fieldId)) === 'standfirst');
      return [...(gist?.valueId ? [{ id: gist.valueId, depth: 0, role: 'body' as const }] : []),
        ...readingPassages(value, props.id, gist?.value, fieldName).slice(0, BLOCK_ROWS).map(row => ({ id: row.id, depth: 0, role: 'body' as const }))];
    }
    return isPage() ? proseRows(value, value.pageId, gloss(), fieldName, props.pinned ? BLOCK_ROWS : PAGE_ROWS) : blockContextRows(value, props.id, BLOCK_ROWS);
  });
  // One subject query provides the count; the referenced pages are opened only after pinning.
  const [positions] = createResource(() => target() && target()?.revision !== 0 && isPage() ? props.id : false, subject => props.notebook.api.positions({ subject }));
  const positionRows = () => positions.error ? [] : positions()?.rows ?? [];
  const [references] = createResource(() => target()?.revision !== 0 ? props.id : false, async id => {
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
    positions.error ? 'Perspectives unavailable' : positionRows().length ? `${positionRows().length} ${positionRows().length === 1 ? 'perspective' : 'perspectives'}` : '',
    referenceCount(),
  ].filter(Boolean).join(' · '));
  // Loading placeholders and late field/count requests must never size a painted slip.
  createEffect(() => {
    const block = target();
    const status = doc()?.status();
    if (block === undefined || block && (!status || status === 'loading')) return;
    if (fieldList.loading || positions.loading || references.loading || citationSource.loading) return;
    props.onReady();
  });
  const [clipped, setClipped] = createSignal(false);
  let body: HTMLDivElement | undefined;
  // The body's max-height pins its own box, so growth shows up only on its rows.
  const observer = new ResizeObserver(() => { if (body) setClipped(body.scrollHeight > body.clientHeight + 1); });
  onCleanup(() => observer.disconnect());
  return <Show when={target() !== undefined} fallback={<p class="reference-preview-message">Loading reference…</p>}>
    <Show when={target()} fallback={<p class="reference-preview-message">This reference points to an atom that was deleted or never synced here.</p>}>{block => <>
      <header class="reference-preview-header">
        <div class="reference-preview-topline">
          <div class="reference-preview-crumbs"><Show when={!citationSource.error && citationSource()} fallback={<BlockBreadcrumb block={block()} notebook={props.notebook} />}>{source => <>{source().siglum}<Show when={props.locator}>{' · '}{props.locator}</Show></>}</Show></div>
          <Button class="reference-preview-pin" aria-pressed={props.pinned} title={props.pinned ? 'Unpin reference preview' : 'Pin reference preview · ⌘'} onClick={props.onTogglePin}>
            {props.pinned ? 'Unpin' : 'Pin'}<Show when={!props.pinned}><kbd>⌘</kbd></Show>
          </Button>
        </div>
        <div class="reference-preview-title">
          <Show when={state()?.position} fallback={<Show when={isPage()} fallback={<span class="reference-preview-kind">Atom</span>}><h2>{displayTitle(block().text, id => props.notebook.lookup(id)) || 'Untitled'}</h2></Show>}>
            <h2><BlockText text={block().text} notebook={props.notebook} interactive={false} /></h2>
          </Show>
        </div>
        <Show when={summary()}><p class="reference-preview-gloss"><BlockText text={doc()?.block(summaryId() ?? '')?.text ?? ''} blockId={summaryId()} notebook={props.notebook} onOpen={props.onNested} /></p></Show>
        <Show when={readingFields().find(field => field.name.trim().toLowerCase() === 'work')?.value}>{work => <p class="reference-preview-reading-source"><BlockText text={work()} notebook={props.notebook} onOpen={props.onNested} /></p>}</Show>
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
            <Show when={props.pinned && positions.loading}><p class="reference-preview-message" role="status">Loading perspectives…</p></Show>
            <Show when={props.pinned && positions.error}><p class="reference-preview-message" role="alert">Couldn’t load perspectives. The atom preview is still available.</p></Show>
            <Show when={fieldList.error}><p class="reference-preview-message" role="alert">Couldn’t load field definitions.</p></Show>
            <Show when={!isPage() || !fieldList.loading} fallback={<p class="reference-preview-message" role="status">Loading preview…</p>}>
              <Show when={rows().length} fallback={<p class="reference-preview-message">{isPage() ? summary() ? 'No further text on this atom.' : 'Empty atom.' : 'Atom not found in its outline.'}</p>}>
                <div ref={element => { body = element; observer.observe(element); }} class={`reference-preview-body${isPage() || state()?.position ? ' prose' : ''}${props.pinned ? ' scrollable' : clipped() ? ' clipped' : ''}`}>
                  <BlockTree rows={rows()} block={id => doc()?.block(id)} notebook={props.notebook} onOpen={props.onNested} prose={isPage() || !!state()?.position} rowRef={element => observer.observe(element)} />
                </div>
              </Show>
            </Show>
          </Show>
        }>
          <Show when={fieldList.error}><p class="reference-preview-message" role="alert">Couldn’t load perspective fields.</p></Show>
          <PinnedReadings rows={positionRows()} notebook={props.notebook} fieldName={fieldName} standfirst={id => fieldRole(fieldList()?.fields.find(field => field.id === id)) === 'standfirst'} onOpen={props.onNested} />
          <Show when={positionRows().length >= 2}>
            <Button class="reference-preview-compare" onClick={event => props.onNested({ kind: 'compare', subjectId: props.id }, opensBeside(event))}>Compare perspectives →</Button>
          </Show>
        </Show>
      </Show>
      <footer class="reference-preview-footer">
        <span class="reference-preview-counts">{counts()}</span>
        <span class="reference-preview-spacer" />
        <Button onClick={() => props.onOpen(true)}>Beside<Show when={props.keyboard}><kbd>{besideKey}↵</kbd></Show></Button>
        <Button class="primary" onClick={() => props.onOpen(false)}>{isPage() ? 'Open' : 'Go to atom'}<Show when={props.keyboard}><kbd>↵</kbd></Show></Button>
      </footer>
    </>}</Show>
  </Show>;
}

/** Only a pinned slip holds other pages open; summaries and expanded readings follow their live documents. */
function PinnedReadings(props: {
  rows: readonly PositionRow[];
  notebook: NotebookClient;
  fieldName(id: string): string | undefined;
  standfirst(id: string): boolean;
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
      gist: fields.find(field => props.standfirst(field.fieldId))?.value,
      gistId: fields.find(field => props.standfirst(field.fieldId))?.valueId,
      work: fields.find(field => field.name.trim().toLowerCase() === 'work'),
      account: fields.find(field => field.name.trim().toLowerCase() === 'account'),
      source: ready ? positionSource(doc, row.block.block.id, props.fieldName) : null,
      shape: fields.find(field => field.name.trim().toLowerCase() === 'shape')?.value,
      prose: ready ? readingPassages(doc, row.block.block.id, fields.find(field => props.standfirst(field.fieldId))?.value, props.fieldName).slice(0, BLOCK_ROWS) : [],
    };
  }));
  const siglumRecords = createCitedSources(props.notebook, () => [...new Set(readings().map(reading => reading.source).filter(id => id !== null))]);
  const sigla = createMemo(() => citedSigla(siglumRecords()));

  return <section class="reference-preview-readings" aria-label="Perspectives">
    <div class="reference-preview-section-heading"><span>Perspectives</span><span class="reference-preview-rule" /><span>{props.rows.length}</span></div>
    <For each={readings()}>{reading => {
      const id = reading.row.block.block.id;
      const holderName = createMemo(() => {
        const holderId = reading.doc.status() === 'ready' ? reading.doc.block(id)?.position?.holder_id ?? null : reading.row.holder_id;
        if (!holderId) return 'No holder';
        const holder = props.notebook.lookup(holderId)();
        return holder === undefined ? 'Loading holder…' : holder?.text || 'Unavailable holder';
      });
      const summaryId = createMemo(() => reading.gist ? reading.gistId : reading.prose[0]?.id ?? id);
      const summary = createMemo(() => reading.doc.block(summaryId() ?? id)?.text || reading.row.block.block.text);
      const open = (beside: boolean) => props.onOpen({ kind: 'page', pageId: reading.row.block.page.id, blockId: id }, beside);
      return <article class="reference-preview-reading" classList={{ selected: selected() === id }} data-reading={id}>
        <div class="reference-preview-reading-heading">
          <Show when={reading.source && sigla().get(reading.source)}>{mark => <span class="reference-preview-siglum" title={props.notebook.lookup(reading.source!)()?.text}>{mark()}</span>}</Show>
          <Button class="reference-preview-holder" aria-expanded={reading.prose.length ? selected() === id : undefined}
            title={reading.prose.length ? `Expand this perspective · ${besideHint}` : `Open this perspective · ${besideHint}`}
            onClick={event => opensBeside(event) || !reading.prose.length ? open(opensBeside(event)) : setSelected(value => value === id ? null : id)}>
            <span>{holderName()}</span>
            <Show when={reading.shape}>{shape => <ShapeGlyph value={shape()} />}</Show>
            <Show when={reading.prose.length}><span class="reference-preview-expand" aria-hidden="true">{selected() === id ? '−' : '+'}</span></Show>
          </Button>
        </div>
        <Show when={reading.work?.value}>{work => <p class="reference-preview-reading-source"><BlockText text={work()} blockId={reading.work?.valueId ?? undefined} notebook={props.notebook} onOpen={props.onOpen} /></p>}</Show>
        <Show when={reading.account?.value}>{account => <p class="reference-preview-reading-source"><span class="relation-label">Account</span> <BlockText text={account()} blockId={reading.account?.valueId ?? undefined} notebook={props.notebook} onOpen={props.onOpen} /></p>}</Show>
        <Show when={reading.doc.status() === 'ready'} fallback={
          <p class="reference-preview-reading-message" role={reading.doc.status() === 'loading' ? 'status' : 'alert'}>{reading.doc.status() === 'loading' ? 'Loading perspective…' : reading.doc.statusMessage()}</p>
        }>
          <Show when={summary()}>{text => <p class="reference-preview-gist"><BlockText text={text()} blockId={summaryId() ?? undefined} notebook={props.notebook} onOpen={props.onOpen} /></p>}</Show>
        </Show>
        <OutgoingRelations rows={reading.doc.status() === 'ready' ? positionRelations(reading.doc, id) : []} notebook={props.notebook} onOpen={props.onOpen} />
        <Show when={selected() === id}>
          <div class="reference-preview-reading-detail">
            <Show when={reading.doc.status() === 'ready'}>
              <Show when={reading.source}>{source =>
                <Button class="reference-preview-reading-source" title={`Open source · ${besideHint}`} disabled={!props.notebook.lookup(source())()}
                  onClick={event => {
                    const block = props.notebook.lookup(source())();
                    if (block) props.onOpen({ kind: 'page', pageId: block.page_id, blockId: block.kind === 'block' ? block.id : undefined }, opensBeside(event));
                  }}>
                  <Show when={props.notebook.lookup(source())() !== undefined} fallback="Loading source…">{props.notebook.lookup(source())()?.text || 'Unavailable source'}</Show>
                </Button>
              }</Show>
              <For each={reading.prose}>{row => <p class="reference-preview-reading-prose"><BlockText text={reading.doc.block(row.id)?.text ?? ''} blockId={row.id} notebook={props.notebook} onOpen={props.onOpen} /></p>}</For>
              <Show when={!reading.prose.length}><p class="reference-preview-reading-message">No further text in this perspective.</p></Show>
            </Show>
            <Button class="reference-preview-open-reading" onClick={event => open(opensBeside(event))}>Open perspective →</Button>
          </div>
        </Show>
      </article>;
    }}</For>
  </section>;
}
