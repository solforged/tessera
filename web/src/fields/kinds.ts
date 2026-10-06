import type { FieldKind } from '../api/types';

export const fieldKinds = ['text', 'number', 'date', 'checkbox', 'choice', 'instance', 'url', 'identifier'] as const;
export const partialDatePlaceholder = 'YYYY, YYYY-MM or YYYY-MM-DD';

export const kindLabels: Record<FieldKind, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  checkbox: 'Checkbox',
  choice: 'Choice',
  instance: 'Instance',
  url: 'URL',
  identifier: 'Identifier',
};
