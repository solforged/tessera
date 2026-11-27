import { quoteTarget } from '../text-tokens';
import { currentReading, questionState, sameState } from '../types';
import type { Edit } from '../contract';
import type { DocumentInternals } from './internals';
import type { EditSession } from './session';

export function editPosition(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'position' }>,
): void {
  const { actions } = session;
  const block = doc.snapshot(edit.id);
  if (block.kind !== 'block') throw new Error('Only ordinary notes can be perspectives.');
  if (edit.value && doc.block(edit.id)?.relation) throw new Error('Remove the argument first.');
  const previous = !!doc.capabilities(edit.id).position;
  if (previous !== edit.value)
    actions.push({ kind: 'position', id: edit.id, value: edit.value, previous, baseRevision: block.revision });
}

export function editRelation(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'relation' }>,
): void {
  const { actions } = session;
  const block = doc.snapshot(edit.id);
  if (block.kind !== 'block') throw new Error('Only ordinary notes can be arguments.');
  const capability = doc.capabilities(edit.id);
  if (edit.value && (capability.position || capability.question || capability.assessment))
    throw new Error('An argument cannot also be a perspective, question or answer.');
  const previous = capability.relation?.kind ?? null;
  if (edit.text !== undefined) session.setText(block, edit.text);
  if (previous !== edit.value)
    actions.push({ kind: 'relation', id: edit.id, value: edit.value, previous, baseRevision: block.revision });
}

export function editAddRelation(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'addRelation' }>,
): void {
  const { actions } = session;
  const parent = doc.snapshot(edit.parentId);
  const capability = doc.capabilities(edit.parentId);
  if (!capability.position && !capability.assessment && !capability.question)
    throw new Error('Select a perspective, question or answer.');
  if (edit.sourceText !== undefined) session.setText(parent, edit.sourceText);
  const text = `[[${edit.targetId}]]`;
  const id = session.insert(edit.parentId, doc.outline.children(edit.parentId).at(-1) ?? null, text);
  actions.push({ kind: 'relation', id, value: edit.value, previous: null, baseRevision: 0 });
  session.caret = { id, offset: text.length };
}

export function editSpread(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'spread' }>,
): void {
  const { actions } = session;
  const block = doc.snapshot(edit.id);
  if (block.kind !== 'page') throw new Error('Only a titled note can be a spread.');
  const previous = !!doc.capabilities(edit.id).spread;
  if (previous !== edit.value) actions.push({ ...edit, previous, baseRevision: block.revision });
}

export function editQuestionChild(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'writeAssessment' | 'addBranchQuestion' }>,
): void {
  const { actions } = session;
  const question = doc.block(edit.parentId)?.question;
  if (!question) throw new Error('Select a question.');
  if (edit.kind === 'writeAssessment' && question.state.parked)
    throw new Error('Resume the question before writing an assessment.');
  const id = session.insert(edit.parentId, doc.outline.children(edit.parentId).at(-1) ?? null, '');
  if (edit.kind === 'writeAssessment')
    actions.push({
      kind: 'assessment',
      id,
      value: { assessed_on: edit.assessedOn, aporia: false },
      previous: null,
      baseRevision: 0,
    });
  else
    actions.push({
      kind: 'question',
      id,
      value: { unsettled: false, parked: false, accepted: null, review_on: null, reading_history: [] },
      previous: null,
      baseRevision: 0,
    });
  session.caret = { id, offset: 0 };
}

export function editQuestion(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'question' }>,
): void {
  const { actions } = session;
  if (edit.value === null) session.removeCapabilityTags(edit.id, 'question');
  const previous = questionState(doc.capabilities(edit.id).question?.state);
  let value = questionState(edit.value);
  if (
    previous &&
    value &&
    previous.accepted !== value.accepted &&
    sameState(previous.reading_history, value.reading_history)
  ) {
    value = currentReading({ ...value, accepted: previous.accepted }, value.accepted, doc.host.todayDate());
  }
  if (edit.value && doc.block(edit.id)?.relation) throw new Error('Remove the argument first.');
  if (edit.value && doc.block(edit.id)?.assessment) throw new Error('A note cannot be both a question and an answer.');
  if (
    (previous?.parked || edit.value?.parked) &&
    (previous?.accepted ?? null) !== (edit.value?.accepted ?? null) &&
    edit.value?.accepted
  )
    throw new Error('Resume the question before accepting a reading.');
  if (!sameState(previous, value))
    actions.push({
      ...edit,
      value: structuredClone(value),
      previous,
      baseRevision: doc.snapshot(edit.id).revision,
    });
}

export function editQuote(doc: DocumentInternals, session: EditSession, edit: Extract<Edit, { kind: 'quote' }>): void {
  const { actions } = session;
  const block = doc.snapshot(edit.id);
  const text = edit.text ?? block.text;
  if (edit.value && (quoteTarget(text) !== edit.value.target_id || edit.value.target_id === edit.id))
    throw new Error('Quote target must match a different note.');
  const previous = doc.capabilities(edit.id).quote ?? null;
  session.setText(block, text);
  if (!sameState(previous, edit.value))
    actions.push({
      kind: 'quote',
      id: edit.id,
      value: structuredClone(edit.value),
      previous,
      baseRevision: block.revision,
    });
  if (edit.text !== undefined) session.caret = { id: edit.id, offset: text.length };
}

export function editAssessment(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'assessment' }>,
): void {
  const { actions } = session;
  const previous = doc.capabilities(edit.id).assessment?.state ?? null;
  if (edit.value) {
    if (doc.block(edit.id)?.relation) throw new Error('Remove the argument first.');
    if (doc.block(edit.id)?.question) throw new Error('A note cannot be both a question and an answer.');
    let owner = doc.block(edit.id)?.parentId;
    while (owner && !doc.block(owner)?.question) owner = doc.block(owner)?.parentId;
    if (!owner) throw new Error('Put the answer under a question first.');
    if (!previous && doc.block(owner)?.question?.state.parked)
      throw new Error('Resume the question before answering it.');
  }
  if (!edit.value && previous) {
    for (const ownerId of doc.investigationIds) {
      const question = doc.capabilities(ownerId).question?.state;
      if (question?.accepted === edit.id)
        actions.push({
          kind: 'question',
          id: ownerId,
          value: currentReading(question, null, doc.host.todayDate()),
          previous: questionState(question),
          baseRevision: doc.snapshot(ownerId).revision,
        });
    }
  }
  if (!sameState(previous, edit.value))
    actions.push({
      ...edit,
      value: structuredClone(edit.value),
      previous,
      baseRevision: doc.snapshot(edit.id).revision,
    });
}

export function editAddReading(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'addReading' }>,
): void {
  const { actions } = session;
  if (edit.after && doc.outline.parentOf(edit.after) !== edit.parentId)
    throw new Error('The destination sibling no longer exists.');
  const id = session.insert(edit.parentId, edit.after, `[[${edit.holderId}]]`);
  actions.push({ kind: 'position', id, value: true, previous: false, baseRevision: 0 });
  const entry = session.insert(id, null, `[[${edit.gistFieldId}]]`);
  session.caret = { id: session.insert(entry, null, ''), offset: 0 };
}
