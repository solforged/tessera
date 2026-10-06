import { describe, expect, test } from 'bun:test';
import type { IngestJob, LibraryRow } from '../api/types';
import { libraryQuery, recentJobs, retryTime, selectSources, sourceByline, sourceStateOperation } from './query';

describe('library queries', () => {
  test('selects a state and trims search text', () => {
    expect(libraryQuery({ tab: 'reading', text: '  Tudors  ', sort: 'added' })).toEqual({ states: ['reading'], text: 'Tudors', sort: 'added', direction: 'desc' });
  });
  test('all and highlights retain global counts without a state filter', () => {
    for (const tab of ['all', 'highlights'] as const) {
      expect(libraryQuery({ tab, text: ' ', sort: 'title' })).toEqual({ states: [], text: null, sort: 'title', direction: 'asc' });
    }
  });
  test('sorts title ascending and every time/progress order descending', () => {
    for (const sort of ['added', 'title', 'last_read', 'progress'] as const) {
      expect(libraryQuery({ tab: 'inbox', text: '', sort }).direction).toBe(sort === 'title' ? 'asc' : 'desc');
    }
  });
});

test('source state edits preserve authored identifiers and use the owning revision', () => {
  const row = {
    page: { id: 'source', revision: 9 },
    source: { block_id: 'source', format: 'epub', state: 'inbox', origin: 'book.epub', match_key: 'isbn:123', citation_key: 'author2026book', added_at: 1, state_changed_at: 2, last_read_at: null, current_snapshot_id: 'snapshot' },
  } as LibraryRow;
  expect(sourceStateOperation(row, 'finished')).toEqual({
    op: 'set_source', id: 'source', base_revision: 9,
    source: { format: 'epub', state: 'finished', origin: 'book.epub', match_key: 'isbn:123', citation_key: 'author2026book' },
  });
  expect(row.source.state).toBe('inbox');
});

test('bylines retain creators and only the publication year without dangling separators', () => {
  expect(sourceByline({ creators: ['A. Author', 'B. Editor'], published: '2026-10-04' })).toBe('A. Author, B. Editor · 2026');
  expect(sourceByline({ creators: ['A. Author'], published: null })).toBe('A. Author');
  expect(sourceByline({ creators: [], published: '1999' })).toBe('1999');
  expect(sourceByline({ creators: [], published: null })).toBe('');
});

test('jobs retain unfinished work at any age and completed work for one day', () => {
  const now = 100_000_000;
  const cutoff = now - 24 * 60 * 60 * 1000;
  const jobs = [
    { id: 'queued', state: 'queued', created_at: cutoff - 1 },
    { id: 'running', state: 'running', created_at: cutoff - 1 },
    { id: 'failed', state: 'failed', created_at: cutoff - 1 },
    { id: 'done', state: 'done', created_at: now },
    { id: 'boundary', state: 'done', created_at: cutoff },
    { id: 'old', state: 'done', created_at: cutoff - 1, updated_at: now },
  ] as IngestJob[];
  expect(recentJobs(jobs, now).map(job => job.id)).toEqual(['queued', 'running', 'failed', 'done', 'boundary']);
  expect(jobs).toHaveLength(6);
});

test('retry times use the notebook time zone and a 24-hour clock', () => {
  const timestamp = Date.parse('2026-10-05T12:34:00Z');
  expect(retryTime(timestamp, 'UTC')).toBe('12:34');
  expect(retryTime(timestamp, 'Asia/Tokyo')).toBe('21:34');
});

test('source selection toggles and extends inclusive ranges in either direction', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const original = new Set(['b']);
  const forward = selectSources(ids, original, 'd', 'b', true);
  expect([...forward]).toEqual(['b', 'c', 'd']);
  expect([...original]).toEqual(['b']);
  expect([...selectSources(ids, forward, 'b', 'd', true)]).toEqual([]);
  expect([...selectSources(ids, original, 'd', 'missing', true)]).toEqual(['b', 'd']);
  expect([...selectSources(ids, original, 'b', null, false)]).toEqual([]);
});
