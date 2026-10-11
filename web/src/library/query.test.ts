import { describe, expect, test } from 'bun:test';
import type { Citation, HighlightRow, IngestJob, LibraryFilters, LibraryRow } from '../api/types';
import { groupSources, highlightChapters, highlightLocation, highlightMeta, jobLabel, libraryQuery, recentJobs, retryTime, selectSources, sourceByline, sourceStateOperation, visibleJobs } from './query';

const filters: LibraryFilters = { people: [], decades: [], publishers: [], languages: [] };

describe('library queries', () => {
  test('selects a state, trims search text and carries browse filters', () => {
    expect(libraryQuery({ tab: 'reading', text: '  Tudors  ', sort: 'added', filters: { ...filters, people: ['wood'], decades: [1840] } })).toEqual({ states: ['reading'], text: 'Tudors', sort: 'added', direction: 'desc', people: ['wood'], decades: [1840], publishers: [], languages: [] });
  });
  test('all and highlights retain global counts without a state filter', () => {
    for (const tab of ['all', 'highlights'] as const) {
      expect(libraryQuery({ tab, text: ' ', sort: 'title', filters })).toMatchObject({ states: [], text: null, sort: 'title', direction: 'asc' });
    }
  });
  test('sorts title and author ascending and year/time/progress descending', () => {
    for (const sort of ['added', 'title', 'author', 'year', 'last_read', 'progress'] as const) {
      expect(libraryQuery({ tab: 'inbox', text: '', sort, filters }).direction).toBe(sort === 'title' || sort === 'author' ? 'asc' : 'desc');
    }
  });
});

test('groups keep listed order, use the first author or editor, and put missing values last', () => {
  const row = (id: string, people: [string | null, string, 'author' | 'editor' | 'translator'][], published: string | null) =>
    ({ page: { id }, people: people.map(([personId, name, role]) => ({ id: personId, name, role })), published, publisher: null, language: null }) as unknown as LibraryRow;
  const rows = [
    row('marx-reader', [['tucker', 'Robert C. Tucker', 'editor'], ['trans', 'A Translator', 'translator']], '1978-03'),
    row('nameless', [], null),
    row('wood-1', [['wood', 'Ellen Meiksins Wood', 'author']], '2008'),
    row('ideology', [['marx', 'Karl Marx', 'author'], ['engels', 'Friedrich Engels', 'author']], '1846'),
    row('wood-2', [['wood', 'Ellen Meiksins Wood', 'author']], '2011'),
    row('plain', [[null, 'Jullian, Camille', 'author']], '1908'),
  ];
  expect(groupSources(rows, 'author').map(group => [group.label, group.personId, group.rows.map(value => value.page.id)])).toEqual([
    ['Jullian, Camille', null, ['plain']],
    ['Karl Marx', 'marx', ['ideology']],
    ['Robert C. Tucker', 'tucker', ['marx-reader']],
    ['Ellen Meiksins Wood', 'wood', ['wood-1', 'wood-2']],
    ['No author', null, ['nameless']],
  ]);
  expect(groupSources(rows, 'decade').map(group => [group.label, group.rows.length])).toEqual([['2010s', 1], ['2000s', 1], ['1970s', 1], ['1900s', 1], ['1840s', 1], ['Undated', 1]]);
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

test('highlight location uses the covering chapter, else a one-based passage number', () => {
  const sections = [
    { title: 'Opening', ordinal: 2, locator: 'opening', level: 1 },
    { title: 'Next chapter', ordinal: 8, locator: 'next', level: 1 },
  ];
  expect(highlightLocation({ ordinal: 7 }, sections)).toBe('Opening');
  expect(highlightLocation({ ordinal: 8 }, sections)).toBe('Next chapter');
  expect(highlightLocation({ ordinal: 1 }, sections)).toBe('¶2');
});

test('highlight meta gives the one-based passage and the notebook date', () => {
  const row = { citation: { ordinal: 0 } as Citation, created_at: Date.parse('2026-12-31T16:30:00Z') };
  expect(highlightMeta(row, 'Asia/Tokyo')).toBe('¶1 · 2027-01-01');
  expect(highlightMeta(row, 'UTC')).toBe('¶1 · 2026-12-31');
});

test('a source\'s highlights run in reading order and split where the chapter changes', () => {
  const row = (id: string, ordinal: number, offset: number, chapter_title: string | null) =>
    ({ citation: { id, ordinal, start: { offset }, chapter_title } }) as unknown as HighlightRow;
  const chapters = highlightChapters([row('late', 9, 0, 'Two'), row('early', 1, 0, null), row('second', 4, 30, 'One'), row('first', 4, 2, 'One'), row('next', 6, 0, 'Two')]);
  expect(chapters.map(chapter => [chapter.title, chapter.rows.map(value => value.citation.id)])).toEqual([
    [null, ['early']],
    ['One', ['first', 'second']],
    ['Two', ['next', 'late']],
  ]);
});
