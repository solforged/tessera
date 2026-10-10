import type { Citation, FieldDefinition } from '../api/types';
import type { PageDocument } from '../document/contract';
import { sourceFieldName } from '../outline/source';

/** Keep each editable subtree intact while showing source fields first and highlights in reading order. */
export function sourceReadingOrder(doc: PageDocument, visible: readonly string[], definitions: ReadonlyMap<string, FieldDefinition>): string[] {
  const groups: { ids: string[]; field: boolean; citation?: Citation }[] = [];
  for (const id of visible) {
    const block = doc.block(id);
    if (!block) continue;
    if (block.parentId === doc.pageId || !groups.length) {
      groups.push({ ids: [id], field: !!sourceFieldName(block.text, definitions), citation: block.citations.filter(c => c.source_id === doc.pageId).sort((a, b) => a.ordinal - b.ordinal || a.start.offset - b.start.offset)[0] });
    } else groups.at(-1)!.ids.push(id);
  }
  groups.sort((a, b) => Number(b.field) - Number(a.field) || (a.citation && b.citation ? a.citation.ordinal - b.citation.ordinal || a.citation.start.offset - b.citation.start.offset : Number(!!a.citation) - Number(!!b.citation)));
  return groups.flatMap(group => group.ids);
}
