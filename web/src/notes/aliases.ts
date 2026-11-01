import type { PageDocument } from '../document/contract';
import { foldName } from '../outline/names';
import { fieldEntryId } from '../table/query';

type AliasDocument = Pick<PageDocument, 'pageId' | 'outline' | 'block'>;

/**
 * Whether entry `id`, of the field named `fieldName`, is one of a note's populated top-level Aliases entries. The
 * header's ALSO line presents those, so Outline and Read both leave them out of the body. Sources and the Fields page
 * keep ordinary field presentation.
 */
export function aliasesInHeader(doc: Pick<PageDocument, 'pageId' | 'outline' | 'block' | 'root' | 'isArchived'>, id: string, fieldName: string | undefined): boolean {
  const root = doc.root();
  return root?.kind === 'page' && !root.source && root.text.toLowerCase() !== 'fields'
    && doc.outline.parentOf(id) === doc.pageId && foldName(fieldName ?? '') === 'aliases'
    && doc.outline.children(id).some(value => !doc.isArchived(value) && !!doc.block(value)?.text.trim());
}

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
