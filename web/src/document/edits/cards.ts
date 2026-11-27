import { sameState } from '../types';
import type { Edit } from '../contract';
import type { DocumentInternals } from './internals';
import type { EditSession } from './session';

export function editCardHeld(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'cardHeld' }>,
): void {
  const { actions } = session;
  for (const card of edit.cards) {
    if (!card.active || !doc.block(card.source_block_id)) throw new Error('The card is no longer active on this note.');
    if (card.held !== edit.held)
      actions.push({
        kind: 'cardHeld',
        id: card.id,
        value: edit.held,
        previous: card.held,
        baseRevision: card.revision,
      });
  }
}

export function editCardTemplate(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'cardTemplate' }>,
): void {
  const { actions, created } = session;
  if ((edit.value?.type_id ?? edit.previous?.type_id) !== doc.pageId)
    throw new Error('Card templates belong to their tag.');
  const { previous, value } = edit;
  if (
    previous &&
    value &&
    previous.name === value.name &&
    previous.front === value.front &&
    previous.back === value.back &&
    (previous.hint ?? null) === (value.hint ?? null) &&
    JSON.stringify(previous.details ?? []) === JSON.stringify(value.details ?? []) &&
    previous.applied === value.applied &&
    previous.new_per_day === value.new_per_day
  )
    return;
  actions.push({
    kind: 'cardTemplate',
    id: edit.id,
    value: edit.value,
    previous: edit.previous,
    baseRevision: edit.previous?.revision ?? 0,
  });
  if (!edit.previous) created.push(edit.id);
}

export function editImage(doc: DocumentInternals, session: EditSession, edit: Extract<Edit, { kind: 'image' }>): void {
  const { actions } = session;
  const block = doc.snapshot(edit.id);
  const previous = doc.capabilities(edit.id).image ?? null;
  if (sameState(previous, edit.image)) return;
  if (edit.image && doc.capabilities(edit.id).quote) throw new Error("A quoted copy can't hold an image.");
  actions.push({ kind: 'image', id: edit.id, value: edit.image, previous, baseRevision: block.revision });
}

export function editOcclusion(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'occlusion' }>,
): void {
  const { actions } = session;
  const block = doc.snapshot(edit.id);
  const previous = doc.capabilities(edit.id).occlusion ?? null;
  if (sameState(previous, edit.occlusion)) return;
  if (edit.occlusion && !doc.capabilities(edit.id).image) throw new Error('Add an image before drawing masks.');
  actions.push({
    kind: 'occlusion',
    id: edit.id,
    value: structuredClone(edit.occlusion),
    previous,
    baseRevision: block.revision,
  });
}

export function editImages(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'insertImages' | 'placeImages' }>,
): void {
  const { actions } = session;
  const target = edit.kind === 'placeImages' ? doc.snapshot(edit.targetId) : null;
  const parentId = target ? (target.parent_id ?? target.id) : edit.kind === 'insertImages' ? edit.parentId : doc.pageId;
  let after = target
    ? target.parent_id
      ? target.id
      : (doc.outline.children(target.id).at(-1) ?? null)
    : edit.kind === 'insertImages'
      ? edit.after
      : null;
  for (let index = 0; index < edit.images.length; index++) {
    const reuse = index === 0 && target?.kind === 'block' && !target.text.trim() && !doc.block(target.id)?.image;
    const id = reuse ? target.id : session.insert(parentId, after, '');
    actions.push({
      kind: 'image',
      id,
      value: edit.images[index]!,
      previous: null,
      baseRevision: reuse ? target.revision : 0,
    });
    after = id;
    session.caret ??= { id, offset: 0 };
  }
}
