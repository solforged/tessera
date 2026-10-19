import { For, Show, createSignal, onCleanup } from 'solid-js';
import type { Component } from 'solid-js';
import type { ApiClient } from '../api/client';
import type { Citation, HighlightRow, TocEntry } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { pendingCaretInput } from '../shell/pending-caret';
import { documentReady } from '../tasks/JournalAgenda';
import { CardComposer } from '../review/CardComposer';
import { parseCardText } from '../review/card-text';
import { Button } from '../ui/Button';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { createHighlightTagPrompt } from './HighlightTagPopup';
import './library.css';

export const highlightColors = ['yellow', 'green', 'blue', 'red', 'purple'] as const;
export const [linkedCitation, setLinkedCitation] = createSignal<string | null>(null);

export interface HighlightMenu {
  items: MenuItem[];
  Header: Component<{ onDismiss(): void }>;
  openNote(): void;
  makeCard(): void;
  toggleProcessed(): Promise<void>;
  tag(): void;
  setColor(color: Citation['color']): void;
}

export type HighlightSection = TocEntry & { ordinal: number };

/** Resolve chapter boundaries in the citation's snapshot, not the newest version. */
export async function highlightSections(api: ApiClient, snapshotId: string, signal?: AbortSignal): Promise<HighlightSection[]> {
  const { toc } = await api.passages(snapshotId, 0, 1, signal);
  return toc.filter((entry): entry is HighlightSection => entry.ordinal !== null).sort((a, b) => a.ordinal - b.ordinal);
}

