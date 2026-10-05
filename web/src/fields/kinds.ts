import type { FieldKind } from '../api/types';

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
