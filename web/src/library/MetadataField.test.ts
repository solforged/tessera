import { describe, expect, test } from 'bun:test';
import type { SourceCreator } from './details';
import { metadataEqual, metadataText, metadataValues } from './metadata-values';

describe('inspector metadata values', () => {
  test('a shared value appears once with its source count', () => {
    expect(metadataValues(['Bloomsbury', 'Bloomsbury', 'Bloomsbury', 'Bloomsbury'])).toEqual({
      distinct: [{ value: 'Bloomsbury', count: 4 }], empty: 0, mixed: false,
    });
  });

  test('empty sources do not masquerade as conflicting known values', () => {
    expect(metadataValues(['Paperback', '', 'Paperback', ''])).toEqual({
      distinct: [{ value: 'Paperback', count: 2 }], empty: 2, mixed: true,
    });
    expect(metadataValues(['', '', ''])).toEqual({ distinct: [], empty: 3, mixed: false });
    expect(metadataValues([[], []])).toEqual({ distinct: [], empty: 2, mixed: false });
  });

  test('mixed values retain every distinct source count', () => {
    expect(metadataValues(['Bloomsbury', 'Scholastic', 'Bloomsbury', 'Scholastic', ''])).toEqual({
      distinct: [{ value: 'Bloomsbury', count: 2 }, { value: 'Scholastic', count: 2 }], empty: 1, mixed: true,
    });
  });

  test('identifiers keep all values and preserve order while editing', () => {
    const identifiers = ['isbn:9780262033848', 'doi:10.1000/example', 'arxiv:2401.00001'];
    expect(metadataText(identifiers)).toBe('isbn:9780262033848\ndoi:10.1000/example\narxiv:2401.00001');
    expect(metadataEqual(identifiers, [...identifiers])).toBe(true);
    expect(metadataEqual(identifiers, [...identifiers].reverse())).toBe(false);
  });

  test('creator identity, order and book role each distinguish a register value', () => {
    const author: SourceCreator = { id: 'person', name: 'Robert C. Tucker', role: 'author' };
    const editor: SourceCreator = { ...author, role: 'editor' };
    const duplicate: SourceCreator = { ...author, id: 'duplicate' };
    expect(metadataValues([[author], [author], [editor], [duplicate], []])).toEqual({
      distinct: [{ value: [author], count: 2 }, { value: [editor], count: 1 }, { value: [duplicate], count: 1 }], empty: 1, mixed: true,
    });
    expect(metadataEqual([author, editor], [editor, author])).toBe(false);
    expect(metadataText([author])).toBe('Robert C. Tucker');
  });

  test('a fifty-source selection aggregates without dropping empty or distinct values', () => {
    const values = Array.from({ length: 50 }, (_, index) => index % 5 ? `Publisher ${index % 3}` : '');
    const aggregate = metadataValues(values);
    expect(aggregate.empty).toBe(10);
    expect(aggregate.distinct.length).toBe(3);
    expect(aggregate.distinct.reduce((count, item) => count + item.count, aggregate.empty)).toBe(50);
  });
});
