import { titleKey } from '../title-key';
import { sameState } from '../types';
import type { Edit } from '../contract';
import type { DocumentInternals } from './internals';
import type { EditSession } from './session';

export function editTypePresentation(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'typePresentation' }>,
): void {
  const { actions } = session;
  if (doc.snapshot(edit.id).revision !== edit.revision || doc.block(edit.id)?.pending)
    throw new Error('The tag changed. Refresh before changing its icon or name.');
  if (!sameState(edit.value, edit.previous))
    actions.push({
      kind: 'typePresentation',
      id: edit.id,
      value: { ...edit.value },
      previous: { ...edit.previous },
      baseRevision: edit.revision,
    });
}

export function editManualType(
  doc: DocumentInternals,
  session: EditSession,
  edit: Extract<Edit, { kind: 'addType' | 'removeType' }>,
): void {
  const { actions } = session;
  const block = doc.block(edit.id);
  if (!block) throw new Error('The atom no longer exists.');
  if (!edit.title || edit.title.trim() !== edit.title || /[[\]\r\n]/.test(edit.title))
    throw new Error('Invalid tag title.');
  const exists = block.manual_types.some(title => titleKey(title) === titleKey(edit.title));
  if (edit.kind === 'addType' && exists) return;
  if (edit.kind === 'removeType' && !exists) throw new Error('From the text. Edit the #tag there to remove it.');
  actions.push({ kind: edit.kind, id: edit.id, title: edit.title });
}
