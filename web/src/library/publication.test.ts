import { expect, test } from 'bun:test';
import { publicationReading } from './publication';

test('legacy Calibre EPUB publication reads as undated in the header and card', () => {
  const snapshots = [{ format: 'epub' as const, metadata: { published: '0101-01-01' } }];
  expect(publicationReading('0101-01-01', snapshots)).toBeNull();
  expect(publicationReading('2024-01-01', snapshots)).toBe('2024-01-01');
  expect(publicationReading('0101-01-01', [...snapshots, { format: 'epub', metadata: { published: '2024' } }])).toBeNull();
});

test('authored ancient dates and non-EPUB metadata remain literal readings', () => {
  expect(publicationReading('0101-01-01')).toBe('0101-01-01');
  expect(publicationReading('0101-01-01', [{ format: 'epub', metadata: { published: null } }])).toBe('0101-01-01');
  expect(publicationReading('0101-01-01', [{ format: 'article', metadata: { published: '0101-01-01' } }])).toBe('0101-01-01');
  expect(publicationReading('0100-01-01', [{ format: 'epub', metadata: { published: '0101-01-01' } }])).toBe('0100-01-01');
  expect(publicationReading(null)).toBeNull();
  expect(publicationReading(undefined)).toBeUndefined();
});
