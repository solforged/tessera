export const fieldHides = ['never', 'when_empty', 'always'] as const;
export type FieldHide = typeof fieldHides[number];
export const hideLabels: Record<FieldHide, string> = { never: 'Never', when_empty: 'When empty', always: 'Always' };
export const hideDescriptions: Record<FieldHide, string> = {
  never: 'Shown even when empty.',
  when_empty: 'Hidden in atoms while empty.',
  always: 'Hidden in atoms; tables still show it.',
};
/** Definitions from builds before the setting existed carry none. */
export const fieldHide = (field: { hide?: FieldHide } | undefined): FieldHide => field?.hide ?? 'never';
