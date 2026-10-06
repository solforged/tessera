import type { Caret, PageDocument, TextRange } from '../document/contract';
import type { OutlineIndex } from '../document/outline-index';
import type { Depth } from '../shell/contract';
import { fieldEntryId } from '../table/query';

/** The sole leaf value that can replace a known field entry in the visible list. */
export function inlineFieldValue(doc: PageDocument, id: string, definitions: ReadonlyMap<string, unknown>): string | null {
  const field = fieldEntryId(doc.block(id)?.text ?? '');
  if (!field || !definitions.has(field)) return null;
  const children = doc.outline.children(id);
  return children.length === 1 && !doc.outline.children(children[0]!).length ? children[0]! : null;
}

export interface DepthFilter {
  stop: Depth;
  /** The page's gloss entry, shown at every stop. */
  gloss: string | null;
  /** Positions show at the perspectives stop under a shown heading, with only their gist beneath them. */
  position(id: string): boolean;
  /** A position's gist entry. */
  gist(id: string): boolean;
}

/** Rebuilt for structure, folds, archive visibility, zoom, depth or inline-field eligibility. A zoomed page shows in full. */
export function visibleIds(doc: PageDocument, zoom: string | null, folds: ReadonlySet<string>, archived: boolean, inlineFields?: ReadonlySet<string>, depth?: DepthFilter): string[] {
  const outline = doc.outline;
  const result: string[] = [];
  const start = zoom ? outline.indexOf(zoom) : 0;
  const end = zoom && start >= 0 ? outline.subtreeEnd(start) : outline.size();
  const stop = zoom || !depth ? 'full' : depth.stop;
  // One subscription for every archived flag; a tracked read per row would cost a subscription per row.
  if (!archived) doc.archivedVersion();
  let hiddenDepth: number | null = null;
  // Below full: rows deeper than `openDepth` show with their subtree (gloss, opening text, a gist);
  // `sectionDepth` is the deepest shown heading, under which only headings and positions appear;
  // `positionDepth` is a shown position, under which only its gist appears.
  let openDepth: number | null = null;
  let sectionDepth = -1;
  let positionDepth: number | null = null;
  let opening = true;
  (outline as OutlineIndex).each(Math.max(0, start), end, row => {
    if (hiddenDepth !== null && row.depth > hiddenDepth) return;
    hiddenDepth = null;
    if (!archived && row.id !== zoom && doc.isArchived(row.id)) {
      hiddenDepth = row.depth;
      return;
    }
    if (stop !== 'full' && (openDepth === null || row.depth <= openDepth)) {
      openDepth = null;
      if (positionDepth !== null && row.depth <= positionDepth) positionDepth = null;
      if (positionDepth !== null) {
        if (row.depth === positionDepth + 1 && depth!.gist(row.id)) openDepth = row.depth;
        else { hiddenDepth = row.depth; return; }
      } else {
        if (row.depth <= sectionDepth) sectionDepth = row.depth - 1;
        const heading = !!doc.block(row.id)?.heading;
        if (row.depth === 0 && heading) opening = false;
        if (row.id === depth!.gloss || (stop !== 'gloss' && opening && row.depth === 0)) openDepth = row.depth;
        else if (stop === 'perspectives' && heading && row.depth === sectionDepth + 1) sectionDepth = row.depth;
        else if (stop === 'perspectives' && row.depth === sectionDepth + 1 && depth!.position(row.id)) positionDepth = row.depth;
        else { hiddenDepth = row.depth; return; }
      }
    }
    if (!inlineFields?.has(row.id)) result.push(row.id);
    if (folds.has(row.id)) hiddenDepth = row.depth;
  });
  return result;
}

export function selectionIds(ids: readonly string[], range: TextRange): string[] {
  const a = ids.indexOf(range.anchor.id);
  const b = ids.indexOf(range.head.id);
  if (a < 0 || b < 0) return [];
  return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export function orderedRange(doc: PageDocument, range: TextRange): [Caret, Caret] {
  const a = doc.outline.indexOf(range.anchor.id);
  const b = doc.outline.indexOf(range.head.id);
  return a < b || (a === b && range.anchor.offset <= range.head.offset)
    ? [range.anchor, range.head] : [range.head, range.anchor];
}

export function selectedText(doc: PageDocument, ids: readonly string[], range: TextRange): string {
  const [start, end] = orderedRange(doc, range);
  return selectionIds(ids, range).map(id => {
    const text = doc.block(id)?.text ?? '';
    return text.slice(id === start.id ? start.offset : 0, id === end.id ? end.offset : undefined);
  }).join('\n');
}

/** Subtree commands accept roots only, never both a parent and its child. */
export function selectionRoots(doc: PageDocument, ids: readonly string[]): string[] {
  const result: string[] = [];
  let end = -1;
  for (const id of ids) {
    const index = doc.outline.indexOf(id);
    if (index >= end) {
      result.push(id);
      end = doc.outline.subtreeEnd(index);
    }
  }
  return result;
}
