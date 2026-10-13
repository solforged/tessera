import type { BlockState, Edit, PageDocument } from './contract';

/** The edit that drops a block's capability, one per Backspace, so a protected row can then merge as plain text. */
function capabilityRemoval({ id, task, project, relation, position, spread, question, assessment }: BlockState): Edit | null {
  if (task) return { kind: 'task', id, value: null };
  if (project) return { kind: 'project', id, value: null };
  if (relation) return { kind: 'relation', id, value: null };
  if (position) return { kind: 'position', id, value: false };
  if (spread) return { kind: 'spread', id, value: false };
  if (question) return { kind: 'question', id, value: null };
  if (assessment) return { kind: 'assessment', id, value: null };
  return null;
}

/** Plan a row-boundary deletion using the pane's visible rows and inline fields. */
export function boundaryDeletion(doc: PageDocument, id: string, direction: 'backward' | 'forward', previousVisible: string | null = null, inlineFields?: ReadonlySet<string>, zoomRoot?: string | null): Edit | null {
  const block = doc.block(id);
  if (!block) return null;
  const siblings = doc.outline.children(doc.outline.parentOf(id));
  if (direction === 'forward') {
    if (id === zoomRoot) return null;
    const next = siblings[siblings.indexOf(id) + 1];
    return next ? { kind: 'merge', sourceId: next, destinationId: id } : null;
  }
  // The first inline value sits beside the field label, which Backspace must not delete into; later values merge into the value above.
  if (inlineFields?.has(doc.outline.parentOf(id)) && (!previousVisible || doc.outline.parentOf(previousVisible) !== doc.outline.parentOf(id))) return null;
  // Merging would lose a capability or its history, so Backspace deletes an empty protected leaf and otherwise drops the capability first.
  const removal = capabilityRemoval(block);
  if ((removal || block.mergeProtected) && !block.text && !doc.outline.children(id).length) return { kind: 'delete', ids: [id] };
  if (removal) return removal;
  if (block.heading) return { kind: 'heading', id, level: null };
  if (siblings.indexOf(id) > 0) return previousVisible ? { kind: 'merge', sourceId: id, destinationId: previousVisible } : null;
  return doc.outline.depth(id) > 0 ? { kind: 'outdent', ids: [id] } : null;
}