/** Keep edited documents alive with the surface so their undo history survives the menu. */
export function createHighlightActions(notebook: NotebookClient, onOpen: (target: OpenTarget, beside: boolean) => void, onError: (message: string) => void, onProcessed?: (row: HighlightRow) => void, onRemoved?: () => void) {
  const documents = new Map<string, PageDocument>();
  const tagPrompt = createHighlightTagPrompt();
  const [lastDocument, setLastDocument] = createSignal<PageDocument>();
  const [cardDraft, setCardDraft] = createSignal<{ document: PageDocument; row: HighlightRow; anchor?: DOMRect }>();
  const [documentsVersion, setDocumentsVersion] = createSignal(0);
  const [removal, setRemoval] = createSignal<{ anchor: DOMRect; written: number; references: number; remove(): Promise<void> }>();
  let disposed = false;
  onCleanup(() => { disposed = true; for (const doc of documents.values()) doc.release(); });
  const loadDocument = async (pageId: string) => {
    let doc = documents.get(pageId);
    if (!doc) {
      doc = notebook.open(pageId);
      documents.set(pageId, doc);
      await documentReady(doc);
      if (!disposed) setDocumentsVersion(value => value + 1);
    } else await documentReady(doc);
    return doc;
  };
  const notes = (doc: PageDocument, id: string) => doc.outline.children(id).filter(child => {
    const block = doc.block(child);
    return block && !block.archived && !block.templateCards && !parseCardText(block.text).cards.length;
  });
  const menu = async (row: HighlightRow, copyText?: string): Promise<HighlightMenu> => {
    const id = row.citation.block_id, pageId = row.block.page.id;
    const document = await loadDocument(pageId);
    const hasNote = notes(document, id).some(child => !!document.block(child)?.text.trim());
    const run = async (action: 'note' | 'card' | 'triage' | 'remove', confirmed = false, caretSignal?: AbortSignal) => {
      await documentReady(document);
      if (disposed) return;
      if (action === 'card') {
        // Hang the draft from the focused row; a menu item or the page body leaves it near the top of the viewport.
        const focused = globalThis.document.activeElement;
        const anchor = focused instanceof HTMLElement && focused !== globalThis.document.body && !focused.closest('.popup') ? focused.getBoundingClientRect() : undefined;
        setCardDraft({ document, row, anchor });
        return;
      }
      if (action === 'remove' && !confirmed) {
        const index = document.outline.indexOf(id), end = document.outline.subtreeEnd(index);
        const ids = new Set<string>([id]);
        let written = 0;
        for (let at = index + 1; at < end; at++) {
          const child = document.outline.idAt(at);
          ids.add(child);
          if (document.block(child)?.text.trim()) written++;
        }
        const references = (await notebook.api.referenceCounts(pageId)).filter(value => ids.has(value.block_id)).reduce((sum, value) => sum + value.count, 0);
        if (disposed) return;
        if (written || references) {
          const anchor = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : globalThis.document.body;
          setRemoval({ anchor: anchor.getBoundingClientRect(), written, references, remove: () => run('remove', true) });
          return;
        }
      }
      let caretId: string | undefined;
      if (action === 'note') {
        // Open the first written note, else reuse a blank one left from an earlier Add note.
        const children = notes(document, id);
        caretId = children.find(child => !!document.block(child)?.text.trim()) ?? children.find(child => document.block(child)?.text === '' && !document.outline.children(child).length);
        if (!caretId) {
          const result = document.edit({ kind: 'insert', parentId: id, after: document.outline.children(id).at(-1) ?? null, text: '' });
          if (!result.ok) throw new Error(result.reason);
          caretId = result.created[0];
        }
      } else {
        const result = document.edit(action === 'remove' ? { kind: 'delete', ids: [id] } : { kind: 'citationTriage', id, citationId: row.citation.id, triage: row.processed ? 'unprocessed' : 'processed' });
        if (!result.ok) throw new Error(result.reason);
      }
      setLastDocument(document);
      if (action === 'remove') onRemoved?.();
      // The child is already in the shared local document. Delivery must not hold up typing.
      if (caretId && !caretSignal?.aborted) onOpen({ kind: 'page', pageId, blockId: id, caretId, caretOffset: 0 }, true);
      await document.flush();
      if (disposed) return;
      if (action === 'triage') onProcessed?.(row);
    };
    const fail = (reason: unknown) => { if (!disposed) onError(reason instanceof Error ? reason.message : String(reason)); };
    const fire = (action: Parameters<typeof run>[0]) => {
      const cancelInput = action === 'note' ? pendingCaretInput.prepare() : undefined;
      void run(action, false, cancelInput?.signal).catch(reason => { cancelInput?.(); fail(reason); });
    };
    const tag = () => { setLastDocument(document); tagPrompt.open(document, id); };
    const color = document.block(id)?.citations.find(citation => citation.id === row.citation.id)?.color ?? null;
    const setColor = (color: Citation['color']) => {
      void (async () => {
        await documentReady(document);
        const result = document.edit({ kind: 'highlightColor', id, citationId: row.citation.id, color });
        if (!result.ok) throw new Error(result.reason);
        setLastDocument(document);
        await document.flush();
      })().catch(fail);
    };
    const items: MenuItem[] = [
      { label: hasNote ? 'Open atom' : 'Add atom', action: () => fire('note') },
      { label: 'Make card', action: () => fire('card') },
    ];
    if (copyText !== undefined) items.push({ label: 'Copy with citation', action: () => { void navigator.clipboard.writeText(copyText).catch(reason => onError(reason instanceof Error ? reason.message : String(reason))); } });
    items.push(
      { label: row.processed ? 'Mark unprocessed' : 'Mark processed', action: () => fire('triage') },
      { label: 'Add tag…', action: tag },
      { label: 'Remove highlight', danger: true, action: () => fire('remove') },
    );
    const Header: HighlightMenu['Header'] = props => <>
      <p class="highlight-menu-quote">{row.citation.quote}</p>
      <div class="highlight-menu-colors">
        <For each={[...highlightColors, null]}>{value => {
          const label = value ? value[0]!.toUpperCase() + value.slice(1) : 'No colour';
          return <Button class="icon-only" aria-label={label} aria-pressed={color === value} data-menu-key={value ? String(highlightColors.indexOf(value) + 1) : '0'} onClick={() => { props.onDismiss(); setColor(value); }}>
            <span class={`highlight-color-dot ${value ? `highlight-color-${value}` : 'highlight-color-none'}`} aria-hidden="true" />
          </Button>;
        }}</For>
      </div>
    </>;
    return { items, Header, openNote: () => fire('note'), makeCard: () => fire('card'), toggleProcessed: () => run('triage'), tag, setColor };
  };
  return Object.assign(menu, {
    prepare: async (rows: readonly HighlightRow[]) => { await Promise.all([...new Set(rows.filter(row => row.notes > 0).map(row => row.block.page.id))].map(loadDocument)); },
    noteCount: (row: HighlightRow) => {
      documentsVersion();
      const doc = documents.get(row.block.page.id);
      return doc?.status() === 'ready' ? notes(doc, row.citation.block_id).filter(child => !!doc.block(child)?.text.trim()).length : row.notes === 0 ? 0 : undefined;
    },
    Popups: () => <><tagPrompt.TagPopup /><Show keyed when={removal()}>{state => {
      const [busy, setBusy] = createSignal(false);
      const [error, setError] = createSignal('');
      return <Popup anchor={state.anchor} label="Remove highlight" placement="top" onDismiss={() => { if (!busy()) setRemoval(undefined); }}>
        <h3 class="popup-title">Remove highlight?</h3>
        <p>This also deletes {state.written} written child {state.written === 1 ? 'atom' : 'atoms'} and breaks {state.references} incoming {state.references === 1 ? 'reference' : 'references'}. You can undo this from the highlight actions.</p>
        <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
        <div class="popup-actions"><Button disabled={busy()} onClick={() => setRemoval(undefined)}>Cancel</Button><Button class="bordered danger" disabled={busy()} onClick={() => {
          setBusy(true); setError('');
          void state.remove().then(() => { if (!disposed) setRemoval(undefined); }).catch(reason => { if (!disposed) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); } });
        }}>Remove highlight</Button></div>
      </Popup>;
    }}</Show><Show keyed when={cardDraft()}>{draft => <CardComposer anchor={draft.anchor} initialBack={draft.row.citation.quote}
      where={`${draft.row.source_title} · ¶${draft.row.citation.ordinal + 1}`} onDismiss={() => setCardDraft(undefined)}
      onSave={async (text, again) => {
        // Another card keeps the draft open, so only the last one opens its editor.
        const cancelInput = again ? undefined : pendingCaretInput.prepare();
        try {
          const doc = draft.document, parentId = draft.row.citation.block_id;
          await documentReady(doc);
          const result = doc.edit({ kind: 'insert', parentId, after: doc.outline.children(parentId).at(-1) ?? null, text });
          if (!result.ok) throw new Error(result.reason);
          const id = result.created[0]!;
          setLastDocument(doc);
          if (cancelInput) {
            if (!disposed && !cancelInput.signal.aborted) onOpen({ kind: 'page', pageId: draft.row.block.page.id, blockId: parentId, caretId: id, caretOffset: 0 }, true);
            else cancelInput();
          }
          await doc.flush();
        } catch (reason) { cancelInput?.(); throw reason; }
      }} />}</Show></>,
    canUndo: () => lastDocument()?.canUndo() ?? false,
    undo: async () => {
      const doc = lastDocument();
      if (!doc?.canUndo()) return;
      doc.undo();
      await doc.flush();
    },
  });
}
