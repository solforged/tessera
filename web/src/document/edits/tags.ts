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
  if (!edit.title || edit.title.trim() !== edit.title || /[[\]\r\n]/.test(edit.title))
    throw new Error('Invalid tag title.');
  const multi = 'ids' in edit;
  const targets = multi ? [...new Set(edit.ids)] : [edit.id];
  let matched = 0;
  for (const id of targets) {
    const block = doc.block(id);
    if (!block) throw new Error('The note no longer exists.');
    const exists = block.manual_types.some(title => titleKey(title) === titleKey(edit.title));
    if (edit.kind === 'addType') {
      if (exists) continue;
      actions.push({ kind: 'addType', id, title: edit.title });
      matched++;
    } else {
      if (!exists) {
        if (!multi) throw new Error('From the text. Edit the #tag there to remove it.');
        continue;
      }
      actions.push({ kind: 'removeType', id, title: edit.title });
      matched++;
    }
  }
  if (multi && edit.kind === 'removeType' && matched === 0 && targets.length > 0)
    throw new Error('From the text. Edit the #tag there to remove it.');
}
