import { describe, expect, test } from 'bun:test';
import type { TaskQuery } from '../api/types';
import { createTaskQuery } from './query';
import { formatTaskQueryLine, parseTaskQueryLine, taskQueryLineTerms } from './task-query-line';
import type { TaskQueryLineContext } from './task-query-line';

const types: Record<string, string> = { book: 'Book', 'research-notes': 'Research notes', quoted: 'A "quoted" type', brackets: 'Notes ]] and \\ drafts' };
const projects: Record<string, string> = { thesis: 'Finish thesis', article: 'Article' };
const ctx: TaskQueryLineContext = {
  context_date: '2026-10-06',
  resolveType: title => Object.entries(types).find(([, name]) => name.toLowerCase() === title.toLowerCase())?.[0] ?? null,
  typeTitle: id => types[id] ?? null,
  resolveProject: title => Object.entries(projects).find(([, name]) => name.toLowerCase() === title.toLowerCase())?.[0] ?? null,
  projectTitle: id => projects[id] ?? null,
};

describe('task query line', () => {
  test('selection defaults match a new task view, with explicit open and all selections', () => {
    expect(parseTaskQueryLine('', ctx)).toEqual({ query: createTaskQuery(ctx.context_date), errors: [] });
    expect(formatTaskQueryLine(createTaskQuery(ctx.context_date), ctx)).toBe('');
    expect(parseTaskQueryLine('show:open', ctx).query.filter.selection).toBe('unfinished');
    expect(parseTaskQueryLine('show:all', ctx).query.filter.selection).toBe('all');
    for (const text of ['show:recent', 'show:recent:7']) {
      const result = parseTaskQueryLine(text, ctx);
      expect(result.errors).toEqual([]);
      expect(result.query.filter.selection).toBe('unfinished_or_recent');
      expect(result.query.filter.recent_days).toBe(7);
      expect(formatTaskQueryLine(result.query, ctx)).toBe('');
    }
    expect(parseTaskQueryLine('show:recent:14', ctx).query.filter.recent_days).toBe(14);
  });

  test('each status, priority, limit, type and project term combines with text', () => {
    const result = parseTaskQueryLine('is:todo,doing,waiting,done,cancelled priority:high #book [[Finish thesis]] limit:50 read notes', ctx);
    expect(result.errors).toEqual([]);
    expect(result.query.filter.statuses).toEqual(['todo', 'doing', 'waiting', 'done', 'cancelled']);
    expect(result.query.filter.priority).toBe('high');
    expect(result.query.filter.project_id).toBe('thesis');
    expect(result.query.source).toEqual({ type: 'book', text: 'read notes', filters: [], sort: [], limit: null });
    expect(result.query.limit).toBe(50);
    for (const priority of ['medium', 'low'] as const) expect(parseTaskQueryLine(`priority:${priority}`, ctx).query.filter.priority).toBe(priority);
  });

  test('double quotes group text and date fragments without swallowing range syntax', () => {
    const result = parseTaskQueryLine('#[[Research notes]] "is:todo" "read \\"carefully\\"" @"in 2 days"..+7d', ctx);
    expect(result.errors).toEqual([]);
    expect(result.query.filter.statuses).toEqual([]);
    expect(result.query.source?.type).toBe('research-notes');
    expect(result.query.source?.text).toBe('is:todo read "carefully"');
    expect(result.query.filter.scheduled).toEqual({ from: '2026-10-08', through: '2026-10-13' });
    expect(taskQueryLineTerms('  @"next fri"..  #[[Research notes]] ')).toEqual([
      { term: '@"next fri"..', start: 2, end: 15 },
      { term: '#[[Research notes]]', start: 17, end: 36 },
    ]);
  });

  test('scheduled and deadline ranges have independent inclusive or open endpoints', () => {
    for (const [text, range] of [
      ['today', { from: '2026-10-06', through: '2026-10-06' }],
      ['today..', { from: '2026-10-06', through: null }],
      ['..2026-10-12', { from: null, through: '2026-10-12' }],
      ['today..+7d', { from: '2026-10-06', through: '2026-10-13' }],
    ] as const) {
      const result = parseTaskQueryLine(`@${text} by:${text}`, ctx);
      expect(result.errors).toEqual([]);
      expect(result.query.filter.scheduled).toEqual(range);
      expect(result.query.filter.deadline).toEqual(range);
    }
    expect(parseTaskQueryLine('due:tomorrow @fri', ctx).query.filter).toMatchObject({
      deadline: { from: '2026-10-07', through: '2026-10-07' },
      scheduled: { from: '2026-10-09', through: '2026-10-09' },
    });
  });

  test('date ranges use the civil date from every accepted date expression', () => {
    const result = parseTaskQueryLine('@"today 09:30" by:"tomorrow 18:45"', ctx);
    expect(result.errors).toEqual([]);
    expect(result.query.filter.scheduled).toEqual({ from: '2026-10-06', through: '2026-10-06' });
    expect(result.query.filter.deadline).toEqual({ from: '2026-10-07', through: '2026-10-07' });
  });

  test('ordinary unknown words are source text; invalid predicates retain exact error spans', () => {
    const text = 'words other:words #Unknown [[Not a project]] is:finished @nonsense';
    const result = parseTaskQueryLine(text, ctx);
    expect(result.query.source?.text).toBe('words other:words');
    expect(result.errors.map(error => error.term)).toEqual(['#Unknown', '[[Not a project]]', 'is:finished', '@nonsense']);
    for (const error of result.errors) expect(text.slice(error.start, error.end)).toBe(error.term);
    expect(result.query.filter.statuses).toEqual([]);
    expect(result.query.filter.scheduled).toBeNull();
  });

  test('malformed grouping, empty ranges and invalid numeric bounds are error terms', () => {
    for (const text of ['"unclosed text', '#[[unclosed type', '@..', '@today..tomorrow..+7d', '@tomorrow..today', 'is:', 'show:unknown', 'show:recent:0', 'show:recent:3661', 'priority:urgent', 'limit:0', 'limit:2001', 'limit:1.5']) {
      const result = parseTaskQueryLine(text, ctx);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toMatchObject({ term: text, start: 0, end: text.length });
      expect(result.query.source?.text ?? null).toBeNull();
    }
  });

  test('later valid singleton terms win and repeated statuses are deduplicated', () => {
    const result = parseTaskQueryLine('priority:low priority:high show:all show:open is:todo,todo,doing', ctx);
    expect(result.errors).toEqual([]);
    expect(result.query.filter).toMatchObject({ priority: 'high', selection: 'unfinished', statuses: ['todo', 'doing'] });
  });

  test('formatting is stable and preserves all line fields plus field chips and hidden source settings', () => {
    const query: TaskQuery = {
      ...createTaskQuery(ctx.context_date),
      filter: { selection: 'unfinished_or_recent', recent_days: 14, statuses: ['doing', 'waiting'], priority: 'medium', project_id: 'thesis', scheduled: { from: '2026-10-06', through: null }, deadline: { from: null, through: '2026-10-14' } },
      source: { type: 'research-notes', text: 'is:todo "read it" \\ later', filters: [{ field: 'author', op: 'contains', value: 'Smith' }], sort: [{ by: 'updated', field: null, direction: 'desc' }], limit: 800 },
      limit: 50,
    };
    const context = { ...ctx, baseQuery: query };
    const line = formatTaskQueryLine(query, context);
    const parsed = parseTaskQueryLine(line, context);
    expect(parsed.errors).toEqual([]);
    expect(parsed.query).toEqual(query);
    expect(formatTaskQueryLine(parsed.query, context)).toBe(line);
    parsed.query.source!.filters[0]!.value = 'Jones';
    expect(query.source!.filters[0]!.value).toBe('Smith');
    for (const selection of ['unfinished', 'all'] as const) {
      const value = { ...query, filter: { ...query.filter, selection } };
      const context = { ...ctx, baseQuery: value };
      expect(parseTaskQueryLine(formatTaskQueryLine(value, context), context).query).toEqual(value);
    }
  });

  test('quoted and escaped wiki titles round-trip without changing their page identity', () => {
    for (const type of ['quoted', 'brackets']) {
      const query = parseTaskQueryLine('#Book', ctx).query;
      query.source!.type = type;
      const line = formatTaskQueryLine(query, ctx);
      const result = parseTaskQueryLine(line, ctx);
      expect(result.errors).toEqual([]);
      expect(result.query).toEqual(query);
      expect(formatTaskQueryLine(result.query, ctx)).toBe(line);
    }
  });

  test('editing only the line leaves field predicates outside it and removes their type/text constraints', () => {
    const baseQuery = parseTaskQueryLine('#Book read', ctx).query;
    baseQuery.source!.filters.push({ field: 'rating', op: 'gte', value: '4' });
    const result = parseTaskQueryLine('is:todo', { ...ctx, baseQuery });
    expect(result.query.source).toEqual({ type: null, text: null, filters: [{ field: 'rating', op: 'gte', value: '4' }], sort: [], limit: null });
    expect(formatTaskQueryLine(result.query, ctx)).toBe('is:todo');
  });
});
