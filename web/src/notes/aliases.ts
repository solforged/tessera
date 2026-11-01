import type { PageDocument } from '../document/contract';
import { fieldEntryId } from '../table/query';

type AliasDocument = Pick<PageDocument, 'pageId' | 'outline' | 'block'>;

/** A note's live top-level Aliases entries, in outline order; a note may hold several. */
export function aliasEntries(doc: AliasDocument, fieldId: string): string[] {
  return doc.outline.children(doc.pageId).filter(child => {
    const block = doc.block(child);
    return !!block && !block.archived && fieldEntryId(block.text) === fieldId;
  });
}

/** Every nonblank alias those entries hold, in outline order. */
export function aliasNames(doc: AliasDocument, entries: readonly string[]): string[] {
  const names: string[] = [];
  for (const entry of entries) for (const child of doc.outline.children(entry)) {
    const block = doc.block(child);
    const text = block && !block.archived ? block.text.trim() : '';
    if (text) names.push(text);
  }
  return names;
}
