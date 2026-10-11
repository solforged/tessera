import { describe, expect, test } from 'bun:test';
import type { Citation, IngestJob, LibraryRow } from '../api/types';
import { highlightLocation, highlightMeta, jobLabel, libraryQuery, recentJobs, retryTime, selectSources, sourceByline, sourceStateOperation, visibleJobs } from './query';

describe('library queries', () => {
  test('selects a state and trims search text', () => {
    expect(libraryQuery({ tab: 'reading', text: '  Tudors  ', sort: 'added' })).toEqual({ states: ['reading'], text: 'Tudors', sort: 'added', direction: 'desc' });
  });
  test('all and highlights retain global counts without a state filter', () => {
    for (const tab of ['all', 'highlights'] as const) {
      expect(libraryQuery({ tab, text: ' ', sort: 'title' })).toEqual({ states: [], text: null, sort: 'title', direction: 'asc' });
    }
  });
  test('sorts title and author ascending and year/time/progress descending', () => {
    for (const sort of ['added', 'title', 'author', 'year', 'last_read', 'progress'] as const) {
      expect(libraryQuery({ tab: 'inbox', text: '', sort }).direction).toBe(sort === 'title' || sort === 'author' ? 'asc' : 'desc');
    }
  });
});

test('source state edits preserve authored identifiers and use the owning revision', () => {
  const row = {
    page: { id: 'source', revision: 9 },
    source: { block_id: 'source', format: 'epub', state: 'inbox', origin: 'book.epub', match_key: 'isbn:123', citation_key: 'author2026book', added_at: 1, state_changed_at: 2, last_read_at: null, current_snapshot_id: 'snapshot', siglum: 'AUT', siglum_basis: 'AUTHOR', siglum_authored: false },
  } as LibraryRow;
  expect(sourceStateOperation(row, 'finished')).toEqual({
    op: 'set_source', id: 'source', base_revision: 9,
    source: { format: 'epub', state: 'finished', origin: 'book.epub', match_key: 'isbn:123', citation_key: 'author2026book' },
  });
  expect(row.source.state).toBe('inbox');
});

test('bylines retain creators or site separately from the year column', () => {
  expect(sourceByline({ creators: ['A. Author', 'B. Editor'], site: 'Journal', published: '2026-10-04' })).toBe('A. Author, B. Editor');
  expect(sourceByline({ creators: ['A. Author'], site: null, published: null })).toBe('A. Author');
  expect(sourceByline({ creators: [], site: 'karpathy.github.io', published: '2015-05-21' })).toBe('karpathy.github.io');
  expect(sourceByline({ creators: [], site: null, published: '1999' })).toBe('');
  expect(sourceByline({ creators: [], site: null, published: null })).toBe('');
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

test('completed jobs disappear once their source is known', () => {
  const jobs = [
    { id: 'visible', state: 'done', source_id: 'source' },
    { id: 'filtered', state: 'done', source_id: 'other' },
    { id: 'queued', state: 'queued', source_id: 'source' },
    { id: 'failed', state: 'failed', source_id: 'source' },
  ] as IngestJob[];
  expect(visibleJobs(jobs, new Set(['source'])).map(job => job.id)).toEqual(['filtered', 'queued', 'failed']);
  expect(visibleJobs(jobs, new Set())).toEqual(jobs);
});

test('completed jobs use the source title and added with attempts only after a retry', () => {
  const job = { name: 'upload-123.epub', state: 'done', source_id: 'source', attempts: 1 } as IngestJob;
  const titles = new Map([['source', 'The source title']]);
  expect(jobLabel(job, titles)).toEqual({ name: 'The source title', state: 'Added', attempt: null });
  expect(jobLabel({ ...job, attempts: 2 }, titles).attempt).toBe('attempt 2');
  for (const state of ['queued', 'failed'] as const) {
    const label = state[0]!.toUpperCase() + state.slice(1);
    expect(jobLabel({ ...job, state, attempts: 0 }, titles)).toEqual({ name: 'upload-123', state: label, attempt: null });
    expect(jobLabel({ ...job, state, attempts: 3 }, titles)).toEqual({ name: 'upload-123', state: label, attempt: 'attempt 3' });
  }
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

test('highlight meta uses the covering chapter and the notebook date', () => {
  const sections = [
    { title: 'Opening', ordinal: 2, locator: 'opening', level: 1 },
    { title: 'Next chapter', ordinal: 8, locator: 'next', level: 1 },
  ];
  const row = { citation: { ordinal: 7 } as Citation, created_at: Date.parse('2026-10-06T00:30:00Z') };
  expect(highlightMeta(row, sections, 'UTC')).toBe('Opening · ¶8 · 2026-10-06');
  expect(highlightMeta(row, sections, 'America/Los_Angeles')).toBe('Opening · ¶8 · 2026-10-05');
  expect(highlightLocation({ ordinal: 8 }, sections)).toBe('Next chapter');
  expect(highlightLocation({ ordinal: 1 }, sections)).toBe('¶2');
});

test('highlight meta falls back to a one-based passage number without contents', () => {
  const row = { citation: { ordinal: 0 } as Citation, created_at: Date.parse('2026-12-31T16:30:00Z') };
  expect(highlightMeta(row, [], 'Asia/Tokyo')).toBe('¶1 · 2027-01-01');
});
