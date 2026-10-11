import { describe, expect, test } from 'bun:test';
import { entryAnchor, startingTemplateFor } from './templates';

const template = ['author', 'published', 'status', 'rating'];

describe('entryAnchor', () => {
  test('a template field follows the last entry that comes earlier in the template', () => {
    const entries = [{ id: 'e-author', field: 'author' }, { id: 'e-status', field: 'status' }, { id: 'e-shelf', field: 'shelf' }];
    expect(entryAnchor(['e-author', 'e-status', 'e-shelf', 'note'], entries, template, 'published')).toBe('e-author');
    expect(entryAnchor(['e-author', 'e-status', 'e-shelf', 'note'], entries, template, 'rating')).toBe('e-status');
  });

  test('a field earlier than every entry goes just before the first entry, after any note above it', () => {
    const entries = [{ id: 'e-status', field: 'status' }];
    expect(entryAnchor(['intro', 'e-status'], entries, template, 'author')).toBe('intro');
    expect(entryAnchor(['e-status', 'note'], entries, template, 'author')).toBeNull();
  });

  test('a field outside the template follows the last entry, and the first entry of a bare block heads it', () => {
    const entries = [{ id: 'e-rating', field: 'rating' }, { id: 'e-shelf', field: 'shelf' }];
    expect(entryAnchor(['e-rating', 'e-shelf', 'note'], entries, template, 'isbn')).toBe('e-shelf');
    expect(entryAnchor(['note'], [], template, 'status')).toBeNull();
  });
});

describe('startingTemplateFor', () => {
  test('offers the specified names and fields for each starting template', () => {
    expect(startingTemplateFor('Person')).toEqual({ title: 'Person', fields: ['Aliases', 'Lived', 'Affiliated with'] });
    expect(startingTemplateFor('Group')).toEqual({ title: 'Group', fields: ['Aliases', 'Active'] });
    expect(startingTemplateFor('Concept')).toEqual({ title: 'Concept', fields: ['Aliases', 'Coined by', 'Coined in'] });
  });

  test('folds case, surrounding whitespace and composed or decomposed diacritics', () => {
    for (const title of ['person', '  PERSON \n', 'Pérsön', 'Pe\u0301rson']) {
      expect(startingTemplateFor(title)?.title).toBe('Person');
    }
    expect(startingTemplateFor('\tGróup  ')?.title).toBe('Group');
    expect(startingTemplateFor('CÓNCEPT')?.title).toBe('Concept');
  });

  test('does not replace any existing field choices, including unresolved field ids', () => {
    for (const title of ['Person', 'Group', 'Concept'] as const) {
      expect(startingTemplateFor(title, ['custom-field'])).toBeNull();
      expect(startingTemplateFor(title, [])?.title).toBe(title);
    }
  });

  test('does not offer templates for other titles or substrings', () => {
    for (const title of ['', 'Thesis', 'People', 'Person notes', 'A Group', 'con cept', 'constructor']) {
      expect(startingTemplateFor(title)).toBeNull();
    }
  });
});
