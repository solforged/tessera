import { createMemo, mapArray } from 'solid-js';
import type { PageDocument } from '../document/contract';
import { relativeDate } from '../tasks/relative-date';

/** Only a whole, unaliased canonical block reference is an embed. */
export function embedTarget(text: string): string | undefined {
  return /^\[\[([0-9A-HJKMNP-TV-Z]{26})\]\]$/.exec(text.trim())?.[1];
}

export function createAddedTargets(doc: PageDocument) {
  const rows = mapArray(() => {
    doc.outline.version();
    return Array.from({ length: doc.outline.size() }, (_, index) => doc.outline.idAt(index));
  }, id => createMemo(() => embedTarget(doc.block(id)?.text ?? '')));
  return createMemo(() => new Set(rows().flatMap(target => {
    const id = target();
    return id ? [id] : [];
  })));
}

/** Adding uses ordinary outline insertion, so order and undo need no sidecar; like Add to today, it fills a trailing empty block first. */
export function addArrival(doc: PageDocument, id: string) {
  const last = doc.outline.children(doc.pageId).at(-1);
  if (last && !doc.block(last)?.text && !doc.outline.children(last).length) return doc.edit({ kind: 'text', id: last, text: `[[${id}]]` });
  return doc.edit({ kind: 'insert', parentId: doc.pageId, after: last ?? null, text: `[[${id}]]` });
}

/** A journal day as a stream names it, by the shared civil-date rule (`Today`, a weekday within six days, then `Oct 16`), measured from `today`. */
export function streamDay(date: string, today: string) {
  const day = relativeDate(date, today);
  return day[0]!.toUpperCase() + day.slice(1);
}
