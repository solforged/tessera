import { onCleanup } from 'solid-js';
import type { ApiClient } from '../api/client';
import type { Citation, HighlightRow, TocEntry } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { documentReady } from '../tasks/JournalAgenda';
import type { MenuItem } from '../ui/Menu';
import { createHighlightTagPrompt } from './HighlightTagPopup';

export const highlightColors = ['yellow', 'green', 'blue', 'red', 'purple'] as const;

export type HighlightSection = TocEntry & { ordinal: number };

/** Resolve chapter boundaries in the citation's snapshot, not the newest version. */
export async function highlightSections(api: ApiClient, snapshotId: string, signal?: AbortSignal): Promise<HighlightSection[]> {
  const { toc } = await api.passages(snapshotId, 0, 1, signal);
  return toc.filter((entry): entry is HighlightSection => entry.ordinal !== null).sort((a, b) => a.ordinal - b.ordinal);
}

/** Keep edited documents alive with the surface so their undo history survives the menu. */
export function createHighlightActions(notebook: NotebookClient, onOpen: (target: OpenTarget, beside: boolean) => void, onError: (message: string) => void) {
  const documents = new Map<string, PageDocument>();
  const tagPrompt = createHighlightTagPrompt();
  let disposed = false;
  onCleanup(() => { disposed = true; for (const doc of documents.values()) doc.release(); });
  const menu = async (row: HighlightRow, copyText?: string): Promise<MenuItem[]> => {
    const id = row.citation.block_id, pageId = row.block.page.id;
    let doc = documents.get(pageId);
    if (!doc) { doc = notebook.open(pageId); documents.set(pageId, doc); }
    await documentReady(doc);
    const document = doc;
    const hasNote = document.outline.children(id).some(child => !!document.block(child)?.text.trim());
    const run = (action: 'note' | 'card' | 'triage' | 'remove') => {
      void (async () => {
        await documentReady(document);
        let caretId: string | undefined;
        if (action === 'note' || action === 'card') {
          caretId = action === 'note' ? document.outline.children(id).find(child => !!document.block(child)?.text.trim()) : undefined;
          if (!caretId) {
            const result = document.edit({ kind: 'insert', parentId: id, after: document.outline.children(id).at(-1) ?? null, text: action === 'card' ? '>> ' : '' });
            if (!result.ok) throw new Error(result.reason);
            caretId = result.created[0];
          }
        } else {
          const result = document.edit(action === 'remove' ? { kind: 'delete', ids: [id] } : { kind: 'citationTriage', id, citationId: row.citation.id, triage: row.processed ? 'unprocessed' : 'processed' });
          if (!result.ok) throw new Error(result.reason);
        }
        await document.flush();
        if (!disposed && caretId) onOpen({ kind: 'page', pageId, blockId: id, caretId, caretOffset: action === 'card' ? 3 : 0 }, true);
      })().catch(reason => { if (!disposed) onError(reason instanceof Error ? reason.message : String(reason)); });
    };
    const color = document.block(id)?.citations.find(citation => citation.id === row.citation.id)?.color ?? null;
    const setColor = (color: Citation['color']) => {
      void (async () => {
        await documentReady(document);
        const result = document.edit({ kind: 'highlightColor', id, citationId: row.citation.id, color });
        if (!result.ok) throw new Error(result.reason);
        await document.flush();
      })().catch(reason => { if (!disposed) onError(reason instanceof Error ? reason.message : String(reason)); });
    };
    const items: MenuItem[] = [
      { label: hasNote ? 'Open note' : 'Add note', action: () => run('note') },
      { label: 'Make card', action: () => run('card') },
    ];
    if (copyText !== undefined) items.push({ label: 'Copy with citation', action: () => { void navigator.clipboard.writeText(copyText).catch(reason => onError(reason instanceof Error ? reason.message : String(reason))); } });
    items.push(
      { label: row.processed ? 'Mark unprocessed' : 'Mark processed', action: () => run('triage') },
      { label: 'Add tag…', action: () => tagPrompt.open(document, id) },
      ...highlightColors.map((value, index): MenuItem => ({ label: value[0]!.toUpperCase() + value.slice(1), section: index === 0 ? 'Colour' : undefined, icon: color === value ? 'check' : undefined, action: () => setColor(value) })),
      { label: 'No colour', icon: color === null ? 'check' : undefined, action: () => setColor(null) },
      { label: 'Remove highlight', danger: true, action: () => run('remove') },
    );
    return items;
  };
  return Object.assign(menu, { TagPopup: tagPrompt.TagPopup });
}
