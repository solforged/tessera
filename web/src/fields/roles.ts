import { untrack } from 'solid-js';
import type { FieldDefinition, FieldRole } from '../api/types';
import { fieldEntryId } from '../core/field-entry';
import type { PageDocument } from '../document/contract';
import { fieldRole, fieldRoles, roleDescriptions, roleLabels } from '../model/fields';

export { fieldRole, fieldRoles, roleDescriptions, roleLabels, type FieldRole };

/** Project each owner's standfirst, compact bed and prose before its ordinary children. */
export function fieldBedRows(
  doc: PageDocument,
  visible: readonly string[],
  definitions: Pick<ReadonlyMap<string, FieldDefinition>, 'get'>,
  root: string,
): string[] {
  const shown = new Set(visible),
    result: string[] = [];
  const rank: Record<FieldRole, number> = { standfirst: 0, attribute: 1, citation: 1, prose: 2 };
  const visit = (parent: string) => {
    const children = doc.outline.children(parent);
    const fields = children.flatMap(id => {
      const field = definitions.get(fieldEntryId(untrack(() => doc.block(id)?.text ?? '')) ?? '');
      return field ? [{ id, rank: rank[fieldRole(field)] }] : [];
    });
    fields.sort((a, b) => a.rank - b.rank);
    const entries = new Set(fields.map(field => field.id));
    for (const id of [...fields.map(field => field.id), ...children.filter(id => !entries.has(id))]) {
      if (shown.has(id)) result.push(id);
      visit(id);
    }
  };
  if (shown.has(root)) result.push(root);
  visit(root);
  return result;
}
