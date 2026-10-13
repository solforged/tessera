import type { BlockState, PageDocument } from '../document/contract';
import { fieldEntryId, matchFieldEntry } from '../table/query';

/** A field entry directly under a position, with its first value. */
export interface PositionField { name: string; fieldId: string; entryId: string; valueId: string | null; value: string }

const STABLE_REFERENCE = /\[\[([0-9A-HJKMNP-TV-Z]{26})(?:\|[^\]]*)?\]\]/i;

/** The field entries directly under a position, in outline order. `fieldName` resolves a definition ID. */
export function positionFields(doc: PageDocument, id: string, fieldName: (fieldId: string) => string | undefined): PositionField[] {
  const result: PositionField[] = [];
  for (const entryId of doc.outline.children(id)) {
    const fieldId = fieldEntryId(doc.block(entryId)?.text ?? '');
    const name = fieldId ? fieldName(fieldId) : undefined;
    if (!fieldId || !name || doc.isArchived(entryId) || doc.block(entryId)?.relation) continue;
    const valueId = doc.outline.children(entryId)[0] ?? null;
    result.push({ name, fieldId, entryId, valueId, value: valueId ? doc.block(valueId)?.text.trim() ?? '' : '' });
  }
  return result;
}

/** The source a position names: the page its Work field references, else the first passage cited beneath it. */
export function positionSource(doc: PageDocument, id: string, fieldName: (fieldId: string) => string | undefined): string | null {
  const work = positionFields(doc, id, fieldName).find(field => field.name.trim().toLowerCase() === 'work');
  const named = work ? STABLE_REFERENCE.exec(work.value)?.[1] : undefined;
  if (named) return named;
  const outline = doc.outline;
  const index = outline.indexOf(id);
  if (index < 0) return null;
  for (let at = index + 1, end = outline.subtreeEnd(index); at < end; at++) {
    const citation = doc.block(outline.idAt(at))?.citations[0];
    if (citation) return citation.source_id;
  }
  return null;
}

export interface ReadingPassage { id: string; text: string; heading: boolean }

/** Authored prose excludes fields, nested readings and an edge's entire reasoning subtree. */
export function readingPassages(doc: PageDocument, id: string, gist: string | undefined, fieldName: (id: string) => string | undefined): ReadingPassage[] {
  doc.outline.version(); doc.archivedVersion();
  const outline = doc.outline;
  const start = outline.indexOf(id);
  const passages: ReadingPassage[] = [];
  if (start < 0) return passages;
  for (let at = start + 1, end = outline.subtreeEnd(start); at < end;) {
    const blockId = outline.idAt(at);
    const block = doc.block(blockId);
    const field = fieldEntryId(block?.text ?? '');
    if (!block || doc.isArchived(blockId) || (field && fieldName(field)) || matchFieldEntry(block.text) || block.position || block.relation) {
      at = outline.subtreeEnd(at);
      continue;
    }
    const text = block.text.trim();
    if (text && text !== gist?.trim()) passages.push({ id: blockId, text: block.text, heading: block.heading !== null });
    at++;
  }
  return passages;
}

/** Outgoing edges may sit below ordinary reasoning blocks, not just among direct children. */
export function positionRelations(doc: PageDocument, id: string): BlockState[] {
  doc.outline.version(); doc.archivedVersion();
  const start = doc.outline.indexOf(id);
  if (start < 0) return [];
  const rows: BlockState[] = [];
  for (let at = start + 1, end = doc.outline.subtreeEnd(start); at < end;) {
    const block = doc.block(doc.outline.idAt(at));
    if (!block || doc.isArchived(block.id)) { at = doc.outline.subtreeEnd(at); continue; }
    if (block.relation?.source_id === id) rows.push(block);
    at++;
  }
  return rows;
}
