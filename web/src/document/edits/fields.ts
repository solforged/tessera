import { fieldHide } from '../../core/hide';
import { countsReason, fieldCounts, fieldRole } from '../../model/fields';
import { titleKey } from '../../model/title-key';
import type { Edit } from '../contract';
import type { Caret } from '../../core/contract';
import type { DocumentInternals } from './internals';
import type { EditSession } from './session';

export function editAddField(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'addField' }>,
): void {
  const { actions } = session;
  const root = doc.root();
  if (root?.kind !== 'page' || titleKey(root.text) !== 'fields')
    throw new Error('Field definitions belong on the Fields register.');
  if (!edit.name.trim()) throw new Error('A field needs a name.');
  const id = session.insert(doc.pageId, doc.outline.children(doc.pageId).at(-1) ?? null, edit.name);
  if (edit.value !== 'text') actions.push({ kind: 'fieldKind', id, value: edit.value, previous: 'text' });
  if (edit.role && edit.role !== 'attribute')
    actions.push({ kind: 'fieldRole', id, value: edit.role, previous: 'attribute' });
  session.caret = { id, offset: 0 };
}

export function editFieldEntry(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'fieldEntry' }>,
): void {
  const caretBefore = session.caretBefore;
  const block = doc.snapshot(edit.id);
  const from = Math.max(0, Math.min(block.text.length, edit.from));
  const value = block.text.slice(from);
  session.guardSplit(block, '', '');
  session.setText(block, `[[${edit.fieldId}]]`);
  const id = session.insert(edit.id, null, value);
  const offset = caretBefore?.id === edit.id ? caretBefore.offset - from : value.length;
  session.caret = { id, offset: Math.max(0, Math.min(value.length, offset)) };
}

export function editAddFieldEntries(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'addFieldEntries' }>,
): void {
  if (!edit.entries.length) throw new Error('Choose a field.');
  if (edit.after && doc.outline.parentOf(edit.after) !== edit.parentId)
    throw new Error('The destination sibling no longer exists.');
  let after = edit.after;
  let first: Caret | undefined;
  for (const entry of edit.entries) {
    after = session.insert(edit.parentId, after, `[[${entry.fieldId}]]`);
    const value = session.insert(after, null, entry.value, null, entry.quote);
    first ??= { id: value, offset: entry.value.length };
  }
  session.caret = first!;
}

export function editFieldKind(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'fieldKind' }>,
): void {
  const { actions } = session;
  const definition = edit.definition;
  if (doc.snapshot(definition.id).revision !== definition.revision || doc.block(definition.id)?.pending)
    throw new Error('The field changed. Refresh before changing its format.');
  if (definition.kind !== edit.value)
    actions.push({
      kind: 'fieldKind',
      id: definition.id,
      value: edit.value,
      previous: definition.kind,
      baseRevision: definition.revision,
    });
}

export function editFieldHide(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'fieldHide' }>,
): void {
  const { actions } = session;
  const definition = edit.definition;
  if (doc.snapshot(definition.id).revision !== definition.revision || doc.block(definition.id)?.pending)
    throw new Error('The field changed. Refresh before changing its hide setting.');
  const previous = fieldHide(definition);
  if (previous !== edit.value)
    actions.push({
      kind: 'fieldHide',
      id: definition.id,
      value: edit.value,
      previous,
      baseRevision: definition.revision,
    });
}

export function editFieldRole(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'fieldRole' }>,
): void {
  const { actions } = session;
  const definition = edit.definition;
  if (doc.snapshot(definition.id).revision !== definition.revision || doc.block(definition.id)?.pending)
    throw new Error('The field changed. Refresh before changing its role.');
  const previous = fieldRole(definition);
  if (previous !== edit.value)
    actions.push({
      kind: 'fieldRole',
      id: definition.id,
      value: edit.value,
      previous,
      baseRevision: definition.revision,
    });
}

export function editFieldCountsAs(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'fieldCountsAs' }>,
): void {
  const { actions } = session;
  const definition = edit.definition;
  if (doc.snapshot(definition.id).revision !== definition.revision || doc.block(definition.id)?.pending)
    throw new Error('The field changed. Refresh before changing what it counts as.');
  const reason = countsReason(definition);
  if (reason) throw new Error(reason);
  const previous = fieldCounts(definition);
  if (previous !== edit.value)
    actions.push({
      kind: 'fieldCountsAs',
      id: definition.id,
      value: edit.value,
      previous,
      baseRevision: definition.revision,
    });
}

export function editFieldTargets(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'fieldTargets' }>,
): void {
  const { actions } = session;
  const definition = edit.definition;
  if (doc.snapshot(definition.id).revision !== definition.revision || doc.block(definition.id)?.pending)
    throw new Error('The field changed. Refresh before changing its targets.');
  if (JSON.stringify(definition.targets) !== JSON.stringify(edit.targets))
    actions.push({
      kind: 'fieldTargets',
      id: definition.id,
      targets: edit.targets,
      previous: definition.targets,
      baseRevision: definition.revision,
    });
}

export function editSubjectCriteria(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'subjectCriteria' }>,
): void {
  const { actions } = session;
  if (doc.snapshot(edit.id).revision !== edit.revision || doc.block(edit.id)?.pending)
    throw new Error('The subject changed. Refresh before changing its criteria.');
  actions.push({
    kind: 'subjectCriteria',
    id: edit.id,
    fields: [...edit.fields],
    previous: [...edit.previous],
    baseRevision: edit.revision,
  });
}
