import { sameState, sourceState } from '../types';
import type { Edit } from '../contract';
import type { DocumentInternals } from './internals';
import type { EditSession } from './session';

export function editSourceDetails(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'sourceDetails' }>,
): void {
  const { actions, created } = session;
  actions.push(...doc.sourceDetailsActions(edit));
  created.push(...actions.flatMap(action => (action.kind === 'insert' ? [action.block.id] : [])));
}

export function editSource(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'source' }>,
): void {
  const { actions } = session;
  if (edit.value === null) session.removeCapabilityTags(edit.id, 'source');
  const previous = sourceState(doc.capabilities(edit.id).source);
  const value = sourceState(edit.value);
  if (!sameState(previous, value))
    actions.push({
      kind: 'source',
      id: edit.id,
      value,
      previous,
      baseRevision: doc.snapshot(edit.id).revision,
    });
}

export function editMergeHighlights(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'mergeHighlights' }>,
): void {
  const { actions } = session;
  for (const merge of edit.merges) {
    const id = merge.citation.block_id;
    const previous = doc.capabilities(id).citations?.find(citation => citation.id === merge.citation.id);
    if (!previous) throw new Error('Citation not found.');
    const baseRevision = doc.snapshot(id).revision;
    if (!sameState(previous.start, merge.citation.start) || !sameState(previous.end, merge.citation.end)) {
      actions.push({
        kind: 'citationRange',
        id,
        citation: { ...merge.citation, color: previous.color },
        previous,
        baseRevision,
      });
      const block = doc.snapshot(id);
      // Authored notes or card syntax stay intact; only a verbatim quote follows its evidence.
      if (block.text === previous.quote) session.setText(block, merge.citation.quote);
    }
    if (previous.color !== merge.citation.color)
      actions.push({
        kind: 'highlightColor',
        id,
        citationId: previous.id,
        color: merge.citation.color,
        previous: previous.color,
        baseRevision,
      });
    for (const citationId of merge.removeCitationIds ?? [])
      actions.push({ kind: 'uncite', id, citationId, baseRevision });
    let after = doc.outline.children(id).at(-1) ?? null;
    const removedIds = [...merge.removeIds].sort((a, b) => doc.outline.indexOf(b) - doc.outline.indexOf(a));
    for (const removed of removedIds) {
      if (removed === id || !doc.block(removed)) throw new Error('Highlight no longer exists.');
      doc.guardHide(removed);
      // Hoist a survivor nested under a highlight that is being absorbed.
      let ancestor = doc.block(id)?.parentId;
      while (ancestor && ancestor !== removed) ancestor = doc.block(ancestor)?.parentId;
      if (ancestor === removed)
        actions.push({ kind: 'move', id, parentId: doc.outline.parentOf(removed), after: removed });
      const children = doc.outline.children(removed).filter(child => child !== id && !merge.removeIds.includes(child));
      for (const child of children) {
        actions.push({ kind: 'move', id: child, parentId: id, after });
        after = child;
      }
      actions.push({ kind: 'delete', id: removed });
    }
    session.caret = { id, offset: doc.block(id)?.text.length ?? 0 };
    if (edit.note) session.caret = { id: session.insert(id, null, ''), offset: 0 };
  }
}

export function editCite(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'cite' | 'highlight' }>,
): void {
  const { actions } = session;
  const id =
    edit.kind === 'highlight'
      ? session.insert(
          edit.parentId,
          edit.after === undefined ? (doc.outline.children(edit.parentId).at(-1) ?? null) : edit.after,
          edit.text,
        )
      : edit.id;
  const citation = edit.citation;
  actions.push({
    kind: 'cite',
    id,
    baseRevision: edit.kind === 'highlight' ? 0 : doc.snapshot(id).revision,
    citation: {
      id: citation.id,
      block_id: id,
      source_id: citation.sourceId,
      snapshot_id: citation.snapshotId,
      start: { ...citation.start },
      end: { ...citation.end },
      quote: citation.quote,
      locator: citation.locator,
      ordinal: citation.ordinal,
      triage: null,
      color: edit.kind === 'highlight' ? (edit.color ?? null) : null,
    },
  });
  if (edit.kind === 'highlight')
    session.caret = edit.note ? { id: session.insert(id, null, ''), offset: 0 } : { id, offset: edit.text.length };
}

export function editUncite(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'uncite' }>,
): void {
  const { actions } = session;
  const baseRevision = doc.snapshot(edit.id).revision;
  for (const citationId of new Set(edit.citationIds)) {
    if (doc.block(edit.id)!.citations.some(citation => citation.id === citationId))
      actions.push({ kind: 'uncite', id: edit.id, citationId, baseRevision });
  }
}

export function editCitationTriage(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'citationTriage' }>,
): void {
  const { actions } = session;
  const citation = doc.capabilities(edit.id).citations?.find(item => item.id === edit.citationId);
  if (!citation) throw new Error('Citation not found.');
  if (citation.triage !== edit.triage)
    actions.push({
      kind: 'citationTriage',
      id: edit.id,
      citationId: edit.citationId,
      triage: edit.triage,
      previous: citation.triage,
      baseRevision: doc.snapshot(edit.id).revision,
    });
}

export function editHighlightColor(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'highlightColor' }>,
): void {
  const { actions } = session;
  const citation = doc.capabilities(edit.id).citations?.find(item => item.id === edit.citationId);
  if (!citation) throw new Error('Citation not found.');
  if (citation.color !== edit.color)
    actions.push({
      kind: 'highlightColor',
      id: edit.id,
      citationId: edit.citationId,
      color: edit.color,
      previous: citation.color,
      baseRevision: doc.snapshot(edit.id).revision,
    });
}
