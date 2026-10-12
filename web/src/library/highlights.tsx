import { For, Show, createSignal, onCleanup } from 'solid-js';
import type { Component } from 'solid-js';
import { ulid } from 'ulid';
import type { ApiClient } from '../api/client';
import type { Citation, HighlightRow, TocEntry } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { documentReady } from '../tasks/JournalAgenda';
import { CardComposer } from '../review/CardComposer';
import { Button } from '../ui/Button';
import type { MenuItem } from '../ui/Menu';
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
export function createHighlightActions(notebook: NotebookClient, onOpen: (target: OpenTarget, beside: boolean) => void, onError: (message: string) => void, onProcessed?: (row: HighlightRow) => void) {
  const documents = new Map<string, PageDocument>();
  const tagPrompt = createHighlightTagPrompt();
  const [lastDocument, setLastDocument] = createSignal<PageDocument>();
  const [cardDraft, setCardDraft] = createSignal<{ document: PageDocument; row: HighlightRow; anchor: DOMRect }>();
  let disposed = false;
  onCleanup(() => { disposed = true; for (const doc of documents.values()) doc.release(); });
  const menu = async (row: HighlightRow, copyText?: string): Promise<HighlightMenu> => {
    const id = row.citation.block_id, pageId = row.block.page.id;
    let doc = documents.get(pageId);
    if (!doc) { doc = notebook.open(pageId); documents.set(pageId, doc); }
    await documentReady(doc);
    const document = doc;
    const hasNote = document.outline.children(id).some(child => !document.block(child)?.archived && !!document.block(child)?.text.trim());
    const run = async (action: 'note' | 'card' | 'triage' | 'remove') => {
      await documentReady(document);
      if (disposed) return;
      if (action === 'card') {
        const anchor = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : globalThis.document.body;
        setCardDraft({ document, row, anchor: anchor.getBoundingClientRect() });
        return;
      }
      let caretId: string | undefined;
      if (action === 'note') {
        // Open the first written note, else reuse a blank one left from an earlier Add note.
        const notes = document.outline.children(id).filter(child => !document.block(child)?.archived);
        caretId = notes.find(child => !!document.block(child)?.text.trim()) ?? notes.find(child => document.block(child)?.text === '' && !document.outline.children(child).length);
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
      await document.flush();
      if (disposed) return;
      if (caretId) onOpen({ kind: 'page', pageId, blockId: id, caretId, caretOffset: 0 }, true);
      if (action === 'triage') onProcessed?.(row);
    };
    const fail = (reason: unknown) => { if (!disposed) onError(reason instanceof Error ? reason.message : String(reason)); };
    const fire = (action: Parameters<typeof run>[0]) => { void run(action).catch(fail); };
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
      { label: hasNote ? 'Open note' : 'Add note', action: () => fire('note') },
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
    Popups: () => <><tagPrompt.TagPopup /><Show keyed when={cardDraft()}>{draft => <CardComposer anchor={draft.anchor} initialBack={draft.row.citation.quote}
      context={<p class="muted">{draft.row.source_title} · ¶{draft.row.citation.ordinal + 1}</p>} onDismiss={() => setCardDraft(undefined)}
      onSave={async text => {
        const doc = draft.document, parentId = draft.row.citation.block_id;
        await documentReady(doc);
        const id = ulid();
        await notebook.commit([{ op: 'insert', id, parent_id: parentId, after: doc.outline.children(parentId).at(-1) ?? null, text, heading: null }], 'Make card from highlight', [doc.pageId]);
        setLastDocument(undefined);
        if (!disposed) onOpen({ kind: 'page', pageId: draft.row.block.page.id, blockId: parentId, caretId: id, caretOffset: 0 }, true);
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
