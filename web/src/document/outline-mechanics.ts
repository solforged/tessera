import type { Edit, PageDocument } from './contract';

/** Plan a row-boundary deletion; the pane supplies the previous visible row. */
export function boundaryDeletion(doc: PageDocument, id: string, direction: 'backward' | 'forward', previousVisible: string | null = null): Edit | null {
  const block = doc.block(id);
  if (!block) return null;
  const siblings = doc.outline.children(doc.outline.parentOf(id));
  if (direction === 'forward') {
    const next = siblings[siblings.indexOf(id) + 1];
    return next ? { kind: 'merge', sourceId: next, destinationId: id } : null;
  }
  if (block.heading) return { kind: 'heading', id, level: null };
  if (siblings.indexOf(id) > 0) return previousVisible ? { kind: 'merge', sourceId: id, destinationId: previousVisible } : null;
  return doc.outline.depth(id) > 0 ? { kind: 'outdent', ids: [id] } : null;
}
