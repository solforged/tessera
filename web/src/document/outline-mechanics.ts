import type { Edit, PageDocument } from './contract';

/** Plan a row-boundary deletion using the pane's visible rows and inline fields. */
export function boundaryDeletion(doc: PageDocument, id: string, direction: 'backward' | 'forward', previousVisible: string | null = null, inlineFields?: ReadonlySet<string>): Edit | null {
  const block = doc.block(id);
  if (!block) return null;
  const siblings = doc.outline.children(doc.outline.parentOf(id));
  if (direction === 'forward') {
    const next = siblings[siblings.indexOf(id) + 1];
    return next ? { kind: 'merge', sourceId: next, destinationId: id } : null;
  }
  // The first inline value sits beside the field label, which Backspace must not delete into; later values merge into the value above.
  if (inlineFields?.has(doc.outline.parentOf(id)) && (!previousVisible || doc.outline.parentOf(previousVisible) !== doc.outline.parentOf(id))) return null;
  if (block.task) return !block.text && !doc.outline.children(id).length
    ? { kind: 'delete', ids: [id] }
    : { kind: 'task', id, value: null };
  if (block.heading) return { kind: 'heading', id, level: null };
  if (siblings.indexOf(id) > 0) return previousVisible ? { kind: 'merge', sourceId: id, destinationId: previousVisible } : null;
  return doc.outline.depth(id) > 0 ? { kind: 'outdent', ids: [id] } : null;
}
