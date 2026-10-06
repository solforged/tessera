import type { PageDocument } from '../document/contract';
import { fieldEntryId } from '../table/query';

/** A field entry directly under a position, with its first value. */
export interface PositionField { name: string; fieldId: string; entryId: string; valueId: string | null; value: string }

const STABLE_REFERENCE = /\[\[([0-9A-HJKMNP-TV-Z]{26})(?:\|[^\]]*)?\]\]/i;

/** The field entries directly under a position, in outline order. `fieldName` resolves a definition ID. */
export function positionFields(doc: PageDocument, id: string, fieldName: (fieldId: string) => string | undefined): PositionField[] {
  const result: PositionField[] = [];
  for (const entryId of doc.outline.children(id)) {
    const fieldId = fieldEntryId(doc.block(entryId)?.text ?? '');
    const name = fieldId ? fieldName(fieldId) : undefined;
    if (!fieldId || !name || doc.isArchived(entryId)) continue;
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
