import { createMemo, mapArray } from 'solid-js';
import type { PageDocument } from '../document/contract';

/** Only a whole, unaliased canonical block reference is an embed. */
export function embedTarget(text: string): string | undefined {
  return /^\[\[([0-9A-HJKMNP-TV-Z]{26})\]\]$/.exec(text.trim())?.[1];
}

export function createFiledTargets(doc: PageDocument) {
  const rows = mapArray(() => {
    doc.outline.version();
    return Array.from({ length: doc.outline.size() }, (_, index) => doc.outline.idAt(index));
  }, id => createMemo(() => embedTarget(doc.block(id)?.text ?? '')));
  return createMemo(() => new Set(rows().flatMap(target => {
    const id = target();
    return id ? [id] : [];
  })));
}

/** Filing uses ordinary outline insertion, so order and undo need no sidecar. */
export function fileArrival(doc: PageDocument, id: string) {
  return doc.edit({ kind: 'insert', parentId: doc.pageId, after: doc.outline.children(doc.pageId).at(-1) ?? null, text: `[[${id}]]` });
}

export function streamDay(date: string) {
  const value = new Date(`${date}T12:00:00Z`);
  return `${new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(value)} ${value.getUTCDate()}`;
}
