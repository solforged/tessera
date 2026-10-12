import { For, Show } from 'solid-js';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { BlockText } from './BlockText';
import './block-tree.css';

/** One read-only row: `context` is a dimmed ancestor, `focus` the block a reader came for. */
export interface TreeRow { id: string; depth: number; role: 'context' | 'focus' | 'body' }
/** What a row shows, read live from a page document or frozen from a quote. */
export interface TreeBlock { text: string; heading?: number | null }

/** A block keeps its parent and up to `limit` descendants, so the focused passage stays in context. */
export function blockContextRows(doc: PageDocument, id: string, limit: number): TreeRow[] {
  doc.outline.version(); doc.archivedVersion();
  const outline = doc.outline;
  const rows: TreeRow[] = [];
  const index = outline.indexOf(id);
  if (index < 0) return rows;
  const parent = outline.parentOf(id);
  const offset = parent === doc.pageId ? 0 : 1;
  if (offset) rows.push({ id: parent, depth: 0, role: 'context' });
  rows.push({ id, depth: offset, role: 'focus' });
  const base = outline.depth(id) - offset;
  const end = outline.subtreeEnd(index);
  for (let row = index + 1; row < end && rows.length < limit + offset + 1;) {
    const child = outline.idAt(row);
    if (doc.isArchived(child)) { row = outline.subtreeEnd(row); continue; }
    rows.push({ id: child, depth: outline.depth(child) - base, role: 'body' });
    row++;
  }
  return rows;
}

/**
 * A block and its descendants as a small, read-only outline. Live callers pass
 * a `block` reader over an open document, so edits show as they land; quotes
 * pass their frozen rows.
 */
export function BlockTree(props: {
  rows: readonly TreeRow[];
  block(id: string): TreeBlock | undefined;
  notebook: NotebookClient;
  onOpen?(target: OpenTarget, beside: boolean): void;
  /** Pages read as prose without bullets; blocks keep their outline. */
  prose?: boolean;
  rowRef?(element: HTMLElement): void;
}) {
  return <For each={props.rows}>{row => {
    const block = () => props.block(row.id);
    return <div ref={element => props.rowRef?.(element)} class={`block-tree-row ${row.role}`} classList={{ prose: props.prose }} style={{ '--depth': row.depth }}>
      <Show when={!props.prose}><span class="block-tree-bullet" aria-hidden="true" /></Show>
      <div class="block-tree-text" classList={{ 'heading-1': block()?.heading === 1, 'heading-2': block()?.heading === 2, 'heading-3': block()?.heading === 3 }}>
        <BlockText text={block()?.text ?? ''} blockId={row.id} notebook={props.notebook} onOpen={props.onOpen} />
      </div>
    </div>;
  }}</For>;
}
