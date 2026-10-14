import { untrack } from 'solid-js';
import type { PageDocument } from '../document/contract';
import { fieldEntryId } from '../table/query';

/** The built-in field whose value is a page's one- or two-sentence hover form. */
export const GLOSS_FIELD = 'gloss';

/**
 * The page's opening summary: its first top-level entry accepted by the field predicate.
 * Text follows structural changes; the field predicate stays reactive as definitions load or change.
 */
export function glossEntry(doc: PageDocument, isGloss: (fieldId: string) => boolean): string | null {
  const children = doc.outline.children(doc.pageId);
  return children.find(id => { const field = fieldEntryId(untrack(() => doc.block(id)?.text ?? '')); return !!field && isGloss(field); }) ?? null;
}

/** The gloss text: the entry's first value. */
export function glossText(doc: PageDocument, entry: string | null): string {
  const value = entry ? doc.outline.children(entry)[0] : undefined;
  return value ? doc.block(value)?.text.trim() ?? '' : '';
}
