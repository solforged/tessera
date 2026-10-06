import { untrack } from 'solid-js';
import type { PageDocument } from '../document/contract';
import { fieldEntryId } from '../table/query';

/** The built-in field whose value is a page's one- or two-sentence hover form. */
export const GLOSS_FIELD = 'Gloss';
export const isGlossName = (name: string | undefined) => name?.trim().toLowerCase() === 'gloss';
/** A position's gist: its one-line summary, shown under the holder at the perspectives depth. */
export const isGistName = (name: string | undefined) => name?.trim().toLowerCase() === 'gist';

/**
 * The page's gloss entry: its first top-level block that is an entry for the Gloss field. Text is read
 * untracked, so callers rerun on structure; converting shorthand inserts the value, a structural change.
 */
export function glossEntry(doc: PageDocument, isGloss: (fieldId: string) => boolean): string | null {
  const children = doc.outline.children(doc.pageId);
  return untrack(() => children.find(id => { const field = fieldEntryId(doc.block(id)?.text ?? ''); return !!field && isGloss(field); })) ?? null;
}

/** The gloss text: the entry's first value. */
export function glossText(doc: PageDocument, entry: string | null): string {
  const value = entry ? doc.outline.children(entry)[0] : undefined;
  return value ? doc.block(value)?.text.trim() ?? '' : '';
}
