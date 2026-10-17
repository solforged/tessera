import { describe, expect, test } from 'bun:test';
import { entryAnchor } from './templates';

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
