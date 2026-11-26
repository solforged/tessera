import type { FieldKind } from '../api/types';
import {
  checkboxValue,
  fieldKinds,
  fieldLabel,
  fieldNameProblem,
  formatMenuNote,
  kindDescriptions,
  kindLabels,
  kindNoun,
  partialDatePlaceholder,
  taskFormatReason,
} from '../model/fields';
import type { MenuItem } from '../ui/Menu';

export {
  checkboxValue,
  fieldKinds,
  fieldLabel,
  fieldNameProblem,
  formatMenuNote,
  kindDescriptions,
  kindLabels,
  kindNoun,
  partialDatePlaceholder,
  taskFormatReason,
};

/** Format choices and their explanations stay the same in every definition editor. A reason disables every row and stands alone, so the menu stays short. */
export function formatMenuItems(
  current: FieldKind,
  select: (kind: FieldKind) => void,
  disabledReason?: string,
): MenuItem[] {
  return fieldKinds.map(kind => ({
    label: kindLabels[kind],
    secondary: disabledReason ? undefined : kindDescriptions[kind],
    checked: kind === current,
    disabledReason,
    action: () => select(kind),
  }));
}
